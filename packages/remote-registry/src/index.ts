import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import { networkInterfaces } from 'node:os'
import WebSocket, { WebSocketServer } from 'ws'
import { parseAgentRegister, type AgentRegister, type AgentFrame, type RegistryMachine, REGISTRY_PROTOCOL_VERSION } from './protocol.ts'
import { DshWebLauncher } from './web-launcher.ts'
import { ConfigStore, type MachineRecord } from './config-store.ts'

interface AgentConnection { readonly registration: AgentRegister; readonly socket: WebSocket; readonly connectedAt: number; lastHeartbeat: number }
interface Bridge { readonly id: string; readonly agent: AgentConnection; readonly viewer: WebSocket; readonly pending: string[]; ready: boolean }
type LaunchStage = 'queued' | 'checking-agent' | 'syncing-skills' | 'starting-dsh' | 'waiting-ready' | 'ready' | 'failed' | 'cancelled'
interface LaunchTask { taskId: string; machineId: string; stage: LaunchStage; message: string; startedAt: number; updatedAt: number; url?: string; error?: string; controller: AbortController }
interface InventoryMachine { machineId: string; displayName: string; status: 'pending' | 'offline' | 'online'; platform?: NodeJS.Platform; rootPath?: string; capabilities: readonly string[]; createdAt: number; connectedAt?: number; lastHeartbeat?: number; web?: string }

export interface RegistryConfig {
  host?: string
  port?: number
  agentToken?: string
  heartbeatTimeoutMs?: number
  dshCommand?: string
  dshCommandArgs?: readonly string[]
  dshProfile?: string
  webHost?: string
  webAdvertisedHost?: string
  webStartPort?: number
  webReadinessTimeoutMs?: number
  dshEnv?: NodeJS.ProcessEnv
  webProfilePackageDir?: string
  configPath?: string
}

export class RemoteRegistry {
  readonly config: { host: string; port: number; heartbeatTimeoutMs: number; agentToken: string | undefined }
  readonly server: ReturnType<typeof createServer>
  readonly wss: WebSocketServer
  private readonly agents = new Map<string, AgentConnection>()
  private readonly bridges = new Map<string, Bridge>()
  private readonly launches = new Map<string, LaunchTask>()
  private readonly heartbeatTimer: NodeJS.Timeout
  readonly web: DshWebLauncher
  readonly configStore: ConfigStore

  constructor(config: RegistryConfig = {}) {
    this.config = { host: config.host ?? '127.0.0.1', port: config.port ?? 0, agentToken: config.agentToken, heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? 45_000 }
    this.configStore = new ConfigStore(config.configPath)
    this.web = new DshWebLauncher({
      ...(config.dshCommand === undefined ? {} : { command: config.dshCommand }),
      ...(config.dshCommandArgs === undefined ? {} : { commandArgs: config.dshCommandArgs }),
      ...(config.dshProfile === undefined ? {} : { profile: config.dshProfile }),
      ...(config.webHost === undefined ? {} : { host: config.webHost }),
      ...(config.webAdvertisedHost === undefined ? {} : { advertisedHost: config.webAdvertisedHost }),
      ...(config.webStartPort === undefined ? {} : { startPort: config.webStartPort }),
      ...(config.webReadinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: config.webReadinessTimeoutMs }),
      ...(config.dshEnv === undefined ? {} : { env: config.dshEnv }),
      ...(config.webProfilePackageDir === undefined ? {} : { profilePackageDir: config.webProfilePackageDir }),
    })
    this.server = createServer((request, response) => this.http(request, response))
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 })
    this.server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head))
    this.heartbeatTimer = setInterval(() => this.expireAgents(), Math.max(1000, this.config.heartbeatTimeoutMs / 3))
    this.heartbeatTimer.unref()
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port, this.config.host, () => resolve()) })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('remote-registry: listener address unavailable')
    return `http://${this.config.host}:${address.port}`
  }

  async dispose(): Promise<void> {
    clearInterval(this.heartbeatTimer)
    for (const bridge of this.bridges.values()) bridge.viewer.close()
    for (const agent of this.agents.values()) agent.socket.close()
    this.bridges.clear(); this.agents.clear()
    await this.web.dispose()
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }

  listMachines(): RegistryMachine[] {
    return [...this.agents.values()].map(agent => ({
      machineId: agent.registration.machineId,
      displayName: this.configStore.machineRecord(agent.registration.machineId)?.displayName ?? agent.registration.displayName,
      platform: agent.registration.platform,
      rootPath: agent.registration.rootPath,
      capabilities: agent.registration.capabilities,
      connectedAt: agent.connectedAt,
      lastHeartbeat: agent.lastHeartbeat,
    }))
  }

  listInventory(): InventoryMachine[] {
    const records = Object.values(this.configStore.snapshot().machineRecords)
    return records.sort((left, right) => left.createdAt - right.createdAt).map(record => {
      const agent = this.agents.get(record.id)
      if (agent === undefined) return { machineId: record.id, displayName: record.displayName, status: record.claimedAt === undefined ? 'pending' : 'offline', capabilities: [], createdAt: record.createdAt }
      return {
        machineId: record.id, displayName: record.displayName, status: 'online', platform: agent.registration.platform,
        rootPath: agent.registration.rootPath, capabilities: agent.registration.capabilities, createdAt: record.createdAt,
        connectedAt: agent.connectedAt, lastHeartbeat: agent.lastHeartbeat,
        ...(this.web.get(record.id) === undefined ? {} : { web: this.webProxyPath(record.id) }),
      }
    })
  }

  private http(request: IncomingMessage, response: import('node:http').ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://registry')
    const refererMachine = this.machineFromReferer(request)
    if (refererMachine !== undefined && !url.pathname.startsWith('/api/machines/') && !url.pathname.startsWith('/web/')) { this.proxyWebHttp(refererMachine, url.pathname + url.search, request, response); return }
    if (url.pathname === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, protocolVersion: REGISTRY_PROTOCOL_VERSION })); return }
    if (url.pathname === '/machines') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(this.listMachines())); return }
    if (url.pathname === '/api/machines') { void this.machinesRequest(request, response); return }
    const deleteMachine = /^\/api\/machines\/([^/]+)$/.exec(url.pathname)
    if (deleteMachine?.[1] !== undefined && request.method === 'DELETE') { void this.deleteMachineRequest(decodeURIComponent(deleteMachine[1]), response); return }
    const launchStatus = /^\/api\/machines\/([^/]+)\/open-status$/.exec(url.pathname)
    if (launchStatus?.[1] !== undefined && request.method === 'GET') { this.json(response, this.launchStatus(launchStatus[1])); return }
    const launchCancel = /^\/api\/machines\/([^/]+)\/open-cancel$/.exec(url.pathname)
    if (launchCancel?.[1] !== undefined && request.method === 'POST') { this.cancelLaunch(launchCancel[1], response); return }
    if (url.pathname === '/api/config' && request.method === 'GET') { this.json(response, this.publicConfig()); return }
    if (url.pathname === '/api/registry-info' && request.method === 'GET') { this.json(response, this.registryInfo(request)); return }
    const enrollment = /^\/api\/machines\/([^/]+)\/enrollment$/.exec(url.pathname)
    if (enrollment?.[1] !== undefined && request.method === 'GET') { this.machineEnrollmentRequest(decodeURIComponent(enrollment[1]), request, response); return }
    const configMatch = /^\/api\/(model-profiles|skills|mcps|hooks)(?:\/([^/]+))?$/.exec(url.pathname)
    if (configMatch !== null) { void this.resourceRequest(configMatch[1]!, configMatch[2], request, response); return }
    const machineConfig = /^\/api\/machines\/([^/]+)\/config$/.exec(url.pathname)
    if (machineConfig?.[1] !== undefined) { void this.machineConfigRequest(machineConfig[1], request, response); return }
    if (url.pathname === '/' || url.pathname === '/index.html') { this.dashboard(response); return }
    const launchPage = /^\/launch\/([^/]+)$/.exec(url.pathname)
    if (launchPage?.[1] !== undefined) { this.launchPage(decodeURIComponent(launchPage[1]), response); return }
    const webProxy = /^\/web\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (webProxy?.[1] !== undefined) { this.proxyWebHttp(decodeURIComponent(webProxy[1]), webProxy[2] ?? '/', request, response); return }
    const openMatch = /^\/api\/machines\/([^/]+)\/open$/.exec(url.pathname)
    if (openMatch?.[1] !== undefined && request.method === 'POST') { this.startLaunch(openMatch[1], response); return }
    const stopMatch = /^\/api\/machines\/([^/]+)\/stop$/.exec(url.pathname)
    if (stopMatch?.[1] !== undefined && request.method === 'POST') { void this.stopWeb(stopMatch[1], response); return }
    response.writeHead(404); response.end('not found')
  }

  private json(response: import('node:http').ServerResponse, value: unknown, status = 200): void { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
  private webProxyPath(machineId: string): string { return `/web/${encodeURIComponent(machineId)}/` }
  private machineFromReferer(request: IncomingMessage): string | undefined { const referer = request.headers.referer; if (referer === undefined) return undefined; try { const path = new URL(referer).pathname; const match = /^\/web\/([^/]+)(?:\/|$)/.exec(path); return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]) } catch { return undefined } }
  private proxyWebHttp(machineId: string, path: string, request: IncomingMessage, response: ServerResponse): void {
    const web = this.web.get(machineId)
    if (web === undefined) { this.json(response, { error: 'dsh Web is not running' }, 404); return }
    const target = new URL(web.url)
    // dsh's privileged Host API is intentionally loopback/same-origin only.
    // The registry is the public LAN boundary, so normalize browser authority
    // headers before forwarding instead of weakening dsh's trust fence.
    const headers: IncomingHttpHeaders = { ...request.headers, host: target.host, origin: target.origin, referer: `${target.origin}/` }
    delete headers['sec-fetch-site']
    delete headers['sec-fetch-mode']
    delete headers['sec-fetch-dest']
    delete headers['x-forwarded-host']
    delete headers['x-forwarded-proto']
    const proxy = httpRequest({ hostname: target.hostname, port: Number(target.port), method: request.method, path, headers }, upstream => {
      const contentType = String(upstream.headers['content-type'] ?? '')
      if (!contentType.includes('text/html')) { response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response); return }
      const chunks: Buffer[] = []
      upstream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      upstream.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const injected = injectBrowserCompatibility(body, machineId)
        const headers = { ...upstream.headers, 'content-length': Buffer.byteLength(injected) }
        delete headers['content-encoding']
        response.writeHead(upstream.statusCode ?? 502, headers)
        response.end(injected)
      })
    })
    proxy.once('error', error => { if (!response.headersSent) this.json(response, { error: `dsh Web proxy failed: ${error.message}` }, 502); else response.destroy(error) })
    request.pipe(proxy)
  }

  private async machinesRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === 'GET') { this.json(response, this.listInventory()); return }
      if (request.method !== 'POST') { this.json(response, { error: 'method not allowed' }, 405); return }
      const body = await readJson(request) as { displayName?: unknown }
      const displayName = normalizeMachineName(body.displayName)
      const record = this.configStore.createMachine(displayName)
      this.json(response, { machine: this.publicMachineRecord(record), enrollment: this.enrollmentInfo(record, request) }, 201)
    } catch (error) { this.json(response, { error: error instanceof Error ? error.message : String(error) }, 400) }
  }

  private async deleteMachineRequest(machineId: string, response: ServerResponse): Promise<void> {
    if (this.configStore.machineRecord(machineId) === undefined) { this.json(response, { error: 'machine not found' }, 404); return }
    this.configStore.deleteMachine(machineId)
    const launch = this.launches.get(machineId)
    launch?.controller.abort()
    this.launches.delete(machineId)
    const agent = this.agents.get(machineId)
    if (agent !== undefined) { agent.socket.close(1008, 'machine deleted'); this.removeAgent(agent) }
    await this.web.stop(machineId)
    this.json(response, { deleted: true, machineId })
  }

  private machineEnrollmentRequest(machineId: string, request: IncomingMessage, response: ServerResponse): void {
    let record = this.configStore.machineRecord(machineId)
    if (record === undefined) { this.json(response, { error: 'machine not found' }, 404); return }
    if (record.agentToken === undefined) record = this.configStore.ensureMachineToken(machineId)
    this.json(response, this.enrollmentInfo(record, request))
  }

  private publicMachineRecord(record: MachineRecord): Omit<MachineRecord, 'agentToken'> {
    return { id: record.id, displayName: record.displayName, createdAt: record.createdAt, ...(record.claimedAt === undefined ? {} : { claimedAt: record.claimedAt }) }
  }

  private enrollmentInfo(record: MachineRecord, request: IncomingMessage): unknown {
    if (record.agentToken === undefined) throw new Error('machine enrollment token is unavailable')
    const { addresses, host, port } = this.registryAddresses(request)
    const targets = addresses.length === 0 ? [host] : addresses
    const clone = 'git clone http://code.oppoer.me/S9064479/remote-client.git'
    const commands = targets.map(address => {
      const registry = port === 32100 ? address : `${address}:${port}`
      return `${clone}\ncd remote-client\n./scripts/register-agent.sh ${shellQuote(registry)} ${shellQuote(record.id)} ${shellQuote(record.agentToken!)} ${shellQuote(record.displayName)}`
    })
    return { machineId: record.id, displayName: record.displayName, addresses: targets, commands }
  }

  private registryAddresses(request: IncomingMessage): { addresses: string[]; host: string; port: number } {
    const port = this.boundPort()
    const network = Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address))
    const host = request.headers.host?.split(':')[0] ?? this.config.host
    const candidates = host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost' ? network : [host]
    const addresses = [...new Set(candidates)].filter(address => address.startsWith('10.'))
    return { addresses, host, port }
  }

  private registryInfo(request: IncomingMessage): unknown { const { addresses, host, port } = this.registryAddresses(request); return { port, addresses, websocketUrl: `ws://${addresses[0] ?? host}:${port}/agent`, clone: 'git clone http://code.oppoer.me/S9064479/remote-client.git && cd remote-client', script: './scripts/register-agent.sh' } }
  private launchStatus(machineId: string): Record<string, unknown> { const task = this.launches.get(machineId); const web = this.web.get(machineId); if (task !== undefined) return { taskId: task.taskId, machineId: task.machineId, stage: task.stage, message: task.message, startedAt: task.startedAt, updatedAt: task.updatedAt, url: task.url ?? null, error: task.error ?? null, statusUrl: `/api/machines/${encodeURIComponent(machineId)}/open-status` }; return web === undefined ? { machineId, stage: 'idle', url: null } : { machineId, stage: 'ready', url: this.webProxyPath(machineId), startedAt: web.startedAt, updatedAt: web.startedAt } }
  private cancelLaunch(machineId: string, response: import('node:http').ServerResponse): void { const task = this.launches.get(machineId); if (task === undefined) { this.json(response, { error: '没有正在启动的 Web' }, 404); return } task.controller.abort(); task.stage = 'cancelled'; task.message = '启动已取消'; task.updatedAt = Date.now(); this.json(response, this.launchStatus(machineId)) }
  private startLaunch(machineId: string, response: import('node:http').ServerResponse): void { const existing = this.launches.get(machineId); if (existing !== undefined && !['failed', 'cancelled', 'ready'].includes(existing.stage)) { this.json(response, { ...this.launchStatus(machineId), launchUrl: `/launch/${encodeURIComponent(machineId)}` }); return } const task: LaunchTask = { taskId: randomUUID(), machineId, stage: 'queued', message: '启动任务已排队', startedAt: Date.now(), updatedAt: Date.now(), controller: new AbortController() }; this.launches.set(machineId, task); this.json(response, { ...this.launchStatus(machineId), launchUrl: `/launch/${encodeURIComponent(machineId)}` }); void this.runLaunch(task) }
  private async runLaunch(task: LaunchTask): Promise<void> { const set = (stage: LaunchStage, message: string): void => { task.stage = stage; task.message = message; task.updatedAt = Date.now() }; try { set('checking-agent', '正在连接远程机器…'); const agent = this.agents.get(task.machineId); if (agent === undefined) throw new Error('machine is offline'); const executorToken = agent.registration.executorToken; const bridgeToken = agent.registration.token; const bridgeUrl = `${this.publicWsUrl()}/machines/${encodeURIComponent(task.machineId)}/executor${bridgeToken === undefined ? '' : `?token=${encodeURIComponent(bridgeToken)}`}`; const stored = this.configStore.snapshot(); const binding = this.configStore.machine(task.machineId); const model = stored.modelProfiles.find(item => item.id === binding.modelProfileId); const mcps = stored.mcps.filter(item => binding.mcpIds.includes(item.id)); const hooks = stored.hooks.filter(item => binding.hookIds.includes(item.id)); const skills = stored.skills.filter(item => binding.skillIds.includes(item.id)); if (skills.length) { set('syncing-skills', '正在同步 Skills…'); await this.syncSkills(agent, task.machineId, skills) } set('starting-dsh', '正在启动 dsh Web…'); set('waiting-ready', '正在等待 Web 就绪…'); await this.web.launch(task.machineId, bridgeUrl, executorToken, { ...(model === undefined ? {} : { model }), skills, mcps, hooks, machine: binding }, { signal: task.controller.signal }); this.configStore.markApplied(task.machineId); task.url = this.webProxyPath(task.machineId); set('ready', 'Web 已就绪'); } catch (error) { if (task.controller.signal.aborted) { task.stage = 'cancelled'; task.message = '启动已取消' } else { task.stage = 'failed'; task.error = error instanceof Error ? error.message : String(error); task.message = 'dsh Web 启动失败' } task.updatedAt = Date.now() } }
  private publicConfig(): unknown {
    const { revokedMachineIds: _, ...config } = this.configStore.snapshot()
    return { ...config, machineRecords: Object.fromEntries(Object.values(config.machineRecords).map(record => [record.id, this.publicMachineRecord(record)])), modelProfiles: config.modelProfiles.map(({ apiKey, ...item }) => ({ ...item, apiKey: apiKey ? `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}` : '' })) }
  }
  private async resourceRequest(kind: string, id: string | undefined, request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    try {
      const key = (kind === 'model-profiles' ? 'modelProfiles' : kind) as 'modelProfiles' | 'skills' | 'mcps' | 'hooks'
      if (request.method === 'GET') { this.json(response, this.publicConfig()); return }
      const body = await readJson(request) as Record<string, unknown>
      if (request.method === 'DELETE' && id !== undefined) {
        this.configStore.update(value => { const list = value[key] as Array<{ id: string }>; if (Object.values(value.machines).some(machine => ([...machine.skillIds, ...machine.mcpIds, ...machine.hookIds]).includes(id))) throw new Error('resource is still used by a machine'); value[key] = list.filter(item => item.id !== id) as never })
      } else if (request.method === 'POST' || request.method === 'PUT') {
        const resource = body as unknown as { id?: string; name?: string }
        if (typeof resource.name !== 'string' || resource.name.length === 0) throw new Error('resource name is required')
        this.configStore.update(value => { const list = value[key] as unknown as Array<Record<string, unknown>>; const next = { ...resource, id: id ?? resource.id ?? this.configStore.newId() }; const index = list.findIndex(item => item.id === next.id); if (index < 0) list.push(next); else list[index] = { ...list[index], ...next } })
      } else { this.json(response, { error: 'method not allowed' }, 405); return }
      this.json(response, this.publicConfig())
    } catch (error) { this.json(response, { error: error instanceof Error ? error.message : String(error) }, 400) }
  }
  private async machineConfigRequest(machineId: string, request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    try {
      if (request.method === 'GET') { this.json(response, this.configStore.machine(machineId)); return }
      if (request.method !== 'PUT') { this.json(response, { error: 'method not allowed' }, 405); return }
      const body = await readJson(request) as { modelProfileId?: string; skillIds?: string[]; mcpIds?: string[]; hookIds?: string[] }
      const config = this.configStore.setMachine(machineId, { ...(body.modelProfileId === undefined ? {} : { modelProfileId: body.modelProfileId }), skillIds: body.skillIds ?? [], mcpIds: body.mcpIds ?? [], hookIds: body.hookIds ?? [] })
      this.json(response, config.machines[machineId])
    } catch (error) { this.json(response, { error: error instanceof Error ? error.message : String(error) }, 400) }
  }

  private dashboard(response: import('node:http').ServerResponse): void {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote Console</title><style>body{margin:0;background:#f7f8fa;color:#18212f;font:14px/1.5 system-ui,sans-serif}*{box-sizing:border-box}main{display:flex;min-height:100vh}.side{width:220px;background:#fff;border-right:1px solid #e7ebf0;padding:28px 18px}.brand{font-weight:700;font-size:18px;margin:0 8px 28px}.nav button{display:block;width:100%;padding:11px 12px;border:0;background:transparent;text-align:left;border-radius:9px;color:#6b7685;cursor:pointer}.nav button.active,.nav button:hover{background:#eef4ff;color:#2563eb}.content{flex:1;max-width:1100px;padding:42px 38px}.top{display:flex;justify-content:space-between;align-items:start;margin-bottom:28px}.eyebrow{color:#2563eb;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700}.title{font-size:30px;letter-spacing:-.04em;margin:8px 0}.muted{color:#6b7685}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:15px}.card,.panel{background:#fff;border:1px solid #e7ebf0;border-radius:16px;padding:20px;box-shadow:0 5px 20px #18212f08}.cardhead{display:flex;justify-content:space-between;gap:12px}.machine{font-size:17px;font-weight:650}.machineid{color:#6b7685;font:11px monospace;margin-top:3px;overflow:hidden;text-overflow:ellipsis}.badge{padding:4px 8px;border-radius:99px;background:#e9f8f0;color:#16845b;font-size:12px;white-space:nowrap}.summary{display:flex;gap:12px;margin-bottom:25px}.metric{background:#fff;border:1px solid #e7ebf0;border-radius:12px;padding:14px 18px;min-width:130px}.metric b{display:block;font-size:23px}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.btn{border:0;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600}.btn:disabled{opacity:.55;cursor:wait}.primary{background:#18212f;color:#fff}.secondary{background:#eef4ff;color:#2563eb}.danger{background:#fff0ee;color:#b42318}.ghost{background:#f0f2f5;color:#6b7685}.details{display:none;border-top:1px solid #e7ebf0;margin-top:17px;padding-top:17px}.card.show-details .details{display:block}.section-label{font-weight:650;margin-bottom:10px}.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;color:#6b7685}.row strong{color:#18212f;font-weight:500;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.notice{margin:15px 0;color:#a16207;background:#fff7df;padding:10px;border-radius:8px}.status{min-height:22px;color:#b42318;margin-bottom:15px}.resource{margin-top:18px}.resource h3{margin:0 0 12px}.resource-list{display:grid;gap:9px}.resource-item{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px;border:1px solid #e7ebf0;border-radius:10px}.resource-meta{color:#6b7685;font-size:12px;margin-top:3px}.empty{padding:45px;text-align:center;color:#6b7685;border:1px dashed #d5dce5;border-radius:14px}.drawer-backdrop{display:none;position:fixed;inset:0;background:#18212f40;z-index:10}.drawer-backdrop.visible{display:block}.drawer{position:absolute;right:0;top:0;height:100%;width:min(600px,96vw);background:#fff;box-shadow:-18px 0 45px #18212f22;display:flex;flex-direction:column}.drawer-head{padding:25px 28px 18px;border-bottom:1px solid #e7ebf0;display:flex;justify-content:space-between;gap:18px}.drawer-title{font-size:20px;font-weight:650}.drawer-body{padding:22px 28px;overflow:auto;flex:1}.drawer-foot{padding:16px 28px;border-top:1px solid #e7ebf0;display:flex;justify-content:flex-end;gap:9px}.config-section{margin-bottom:25px}.config-section h3{margin:0 0 4px;font-size:15px}.config-section p{margin:0 0 12px;color:#6b7685;font-size:12px}.model-choice,.resource-choice{display:flex;align-items:center;gap:11px;padding:12px;border:1px solid #e0e5eb;border-radius:10px;margin:8px 0;cursor:pointer}.model-choice:has(input:checked),.resource-choice:has(input:checked){border-color:#8fb2ff;background:#f5f8ff}.resource-choice input,.model-choice input{accent-color:#2563eb}.choice-copy{min-width:0}.choice-name{font-weight:600}.choice-desc{color:#6b7685;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.field{display:block}.field.full{grid-column:1/-1}.field-label{display:block;font-weight:600;margin-bottom:6px}.required:after{content:' *';color:#b42318}.input,.textarea,.select{width:100%;border:1px solid #dfe4ea;border-radius:9px;padding:10px 11px;background:#fff;color:#18212f;font:inherit;outline:none}.input:focus,.textarea:focus,.select:focus{border-color:#7aa2f8;box-shadow:0 0 0 3px #eef4ff}.textarea{min-height:110px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.help{color:#6b7685;font-size:12px;margin-top:5px}.error{color:#b42318;font-size:12px;margin-top:5px}.segmented{display:flex;background:#f0f2f5;border-radius:9px;padding:3px;margin-bottom:17px}.segmented button{flex:1;border:0;background:transparent;padding:8px;border-radius:7px;cursor:pointer}.segmented button.active{background:#fff;box-shadow:0 1px 5px #18212f16;font-weight:600}.kv-list,.rule-list,.file-list{display:grid;gap:8px}.kv-row,.rule-card,.file-row{display:flex;gap:8px;align-items:start;padding:10px;border:1px solid #e7ebf0;border-radius:9px}.kv-row .input{min-width:0}.upload{border:1px dashed #bfc8d4;border-radius:11px;padding:20px;text-align:center;background:#fafbfc}.file-row{justify-content:space-between}.file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.advanced{margin-top:16px}.advanced summary{cursor:pointer;color:#6b7685}.form-error{display:none;color:#b42318;background:#fff0ee;padding:10px;border-radius:8px;margin-bottom:15px}.form-error.visible{display:block}@media(max-width:760px){.side{width:64px;padding:20px 8px}.brand{font-size:0}.brand:after{content:'RC';font-size:16px}.nav button{font-size:0;text-align:center}.nav button:first-letter{font-size:18px}.content{padding:28px 16px}.top{display:block}.summary{overflow:auto}.form-grid{grid-template-columns:1fr}.field.full{grid-column:auto}}
</style></head><body><main><aside class="side"><div class="brand">Remote Console</div><nav class="nav"><button class="active" data-view="machines">⌘　机器</button><button data-view="models">◉　模型配置</button><button data-view="skills">✦　Skills</button><button data-view="mcps">◇　MCP</button><button data-view="hooks">⚙　Hooks</button></nav></aside><section class="content"><div class="top"><div><div class="eyebrow">Remote Console</div><h1 class="title" id="heading">远程机器</h1><div class="muted" id="subheading">选择机器并配置它的运行环境。</div></div><div class="muted">Registry 在线</div></div><div id="status" class="status"></div><section id="view"></section></section></main><div id="drawer-backdrop" class="drawer-backdrop"><aside class="drawer" role="dialog" aria-modal="true"><header class="drawer-head"><div><div class="drawer-title" id="drawer-title">机器配置</div><div class="muted" id="drawer-subtitle"></div></div><button class="btn ghost" id="drawer-close">关闭</button></header><div class="drawer-body" id="drawer-body"></div><footer class="drawer-foot"><button class="btn ghost" id="drawer-cancel">取消</button><button class="btn primary" id="drawer-save">保存配置</button></footer></aside></div><script>
const state={config:null,machines:[],view:'machines',editing:null},el=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c])),api=async(path,opts)=>{const r=await fetch(path,opts);const x=await r.json();if(!r.ok)throw new Error(x.error||'请求失败');return x};document.head.insertAdjacentHTML('beforeend','<style>.content{max-width:1280px}.grid{grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:18px;align-items:start}.card{padding:0;overflow:hidden;border-color:#e4e8ee;box-shadow:0 1px 2px #18212f08,0 8px 28px #18212f06;transition:border-color .18s,box-shadow .18s,transform .18s}.card:hover{border-color:#d7dde6;box-shadow:0 2px 4px #18212f0a,0 14px 36px #18212f0b;transform:translateY(-1px)}.card-main{padding:20px}.cardhead{align-items:flex-start;gap:14px}.identity{display:flex;gap:12px;min-width:0}.platform-icon{display:grid;place-items:center;flex:0 0 38px;height:38px;border-radius:11px;background:#f1f4f8;color:#475569;font-size:12px;font-weight:750;text-transform:uppercase}.identity-copy{min-width:0}.machine{font-size:17px;font-weight:700;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.machineid{font-size:11px;line-height:1.35;white-space:nowrap;max-width:100%;margin-top:4px}.status-stack{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none}.badge{display:inline-flex;align-items:center;align-self:flex-start;flex:none;gap:6px;height:24px;padding:0 9px;border:1px solid #cceedd;border-radius:999px;background:#f0fbf5;color:#087443;font-size:11px;line-height:1;white-space:nowrap}.badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.web-state{font-size:11px;color:#758195;white-space:nowrap}.web-state.running{color:#087443}.machine-meta{display:flex;align-items:center;gap:8px;margin-top:16px;color:#647184;font-size:12px}.meta-dot{width:3px;height:3px;border-radius:50%;background:#b4bdc9}.resource-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:16px}.resource-stat{padding:10px;border:1px solid #e8ecf1;border-radius:10px;background:#fafbfc}.resource-stat strong{display:block;font-size:16px;line-height:1.1}.resource-stat span{display:block;margin-top:4px;color:#778396;font-size:11px}.card-actions{display:flex;align-items:center;gap:8px;margin-top:18px}.card-actions .primary{flex:1}.card-actions .btn{height:36px}.icon-btn{width:36px;padding:0;display:grid;place-items:center;font-size:16px}.card-foot{display:flex;justify-content:space-between;gap:10px;padding:12px 20px;border-top:1px solid #edf0f4;background:#fbfcfd;color:#7a8595;font-size:11px}.details{margin:0;padding:17px 20px;border-top:1px solid #e7ebf0;background:#fff}.detail-actions{display:flex;justify-content:flex-end;margin-top:12px}.summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:12px}.metric{min-width:0}.metric b{font-size:22px}.config-tabs{display:flex;gap:4px;padding:4px;background:#f1f3f6;border-radius:10px;margin-bottom:20px;position:sticky;top:-22px;z-index:2}.config-tab{flex:1;border:0;border-radius:8px;padding:9px 6px;background:transparent;color:#667386;cursor:pointer;font-weight:600;font-size:12px}.config-tab.active{background:#fff;color:#18212f;box-shadow:0 1px 5px #18212f16}.config-pane{display:none}.config-pane.active{display:block}.config-count{display:inline-flex;justify-content:center;min-width:18px;margin-left:4px;padding:1px 5px;border-radius:99px;background:#e8edf5;font-size:10px}.danger-link{color:#b42318;background:transparent}.heartbeat-warn{color:#b54708}@media(max-width:900px){.summary{grid-template-columns:repeat(2,1fr)}}@media(max-width:760px){.grid{grid-template-columns:1fr}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.card-actions{flex-wrap:wrap}.config-tabs{overflow:auto;justify-content:flex-start}.config-tab{flex:0 0 auto;padding-inline:12px}}</style>');
document.head.insertAdjacentHTML('beforeend','<style>.badge.pending{color:#9a6700;background:#fff8db;border-color:#f1df9c}.badge.offline{color:#667085;background:#f5f6f7;border-color:#dfe3e8}.enrollment-command{align-items:flex-start}.enrollment-command>div{min-width:0;flex:1}.enrollment-command code{display:block;margin-top:7px;padding:12px;border-radius:9px;background:#111827;color:#e5edf7;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}</style>');
async function copyText(value){if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(value);return}const input=document.createElement('textarea');input.value=value;input.setAttribute('readonly','');input.style.cssText='position:fixed;left:-9999px;top:0;opacity:0';document.body.appendChild(input);input.select();input.setSelectionRange(0,input.value.length);const copied=document.execCommand('copy');input.remove();if(!copied)throw new Error('浏览器不允许复制，请手动选择命令')}
async function load(){if(state.editing)return;try{state.config=await api('/api/config');state.machines=await api('/api/machines');render()}catch(e){el('status').textContent=String(e)}}
function render(){const labels={machines:['远程机器','选择机器并配置它的运行环境。'],models:['模型配置','注册多个 API URL 和 key，机器选择其中一个。'],skills:['Skills','注册可同步到远程机器的技能包。'],mcps:['MCP','注册控制机 harness 使用的 MCP。'],hooks:['Hooks','注册控制机 harness 使用的 Hook。']};el('heading').textContent=labels[state.view][0];el('subheading').textContent=labels[state.view][1];state.view==='machines'?renderMachines():renderResources(state.view)}
function renderMachines(){const c=state.config,m=state.machines,online=m.filter(x=>x.status==='online').length,pending=m.filter(x=>x.status==='pending').length,unconfigured=m.filter(x=>{const b=c.machines[x.machineId];return x.status!=='pending'&&(!b||(!b.modelProfileId&&!b.skillIds?.length&&!b.mcpIds?.length&&!b.hookIds?.length))}).length;el('view').innerHTML='<div class="summary"><div class="metric"><span class="muted">在线机器</span><b>'+online+'</b></div><div class="metric"><span class="muted">Web 运行中</span><b>'+m.filter(x=>x.web).length+'</b></div><div class="metric"><span class="muted">等待接入</span><b>'+pending+'</b></div><div class="metric"><span class="muted">待配置</span><b>'+unconfigured+'</b></div></div><div class="grid">'+(m.length?m.map(machineCard).join(''):'<div class="empty">还没有机器，点击右上角“添加机器”开始接入。</div>')+'</div>';document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>toggleDetails(b));document.querySelectorAll('[data-config]').forEach(b=>b.onclick=()=>openConfig(decodeURIComponent(b.dataset.config)));document.querySelectorAll('[data-enroll]').forEach(b=>b.onclick=()=>openEnrollment(decodeURIComponent(b.dataset.enroll)));document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>machineAction(b.dataset.open,'open'));document.querySelectorAll('[data-stop]').forEach(b=>b.onclick=()=>stopMachine(b.dataset.stop));document.querySelectorAll('[data-delete-machine]').forEach(b=>b.onclick=()=>deleteMachine(decodeURIComponent(b.dataset.deleteMachine),b.dataset.machineName))}
function toggleDetails(button){const card=button.closest('.card'),active=card.classList.contains('show-details');document.querySelectorAll('.card').forEach(x=>x.classList.remove('show-details'));if(!active)card.classList.add('show-details')}
function platformLabel(platform){return platform==='darwin'?'macOS':platform==='win32'?'Windows':platform==='linux'?'Linux':'尚未接入'}
function platformIcon(platform){return platform==='darwin'?'mac':platform==='win32'?'win':platform==='linux'?'linux':'host'}
function relativeHeartbeat(timestamp){const seconds=Math.max(0,Math.round((Date.now()-timestamp)/1000));if(seconds<10)return '刚刚';if(seconds<60)return seconds+' 秒前';const minutes=Math.floor(seconds/60);return minutes<60?minutes+' 分钟前':Math.floor(minutes/60)+' 小时前'}
function machineCard(x){const binding=state.config.machines[x.machineId]||{skillIds:[],mcpIds:[],hookIds:[]},id=encodeURIComponent(x.machineId),online=x.status==='online',pending=x.status==='pending',caps=(x.capabilities||[]).join('、')||'未声明',statusText=online?'在线':pending?'等待接入':'离线',badge='<span class="badge '+x.status+'">'+statusText+'</span>',web=online?(x.web?'<span class="web-state running">Web 运行中</span>':'<span class="web-state">Web 未启动</span>'):'',meta=online?'<span>'+esc(platformLabel(x.platform))+'</span><i class="meta-dot"></i><span class="'+(Date.now()-x.lastHeartbeat>45000?'heartbeat-warn':'')+'">心跳 '+relativeHeartbeat(x.lastHeartbeat)+'</span>':pending?'<span>尚未运行接入脚本</span>':'<span>Agent 当前未连接</span>',resources=pending?'':'<div class="resource-stats"><div class="resource-stat"><strong>'+((binding.skillIds||[]).length)+'</strong><span>Skills</span></div><div class="resource-stat"><strong>'+((binding.mcpIds||[]).length)+'</strong><span>MCP</span></div><div class="resource-stat"><strong>'+((binding.hookIds||[]).length)+'</strong><span>Hooks</span></div></div>',remove='<button class="btn danger" data-delete-machine="'+id+'" data-machine-name="'+esc(x.displayName)+'">删除</button>',actions=(pending?'<button class="btn primary" data-enroll="'+id+'">查看接入脚本</button>':online?(x.web?'<button class="btn primary" data-open="'+id+'">打开 Web</button>':'<button class="btn primary" data-open="'+id+'">启动 Web</button>')+'<button class="btn secondary" data-config="'+id+'">配置</button><button class="btn ghost icon-btn" data-detail title="查看详情" aria-label="查看详情">···</button>':'<button class="btn primary" data-enroll="'+id+'">查看接入脚本</button><button class="btn secondary" data-config="'+id+'">配置</button>')+remove;const details=online?'<div class="details"><div class="section-label">机器详情</div><div class="row"><span>系统平台</span><strong>'+esc(platformLabel(x.platform))+'</strong></div><div class="row"><span>工作区根目录</span><strong title="'+esc(x.rootPath)+'">'+esc(x.rootPath)+'</strong></div><div class="row"><span>连接时间</span><strong>'+new Date(x.connectedAt).toLocaleString('zh-CN')+'</strong></div><div class="row"><span>最近心跳</span><strong>'+new Date(x.lastHeartbeat).toLocaleString('zh-CN')+'</strong></div><div class="row"><span>支持能力</span><strong title="'+esc(caps)+'">'+esc(caps)+'</strong></div><div class="row"><span>dsh Web</span><strong>'+(x.web?'运行中':'未启动')+'</strong></div>'+(x.web?'<div class="detail-actions"><button class="btn danger-link" data-stop="'+id+'">停止 Web</button></div>':'')+'</div>':'';return '<article class="card"><div class="card-main"><div class="cardhead"><div class="identity"><div class="platform-icon">'+platformIcon(x.platform)+'</div><div class="identity-copy"><div class="machine" title="'+esc(x.displayName)+'">'+esc(x.displayName)+'</div></div></div><div class="status-stack">'+badge+web+'</div></div><div class="machine-meta">'+meta+'</div>'+resources+'<div class="card-actions">'+actions+'</div></div><div class="card-foot"><span>'+(online?'根目录 '+esc(x.rootPath):pending?'等待远程机器接入':'保留历史与配置')+'</span><span>'+(x.web?'实例运行中':statusText)+'</span></div>'+details+'</article>'}
async function stopMachine(encoded){if(!confirm('确定停止这台机器当前运行的 dsh Web 吗？远程 Agent 不会被停止。'))return;await machineAction(encoded,'stop')}
function choices(items,selected,type){return items.length?items.map(item=>'<label class="resource-choice"><input type="checkbox" name="'+type+'" value="'+esc(item.id)+'" '+(selected.includes(item.id)?'checked':'')+'><div class="choice-copy"><div class="choice-name">'+esc(item.name)+'</div><div class="choice-desc">'+esc(item.description||item.config?.transport||item.id)+'</div></div></label>').join(''):'<div class="empty">还没有注册可选资源</div>'}
function openConfig(id){const machine=state.machines.find(x=>x.machineId===id);if(!machine)return;const binding=state.config.machines[id]||{skillIds:[],mcpIds:[],hookIds:[]};state.editing={id,dirty:false};el('drawer-title').textContent='配置 '+machine.displayName;el('drawer-subtitle').textContent=platformLabel(machine.platform)+' · '+(machine.web?'Web 运行中':'Web 未启动');const pane=(title,content,key,count)=>'<section class="config-pane '+(key==='model'?'active':'')+'" data-pane="'+key+'"><h3>'+title+(count===undefined?'':' <span class="config-count">'+count+'</span>')+'</h3>'+content+'</section>';const model='<p>选择这台机器启动 dsh Web 时使用的模型端点。</p><label class="model-choice"><input type="radio" name="model" value="" '+(!binding.modelProfileId?'checked':'')+'><div class="choice-copy"><div class="choice-name">默认配置</div><div class="choice-desc">使用 Registry 共享的模型配置</div></div></label>'+state.config.modelProfiles.map(item=>'<label class="model-choice"><input type="radio" name="model" value="'+esc(item.id)+'" '+(binding.modelProfileId===item.id?'checked':'')+'><div class="choice-copy"><div class="choice-name">'+esc(item.name)+'</div><div class="choice-desc">'+esc(item.baseUrl)+'</div></div></label>').join('');el('drawer-body').innerHTML='<div class="config-tabs"><button class="config-tab active" data-tab="model">模型</button><button class="config-tab" data-tab="skills">Skills <span class="config-count">'+((binding.skillIds||[]).length)+'</span></button><button class="config-tab" data-tab="mcps">MCP <span class="config-count">'+((binding.mcpIds||[]).length)+'</span></button><button class="config-tab" data-tab="hooks">Hooks <span class="config-count">'+((binding.hookIds||[]).length)+'</span></button></div>'+pane('模型配置',model,'model')+pane('Skills','<p>启动时同步到远程机器。</p>'+choices(state.config.skills,binding.skillIds||[],'skills'),'skills',(binding.skillIds||[]).length)+pane('MCP','<p>由控制机 harness 连接和运行。</p>'+choices(state.config.mcps,binding.mcpIds||[],'mcps'),'mcps',(binding.mcpIds||[]).length)+pane('Hooks','<p>由控制机 harness 加载和执行。</p>'+choices(state.config.hooks,binding.hookIds||[],'hooks'),'hooks',(binding.hookIds||[]).length)+'<div class="notice">保存后需要重启 Web 才能应用新的资源配置。</div>';el('drawer-backdrop').classList.add('visible');document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===button));document.querySelectorAll('[data-pane]').forEach(x=>x.classList.toggle('active',x.dataset.pane===button.dataset.tab))});el('drawer-body').oninput=()=>{if(state.editing)state.editing.dirty=true};el('drawer-body').onchange=()=>{if(state.editing)state.editing.dirty=true}}
function closeConfig(force=false){if(!force&&state.editing?.dirty&&!el('drawer-save').disabled){const error=el('form-error');if(error){error.textContent='有未保存的修改，请点击“取消”放弃或“保存配置”保存。';error.classList.add('visible');return false}if(!confirm('配置尚未保存，确定放弃修改吗？'))return false}state.editing=null;el('drawer-backdrop').classList.remove('visible');el('drawer-save').disabled=false;el('drawer-save').style.display='';el('drawer-save').textContent='保存配置';void load();return true}
function renderEnrollment(info){el('drawer-title').textContent='接入 '+info.displayName;el('drawer-subtitle').textContent='在目标机器终端执行以下命令';el('drawer-body').innerHTML='<section class="config-section"><h3>连接远程机器</h3><p>脚本已经绑定这台机器的内部身份。机器名称、历史和配置由 Registry 保存。</p><div class="resource-list">'+info.commands.map((command,index)=>'<div class="resource-item enrollment-command"><div><div class="muted">局域网地址 '+esc(info.addresses[index]||'')+'</div><code>'+esc(command)+'</code></div><button class="btn secondary" data-copy="'+esc(command)+'">复制</button></div>').join('')+'</div><div class="notice">首次执行后，身份会保存到 ~/.dsh-remote/identity.json；后续更新和重启不需要重新命名。</div></section>';el('drawer-backdrop').classList.add('visible');el('drawer-save').style.display='none';document.querySelectorAll('[data-copy]').forEach(button=>button.onclick=async()=>{const label=button.textContent;button.disabled=true;try{await copyText(button.dataset.copy||'');button.textContent='已复制'}catch(error){button.textContent='复制失败';el('status').textContent=error instanceof Error?error.message:String(error)}finally{button.disabled=false;setTimeout(()=>{if(button.isConnected)button.textContent=label},1600)}})}
async function openEnrollment(id){state.editing={machineGuide:true,dirty:false};el('drawer-title').textContent='读取接入脚本…';el('drawer-subtitle').textContent='';el('drawer-body').innerHTML='<div class="muted">正在生成接入命令…</div>';el('drawer-backdrop').classList.add('visible');el('drawer-save').style.display='none';try{renderEnrollment(await api('/api/machines/'+encodeURIComponent(id)+'/enrollment'))}catch(e){el('drawer-body').textContent=String(e)}}
async function createMachine(){const name=el('machine-name').value.trim(),error=el('form-error');if(!name){error.textContent='请填写机器名称';error.classList.add('visible');return}el('drawer-save').disabled=true;el('drawer-save').textContent='创建中…';try{const result=await api('/api/machines',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({displayName:name})});state.editing={machineGuide:true,dirty:false};renderEnrollment(result.enrollment);await load()}catch(e){error.textContent=String(e);error.classList.add('visible');el('drawer-save').disabled=false;el('drawer-save').textContent='创建机器'}}
async function saveMachine(){if(!state.editing)return;const id=state.editing.id,picked=name=>Array.from(document.querySelectorAll('input[name="'+name+'"]:checked')).map(x=>x.value);el('drawer-save').disabled=true;el('drawer-save').textContent='保存中…';try{await api('/api/machines/'+encodeURIComponent(id)+'/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({modelProfileId:document.querySelector('input[name="model"]:checked')?.value||undefined,skillIds:picked('skills'),mcpIds:picked('mcps'),hookIds:picked('hooks')})});el('status').textContent='已保存 '+id+' 的配置；请手动重启 Web。';closeConfig(true)}catch(e){el('status').textContent=String(e);el('drawer-save').disabled=false;el('drawer-save').textContent='保存配置'}}
async function saveResource(){const editing=state.editing;if(!editing?.resourceKind)return;const kind=editing.resourceKind,body={name:el('resource-name').value.trim()};const error=message=>{el('form-error').textContent=message;el('form-error').classList.add('visible')};if(!body.name)return error('请填写资源名称');el('drawer-save').disabled=true;el('drawer-save').textContent='保存中…';try{if(kind==='models'){const base=el('resource-base').value.trim();if(!base)return error('请填写 Base URL');try{new URL(base)}catch{return error('Base URL 格式不正确')}body.baseUrl=base;body.model=el('resource-model').value.trim();const key=el('resource-key').value.trim();if(key)body.apiKey=key}else if(kind==='skills'){body.description=el('resource-description').value.trim();const files=el('skill-files')?.files;if(files&&files.length){body.files={};for(const file of files){const raw=file.webkitRelativePath||file.name;const path=raw.split('/').slice(1).join('/')||raw;body.files[path]=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=reject;reader.readAsDataURL(file)})}}}else if(kind==='mcps'){const transport=document.querySelector('[data-transport].active')?.dataset.transport||'stdio';const advanced=el('resource-json').value.trim();const config=advanced?JSON.parse(advanced):{};body.config=Object.assign(config,{transport,serverName:el('mcp-server').value.trim(),...(transport==='stdio'?{command:el('mcp-command').value.trim(),args:el('mcp-args').value.split(String.fromCharCode(10)).filter(Boolean)}:{url:el('mcp-url').value.trim()})})}else{body.config={event:el('hook-event').value,matcher:el('hook-matcher').value.trim(),command:el('hook-command').value.trim(),timeoutSec:Number(el('hook-timeout').value||600)};if(!body.config.command)return error('请填写 Hook command')}const endpoint=resourceEndpoint(kind),url=editing.resourceId?'/api/'+endpoint+'/'+encodeURIComponent(editing.resourceId):'/api/'+endpoint;await api(url,{method:editing.resourceId?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});el('status').textContent='资源已保存';closeConfig(true)}catch(e){error(String(e))}finally{if(state.editing){el('drawer-save').disabled=false;el('drawer-save').textContent='保存配置'}}}
function renderResources(kind){const key={models:'modelProfiles',skills:'skills',mcps:'mcps',hooks:'hooks'}[kind],items=state.config[key]||[];el('view').innerHTML='<div class="panel"><div class="actions"><button class="btn primary" id="add">新增'+({models:'模型配置',skills:'Skill',mcps:'MCP',hooks:'Hook'}[kind])+'</button></div><div class="resource-list resource">'+(items.length?items.map(i=>'<div class="resource-item"><div><strong>'+esc(i.name)+'</strong><div class="resource-meta">'+esc(i.description||i.config?.transport||i.baseUrl||'')+'</div></div><div class="actions"><button class="btn secondary" data-edit="'+esc(i.id)+'">编辑</button><button class="btn danger" data-delete="'+esc(i.id)+'">删除</button></div></div>').join(''):'<div class="empty">暂无资源</div>')+'</div></div>';el('add').onclick=()=>openResourceForm(kind);document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openResourceForm(kind,b.dataset.edit));document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>deleteResource(kind,b.dataset.delete))}
function resourceEndpoint(kind){return {models:'model-profiles',skills:'skills',mcps:'mcps',hooks:'hooks'}[kind]}
function openResourceForm(kind,id){const key={models:'modelProfiles',skills:'skills',mcps:'mcps',hooks:'hooks'}[kind],item=id?state.config[key].find(x=>x.id===id):undefined;state.editing={resourceKind:kind,resourceId:id,dirty:false};el('drawer-title').textContent=(id?'编辑':'新增')+({models:'模型配置',skills:' Skill',mcps:' MCP',hooks:' Hook'}[kind]);el('drawer-subtitle').textContent='填写完整信息后一次性保存';el('drawer-body').innerHTML=resourceForm(kind,item);el('drawer-backdrop').classList.add('visible');el('drawer-body').oninput=()=>{if(state.editing)state.editing.dirty=true};el('drawer-body').onchange=()=>{if(state.editing)state.editing.dirty=true};bindResourceForm(kind,item)}
function resourceForm(kind,item){const common='<div id="form-error" class="form-error"></div><div class="form-grid"><label class="field full"><span class="field-label required">名称</span><input class="input" id="resource-name" value="'+esc(item?.name||'')+'" placeholder="例如：个人模型 / 文件整理技能"></label>';
if(kind==='models')return common+'<label class="field full"><span class="field-label required">Base URL</span><input class="input" id="resource-base" type="url" value="'+esc(item?.baseUrl||'')+'" placeholder="https://api.example.com/v1"></label><label class="field full"><span class="field-label">API key '+(item?'（留空保持不变）':'')+'</span><input class="input" id="resource-key" type="password" placeholder="输入 API key"></label><label class="field full"><span class="field-label">默认模型</span><input class="input" id="resource-model" value="'+esc(item?.model||'')+'" placeholder="例如：deepseek-v4-flash"></label></div>';
if(kind==='skills')return common+'<label class="field full"><span class="field-label">描述</span><textarea class="textarea" id="resource-description" placeholder="说明这个 Skill 什么时候使用">'+esc(item?.description||'')+'</textarea></label><div class="field full"><span class="field-label required">Skill 文件</span><div class="upload"><input id="skill-files" type="file" multiple webkitdirectory directory><div class="help">选择包含 SKILL.md 的文件夹；文件只会在保存时上传到 registry。</div></div><div id="file-list" class="file-list" style="margin-top:8px"></div></div></div>';
if(kind==='mcps')return common+'<div class="field full"><span class="field-label">传输类型</span><div class="segmented"><button type="button" data-transport="stdio">stdio</button><button type="button" data-transport="streamable-http">Streamable HTTP</button></div></div><div id="mcp-fields"></div><details class="advanced field full"><summary>高级 JSON</summary><textarea class="textarea" id="resource-json">'+esc(JSON.stringify(item?.config||{},null,2))+'</textarea></details></div>';
return common+'<label class="field full"><span class="field-label required">事件</span><select class="select" id="hook-event">'+['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop'].map(event=>'<option '+(item?.config?.event===event?'selected':'')+'>'+event+'</option>').join('')+'</select></label><label class="field full"><span class="field-label">Matcher</span><input class="input" id="hook-matcher" value="'+esc(item?.config?.matcher||'')+'" placeholder="可选正则或工具名"></label><label class="field full"><span class="field-label required">Command</span><input class="input" id="hook-command" value="'+esc(item?.config?.command||'')+'" placeholder="例如：node scripts/check.mjs"></label><label class="field"><span class="field-label">Timeout（秒）</span><input class="input" id="hook-timeout" type="number" value="'+esc(item?.config?.timeoutSec||600)+'"></label><details class="advanced field full"><summary>高级 JSON</summary><textarea class="textarea" id="resource-json">'+esc(JSON.stringify(item?.config||{},null,2))+'</textarea></details></div>'}
function bindResourceForm(kind,item){const fileInput=el('skill-files');if(fileInput){fileInput.onchange=()=>{el('file-list').innerHTML=Array.from(fileInput.files).map(f=>'<div class="file-row"><span class="file-name">'+esc(f.webkitRelativePath||f.name)+'</span><span class="muted">'+Math.ceil(f.size/1024)+' KB</span></div>').join('')}}if(kind==='mcps'){const current=item?.config?.transport||'stdio';const renderMcp=transport=>{document.querySelectorAll('[data-transport]').forEach(b=>b.classList.toggle('active',b.dataset.transport===transport));el('mcp-fields').innerHTML=transport==='stdio'?'<div class="form-grid"><label class="field full"><span class="field-label required">Server name</span><input class="input" id="mcp-server" value="'+esc(item?.config?.serverName||'')+'"></label><label class="field full"><span class="field-label required">Command</span><input class="input" id="mcp-command" value="'+esc(item?.config?.command||'')+'"></label><label class="field full"><span class="field-label">Arguments（每行一个）</span><textarea class="textarea" id="mcp-args">'+esc((item?.config?.args||[]).join(String.fromCharCode(10)))+'</textarea></label></div>':'<div class="form-grid"><label class="field full"><span class="field-label required">Server name</span><input class="input" id="mcp-server" value="'+esc(item?.config?.serverName||'')+'"></label><label class="field full"><span class="field-label required">URL</span><input class="input" id="mcp-url" type="url" value="'+esc(item?.config?.url||'')+'"></label></div>';document.querySelectorAll('[data-transport]').forEach(b=>b.onclick=()=>renderMcp(b.dataset.transport))};renderMcp(current)}}
async function deleteResource(kind,id){try{await api('/api/'+({models:'model-profiles',skills:'skills',mcps:'mcps',hooks:'hooks'}[kind])+'/'+encodeURIComponent(id),{method:'DELETE'});await load()}catch(e){el('status').textContent=String(e)}}
async function deleteMachine(id,name){if(!confirm('确定删除“'+name+'”吗？\\n\\n删除后会停止它的 dsh Web、断开远程连接，并清除这台机器在 Registry 中的配置。'))return;try{await api('/api/machines/'+encodeURIComponent(id),{method:'DELETE'});el('status').textContent='机器已删除';await load()}catch(e){el('status').textContent=String(e)}}
async function machineAction(encoded,kind){if(kind==='open'){const tab=window.open('about:blank','_blank');if(!tab){el('status').textContent='浏览器阻止了新标签页，请允许此站点打开新标签页后重试。';return}tab.document.write('<title>正在启动 Remote Web</title><p style="font:16px system-ui;padding:32px">正在启动远程 Web…</p>');try{const r=await api('/api/machines/'+encoded+'/open',{method:'POST'});tab.location.href=r.launchUrl;await load()}catch(e){tab.close();el('status').textContent=String(e)}}else{try{await api('/api/machines/'+encoded+'/stop',{method:'POST'});await load()}catch(e){el('status').textContent=String(e)}}}
el('drawer-close').onclick=()=>closeConfig();el('drawer-cancel').onclick=()=>closeConfig(true);el('drawer-save').onclick=()=>state.editing?.machineCreate?createMachine():state.editing?.resourceKind?saveResource():saveMachine();el('drawer-backdrop').onclick=e=>{if(e.target===el('drawer-backdrop'))closeConfig()};document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.editing)closeConfig()});document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>{if(state.editing&&!closeConfig())return;state.view=b.dataset.view;document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x===b));render()});load();setInterval(load,5000);
const addMachine=document.createElement('button');addMachine.className='btn primary';addMachine.textContent='添加机器';addMachine.onclick=()=>{state.editing={machineCreate:true,dirty:false};el('drawer-title').textContent='添加机器';el('drawer-subtitle').textContent='先为这台机器设置一个容易识别的名称';el('drawer-body').innerHTML='<div id="form-error" class="form-error"></div><div class="form-grid"><label class="field full"><span class="field-label required">机器名称</span><input class="input" id="machine-name" maxlength="64" autofocus placeholder="例如：Langfuse 测试服务器 / 张三的 MacBook"></label><div class="field full help">支持中文、英文、数字和空格。名称只用于展示，不参与机器身份和文件路径。</div></div>';el('drawer-backdrop').classList.add('visible');el('drawer-save').style.display='';el('drawer-save').textContent='创建机器';el('drawer-body').oninput=()=>{if(state.editing)state.editing.dirty=true};setTimeout(()=>el('machine-name').focus(),0)};document.querySelector('.top>div:last-child').append(' ',addMachine);
</script></body></html>`)
  }
  private launchPage(machineId: string, response: import('node:http').ServerResponse): void {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><meta charset="utf-8"><title>正在启动 Remote Web</title><style>body{font:15px system-ui;background:#f7f8fa;color:#18212f;display:grid;place-items:center;min-height:100vh}.box{background:#fff;border:1px solid #e5e9ef;border-radius:18px;padding:32px;min-width:320px;box-shadow:0 12px 40px #18212f12}h1{font-size:20px;margin:0 0 10px}.stage{color:#2563eb;margin:18px 0}.muted{color:#6b7685}.error{color:#b42318;background:#fff0ee;padding:12px;border-radius:8px;white-space:pre-wrap}.btn{border:0;border-radius:8px;padding:9px 13px;background:#18212f;color:#fff;cursor:pointer}</style><main class="box"><h1>正在启动远程 Web</h1><div class="muted">${escapeHtml(machineId)}</div><div id="stage" class="stage">正在准备…</div><div id="elapsed" class="muted"></div><div id="error"></div><button id="cancel" class="btn">取消启动</button></main><script>const machine=${JSON.stringify(machineId)},started=Date.now(),stage=document.getElementById('stage'),elapsed=document.getElementById('elapsed'),error=document.getElementById('error'),cancel=document.getElementById('cancel');async function poll(){const r=await fetch('/api/machines/'+encodeURIComponent(machine)+'/open-status');const x=await r.json();stage.textContent=x.message||x.stage;elapsed.textContent='已等待 '+Math.floor((Date.now()-started)/1000)+' 秒';if(x.stage==='ready'&&x.url){location.replace(x.url);return}if(x.stage==='failed'||x.stage==='cancelled'){error.className=x.stage==='failed'?'error':'';error.textContent=x.error||x.message;cancel.style.display='none';return}setTimeout(poll,800)}cancel.onclick=async()=>{await fetch('/api/machines/'+encodeURIComponent(machine)+'/open-cancel',{method:'POST'});poll()};poll();setInterval(()=>elapsed.textContent='已等待 '+Math.floor((Date.now()-started)/1000)+' 秒',1000)</script>`)
  }

  private async syncSkills(agent: AgentConnection, machineId: string, skills: Array<{ id: string; files: Record<string, string> }>): Promise<void> {
    if (skills.length === 0) return
    const requestId = randomUUID()
    const files = skills.flatMap(skill => Object.entries(skill.files).map(([path, contentBase64]) => ({ path: `${skill.id}/${path}`, contentBase64 })))
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`skill sync timed out for ${machineId}`)) }, 15_000)
      const onMessage = (raw: WebSocket.RawData): void => {
        try { const frame = JSON.parse(raw.toString()) as { type?: string; requestId?: string; ok?: boolean; error?: string }; if (frame.type !== 'skills.synced' || frame.requestId !== requestId) return; cleanup(); frame.ok === true ? resolve() : reject(new Error(frame.error ?? 'skill sync failed')) } catch { /* ignore unrelated frames */ }
      }
      const cleanup = (): void => { clearTimeout(timeout); agent.socket.off('message', onMessage) }
      agent.socket.on('message', onMessage)
      agent.socket.send(JSON.stringify({ type: 'skills.sync', requestId, root: agent.registration.skillRootPath ?? '.dsh-remote/skills', files }))
    })
  }

  private async stopWeb(machineId: string, response: import('node:http').ServerResponse): Promise<void> { await this.web.stop(machineId); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ stopped: true })) }

  private publicWsUrl(): string { return `ws://${this.config.host === '0.0.0.0' ? '127.0.0.1' : this.config.host}:${this.boundPort()}` }
  private boundPort(): number { const address = this.server.address(); if (address === null || typeof address === 'string') throw new Error('remote-registry: listener is not active'); return address.port }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://registry')
    const refererMachine = this.machineFromReferer(request)
    if (refererMachine !== undefined && !url.pathname.startsWith('/machines/') && !url.pathname.startsWith('/web/')) {
      this.wss.handleUpgrade(request, socket, head, viewer => this.proxyWebSocket(refererMachine, url.pathname + url.search, viewer))
      return
    }
    if (url.pathname === '/agent') {
      this.wss.handleUpgrade(request, socket, head, client => this.acceptAgent(client))
      return
    }
    const match = /^\/machines\/([^/]+)\/executor$/.exec(url.pathname)
    if (match?.[1] !== undefined) {
      this.wss.handleUpgrade(request, socket, head, client => this.acceptViewer(client, match[1]!, url.searchParams.get('token')))
      return
    }
    const webProxy = /^\/web\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (webProxy?.[1] !== undefined) {
      this.wss.handleUpgrade(request, socket, head, viewer => this.proxyWebSocket(decodeURIComponent(webProxy[1]!), webProxy[2] ?? '/', viewer))
      return
    }
    socket.destroy()
  }

  private proxyWebSocket(machineId: string, path: string, viewer: WebSocket): void {
    const web = this.web.get(machineId)
    if (web === undefined) { viewer.close(1013, 'dsh Web is not running'); return }
    const target = new URL(web.url)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const requested = new URL(path, 'http://registry')
    target.pathname = requested.pathname
    target.search = requested.search
    const upstream = new WebSocket(target.toString(), { headers: { origin: target.origin } })
    const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = []
    const close = (): void => { if (viewer.readyState === WebSocket.OPEN) viewer.close(); if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close() }
    viewer.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, binary })
    })
    viewer.on('close', close); viewer.on('error', close)
    upstream.on('open', () => { for (const frame of pending.splice(0)) upstream.send(frame.data, { binary: frame.binary }) })
    upstream.on('message', (data, binary) => { if (viewer.readyState === WebSocket.OPEN) viewer.send(data, { binary }) })
    upstream.on('close', close); upstream.on('error', close)
  }

  private acceptAgent(socket: WebSocket): void {
    let agent: AgentConnection | undefined
    socket.once('message', raw => {
      try {
        const registration = parseAgentRegister(JSON.parse(raw.toString()))
        if (this.configStore.isMachineRevoked(registration.machineId)) throw new Error('remote-registry: machine enrollment was deleted')
        const stored = this.configStore.machineRecord(registration.machineId)
        const expectedToken = stored?.agentToken ?? this.config.agentToken
        if (expectedToken !== undefined && registration.token !== expectedToken) throw new Error('remote-registry: invalid agent token')
        if (stored === undefined) this.configStore.adoptMachine(registration.machineId, registration.displayName)
        else this.configStore.markMachineClaimed(registration.machineId)
        const previous = this.agents.get(registration.machineId); previous?.socket.close()
        agent = { registration, socket, connectedAt: Date.now(), lastHeartbeat: Date.now() }
        this.agents.set(registration.machineId, agent)
        socket.send(JSON.stringify({ type: 'agent.accepted', protocolVersion: REGISTRY_PROTOCOL_VERSION, machineId: registration.machineId }))
        socket.on('message', data => this.handleAgentMessage(agent!, data.toString()))
        socket.on('close', () => this.removeAgent(agent!))
      } catch (error) { socket.send(JSON.stringify({ type: 'registry.error', error: error instanceof Error ? error.message : String(error) })); socket.close() }
    })
  }

  private acceptViewer(viewer: WebSocket, machineId: string, token: string | null): void {
    const agent = this.agents.get(machineId)
    if (agent === undefined) { viewer.close(1013, 'machine is offline'); return }
    const expectedToken = agent.registration.token ?? this.config.agentToken
    if (expectedToken !== undefined && token !== expectedToken) { viewer.close(1008, 'invalid registry token'); return }
    const bridge: Bridge = { id: randomUUID(), agent, viewer, pending: [], ready: false }
    this.bridges.set(bridge.id, bridge)
    const cleanup = (): void => { this.bridges.delete(bridge.id); if (agent.socket.readyState === WebSocket.OPEN) agent.socket.send(JSON.stringify({ type: 'bridge.close', bridgeId: bridge.id })); if (viewer.readyState === WebSocket.OPEN) viewer.close() }
    viewer.on('close', cleanup); viewer.on('error', cleanup)
    viewer.on('message', data => {
      const payload = data.toString()
      if (!bridge.ready) { bridge.pending.push(payload); return }
      if (agent.socket.readyState === WebSocket.OPEN) agent.socket.send(JSON.stringify({ type: 'bridge.message', bridgeId: bridge.id, data: payload }))
    })
    agent.socket.send(JSON.stringify({ type: 'bridge.open', bridgeId: bridge.id }))
  }

  private handleAgentMessage(agent: AgentConnection, raw: string): void {
    let frame: AgentFrame & { data?: string }
    try { frame = JSON.parse(raw) as typeof frame } catch { return }
    if (frame.type === 'agent.heartbeat') { agent.lastHeartbeat = Date.now(); return }
    if (frame.type === 'bridge.ready' || frame.type === 'bridge.closed') {
      const bridge = this.bridges.get(frame.bridgeId); if (bridge === undefined) return
      if (frame.type === 'bridge.ready') {
        bridge.ready = true
        for (const data of bridge.pending.splice(0)) agent.socket.send(JSON.stringify({ type: 'bridge.message', bridgeId: bridge.id, data }))
        return
      }
      if (frame.error !== undefined) console.error(`remote-registry: bridge ${bridge.id} for ${agent.registration.machineId} failed: ${frame.error}`)
      const reason = frame.error === undefined ? 'remote bridge closed' : frame.error.slice(0, 120)
      bridge.viewer.close(1011, reason); this.bridges.delete(bridge.id); return
    }
    if ((frame as { type?: string }).type === 'bridge.message' && typeof frame.data === 'string') {
      const bridge = this.bridges.get((frame as { bridgeId: string }).bridgeId)
      if (bridge?.viewer.readyState === WebSocket.OPEN) bridge.viewer.send(frame.data)
    }
  }

  private removeAgent(agent: AgentConnection): void {
    if (this.agents.get(agent.registration.machineId) !== agent) return
    this.agents.delete(agent.registration.machineId)
    void this.web.stop(agent.registration.machineId)
    for (const bridge of [...this.bridges.values()]) if (bridge.agent === agent) { bridge.viewer.close(1012, 'agent disconnected'); this.bridges.delete(bridge.id) }
  }

  private expireAgents(): void { const now = Date.now(); for (const agent of this.agents.values()) if (now - agent.lastHeartbeat > this.config.heartbeatTimeoutMs) { agent.socket.close(); this.removeAgent(agent) } }
}

export default RemoteRegistry

function escapeHtml(value: string): string { return value.replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[char] ?? char)) }
function normalizeMachineName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('machine name is required')
  const name = value.trim()
  if (name.length === 0) throw new Error('machine name is required')
  if ([...name].length > 64) throw new Error('machine name must be at most 64 characters')
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('machine name contains unsupported control characters')
  return name
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\"'\"'`)}'` }
export function injectBrowserCompatibility(html: string, machineId: string): string {
  const proxyPrefix = `/web/${encodeURIComponent(machineId)}`
  const script = `<script>(function(){var c=globalThis.crypto;if(c&&typeof c.randomUUID!=='function'&&typeof c.getRandomValues==='function'){c.randomUUID=function(){var b=new Uint8Array(16);c.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=Array.from(b,function(x){return x.toString(16).padStart(2,'0')}).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)}}var W=globalThis.WebSocket,F=globalThis.fetch,p=${JSON.stringify(proxyPrefix)};if(typeof W==='function'){globalThis.WebSocket=class extends W{constructor(){var a=Array.prototype.slice.call(arguments),u=new URL(String(a[0]),location.href);if(u.host===location.host&&!u.pathname.startsWith(p+'/')){u.pathname=p+(u.pathname.startsWith('/')?u.pathname:'/'+u.pathname);a[0]=u.toString()}super(...a)}}}if(typeof F==='function'){globalThis.fetch=function(i,n){var r=typeof Request==='function'&&i instanceof Request,u=new URL(String(r?i.url:i),location.href);if(u.origin===location.origin&&u.pathname.startsWith('/api/')){u.pathname=p+u.pathname;i=r?new Request(u,i):u}return F.call(this,i,n)}}})();</script>`
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024 * 1024) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

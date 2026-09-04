import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import WebSocket from 'ws'

const REGISTRY_PROTOCOL_VERSION = 1 as const

export interface RemoteAgentConfig {
  registryUrl: string
  machineId: string
  displayName?: string
  root?: string
  token?: string
  registryToken?: string
  executorCommand?: string
  executorArgs?: readonly string[]
  heartbeatMs?: number
}

interface BridgeRuntime { readonly id: string; readonly executor: ChildProcess; readonly socket: WebSocket }

export class RemoteAgent {
  readonly config: RemoteAgentConfig & { registryUrl: string; machineId: string; root: string; displayName: string; heartbeatMs: number }
  private registry: WebSocket | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private readonly bridges = new Map<string, BridgeRuntime>()
  private stopped = false

  constructor(config: RemoteAgentConfig) {
    this.config = { ...config, registryUrl: requireWs(config.registryUrl), root: config.root ?? '/', displayName: config.displayName ?? config.machineId, heartbeatMs: config.heartbeatMs ?? 15_000 }
  }

  async start(): Promise<void> {
    this.stopped = false
    let delayMs = 250
    while (!this.stopped) {
      try {
        await this.connect()
        return
      } catch (error) {
        // Startup races are expected when the registry is being restarted or
        // the machine is booting. Keep the agent alive instead of turning one
        // transient ECONNREFUSED into a permanently dead registration.
        console.error(`remote-agent: registry unavailable (${formatError(error)}); retrying in ${delayMs}ms`)
        await delay(delayMs)
        delayMs = Math.min(delayMs * 2, 5000)
      }
    }
    throw new Error('remote-agent: stopped before registry connection became ready')
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    for (const bridge of this.bridges.values()) { bridge.socket.close(); terminate(bridge.executor) }
    this.bridges.clear(); this.registry?.close(); this.registry = undefined
  }

  private async connect(): Promise<void> {
    const socket = new WebSocket(`${this.config.registryUrl.replace(/\/$/, '')}/agent`)
    this.registry = socket
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    } catch (error) {
      socket.close()
      if (this.registry === socket) this.registry = undefined
      throw error
    }
    socket.send(JSON.stringify({ type: 'agent.register', protocolVersion: REGISTRY_PROTOCOL_VERSION, machineId: this.config.machineId, displayName: this.config.displayName, platform: process.platform, rootPath: this.config.root, skillRootPath: this.skillRoot(), capabilities: ['subprocess', 'fs', 'workspace', 'directory-browse', 'sandbox', 'skill-sync'], ...(this.config.registryToken ?? this.config.token) === undefined ? {} : { token: this.config.registryToken ?? this.config.token }, ...(this.config.token === undefined ? {} : { executorToken: this.config.token }) }))
    socket.on('message', raw => this.handleFrame(raw.toString()))
    socket.on('close', () => { if (!this.stopped) void this.reconnect() })
    this.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'agent.heartbeat', machineId: this.config.machineId, timestamp: Date.now() })) }, this.config.heartbeatMs)
    this.heartbeat.unref()
  }

  private async reconnect(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (!this.stopped) { try { await this.connect() } catch { void this.reconnect() } }
  }

  private handleFrame(raw: string): void {
    let frame: { type?: string; bridgeId?: string; data?: string; root?: string; requestId?: string; files?: Array<{ path: string; contentBase64: string; mode?: number }> }
    try { frame = JSON.parse(raw) as typeof frame } catch { return }
    if (frame.type === 'bridge.open' && frame.bridgeId !== undefined) { void this.openBridge(frame.bridgeId); return }
    if (frame.type === 'bridge.close' && frame.bridgeId !== undefined) { this.closeBridge(frame.bridgeId); return }
    if (frame.type === 'bridge.message' && frame.bridgeId !== undefined && typeof frame.data === 'string') {
      const bridge = this.bridges.get(frame.bridgeId); if (bridge?.socket.readyState === WebSocket.OPEN) bridge.socket.send(frame.data)
    }
    if (frame.type === 'skills.sync' && Array.isArray(frame.files)) { void this.syncSkills({ ...(frame.root === undefined ? {} : { root: frame.root }), ...(frame.requestId === undefined ? {} : { requestId: frame.requestId }), files: frame.files }); return }
  }

  private async syncSkills(request: { root?: string; requestId?: string; files: Array<{ path: string; contentBase64: string; mode?: number }> }): Promise<void> {
    try {
      const defaultRoot = this.skillRoot()
      const root = request.root === undefined ? defaultRoot : resolve(this.config.root, request.root)
      if (!within(this.config.root, root)) throw new Error('skill target escaped executor root')
      await mkdir(root, { recursive: true })
      for (const file of request.files) {
        const target = resolve(root, file.path)
        if (!within(root, target)) throw new Error(`skill path escaped target: ${file.path}`)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, Buffer.from(file.contentBase64, 'base64'))
        if (file.mode !== undefined) await chmod(target, file.mode & 0o777)
      }
      this.send({ type: 'skills.synced', ...(request.requestId === undefined ? {} : { requestId: request.requestId }), ok: true })
    } catch (error) { this.send({ type: 'skills.synced', ...(request.requestId === undefined ? {} : { requestId: request.requestId }), ok: false, error: error instanceof Error ? error.message : String(error) }) }
  }
  private skillRoot(): string { return this.config.root === resolve('/') ? resolve(homedir(), '.dsh-remote/skills') : resolve(this.config.root, '.dsh-remote/skills') }

  private async openBridge(id: string): Promise<void> {
    if (this.bridges.has(id) || this.registry?.readyState !== WebSocket.OPEN) return
    const executor = spawn(this.config.executorCommand ?? 'dsh-subprocess-executor', [...(this.config.executorArgs ?? []), '--host', '127.0.0.1', '--port', '0', '--root', this.config.root], { env: { ...executorEnv(), ...(this.config.token === undefined ? {} : { DSH_EXECUTOR_TOKEN: this.config.token }) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let executorStderr = ''
    executor.stderr?.on('data', (chunk: Buffer | string) => {
      executorStderr = `${executorStderr}${String(chunk)}`.slice(-8192)
    })
    try {
      const url = await readUrl(executor)
      const socket = new WebSocket(url)
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      const bridge: BridgeRuntime = { id, executor, socket }; this.bridges.set(id, bridge)
      socket.on('message', data => this.send({ type: 'bridge.message', bridgeId: id, data: data.toString() }))
      socket.on('close', () => this.closeBridge(id))
      this.send({ type: 'bridge.ready', bridgeId: id })
    } catch (error) {
      terminate(executor)
      const message = error instanceof Error ? error.message : String(error)
      const detail = executorStderr.trim()
      this.send({ type: 'bridge.closed', bridgeId: id, error: detail.length === 0 ? message : `${message}: ${detail}` })
    }
  }

  private closeBridge(id: string): void { const bridge = this.bridges.get(id); if (bridge === undefined) return; this.bridges.delete(id); bridge.socket.close(); terminate(bridge.executor) }
  private send(frame: object): void { if (this.registry?.readyState === WebSocket.OPEN) this.registry.send(JSON.stringify(frame)) }
}

function within(root: string, target: string): boolean {
  const child = relative(resolve(root), resolve(target))
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !child.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(child))
}

async function readUrl(executor: ChildProcess): Promise<string> {
  if (executor.stdout === null) throw new Error('remote-agent: executor stdout unavailable')
  const lines = createInterface({ input: executor.stdout })
  for await (const line of lines) if (line.trim().startsWith('ws://') || line.trim().startsWith('wss://')) { lines.close(); return line.trim() }
  throw new Error(`remote-agent: executor exited before readiness (code ${executor.exitCode ?? 'unknown'})`)
}
function requireWs(value: string): string { if (!value.startsWith('ws://') && !value.startsWith('wss://')) throw new Error('remote-agent: registryUrl must start with ws:// or wss://'); return value }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function terminate(child: ChildProcess): void { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }
function executorEnv(): NodeJS.ProcessEnv { const result: NodeJS.ProcessEnv = {}; for (const key of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'TZ']) if (process.env[key] !== undefined) result[key] = process.env[key]; return result }

export default RemoteAgent

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MachineBinding, ModelProfile, McpResource, HookResource, SkillResource } from './config-store.ts'

export interface DshWebLaunchConfig {
  readonly command?: string
  readonly commandArgs?: readonly string[]
  readonly profile?: string
  readonly host?: string
  readonly advertisedHost?: string
  readonly startPort?: number
  readonly readinessTimeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
  readonly profilePackageDir?: string
  readonly configRoot?: string
}

export type WebLaunchStage = 'checking-agent' | 'syncing-skills' | 'starting-dsh' | 'waiting-ready'
export interface WebLaunchProgress { stage: WebLaunchStage; message: string }

export interface RunningDshWeb {
  readonly machineId: string
  readonly process: ChildProcess
  readonly url: string
  readonly port: number
  readonly startedAt: number
  stop(): Promise<void>
}

export class DshWebLauncher {
  private readonly running = new Map<string, RunningDshWeb>()
  private nextPort: number

  constructor(private readonly config: DshWebLaunchConfig = {}) {
    this.nextPort = config.startPort ?? 33100
  }

  list(): RunningDshWeb[] { return [...this.running.values()] }
  get(machineId: string): RunningDshWeb | undefined { return this.running.get(machineId) }

  async launch(machineId: string, executorUrl: string, executorToken?: string, binding?: { model?: ModelProfile; skills?: SkillResource[]; mcps?: McpResource[]; hooks?: HookResource[]; machine?: MachineBinding }, options?: { signal?: AbortSignal; onProgress?: (progress: WebLaunchProgress) => void }): Promise<RunningDshWeb> {
    options?.onProgress?.({ stage: 'starting-dsh', message: '正在准备 dsh Web…' })
    if (options?.signal?.aborted) throw new Error('启动已取消')
    const existing = this.running.get(machineId)
    if (existing !== undefined && existing.process.exitCode === null) return existing
    // dsh deliberately rejects 0.0.0.0 for its Web app. The registry itself
    // may be LAN-visible, but the dsh child stays on localhost for safety.
    const host = this.config.host ?? '127.0.0.1'
    const port = await this.reservePort(host)
    const sharedHome = this.config.env?.['DSH_HOME'] ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
    const machineHome = join(sharedHome, 'remote-machines', safeMachineId(machineId))
    const modelEnv = join(sharedHome, 'model.env')
    prepareLocalSkills(machineHome, binding?.skills ?? [])
    if ((this.config.profile ?? 'web-remote') === 'web-remote') ensureRemoteProfile(machineHome, this.config.profilePackageDir, binding)
    const sharedModelEnv = readEnvFile(modelEnv)
    const sharedCredentials = join(sharedHome, '.credentials.yaml')
    linkSharedFile(sharedCredentials, join(machineHome, '.credentials.yaml'))
    linkSharedFile(modelEnv, join(machineHome, 'model.env'))
    linkSharedFile(join(sharedHome, 'settings.yaml'), join(machineHome, 'settings.yaml'))
    const child = spawn(this.config.command ?? 'dsh', [
      ...(this.config.commandArgs ?? []),
      '--profile', this.config.profile ?? 'web-remote',
      '--host', host,
      '--port', String(port),
    ], {
      env: {
        ...process.env,
        ...sharedModelEnv,
        ...(this.config.env ?? {}),
        ...(binding?.model === undefined ? {} : { DEEPSEEK_BASE_URL: binding.model.baseUrl, DEEPSEEK_API_KEY: binding.model.apiKey, ...(binding.model.model === undefined ? {} : { DSH_MODEL: binding.model.model }) }),
        DSH_HOME: machineHome,
        DSH_MODEL_ENV: modelEnv,
        DSH_REMOTE_SKILL_DIR: join(machineHome, 'remote-skills'),
        DSH_EXECUTOR_URL: executorUrl,
        ...(executorToken === undefined ? {} : { DSH_EXECUTOR_TOKEN: executorToken }),
      },
      // Keep the dsh process and any pnpm/node descendants in one group so
      // stop/dispose can clean up the complete Web instance.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostics = ''
    child.stdout?.on('data', data => { diagnostics = bounded(diagnostics, data.toString()) })
    child.stderr?.on('data', data => { diagnostics = bounded(diagnostics, data.toString()) })
    try {
      await Promise.race([
        waitForPort(host, port, child, this.config.readinessTimeoutMs ?? 30_000, () => diagnostics, options?.signal),
        new Promise<never>((_, reject) => child.once('error', error => reject(new Error(`remote-registry: cannot start dsh Web: ${error.message}`)))),
      ])
    } catch (error) {
      terminate(child)
      throw error
    }
    const url = `http://${this.config.advertisedHost ?? host}:${port}`
    const stop = async (): Promise<void> => { terminate(child); await exited(child) }
    const running: RunningDshWeb = { machineId, process: child, url, port, startedAt: Date.now(), stop }
    this.running.set(machineId, running)
    child.once('exit', () => { if (this.running.get(machineId) === running) this.running.delete(machineId) })
    return running
  }

  async stop(machineId: string): Promise<void> { await this.running.get(machineId)?.stop() }
  async dispose(): Promise<void> { await Promise.all([...this.running.values()].map(item => item.stop())); this.running.clear() }

  private async reservePort(host: string): Promise<number> {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const port = this.nextPort++
      if (await isPortFree(host, port)) return port
    }
    throw new Error('remote-registry: no free dsh Web port found')
  }
}

function prepareLocalSkills(machineHome: string, skills: SkillResource[]): void {
  const root = join(machineHome, 'remote-skills')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  for (const skill of skills) for (const [path, contentBase64] of Object.entries(skill.files)) {
    if (path === '' || path.startsWith('/') || path.split(/[\\/]/).includes('..')) throw new Error(`remote-registry: unsafe skill path ${path}`)
    const target = join(root, skill.id, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(contentBase64, 'base64'))
  }
}

function ensureRemoteProfile(configuredHome: string | undefined, profilePackageDir: string | undefined, binding?: { mcps?: McpResource[]; hooks?: HookResource[] }): void {
  const home = configuredHome ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const dir = join(home, 'profiles', 'web-remote')
  mkdirSync(dir, { recursive: true })
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest) || binding !== undefined) writeFileSync(manifest, JSON.stringify({
    name: 'dsh-profile-web-remote', private: true,
    dependencies: {
      ...(binding?.mcps?.length ? { '@deepseek-ai/dsh-mcp-client': 'workspace:*' } : {}),
      ...(binding?.hooks?.length ? { '@deepseek-ai/dsh-hooks-codex': 'workspace:*' } : {}),
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-web-remote'] } },
  }, undefined, 2) + '\n')
  if (profilePackageDir !== undefined) {
    const profileNodeModules = join(dir, 'node_modules', '@deepseek-ai')
    mkdirSync(profileNodeModules, { recursive: true })
    const sourceNodeModules = join(profilePackageDir, 'node_modules', '@deepseek-ai')
    for (const packageName of ['dsh-web-remote', 'dsh-bash-remote', 'dsh-fs-remote', 'dsh-host-apiproxy-remote', 'dsh-host-directory-picker-remote', 'dsh-subprocess-remote', 'dsh-tool-fs-search-remote', 'dsh-workspace-remote', 'dsh-sandbox-policy', 'dsh-client-ui-directory-picker-browse', 'dsh-host-apiproxy']) {
      const link = join(profileNodeModules, packageName)
      const source = join(sourceNodeModules, packageName)
      if (!existsSync(link) && existsSync(source)) {
        try { symlinkSync(source, link, 'dir') } catch { /* another launcher may have won the race */ }
      }
    }
  }
  const patch = join(dir, 'cordis.patch.yml')
  if (!existsSync(patch) || binding !== undefined) writeFileSync(patch, profilePatch(binding))
  const workspace = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) writeFileSync(workspace, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

function profilePatch(binding?: { mcps?: McpResource[]; hooks?: HookResource[] }): string {
  const rows: unknown[] = [{ id: 'skill-filesystem', config: { customSkillDirs: ['!!js process.env.DSH_REMOTE_SKILL_DIR'] } }]
  for (const mcp of binding?.mcps ?? []) rows.push({ insert: [{ id: `remote-mcp-${mcp.id}`, name: '@deepseek-ai/dsh-mcp-client', config: mcp.config }] })
  for (const hook of binding?.hooks ?? []) rows.push({ insert: [{ id: `remote-hook-${hook.id}`, name: '@deepseek-ai/dsh-hooks-codex', config: hook.config }] })
  return `${JSON.stringify(rows, undefined, 2).replace('"!!js process.env.DSH_REMOTE_SKILL_DIR"', '!!js process.env.DSH_REMOTE_SKILL_DIR')}\n`
}

function safeMachineId(machineId: string): string {
  const label = machineId.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'machine'
  const identity = createHash('sha256').update(machineId).digest('hex').slice(0, 16)
  return `${label}-${identity}`
}

function linkSharedFile(source: string, target: string): void {
  if (!existsSync(source) || existsSync(target)) return
  mkdirSync(dirname(target), { recursive: true })
  try { symlinkSync(source, target, 'file') } catch { /* another launcher may have won the race */ }
}

function readEnvFile(path: string): NodeJS.ProcessEnv {
  if (!existsSync(path)) return {}
  const result: NodeJS.ProcessEnv = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined && !match[1].startsWith('DSH_')) result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return result
}

async function isPortFree(host: string, port: number): Promise<boolean> {
  const server = createServer()
  return await new Promise(resolve => {
    server.once('error', () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}

async function waitForPort(host: string, port: number, child: ChildProcess, timeoutMs: number, diagnostics: () => string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('启动已取消')
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`remote-registry: dsh Web exited during startup\n${diagnostics()}`)
    if (!await isPortFree(host, port)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`remote-registry: dsh Web did not listen on ${host}:${port} within ${timeoutMs}ms\n${diagnostics()}`)
}

function bounded(current: string, chunk: string): string { return (current + chunk).slice(-16 * 1024) }
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  signalProcess(child, 'SIGTERM')
}
async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<void>(resolve => setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalProcess(child, 'SIGKILL')
      resolve()
    }, 5000)),
  ])
}
function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return } catch { /* fall back to direct child */ }
  }
  try { child.kill(signal) } catch {}
}

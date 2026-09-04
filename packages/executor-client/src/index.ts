import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { realpath } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const DEFAULT_READINESS_TIMEOUT_MS = 15_000
const MAX_STARTUP_DIAGNOSTIC_BYTES = 16 * 1024
const EXECUTOR_ENVIRONMENT_KEYS = new Set([
  'APPDATA',
  'COLORTERM',
  'COMSPEC',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
  'FORCE_COLOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LD_LIBRARY_PATH',
  'LOCALAPPDATA',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  '__CF_USER_TEXT_ENCODING',
])

/** Options for starting an executor and an explicitly selected dsh profile. */
export interface RemoteLaunchOptions {
  /** Optional executor directory-browsing root. Defaults to `/`. */
  root?: string
  /** Connect to an already-running executor instead of spawning one locally. */
  executorUrl?: string
  /** Executor command, resolved through PATH when omitted. */
  executorCommand?: string
  /** Arguments passed to the executor command before its own options. */
  executorArgs?: readonly string[]
  /** Maximum time to wait for the executor WebSocket URL. */
  readinessTimeoutMs?: number
  /** dsh command or executable to launch. */
  dshCommand?: string
  /** Arguments passed to dsh after the remote profile flags. */
  dshArgs?: readonly string[]
  /** Explicit remote profile name. */
  profile?: string
  /** Optional localhost or trusted-network POC token. */
  token?: string
  /**
   * Additional dsh environment values. An owned executor receives only the
   * runtime allowlist plus its RPC token, so Harness state and cloud
   * credentials remain in the control-plane process.
   */
  env?: NodeJS.ProcessEnv
}

/** Running remote dsh process pair. */
export interface RemoteLaunch {
  readonly executor: ChildProcess | undefined
  readonly dsh: ChildProcess
  readonly url: string
  /** Wait for dsh to exit, then stop the executor. */
  wait(): Promise<number>
  /** Stop both owned processes and wait for quiescence. */
  stop(signal?: NodeJS.Signals): Promise<void>
}

/** Start one executor and one dsh process with an explicit remote profile. */
export async function launchRemote(options: RemoteLaunchOptions): Promise<RemoteLaunch> {
  const externalExecutor = options.executorUrl !== undefined
  const root = externalExecutor ? options.root : await realpath(options.root ?? '/')
  const inheritedEnv = mergeEnvironment(process.env, options.env)
  const token = options.token ?? inheritedEnv['DSH_EXECUTOR_TOKEN']
  const dshEnv: NodeJS.ProcessEnv = {
    ...inheritedEnv,
    ...(token === undefined ? {} : { DSH_EXECUTOR_TOKEN: token }),
  }
  let executor: ChildProcess | undefined
  let url: string
  if (options.executorUrl !== undefined) {
    url = requireWebSocketUrl(options.executorUrl)
  } else {
    const executorEnv = executorEnvironment(inheritedEnv, token)
    executor = spawn(options.executorCommand ?? 'dsh-subprocess-executor', [
      ...(options.executorArgs ?? []),
      ...(root === undefined ? [] : ['--root', root]),
    ], {
      env: executorEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      url = await readExecutorUrl(
        executor,
        options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      )
    } catch (error) {
      terminate(executor, 'SIGTERM')
      await onceExit(executor)
      throw error
    }
  }

  dshEnv.DSH_EXECUTOR_URL = url
  const dsh = spawn(options.dshCommand ?? 'dsh', [
    '--profile',
    options.profile ?? 'web-remote',
    ...(options.dshArgs ?? []),
  ], {
    env: dshEnv,
    stdio: 'inherit',
  })

  try {
    await onceSpawned(dsh)
  } catch (error) {
    if (executor !== undefined) {
      terminate(executor, 'SIGTERM')
      await onceExit(executor)
    }
    throw error
  }

  let stopPromise: Promise<void> | undefined
  const stop = (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    stopPromise ??= stopChildren(dsh, executor, signal)
    return stopPromise
  }
  const wait = async (): Promise<number> => {
    const [code] = await onceExit(dsh)
    await stop('SIGTERM')
    return code ?? 1
  }

  return { executor, dsh, url, wait, stop }
}

function mergeEnvironment(
  inherited: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...inherited, ...(overrides ?? {}) }
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) delete result[key]
  }
  return result
}

function executorEnvironment(
  inherited: NodeJS.ProcessEnv,
  token: string | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || !isExecutorEnvironmentKey(key)) continue
    result[key] = value
  }
  if (token !== undefined) result.DSH_EXECUTOR_TOKEN = token
  return result
}

function isExecutorEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase()
  return EXECUTOR_ENVIRONMENT_KEYS.has(normalized) || normalized.startsWith('LC_')
}

async function readExecutorUrl(
  executor: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('dsh-remote: readinessTimeoutMs must be a positive safe integer')
  }
  if (executor.stdout === null || executor.stderr === null) {
    throw new Error('dsh-remote: executor output pipes are unavailable')
  }

  let diagnostics = ''
  executor.stderr.setEncoding('utf8')
  const onDiagnostic = (chunk: string): void => {
    diagnostics = appendBounded(diagnostics, chunk, MAX_STARTUP_DIAGNOSTIC_BYTES)
  }
  executor.stderr.on('data', onDiagnostic)
  const lines = createInterface({ input: executor.stdout })
  let timer: NodeJS.Timeout | undefined

  try {
    const ready = (async (): Promise<string> => {
      for await (const line of lines) {
        const url = line.trim()
        if (url.startsWith('ws://') || url.startsWith('wss://')) return url
      }
      const [code, signal] = await onceExit(executor)
      throw new Error(formatStartupFailure(code, signal, diagnostics))
    })()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          `dsh-remote: executor did not publish its WebSocket URL within ${timeoutMs}ms${formatDiagnostics(diagnostics)}`,
        ))
      }, timeoutMs)
      timer.unref()
    })
    return await Promise.race([ready, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    lines.close()
    executor.stderr.off('data', onDiagnostic)
  }
}

function appendBounded(current: string, chunk: string, maximumBytes: number): string {
  const combined = current + chunk
  const bytes = Buffer.byteLength(combined)
  if (bytes <= maximumBytes) return combined
  return Buffer.from(combined).subarray(bytes - maximumBytes).toString('utf8')
}

function formatStartupFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  diagnostics: string,
): string {
  const outcome = signal === null ? `code ${code ?? 'unknown'}` : `signal ${signal}`
  return `dsh-remote: executor exited before publishing its WebSocket URL (${outcome})${formatDiagnostics(diagnostics)}`
}

function formatDiagnostics(diagnostics: string): string {
  const trimmed = diagnostics.trim()
  return trimmed === '' ? '' : `\nExecutor diagnostics:\n${trimmed}`
}

async function stopChildren(
  dsh: ChildProcess,
  executor: ChildProcess | undefined,
  signal: NodeJS.Signals,
): Promise<void> {
  terminate(dsh, signal)
  if (executor === undefined) {
    await onceExit(dsh)
    return
  }
  terminate(executor, signal)
  await Promise.all([onceExit(dsh), onceExit(executor)])
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}

function requireWebSocketUrl(value: string): string {
  if (!value.startsWith('ws://') && !value.startsWith('wss://')) {
    throw new Error('dsh-remote: executorUrl must start with ws:// or wss://')
  }
  return value
}

async function onceSpawned(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return
  await Promise.race([
    once(child, 'spawn').then(() => undefined),
    once(child, 'error').then((values) => Promise.reject(values[0])),
  ])
}

async function onceExit(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode]
  }
  try {
    return await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return [child.exitCode, child.signalCode]
    }
    throw error
  }
}

/** Parse the command-line arguments for the remote companion. */
export function parseRemoteArgs(args: readonly string[]): RemoteLaunchOptions {
  const values = new Map<string, string>()
  const dshArgs: string[] = []
  let afterSeparator = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) break
    if (afterSeparator) {
      dshArgs.push(arg)
      continue
    }
    if (arg === '--') {
      afterSeparator = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`dsh-remote: unexpected argument ${arg}`)
    const [key, value] = arg.slice(2).split('=', 2)
    if (key === undefined || key === '') throw new Error('dsh-remote: empty option name')
    if (value !== undefined) {
      values.set(key, value)
      continue
    }
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`dsh-remote: missing value for --${key}`)
    }
    values.set(key, next)
    index++
  }

  const known = new Set([
    'root',
    'executor-url',
    'executor-command',
    'readiness-timeout-ms',
    'dsh-command',
    'profile',
    'token',
  ])
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`dsh-remote: unknown option --${key}`)
  }
  const root = values.get('root')
  const readinessTimeout = values.get('readiness-timeout-ms')
  const readinessTimeoutMs = readinessTimeout === undefined
    ? undefined
    : Number(readinessTimeout)

  const executorCommand = values.get('executor-command')
  const executorUrl = values.get('executor-url')
  const dshCommand = values.get('dsh-command')
  const profile = values.get('profile')
  const token = values.get('token')
  return {
    ...(root === undefined ? {} : { root }),
    ...(executorUrl === undefined ? {} : { executorUrl: requireWebSocketUrl(executorUrl) }),
    ...(executorCommand === undefined ? {} : { executorCommand }),
    ...(readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs }),
    ...(dshCommand === undefined ? {} : { dshCommand }),
    ...(profile === undefined ? {} : { profile }),
    ...(token === undefined ? {} : { token }),
    dshArgs,
  }
}

/** Run the companion command-line launcher. */
export async function runRemoteCli(args = process.argv.slice(2)): Promise<number> {
  const launch = await launchRemote(parseRemoteArgs(args))
  const forward = (signal: NodeJS.Signals): void => {
    void launch.stop(signal)
  }
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  try {
    return await launch.wait()
  } finally {
    process.off('SIGINT', forward)
    process.off('SIGTERM', forward)
  }
}

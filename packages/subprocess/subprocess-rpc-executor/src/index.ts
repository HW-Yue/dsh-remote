import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { chmod, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { rgPath } from '@vscode/ripgrep'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsEditRequest,
  FsTarget,
  FsWriteIntent,
} from '@deepseek-ai/dsh-fs'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  SandboxProvider,
} from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import {
  ExecutorRpcError,
  ExecutorWebSocketPeer,
} from './protocol/index.ts'
import {
  EXECUTOR_PROTOCOL_VERSION,
  assertFsAuthority,
  assertSpawnRequest,
  executorConnectionId,
  executorId,
  executorProcessId,
  executorWorkspaceId,
  type DirectoryCreateRequest,
  type DirectoryListRequest,
  type ExecutorCapability,
  type ExecutorId,
  type ExecutorProcessId,
  type ExecutorSpillUploadId,
  type ExecutorWorkspace,
  type ExecutorWorkspaceId,
  type FsAuthority,
  type InitializeRequest,
  type SpawnRequest,
  type SpillAppendRequest,
  type SpillBeginRequest,
  type SpillUploadRequest,
  type RemoteFsDirEntry,
  type RemoteFsTarget,
  type WorkspaceAdoptRequest,
  type WorkspaceDescribeRequest,
  type WorkspaceValidateRequest,
} from './protocol/index.ts'
import WebSocket, { WebSocketServer } from 'ws'

const EXECUTABLE_SPAWN_CODES = new Set(['EACCES', 'ENOENT'])
const OUTPUT_NOTIFICATION_MAX_BYTES = 64 * 1024

interface OutputNotificationChunk {
  readonly text: string
  readonly bytes: number
}

interface SpillUpload {
  readonly id: ExecutorSpillUploadId
  readonly path: string
  readonly handle: FileHandle
  bytes: number
}

/** Split text without cutting a UTF-8 code point so one output notification stays well below the RPC frame limit. */
export function outputNotificationChunks(
  text: string,
  maxBytes = OUTPUT_NOTIFICATION_MAX_BYTES,
): OutputNotificationChunk[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new Error('subprocess-rpc-executor: output notification chunk size must be at least 4 bytes')
  }
  const chunks: OutputNotificationChunk[] = []
  let start = 0
  let bytes = 0
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    const width = codePoint > 0xffff ? 2 : 1
    const codePointBytes = Buffer.byteLength(text.slice(index, index + width))
    if (bytes > 0 && bytes + codePointBytes > maxBytes) {
      chunks.push({ text: text.slice(start, index), bytes })
      start = index
      bytes = 0
    }
    bytes += codePointBytes
    index += width
  }
  if (start < text.length) chunks.push({ text: text.slice(start), bytes })
  return chunks
}

/**
 * Project a protocol command into the executor's own installation world.
 * Ripgrep is deliberately supplied by this package so a remote machine does
 * not need a global `rg` install and never receives a Harness-host path.
 */
export function executorExecutable(command: string): string {
  return command === 'rg' ? rgPath : command
}

function isRunnerSpawnFailure(error: unknown, runnerProgram: string | undefined, workdir: string): boolean {
  if (runnerProgram === undefined) return false
  try {
    if (!statSync(workdir).isDirectory()) return false
  } catch {
    return false
  }
  if (typeof error !== 'object' || error === null) return false
  const { code, path, syscall } = error as { code?: unknown; path?: unknown; syscall?: unknown }
  if (typeof code !== 'string' || !EXECUTABLE_SPAWN_CODES.has(code) || typeof syscall !== 'string') return false
  const exactSyscall = `spawn ${runnerProgram}`
  return path === undefined
    ? syscall === exactSyscall
    : path === runnerProgram && (syscall === 'spawn' || syscall === exactSyscall)
}

function classifyRunnerFailure(exitCode: number | null, stderr: string, rules: ConfinedArgv['runnerFailureRules']): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lines = stderr.split(/\r?\n/)
  return rules.some((rule) => {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) return false
    const informational = new Set((rule.informationalLines ?? []).map(line => line.toLowerCase()))
    const signatures = rule.fatalSignatures.filter(value => value.trim() !== '').map(value => value.toLowerCase())
    return lines.some(line => !informational.has(line.toLowerCase()) && signatures.some(value => line.toLowerCase().includes(value)))
  })
}

function matchesSignature(exitCode: number | null, stderr: string, signatures: readonly string[]): boolean {
  if (exitCode === null || exitCode === 0) return false
  const lowered = stderr.toLowerCase()
  return signatures.some(signature => lowered.includes(signature.toLowerCase()))
}

/** Configuration for the local executor server. */
export interface Config {
  /** Interface to bind. Defaults to loopback. */
  host?: string
  /** TCP port to bind. Defaults to an ephemeral port. */
  port?: number
  /** Root exposed to directory browsing and workspace adoption. Defaults to `/`. */
  rootPath?: string
  /** Optional static handshake token for the POC. */
  token?: string
  /** Poll interval for collected output notifications. */
  outputPollMs?: number
}

interface ResolvedConfig {
  host: string
  port: number
  rootPath: string
  token: string | undefined
  outputPollMs: number
}

interface WorkspaceHandle extends ExecutorWorkspace {
  readonly rootIdentity: string
}

interface OwnedProcess {
  readonly id: ExecutorProcessId
  readonly handle: SubprocessHandle
  readonly timer: NodeJS.Timeout
  readonly offsets: { stdout: number; stderr: number }
  readonly sequences: { stdout: number; stderr: number }
  readonly detachPipeListeners: (() => void)[]
  readonly sandbox?: {
    readonly mode: 'read-only' | 'workspace-write'
    readonly confinement: ConfinedArgv
    readonly workdir: string
  }
  ended: boolean
}

/**
 * Serve local subprocess capabilities over a WebSocket executor connection.
 * The server owns one connection and disposes every process when that
 * connection closes.
 */
export class LocalSubprocessExecutor {
  /** Canonical workspace and listener configuration used by this executor. */
  readonly config: ResolvedConfig
  /** WebSocket server that accepts the single executor connection. */
  readonly server: WebSocketServer
  private peer: ExecutorWebSocketPeer | undefined
  private connectionId: string | undefined
  private readonly executorIdentity: ExecutorId
  private readonly workspaces = new Map<ExecutorWorkspaceId, WorkspaceHandle>()
  private readonly processes = new Map<ExecutorProcessId, OwnedProcess>()
  private readonly spillUploads = new Map<ExecutorSpillUploadId, SpillUpload>()

  constructor(
    private readonly ctx: Context,
    config: Config = {},
    private readonly sandbox?: SandboxProvider,
  ) {
    this.config = {
      host: config.host ?? '127.0.0.1',
      port: config.port ?? 0,
      rootPath: realpathSync(config.rootPath ?? resolve('/')),
      token: config.token,
      outputPollMs: config.outputPollMs ?? 25,
    }
    this.executorIdentity = executorId(`local-${process.pid}-${randomUUID()}`)
    if (!Number.isSafeInteger(this.config.port) || this.config.port < 0 || this.config.port > 65535) {
      throw new Error('subprocess-rpc-executor: port must be an integer from 0 through 65535')
    }
    if (!Number.isSafeInteger(this.config.outputPollMs) || this.config.outputPollMs <= 0) {
      throw new Error('subprocess-rpc-executor: outputPollMs must be a positive integer')
    }
    this.server = new WebSocketServer({ host: this.config.host, port: this.config.port })
    this.server.on('connection', this.onConnection)
  }

  /** Port selected by the server after it starts listening. */
  get address(): string | null {
    const address = this.server.address()
    return typeof address === 'object' && address !== null ? `${address.address}:${address.port}` : null
  }

  /** WebSocket URL selected by the server after it starts listening. */
  get url(): string | null {
    const address = this.server.address()
    if (typeof address !== 'object' || address === null) return null
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
    return `ws://${host}:${address.port}`
  }

  /**
   * Wait until the server accepts connections.
   * @returns The selected WebSocket URL.
   */
  async ready(): Promise<string> {
    const current = this.url
    if (current !== null) return current
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => { cleanup(); resolve() }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      const cleanup = (): void => {
        this.server.off('listening', onListening)
        this.server.off('error', onError)
      }
      this.server.once('listening', onListening)
      this.server.once('error', onError)
    })
    const listening = this.url
    if (listening === null) throw new Error('subprocess-rpc-executor: server did not expose an address')
    return listening
  }

  /** Stop accepting connections, dispose processes, and close the server. */
  async dispose(): Promise<void> {
    for (const process of this.processes.values()) process.handle.terminate()
    await Promise.all([...this.processes.values()].map(async (process) => {
      await process.handle.done.catch(() => undefined)
      await process.handle.waitForExit().catch(() => false)
      clearInterval(process.timer)
    }))
    this.processes.clear()
    await this.abortSpillUploads()
    this.workspaces.clear()
    this.peer?.close()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }

  private readonly onConnection = (socket: WebSocket): void => {
    if (this.peer !== undefined) {
      socket.close(1008, 'executor already has an active connection')
      return
    }
    const peer = new ExecutorWebSocketPeer(socket)
    this.peer = peer
    peer.onRequest((method, params) => this.dispatch(peer, method, params))
    peer.onNotification(() => {})
    socket.once('close', () => { void this.closeConnection(peer) })
  }

  private async closeConnection(peer: ExecutorWebSocketPeer): Promise<void> {
    if (this.peer !== peer) return
    this.peer = undefined
    this.connectionId = undefined
    this.workspaces.clear()
    for (const process of this.processes.values()) process.handle.terminate()
    await Promise.all([...this.processes.values()].map(async (process) => {
      await process.handle.done.catch(() => undefined)
      await process.handle.waitForExit().catch(() => false)
      clearInterval(process.timer)
    }))
    this.processes.clear()
    await this.abortSpillUploads()
  }

  private async dispatch(peer: ExecutorWebSocketPeer, method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.invoke(peer, method, params)
    } catch (error) {
      if (error instanceof FsError) {
        throw new ExecutorRpcError(-32010, error.message, {
          kind: 'fs',
          code: error.code,
        })
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new ExecutorRpcError(-32011, error.message, {
          kind: 'directory',
          code: 'exists',
        })
      }
      throw error
    }
  }

  private invoke(peer: ExecutorWebSocketPeer, method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'executor.initialize': return this.initialize(params)
      case 'executor.resolveExecutable': return this.resolveExecutable(params)
      case 'directory.list': return this.directoryList(params)
      case 'directory.create': return this.directoryCreate(params)
      case 'workspace.adopt': return this.workspaceAdopt(params)
      case 'workspace.validate': return this.workspaceValidate(params)
      case 'workspace.describe': return this.workspaceDescribe(params)
      case 'spill.begin': return this.spillBegin(params)
      case 'spill.append': return this.spillAppend(params)
      case 'spill.commit': return this.spillCommit(params)
      case 'spill.abort': return this.spillAbort(params)
      case 'subprocess.spawn': return this.spawn(peer, params)
      case 'subprocess.readOutput': return this.readOutput(params)
      case 'subprocess.writeStdin': return this.writeStdin(params)
      case 'subprocess.closeStdin': return this.closeStdin(params)
      case 'subprocess.terminate': return this.terminate(params)
      case 'subprocess.waitForExit': return this.waitForExit(params)
      case 'subprocess.release': return this.release(params)
      case 'fs.resolve': return this.fsResolve(params)
      case 'fs.processPath': return this.fsProcessPath(params)
      case 'fs.fileUrl': return this.fsFileUrl(params)
      case 'fs.stat': return this.fsStat(params)
      case 'fs.lstat': return this.fsLstat(params)
      case 'fs.readText': return this.fsReadText(params)
      case 'fs.readBytes': return this.fsReadBytes(params)
      case 'fs.listDir': return this.fsListDir(params)
      case 'fs.writeText': return this.fsWriteText(params)
      case 'fs.editText': return this.fsEditText(params)
      default: throw new Error(`subprocess-rpc-executor: unknown method ${method}`)
    }
  }

  private initialize(raw: Record<string, unknown>): unknown {
    const request = raw as unknown as InitializeRequest
    if (request.protocolVersion !== EXECUTOR_PROTOCOL_VERSION) throw new Error('subprocess-rpc-executor: unsupported protocol version')
    if (this.config.token !== undefined && request.token !== this.config.token) throw new Error('subprocess-rpc-executor: invalid token')
    this.connectionId = randomUUID()
    const capabilities: ExecutorCapability[] = ['subprocess', 'fs', 'directory-browse', 'workspace', 'spill']
    if (this.sandbox !== undefined) capabilities.push('sandbox')
    return {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
      connectionId: executorConnectionId(this.connectionId),
      executorId: this.executorIdentity,
      platform: process.platform,
      rootPath: this.config.rootPath,
      capabilities,
    }
  }

  private directoryList(raw: Record<string, unknown>): unknown {
    this.requireInitialized()
    const request = raw as unknown as DirectoryListRequest
    const canonicalPath = this.resolveBrowsePath(request.path ?? this.config.rootPath)
    const entries = readdirSync(canonicalPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const requested = resolve(canonicalPath, entry.name)
        const noFollow = lstatSync(requested)
        let entryPath = requested
        let type: 'file' | 'directory' | 'other' = noFollow.isDirectory()
          ? 'directory'
          : noFollow.isFile() ? 'file' : 'other'
        let enterable = type === 'directory'
        if (noFollow.isSymbolicLink()) {
          try {
            entryPath = realpathSync(requested)
            const followed = statSync(entryPath)
            type = followed.isDirectory() ? 'directory' : followed.isFile() ? 'file' : 'other'
            enterable = followed.isDirectory()
          } catch {
            enterable = false
          }
        }
        return {
          name: entry.name,
          type,
          canonicalPath: entryPath,
          enterable,
          symlink: noFollow.isSymbolicLink(),
        }
      })
    let homePath: string | undefined
    try {
      homePath = realpathSync(homedir())
    } catch {
      // The platform home directory is optional picker metadata.
    }
    return {
      canonicalPath,
      ...(homePath === undefined ? {} : { homePath }),
      entries,
      truncated: false,
    }
  }

  private directoryCreate(raw: Record<string, unknown>): unknown {
    this.requireInitialized()
    const request = raw as unknown as DirectoryCreateRequest
    const parentPath = this.resolveBrowsePath(requireString(request.parentPath, 'parentPath'))
    const name = requireDirectoryName(request.name)
    const requested = resolve(parentPath, name)
    if (dirname(requested) !== parentPath) {
      throw new Error('subprocess-rpc-executor: directory name must identify one direct child')
    }
    mkdirSync(requested)
    return { canonicalPath: realpathSync(requested) }
  }

  private workspaceAdopt(raw: Record<string, unknown>): ExecutorWorkspace {
    this.requireInitialized()
    const request = raw as unknown as WorkspaceAdoptRequest
    const canonicalPath = this.resolveBrowsePath(requireString(request.path, 'path'))
    const workspaceId = executorWorkspaceId(randomUUID())
    const workspace: WorkspaceHandle = {
      executorId: this.executorIdentity,
      workspaceId,
      canonicalPath,
      rootIdentity: directoryIdentity(canonicalPath),
    }
    this.workspaces.set(workspaceId, workspace)
    return workspace
  }

  private workspaceValidate(raw: Record<string, unknown>): unknown {
    this.requireInitialized()
    const request = raw as unknown as WorkspaceValidateRequest
    if (typeof request.workspaceId !== 'string' || request.workspaceId.length === 0) {
      throw new Error('subprocess-rpc-executor: workspaceId is required')
    }
    const workspace = this.workspaces.get(executorWorkspaceId(request.workspaceId))
    if (workspace === undefined) return { valid: false }
    try {
      return { valid: true, workspace: this.revalidateWorkspace(workspace) }
    } catch {
      this.workspaces.delete(workspace.workspaceId)
      return { valid: false }
    }
  }

  private workspaceDescribe(raw: Record<string, unknown>): ExecutorWorkspace {
    const request = raw as unknown as WorkspaceDescribeRequest
    return this.requireWorkspace(request.workspaceId)
  }

  private async spillBegin(raw: Record<string, unknown>): Promise<{ uploadId: ExecutorSpillUploadId }> {
    this.requireInitialized()
    const request = raw as unknown as SpillBeginRequest
    const sessionId = requireString(request.sessionId, 'sessionId')
    const suggestedName = requireString(request.suggestedName, 'suggestedName')
    const root = await this.prepareSpillRoot()
    const sessionHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
    const directory = resolve(root, `session-${sessionHash}`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const canonicalDirectory = await realpath(directory)
    if (!pathStaysWithin(root, canonicalDirectory)) {
      throw new Error('subprocess-rpc-executor: spill session directory escapes the spill root')
    }
    await chmod(canonicalDirectory, 0o700)
    const path = resolve(canonicalDirectory, `${randomBytes(6).toString('hex')}-${encodeSpillSegment(suggestedName)}`)
    const handle = await open(path, 'wx', 0o600)
    const uploadId = randomUUID() as ExecutorSpillUploadId
    this.spillUploads.set(uploadId, { id: uploadId, path, handle, bytes: 0 })
    return { uploadId }
  }

  private async spillAppend(raw: Record<string, unknown>): Promise<{ nextOffset: number }> {
    this.requireInitialized()
    const request = raw as unknown as SpillAppendRequest
    const upload = this.requireSpillUpload(request.uploadId)
    if (!Number.isSafeInteger(request.offset) || request.offset !== upload.bytes) {
      throw new Error('subprocess-rpc-executor: spill chunk offset does not match current size')
    }
    const content = requireString(request.content, 'content', true)
    await upload.handle.writeFile(content)
    upload.bytes += Buffer.byteLength(content)
    return { nextOffset: upload.bytes }
  }

  private async spillCommit(raw: Record<string, unknown>): Promise<{ locator: string; bytes: number }> {
    this.requireInitialized()
    const request = raw as unknown as SpillUploadRequest
    const upload = this.requireSpillUpload(request.uploadId)
    await upload.handle.close()
    this.spillUploads.delete(upload.id)
    return { locator: upload.path, bytes: upload.bytes }
  }

  private async spillAbort(raw: Record<string, unknown>): Promise<Record<string, never>> {
    this.requireInitialized()
    const request = raw as unknown as SpillUploadRequest
    const upload = this.requireSpillUpload(request.uploadId)
    this.spillUploads.delete(upload.id)
    await upload.handle.close().catch(() => undefined)
    await unlink(upload.path).catch(() => undefined)
    return {}
  }

  private spillRoot(): string {
    return this.config.rootPath === resolve('/')
      ? resolve(homedir(), '.dsh-remote/spills')
      : resolve(this.config.rootPath, '.dsh-remote/spills')
  }

  private async prepareSpillRoot(): Promise<string> {
    const expected = this.spillRoot()
    await mkdir(expected, { recursive: true, mode: 0o700 })
    const canonical = await realpath(expected)
    if (!pathStaysWithin(this.config.rootPath, canonical)) {
      throw new Error('subprocess-rpc-executor: spill root escapes the configured executor root')
    }
    await chmod(canonical, 0o700)
    return canonical
  }

  private requireSpillUpload(value: unknown): SpillUpload {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('subprocess-rpc-executor: spill uploadId is required')
    }
    const upload = this.spillUploads.get(value as ExecutorSpillUploadId)
    if (upload === undefined) throw new Error('subprocess-rpc-executor: unknown spill upload')
    return upload
  }

  private async abortSpillUploads(): Promise<void> {
    const uploads = [...this.spillUploads.values()]
    this.spillUploads.clear()
    await Promise.all(uploads.map(async (upload) => {
      await upload.handle.close().catch(() => undefined)
      await unlink(upload.path).catch(() => undefined)
    }))
  }

  private resolveBrowsePath(requested: string): string {
    if (!isAbsolute(requested)) {
      throw new Error('subprocess-rpc-executor: directory path must be absolute')
    }
    const canonicalPath = realpathSync(requested)
    if (!statSync(canonicalPath).isDirectory()) {
      throw new Error('subprocess-rpc-executor: directory path must identify a directory')
    }
    this.assertWithinConfiguredWorkspace(canonicalPath)
    return canonicalPath
  }

  /**
   * Directory browsing and workspace adoption are deliberately rooted at the
   * executor's configured workspace. Canonicalizing before this check closes
   * the symlink escape that a lexical `startsWith` test would leave open.
   */
  private assertWithinConfiguredWorkspace(candidate: string): void {
    const fromRoot = relative(this.config.rootPath, candidate)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('subprocess-rpc-executor: path must stay within the configured workspace')
    }
  }

  private resolveFullAccessCwd(requested: string): string {
    if (!isAbsolute(requested)) {
      throw new Error('subprocess-rpc-executor: full-access cwd must be absolute')
    }
    const canonicalPath = realpathSync(requested)
    if (!statSync(canonicalPath).isDirectory()) {
      throw new Error('subprocess-rpc-executor: full-access cwd must identify a directory')
    }
    return canonicalPath
  }

  private requireWorkspace(value: unknown): WorkspaceHandle {
    this.requireInitialized()
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('subprocess-rpc-executor: workspaceId is required')
    }
    const workspace = this.workspaces.get(executorWorkspaceId(value))
    if (workspace === undefined) {
      throw new Error('subprocess-rpc-executor: unknown or stale workspace')
    }
    return this.revalidateWorkspace(workspace)
  }

  private revalidateWorkspace(workspace: WorkspaceHandle): WorkspaceHandle {
    const canonicalPath = realpathSync(workspace.canonicalPath)
    if (canonicalPath !== workspace.canonicalPath
      || directoryIdentity(canonicalPath) !== workspace.rootIdentity) {
      throw new Error('subprocess-rpc-executor: adopted workspace root was replaced')
    }
    return workspace
  }

  private async resolveExecutable(raw: Record<string, unknown>): Promise<unknown> {
    this.requireInitialized()
    const command = raw.command
    if (typeof command !== 'string' || command.length === 0) throw new Error('subprocess-rpc-executor: command must be non-empty')
    const path = await this.ctx.subprocess.resolveExecutable(
      executorExecutable(command),
      asStringEnvironment(raw.env),
    )
    return { path }
  }

  private spawn(peer: ExecutorWebSocketPeer, raw: Record<string, unknown>): unknown {
    this.requireInitialized()
    assertSpawnRequest(raw)
    const request: SpawnRequest = raw
    let cwd: string
    let argv = [...request.argv]
    let confinement: ConfinedArgv | undefined
    let sandboxFacts: OwnedProcess['sandbox']
    if (request.authority.kind === 'workspace') {
      const workspaceRequest = request as Extract<SpawnRequest, { authority: { kind: 'workspace' } }>
      const workspace = this.requireWorkspace(workspaceRequest.authority.workspaceId)
      cwd = this.resolveWorkspacePath(workspaceRequest.cwd, workspace)
      if (workspaceRequest.sandbox.workspaceRoot !== workspace.canonicalPath) {
        throw new Error('subprocess-rpc-executor: sandbox workspaceRoot must match adopted workspace')
      }
      if (this.sandbox === undefined) {
        throw new Error('subprocess-rpc-executor: sandbox capability is unavailable')
      }
      const policy: SandboxPolicy = {
        mode: workspaceRequest.sandbox.mode,
        workspaceRoot: workspace.canonicalPath,
      }
      confinement = this.sandbox.confine(argv, policy)
      argv = confinement.argv
      sandboxFacts = {
        mode: workspaceRequest.sandbox.mode,
        confinement,
        workdir: cwd,
      }
    } else {
      cwd = this.resolveFullAccessCwd(request.cwd)
    }
    const spec: SubprocessSpawnSpec & { sandbox?: unknown } = {
      argv,
      cwd,
      graceMs: request.graceMs,
      env: asEnvironment(request.env),
      stdio: request.stdio,
      sandbox: request.sandbox,
    }
    const handle = this.ctx.subprocess.spawn(spec)
    const id = executorProcessId(randomUUID())
    const owned: OwnedProcess = {
      id,
      handle,
      timer: setInterval(() => { this.publishOutput(peer, owned) }, this.config.outputPollMs),
      offsets: { stdout: 0, stderr: 0 },
      sequences: { stdout: 0, stderr: 0 },
      detachPipeListeners: [],
      ...(sandboxFacts === undefined ? {} : { sandbox: sandboxFacts }),
      ended: false,
    }
    const detach: (() => void)[] = []
    for (const stream of ['stdout', 'stderr'] as const) {
      const output = handle[stream]
      if (output === undefined) continue
      let deliveredBytes = 0
      const onData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
        if (buffer.length === 0) return
        deliveredBytes += buffer.length
        peer.notify('subprocess.output', {
          processId: id,
          stream,
          sequence: ++owned.sequences[stream],
          data: buffer.toString('utf8'),
          nextOffset: deliveredBytes,
        })
      }
      output.on('data', onData)
      detach.push(() => { output.off('data', onData) })
    }
    owned.detachPipeListeners.push(...detach)
    this.processes.set(id, owned)
    void handle.done.then(
      (outcome) => {
        owned.ended = true
        clearInterval(owned.timer)
        this.publishOutput(peer, owned)
        for (const detachListener of owned.detachPipeListeners) detachListener()
        peer.notify('subprocess.exit', {
          processId: id,
          outcome: this.settleOutcome(owned, outcome),
        })
      },
      (error) => {
        owned.ended = true
        clearInterval(owned.timer)
        this.publishOutput(peer, owned)
        for (const detachListener of owned.detachPipeListeners) detachListener()
        const runnerFailed = owned.sandbox !== undefined
          && isRunnerSpawnFailure(
            error,
            owned.sandbox.confinement.argv[0],
            owned.sandbox.workdir,
          )
        if (runnerFailed) {
          peer.notify('subprocess.exit', {
            processId: id,
            outcome: {
              exitCode: null,
              signal: null,
              sandbox: {
                mode: owned.sandbox?.mode ?? 'workspace-write',
                denied: false,
                enforcement: owned.sandbox?.confinement.enforcement,
                runnerFailed: true,
              },
            },
          })
          return
        }
        peer.notify('subprocess.exit', {
          processId: id,
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )
    return { processId: id, pid: handle.pid }
  }

  private settleOutcome(process: OwnedProcess, outcome: SubprocessOutcome): SubprocessOutcome {
    const facts = process.sandbox
    if (facts === undefined) return outcome
    const stderr = facts.confinement.runnerFailureRules.length === 0
      ? ''
      : process.handle.collected.stderr?.readFrom(0).text ?? ''
    const runnerFailed = classifyRunnerFailure(
      outcome.exitCode,
      stderr,
      facts.confinement.runnerFailureRules,
    )
    const denied = !runnerFailed && matchesSignature(
      outcome.exitCode,
      stderr,
      facts.confinement.denialSignatures,
    )
    const sandbox = {
      mode: facts.mode,
      denied,
      enforcement: facts.confinement.enforcement,
      ...(runnerFailed ? { runnerFailed } : {}),
    }
    return { ...outcome, sandbox } as SubprocessOutcome
  }

  private publishOutput(peer: ExecutorWebSocketPeer, process: OwnedProcess): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const reader = process.handle.collected[stream]
      if (reader === undefined) continue
      const previousOffset = process.offsets[stream]
      const result = reader.readFrom(previousOffset)
      process.offsets[stream] = result.nextOffset
      if (result.text.length === 0) continue
      const chunks = outputNotificationChunks(result.text)
      const retainedBytes = chunks.reduce((total, chunk) => total + chunk.bytes, 0)
      let nextOffset = result.nextOffset - retainedBytes
      for (const [index, chunk] of chunks.entries()) {
        nextOffset += chunk.bytes
        peer.notify('subprocess.output', {
          processId: process.id,
          stream,
          sequence: ++process.sequences[stream],
          data: chunk.text,
          nextOffset,
          lossy: result.lossy && index === 0,
        })
      }
    }
  }

  private async readOutput(raw: Record<string, unknown>): Promise<unknown> {
    const process = this.requireProcess(raw)
    const stream = raw.stream
    if (stream !== 'stdout' && stream !== 'stderr') throw new Error('subprocess-rpc-executor: stream must be stdout or stderr')
    const fromByte = raw.fromByte
    if (typeof fromByte !== 'number' || !Number.isSafeInteger(fromByte) || fromByte < 0) throw new Error('subprocess-rpc-executor: fromByte must be a non-negative integer')
    const reader = process.handle.collected[stream]
    if (reader === undefined) throw new Error(`subprocess-rpc-executor: ${stream} is not collected`)
    return reader.readFrom(fromByte)
  }

  private async writeStdin(raw: Record<string, unknown>): Promise<Record<string, never>> {
    const process = this.requireProcess(raw)
    if (process.handle.stdin === undefined || typeof raw.data !== 'string') throw new Error('subprocess-rpc-executor: stdin is not writable')
    await new Promise<void>((resolve, reject) => { process.handle.stdin?.write(raw.data, (error) => { if (error) reject(error); else resolve() }) })
    return {}
  }

  private closeStdin(raw: Record<string, unknown>): Record<string, never> {
    const process = this.requireProcess(raw)
    process.handle.stdin?.end()
    return {}
  }

  private terminate(raw: Record<string, unknown>): Record<string, never> {
    this.requireProcess(raw).handle.terminate()
    return {}
  }

  private async waitForExit(raw: Record<string, unknown>): Promise<{ exited: boolean }> {
    return { exited: await this.requireProcess(raw).handle.waitForExit() }
  }

  private async release(raw: Record<string, unknown>): Promise<Record<string, never>> {
    const id = this.processId(raw)
    const process = this.processes.get(id)
    if (process === undefined) throw new Error('subprocess-rpc-executor: unknown process')
    if (!process.ended) throw new Error('subprocess-rpc-executor: process is still active')
    if (!await process.handle.waitForExit()) {
      throw new Error('subprocess-rpc-executor: process tree is still active')
    }
    clearInterval(process.timer)
    this.processes.delete(id)
    return {}
  }

  private async fsResolve(raw: Record<string, unknown>): Promise<RemoteFsTarget> {
    this.requireInitialized()
    const authority = this.requireFsAuthority(raw.authority)
    const path = requireString(raw.path, 'path')
    const cwd = optionalString(raw.cwd, 'cwd')
    const target = await this.ctx.fs.resolve(path, {
      cwd: this.fsCwd(authority, cwd),
    })
    if (authority.workspace !== undefined) this.assertTargetInWorkspace(target, authority.workspace)
    return {
      ...target,
      authority: authority.value,
      processPath: this.ctx.fs.processPath(target),
      fileUrl: this.ctx.fs.fileUrl(target),
    }
  }

  private fsProcessPath(raw: Record<string, unknown>): { path: string } {
    const target = this.requireTarget(raw)
    return { path: this.ctx.fs.processPath(target) }
  }

  private fsFileUrl(raw: Record<string, unknown>): { url: string } {
    const target = this.requireTarget(raw)
    return { url: this.ctx.fs.fileUrl(target) }
  }

  private async fsStat(raw: Record<string, unknown>): Promise<unknown> {
    const info = await this.ctx.fs.stat(this.requireTarget(raw))
    return info === undefined ? {} : { info }
  }

  private async fsLstat(raw: Record<string, unknown>): Promise<unknown> {
    this.requireInitialized()
    const authority = this.requireFsAuthority(raw.authority)
    const path = requireString(raw.path, 'path')
    const cwd = optionalString(raw.cwd, 'cwd')
    if (authority.workspace !== undefined) {
      this.requireWorkspacePathNoFollow(path, cwd, authority.workspace)
    }
    const info = await this.ctx.fs.lstat(path, {
      cwd: this.fsCwd(authority, cwd),
    })
    return info === undefined ? {} : { info }
  }

  private async fsReadText(raw: Record<string, unknown>): Promise<{ text: string }> {
    return { text: await this.ctx.fs.readText(this.requireTarget(raw)) }
  }

  private async fsReadBytes(raw: Record<string, unknown>): Promise<{ base64: string }> {
    const maxBytes = raw.maxBytes
    if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('subprocess-rpc-executor: maxBytes must be a positive safe integer')
    }
    const bytes = await this.ctx.fs.readBytes(this.requireTarget(raw), undefined, maxBytes)
    return { base64: Buffer.from(bytes).toString('base64') }
  }

  private async fsListDir(
    raw: Record<string, unknown>,
  ): Promise<{ entries: RemoteFsDirEntry[] }> {
    const authority = this.requireFsAuthority(raw.authority)
    const entries = await this.ctx.fs.listDir(this.requireTarget(raw, authority))
    return {
      entries: entries.map((entry) => {
        const target = entry.target
        if (authority.workspace !== undefined) this.assertTargetInWorkspace(target, authority.workspace)
        return {
          ...entry,
          target: {
            ...target,
            authority: authority.value,
            processPath: this.ctx.fs.processPath(target),
            fileUrl: this.ctx.fs.fileUrl(target),
          },
        }
      }),
    }
  }

  private async fsWriteText(raw: Record<string, unknown>): Promise<unknown> {
    const target = this.requireTarget(raw)
    const content = requireString(raw.content, 'content', true)
    return this.ctx.fs.writeText(target, content, asWriteIntent(raw.expected))
  }

  private async fsEditText(raw: Record<string, unknown>): Promise<unknown> {
    const target = this.requireTarget(raw)
    return this.ctx.fs.editText(
      target,
      asEditRequest(raw.edit),
      asEditExpectation(raw.expected),
    )
  }

  private requireTarget(
    raw: Record<string, unknown>,
    resolvedAuthority = this.requireFsAuthority(raw.authority),
  ): FsTarget {
    this.requireInitialized()
    const value = raw.target
    if (!isRecord(value)) throw new Error('subprocess-rpc-executor: target must be an object')
    const targetAuthority = this.requireFsAuthority(value.authority)
    if (!sameFsAuthority(resolvedAuthority.value, targetAuthority.value)) {
      throw new Error('subprocess-rpc-executor: filesystem target authority mismatch')
    }
    const target: FsTarget = {
      targetKey: FsTargetKey(requireString(value.targetKey, 'target.targetKey')),
      displayPath: requireString(value.displayPath, 'target.displayPath'),
    }
    if (resolvedAuthority.workspace !== undefined) {
      this.assertTargetInWorkspace(target, resolvedAuthority.workspace)
    }
    return target
  }

  private requireFsAuthority(value: unknown): {
    value: FsAuthority
    workspace?: WorkspaceHandle
  } {
    assertFsAuthority(value)
    if (value.kind === 'full-access') return { value }
    return { value, workspace: this.requireWorkspace(value.workspaceId) }
  }

  private fsCwd(
    authority: { value: FsAuthority; workspace?: WorkspaceHandle },
    requested: string | undefined,
  ): string {
    if (authority.workspace !== undefined) {
      return requested === undefined
        ? authority.workspace.canonicalPath
        : this.resolveWorkspacePath(requested, authority.workspace)
    }
    return requested === undefined ? this.config.rootPath : this.resolveFullAccessCwd(requested)
  }

  private assertTargetInWorkspace(target: FsTarget, workspace: WorkspaceHandle): void {
    const processPath = this.ctx.fs.processPath(target)
    const canonical = this.canonicalWorkspacePath(processPath, workspace)
    if (canonical !== processPath) {
      throw new FsError('filesystem target identity is not canonical', 'FS_PERMISSION_DENIED')
    }
  }

  private requireWorkspacePathNoFollow(path: string, cwd: string | undefined, workspace: WorkspaceHandle): void {
    const absolute = isAbsolute(path)
      ? resolve(path)
      : resolve(cwd === undefined ? workspace.canonicalPath : this.resolveWorkspacePath(cwd, workspace), path)
    const parent = this.canonicalWorkspacePath(dirname(absolute), workspace)
    const candidate = resolve(parent, basename(absolute))
    this.assertWorkspaceContains(candidate, workspace)
  }

  private canonicalWorkspacePath(requested: string, workspace: WorkspaceHandle): string {
    let cursor = resolve(requested)
    const suffix: string[] = []
    while (true) {
      try {
        const existing = realpathSync(cursor)
        const candidate = resolve(existing, ...suffix.reverse())
        this.assertWorkspaceContains(candidate, workspace)
        return candidate
      } catch (error) {
        if (!isMissingPathError(error)) throw error
        const parent = dirname(cursor)
        if (parent === cursor) throw error
        suffix.push(cursor.slice(parent.length + 1))
        cursor = parent
      }
    }
  }

  private assertWorkspaceContains(candidate: string, workspace: WorkspaceHandle): void {
    const fromRoot = relative(workspace.canonicalPath, candidate)
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new FsError('filesystem path must stay within adopted workspace', 'FS_PERMISSION_DENIED')
    }
  }

  private resolveWorkspacePath(requested: string, workspace: WorkspaceHandle): string {
    const candidate = realpathSync(isAbsolute(requested) ? requested : resolve(workspace.canonicalPath, requested))
    this.assertWorkspaceContains(candidate, workspace)
    return candidate
  }

  private requireInitialized(): void {
    if (this.connectionId === undefined) throw new Error('subprocess-rpc-executor: initialize is required')
  }

  private requireProcess(raw: Record<string, unknown>): OwnedProcess {
    this.requireInitialized()
    const process = this.processes.get(this.processId(raw))
    if (process === undefined) throw new Error('subprocess-rpc-executor: unknown process')
    return process
  }

  private processId(raw: Record<string, unknown>): ExecutorProcessId {
    if (typeof raw.processId !== 'string' || raw.processId.length === 0) throw new Error('subprocess-rpc-executor: processId is required')
    return executorProcessId(raw.processId)
  }
}

function requireDirectoryName(value: unknown): string {
  const name = requireString(value, 'name')
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes(sep)) {
    throw new Error('subprocess-rpc-executor: invalid directory name')
  }
  return name
}

function directoryIdentity(path: string): string {
  const info = statSync(path)
  return `${info.dev}:${info.ino}`
}

function pathStaysWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
}

function encodeSpillSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let encoded = ''
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    encoded += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return encoded
}

function asStringEnvironment(value: unknown): Readonly<Record<string, string>> | undefined {
  const env = asEnvironment(value)
  if (env === undefined) return undefined
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`subprocess-rpc-executor: ${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label)
}

function asWriteIntent(value: unknown): FsWriteIntent | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('subprocess-rpc-executor: expected write intent must be an object')
  if (value.kind === 'createIfAbsent') return { kind: 'createIfAbsent' }
  if (value.kind === 'replaceIfVersion') {
    return {
      kind: 'replaceIfVersion',
      version: FsVersion(requireString(value.version, 'expected.version')),
    }
  }
  throw new Error('subprocess-rpc-executor: invalid write intent')
}

function asEditExpectation(value: unknown): { version: ReturnType<typeof FsVersion> } | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('subprocess-rpc-executor: expected edit version must be an object')
  return { version: FsVersion(requireString(value.version, 'expected.version')) }
}

function asEditRequest(value: unknown): FsEditRequest {
  if (!isRecord(value)
    || typeof value.oldString !== 'string'
    || value.oldString.length === 0
    || typeof value.newString !== 'string'
    || typeof value.replaceAll !== 'boolean') {
    throw new Error('subprocess-rpc-executor: invalid edit request')
  }
  return {
    oldString: value.oldString,
    newString: value.newString,
    replaceAll: value.replaceAll,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function asEnvironment(value: unknown): NodeJS.ProcessEnv | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('subprocess-rpc-executor: env must be an object')
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (item !== undefined && typeof item !== 'string') {
      throw new Error('subprocess-rpc-executor: env values must be strings or undefined')
    }
    return [key, item]
  }))
}

function sameFsAuthority(left: FsAuthority, right: FsAuthority): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === 'full-access'
    || (right.kind === 'workspace' && left.workspaceId === right.workspaceId)
}

export default LocalSubprocessExecutor

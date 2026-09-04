/** Wire vocabulary for one remote subprocess connection. */
type Branded<T extends string> = string & { readonly __brand: T }
type SubprocessStdinMode = 'ignore' | 'pipe' | { readonly data: string }
type SubprocessOutputMode = 'pipe' | 'inherit' | { readonly maxBytes: number; readonly spill?: { readonly maxBytes: number } }
type SubprocessStdio = { readonly stdin: SubprocessStdinMode; readonly stdout: SubprocessOutputMode; readonly stderr: SubprocessOutputMode }
export interface FsTarget { readonly targetKey: string; readonly displayPath: string }
export interface FsInfo { readonly version: string; readonly type: string; readonly size?: number }
export interface FsPathInfo extends FsInfo { readonly type: string }
export interface FsEditRequest { readonly oldString: string; readonly newString: string; readonly replaceAll?: boolean }
export interface FsWriteIntent { readonly version?: string }
export interface FsEditOutcome { readonly version: string }
export interface FsWriteOutcome { readonly version: string }
type FsVersion = string

/** Protocol version negotiated by both executor endpoints. */
export const EXECUTOR_PROTOCOL_VERSION = 6 as const

/** Opaque connection identifier owned by the executor protocol. */
export type ExecutorConnectionId = Branded<'ExecutorConnectionId'>
/** Opaque executor installation identifier owned by the executor protocol. */
export type ExecutorId = Branded<'ExecutorId'>
/** Opaque adopted workspace identifier owned by one executor connection. */
export type ExecutorWorkspaceId = Branded<'ExecutorWorkspaceId'>
/** Opaque remote process identifier owned by the executor protocol. */
export type ExecutorProcessId = Branded<'ExecutorProcessId'>

/**
 * Construct a validated wire connection id.
 * @param value - Non-empty executor-assigned identifier.
 * @returns The branded connection identifier.
 */
export function executorConnectionId(value: string): ExecutorConnectionId {
  return requireNonEmpty(value, 'connection id') as ExecutorConnectionId
}

/**
 * Construct a validated executor id.
 * @param value - Non-empty executor-assigned identifier.
 * @returns The branded executor identifier.
 */
export function executorId(value: string): ExecutorId {
  return requireNonEmpty(value, 'executor id') as ExecutorId
}

/**
 * Construct a validated adopted workspace id.
 * @param value - Non-empty executor-assigned identifier.
 * @returns The branded executor workspace identifier.
 */
export function executorWorkspaceId(value: string): ExecutorWorkspaceId {
  return requireNonEmpty(value, 'workspace id') as ExecutorWorkspaceId
}

/**
 * Construct a validated wire process id.
 * @param value - Non-empty executor-assigned identifier.
 * @returns The branded process identifier.
 */
export function executorProcessId(value: string): ExecutorProcessId {
  return requireNonEmpty(value, 'process id') as ExecutorProcessId
}

function requireNonEmpty(value: string, label: string): string {
  if (value.length === 0) throw new Error(`executor protocol: ${label} must be non-empty`)
  return value
}

/** JSON-safe representation of one subprocess output disposition. */
export type WireOutputMode = 'pipe' | 'inherit' | {
  readonly maxBytes: number
  readonly spill?: { readonly maxBytes: number }
}

/** JSON-safe representation of one subprocess stdio disposition. */
export interface WireStdio {
  readonly stdin: SubprocessStdinMode
  readonly stdout: WireOutputMode
  readonly stderr: WireOutputMode
}

/**
 * Convert subprocess stdio dispositions to JSON-safe fields.
 * @param stdio - Subprocess stdio configuration.
 * @returns The equivalent wire representation.
 */
export function toWireStdio(stdio: SubprocessStdio): WireStdio {
  return { stdin: stdio.stdin, stdout: toWireOutput(stdio.stdout), stderr: toWireOutput(stdio.stderr) }
}

function toWireOutput(mode: SubprocessOutputMode): WireOutputMode {
  return mode === 'pipe' || mode === 'inherit'
    ? mode
    : { maxBytes: mode.maxBytes, ...(mode.spill === undefined ? {} : { spill: { maxBytes: mode.spill.maxBytes } }) }
}

/** Negotiated executor capabilities. */
export type ExecutorCapability = 'subprocess' | 'fs' | 'terminal' | 'sandbox' | 'directory-browse' | 'workspace' | 'spill'

/** Metadata presented by an outbound executor when registering with the server. */
export interface ExecutorRegistrationRequest {
  readonly protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION
  readonly executorId: ExecutorId
  readonly platform: NodeJS.Platform
  readonly rootPath: string
  readonly capabilities: readonly ExecutorCapability[]
  readonly token?: string
}

/** Server acceptance metadata for one outbound executor connection. */
export interface ExecutorRegistrationResult {
  readonly protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION
  readonly executorId: ExecutorId
  readonly connectionId: ExecutorConnectionId
}

/**
 * Validate metadata presented by an outbound executor.
 * @param value - Untrusted registration request fields.
 * @returns The validated request.
 * @throws When any registration field is malformed or unsupported.
 */
export function parseExecutorRegistrationRequest(value: unknown): ExecutorRegistrationRequest {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['protocolVersion', 'executorId', 'platform', 'rootPath', 'capabilities', 'token'])
    || value.protocolVersion !== EXECUTOR_PROTOCOL_VERSION
    || typeof value.executorId !== 'string' || value.executorId.length === 0
    || !isNodePlatform(value.platform)
    || typeof value.rootPath !== 'string' || value.rootPath.length === 0
    || !isExecutorCapabilities(value.capabilities)
    || (value.token !== undefined && (typeof value.token !== 'string' || value.token.length === 0))) {
    throw new Error('executor protocol: invalid executor registration')
  }
  return {
    protocolVersion: EXECUTOR_PROTOCOL_VERSION,
    executorId: executorId(value.executorId),
    platform: value.platform,
    rootPath: value.rootPath,
    capabilities: value.capabilities,
    ...(value.token === undefined ? {} : { token: value.token }),
  }
}

/**
 * Validate server acceptance metadata for an outbound executor.
 * @param value - Untrusted registration result fields.
 * @param expectedExecutorId - Executor identity sent in the request.
 * @returns The validated result.
 * @throws When the server returns malformed or mismatched metadata.
 */
export function parseExecutorRegistrationResult(
  value: unknown,
  expectedExecutorId: ExecutorId,
): ExecutorRegistrationResult {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['protocolVersion', 'executorId', 'connectionId'])
    || value.protocolVersion !== EXECUTOR_PROTOCOL_VERSION
    || value.executorId !== expectedExecutorId
    || typeof value.connectionId !== 'string' || value.connectionId.length === 0) {
    throw new Error('executor protocol: invalid executor registration result')
  }
  return {
    protocolVersion: EXECUTOR_PROTOCOL_VERSION,
    executorId: expectedExecutorId,
    connectionId: executorConnectionId(value.connectionId),
  }
}

/** A directory entry returned by the executor picker. */
export interface DirectoryEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly canonicalPath: string
  readonly enterable: boolean
  readonly symlink: boolean
}
/** Result of listing one executor-visible directory. */
export interface DirectoryListResult {
  readonly canonicalPath: string
  readonly homePath?: string
  readonly entries: readonly DirectoryEntry[]
  readonly truncated: boolean
}
/** Request to list one executor-visible directory. */
export interface DirectoryListRequest { readonly path?: string }
/** Request to create one child directory beneath an executor-visible directory. */
export interface DirectoryCreateRequest { readonly parentPath: string; readonly name: string }
/** Result of creating one directory. */
export interface DirectoryCreateResult { readonly canonicalPath: string }
/** Executor-issued adopted workspace binding. */
export interface ExecutorWorkspace {
  readonly executorId: ExecutorId
  readonly workspaceId: ExecutorWorkspaceId
  readonly canonicalPath: string
}
/** Request to adopt a directory as an execution workspace. */
export interface WorkspaceAdoptRequest { readonly path: string }
/** Request to validate an adopted workspace. */
export interface WorkspaceValidateRequest { readonly workspaceId: ExecutorWorkspaceId }
/** Request to describe an adopted workspace. */
export interface WorkspaceDescribeRequest { readonly workspaceId: ExecutorWorkspaceId }
/** Result of validating an adopted workspace. */
export interface WorkspaceValidateResult { readonly valid: boolean; readonly workspace?: ExecutorWorkspace }
/** Result of describing an adopted workspace. */
export type WorkspaceDescribeResult = ExecutorWorkspace

/** Request to resolve an executable in the executor's environment. */
export interface ResolveExecutableRequest {
  readonly command: string
  readonly env?: Readonly<Record<string, string | undefined>>
}
/** Result of executable resolution. */
export interface ResolveExecutableResult { readonly path: string }

/** Request to begin one session-scoped remote spill upload. */
export interface SpillBeginRequest {
  readonly sessionId: string
  readonly suggestedName: string
}
/** Executor-owned identifier for an incomplete spill upload. */
export type ExecutorSpillUploadId = Branded<'ExecutorSpillUploadId'>
/** Result of beginning one remote spill upload. */
export interface SpillBeginResult { readonly uploadId: ExecutorSpillUploadId }
/** Request to append one UTF-8 chunk at the exact current spill byte offset. */
export interface SpillAppendRequest {
  readonly uploadId: ExecutorSpillUploadId
  readonly offset: number
  readonly content: string
}
/** Result of appending one spill chunk. */
export interface SpillAppendResult { readonly nextOffset: number }
/** Request to commit or abort an incomplete spill upload. */
export interface SpillUploadRequest { readonly uploadId: ExecutorSpillUploadId }
/** Result of committing one complete remote spill artifact. */
export interface SpillCommitResult {
  readonly locator: string
  readonly bytes: number
}

/** Workspace authority for one confined remote subprocess. */
export interface WorkspaceSpawnAuthority {
  readonly kind: 'workspace'
  readonly workspaceId: ExecutorWorkspaceId
}

/** Explicit unrestricted authority for one approved remote subprocess. */
export interface FullAccessSpawnAuthority {
  readonly kind: 'full-access'
}

/** Executor authority selected for one remote subprocess. */
export type SpawnAuthority = WorkspaceSpawnAuthority | FullAccessSpawnAuthority

/** Shared fields for one remote subprocess spawn. */
interface SpawnRequestFields {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: WireStdio
  readonly graceMs: number
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** Workspace-confined sandbox request carried by the remote wire protocol. */
export interface WorkspaceSandboxRequest {
  readonly mode: 'read-only' | 'workspace-write'
  readonly workspaceRoot: string
  readonly sessionId?: string
}

/** Full-access sandbox request carried by the remote wire protocol. */
export interface FullAccessSandboxRequest {
  readonly mode: 'danger-full-access'
}

/** Sandbox request selected by subprocess authority. */
export type WireSandboxRequest = WorkspaceSandboxRequest | FullAccessSandboxRequest

/** Sandbox facts reported when a process exits. */
export interface WireSandboxOutcome {
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly denied: boolean
  readonly enforcement?: 'full' | 'partial'
  readonly runnerFailed?: boolean
}

/** Request to start one workspace-confined remote subprocess. */
export interface WorkspaceSpawnRequest extends SpawnRequestFields {
  readonly authority: WorkspaceSpawnAuthority
  readonly sandbox: WorkspaceSandboxRequest
}

/** Request to start one explicitly unrestricted remote subprocess. */
export interface FullAccessSpawnRequest extends SpawnRequestFields {
  readonly authority: FullAccessSpawnAuthority
  readonly sandbox: FullAccessSandboxRequest
}

/** Request to start one remote subprocess. */
export type SpawnRequest = WorkspaceSpawnRequest | FullAccessSpawnRequest
/** Result of starting one remote subprocess. */
export interface SpawnResult {
  readonly processId: ExecutorProcessId
  readonly pid: number
}

/** Request to read a collected stream from a byte offset. */
export interface ReadOutputRequest {
  readonly processId: ExecutorProcessId
  readonly stream: 'stdout' | 'stderr'
  readonly fromByte: number
}
/** Result of reading a collected stream. */
export interface ReadOutputResult {
  readonly text: string
  readonly nextOffset: number
  readonly lossy: boolean
  readonly spillPath?: string
}

/** Request to write bytes to an active stdin pipe. */
export interface WriteStdinRequest {
  readonly processId: ExecutorProcessId
  readonly data: string
}
/** Request to close an active stdin pipe. */
export interface CloseStdinRequest { readonly processId: ExecutorProcessId }
/** Request to terminate one process tree. */
export interface TerminateRequest { readonly processId: ExecutorProcessId }
/** Request to wait for process-tree quiescence. */
export interface WaitForExitRequest { readonly processId: ExecutorProcessId }
/** Request to release an ended process handle. */
export interface ReleaseRequest { readonly processId: ExecutorProcessId }

/** JSON-safe resolved filesystem target with synchronous execution-world projections. */
export interface RemoteFsTarget extends FsTarget {
  /** Filesystem authority that issued and owns this target. */
  readonly authority: FsAuthority
  /** Canonical absolute path usable by subprocesses on the executor. */
  readonly processPath: string
  /** Canonical file URI produced using the executor platform. */
  readonly fileUrl: string
}
/** Wire target carrying the authority that produced its opaque identity. */
export interface FsWireTarget extends FsTarget {
  readonly authority: FsAuthority
}
/** Result of resolving one filesystem path. */
export type FsResolveResult = RemoteFsTarget
/** Workspace authority for one confined remote filesystem operation. */
export interface WorkspaceFsAuthority {
  readonly kind: 'workspace'
  readonly workspaceId: ExecutorWorkspaceId
}
/** Explicit unrestricted authority for one approved remote filesystem operation. */
export interface FullAccessFsAuthority { readonly kind: 'full-access' }
/** Executor authority selected for one remote filesystem operation. */
export type FsAuthority = WorkspaceFsAuthority | FullAccessFsAuthority
/** Request to resolve one path in an adopted executor workspace. */
export interface FsResolveRequest {
  readonly authority: FsAuthority
  readonly path: string
  readonly cwd?: string
}
/** Request carrying one previously resolved filesystem target. */
export interface FsTargetRequest {
  readonly authority: FsAuthority
  readonly target: FsWireTarget
}
/** Request to inspect a path without following its final component. */
export interface FsLstatRequest {
  readonly authority: FsAuthority
  readonly path: string
  readonly cwd?: string
}
/** Request to read bounded raw file bytes. */
export interface FsReadBytesRequest extends FsTargetRequest {
  readonly maxBytes: number
}
/** Base64-encoded complete file content. */
export interface FsReadBytesResult { readonly base64: string }
/** Request to write one complete text file. */
export interface FsWriteTextRequest extends FsTargetRequest {
  readonly content: string
  readonly expected?: FsWriteIntent
}
/** Request to apply one literal text edit. */
export interface FsEditTextRequest extends FsTargetRequest {
  readonly edit: FsEditRequest
  readonly expected?: { readonly version: string }
}
/** Result of a target metadata probe. */
export interface FsStatResult { readonly info?: FsInfo }
/** Result of a no-follow path metadata probe. */
export interface FsLstatResult { readonly info?: FsPathInfo }
/** Result of a complete text read. */
export interface FsReadTextResult { readonly text: string }
/** Direct-child directory entry with executor-produced target projections. */
export interface RemoteFsDirEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly target: RemoteFsTarget
  readonly version?: FsVersion
  readonly size?: number
}
/** Result of a direct-child directory listing. */
export interface FsListDirResult { readonly entries: RemoteFsDirEntry[] }
/** Result of an atomic full-file write. */
export type FsWriteTextResult = FsWriteOutcome
/** Result of an atomic literal edit. */
export type FsEditTextResult = FsEditOutcome

/** Normalized process exit facts. */
export interface ProcessOutcome {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly sandbox?: WireSandboxOutcome
}
/** Notification emitted when a remote process has settled or failed to report settlement. */
export type ProcessExitNotification =
  | {
      readonly processId: ExecutorProcessId
      readonly outcome: ProcessOutcome
    }
  | {
      readonly processId: ExecutorProcessId
      readonly error: string
    }
/** Notification emitted for one piped output chunk. */
export interface ProcessOutputNotification {
  readonly processId: ExecutorProcessId
  readonly stream: 'stdout' | 'stderr'
  readonly sequence: number
  readonly data: string
  /** Whole-stream byte offset immediately after this chunk. */
  readonly nextOffset: number
  /** True when bytes before this chunk were unavailable to the executor poller. */
  readonly lossy?: boolean
}

/** Request method parameter map for the executor channel. */
export interface ExecutorRequestMap {
  'executor.initialize': { params: InitializeRequest; result: InitializeResult }
  'executor.register': { params: ExecutorRegistrationRequest; result: ExecutorRegistrationResult }
  'executor.resolveExecutable': { params: ResolveExecutableRequest; result: ResolveExecutableResult }
  'directory.list': { params: DirectoryListRequest; result: DirectoryListResult }
  'directory.create': { params: DirectoryCreateRequest; result: DirectoryCreateResult }
  'workspace.adopt': { params: WorkspaceAdoptRequest; result: ExecutorWorkspace }
  'workspace.validate': { params: WorkspaceValidateRequest; result: WorkspaceValidateResult }
  'workspace.describe': { params: WorkspaceDescribeRequest; result: WorkspaceDescribeResult }
  'spill.begin': { params: SpillBeginRequest; result: SpillBeginResult }
  'spill.append': { params: SpillAppendRequest; result: SpillAppendResult }
  'spill.commit': { params: SpillUploadRequest; result: SpillCommitResult }
  'spill.abort': { params: SpillUploadRequest; result: EmptyResult }
  'subprocess.spawn': { params: SpawnRequest; result: SpawnResult }
  'subprocess.readOutput': { params: ReadOutputRequest; result: ReadOutputResult }
  'subprocess.writeStdin': { params: WriteStdinRequest; result: EmptyResult }
  'subprocess.closeStdin': { params: CloseStdinRequest; result: EmptyResult }
  'subprocess.terminate': { params: TerminateRequest; result: EmptyResult }
  'subprocess.waitForExit': { params: WaitForExitRequest; result: WaitForExitResult }
  'subprocess.release': { params: ReleaseRequest; result: EmptyResult }
  'fs.resolve': { params: FsResolveRequest; result: FsResolveResult }
  'fs.processPath': { params: FsTargetRequest; result: { path: string } }
  'fs.fileUrl': { params: FsTargetRequest; result: { url: string } }
  'fs.stat': { params: FsTargetRequest; result: FsStatResult }
  'fs.lstat': { params: FsLstatRequest; result: FsLstatResult }
  'fs.readText': { params: FsTargetRequest; result: FsReadTextResult }
  'fs.readBytes': { params: FsReadBytesRequest; result: FsReadBytesResult }
  'fs.listDir': { params: FsTargetRequest; result: FsListDirResult }
  'fs.writeText': { params: FsWriteTextRequest; result: FsWriteTextResult }
  'fs.editText': { params: FsEditTextRequest; result: FsEditTextResult }
}

/** Request parameters for the executor handshake. */
export interface InitializeRequest {
  readonly protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION
  readonly token?: string
}
/** Executor handshake result. */
export interface InitializeResult {
  readonly protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION
  readonly connectionId: ExecutorConnectionId
  readonly executorId: ExecutorId
  readonly platform: NodeJS.Platform
  /** Canonical root exposed by executor-backed directory browsing. */
  readonly rootPath: string
  readonly capabilities: readonly ExecutorCapability[]
}
/** Empty successful result used by command methods. */
export type EmptyResult = Record<string, never>
/** Result of waiting for a process. */
export interface WaitForExitResult { readonly exited: boolean }

/** Notification method parameter map for executor events. */
export interface ExecutorNotificationMap {
  'subprocess.output': ProcessOutputNotification
  'subprocess.exit': ProcessExitNotification
}

/**
 * Test whether a value is a JSON-safe subprocess output mode.
 * @param value - Untrusted wire value.
 * @returns Whether the value is a valid output disposition.
 */
export function isWireOutputMode(value: unknown): value is WireOutputMode {
  if (value === 'pipe' || value === 'inherit') return true
  if (!isRecord(value) || !isPositiveSafeInteger(value.maxBytes)) return false
  return value.spill === undefined || (isRecord(value.spill) && isPositiveSafeInteger(value.spill.maxBytes))
}

export function assertProcessExitNotification(
  value: unknown,
): asserts value is ProcessExitNotification {
  if (!isRecord(value) || typeof value.processId !== 'string' || value.processId.length === 0) {
    throw new Error('executor protocol: invalid subprocess.exit notification')
  }
  const hasOutcome = Object.hasOwn(value, 'outcome')
  const hasError = Object.hasOwn(value, 'error')
  if (hasOutcome === hasError) {
    throw new Error('executor protocol: invalid subprocess.exit notification')
  }
  if (hasError) {
    if (typeof value.error !== 'string' || value.error.length === 0) {
      throw new Error('executor protocol: invalid subprocess.exit notification')
    }
    return
  }
  if (!isProcessOutcome(value.outcome)) {
    throw new Error('executor protocol: invalid subprocess.exit notification')
  }
}

function isExecutorCapabilities(value: unknown): value is readonly ExecutorCapability[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(item => item === 'subprocess'
      || item === 'fs'
      || item === 'terminal'
      || item === 'sandbox'
      || item === 'directory-browse'
      || item === 'workspace'
      || item === 'spill')
}

function isNodePlatform(value: unknown): value is NodeJS.Platform {
  return value === 'aix' || value === 'android' || value === 'darwin' || value === 'freebsd'
    || value === 'haiku' || value === 'linux' || value === 'openbsd' || value === 'sunos'
    || value === 'win32'
}
function isProcessOutcome(value: unknown): value is ProcessOutcome {
  return isRecord(value)
    && (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))
    && (value.signal === null || typeof value.signal === 'string')
    && isSandboxOutcome(value.sandbox)
}

function isSandboxOutcome(value: unknown): value is WireSandboxOutcome | undefined {
  if (value === undefined) return true
  if (!isRecord(value)
    || (value.mode !== 'read-only' && value.mode !== 'workspace-write' && value.mode !== 'danger-full-access')
    || typeof value.denied !== 'boolean'
    || (value.enforcement !== undefined && value.enforcement !== 'full' && value.enforcement !== 'partial')
    || (value.runnerFailed !== undefined && typeof value.runnerFailed !== 'boolean')) {
    return false
  }
  return true
}

/**
 * Validate subprocess spawn parameters received from an RPC peer.
 * @param value - Untrusted wire value.
 * @returns The narrowed spawn request value.
 * @throws When any required spawn field is invalid.
 */
export function assertSpawnRequest(value: unknown): asserts value is SpawnRequest {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['authority', 'argv', 'cwd', 'stdio', 'graceMs', 'env', 'sandbox'])
    || !isSpawnAuthority(value.authority)
    || !Array.isArray(value.argv) || value.argv.some(item => typeof item !== 'string')
    || value.argv.length === 0 || value.argv[0]?.length === 0
    || typeof value.cwd !== 'string' || value.cwd.length === 0 || !isPositiveNumber(value.graceMs)
    || !isRecord(value.stdio) || !isValidStdin(value.stdio.stdin)
    || !isWireOutputMode(value.stdio.stdout) || !isWireOutputMode(value.stdio.stderr)
    || !isEnvironment(value.env) || !isSandboxRequest(value.sandbox)
    || !isAuthoritySandboxPair(value.authority, value.sandbox)) {
    throw new Error('executor protocol: invalid subprocess.spawn parameters')
  }
}

/** Validate an explicit filesystem authority received from an RPC peer. */
export function assertFsAuthority(value: unknown): asserts value is FsAuthority {
  if (!isFsAuthority(value)) throw new Error('executor protocol: invalid filesystem authority')
}

function isFsAuthority(value: unknown): value is FsAuthority {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['kind', 'workspaceId'])
    || (value.kind !== 'workspace' && value.kind !== 'full-access')) return false
  return value.kind === 'workspace'
    ? typeof value.workspaceId === 'string' && value.workspaceId.length > 0
    : value.workspaceId === undefined
}

function isAuthoritySandboxPair(
  authority: SpawnAuthority,
  sandbox: WireSandboxRequest,
): boolean {
  return authority.kind === 'workspace'
    ? sandbox.mode === 'read-only' || sandbox.mode === 'workspace-write'
    : sandbox.mode === 'danger-full-access'
}

function isSpawnAuthority(value: unknown): value is SpawnAuthority {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['kind', 'workspaceId'])
    || (value.kind !== 'workspace' && value.kind !== 'full-access')) return false
  if (value.kind === 'workspace') {
    return typeof value.workspaceId === 'string' && value.workspaceId.length > 0
  }
  return value.workspaceId === undefined
}

function isSandboxRequest(value: unknown): value is WireSandboxRequest {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['mode', 'workspaceRoot', 'sessionId'])
    || (value.mode !== 'read-only' && value.mode !== 'workspace-write' && value.mode !== 'danger-full-access')
    || (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.length === 0))) {
    return false
  }
  if (value.mode === 'danger-full-access') {
    return value.workspaceRoot === undefined
  }
  return typeof value.workspaceRoot === 'string' && value.workspaceRoot.length > 0
}

function isEnvironment(value: unknown): value is Readonly<Record<string, string | undefined>> | undefined {
  return value === undefined || (isRecord(value)
    && Object.values(value).every(item => item === undefined || typeof item === 'string'))
}

function isValidStdin(value: unknown): value is SubprocessStdinMode {
  return value === 'ignore' || value === 'pipe' || (isRecord(value) && typeof value.data === 'string')
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every(key => allowedKeys.has(key))
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

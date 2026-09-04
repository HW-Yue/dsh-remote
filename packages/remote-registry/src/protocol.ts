export const REGISTRY_PROTOCOL_VERSION = 1 as const

export interface AgentRegister {
  readonly type: 'agent.register'
  readonly protocolVersion: typeof REGISTRY_PROTOCOL_VERSION
  readonly machineId: string
  readonly displayName: string
  readonly platform: NodeJS.Platform
  readonly rootPath: string
  readonly skillRootPath?: string
  readonly capabilities: readonly string[]
  readonly token?: string
  readonly executorToken?: string
}

export interface AgentHeartbeat {
  readonly type: 'agent.heartbeat'
  readonly machineId: string
  readonly timestamp: number
}

export interface RegistryMachine {
  readonly machineId: string
  readonly displayName: string
  readonly platform: NodeJS.Platform
  readonly rootPath: string
  readonly skillRootPath?: string
  readonly capabilities: readonly string[]
  readonly connectedAt: number
  readonly lastHeartbeat: number
}

export type AgentFrame = AgentRegister | AgentHeartbeat | {
  readonly type: 'bridge.ready' | 'bridge.closed'
  readonly bridgeId: string
  readonly error?: string
} | { readonly type: 'registry.error'; readonly error: string }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAgentRegister(value: unknown): AgentRegister {
  if (!isRecord(value)
    || value.type !== 'agent.register'
    || value.protocolVersion !== REGISTRY_PROTOCOL_VERSION
    || !nonEmpty(value.machineId)
    || !nonEmpty(value.displayName)
    || !isPlatform(value.platform)
    || !nonEmpty(value.rootPath)
    || !Array.isArray(value.capabilities)
    || !value.capabilities.every(item => typeof item === 'string')
    || (value.token !== undefined && !nonEmpty(value.token))
    || (value.executorToken !== undefined && !nonEmpty(value.executorToken))) {
    throw new Error('remote-registry: invalid agent registration')
  }
  return {
    type: 'agent.register', protocolVersion: REGISTRY_PROTOCOL_VERSION,
    machineId: value.machineId, displayName: value.displayName, platform: value.platform,
    rootPath: value.rootPath, capabilities: value.capabilities,
    ...(typeof value.skillRootPath === 'string' && value.skillRootPath.length > 0 ? { skillRootPath: value.skillRootPath } : {}),
    ...(value.token === undefined ? {} : { token: value.token }),
    ...(value.executorToken === undefined ? {} : { executorToken: value.executorToken }),
  }
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function isPlatform(value: unknown): value is NodeJS.Platform {
  return value === 'aix' || value === 'android' || value === 'darwin' || value === 'freebsd'
    || value === 'haiku' || value === 'linux' || value === 'openbsd' || value === 'sunos' || value === 'win32'
}

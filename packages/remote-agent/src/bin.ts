#!/usr/bin/env node
import RemoteAgent from './index.ts'
import { hostname } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i++) {
  const raw = process.argv[i]
  if (raw === undefined || !raw.startsWith('--')) throw new Error('dsh-remote-agent: arguments must use --name value')
  const key = raw.slice(2); const value = process.argv[++i]
  if (value === undefined || value.startsWith('--')) throw new Error(`dsh-remote-agent: missing value for --${key}`)
  args.set(key, value)
}
const value = (name: string, env: string, fallback?: string): string => args.get(name) ?? process.env[env] ?? fallback ?? (() => { throw new Error(`dsh-remote-agent: ${name} is required`) })()
const identity = readIdentity(process.env['DSH_REMOTE_IDENTITY_FILE'] ?? join(process.env['DSH_REMOTE_STATE_DIR'] ?? join(process.env['HOME'] ?? '', '.dsh-remote'), 'identity.json'))
const displayName = args.get('display-name') ?? process.env['DSH_MACHINE_NAME'] ?? identity?.displayName
const registryToken = process.env['DSH_REGISTRY_TOKEN']
const executorCommand = process.env['DSH_EXECUTOR_COMMAND']
const argRegistryToken = args.get('registry-token')
const argExecutorCommand = args.get('executor-command')
const selectedRegistryToken = argRegistryToken ?? registryToken ?? identity?.registryToken
const bundledExecutor = resolve(dirname(fileURLToPath(import.meta.url)), '../../executor/bin/dsh-subprocess-executor')
const workspaceExecutor = resolve(dirname(fileURLToPath(import.meta.url)), '../../subprocess/subprocess-rpc-executor/lib/bin.js')
const selectedExecutorCommand = argExecutorCommand ?? executorCommand
  ?? (existsSync(bundledExecutor) ? bundledExecutor : undefined)
  ?? (existsSync(workspaceExecutor) ? process.execPath : undefined)
const selectedExecutorArgs = argExecutorCommand === undefined && executorCommand === undefined && !existsSync(bundledExecutor) && existsSync(workspaceExecutor)
  ? [workspaceExecutor] : undefined
const selectedExecutorToken = args.get('executor-token') ?? process.env['DSH_EXECUTOR_TOKEN']
const agent = new RemoteAgent({
  registryUrl: value('registry', 'DSH_REGISTRY_URL', identity?.registryUrl),
  machineId: value('machine', 'DSH_MACHINE_ID', identity?.machineId ?? hostname()),
  ...(displayName === undefined ? {} : { displayName }),
  root: args.get('root') ?? process.env['DSH_EXECUTOR_ROOT'] ?? '/',
  ...(selectedExecutorToken === undefined ? {} : { token: selectedExecutorToken }),
  ...(selectedRegistryToken === undefined ? {} : { registryToken: selectedRegistryToken }),
  ...(selectedExecutorCommand === undefined ? {} : { executorCommand: selectedExecutorCommand }),
  ...(selectedExecutorArgs === undefined ? {} : { executorArgs: selectedExecutorArgs }),
})
await agent.start()
console.log(`registered ${agent.config.machineId}`)
const stop = (): void => { void agent.stop().then(() => process.exit(0)) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)

interface AgentIdentity { registryUrl: string; machineId: string; displayName?: string; registryToken?: string }
function readIdentity(path: string): AgentIdentity | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentIdentity>
    if (typeof value.registryUrl !== 'string' || typeof value.machineId !== 'string') return undefined
    return { registryUrl: value.registryUrl, machineId: value.machineId, ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}), ...(typeof value.registryToken === 'string' ? { registryToken: value.registryToken } : {}) }
  } catch { return undefined }
}

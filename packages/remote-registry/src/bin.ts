#!/usr/bin/env node
import RemoteRegistry from './index.ts'
const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i++) {
  const raw = process.argv[i]
  if (raw === undefined || !raw.startsWith('--')) throw new Error('dsh-remote-registry: arguments must use --name value')
  const key = raw.slice(2)
  const value = process.argv[++i]
  if (value === undefined || value.startsWith('--')) throw new Error(`dsh-remote-registry: missing value for --${key}`)
  args.set(key, value)
}
const option = (name: string, env: string): string | undefined => args.get(name) ?? process.env[env]
const host = option('host', 'DSH_REGISTRY_HOST')
const agentToken = process.env['DSH_REGISTRY_TOKEN']
const dshCommand = option('dsh-command', 'DSH_COMMAND') ?? 'dsh'
const dshCommandArgs = parseStringArray(option('dsh-args-json', 'DSH_COMMAND_ARGS_JSON'), 'DSH_COMMAND_ARGS_JSON')
const webAdvertisedHost = option('web-host', 'DSH_WEB_ADVERTISED_HOST')
const webProfilePackageDir = option('web-remote-package-dir', 'DSH_WEB_REMOTE_PACKAGE_DIR')
const configPath = option('config', 'DSH_REMOTE_CONFIG')
const webStartPort = optionalNumber(option('web-port', 'DSH_WEB_START_PORT'), 'DSH_WEB_START_PORT')
const registry = new RemoteRegistry({
  ...(host === undefined ? {} : { host }),
  port: Number(option('port', 'DSH_REGISTRY_PORT') ?? 32100),
  ...(agentToken === undefined ? {} : { agentToken }),
  ...(dshCommand === undefined ? {} : { dshCommand }),
  ...(dshCommandArgs === undefined ? {} : { dshCommandArgs }),
  ...(webAdvertisedHost === undefined ? {} : { webAdvertisedHost }),
  ...(webProfilePackageDir === undefined ? {} : { webProfilePackageDir }),
  ...(webStartPort === undefined ? {} : { webStartPort }),
  ...(configPath === undefined ? {} : { configPath }),
})
const address = await registry.listen()
console.log(address)
const stop = (): void => { void registry.dispose().then(() => process.exit(0)) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)

function parseStringArray(value: string | undefined, name: string): string[] | undefined {
  if (value === undefined) return undefined
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error(`${name} must be a JSON string array`)
  return parsed
}

function optionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`${name} must be a valid port`)
  return parsed
}

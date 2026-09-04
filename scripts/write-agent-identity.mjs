import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

const [registryUrl, requestedMachineId = '', requestedToken = '', requestedDisplayName = ''] = process.argv.slice(2)
if (registryUrl === undefined || (!registryUrl.startsWith('ws://') && !registryUrl.startsWith('wss://'))) {
  throw new Error('remote-client: registry URL must start with ws:// or wss://')
}

const stateDir = process.env['DSH_REMOTE_STATE_DIR'] ?? join(homedir(), '.dsh-remote')
const path = process.env['DSH_REMOTE_IDENTITY_FILE'] ?? join(stateDir, 'identity.json')
const previous = readIdentity(path)
const machineId = requestedMachineId || previous?.machineId || hostname() || randomUUID()
const registryToken = requestedToken || previous?.registryToken
const displayName = requestedDisplayName || previous?.displayName || hostname() || machineId
const identity = { registryUrl, machineId, displayName, ...(registryToken === undefined ? {} : { registryToken }) }

mkdirSync(dirname(path), { recursive: true })
const temporary = `${path}.${process.pid}.tmp`
writeFileSync(temporary, `${JSON.stringify(identity, undefined, 2)}\n`, { mode: 0o600 })
chmodSync(temporary, 0o600)
renameSync(temporary, path)
chmodSync(path, 0o600)
process.stdout.write(`${path}\n`)

function readIdentity(path) {
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null || typeof value.machineId !== 'string') return undefined
    return value
  } catch { return undefined }
}

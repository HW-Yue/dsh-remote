import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('remote agent identity', () => {
  it('persists the registry-issued machine identity outside the checkout', async () => {
    const state = await mkdtemp(join(tmpdir(), 'remote-agent-identity-'))
    directories.push(state)
    const writer = resolve('scripts/write-agent-identity.mjs')
    const path = execFileSync(process.execPath, [writer, 'ws://10.0.0.2:32100', 'machine-id', 'machine-token'], { env: { ...process.env, DSH_REMOTE_STATE_DIR: state }, encoding: 'utf8' }).trim()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ registryUrl: 'ws://10.0.0.2:32100', machineId: 'machine-id', registryToken: 'machine-token' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

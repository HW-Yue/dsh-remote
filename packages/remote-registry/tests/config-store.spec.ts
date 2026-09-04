import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config-store.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('remote registry config store', () => {
  it('persists machine bindings and masks are applied by the registry API layer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'remote-registry-'))
    homes.push(home)
    const store = new ConfigStore(join(home, 'config.json'))
    const model = { id: 'model-1', name: 'Personal', baseUrl: 'https://llm.test/v1', apiKey: 'secret-key' }
    store.update(value => value.modelProfiles.push(model))
    store.setMachine('box', { modelProfileId: model.id, skillIds: ['skill-1'], mcpIds: [], hookIds: [] })
    const machine = store.createMachine('中文测试机器')
    store.markMachineClaimed(machine.id)
    const restored = new ConfigStore(store.path)
    expect(restored.snapshot().machines.box?.modelProfileId).toBe('model-1')
    expect(restored.machineRecord(machine.id)).toMatchObject({ displayName: '中文测试机器', agentToken: expect.any(String), claimedAt: expect.any(Number) })
    expect(JSON.parse(readFileSync(store.path, 'utf8')).modelProfiles[0].apiKey).toBe('secret-key')
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
    store.deleteMachine(machine.id)
    const afterDelete = new ConfigStore(store.path)
    expect(afterDelete.machineRecord(machine.id)).toBeUndefined()
    expect(afterDelete.isMachineRevoked(machine.id)).toBe(true)
  })
})

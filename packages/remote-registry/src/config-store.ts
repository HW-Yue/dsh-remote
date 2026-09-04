import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ModelProfile { id: string; name: string; baseUrl: string; apiKey: string; model?: string }
export interface SkillResource { id: string; name: string; description?: string; files: Record<string, string> }
export interface McpResource { id: string; name: string; config: Record<string, unknown> }
export interface HookResource { id: string; name: string; config: Record<string, unknown> }
export interface MachineBinding { modelProfileId?: string; skillIds: string[]; mcpIds: string[]; hookIds: string[]; revision: number; appliedRevision?: number }
export interface MachineRecord { id: string; displayName: string; agentToken?: string; createdAt: number; claimedAt?: number }
export interface RemoteConsoleConfig { modelProfiles: ModelProfile[]; skills: SkillResource[]; mcps: McpResource[]; hooks: HookResource[]; machines: Record<string, MachineBinding>; machineRecords: Record<string, MachineRecord>; revokedMachineIds: Record<string, number> }

const empty = (): RemoteConsoleConfig => ({ modelProfiles: [], skills: [], mcps: [], hooks: [], machines: {}, machineRecords: {}, revokedMachineIds: {} })

export class ConfigStore {
  readonly path: string
  private value: RemoteConsoleConfig
  constructor(path = process.env['DSH_REMOTE_CONFIG'] ?? join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'remote-registry', 'config.json')) {
    this.path = path
    this.value = this.load()
  }
  snapshot(): RemoteConsoleConfig { return structuredClone(this.value) }
  save(value: RemoteConsoleConfig): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, undefined, 2) + '\n', { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.path)
    chmodSync(this.path, 0o600)
    this.value = structuredClone(value)
  }
  update(mutator: (value: RemoteConsoleConfig) => void): RemoteConsoleConfig { const next = this.snapshot(); mutator(next); this.save(next); return this.snapshot() }
  machine(machineId: string): MachineBinding { return this.value.machines[machineId] ?? { skillIds: [], mcpIds: [], hookIds: [], revision: 0 } }
  machineRecord(machineId: string): MachineRecord | undefined { const record = this.value.machineRecords[machineId]; return record === undefined ? undefined : structuredClone(record) }
  createMachine(displayName: string): MachineRecord {
    const record: MachineRecord = { id: randomUUID(), displayName, agentToken: randomUUID(), createdAt: Date.now() }
    this.update(value => { value.machineRecords[record.id] = record })
    return structuredClone(record)
  }
  adoptMachine(machineId: string, displayName: string): MachineRecord {
    const existing = this.machineRecord(machineId)
    if (existing !== undefined) return existing
    const record: MachineRecord = { id: machineId, displayName, createdAt: Date.now(), claimedAt: Date.now() }
    this.update(value => { value.machineRecords[machineId] ??= record })
    return this.machineRecord(machineId)!
  }
  markMachineClaimed(machineId: string): MachineRecord {
    this.update(value => {
      const record = value.machineRecords[machineId]
      if (record === undefined) throw new Error(`unknown machine ${machineId}`)
      record.claimedAt ??= Date.now()
    })
    return this.machineRecord(machineId)!
  }
  ensureMachineToken(machineId: string): MachineRecord {
    this.update(value => {
      const record = value.machineRecords[machineId]
      if (record === undefined) throw new Error(`unknown machine ${machineId}`)
      record.agentToken ??= randomUUID()
    })
    return this.machineRecord(machineId)!
  }
  isMachineRevoked(machineId: string): boolean { return this.value.revokedMachineIds[machineId] !== undefined }
  deleteMachine(machineId: string): void { this.update(value => { delete value.machineRecords[machineId]; delete value.machines[machineId]; value.revokedMachineIds[machineId] = Date.now() }) }
  setMachine(machineId: string, binding: Omit<MachineBinding, 'revision'> & { revision?: number }): RemoteConsoleConfig { return this.update(value => { const previous = value.machines[machineId]; value.machines[machineId] = { ...binding, revision: (previous?.revision ?? 0) + 1 } }) }
  markApplied(machineId: string): void { this.update(value => { const binding = value.machines[machineId]; if (binding !== undefined) binding.appliedRevision = binding.revision }) }
  newId(): string { return randomUUID() }
  private load(): RemoteConsoleConfig {
    if (!existsSync(this.path)) return empty()
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<RemoteConsoleConfig>
      return { modelProfiles: parsed.modelProfiles ?? [], skills: parsed.skills ?? [], mcps: parsed.mcps ?? [], hooks: parsed.hooks ?? [], machines: parsed.machines ?? {}, machineRecords: parsed.machineRecords ?? {}, revokedMachineIds: parsed.revokedMachineIds ?? {} }
    } catch { return empty() }
  }
}

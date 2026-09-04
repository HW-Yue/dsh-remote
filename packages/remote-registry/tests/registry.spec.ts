import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import RemoteRegistry, { injectBrowserCompatibility } from '../src/index.ts'

const registries: RemoteRegistry[] = []
const temporaryDirectories: string[] = []
afterEach(async () => { await Promise.all(registries.splice(0).map(registry => registry.dispose())); await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('remote registry', () => {
  it('pins browser API requests to the proxied machine path', () => {
    const html = injectBrowserCompatibility('<html><head></head><body></body></html>', 'machine / 中文')
    expect(html).toContain('var W=globalThis.WebSocket,F=globalThis.fetch')
    expect(html).toContain('globalThis.WebSocket=class extends W')
    expect(html).not.toContain('new Proxy(W')
    expect(html).toContain('u.pathname.startsWith(\'/api/\')')
    expect(html).toContain('/web/machine%20%2F%20%E4%B8%AD%E6%96%87')
    expect(html.indexOf('globalThis.fetch')).toBeLessThan(html.indexOf('</head>'))
  })

  it('serves a dashboard with syntactically valid inline scripts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-registry-dashboard-'))
    temporaryDirectories.push(directory)
    const registry = new RemoteRegistry({ configPath: join(directory, 'config.json') })
    registries.push(registry)
    const httpUrl = await registry.listen()
    const html = await fetch(httpUrl).then(response => response.text())
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1] ?? '')
    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) expect(() => new Function(script)).not.toThrow()
    expect(html).toContain('window.isSecureContext')
    expect(html).toContain("document.execCommand('copy')")
  })

  it('registers machines, lists them, bridges frames, and removes disconnected agents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-registry-bridge-'))
    temporaryDirectories.push(directory)
    const registry = new RemoteRegistry({ agentToken: 'registry-secret', configPath: join(directory, 'config.json') })
    registries.push(registry)
    const httpUrl = await registry.listen()
    const wsUrl = httpUrl.replace('http://', 'ws://')
    const agent = new WebSocket(`${wsUrl}/agent`)
    await opened(agent)
    agent.send(JSON.stringify({ type: 'agent.register', protocolVersion: 1, machineId: 'machine-1', displayName: 'Linux box', platform: 'linux', rootPath: '/', capabilities: ['subprocess'], token: 'registry-secret' }))
    await message(agent)
    const machines = await fetch(`${httpUrl}/machines`).then(response => response.json()) as Array<{ machineId: string }>
    expect(machines.map(machine => machine.machineId)).toEqual(['machine-1'])

    const viewer = new WebSocket(`${wsUrl}/machines/machine-1/executor?token=registry-secret`)
    await opened(viewer)
    const open = JSON.parse(await message(agent)) as { type: string; bridgeId: string }
    expect(open.type).toBe('bridge.open')
    agent.send(JSON.stringify({ type: 'bridge.ready', bridgeId: open.bridgeId }))
    viewer.send('viewer-rpc')
    const forwarded = JSON.parse(await message(agent)) as { data: string }
    expect(forwarded.data).toBe('viewer-rpc')
    agent.send(JSON.stringify({ type: 'bridge.message', bridgeId: open.bridgeId, data: 'executor-rpc' }))
    expect(await message(viewer)).toBe('executor-rpc')

    agent.close(); await closed(agent)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(registry.listMachines()).toEqual([])
  })

  it('creates a named machine scaffold and keeps its registry-owned name across reconnects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-registry-machine-'))
    temporaryDirectories.push(directory)
    const registry = new RemoteRegistry({ configPath: join(directory, 'config.json') })
    registries.push(registry)
    const httpUrl = await registry.listen()
    const created = await fetch(`${httpUrl}/api/machines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: '中文测试机器' }),
    }).then(response => response.json()) as { machine: { id: string; displayName: string }; enrollment: { commands: string[] } }
    expect(created.machine.displayName).toBe('中文测试机器')
    expect(created.enrollment.commands[0]).toContain(`./scripts/register-agent.sh`)
    expect(created.enrollment.commands[0]).toContain(created.machine.id)
    expect(created.enrollment.commands[0]).toContain(`'中文测试机器'`)
    expect(await fetch(`${httpUrl}/api/machines`).then(response => response.json())).toEqual([
      expect.objectContaining({ machineId: created.machine.id, displayName: '中文测试机器', status: 'pending' }),
    ])
    const publicConfig = await fetch(`${httpUrl}/api/config`).then(response => response.json()) as { machineRecords: Record<string, object> }
    expect(publicConfig.machineRecords[created.machine.id]).not.toHaveProperty('agentToken')
    expect(publicConfig).not.toHaveProperty('revokedMachineIds')

    const token = registry.configStore.machineRecord(created.machine.id)?.agentToken
    expect(token).toBeTypeOf('string')
    const rejected = new WebSocket(`${httpUrl.replace('http://', 'ws://')}/agent`)
    await opened(rejected)
    const rejectedClosed = closed(rejected)
    rejected.send(JSON.stringify({ type: 'agent.register', protocolVersion: 1, machineId: created.machine.id, displayName: 'wrong token', platform: 'linux', rootPath: '/', capabilities: [], token: 'wrong' }))
    expect(JSON.parse(await message(rejected))).toMatchObject({ type: 'registry.error', error: 'remote-registry: invalid agent token' })
    await rejectedClosed
    const agent = new WebSocket(`${httpUrl.replace('http://', 'ws://')}/agent`)
    await opened(agent)
    agent.send(JSON.stringify({ type: 'agent.register', protocolVersion: 1, machineId: created.machine.id, displayName: 'spoofed remote name', platform: 'linux', rootPath: '/', capabilities: ['subprocess'], token }))
    await message(agent)
    expect(await fetch(`${httpUrl}/api/machines`).then(response => response.json())).toEqual([
      expect.objectContaining({ machineId: created.machine.id, displayName: '中文测试机器', status: 'online', platform: 'linux' }),
    ])
    agent.close(); await closed(agent)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(await fetch(`${httpUrl}/api/machines`).then(response => response.json())).toEqual([
      expect.objectContaining({ machineId: created.machine.id, displayName: '中文测试机器', status: 'offline' }),
    ])
  })

  it('deletes a machine, closes its live agent, and rejects the deleted enrollment identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-registry-delete-'))
    temporaryDirectories.push(directory)
    const registry = new RemoteRegistry({ configPath: join(directory, 'config.json') })
    registries.push(registry)
    const httpUrl = await registry.listen()
    const created = await fetch(`${httpUrl}/api/machines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Disposable box' }),
    }).then(response => response.json()) as { machine: { id: string } }
    const token = registry.configStore.machineRecord(created.machine.id)?.agentToken
    const agent = new WebSocket(`${httpUrl.replace('http://', 'ws://')}/agent`)
    await opened(agent)
    agent.send(JSON.stringify({ type: 'agent.register', protocolVersion: 1, machineId: created.machine.id, displayName: 'Disposable box', platform: 'linux', rootPath: '/', capabilities: [], token }))
    await message(agent)

    const agentClosed = closed(agent)
    const deleted = await fetch(`${httpUrl}/api/machines/${encodeURIComponent(created.machine.id)}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: true, machineId: created.machine.id })
    await agentClosed
    expect(await fetch(`${httpUrl}/api/machines`).then(response => response.json())).toEqual([])

    const reconnect = new WebSocket(`${httpUrl.replace('http://', 'ws://')}/agent`)
    await opened(reconnect)
    const reconnectClosed = closed(reconnect)
    reconnect.send(JSON.stringify({ type: 'agent.register', protocolVersion: 1, machineId: created.machine.id, displayName: 'Disposable box', platform: 'linux', rootPath: '/', capabilities: [], token }))
    expect(JSON.parse(await message(reconnect))).toMatchObject({ type: 'registry.error', error: 'remote-registry: machine enrollment was deleted' })
    await reconnectClosed
  })
})

function opened(socket: WebSocket): Promise<void> { return new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) }) }
function closed(socket: WebSocket): Promise<void> { return new Promise(resolve => socket.once('close', () => resolve())) }
function message(socket: WebSocket): Promise<string> { return new Promise((resolve, reject) => { socket.once('message', raw => resolve(raw.toString())); socket.once('error', reject) }) }

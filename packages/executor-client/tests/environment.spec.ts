import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

import { launchRemote } from '../src/index.ts'

class FakeChild extends EventEmitter {
  readonly stdout: PassThrough | null
  readonly stderr: PassThrough | null
  readonly pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  constructor(pid: number, piped: boolean) {
    super()
    this.pid = pid
    this.stdout = piped ? new PassThrough() : null
    this.stderr = piped ? new PassThrough() : null
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.signalCode = signal
    queueMicrotask(() => { this.emit('exit', null, signal) })
    return true
  }
}

afterEach(() => {
  spawnMock.mockReset()
  vi.unstubAllEnvs()
})

describe('executor-client environment isolation', () => {
  it('keeps Harness credentials and DSH_HOME out of an owned executor', async () => {
    const executor = new FakeChild(101, true)
    const dsh = new FakeChild(102, false)
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => { executor.stdout?.write('ws://127.0.0.1:3210\n') })
        return executor as unknown as ChildProcess
      })
      .mockImplementationOnce(() => dsh as unknown as ChildProcess)

    const launch = await launchRemote({
      root: '/',
      executorCommand: 'test-executor',
      dshCommand: 'test-dsh',
      token: 'rpc-token',
      env: {
        PATH: '/runtime/bin',
        LANG: 'zh_CN.UTF-8',
        DSH_HOME: '/control-plane/dsh-home',
        DEEPSEEK_API_KEY: 'secret-key',
        DEEPSEEK_BASE_URL: 'https://models.example.test',
        ANOTHER_CLOUD_SECRET: 'another-secret',
      },
    })

    const executorOptions = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined
    const dshOptions = spawnMock.mock.calls[1]?.[2] as SpawnOptions | undefined
    const executorEnv = executorOptions?.env as NodeJS.ProcessEnv | undefined
    const dshEnv = dshOptions?.env as NodeJS.ProcessEnv | undefined

    expect(executorEnv).toMatchObject({
      PATH: '/runtime/bin',
      LANG: 'zh_CN.UTF-8',
      DSH_EXECUTOR_TOKEN: 'rpc-token',
    })
    expect(executorEnv).not.toHaveProperty('DSH_HOME')
    expect(executorEnv).not.toHaveProperty('DSH_EXECUTOR_URL')
    expect(executorEnv).not.toHaveProperty('DSH_EXECUTOR_WORKSPACE')
    expect(executorEnv).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(executorEnv).not.toHaveProperty('DEEPSEEK_BASE_URL')
    expect(executorEnv).not.toHaveProperty('ANOTHER_CLOUD_SECRET')

    expect(dshEnv).toMatchObject({
      DSH_HOME: '/control-plane/dsh-home',
      DEEPSEEK_API_KEY: 'secret-key',
      DEEPSEEK_BASE_URL: 'https://models.example.test',
      ANOTHER_CLOUD_SECRET: 'another-secret',
      DSH_EXECUTOR_URL: 'ws://127.0.0.1:3210',
      DSH_EXECUTOR_TOKEN: 'rpc-token',
    })

    await launch.stop()
  })

  it('uses an inherited RPC token without projecting unrelated DSH variables', async () => {
    vi.stubEnv('DSH_EXECUTOR_TOKEN', 'inherited-token')
    vi.stubEnv('DSH_HOME', '/ambient/dsh-home')
    vi.stubEnv('DSH_UNRELATED_SECRET', 'secret')
    const executor = new FakeChild(201, true)
    const dsh = new FakeChild(202, false)
    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => { executor.stdout?.write('ws://127.0.0.1:4321\n') })
        return executor as unknown as ChildProcess
      })
      .mockImplementationOnce(() => dsh as unknown as ChildProcess)

    const launch = await launchRemote({
      root: '/',
      executorCommand: 'test-executor',
      dshCommand: 'test-dsh',
    })

    const executorOptions = spawnMock.mock.calls[0]?.[2] as SpawnOptions | undefined
    const executorEnv = executorOptions?.env as NodeJS.ProcessEnv | undefined
    expect(executorEnv?.DSH_EXECUTOR_TOKEN).toBe('inherited-token')
    expect(executorEnv).not.toHaveProperty('DSH_HOME')
    expect(executorEnv).not.toHaveProperty('DSH_UNRELATED_SECRET')

    await launch.stop()
  })
})

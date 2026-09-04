import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import LocalSubprocessExecutor from '../src/index.ts'
import { EXECUTOR_PROTOCOL_VERSION, ExecutorWebSocketPeer } from '../src/protocol/index.ts'

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(async dispose => { await dispose() }))
})

describe('remote spill storage', () => {
  it('persists chunked UTF-8 text under the configured executor root', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-executor-spill-')))
    const ctx = new Context()
    const executor = new LocalSubprocessExecutor(ctx, { rootPath: root })
    const socket = new WebSocket(await executor.ready())
    await once(socket, 'open')
    const peer = new ExecutorWebSocketPeer(socket)
    disposers.push(async () => {
      peer.close()
      await executor.dispose()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })

    const initialized = await peer.request('executor.initialize', {
      protocolVersion: EXECUTOR_PROTOCOL_VERSION,
    }) as { capabilities: string[] }
    expect(initialized.capabilities).toContain('spill')

    const begun = await peer.request('spill.begin', {
      sessionId: 'session-1',
      suggestedName: '../glob-results.txt',
    }) as { uploadId: string }
    const first = 'first\n'
    const second = '你好🙂\n'
    const firstBytes = Buffer.byteLength(first)
    await expect(peer.request('spill.append', {
      uploadId: begun.uploadId,
      offset: 0,
      content: first,
    })).resolves.toEqual({ nextOffset: firstBytes })
    await expect(peer.request('spill.append', {
      uploadId: begun.uploadId,
      offset: firstBytes,
      content: second,
    })).resolves.toEqual({ nextOffset: firstBytes + Buffer.byteLength(second) })

    const committed = await peer.request('spill.commit', {
      uploadId: begun.uploadId,
    }) as { locator: string; bytes: number }
    expect(relative(root, committed.locator)).not.toMatch(/^\.\./)
    expect(basename(committed.locator)).not.toContain('/')
    expect(readFileSync(committed.locator, 'utf8')).toBe(`${first}${second}`)
    expect(committed.bytes).toBe(Buffer.byteLength(`${first}${second}`))
    expect(statSync(committed.locator).mode & 0o777).toBe(0o600)
  })

  it('rejects a spill root symlink that escapes a confined executor root', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-executor-spill-root-')))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-executor-spill-outside-')))
    mkdirSync(join(root, '.dsh-remote'))
    symlinkSync(outside, join(root, '.dsh-remote/spills'))
    const ctx = new Context()
    const executor = new LocalSubprocessExecutor(ctx, { rootPath: root })
    const socket = new WebSocket(await executor.ready())
    await once(socket, 'open')
    const peer = new ExecutorWebSocketPeer(socket)
    disposers.push(async () => {
      peer.close()
      await executor.dispose()
      await ctx.fiber.dispose()
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ])
    })

    await peer.request('executor.initialize', { protocolVersion: EXECUTOR_PROTOCOL_VERSION })
    await expect(peer.request('spill.begin', {
      sessionId: 'session-escape',
      suggestedName: 'result.txt',
    })).rejects.toThrow('spill root escapes the configured executor root')
  })
})

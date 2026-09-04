import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import LocalSubprocessExecutor from '../src/index.ts'

interface CwdHarness {
  resolveFullAccessCwd(requested: string): string
}

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('full-access subprocess cwd', () => {
  it('accepts an absolute symlink spelling and executes from its canonical directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-executor-full-access-'))
    temporaryRoots.push(root)
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    symlinkSync('.', target)
    symlinkSync('target', alias)
    const executor = Object.create(LocalSubprocessExecutor.prototype) as CwdHarness

    expect(executor.resolveFullAccessCwd(alias)).toBe(realpathSync(alias))
  })
})

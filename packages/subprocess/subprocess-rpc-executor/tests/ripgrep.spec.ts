import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executorExecutable } from '../src/index.ts'

describe('packaged ripgrep executable', () => {
  it('maps bare rg to this installation and starts it without a system PATH entry', () => {
    const executable = executorExecutable('rg')
    expect(isAbsolute(executable)).toBe(true)
    expect(executorExecutable('bash')).toBe('bash')

    const result = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      env: { PATH: '' },
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^ripgrep /)
  })
})

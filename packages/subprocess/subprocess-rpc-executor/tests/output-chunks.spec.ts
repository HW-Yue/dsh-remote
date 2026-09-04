import { describe, expect, it } from 'vitest'
import { outputNotificationChunks } from '../src/index.ts'

describe('executor output notification chunks', () => {
  it('keeps every frame below the byte cap without splitting UTF-8 code points', () => {
    const source = `${'a'.repeat(7)}你🙂${'b'.repeat(13)}`
    const chunks = outputNotificationChunks(source, 8)

    expect(chunks.map(chunk => chunk.text).join('')).toBe(source)
    expect(chunks.every(chunk => chunk.bytes <= 8)).toBe(true)
    expect(chunks.map(chunk => chunk.bytes)).toEqual(
      chunks.map(chunk => Buffer.byteLength(chunk.text)),
    )
  })
})

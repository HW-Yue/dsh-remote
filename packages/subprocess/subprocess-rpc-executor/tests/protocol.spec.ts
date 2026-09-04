import { describe, expect, it } from 'vitest'
import {
  EXECUTOR_PROTOCOL_VERSION,
  assertProcessExitNotification,
  assertSpawnRequest,
  executorConnectionId,
  executorId,
  executorProcessId,
  executorWorkspaceId,
  isWireOutputMode,
  parseExecutorRegistrationRequest,
  parseExecutorRegistrationResult,
  toWireStdio,
} from '../src/protocol/index.ts'

describe('subprocess RPC protocol', () => {
  it('negotiates the sandbox-aware protocol version', () => {
    expect(EXECUTOR_PROTOCOL_VERSION).toBe(6)
  })

  it('validates outbound executor registration metadata', () => {
    const request = parseExecutorRegistrationRequest({
      protocolVersion: 6,
      executorId: 'executor-1',
      platform: 'darwin',
      rootPath: '/',
      capabilities: ['subprocess', 'fs', 'workspace', 'spill'],
      token: 'dev-token',
    })
    expect(request.executorId).toBe('executor-1')
    expect(request.capabilities).toEqual(['subprocess', 'fs', 'workspace', 'spill'])

    const result = parseExecutorRegistrationResult({
      protocolVersion: 6,
      executorId: 'executor-1',
      connectionId: 'connection-1',
    }, request.executorId)
    expect(result.connectionId).toBe('connection-1')

    const invalidRequests: unknown[] = [
      { protocolVersion: 3, executorId: 'executor-1', platform: 'darwin', rootPath: '/', capabilities: ['subprocess'] },
      { protocolVersion: 6, executorId: '', platform: 'darwin', rootPath: '/', capabilities: ['subprocess'] },
      { protocolVersion: 6, executorId: 'executor-1', platform: 'unknown', rootPath: '/', capabilities: ['subprocess'] },
      { protocolVersion: 6, executorId: 'executor-1', platform: 'darwin', rootPath: '', capabilities: ['subprocess'] },
      { protocolVersion: 6, executorId: 'executor-1', platform: 'darwin', rootPath: '/', capabilities: [] },
      { protocolVersion: 6, executorId: 'executor-1', platform: 'darwin', rootPath: '/', capabilities: ['unknown'] },
      { protocolVersion: 6, executorId: 'executor-1', platform: 'darwin', rootPath: '/', capabilities: ['subprocess'], token: '' },
      { protocolVersion: 6, executorId: 'executor-1', platform: 'darwin', rootPath: '/', capabilities: ['subprocess'], extra: true },
    ]
    for (const invalid of invalidRequests) {
      expect(() => parseExecutorRegistrationRequest(invalid)).toThrow('invalid executor registration')
    }

    expect(() => parseExecutorRegistrationResult({
      protocolVersion: 6,
      executorId: 'other-executor',
      connectionId: 'connection-1',
    }, request.executorId)).toThrow('invalid executor registration result')
    expect(() => parseExecutorRegistrationResult({
      protocolVersion: 6,
      executorId: 'executor-1',
      connectionId: '',
    }, request.executorId)).toThrow('invalid executor registration result')
  })
  it('brands non-empty identifiers and rejects empty ones', () => {
    expect(executorConnectionId('connection-1')).toBe('connection-1')
    expect(executorId('executor-1')).toBe('executor-1')
    expect(executorProcessId('process-1')).toBe('process-1')
    expect(executorWorkspaceId('workspace-1')).toBe('workspace-1')
    expect(() => executorProcessId('')).toThrow('process id must be non-empty')
    expect(() => executorId('')).toThrow('executor id must be non-empty')
    expect(() => executorWorkspaceId('')).toThrow('workspace id must be non-empty')
  })

  it('projects stdio into JSON-safe values', () => {
    expect(toWireStdio({
      stdin: { data: 'hello' },
      stdout: { maxBytes: 128, spill: { maxBytes: 1024 } },
      stderr: 'pipe',
    })).toEqual({
      stdin: { data: 'hello' },
      stdout: { maxBytes: 128, spill: { maxBytes: 1024 } },
      stderr: 'pipe',
    })
  })

  it('validates exclusive process exit success and error notifications', () => {
    expect(() => { assertProcessExitNotification({
      processId: 'process-1',
      outcome: { exitCode: 0, signal: null },
    }) }).not.toThrow()
    expect(() => { assertProcessExitNotification({
      processId: 'process-1',
      error: 'spawn failed',
    }) }).not.toThrow()
    expect(() => { assertProcessExitNotification({ processId: 'process-1' }) })
      .toThrow('invalid subprocess.exit notification')
    expect(() => { assertProcessExitNotification({
      processId: 'process-1',
      outcome: { exitCode: 0, signal: null },
      error: 'ambiguous',
    }) }).toThrow('invalid subprocess.exit notification')
    expect(() => { assertProcessExitNotification({
      processId: 'process-1',
      outcome: {
        exitCode: 0,
        signal: null,
        sandbox: { mode: 'workspace-write', denied: 'yes' },
      },
    }) }).toThrow('invalid subprocess.exit notification')
  })

  it('validates output modes and correlated spawn authorities at the wire', () => {
    expect(isWireOutputMode('pipe')).toBe(true)
    expect(isWireOutputMode({ maxBytes: 64 })).toBe(true)
    expect(isWireOutputMode({ maxBytes: 0 })).toBe(false)

    const workspaceRequest: unknown = {
      authority: { kind: 'workspace', workspaceId: 'workspace-1' },
      argv: ['bash', '-c', 'printf ok'],
      cwd: '/workspace',
      graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: 'inherit' },
      sandbox: { mode: 'workspace-write', workspaceRoot: '/workspace', sessionId: 'session-1' },
    }
    expect(() => { assertSpawnRequest(workspaceRequest) }).not.toThrow()
    expect(() => { assertSpawnRequest({ ...workspaceRequest as object, sandbox: { mode: 'read-only', workspaceRoot: '/workspace' } }) }).not.toThrow()

    const fullAccessRequest: unknown = {
      authority: { kind: 'full-access' },
      argv: ['bash', '-c', 'printf ok'],
      cwd: '/tmp',
      graceMs: 1000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: 'inherit' },
      sandbox: { mode: 'danger-full-access', sessionId: 'session-1' },
    }
    expect(() => { assertSpawnRequest(fullAccessRequest) }).not.toThrow()

    const invalidRequests: unknown[] = [
      { ...workspaceRequest as object, authority: undefined },
      { ...workspaceRequest as object, sandbox: undefined },
      { ...workspaceRequest as object, workspaceId: 'workspace-1' },
      { ...workspaceRequest as object, authority: { kind: 'workspace', workspaceId: 'workspace-1' }, sandbox: { mode: 'danger-full-access' } },
      { ...fullAccessRequest as object, authority: { kind: 'full-access', workspaceId: 'workspace-1' } },
      { ...fullAccessRequest as object, sandbox: { mode: 'read-only', workspaceRoot: '/tmp' } },
      { ...fullAccessRequest as object, sandbox: { mode: 'workspace-write', workspaceRoot: '/tmp' } },
      { ...fullAccessRequest as object, sandbox: { mode: 'danger-full-access', workspaceRoot: '/tmp' } },
      { ...workspaceRequest as object, authority: { kind: 'workspace', workspaceId: '' } },
      { ...workspaceRequest as object, sandbox: { mode: 'read-only', workspaceRoot: '' } },
      { ...workspaceRequest as object, sandbox: { mode: 'unsafe', workspaceRoot: '/workspace' } },
      { ...workspaceRequest as object, extra: true },
      { ...workspaceRequest as object, authority: { kind: 'workspace', workspaceId: 'workspace-1', extra: true } },
      { ...workspaceRequest as object, sandbox: { mode: 'workspace-write', workspaceRoot: '/workspace', extra: true } },
      { ...workspaceRequest as object, argv: [] },
      { ...workspaceRequest as object, argv: ['', '-c', 'printf ok'] },
    ]
    for (const request of invalidRequests) {
      expect(() => { assertSpawnRequest(request) }).toThrow('invalid subprocess.spawn parameters')
    }
  })
})

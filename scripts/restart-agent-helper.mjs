import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const [delayRaw, timeoutRaw, stateDir, logFile, startScript, ...agentArgs] = process.argv.slice(2)
if (delayRaw === undefined || timeoutRaw === undefined || stateDir === undefined || logFile === undefined || startScript === undefined) {
  throw new Error('remote-client: incomplete restart helper arguments')
}

const delayMs = seconds(delayRaw, 'restart delay') * 1000
const timeoutMs = seconds(timeoutRaw, 'restart timeout') * 1000
const lockDir = join(stateDir, 'restart.lock')

try {
  const log = openSync(logFile, 'a')
  try {
    const startedAt = Date.now()
    await delay(Math.min(delayMs, timeoutMs))
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      appendFileSync(log, `remote-client: agent restart timed out after ${timeoutRaw}s\n`)
    } else {
      const child = spawn(startScript, ['--restart-now', ...agentArgs], {
        env: process.env,
        stdio: ['ignore', log, log],
      })
      const result = await waitForExit(child, remainingMs)
      if (result.timedOut) {
        appendFileSync(log, `remote-client: agent restart timed out after ${timeoutRaw}s\n`)
      } else if (result.code !== 0) {
        appendFileSync(log, `remote-client: agent restart helper exited with code ${result.code ?? 'unknown'}${result.signal === null ? '' : ` (${result.signal})`}\n`)
      }
    }
  } finally {
    closeSync(log)
  }
} finally {
  rmSync(lockDir, { recursive: true, force: true })
}

function seconds(raw, name) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`remote-client: ${name} must be a non-negative number`)
  return value
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    let timedOut = false
    let settled = false
    let killTimer
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
      killTimer.unref()
    }, timeoutMs)
    timeout.unref()
    child.once('error', () => finish(null, null))
    child.once('exit', finish)

    function finish(code, signal) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer !== undefined) clearTimeout(killTimer)
      resolve({ code, signal, timedOut })
    }
  })
}

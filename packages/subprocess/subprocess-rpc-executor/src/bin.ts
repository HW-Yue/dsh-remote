#!/usr/bin/env node
/**
 * Boot one local subprocess executor with a directory-browsing root. The optional POC
 * token is read from `DSH_EXECUTOR_TOKEN` so it does not appear in process
 * arguments. Stdout reports the selected WebSocket URL; diagnostics use stderr.
 * @module @deepseek-ai/dsh-subprocess-rpc-executor/bin
 */

import { realpath } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSubprocessExecutor from './index.ts'

const NAME = 'dsh-subprocess-executor'

/* v8 ignore start -- exercised by the two-process lifecycle test */
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: 'string' },
    port: { type: 'string' },
    root: { type: 'string', short: 'r' },
  },
  strict: true,
})
const rootPath = await realpath(values.root ?? '/')
const port = parsePort(values.port)
const ctx = new Context()
const fsFiber = await ctx.plugin(LocalFileSystem, { cwd: rootPath })
const subprocessFiber = await ctx.plugin(LocalSubprocessRuntime)
const sandboxFiber = await ctx.plugin(LocalSandboxProvider, {})
const executor = new LocalSubprocessExecutor(ctx, {
  rootPath,
  ...(values.host === undefined ? {} : { host: values.host }),
  ...(port === undefined ? {} : { port }),
  ...(process.env['DSH_EXECUTOR_TOKEN'] === undefined
    ? {}
    : { token: process.env['DSH_EXECUTOR_TOKEN'] }),
}, ctx.sandbox)

let stopping = false
const stop = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  await executor.dispose().catch((error) => {
    console.error(`${NAME}: ${formatError(error)}`)
  })
  await sandboxFiber.dispose().catch((error) => {
    console.error(`${NAME}: ${formatError(error)}`)
  })
  await fsFiber.dispose().catch((error) => {
    console.error(`${NAME}: ${formatError(error)}`)
  })
  await subprocessFiber.dispose().catch((error) => {
    console.error(`${NAME}: ${formatError(error)}`)
  })
}

process.once('SIGINT', () => { void stop().then(() => { process.exit(0) }) })
process.once('SIGTERM', () => { void stop().then(() => { process.exit(0) }) })
process.once('uncaughtException', (error) => {
  console.error(`${NAME}: ${formatError(error)}`)
  void stop().then(() => { process.exit(1) })
})
process.once('unhandledRejection', (error) => {
  console.error(`${NAME}: ${formatError(error)}`)
  void stop().then(() => { process.exit(1) })
})

console.log(await executor.ready())
/* v8 ignore stop */

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${NAME}: --port must be an integer from 0 through 65535`)
  }
  return port
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

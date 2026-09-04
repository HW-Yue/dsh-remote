#!/usr/bin/env node
import { runRemoteCli } from './index.ts'

process.exitCode = await runRemoteCli().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  return 1
})

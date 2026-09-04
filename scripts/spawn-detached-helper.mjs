import { spawn } from 'node:child_process'

const [helper, ...args] = process.argv.slice(2)
if (helper === undefined) {
  throw new Error('remote-client: detached helper path is required')
}

const child = spawn(process.execPath, [helper, ...args], {
  detached: true,
  stdio: 'ignore',
  env: process.env,
})
child.unref()
process.stdout.write(`${child.pid}\n`)

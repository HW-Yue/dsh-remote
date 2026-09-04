import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = resolve(root, 'packages/subprocess/subprocess-rpc-executor')
const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
const artifactName = `dsh-subprocess-rpc-executor-${manifest.version}-${platform()}-${arch()}`
const outputRoot = resolve(root, 'dist')
const deployDir = resolve(outputRoot, artifactName)
const archive = `${deployDir}.tar.gz`

rmSync(deployDir, { recursive: true, force: true })
rmSync(archive, { force: true })
mkdirSync(outputRoot, { recursive: true })

run('pnpm', ['--filter', manifest.name, 'run', 'build'])
run('pnpm', ['--filter', manifest.name, 'deploy', '--prod', '--legacy', deployDir])
run('tar', ['-czf', archive, '-C', outputRoot, artifactName])

console.log(archive)

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CI: process.env.CI ?? 'true' },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

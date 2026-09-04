import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const release = resolve(root, 'dist/remote-client')
rmSync(release, { recursive: true, force: true })
mkdirSync(release, { recursive: true })
run('pnpm', ['-r', '--filter', '@deepseek-ai/dsh-remote-registry', '--filter', '@deepseek-ai/dsh-remote-agent', 'run', 'build'])
run('pnpm', ['--filter', '@deepseek-ai/dsh-subprocess-rpc-executor', 'run', 'build'])
run('pnpm', ['--filter', '@deepseek-ai/dsh-remote-registry', 'deploy', '--prod', '--legacy', resolve(release, 'registry')])
run('pnpm', ['--filter', '@deepseek-ai/dsh-remote-agent', 'deploy', '--prod', '--legacy', resolve(release, 'agent')])
run('pnpm', ['--filter', '@deepseek-ai/dsh-subprocess-rpc-executor', 'deploy', '--prod', '--legacy', resolve(release, 'executor')])
copyFileSync(resolve(root, 'README.md'), resolve(release, 'README.md'))
const binDir = resolve(release, 'bin'); mkdirSync(binDir)
for (const [name, target] of [['dsh-remote-registry', 'registry/lib/bin.js'], ['dsh-remote-agent', 'agent/lib/bin.js']]) {
  const file = resolve(binDir, name)
  writeFileSync(file, `#!/bin/sh\nexec node "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/${target}" "$@"\n`)
  chmodSync(file, 0o755)
}
for (const packageRoot of [resolve(release, 'registry'), resolve(release, 'agent')]) {
  for (const name of ['src', 'tests', 'tsconfig.json', 'tsconfig.tsbuildinfo']) rmSync(resolve(packageRoot, name), { recursive: true, force: true })
}
mkdirSync(resolve(release, 'executor/bin'), { recursive: true })
const executorWrapper = resolve(release, 'executor/bin/dsh-subprocess-executor')
writeFileSync(executorWrapper, '#!/bin/sh\nexec node "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/lib/bin.js" "$@"\n')
chmodSync(executorWrapper, 0o755)
const archive = `${release}.tar.gz`
rmSync(archive, { force: true })
run('tar', ['-czf', archive, '-C', resolve(release, '..'), 'remote-client'])
console.log(archive)

function run(command, args) { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } }); if (result.error) throw result.error; if (result.status !== 0) process.exit(result.status ?? 1) }

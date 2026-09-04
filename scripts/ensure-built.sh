#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -x "$root/node_modules/.bin/tsc" ] \
  || [ ! -f "$root/packages/remote-registry/lib/bin.js" ] \
  || [ ! -f "$root/packages/remote-agent/lib/bin.js" ] \
  || [ ! -f "$root/packages/subprocess/subprocess-rpc-executor/lib/bin.js" ] \
  || [ "$root/packages/remote-registry/src/index.ts" -nt "$root/packages/remote-registry/lib/index.js" ] \
  || [ "$root/packages/remote-agent/src/index.ts" -nt "$root/packages/remote-agent/lib/index.js" ] \
  || [ "$root/packages/remote-agent/src/bin.ts" -nt "$root/packages/remote-agent/lib/bin.js" ] \
  || [ "$root/packages/remote-registry/src/bin.ts" -nt "$root/packages/remote-registry/lib/bin.js" ] \
  || [ "$root/packages/remote-registry/src/web-launcher.ts" -nt "$root/packages/remote-registry/lib/web-launcher.js" ] \
  || [ "$root/packages/subprocess/subprocess-rpc-executor/src/index.ts" -nt "$root/packages/subprocess/subprocess-rpc-executor/lib/bin.js" ] \
  || [ "$root/packages/subprocess/subprocess-rpc-executor/src/bin.ts" -nt "$root/packages/subprocess/subprocess-rpc-executor/lib/bin.js" ] \
  || find "$root/packages/subprocess/subprocess-rpc-executor/src/protocol" -type f -newer "$root/packages/subprocess/subprocess-rpc-executor/lib/bin.js" -print -quit | grep -q .; then
  command -v pnpm >/dev/null 2>&1 || { echo 'remote-client: pnpm is required; install Node.js 22+ with pnpm/corepack' >&2; exit 1; }
  CI=true pnpm install --frozen-lockfile >&2
  pnpm build >&2
fi
printf '%s\n' "$root"

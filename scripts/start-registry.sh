#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

foreground=0
if [ "${1:-}" = "--foreground" ]; then
  foreground=1
  shift
fi

if [ "$foreground" -eq 0 ] && [ "${DSH_REMOTE_REGISTRY_DAEMON:-}" != "1" ]; then
  state_dir=${DSH_REMOTE_STATE_DIR:-${HOME}/.dsh-remote}
  mkdir -p "$state_dir"
  pid_file=${DSH_REMOTE_REGISTRY_PID_FILE:-$state_dir/registry.pid}
  log_file=${DSH_REMOTE_REGISTRY_LOG_FILE:-$state_dir/registry.log}
  if [ -f "$pid_file" ]; then
    old_pid=$(cat "$pid_file" 2>/dev/null || true)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "remote-client: registry already running (pid $old_pid)"
      exit 0
    fi
    rm -f "$pid_file"
  fi
  nohup env DSH_REMOTE_REGISTRY_DAEMON=1 "$0" --foreground "$@" >>"$log_file" 2>&1 </dev/null &
  daemon_pid=$!
  echo "$daemon_pid" >"$pid_file"
  echo "remote-client: registry started (pid $daemon_pid)"
  echo "remote-client: log $log_file"
  exit 0
fi

root=$("$root/scripts/ensure-built.sh")
dsh_root=${DSH_ROOT:-}
if [ -z "$dsh_root" ]; then
  for candidate in \
    "$root/../dsh" \
    "$root/../dsh-remote/dsh" \
    "$HOME/Projects/dsh-remote/dsh" \
    "$HOME/projects/dsh-remote/dsh"
  do
    if [ -f "$candidate/package.json" ] && [ -d "$candidate/packages/bundle/web-remote" ]; then
      dsh_root=$candidate
      break
    fi
  done
fi
if [ -z "${DSH_WEB_REMOTE_PACKAGE_DIR:-}" ] && [ -d "$dsh_root/packages/bundle/web-remote" ]; then
  DSH_WEB_REMOTE_PACKAGE_DIR="$dsh_root/packages/bundle/web-remote"
  export DSH_WEB_REMOTE_PACKAGE_DIR
fi
if [ -z "${DSH_COMMAND:-}" ] && ! command -v dsh >/dev/null 2>&1 && [ -n "$dsh_root" ] && [ -f "$dsh_root/package.json" ]; then
  DSH_COMMAND=pnpm
  DSH_COMMAND_ARGS_JSON=$(node -e 'console.log(JSON.stringify(["--dir", process.argv[1], "dsh"]))' "$dsh_root")
  export DSH_COMMAND DSH_COMMAND_ARGS_JSON
fi
if [ -z "${DSH_COMMAND:-}" ] && ! command -v dsh >/dev/null 2>&1; then
  echo 'remote-client: cannot find dsh automatically; place remote-client beside dsh or install dsh on PATH' >&2
  exit 1
fi
has_host=0
for arg in "$@"; do
  case "$arg" in
    --host|--host=*) has_host=1 ;;
  esac
done
if [ "$has_host" -eq 0 ]; then
  set -- --host 0.0.0.0 "$@"
fi
exec node "$root/packages/remote-registry/lib/bin.js" "$@"

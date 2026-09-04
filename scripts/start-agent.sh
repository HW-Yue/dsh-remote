#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

restart=0
restart_now=0
if [ "${1:-}" = "--restart" ]; then
  restart=1
  shift
fi
if [ "${1:-}" = "--restart-now" ]; then
  restart=1
  restart_now=1
  shift
fi

foreground=0
if [ "${1:-}" = "--foreground" ]; then
  foreground=1
  shift
fi

if [ "$foreground" -eq 0 ] && [ "${DSH_REMOTE_AGENT_DAEMON:-}" != "1" ]; then
  state_dir=${DSH_REMOTE_STATE_DIR:-${HOME}/.dsh-remote}
  mkdir -p "$state_dir"
  pid_file=${DSH_REMOTE_AGENT_PID_FILE:-$state_dir/agent.pid}
  log_file=${DSH_REMOTE_AGENT_LOG_FILE:-$state_dir/agent.log}

  agent_is_running() {
    candidate=$1
    [ -n "$candidate" ] || return 1
    kill -0 "$candidate" 2>/dev/null || return 1
    command_line=$(ps -p "$candidate" -o command= 2>/dev/null || true)
    case "$command_line" in
      *remote-agent/lib/bin.js*|*dsh-remote-agent*) return 0 ;;
      *) return 1 ;;
    esac
  }

  helper_is_running() {
    candidate=$1
    [ -n "$candidate" ] || return 1
    kill -0 "$candidate" 2>/dev/null || return 1
    command_line=$(ps -p "$candidate" -o command= 2>/dev/null || true)
    case "$command_line" in
      *restart-agent-helper.mjs*) return 0 ;;
      *) return 1 ;;
    esac
  }

  clear_restart_lock() {
    rm -f "$lock_dir/pid" "$lock_dir/started"
    rmdir "$lock_dir" 2>/dev/null || true
  }

  schedule_restart() {
    delay=${DSH_REMOTE_RESTART_DELAY_SECONDS:-1}
    timeout=${DSH_REMOTE_RESTART_TIMEOUT_SECONDS:-30}
    case "$timeout" in
      ''|*[!0-9]*) echo "remote-client: DSH_REMOTE_RESTART_TIMEOUT_SECONDS must be a non-negative integer" >&2; exit 2 ;;
    esac
    lock_dir=$state_dir/restart.lock
    if ! mkdir "$lock_dir" 2>/dev/null; then
      lock_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
      lock_started=$(cat "$lock_dir/started" 2>/dev/null || true)
      case "$lock_started" in ''|*[!0-9]*) lock_started=0 ;; esac
      now=$(date +%s)
      max_age=$((timeout + 5))
      lock_age=$((now - lock_started))
      if { [ -z "$lock_pid" ] && [ "$lock_age" -le "$max_age" ]; } \
        || { helper_is_running "$lock_pid" && [ "$lock_age" -le "$max_age" ]; }; then
        echo "remote-client: another agent restart is already in progress"
        exit 0
      fi
      if helper_is_running "$lock_pid"; then
        kill "$lock_pid" 2>/dev/null || true
      fi
      clear_restart_lock
      if ! mkdir "$lock_dir" 2>/dev/null; then
        echo "remote-client: another agent restart is already in progress"
        exit 0
      fi
    fi

    date +%s >"$lock_dir/started"
    if ! helper_pid=$(node "$root/scripts/spawn-detached-helper.mjs" \
      "$root/scripts/restart-agent-helper.mjs" "$delay" "$timeout" \
      "$state_dir" "$log_file" "$root/scripts/start-agent.sh" "$@"); then
      clear_restart_lock
      echo "remote-client: could not start detached restart helper" >&2
      exit 1
    fi
    { printf '%s\n' "$helper_pid" >"$lock_dir/pid"; } 2>/dev/null || true
    echo "remote-client: agent restart scheduled (old pid $old_pid)"
    echo "remote-client: log $log_file"
    exit 0
  }

  if [ -f "$pid_file" ]; then
    old_pid=$(cat "$pid_file" 2>/dev/null || true)
    if agent_is_running "$old_pid"; then
      # Never synchronously kill the Agent from a command running below it.
      # The detached helper lets this command return before replacement.
      if [ "$restart_now" -eq 0 ]; then
        schedule_restart "$@"
      fi

      lock_dir=$state_dir/restart.lock
      if [ ! -d "$lock_dir" ]; then
        mkdir "$lock_dir"
      fi
      trap 'clear_restart_lock' EXIT HUP INT TERM
      kill "$old_pid" 2>/dev/null || true
      attempts=0
      while agent_is_running "$old_pid" && [ "$attempts" -lt 50 ]; do
        sleep 0.1
        attempts=$((attempts + 1))
      done
      if agent_is_running "$old_pid"; then
        kill -KILL "$old_pid" 2>/dev/null || true
      fi
    fi
    rm -f "$pid_file"
  fi
  nohup env DSH_REMOTE_AGENT_DAEMON=1 "$0" --foreground "$@" >>"$log_file" 2>&1 </dev/null &
  daemon_pid=$!
  printf '%s\n' "$daemon_pid" >"$pid_file"
  echo "remote-client: agent started (pid $daemon_pid)"
  echo "remote-client: log $log_file"
  exit 0
fi

root=$("$root/scripts/ensure-built.sh")
if [ "$#" -gt 0 ] && case "$1" in --*) false;; *) true;; esac; then
  registry=$1
  shift
else
  registry=${DSH_REGISTRY_URL:-}
fi
if [ -n "$registry" ]; then
  case "$registry" in
    ws://*|wss://*) url=$registry;;
    *) url="ws://${registry}:32100";;
  esac
  exec env DSH_REGISTRY_URL="$url" node "$root/packages/remote-agent/lib/bin.js" "$@"
fi
exec node "$root/packages/remote-agent/lib/bin.js" "$@"

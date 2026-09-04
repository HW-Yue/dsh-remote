#!/bin/sh
set -eu
if [ "$#" -lt 1 ]; then
  echo "usage: $0 <registry-ip> [machine-id enrollment-token]" >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
registry=$1
case "$registry" in
  ws://*|wss://*) url=$registry;;
  http://*) url="ws://${registry#http://}";;
  https://*) url="wss://${registry#https://}";;
  *:* ) url="ws://${registry}";;
  *) url="ws://${registry}:32100";;
esac
if [ "$#" -ge 3 ]; then
  machine_id=$2
  enrollment_token=$3
  display_name=${4:-}
else
  machine_id=''
  enrollment_token=''
  display_name=${2:-$(hostname)}
fi
identity=$(node "$root/scripts/write-agent-identity.mjs" "$url" "$machine_id" "$enrollment_token" "$display_name")
echo "remote-client: identity saved to $identity"
exec "$root/scripts/start-agent.sh" --restart

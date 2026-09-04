#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$#" -lt 1 ]; then
  echo "usage: $0 <remote-root> [dsh-remote options...]" >&2
  exit 2
fi

remote_root=$1
shift
model_launcher="${DSH_MODEL_LAUNCHER:-$HOME/.dsh/run-with-model-env}"
if [ ! -x "$model_launcher" ]; then
  echo "missing executable model launcher: $model_launcher" >&2
  exit 1
fi

exec "$model_launcher" pnpm --dir "$root" exec dsh-remote \
  --root "$remote_root" \
  "$@"

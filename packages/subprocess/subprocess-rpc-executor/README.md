# @deepseek-ai/dsh-subprocess-rpc-executor

English | [中文](README.zh.md)

Lightweight local executor for remote subprocess and filesystem Providers. It owns local process handles and filesystem operations for one authenticated RPC peer. Its `--root` option controls directory browsing and the set of directories that can be adopted as Session workspaces; it does not permanently bind every Session to one workspace.

Run the built binary with an optional browse root, host, and port. The root defaults to `/`; use a narrower root when the directory picker must not expose the whole server/container filesystem. Supply the optional proof-of-concept token through `DSH_EXECUTOR_TOKEN`, not an argument:

```bash
DSH_EXECUTOR_TOKEN=local-poc-token \
dsh-subprocess-executor --root / --host 127.0.0.1 --port 3210
```

The executor does not run an Agent, load a preset, or receive an LLM API key. Directory browsing and workspace adoption stay under the configured root. A `workspace-write` request is confined to the adopted Session workspace; a `danger-full-access` request may access `/` and its descendants, subject to the executor process's OS permissions. Closing the connection terminates and waits for the processes owned by that connection.

## Model Experience

None, as the executor performs approved effects for server-side Consumers and registers no model-facing surface.

#### KV Cache effect

None. The executor contributes no prompt text, tool schema, or model request fields.

## Known Limitations and Deferred Work

- **One active execution world** — one connection and one process table are supported; the connection may hold multiple adopted Session workspaces, while reconnect, lease generations, executor switching, and multiple executors are deferred.
- **No PTY** — the executor rejects terminal sessions rather than simulating them with ordinary pipes.
- **Collected output is polled and bounded** — the executor publishes deltas at a configured cadence because the local collected-output reader is synchronous, and retention may become intentionally lossy after its limit.
- **Proof-of-concept authentication only** — the optional static token is suitable only for localhost or a trusted private network; the listener must not be publicly exposed without production transport identity and authorization.
- **No kernel process sandbox** — workspace checks confine filesystem RPC and subprocess cwd, but an approved process retains the ambient permissions of the local operating-system account.

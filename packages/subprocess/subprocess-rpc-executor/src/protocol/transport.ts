import type { RawData, WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'

/** JSON-RPC error returned by an executor peer. */
export class ExecutorRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'ExecutorRpcError'
  }
}

/** A bidirectional JSON-RPC peer over one WebSocket connection. */
export class ExecutorWebSocketPeer {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private requestHandler: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined
  private readonly notificationHandlers = new Set<(method: string, params: Record<string, unknown>) => void>()
  private readonly closeHandlers = new Set<(error: Error) => void>()
  private closed = false

  constructor(private readonly socket: WebSocket, private readonly maxMessageBytes = 8 * 1024 * 1024) {
    socket.on('message', this.onMessage)
    socket.on('close', this.onSocketClose)
    socket.on('error', this.onError)
  }

  /**
   * Install the request dispatcher for calls received from the peer.
   * @param handler - Dispatcher invoked for each incoming request.
   */
  onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void {
    this.requestHandler = handler
  }

  /**
   * Register a notification listener.
   * @param handler - Listener invoked for each incoming notification.
   * @returns A disposer that removes the listener.
   */
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.notificationHandlers.add(handler)
    return () => { this.notificationHandlers.delete(handler) }
  }

  /**
   * Register a connection-close listener.
   * @param handler - Listener invoked with the terminal connection error.
   * @returns A disposer that removes the listener.
   */
  onClose(handler: (error: Error) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => { handler(new Error('executor RPC connection is closed')) })
      return () => {}
    }
    this.closeHandlers.add(handler)
    return () => { this.closeHandlers.delete(handler) }
  }

  /**
   * Send a request and await its result.
   * @param method - JSON-RPC method name.
   * @param params - JSON-safe request parameters.
   * @returns The peer-supplied result.
   */
  request(method: string, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('executor RPC connection is closed'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Send a notification without awaiting a response.
   * @param method - JSON-RPC method name.
   * @param params - JSON-safe notification parameters.
   */
  notify(method: string, params: object): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** Close the connection and reject all pending requests. */
  close(): void {
    this.fail(new Error('executor RPC connection closed'))
    this.socket.close()
  }

  private readonly onMessage = (raw: RawData): void => {
    const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    if (data.length > this.maxMessageBytes) {
      this.fail(new Error(`executor RPC message exceeds ${this.maxMessageBytes} bytes`))
      return
    }
    let frame: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(data.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      frame = parsed as Record<string, unknown>
    } catch {
      this.fail(new Error('executor RPC received invalid JSON'))
      return
    }
    const id = frame.id
    const method = frame.method
    if (typeof id === 'string' && typeof method === 'string') {
      void this.handleRequest(id, method, asParams(frame.params))
    } else if (typeof id === 'string') {
      this.handleResponse(id, frame)
    } else if (typeof method === 'string') {
      for (const handler of this.notificationHandlers) {
        try { handler(method, asParams(frame.params)) } catch { /* listener isolation */ }
      }
    }
  }

  private async handleRequest(id: string, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      const handler = this.requestHandler
      if (handler === undefined) throw new ExecutorRpcError(-32601, `method not found: ${method}`)
      const result = await handler(method, params)
      this.sendIfOpen({ jsonrpc: '2.0', id, result })
    } catch (error) {
      const rpc = error instanceof ExecutorRpcError
        ? error
        : new ExecutorRpcError(-32603, error instanceof Error ? error.message : String(error))
      this.sendIfOpen({
        jsonrpc: '2.0',
        id,
        error: {
          code: rpc.code,
          message: rpc.message,
          ...(rpc.data === undefined ? {} : { data: rpc.data }),
        },
      })
    }
  }

  private handleResponse(id: string, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (typeof frame.error === 'object' && frame.error !== null) {
      const error = frame.error as Record<string, unknown>
      pending.reject(new ExecutorRpcError(
        typeof error.code === 'number' ? error.code : -32603,
        typeof error.message === 'string' ? error.message : 'executor RPC error',
        error.data,
      ))
      return
    }
    pending.resolve(frame.result)
  }

  private readonly onSocketClose = (): void => { this.fail(new Error('executor RPC socket closed')) }
  private readonly onError = (error: Error): void => { this.fail(error) }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.socket.off('message', this.onMessage)
    this.socket.off('close', this.onSocketClose)
    this.socket.off('error', this.onError)
    this.rejectPending(error)
    for (const handler of this.closeHandlers) {
      try { handler(error) } catch { /* listener isolation */ }
    }
    this.closeHandlers.clear()
    this.notificationHandlers.clear()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private sendIfOpen(frame: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return
    this.send(frame)
  }

  private send(frame: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      throw new Error('executor RPC connection is closed')
    }
    const encoded = JSON.stringify(frame)
    if (Buffer.byteLength(encoded) > this.maxMessageBytes) throw new Error('executor RPC frame exceeds message limit')
    this.socket.send(encoded)
  }
}

function asParams(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

import { type Socket, connect } from "node:net"
import { type DaemonEventName, type DaemonFrame, type DaemonRequestName, frameToLine } from "../daemon/protocol.ts"

export type DaemonEventHandler = (frame: Extract<DaemonFrame, { type: "event" }>) => void

export class KobeDaemonClient {
  private socket: Socket | null = null
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  private readonly handlers = new Map<DaemonEventName | "*", Set<DaemonEventHandler>>()

  constructor(readonly socketPath: string) {}

  connect(): Promise<void> {
    if (this.socket) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath)
      this.socket = socket
      socket.once("connect", resolve)
      socket.once("error", reject)
      socket.on("data", (chunk) => this.onData(chunk.toString("utf8")))
      socket.on("close", () => {
        this.socket = null
        for (const pending of this.pending.values()) pending.reject(new Error("daemon connection closed"))
        this.pending.clear()
      })
    })
  }

  close(): void {
    this.socket?.end()
    this.socket = null
  }

  on(name: DaemonEventName | "*", handler: DaemonEventHandler): () => void {
    let set = this.handlers.get(name)
    if (!set) {
      set = new Set()
      this.handlers.set(name, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
      if (set?.size === 0) this.handlers.delete(name)
    }
  }

  async request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket) throw new Error("daemon connection is not open")
    const id = String(this.nextId++)
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
    })
    socket.write(frameToLine({ type: "request", id, name, payload }))
    return promise
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf("\n")
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.trim().length > 0) this.onLine(line)
      nl = this.buffer.indexOf("\n")
    }
  }

  private onLine(line: string): void {
    const frame = JSON.parse(line) as DaemonFrame
    if (frame.type === "event") {
      this.emit(frame)
      return
    }
    if (frame.type !== "response") return
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    if (frame.error) pending.reject(new Error(frame.error.message))
    else pending.resolve(frame.payload)
  }

  private emit(frame: Extract<DaemonFrame, { type: "event" }>): void {
    for (const handler of this.handlers.get(frame.name) ?? []) handler(frame)
    for (const handler of this.handlers.get("*") ?? []) handler(frame)
  }
}

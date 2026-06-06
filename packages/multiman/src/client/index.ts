// src/client/index.ts
// Thin wrapper. Zero heavy deps (no db/kernel import) so runner/TUI/CLI can use it.
export interface MultimanRpcTransport {
  request<T>(name: "multiman", payload: { method: string; params?: Record<string, unknown> }): Promise<T>
}

export class MultimanClient {
  constructor(private transport: MultimanRpcTransport) {}
  private call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.transport.request<T>("multiman", { method, params })
  }
  createRole(p: { name: string; kind: string; instructions?: string }) {
    return this.call("role.create", p)
  }
  listRoles() {
    return this.call("role.list")
  }
  createTask(p: { title: string; roleId?: string; repo?: string; priority?: number }) {
    return this.call("task.create", p)
  }
  listTasks(p: { status?: string } = {}) {
    return this.call("task.list", p)
  }
  transition(p: { id: string; to: string; reason?: string; roleId?: string }) {
    return this.call("task.transition", p)
  }
  claim(p: { roleId: string }) {
    return this.call("task.claim", p)
  }
}

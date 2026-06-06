// src/rpc.ts
import type { MultimanKernel } from "./kernel"
import type { RoleKind, TaskStatus } from "./types"

type Params = Record<string, unknown>

function reqStr(p: Params, k: string): string {
  const v = p[k]
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing/invalid param: ${k}`)
  return v
}
function optStr(p: Params, k: string): string | undefined {
  const v = p[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "string") throw new Error(`invalid param: ${k}`)
  return v
}

export type RpcHandler = (method: string, params: Params) => Promise<unknown>

export function makeRpcHandler(kernel: MultimanKernel): RpcHandler {
  const routes: Record<string, (p: Params) => unknown | Promise<unknown>> = {
    // task.* (S0 scope)
    "task.create": (p) =>
      kernel.createTask({
        title: reqStr(p, "title"),
        body: optStr(p, "body"),
        role_id: optStr(p, "roleId") ?? null,
        repo: optStr(p, "repo") ?? null,
        priority: typeof p.priority === "number" ? p.priority : 0,
      }),
    "task.get": (p) => kernel.getTask(reqStr(p, "id")) ?? null,
    "task.list": (p) =>
      kernel.listTasks({
        status: optStr(p, "status") as TaskStatus | undefined,
        role_id: optStr(p, "roleId"),
        dag_id: optStr(p, "dagId"),
      }),
    "task.transition": (p) =>
      kernel.transition(reqStr(p, "id"), reqStr(p, "to") as TaskStatus, optStr(p, "reason") ?? "rpc", {
        roleId: optStr(p, "roleId"),
      }),
    "task.claim": (p) => kernel.claimNextTask(reqStr(p, "roleId")),
    "task.report": (p) =>
      kernel.reportTask(reqStr(p, "id"), {
        status: reqStr(p, "status") as TaskStatus,
        result: optStr(p, "result"),
        error: optStr(p, "error"),
        sessionId: optStr(p, "sessionId"),
      }),
    "task.heartbeat": (p) => {
      kernel.heartbeat(reqStr(p, "id"), reqStr(p, "roleId"))
      return { ok: true }
    },
    // role.* (S0 scope)
    "role.create": (p) =>
      kernel.createRoleViaDao(
        reqStr(p, "name"),
        reqStr(p, "kind") as RoleKind,
        optStr(p, "instructions"),
        optStr(p, "vendor"),
        optStr(p, "model"),
      ),
    "role.get": (p) => kernel.getRole(reqStr(p, "id")) ?? null,
    "role.list": () => kernel.listRoles(),
    // dag.* (S0 scope)
    "dag.create": (p) =>
      kernel.createDag(
        { title: optStr(p, "title") },
        (p.tasks as Parameters<MultimanKernel["createDag"]>[1] | undefined) ?? [],
        (p.edges as [string, string][] | undefined) ?? [],
      ),
    "dag.get": (p) => kernel.getDag(reqStr(p, "id")),
  }
  return async (method, params) => {
    const fn = routes[method]
    if (!fn) throw new Error(`unknown method: ${method}`)
    return await fn(params ?? {})
  }
}

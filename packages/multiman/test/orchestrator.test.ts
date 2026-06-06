// test/orchestrator.test.ts
import { describe, expect, it } from "bun:test"
import { type DecomposeResult, type OrchestratorDeps, orchestrateLoop, orchestrateOnce } from "@/orchestrator"
import type { InboxItem } from "@/types"

function makeItem(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "i1",
    source: "test",
    kind: "task",
    payload: "{}",
    severity: "action",
    status: "claimed",
    consumed_by: "orchestrator",
    created_at: "2026-06-05T00:00:00Z",
    ...over,
  }
}

interface CreateDagCall {
  info: { title: string; source_inbox_item_id?: string }
  tasks: {
    key: string
    title: string
    body?: string
    role_id?: string | null
    repo?: string | null
    priority?: number
  }[]
  edges: [string, string][]
}

interface Calls {
  claimInbox: number
  decompose: string[]
  resolveRole: Array<string | undefined>
  createDag: CreateDagCall[]
  markInbox: Array<{ id: string; status: string }>
  waitForWork: number
  log: string[]
}

function makeDeps(
  over: Partial<OrchestratorDeps> & {
    decomposeResult?: DecomposeResult
    decomposeThrows?: unknown
    createDagThrows?: unknown
    roleMap?: Record<string, string>
  } = {},
): { deps: OrchestratorDeps; calls: Calls } {
  const calls: Calls = {
    claimInbox: 0,
    decompose: [],
    resolveRole: [],
    createDag: [],
    markInbox: [],
    waitForWork: 0,
    log: [],
  }
  const { decomposeResult, decomposeThrows, createDagThrows, roleMap, ...rest } = over
  const map = roleMap ?? { backend: "role-1" }
  const deps: OrchestratorDeps = {
    claimInbox: async () => {
      calls.claimInbox++
      return makeItem()
    },
    decompose: async (item) => {
      calls.decompose.push(item.id)
      if (decomposeThrows !== undefined) throw decomposeThrows
      return (
        decomposeResult ?? {
          tasks: [
            { key: "a", title: "A", roleName: "backend" },
            { key: "b", title: "B", roleName: "frontend" },
          ],
          edges: [["a", "b"]],
        }
      )
    },
    resolveRole: async (roleName) => {
      calls.resolveRole.push(roleName)
      if (roleName === undefined) return null
      return map[roleName] ?? null
    },
    createDag: async (info, tasks, edges) => {
      calls.createDag.push({ info, tasks, edges })
      if (createDagThrows !== undefined) throw createDagThrows
      return { id: "dag-1" }
    },
    markInbox: async (id, status) => {
      calls.markInbox.push({ id, status })
    },
    waitForWork: async () => {
      calls.waitForWork++
    },
    log: (msg) => {
      calls.log.push(msg)
    },
    ...rest,
  }
  return { deps, calls }
}

describe("orchestrator", () => {
  it("happy path: claim -> decompose -> resolve roles -> createDag -> markInbox(processed)", async () => {
    const { deps, calls } = makeDeps()
    const item = await orchestrateOnce(deps)
    expect(item?.id).toBe("i1")
    expect(calls.decompose).toEqual(["i1"])
    expect(calls.createDag).toHaveLength(1)
    const call = calls.createDag[0]!
    expect(call.info.source_inbox_item_id).toBe("i1")
    // role names resolved: backend -> role-1, frontend -> null (unmatched)
    expect(call.tasks).toEqual([
      { key: "a", title: "A", body: undefined, role_id: "role-1", repo: undefined, priority: undefined },
      { key: "b", title: "B", body: undefined, role_id: null, repo: undefined, priority: undefined },
    ])
    expect(call.edges).toEqual([["a", "b"]])
    expect(calls.markInbox).toEqual([{ id: "i1", status: "processed" }])
    expect(calls.waitForWork).toBe(0)
  })

  it("carries through body/repo/priority into createDag tasks", async () => {
    const { deps, calls } = makeDeps({
      decomposeResult: {
        tasks: [{ key: "a", title: "A", body: "do it", roleName: "backend", repo: "r", priority: 5 }],
        edges: [],
      },
    })
    await orchestrateOnce(deps)
    expect(calls.createDag[0]!.tasks).toEqual([
      { key: "a", title: "A", body: "do it", role_id: "role-1", repo: "r", priority: 5 },
    ])
  })

  it("no work: claim null -> waitForWork, no decompose/createDag, returns null", async () => {
    const { deps, calls } = makeDeps({ claimInbox: async () => null })
    const item = await orchestrateOnce(deps)
    expect(item).toBeNull()
    expect(calls.waitForWork).toBe(1)
    expect(calls.decompose).toEqual([])
    expect(calls.createDag).toEqual([])
    expect(calls.markInbox).toEqual([])
  })

  it("decompose throws -> markInbox(archived), no createDag, does not throw", async () => {
    const { deps, calls } = makeDeps({ decomposeThrows: new Error("planner boom") })
    const item = await orchestrateOnce(deps)
    expect(item?.id).toBe("i1")
    expect(calls.createDag).toEqual([])
    expect(calls.markInbox).toEqual([{ id: "i1", status: "archived" }])
  })

  it("decompose returns 0 tasks -> markInbox(archived), no createDag", async () => {
    const { deps, calls } = makeDeps({ decomposeResult: { tasks: [], edges: [] } })
    const item = await orchestrateOnce(deps)
    expect(item?.id).toBe("i1")
    expect(calls.createDag).toEqual([])
    expect(calls.markInbox).toEqual([{ id: "i1", status: "archived" }])
  })

  it("createDag throws (cycle) -> markInbox(archived), does not throw", async () => {
    const { deps, calls } = makeDeps({ createDagThrows: new Error("CyclicDagError") })
    const item = await orchestrateOnce(deps)
    expect(item?.id).toBe("i1")
    expect(calls.createDag).toHaveLength(1)
    expect(calls.markInbox).toEqual([{ id: "i1", status: "archived" }])
  })

  it("unmatched roleName -> role_id is null in createDag call", async () => {
    const { deps, calls } = makeDeps({
      decomposeResult: { tasks: [{ key: "a", title: "A", roleName: "nope" }], edges: [] },
    })
    await orchestrateOnce(deps)
    expect(calls.createDag[0]!.tasks[0]!.role_id).toBeNull()
  })

  it("undefined roleName -> role_id is null (unassigned, awaiting human)", async () => {
    const { deps, calls } = makeDeps({
      decomposeResult: { tasks: [{ key: "a", title: "A" }], edges: [] },
    })
    await orchestrateOnce(deps)
    expect(calls.resolveRole).toEqual([undefined])
    expect(calls.createDag[0]!.tasks[0]!.role_id).toBeNull()
  })

  it("orchestrateLoop: runs until stop() true, claimInbox called N times", async () => {
    let ticks = 0
    const { deps, calls } = makeDeps({ claimInbox: async () => null, waitForWork: async () => {} })
    // re-wire claimInbox to count via calls (overridden above resets counter wiring); use closure
    let claims = 0
    deps.claimInbox = async () => {
      claims++
      return null
    }
    await orchestrateLoop(deps, { stop: () => ticks++ >= 3 })
    expect(claims).toBe(3)
    expect(calls.markInbox).toEqual([])
  })
})

// test/runner.test.ts
import { describe, expect, it } from "bun:test"
import { type ExecuteResult, type RunnerDeps, runLoop, runOnce } from "@/runner"
import type { Task } from "@/types"

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "title",
    body: "body",
    role_id: "r1",
    status: "claimed",
    priority: 0,
    parent_task_id: null,
    dag_id: null,
    kobe_task_id: null,
    repo: null,
    session_id: null,
    mr_url: null,
    work_dir: null,
    source_kind: "manual",
    source_ref: null,
    result: null,
    error: null,
    claimed_by: null,
    claimed_at: null,
    last_heartbeat_at: null,
    retry_count: 0,
    created_at: "2026-06-05T00:00:00Z",
    updated_at: "2026-06-05T00:00:00Z",
    ...over,
  }
}

interface Calls {
  transitionRunning: string[]
  heartbeat: string[]
  report: Array<{ id: string; status: ExecuteResult["status"]; result?: string; error?: string }>
  execute: string[]
  waitForWork: number
}

function makeDeps(over: Partial<RunnerDeps> & { execResult?: ExecuteResult; execThrows?: unknown } = {}): {
  deps: RunnerDeps
  calls: Calls
} {
  const calls: Calls = {
    transitionRunning: [],
    heartbeat: [],
    report: [],
    execute: [],
    waitForWork: 0,
  }
  const { execResult, execThrows, ...rest } = over
  const deps: RunnerDeps = {
    claim: async () => makeTask(),
    transitionRunning: async (id) => {
      calls.transitionRunning.push(id)
      return makeTask({ id, status: "running" })
    },
    heartbeat: (id) => {
      calls.heartbeat.push(id)
    },
    report: async (id, status, result, error) => {
      calls.report.push({ id, status, result, error })
      return makeTask({ id, status })
    },
    execute: async (task) => {
      calls.execute.push(task.id)
      if (execThrows !== undefined) throw execThrows
      return execResult ?? { status: "in_review", result: "ok" }
    },
    waitForWork: async () => {
      calls.waitForWork++
    },
    heartbeatIntervalMs: 0,
    ...rest,
  }
  return { deps, calls }
}

describe("runner", () => {
  it("happy path: claim -> transitionRunning -> execute -> report(in_review)", async () => {
    const { deps, calls } = makeDeps()
    const t = await runOnce(deps)
    expect(t?.id).toBe("t1")
    expect(calls.transitionRunning).toEqual(["t1"])
    expect(calls.execute).toEqual(["t1"])
    expect(calls.report).toEqual([{ id: "t1", status: "in_review", result: "ok", error: undefined }])
  })

  it("no work: claim null -> waitForWork, nothing else, returns null", async () => {
    const { deps, calls } = makeDeps({ claim: async () => null })
    const t = await runOnce(deps)
    expect(t).toBeNull()
    expect(calls.waitForWork).toBe(1)
    expect(calls.transitionRunning).toEqual([])
    expect(calls.execute).toEqual([])
    expect(calls.report).toEqual([])
  })

  it("execute returns failed -> report(failed)", async () => {
    const { deps, calls } = makeDeps({ execResult: { status: "failed", error: "boom" } })
    await runOnce(deps)
    expect(calls.report).toEqual([{ id: "t1", status: "failed", result: undefined, error: "boom" }])
  })

  it("execute returns blocked -> report(blocked)", async () => {
    const { deps, calls } = makeDeps({ execResult: { status: "blocked", result: "waiting" } })
    await runOnce(deps)
    expect(calls.report).toEqual([{ id: "t1", status: "blocked", result: "waiting", error: undefined }])
  })

  it("execute throws -> runOnce does not throw, report(failed) with error string", async () => {
    const { deps, calls } = makeDeps({ execThrows: new Error("kaboom") })
    const t = await runOnce(deps)
    expect(t?.id).toBe("t1")
    expect(calls.report).toHaveLength(1)
    expect(calls.report[0]?.status).toBe("failed")
    expect(calls.report[0]?.error).toBe("Error: kaboom")
  })

  it("runLoop: runs runOnce until stop() returns true", async () => {
    let claims = 0
    let ticks = 0
    const { deps } = makeDeps({
      claim: async () => {
        claims++
        return null
      },
      waitForWork: async () => {},
    })
    await runLoop(deps, { stop: () => ticks++ >= 3 })
    // stop() returns false for ticks 0,1,2 -> 3 iterations; true at tick 3.
    expect(claims).toBe(3)
  })

  it("heartbeat ticker: fires while execute is in flight, cleared after", async () => {
    const { deps, calls } = makeDeps({
      heartbeatIntervalMs: 5,
      execute: async (task) => {
        calls.execute.push(task.id)
        await new Promise((r) => setTimeout(r, 30))
        return { status: "in_review", result: "ok" }
      },
    })
    await runOnce(deps)
    const afterRun = calls.heartbeat.length
    expect(afterRun).toBeGreaterThanOrEqual(1)
    // Ticker cleared in finally: wait past several more intervals, count must not grow.
    await new Promise((r) => setTimeout(r, 30))
    expect(calls.heartbeat.length).toBe(afterRun)
  })
})

// test/rpc-inbox-schedule.test.ts
import { describe, expect, it } from "bun:test"
import { Dao } from "@/db/dao"
import { runMigrations } from "@/db/migrate"
import { openDb } from "@/db/open"
import { MultimanKernel } from "@/kernel"
import { makeRpcHandler } from "@/rpc"
import type { InboxItem, Schedule } from "@/types"

function makeHandler() {
  const db = openDb(":memory:")
  runMigrations(db)
  let n = 0
  const dao = new Dao(
    db,
    () => "2026-06-05T00:00:00.000Z",
    () => `id-${++n}`,
  )
  const events: { kind: string; payload: unknown }[] = []
  const orch = {
    async adoptWorktree(i: { branch: string; worktreePath: string }) {
      return { id: `kobe-${i.branch}`, worktreePath: i.worktreePath }
    },
  }
  const kernel = new MultimanKernel({
    dao,
    orchestrator: orch as never,
    now: () => "2026-06-05T00:00:00.000Z",
    publish: (kind, payload) => events.push({ kind, payload }),
  })
  return { h: makeRpcHandler(kernel), events }
}

describe("rpc inbox routes", () => {
  it("push -> list -> claim -> mark", async () => {
    const { h, events } = makeHandler()
    const pushed = (await h("inbox.push", { source: "s", kind: "alert", severity: "action" })) as InboxItem
    expect(pushed.status).toBe("new")
    expect(pushed.severity).toBe("action")
    expect(events.some((e) => e.kind === "inbox.pushed")).toBe(true)

    const list = (await h("inbox.list", { status: "new" })) as InboxItem[]
    expect(list.length).toBe(1)

    const claimed = (await h("inbox.claim", { consumer: "w1" })) as InboxItem
    expect(claimed.status).toBe("claimed")
    expect(claimed.consumed_by).toBe("w1")
    expect(events.some((e) => e.kind === "inbox.claimed")).toBe(true)

    const marked = (await h("inbox.mark", { id: claimed.id, status: "processed" })) as InboxItem
    expect(marked.status).toBe("processed")
  })

  it("inbox.claim returns null when empty", async () => {
    const { h } = makeHandler()
    expect(await h("inbox.claim", { consumer: "w" })).toBeNull()
  })

  it("inbox.push requires source", async () => {
    const { h } = makeHandler()
    await expect(h("inbox.push", { kind: "k" })).rejects.toThrow(/source/)
  })
})

describe("rpc schedule routes", () => {
  it("create cron computes next_run_at from cronExpr", async () => {
    const { h } = makeHandler()
    const s = (await h("schedule.create", {
      name: "nightly",
      triggerKind: "cron",
      cronExpr: "0 0 * * *",
      targetKind: "role",
      targetRef: "collector",
    })) as Schedule
    // now is 2026-06-05T00:00:00Z, next midnight is 2026-06-06T00:00:00Z
    expect(s.next_run_at).toBe("2026-06-06T00:00:00.000Z")
    expect(s.execution_mode).toBe("collect")
  })

  it("create manual leaves next_run_at null", async () => {
    const { h } = makeHandler()
    const s = (await h("schedule.create", {
      name: "m",
      triggerKind: "manual",
      targetKind: "role",
      targetRef: "r",
    })) as Schedule
    expect(s.next_run_at).toBeNull()
  })

  it("list, enable/disable, update, runNow", async () => {
    const { h } = makeHandler()
    const s = (await h("schedule.create", {
      name: "m",
      triggerKind: "manual",
      targetKind: "role",
      targetRef: "r",
    })) as Schedule

    expect(((await h("schedule.list", {})) as Schedule[]).length).toBe(1)

    const disabled = (await h("schedule.enable", { id: s.id, enabled: false })) as Schedule
    expect(disabled.enabled).toBe(0)
    expect(((await h("schedule.list", { enabled: false })) as Schedule[]).length).toBe(1)
    expect(((await h("schedule.list", { enabled: true })) as Schedule[]).length).toBe(0)

    const updated = (await h("schedule.update", { id: s.id, name: "renamed" })) as Schedule
    expect(updated.name).toBe("renamed")

    const ran = (await h("schedule.runNow", { id: s.id })) as Schedule
    expect(ran.next_run_at).toBe("2026-06-05T00:00:00.000Z")
  })

  it("schedule.enable requires boolean enabled", async () => {
    const { h } = makeHandler()
    const s = (await h("schedule.create", {
      name: "m",
      triggerKind: "manual",
      targetKind: "role",
      targetRef: "r",
    })) as Schedule
    await expect(h("schedule.enable", { id: s.id })).rejects.toThrow(/enabled/)
  })
})

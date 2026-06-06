// test/status-view.test.ts
import { describe, expect, it } from "bun:test"
import { renderStatus } from "@/status-view"
import type { InboxItem, Role, Task } from "@/types"

/** Minimal Role factory — only fields the renderer reads matter. */
function role(over: Partial<Role>): Role {
  return {
    id: "role-aaaaaa",
    name: "alice",
    kind: "worker",
    instructions: "",
    vendor: null,
    model: null,
    status: "active",
    created_at: "",
    updated_at: "",
    ...over,
  }
}

/** Minimal Task factory. */
function task(over: Partial<Task>): Task {
  return {
    id: "task-aaaaaa",
    title: "do a thing",
    body: "",
    role_id: null,
    status: "pending",
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
    created_at: "",
    updated_at: "",
    ...over,
  }
}

/** Minimal InboxItem factory. */
function inbox(over: Partial<InboxItem>): InboxItem {
  return {
    id: "inbox-aaaaaa",
    source: "github",
    kind: "pr_review",
    payload: "{}",
    severity: "info",
    status: "new",
    consumed_by: null,
    created_at: "",
    ...over,
  }
}

describe("renderStatus", () => {
  it("renders an empty snapshot without throwing, showing (no roles) and a header", () => {
    const out = renderStatus({ roles: [], tasks: [], inbox: [] })
    expect(out).toContain("multiman status")
    expect(out).toContain("(no roles)")
  })

  it("does not deadlabel statuses that have zero tasks", () => {
    const out = renderStatus({ roles: [], tasks: [], inbox: [] })
    // No status section headers should appear for empty task sets.
    expect(out).not.toContain("PENDING (")
    expect(out).not.toContain("DONE (")
  })

  it("renders roles, task status sections, dag rollup, and inbox counts", () => {
    const roles = [
      role({ id: "role-111111", name: "alice", kind: "worker", status: "active" }),
      role({ id: "role-222222", name: "bob", kind: "orchestrator", status: "disabled" }),
    ]
    const tasks = [
      task({ id: "task-aaa001", title: "first", status: "pending", role_id: "role-111111" }),
      task({ id: "task-aaa002", title: "second", status: "running", role_id: "role-111111", dag_id: "dag-zzz999" }),
      task({
        id: "task-aaa003",
        title: "third",
        status: "done",
        role_id: "role-222222",
        dag_id: "dag-zzz999",
        mr_url: "https://example.com/mr/3",
      }),
    ]
    const inboxItems = [
      inbox({ id: "inbox-001", kind: "pr_review", source: "github", status: "new", severity: "action" }),
      inbox({ id: "inbox-002", kind: "alert", source: "pager", status: "claimed", severity: "attention" }),
      inbox({ id: "inbox-003", kind: "noise", source: "logs", status: "archived", severity: "info" }),
    ]

    const out = renderStatus({ roles, tasks, inbox: inboxItems })

    // Roles: name (kind) [status]
    expect(out).toContain("alice")
    expect(out).toContain("bob")
    expect(out).toContain("(orchestrator)")
    expect(out).toContain("[disabled]")

    // Status section headers with counts (each status has 1 task).
    expect(out).toContain("PENDING (1)")
    expect(out).toContain("RUNNING (1)")
    expect(out).toContain("DONE (1)")
    // Empty statuses skipped.
    expect(out).not.toContain("BLOCKED (")

    // Task lines reference titles and short ids (last 6 chars).
    expect(out).toContain("first")
    expect(out).toContain("aaa001")
    expect(out).toContain("alice") // role name resolved onto the task line

    // Totals summary (only nonzero).
    expect(out).toContain("pending=1")
    expect(out).toContain("running=1")
    expect(out).toContain("done=1")
    expect(out).not.toContain("blocked=")

    // MR shown for the done task.
    expect(out).toContain("https://example.com/mr/3")

    // DAG rollup: dag <short>: N tasks (done/total done)
    expect(out).toContain("zzz999")
    expect(out).toContain("2 tasks")
    expect(out).toContain("(1/2 done)")

    // Inbox counts (only nonzero) + new/claimed item lines.
    expect(out).toContain("new=1")
    expect(out).toContain("claimed=1")
    expect(out).toContain("archived=1")
    expect(out).not.toContain("processed=")
    expect(out).toContain("pr_review")
    expect(out).toContain("from github")
    expect(out).toContain("alert")
    // Archived item is not listed (only new/claimed).
    expect(out).not.toContain("noise")
  })

  it("is deterministic: same input -> same output", () => {
    const snap = {
      roles: [role({ id: "role-111111", name: "alice" })],
      tasks: [task({ id: "task-aaa001", status: "pending" })],
      inbox: [inbox({ id: "inbox-001", status: "new" })],
    }
    expect(renderStatus(snap)).toBe(renderStatus(snap))
  })

  it("shows an em-dash for tasks with no role", () => {
    const out = renderStatus({
      roles: [],
      tasks: [task({ id: "task-aaa001", status: "pending", role_id: null })],
      inbox: [],
    })
    expect(out).toContain("—")
  })
})

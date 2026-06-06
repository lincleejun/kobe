/**
 * Pure text dashboard renderer for `kobe multiman status`.
 *
 * Given a snapshot of roles / tasks / inbox items, produce a readable,
 * fixed-width ASCII view of the system. PURE: same input → same output, no
 * `Date.now()` / no I/O — so it is trivially unit-testable and the watch loop
 * just re-renders on each refetch. The caller owns timestamps / footers.
 */
import { TASK_STATUSES } from "./types"
import type { InboxItem, Role, Task, TaskStatus } from "./types"

export interface StatusSnapshot {
  roles: Role[]
  tasks: Task[]
  inbox: InboxItem[]
}

/** Last 6 chars of an id, for a compact reference (ids are long + opaque). */
function shortId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6)
}

/**
 * Render the dashboard. Sections, in order: header, roles, tasks-by-status,
 * a one-line totals summary, inbox counts + new/claimed items, and a DAG
 * rollup. Empty groups collapse (skipped statuses, "(no roles)", etc.).
 */
export function renderStatus(s: StatusSnapshot): string {
  const lines: string[] = []
  lines.push("multiman status")
  lines.push("")

  // --- Roles -------------------------------------------------------------
  lines.push("Roles:")
  if (s.roles.length === 0) {
    lines.push("  (no roles)")
  } else {
    for (const r of s.roles) {
      lines.push(`  ${r.name} (${r.kind}) [${r.status}]`)
    }
  }
  lines.push("")

  // Resolve a role id → name for task lines.
  const roleName = new Map<string, string>()
  for (const r of s.roles) roleName.set(r.id, r.name)

  // --- Tasks by status ---------------------------------------------------
  const byStatus = new Map<TaskStatus, Task[]>()
  for (const t of s.tasks) {
    const bucket = byStatus.get(t.status)
    if (bucket) bucket.push(t)
    else byStatus.set(t.status, [t])
  }

  lines.push("Tasks:")
  let renderedAnyStatus = false
  for (const status of TASK_STATUSES) {
    const bucket = byStatus.get(status)
    if (!bucket || bucket.length === 0) continue
    renderedAnyStatus = true
    lines.push(`  ${status.toUpperCase()} (${bucket.length})`)
    for (const t of bucket) {
      const role = t.role_id ? (roleName.get(t.role_id) ?? t.role_id) : "—"
      const parts = [`    ${shortId(t.id)} ${t.title} [${role}]`]
      if (t.dag_id) parts.push(`[dag:${shortId(t.dag_id)}]`)
      if (t.mr_url) parts.push(`[mr ${t.mr_url}]`)
      lines.push(parts.join(" "))
    }
  }
  if (!renderedAnyStatus) lines.push("  (no tasks)")

  // Totals summary — only nonzero statuses, in canonical order.
  const totals: string[] = []
  for (const status of TASK_STATUSES) {
    const n = byStatus.get(status)?.length ?? 0
    if (n > 0) totals.push(`${status}=${n}`)
  }
  lines.push(`  tasks: ${totals.length > 0 ? totals.join(" ") : "none"}`)
  lines.push("")

  // --- Inbox -------------------------------------------------------------
  const inboxCounts: Record<"new" | "claimed" | "processed" | "archived", number> = {
    new: 0,
    claimed: 0,
    processed: 0,
    archived: 0,
  }
  for (const item of s.inbox) {
    if (item.status in inboxCounts) inboxCounts[item.status] += 1
  }
  const inboxParts: string[] = []
  for (const status of ["new", "claimed", "processed", "archived"] as const) {
    const n = inboxCounts[status]
    if (n > 0) inboxParts.push(`${status}=${n}`)
  }
  lines.push(`inbox: ${inboxParts.length > 0 ? inboxParts.join(" ") : "empty"}`)
  for (const item of s.inbox) {
    if (item.status !== "new" && item.status !== "claimed") continue
    lines.push(`  ${item.kind} from ${item.source} [${item.severity}]`)
  }
  lines.push("")

  // --- DAGs --------------------------------------------------------------
  const dagTasks = new Map<string, { total: number; done: number }>()
  for (const t of s.tasks) {
    if (!t.dag_id) continue
    const agg = dagTasks.get(t.dag_id) ?? { total: 0, done: 0 }
    agg.total += 1
    if (t.status === "done") agg.done += 1
    dagTasks.set(t.dag_id, agg)
  }
  lines.push("DAGs:")
  if (dagTasks.size === 0) {
    lines.push("  (no dags)")
  } else {
    for (const [dagId, agg] of dagTasks) {
      lines.push(`  dag ${shortId(dagId)}: ${agg.total} tasks (${agg.done}/${agg.total} done)`)
    }
  }

  return lines.join("\n")
}

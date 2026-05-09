/**
 * Pure grouping function for the sidebar pane.
 *
 * Tasks live in the {@link TaskIndex} as a flat ordered array. The sidebar
 * displays them grouped by status — matching Conductor's layout grammar
 * (DESIGN.md §1, §5.3). Empty groups are still listed (with count 0) so the
 * sidebar's row layout is visually stable as tasks transition between
 * statuses; users can predict where a row will appear before it arrives.
 *
 * Group order is fixed in {@link STATUS_ORDER}: most actionable first
 * (`in_progress`, `in_review`), then `backlog`, then terminal states
 * (`done`, `canceled`, `error`). This is the reverse of Conductor's exact
 * order — Conductor leads with `Done` — but matches what F's brief
 * specifies and what we expect kobe users to scan first.
 *
 * Within a group, tasks keep their input order. The orchestrator owns
 * task ordering (typically by `createdAt` ULID); we do not re-sort.
 *
 * No reactivity here: this is a pure function over `readonly Task[]`. The
 * Solid component (`Sidebar.tsx`) wraps it in a `createMemo` so the
 * grouping recomputes only when the upstream task signal changes.
 */

import type { Task, TaskStatus } from "@/types"

/**
 * One visible row in the sidebar body. Either a status group header
 * (with the count of tasks in that group) or a navigable task row that
 * carries its position in the flat-id list (`flatIndex`).
 */
export type SidebarRow =
  | { kind: "header"; status: TaskStatus; count: number }
  | { kind: "task"; task: Task; flatIndex: number }

/**
 * The canonical group display order. The sidebar renders groups in this
 * sequence regardless of how many tasks each contains.
 *
 * Tuple typed as `readonly TaskStatus[]` (not a value) so TypeScript
 * keeps the literal-tuple narrowing for downstream `.map()` callers.
 */
export const STATUS_ORDER = [
  "in_progress",
  "in_review",
  "backlog",
  "done",
  "canceled",
  "error",
] as const satisfies readonly TaskStatus[]

/**
 * Group a flat task list by status.
 *
 * Returns a complete record — every {@link TaskStatus} key is present,
 * empty arrays included. This is intentional: the sidebar iterates over
 * {@link STATUS_ORDER} and reads from this record, so callers never need
 * a `?? []` fallback.
 *
 * Mutation: returns fresh arrays. The input `tasks` is not mutated and
 * the returned arrays do not alias the input.
 */
export function groupByStatus(tasks: readonly Task[]): Record<TaskStatus, Task[]> {
  const out: Record<TaskStatus, Task[]> = {
    in_progress: [],
    in_review: [],
    backlog: [],
    done: [],
    canceled: [],
    error: [],
  }
  for (const t of tasks) {
    out[t.status].push(t)
  }
  return out
}

/**
 * Build the flat row list for rendering. Headers are interleaved with
 * task rows in {@link STATUS_ORDER}. Tasks within a group keep their
 * input order. Empty groups still emit a header (with count 0) so the
 * list is visually stable when tasks transition statuses. Each task row
 * carries its `flatIndex` — its position in the navigable id list — so
 * the renderer can compare against the cursor without recounting
 * headers.
 *
 * Pure: no Solid, no opentui. Component code calls this inside a memo;
 * tests call it directly.
 */
export function buildRows(tasks: readonly Task[]): SidebarRow[] {
  const groups = groupByStatus(tasks)
  const rows: SidebarRow[] = []
  let flat = 0
  for (const status of STATUS_ORDER) {
    const bucket = groups[status]
    rows.push({ kind: "header", status, count: bucket.length })
    for (const t of bucket) {
      rows.push({ kind: "task", task: t, flatIndex: flat })
      flat++
    }
  }
  return rows
}

/** Extract the flat list of navigable task ids (header rows skipped). */
export function flattenIds(rows: readonly SidebarRow[]): string[] {
  const ids: string[] = []
  for (const r of rows) if (r.kind === "task") ids.push(r.task.id)
  return ids
}

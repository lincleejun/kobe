// Enum single source of truth. SQL CHECK constraints in 001_init.sql must match
// these arrays exactly; enum-sync.test.ts asserts that.
export const TASK_STATUSES = [
  "pending", "assigned", "claimed", "running",
  "blocked", "in_review", "done", "failed", "cancelled",
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const ROLE_KINDS = ["orchestrator", "worker", "collector"] as const
export type RoleKind = (typeof ROLE_KINDS)[number]

export const ROLE_STATUSES = ["active", "disabled"] as const
export type RoleStatus = (typeof ROLE_STATUSES)[number]

export const TASK_SOURCE_KINDS = ["manual", "inbox", "orchestrator"] as const
export type TaskSourceKind = (typeof TASK_SOURCE_KINDS)[number]

export const DAG_STATUSES = ["open", "done", "failed", "cancelled"] as const
export type DagStatus = (typeof DAG_STATUSES)[number]

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "cancelled"])

export interface Role {
  id: string
  name: string
  kind: RoleKind
  instructions: string
  vendor: string | null
  model: string | null
  status: RoleStatus
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  title: string
  body: string
  role_id: string | null
  status: TaskStatus
  priority: number
  parent_task_id: string | null
  dag_id: string | null
  kobe_task_id: string | null
  repo: string | null
  session_id: string | null
  work_dir: string | null
  source_kind: TaskSourceKind
  source_ref: string | null
  result: string | null
  error: string | null
  claimed_by: string | null
  claimed_at: string | null
  last_heartbeat_at: string | null
  retry_count: number
  created_at: string
  updated_at: string
}

export interface Dag {
  id: string
  title: string
  source_inbox_item_id: string | null
  orchestrator_role_id: string | null
  status: DagStatus
  created_at: string
  updated_at: string
}

export interface DagEdge {
  dag_id: string
  from_task_id: string
  to_task_id: string
  type: "depends_on"
}

export interface EventLogRow {
  id: string
  actor_kind: string
  actor_id: string | null
  action: string
  target_kind: string
  target_id: string | null
  details: string
  ts: string
}

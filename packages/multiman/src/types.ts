// Enum single source of truth. SQL CHECK constraints in 001_init.sql must match
// these arrays exactly; enum-sync.test.ts asserts that.
export const TASK_STATUSES = [
  "pending",
  "assigned",
  "claimed",
  "running",
  "blocked",
  "in_review",
  "done",
  "failed",
  "cancelled",
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

export const INBOX_SEVERITIES = ["action", "attention", "info"] as const
export type InboxSeverity = (typeof INBOX_SEVERITIES)[number]

export const INBOX_STATUSES = ["new", "claimed", "processed", "archived"] as const
export type InboxStatus = (typeof INBOX_STATUSES)[number]

export const SCHEDULE_TRIGGER_KINDS = ["cron", "manual"] as const
export type ScheduleTriggerKind = (typeof SCHEDULE_TRIGGER_KINDS)[number]

export const SCHEDULE_TARGET_KINDS = ["role", "workflow"] as const
export type ScheduleTargetKind = (typeof SCHEDULE_TARGET_KINDS)[number]

export const SCHEDULE_EXECUTION_MODES = ["collect", "run_only"] as const
export type ScheduleExecutionMode = (typeof SCHEDULE_EXECUTION_MODES)[number]

export const SCHEDULE_CONCURRENCY_POLICIES = ["skip", "queue", "replace"] as const
export type ScheduleConcurrencyPolicy = (typeof SCHEDULE_CONCURRENCY_POLICIES)[number]

export const SCHEDULE_RUN_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number]

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
  mr_url: string | null
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

export interface InboxItem {
  id: string
  source: string
  kind: string
  payload: string
  severity: InboxSeverity
  status: InboxStatus
  consumed_by: string | null
  created_at: string
}

export interface Schedule {
  id: string
  name: string
  trigger_kind: ScheduleTriggerKind
  cron_expr: string | null
  timezone: string
  target_kind: ScheduleTargetKind
  target_ref: string
  execution_mode: ScheduleExecutionMode
  concurrency_policy: ScheduleConcurrencyPolicy
  next_run_at: string | null
  last_run_at: string | null
  enabled: number
  created_at: string
}

export interface ScheduleRun {
  id: string
  schedule_id: string
  status: ScheduleRunStatus
  started_at: string | null
  finished_at: string | null
  produced_inbox_item_id: string | null
  error: string | null
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

// src/db/dao.ts
import type { Database, SQLQueryBindings } from "bun:sqlite"
import type {
  Asset,
  AssetKind,
  Comment,
  CommentAuthorKind,
  Dag,
  EventLogRow,
  InboxItem,
  InboxSeverity,
  InboxStatus,
  Role,
  RoleKind,
  Schedule,
  ScheduleConcurrencyPolicy,
  ScheduleExecutionMode,
  ScheduleRun,
  ScheduleRunStatus,
  ScheduleTargetKind,
  ScheduleTriggerKind,
  Task,
  TaskStatus,
} from "../types"

type Clock = () => string
type IdGen = () => string

export interface CreateRoleInput {
  name: string
  kind: RoleKind
  instructions?: string
  vendor?: string | null
  model?: string | null
}
export interface CreateTaskInput {
  title: string
  body?: string
  role_id?: string | null
  priority?: number
  parent_task_id?: string | null
  dag_id?: string | null
  repo?: string | null
  source_kind?: Task["source_kind"]
  source_ref?: string | null
  status?: TaskStatus
}
export interface CreateInboxItemInput {
  source: string
  kind: string
  payload?: string
  severity?: InboxSeverity
}
export interface CreateScheduleInput {
  name: string
  trigger_kind: ScheduleTriggerKind
  cron_expr?: string | null
  timezone?: string
  target_kind: ScheduleTargetKind
  target_ref: string
  execution_mode?: ScheduleExecutionMode
  concurrency_policy?: ScheduleConcurrencyPolicy
  next_run_at?: string | null
}

export interface CreateAssetInput {
  kind: AssetKind
  name: string
  version?: string
  spec?: string
  path?: string | null
}

export interface CreateCommentInput {
  task_id: string
  author_kind: CommentAuthorKind
  author_id?: string | null
  body: string
}

export class Dao {
  constructor(
    private db: Database,
    private now: Clock,
    private id: IdGen,
  ) {}

  // ---- role ----
  createRole(i: CreateRoleInput): Role {
    const id = this.id()
    const ts = this.now()
    this.db
      .query(
        `INSERT INTO role (id,name,kind,instructions,vendor,model,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'active', ?, ?)`,
      )
      .run(id, i.name, i.kind, i.instructions ?? "", i.vendor ?? null, i.model ?? null, ts, ts)
    return this.getRole(id)!
  }
  getRole(id: string): Role | undefined {
    return this.db.query("SELECT * FROM role WHERE id=?").get(id) as Role | undefined
  }
  listRoles(): Role[] {
    return this.db.query("SELECT * FROM role ORDER BY created_at").all() as Role[]
  }

  // ---- task ----
  createTask(i: CreateTaskInput): Task {
    const id = this.id()
    const ts = this.now()
    this.db
      .query(
        `INSERT INTO task (id,title,body,role_id,status,priority,parent_task_id,dag_id,
         repo,source_kind,source_ref,retry_count,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      )
      .run(
        id,
        i.title,
        i.body ?? "",
        i.role_id ?? null,
        i.status ?? "pending",
        i.priority ?? 0,
        i.parent_task_id ?? null,
        i.dag_id ?? null,
        i.repo ?? null,
        i.source_kind ?? "manual",
        i.source_ref ?? null,
        ts,
        ts,
      )
    return this.getTask(id)!
  }
  getTask(id: string): Task | undefined {
    return this.db.query("SELECT * FROM task WHERE id=?").get(id) as Task | undefined
  }
  listTasks(f: { status?: TaskStatus; role_id?: string; dag_id?: string } = {}): Task[] {
    const where: string[] = []
    const args: SQLQueryBindings[] = []
    if (f.status) {
      where.push("status=?")
      args.push(f.status)
    }
    if (f.role_id) {
      where.push("role_id=?")
      args.push(f.role_id)
    }
    if (f.dag_id) {
      where.push("dag_id=?")
      args.push(f.dag_id)
    }
    const sql = `SELECT * FROM task ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY priority DESC, created_at ASC`
    return this.db.query(sql).all(...args) as Task[]
  }
  updateTask(id: string, patch: Partial<Omit<Task, "id" | "created_at">>): Task {
    const cols = Object.keys(patch)
    if (cols.length === 0) return this.getTask(id)!
    const set = cols.map((c) => `${c}=?`).join(", ")
    const args = cols.map((c) => (patch as Record<string, unknown>)[c]) as SQLQueryBindings[]
    this.db.query(`UPDATE task SET ${set}, updated_at=? WHERE id=?`).run(...args, this.now(), id)
    return this.getTask(id)!
  }

  // ---- dag + edges ----
  createDagRow(i: { title?: string; source_inbox_item_id?: string | null; orchestrator_role_id?: string | null }): Dag {
    const id = this.id()
    const ts = this.now()
    this.db
      .query(
        `INSERT INTO dag (id,title,source_inbox_item_id,orchestrator_role_id,status,created_at,updated_at)
       VALUES (?,?,?,?, 'open', ?, ?)`,
      )
      .run(id, i.title ?? "", i.source_inbox_item_id ?? null, i.orchestrator_role_id ?? null, ts, ts)
    return this.db.query("SELECT * FROM dag WHERE id=?").get(id) as Dag
  }
  addEdge(dagId: string, from: string, to: string): void {
    this.db
      .query(`INSERT INTO dag_edge (dag_id,from_task_id,to_task_id,type) VALUES (?,?,?, 'depends_on')`)
      .run(dagId, from, to)
  }
  predecessorsOf(taskId: string): string[] {
    return (
      this.db.query("SELECT from_task_id FROM dag_edge WHERE to_task_id=?").all(taskId) as { from_task_id: string }[]
    ).map((r) => r.from_task_id)
  }
  successorsOf(taskId: string): string[] {
    return (
      this.db.query("SELECT to_task_id FROM dag_edge WHERE from_task_id=?").all(taskId) as { to_task_id: string }[]
    ).map((r) => r.to_task_id)
  }
  setDagStatus(dagId: string, status: Dag["status"]): void {
    this.db.query("UPDATE dag SET status=?, updated_at=? WHERE id=?").run(status, this.now(), dagId)
  }

  // ---- inbox_item ----
  createInboxItem(i: CreateInboxItemInput): InboxItem {
    const id = this.id()
    this.db
      .query(
        `INSERT INTO inbox_item (id,source,kind,payload,severity,status,created_at)
       VALUES (?,?,?,?,?, 'new', ?)`,
      )
      .run(id, i.source, i.kind, i.payload ?? "{}", i.severity ?? "info", this.now())
    return this.getInboxItem(id)!
  }
  getInboxItem(id: string): InboxItem | undefined {
    return this.db.query("SELECT * FROM inbox_item WHERE id=?").get(id) as InboxItem | undefined
  }
  listInboxItems(f: { status?: InboxStatus } = {}): InboxItem[] {
    if (f.status) {
      return this.db
        .query("SELECT * FROM inbox_item WHERE status=? ORDER BY created_at ASC")
        .all(f.status) as InboxItem[]
    }
    return this.db.query("SELECT * FROM inbox_item ORDER BY created_at ASC").all() as InboxItem[]
  }
  // Atomic claim: pick the oldest 'new' item and mark it 'claimed'. Mirrors the
  // task-claim UPDATE ... RETURNING pattern; relies on the single-writer invariant.
  claimInboxItem(consumer: string): InboxItem | null {
    const row = this.db
      .query(
        `UPDATE inbox_item SET status='claimed', consumed_by=?
         WHERE id = (
           SELECT id FROM inbox_item WHERE status='new' ORDER BY created_at ASC LIMIT 1)
       RETURNING *`,
      )
      .get(consumer) as InboxItem | undefined
    return row ?? null
  }
  markInboxItem(id: string, status: InboxStatus): InboxItem {
    this.db.query("UPDATE inbox_item SET status=? WHERE id=?").run(status, id)
    return this.getInboxItem(id)!
  }

  // ---- schedule ----
  createSchedule(i: CreateScheduleInput): Schedule {
    const id = this.id()
    this.db
      .query(
        `INSERT INTO schedule (id,name,trigger_kind,cron_expr,timezone,target_kind,target_ref,
         execution_mode,concurrency_policy,next_run_at,enabled,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 1, ?)`,
      )
      .run(
        id,
        i.name,
        i.trigger_kind,
        i.cron_expr ?? null,
        i.timezone ?? "UTC",
        i.target_kind,
        i.target_ref,
        i.execution_mode ?? "collect",
        i.concurrency_policy ?? "skip",
        i.next_run_at ?? null,
        this.now(),
      )
    return this.getSchedule(id)!
  }
  getSchedule(id: string): Schedule | undefined {
    return this.db.query("SELECT * FROM schedule WHERE id=?").get(id) as Schedule | undefined
  }
  listSchedules(f: { enabled?: boolean } = {}): Schedule[] {
    if (f.enabled !== undefined) {
      return this.db
        .query("SELECT * FROM schedule WHERE enabled=? ORDER BY created_at ASC")
        .all(f.enabled ? 1 : 0) as Schedule[]
    }
    return this.db.query("SELECT * FROM schedule ORDER BY created_at ASC").all() as Schedule[]
  }
  updateSchedule(id: string, patch: Partial<Omit<Schedule, "id" | "created_at">>): Schedule {
    const cols = Object.keys(patch)
    if (cols.length === 0) return this.getSchedule(id)!
    const set = cols.map((c) => `${c}=?`).join(", ")
    const args = cols.map((c) => (patch as Record<string, unknown>)[c]) as SQLQueryBindings[]
    this.db.query(`UPDATE schedule SET ${set} WHERE id=?`).run(...args, id)
    return this.getSchedule(id)!
  }
  setScheduleEnabled(id: string, enabled: boolean): Schedule {
    this.db.query("UPDATE schedule SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id)
    return this.getSchedule(id)!
  }
  dueSchedules(nowIso: string): Schedule[] {
    return this.db
      .query(
        `SELECT * FROM schedule
          WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC`,
      )
      .all(nowIso) as Schedule[]
  }

  // ---- schedule_run ----
  createScheduleRun(i: { schedule_id: string; status: ScheduleRunStatus }): ScheduleRun {
    const id = this.id()
    const startedAt = i.status === "pending" ? null : this.now()
    this.db
      .query("INSERT INTO schedule_run (id,schedule_id,status,started_at) VALUES (?,?,?,?)")
      .run(id, i.schedule_id, i.status, startedAt)
    return this.getScheduleRun(id)!
  }
  getScheduleRun(id: string): ScheduleRun | undefined {
    return this.db.query("SELECT * FROM schedule_run WHERE id=?").get(id) as ScheduleRun | undefined
  }
  finishScheduleRun(
    id: string,
    r: { status: ScheduleRunStatus; produced_inbox_item_id?: string | null; error?: string | null },
  ): ScheduleRun {
    this.db
      .query("UPDATE schedule_run SET status=?, finished_at=?, produced_inbox_item_id=?, error=? WHERE id=?")
      .run(r.status, this.now(), r.produced_inbox_item_id ?? null, r.error ?? null, id)
    return this.getScheduleRun(id)!
  }
  activeRunCountForSchedule(scheduleId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS c FROM schedule_run WHERE schedule_id=? AND status IN ('pending','running')")
      .get(scheduleId) as { c: number }
    return row.c
  }

  // ---- asset + role_asset ----
  createAsset(i: CreateAssetInput): Asset {
    const id = this.id()
    this.db
      .query("INSERT INTO asset (id,kind,name,version,spec,path,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, i.kind, i.name, i.version ?? "0.1.0", i.spec ?? "{}", i.path ?? null, this.now())
    return this.getAsset(id)!
  }
  getAsset(id: string): Asset | undefined {
    return this.db.query("SELECT * FROM asset WHERE id=?").get(id) as Asset | undefined
  }
  listAssets(f: { kind?: AssetKind } = {}): Asset[] {
    if (f.kind) {
      return this.db.query("SELECT * FROM asset WHERE kind=? ORDER BY created_at ASC").all(f.kind) as Asset[]
    }
    return this.db.query("SELECT * FROM asset ORDER BY created_at ASC").all() as Asset[]
  }
  // Idempotent: re-attaching the same (role,asset) pair is a no-op (PK conflict ignored).
  attachAsset(roleId: string, assetId: string): void {
    this.db.query("INSERT OR IGNORE INTO role_asset (role_id,asset_id) VALUES (?,?)").run(roleId, assetId)
  }
  detachAsset(roleId: string, assetId: string): void {
    this.db.query("DELETE FROM role_asset WHERE role_id=? AND asset_id=?").run(roleId, assetId)
  }
  assetsForRole(roleId: string): Asset[] {
    return this.db
      .query(
        `SELECT a.* FROM asset a
           JOIN role_asset ra ON ra.asset_id = a.id
          WHERE ra.role_id = ?
          ORDER BY a.created_at ASC`,
      )
      .all(roleId) as Asset[]
  }

  // ---- comment ----
  addComment(i: CreateCommentInput): Comment {
    const id = this.id()
    this.db
      .query("INSERT INTO comment (id,task_id,author_kind,author_id,body,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, i.task_id, i.author_kind, i.author_id ?? null, i.body, this.now())
    return this.db.query("SELECT * FROM comment WHERE id=?").get(id) as Comment
  }
  listComments(taskId: string): Comment[] {
    return this.db
      .query("SELECT * FROM comment WHERE task_id=? ORDER BY created_at ASC, id ASC")
      .all(taskId) as Comment[]
  }

  // ---- event log ----
  logEvent(e: Omit<EventLogRow, "id" | "ts">): void {
    this.db
      .query(
        `INSERT INTO event_log (id,actor_kind,actor_id,action,target_kind,target_id,details,ts)
       VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        this.id(),
        e.actor_kind,
        e.actor_id ?? null,
        e.action,
        e.target_kind,
        e.target_id ?? null,
        e.details,
        this.now(),
      )
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }
  raw(): Database {
    return this.db
  }
}

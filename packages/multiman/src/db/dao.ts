// src/db/dao.ts
import type { Database, SQLQueryBindings } from "bun:sqlite"
import type { Role, RoleKind, Task, TaskStatus, Dag, EventLogRow } from "@/types"

type Clock = () => string
type IdGen = () => string

export interface CreateRoleInput {
  name: string; kind: RoleKind; instructions?: string; vendor?: string | null; model?: string | null
}
export interface CreateTaskInput {
  title: string; body?: string; role_id?: string | null; priority?: number
  parent_task_id?: string | null; dag_id?: string | null; repo?: string | null
  source_kind?: Task["source_kind"]; source_ref?: string | null; status?: TaskStatus
}

export class Dao {
  constructor(private db: Database, private now: Clock, private id: IdGen) {}

  // ---- role ----
  createRole(i: CreateRoleInput): Role {
    const id = this.id(), ts = this.now()
    this.db.query(
      `INSERT INTO role (id,name,kind,instructions,vendor,model,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'active', ?, ?)`
    ).run(id, i.name, i.kind, i.instructions ?? "", i.vendor ?? null, i.model ?? null, ts, ts)
    return this.getRole(id)!
  }
  getRole(id: string): Role | undefined {
    return this.db.query("SELECT * FROM role WHERE id=?").get(id) as Role | undefined
  }
  listRoles(): Role[] { return this.db.query("SELECT * FROM role ORDER BY created_at").all() as Role[] }

  // ---- task ----
  createTask(i: CreateTaskInput): Task {
    const id = this.id(), ts = this.now()
    this.db.query(
      `INSERT INTO task (id,title,body,role_id,status,priority,parent_task_id,dag_id,
         repo,source_kind,source_ref,retry_count,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`
    ).run(
      id, i.title, i.body ?? "", i.role_id ?? null, i.status ?? "pending", i.priority ?? 0,
      i.parent_task_id ?? null, i.dag_id ?? null, i.repo ?? null,
      i.source_kind ?? "manual", i.source_ref ?? null, ts, ts,
    )
    return this.getTask(id)!
  }
  getTask(id: string): Task | undefined {
    return this.db.query("SELECT * FROM task WHERE id=?").get(id) as Task | undefined
  }
  listTasks(f: { status?: TaskStatus; role_id?: string; dag_id?: string } = {}): Task[] {
    const where: string[] = [], args: SQLQueryBindings[] = []
    if (f.status) { where.push("status=?"); args.push(f.status) }
    if (f.role_id) { where.push("role_id=?"); args.push(f.role_id) }
    if (f.dag_id) { where.push("dag_id=?"); args.push(f.dag_id) }
    const sql = `SELECT * FROM task ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY priority DESC, created_at ASC`
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
    const id = this.id(), ts = this.now()
    this.db.query(
      `INSERT INTO dag (id,title,source_inbox_item_id,orchestrator_role_id,status,created_at,updated_at)
       VALUES (?,?,?,?, 'open', ?, ?)`
    ).run(id, i.title ?? "", i.source_inbox_item_id ?? null, i.orchestrator_role_id ?? null, ts, ts)
    return this.db.query("SELECT * FROM dag WHERE id=?").get(id) as Dag
  }
  addEdge(dagId: string, from: string, to: string): void {
    this.db.query(
      `INSERT INTO dag_edge (dag_id,from_task_id,to_task_id,type) VALUES (?,?,?, 'depends_on')`
    ).run(dagId, from, to)
  }
  predecessorsOf(taskId: string): string[] {
    return (this.db.query("SELECT from_task_id FROM dag_edge WHERE to_task_id=?").all(taskId) as { from_task_id: string }[])
      .map((r) => r.from_task_id)
  }
  successorsOf(taskId: string): string[] {
    return (this.db.query("SELECT to_task_id FROM dag_edge WHERE from_task_id=?").all(taskId) as { to_task_id: string }[])
      .map((r) => r.to_task_id)
  }
  setDagStatus(dagId: string, status: Dag["status"]): void {
    this.db.query("UPDATE dag SET status=?, updated_at=? WHERE id=?").run(status, this.now(), dagId)
  }

  // ---- event log ----
  logEvent(e: Omit<EventLogRow, "id" | "ts">): void {
    this.db.query(
      `INSERT INTO event_log (id,actor_kind,actor_id,action,target_kind,target_id,details,ts)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(this.id(), e.actor_kind, e.actor_id ?? null, e.action, e.target_kind, e.target_id ?? null, e.details, this.now())
  }

  transaction<T>(fn: () => T): T { return this.db.transaction(fn)() }
  raw(): Database { return this.db }
}

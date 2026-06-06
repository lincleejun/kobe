# multiman Subsystem 0 — Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build multiman's data layer + coordination kernel + IPC API as a new package inside the kobe fork, so a CLI can create roles/tasks, transition them through a state machine, atomically claim them (pull model), materialize a real kobe worktree on `running`, gate a task DAG, and reclaim dead leases — all persisted in `bun:sqlite` and reachable through the kobe daemon socket.

**Architecture:** New package `packages/multiman` (single package, internal layered modules `types ◄ db ◄ kernel ◄ rpc ◄ client`). The kobe daemon owns a single `MultimanKernel` instance (sole DB writer); runners/CLI/TUI reach it only through one new RPC request name `"multiman"` (a `{method, params}` envelope) over the existing unix socket. State is `~/.kobe/multiman.db`.

**Tech Stack:** Bun ≥1.3, TypeScript, `bun:sqlite` (zero new deps), vitest, biome. Reuses kobe's `orchestrator.adoptWorktree/ensureWorktree`, `daemon/server.ts` worker pattern, `DaemonEventBus`, and ulid util.

**Source spec:** `docs/specs/2026-06-05-multiman-s0-kernel-design.md` (+ roadmap). All decisions (D1, Finding 1/2, codex #1–#4b) are locked there.

---

## File Structure

```
packages/multiman/
├── package.json              # @sma1lboy/multiman, type:module, exports, test scripts
├── tsconfig.json             # extends @tsconfig/bun, @/* path alias
├── vitest.config.ts
├── src/
│   ├── index.ts              # public exports (MultimanKernel, types)
│   ├── types.ts              # enum const arrays + row interfaces (zero heavy deps)
│   ├── ids.ts                # ulid() — re-export kobe util
│   ├── errors.ts             # InvalidTransitionError, CyclicDagError, GuardError
│   ├── db/
│   │   ├── open.ts           # openDb(path): Database  (WAL, FK, busy_timeout)
│   │   ├── migrate.ts        # runMigrations(db) via PRAGMA user_version
│   │   ├── migrations/001_init.sql
│   │   └── dao.ts            # typed CRUD: task/role/dag/dag_edge/event_log (S0 scope)
│   ├── state-machine.ts      # TRANSITIONS table + canTransition/assertTransition
│   ├── kernel.ts             # MultimanKernel (composes dao + sm + kobe orchestrator)
│   ├── dag.ts                # cycle detection + gating helpers (pure)
│   ├── sweeper.ts            # startSweeper(kernel, opts)
│   ├── rpc.ts                # handle(method, params) router + validation
│   └── client/index.ts       # thin wrapper over KobeDaemonClient.request("multiman", …)
└── test/
    ├── db.test.ts
    ├── dao.test.ts
    ├── enum-sync.test.ts
    ├── state-machine.test.ts
    ├── dag.test.ts
    ├── kernel.test.ts
    ├── rpc.test.ts
    └── daemon.socket.test.ts   # gated by KOBE_INCLUDE_SOCKET=1

Modified in packages/kobe:
    package.json                # + "@sma1lboy/multiman": "workspace:*"
    src/daemon/protocol.ts      # + "multiman" request name; + "multiman" channel
    src/daemon/server.ts        # dispatch case + kernel construct + sweeper + lifetime keepalive
    src/cli/index.ts            # register `multiman` subcommand
```

---

## Phase 1 — Package skeleton

### Task 1: Create the `packages/multiman` package

**Files:**
- Create: `packages/multiman/package.json`
- Create: `packages/multiman/tsconfig.json`
- Create: `packages/multiman/vitest.config.ts`
- Create: `packages/multiman/src/index.ts`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@sma1lboy/multiman",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./client": "./src/client/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests",
    "lint": "biome check ."
  },
  "dependencies": {
    "@sma1lboy/kobe": "workspace:*"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "extends": "@tsconfig/bun/tsconfig.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write vitest.config.ts**

```ts
import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: { alias: { "@": resolve(__dirname, "src") } },
})
```

- [ ] **Step 4: Write a placeholder src/index.ts**

```ts
export const MULTIMAN_PACKAGE = "@sma1lboy/multiman"
```

- [ ] **Step 5: Verify workspace picks it up**

Run: `bun install`
Expected: completes; `packages/multiman` linked. Then `cd packages/multiman && bun run typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/multiman/package.json packages/multiman/tsconfig.json packages/multiman/vitest.config.ts packages/multiman/src/index.ts bun.lock
git commit -m "feat(multiman): scaffold @sma1lboy/multiman package"
```

---

## Phase 2 — Types + enums (single source of truth)

### Task 2: Define enum arrays and row types

**Files:**
- Create: `packages/multiman/src/types.ts`
- Test: `packages/multiman/test/enum-sync.test.ts` (added in Task 5 once schema exists)

- [ ] **Step 1: Write types.ts (enums as const arrays — Finding 2)**

```ts
// Enum single source of truth. SQL CHECK constraints in 001_init.sql must match
// these arrays exactly; enum-sync.test.ts asserts that (Finding 2).
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
```

- [ ] **Step 2: Write ids.ts and errors.ts**

`packages/multiman/src/ids.ts`:
```ts
import { ulid } from "@sma1lboy/kobe/orchestrator/ulid"
// NOTE: confirm the real export path during impl (grep kobe for ulid). If kobe
// does not expose it, copy its tiny ulid impl here instead of adding a dep.
export function genId(): string {
  return ulid()
}
```

`packages/multiman/src/errors.ts`:
```ts
export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`invalid task transition: ${from} -> ${to}`)
    this.name = "InvalidTransitionError"
  }
}
export class CyclicDagError extends Error {
  constructor() { super("dag contains a cycle"); this.name = "CyclicDagError" }
}
export class GuardError extends Error {
  constructor(msg: string) { super(msg); this.name = "GuardError" }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/multiman && bun run typecheck`
Expected: PASS (ids.ts ulid import may need path fix — resolve before continuing).

- [ ] **Step 4: Commit**

```bash
git add packages/multiman/src/types.ts packages/multiman/src/ids.ts packages/multiman/src/errors.ts
git commit -m "feat(multiman): enum const arrays, row types, ids, errors"
```

---

## Phase 3 — DB layer

### Task 3: SQLite open + PRAGMAs

**Files:**
- Create: `packages/multiman/src/db/open.ts`
- Test: `packages/multiman/test/db.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/db.test.ts
import { describe, it, expect } from "bun:test"
import { openDb } from "@/db/open"

describe("openDb", () => {
  it("enables WAL and foreign_keys", () => {
    const db = openDb(":memory:")
    const journal = db.query("PRAGMA journal_mode").get() as { journal_mode: string }
    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    // :memory: cannot use WAL; open.ts must request WAL but tolerate memory fallback.
    expect(["wal", "memory"]).toContain(journal.journal_mode)
    expect(fk.foreign_keys).toBe(1)
    db.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/multiman && bun test test/db.test.ts`
Expected: FAIL — cannot resolve `@/db/open`.

- [ ] **Step 3: Implement open.ts**

```ts
// src/db/open.ts
import { Database } from "bun:sqlite"

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA busy_timeout = 5000")
  return db
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/multiman && bun test test/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/db/open.ts packages/multiman/test/db.test.ts
git commit -m "feat(multiman): db open with WAL + foreign_keys"
```

### Task 4: Migration runner + 001_init.sql

**Files:**
- Create: `packages/multiman/src/db/migrate.ts`
- Create: `packages/multiman/src/db/migrations/001_init.sql`
- Test: extend `packages/multiman/test/db.test.ts`

- [ ] **Step 1: Write 001_init.sql**

Copy the full DDL from the spec §3.3 verbatim (all 10 tables: `role`, `dag`, `task` with
`last_heartbeat_at`/`retry_count`, `dag_edge`, `inbox_item`, `schedule`, `schedule_run`,
`asset`, `role_asset`, `event_log`, plus all indexes incl. `idx_task_claim`). The CHECK
enum value lists must match the `*_STATUSES`/`*_KINDS` arrays in types.ts exactly.

- [ ] **Step 2: Write the failing migration test**

```ts
// append to test/db.test.ts
import { runMigrations } from "@/db/migrate"

describe("runMigrations", () => {
  it("applies 001 to an empty db and sets user_version=1", () => {
    const db = openDb(":memory:")
    runMigrations(db)
    const v = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(v.user_version).toBe(1)
    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain("task")
    expect(names).toContain("role")
    expect(names).toContain("event_log")
    db.close()
  })

  it("is idempotent — second run is a no-op", () => {
    const db = openDb(":memory:")
    runMigrations(db)
    runMigrations(db) // must not throw "table already exists"
    const v = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(v.user_version).toBe(1)
    db.close()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/multiman && bun test test/db.test.ts`
Expected: FAIL — cannot resolve `@/db/migrate`.

- [ ] **Step 4: Implement migrate.ts**

```ts
// src/db/migrate.ts
import type { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))

interface Migration { version: number; file: string }
const MIGRATIONS: Migration[] = [{ version: 1, file: "001_init.sql" }]

export function runMigrations(db: Database): void {
  const cur = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
  for (const m of MIGRATIONS) {
    if (m.version <= cur) continue
    const sql = readFileSync(join(HERE, "migrations", m.file), "utf8")
    const tx = db.transaction(() => {
      db.run(sql)
      db.run(`PRAGMA user_version = ${m.version}`)
    })
    tx()
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/multiman && bun test test/db.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add packages/multiman/src/db/migrate.ts packages/multiman/src/db/migrations/001_init.sql packages/multiman/test/db.test.ts
git commit -m "feat(multiman): migration runner + 001_init schema"
```

### Task 5: enum-sync test (Finding 2)

**Files:**
- Test: `packages/multiman/test/enum-sync.test.ts`

- [ ] **Step 1: Write the test**

```ts
// test/enum-sync.test.ts
import { describe, it, expect } from "bun:test"
import { openDb } from "@/db/open"
import { runMigrations } from "@/db/migrate"
import { TASK_STATUSES, ROLE_KINDS, ROLE_STATUSES, DAG_STATUSES, TASK_SOURCE_KINDS } from "@/types"

// Extract the IN (...) value list for a column's CHECK from the table DDL.
function checkValues(ddl: string, column: string): string[] {
  const re = new RegExp(`${column}[\\s\\S]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "i")
  const m = ddl.match(re)
  if (!m) throw new Error(`no CHECK found for ${column}`)
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort()
}

describe("enum sync: TS arrays match SQL CHECK", () => {
  const db = openDb(":memory:")
  runMigrations(db)
  const taskDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='task'").get() as { sql: string }).sql
  const roleDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='role'").get() as { sql: string }).sql
  const dagDdl = (db.query("SELECT sql FROM sqlite_master WHERE name='dag'").get() as { sql: string }).sql

  it("task.status", () => expect(checkValues(taskDdl, "status")).toEqual([...TASK_STATUSES].sort()))
  it("task.source_kind", () => expect(checkValues(taskDdl, "source_kind")).toEqual([...TASK_SOURCE_KINDS].sort()))
  it("role.kind", () => expect(checkValues(roleDdl, "kind")).toEqual([...ROLE_KINDS].sort()))
  it("role.status", () => expect(checkValues(roleDdl, "status")).toEqual([...ROLE_STATUSES].sort()))
  it("dag.status", () => expect(checkValues(dagDdl, "status")).toEqual([...DAG_STATUSES].sort()))
})
```

- [ ] **Step 2: Run — verify it passes (or catches a real drift)**

Run: `cd packages/multiman && bun test test/enum-sync.test.ts`
Expected: PASS. If it fails, the 001_init.sql CHECK lists drifted from types.ts — fix the SQL.

- [ ] **Step 3: Commit**

```bash
git add packages/multiman/test/enum-sync.test.ts
git commit -m "test(multiman): enum sync between TS arrays and SQL CHECK"
```

### Task 6: Typed DAO (task/role/dag/dag_edge/event_log)

**Files:**
- Create: `packages/multiman/src/db/dao.ts`
- Test: `packages/multiman/test/dao.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/dao.test.ts
import { describe, it, expect } from "bun:test"
import { openDb } from "@/db/open"
import { runMigrations } from "@/db/migrate"
import { Dao } from "@/db/dao"

function freshDao() {
  const db = openDb(":memory:")
  runMigrations(db)
  return new Dao(db, () => "2026-06-05T00:00:00.000Z", (() => { let n = 0; return () => `id-${++n}` })())
}

describe("Dao role + task CRUD", () => {
  it("creates and reads a role", () => {
    const dao = freshDao()
    const r = dao.createRole({ name: "backend", kind: "worker" })
    expect(r.id).toBe("id-1")
    expect(dao.getRole(r.id)?.name).toBe("backend")
    expect(dao.listRoles().length).toBe(1)
  })

  it("rejects an invalid enum via CHECK", () => {
    const dao = freshDao()
    // @ts-expect-error intentional bad kind
    expect(() => dao.createRole({ name: "x", kind: "bogus" })).toThrow()
  })

  it("creates a task defaulting to pending, then updates it", () => {
    const dao = freshDao()
    const t = dao.createTask({ title: "do X" })
    expect(t.status).toBe("pending")
    const u = dao.updateTask(t.id, { status: "assigned", role_id: null })
    expect(u.status).toBe("assigned")
  })

  it("enforces foreign keys (task.role_id -> role.id)", () => {
    const dao = freshDao()
    expect(() => dao.createTask({ title: "x", role_id: "nope" })).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/dao.test.ts`
Expected: FAIL — cannot resolve `@/db/dao`.

- [ ] **Step 3: Implement dao.ts**

```ts
// src/db/dao.ts
import type { Database } from "bun:sqlite"
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
    const where: string[] = [], args: unknown[] = []
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
    const args = cols.map((c) => (patch as Record<string, unknown>)[c])
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/dao.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/db/dao.ts packages/multiman/test/dao.test.ts
git commit -m "feat(multiman): typed DAO for task/role/dag/event"
```

---

## Phase 4 — State machine (pure)

### Task 7: Transition table + guards

**Files:**
- Create: `packages/multiman/src/state-machine.ts`
- Test: `packages/multiman/test/state-machine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/state-machine.test.ts
import { describe, it, expect } from "bun:test"
import { canTransition, assertTransition } from "@/state-machine"
import { InvalidTransitionError } from "@/errors"

describe("state machine", () => {
  it("allows the core happy path", () => {
    expect(canTransition("pending", "assigned")).toBe(true)
    expect(canTransition("assigned", "claimed")).toBe(true)
    expect(canTransition("claimed", "running")).toBe(true)
    expect(canTransition("running", "in_review")).toBe(true)
    expect(canTransition("in_review", "done")).toBe(true)
  })
  it("allows blocked gating and lease recovery edges", () => {
    expect(canTransition("blocked", "pending")).toBe(true)
    expect(canTransition("claimed", "assigned")).toBe(true) // claim timeout
    expect(canTransition("running", "assigned")).toBe(true) // lease expiry re-dispatch
  })
  it("forbids done<->failed flip and exits from terminal", () => {
    expect(canTransition("done", "failed")).toBe(false)
    expect(canTransition("failed", "done")).toBe(false)
    expect(canTransition("done", "running")).toBe(false)
    expect(canTransition("cancelled", "pending")).toBe(false)
  })
  it("allows failed->pending retry and any-nonterminal->cancelled", () => {
    expect(canTransition("failed", "pending")).toBe(true)
    expect(canTransition("running", "cancelled")).toBe(true)
    expect(canTransition("pending", "cancelled")).toBe(true)
  })
  it("assertTransition throws on illegal", () => {
    expect(() => assertTransition("done", "failed")).toThrow(InvalidTransitionError)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/state-machine.test.ts`
Expected: FAIL — cannot resolve `@/state-machine`.

- [ ] **Step 3: Implement state-machine.ts**

```ts
// src/state-machine.ts
import type { TaskStatus } from "@/types"
import { TERMINAL_STATUSES } from "@/types"
import { InvalidTransitionError } from "@/errors"

// Shape-legality only. DB-dependent guards (role active, deps satisfied, claim
// uniqueness) live in kernel.ts. This file stays pure for exhaustive unit tests.
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "blocked", "cancelled"],
  assigned: ["claimed", "pending", "cancelled"],
  blocked: ["pending", "assigned", "cancelled"],
  claimed: ["running", "assigned", "cancelled"],
  running: ["in_review", "done", "failed", "blocked", "assigned", "cancelled"],
  in_review: ["done", "failed", "assigned", "cancelled"],
  done: [],
  failed: ["pending", "cancelled"],
  cancelled: [],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (TERMINAL_STATUSES.has(from)) return false
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/state-machine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/state-machine.ts packages/multiman/test/state-machine.test.ts
git commit -m "feat(multiman): task state machine (pure)"
```

---

## Phase 5 — DAG cycle detection (pure)

### Task 8: Cycle check helper

**Files:**
- Create: `packages/multiman/src/dag.ts`
- Test: `packages/multiman/test/dag.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/dag.test.ts
import { describe, it, expect } from "bun:test"
import { hasCycle } from "@/dag"

describe("hasCycle", () => {
  it("false for a DAG", () => {
    expect(hasCycle(["a", "b", "c"], [["a", "b"], ["b", "c"]])).toBe(false)
  })
  it("true for a 2-node cycle", () => {
    expect(hasCycle(["a", "b"], [["a", "b"], ["b", "a"]])).toBe(true)
  })
  it("true for a 3-node cycle", () => {
    expect(hasCycle(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]])).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/dag.test.ts`
Expected: FAIL — cannot resolve `@/dag`.

- [ ] **Step 3: Implement dag.ts (Kahn topological sort)**

```ts
// src/dag.ts
// Edge [from, to] means "to depends_on from" (from must finish first).
export function hasCycle(nodes: string[], edges: [string, string][]): boolean {
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]))
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]))
  for (const [from, to] of edges) {
    adj.get(from)!.push(to)
    indeg.set(to, (indeg.get(to) ?? 0) + 1)
  }
  const queue = nodes.filter((n) => (indeg.get(n) ?? 0) === 0)
  let visited = 0
  while (queue.length) {
    const n = queue.shift()!
    visited++
    for (const m of adj.get(n) ?? []) {
      indeg.set(m, indeg.get(m)! - 1)
      if (indeg.get(m) === 0) queue.push(m)
    }
  }
  return visited !== nodes.length
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/dag.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/dag.ts packages/multiman/test/dag.test.ts
git commit -m "feat(multiman): DAG cycle detection (Kahn)"
```

---

## Phase 6 — Kernel

The kernel composes DAO + state machine + a `KobeOrchestratorPort` (injected; the real
kobe orchestrator in prod, a fake in tests). Define the port narrowly so tests don't need
real git.

### Task 9: Kernel scaffold + createTask/getTask/listTasks + transition guards

**Files:**
- Create: `packages/multiman/src/kernel.ts`
- Test: `packages/multiman/test/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/kernel.test.ts
import { describe, it, expect } from "bun:test"
import { openDb } from "@/db/open"
import { runMigrations } from "@/db/migrate"
import { Dao } from "@/db/dao"
import { MultimanKernel } from "@/kernel"
import { GuardError, InvalidTransitionError } from "@/errors"

function fakeOrchestrator() {
  const calls: { adopt: number; create: number } = { adopt: 0, create: 0 }
  return {
    calls,
    async adoptWorktree(input: { repo: string; worktreePath: string; branch: string }) {
      calls.adopt++
      return { id: `kobe-${input.branch}`, worktreePath: input.worktreePath }
    },
    async createTask() { calls.create++; throw new Error("createTask must not be used") },
  }
}

function makeKernel(now = () => "2026-06-05T00:00:00.000Z") {
  const db = openDb(":memory:"); runMigrations(db)
  let n = 0
  const dao = new Dao(db, now, () => `id-${++n}`)
  const events: { kind: string; payload: unknown }[] = []
  const orch = fakeOrchestrator()
  const kernel = new MultimanKernel({
    dao, orchestrator: orch, now,
    publish: (kind, payload) => events.push({ kind, payload }),
    recoveryWindowMs: 90_000, leaseWindowMs: 60_000, maxRetry: 2,
  })
  return { kernel, dao, events, orch }
}

describe("kernel basic + guards", () => {
  it("createTask lands pending and emits event", () => {
    const { kernel, events } = makeKernel()
    const t = kernel.createTask({ title: "x" })
    expect(t.status).toBe("pending")
    expect(events.some((e) => e.kind === "task.created")).toBe(true)
  })
  it("assigning to a disabled role throws GuardError", () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    dao.raw().query("UPDATE role SET status='disabled' WHERE id=?").run(role.id)
    const t = kernel.createTask({ title: "x" })
    expect(() => kernel.transition(t.id, "assigned", "assign", { roleId: role.id })).toThrow(GuardError)
  })
  it("illegal shape transition throws", () => {
    const { kernel } = makeKernel()
    const t = kernel.createTask({ title: "x" })
    expect(() => kernel.transition(t.id, "done", "skip")).toThrow(InvalidTransitionError)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: FAIL — cannot resolve `@/kernel`.

- [ ] **Step 3: Implement kernel.ts scaffold (this task: ctor, createTask, getTask, listTasks, transition skeleton with shape + role guard + event)**

```ts
// src/kernel.ts
import type { Dao } from "@/db/dao"
import type { Task, TaskStatus } from "@/types"
import { assertTransition } from "@/state-machine"
import { GuardError } from "@/errors"

export interface KobeOrchestratorPort {
  adoptWorktree(input: {
    repo: string; worktreePath: string; branch: string; ifExists: "return"
  }): Promise<{ id: string; worktreePath: string }>
}

export interface KernelDeps {
  dao: Dao
  orchestrator: KobeOrchestratorPort
  now: () => string
  publish: (kind: string, payload: unknown) => void
  recoveryWindowMs?: number
  leaseWindowMs?: number
  maxRetry?: number
}

export class MultimanKernel {
  private dao: Dao
  private orch: KobeOrchestratorPort
  private now: () => string
  private publish: (kind: string, payload: unknown) => void
  private recoveryWindowMs: number
  private leaseWindowMs: number
  private maxRetry: number

  constructor(d: KernelDeps) {
    this.dao = d.dao
    this.orch = d.orchestrator
    this.now = d.now
    this.publish = d.publish
    this.recoveryWindowMs = d.recoveryWindowMs ?? 90_000
    this.leaseWindowMs = d.leaseWindowMs ?? 60_000
    this.maxRetry = d.maxRetry ?? 2
  }

  // INVARIANT: the kobe daemon is the SOLE writer of multiman.db. claimNextTask
  // atomicity (Task 10) depends on this. Never add a second writer process.

  createTask(i: Parameters<Dao["createTask"]>[0]): Task {
    const t = this.dao.createTask(i)
    this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.create", target_kind: "task", target_id: t.id, details: "{}" })
    this.publish("task.created", t)
    return t
  }
  getTask(id: string): Task | undefined { return this.dao.getTask(id) }
  listTasks(f?: Parameters<Dao["listTasks"]>[0]): Task[] { return this.dao.listTasks(f) }

  transition(id: string, to: TaskStatus, reason: string, opts: { roleId?: string } = {}): Task {
    const t = this.dao.getTask(id)
    if (!t) throw new GuardError(`task not found: ${id}`)
    assertTransition(t.status, to)

    // role guard for assignment
    if (to === "assigned") {
      const roleId = opts.roleId ?? t.role_id
      if (!roleId) throw new GuardError("assign requires a role")
      const role = this.dao.getRole(roleId)
      if (!role || role.status !== "active") throw new GuardError(`role not active: ${roleId}`)
    }

    // (running materialization + DAG gating wired in Tasks 11/12)
    const patch: Partial<Task> = { status: to }
    if (to === "assigned" && opts.roleId) patch.role_id = opts.roleId
    const updated = this.dao.updateTask(id, patch)
    this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.transition", target_kind: "task", target_id: id, details: JSON.stringify({ from: t.status, to, reason }) })
    this.publish("task.transitioned", updated)
    return updated
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/kernel.ts packages/multiman/test/kernel.test.ts
git commit -m "feat(multiman): kernel scaffold + transition guards"
```

### Task 10: claimNextTask (atomic pull)

**Files:**
- Modify: `packages/multiman/src/kernel.ts`
- Test: extend `packages/multiman/test/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to test/kernel.test.ts
describe("claimNextTask", () => {
  it("claims highest priority then oldest, and never double-claims", () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const lo = kernel.createTask({ title: "lo", role_id: role.id, priority: 1 })
    const hi = kernel.createTask({ title: "hi", role_id: role.id, priority: 5 })
    kernel.transition(lo.id, "assigned", "a", { roleId: role.id })
    kernel.transition(hi.id, "assigned", "a", { roleId: role.id })

    const first = kernel.claimNextTask(role.id)
    const second = kernel.claimNextTask(role.id)
    const third = kernel.claimNextTask(role.id)
    expect(first?.id).toBe(hi.id)   // priority wins
    expect(second?.id).toBe(lo.id)
    expect(third).toBeNull()        // nothing left
    expect(first?.status).toBe("claimed")
    expect(first?.claimed_by).toBe(role.id)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: FAIL — `kernel.claimNextTask is not a function`.

- [ ] **Step 3: Implement claimNextTask**

```ts
// add method to MultimanKernel
claimNextTask(roleId: string): Task | null {
  const ts = this.now()
  // Single statement; atomicity relies on the single-writer invariant above.
  // RETURNING needs SQLite >= 3.35 (bun bundles a recent build). If unavailable,
  // fall back to a SELECT-then-UPDATE inside this.dao.transaction().
  const row = this.dao.raw().query(
    `UPDATE task SET status='claimed', claimed_by=?, claimed_at=?, updated_at=?
       WHERE id = (
         SELECT id FROM task
          WHERE status='assigned' AND role_id=?
          ORDER BY priority DESC, created_at ASC LIMIT 1)
     RETURNING *`
  ).get(roleId, ts, ts, roleId) as Task | undefined
  if (!row) return null
  this.dao.logEvent({ actor_kind: "role", actor_id: roleId, action: "task.claim", target_kind: "task", target_id: row.id, details: "{}" })
  this.publish("task.claimed", row)
  return row
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/kernel.ts packages/multiman/test/kernel.test.ts
git commit -m "feat(multiman): atomic claimNextTask (pull model)"
```

### Task 11: materialize (deterministic adopt) + transition(→running) wiring

**Files:**
- Modify: `packages/multiman/src/kernel.ts`
- Test: extend `packages/multiman/test/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to test/kernel.test.ts
describe("materialize (Finding 1 idempotency)", () => {
  it("transition->running adopts (not creates) a deterministic worktree and is idempotent", async () => {
    const { kernel, dao, orch } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)

    const running = await kernel.transition(t.id, "running", "start")
    expect(running.status).toBe("running")
    expect(running.kobe_task_id).toBe(`kobe-multiman/${t.id}`)
    expect(orch.calls.adopt).toBe(1)
    expect(orch.calls.create).toBe(0)

    // simulate crash retry: re-materialize must reuse, not duplicate
    const again = await kernel.materialize(t.id)
    expect(again.kobeTaskId).toBe(`kobe-multiman/${t.id}`)
    expect(orch.calls.adopt).toBe(1) // fast path: already materialized
  })

  it("materialize failure leaves no half-state (task stays claimed)", async () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    // monkeypatch orchestrator to throw
    ;(kernel as any).orch.adoptWorktree = async () => { throw new Error("git boom") }
    await expect(kernel.transition(t.id, "running", "start")).rejects.toThrow("git boom")
    expect(dao.getTask(t.id)?.status).toBe("claimed") // no half-state
  })
})
```

Note: `transition` becomes async (returns `Promise<Task>` when `to === "running"`). Update the
earlier sync tests to `await` transitions, or make `transition` always async and `await`
everywhere. **Decision: make `transition` always `async`** (uniform signature). Update Task 9
tests to `await kernel.transition(...)` and add `await` in claim test setup transitions.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: FAIL — `kernel.materialize` undefined / transition not awaiting.

- [ ] **Step 3: Implement materialize + make transition async with running hook**

```ts
// change signature: async transition(...): Promise<Task>
async transition(id: string, to: TaskStatus, reason: string, opts: { roleId?: string } = {}): Promise<Task> {
  const t = this.dao.getTask(id)
  if (!t) throw new GuardError(`task not found: ${id}`)
  assertTransition(t.status, to)

  if (to === "assigned") {
    const roleId = opts.roleId ?? t.role_id
    if (!roleId) throw new GuardError("assign requires a role")
    const role = this.dao.getRole(roleId)
    if (!role || role.status !== "active") throw new GuardError(`role not active: ${roleId}`)
  }

  // #2 hard materialization: running requires a kobe worktree. Materialize FIRST;
  // if it throws, the transition fails and the task keeps its prior status.
  if (to === "running" && !t.kobe_task_id) {
    await this.materialize(id) // throws -> we never reach the status write below
  }

  const patch: Partial<Task> = { status: to }
  if (to === "assigned" && opts.roleId) patch.role_id = opts.roleId
  if (to === "running") patch.last_heartbeat_at = this.now()
  const updated = this.dao.updateTask(id, patch)
  this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.transition", target_kind: "task", target_id: id, details: JSON.stringify({ from: t.status, to, reason }) })
  this.publish("task.transitioned", updated)

  if (to === "done") this.onTaskDone(id)
  if (to === "failed") this.onTaskFailed(id)
  return updated
}

async materialize(taskId: string): Promise<{ kobeTaskId: string; worktreePath: string }> {
  const t = this.dao.getTask(taskId)
  if (!t) throw new GuardError(`task not found: ${taskId}`)
  if (t.kobe_task_id && t.work_dir) return { kobeTaskId: t.kobe_task_id, worktreePath: t.work_dir }
  if (!t.repo) throw new GuardError(`task ${taskId} has no repo to materialize`)
  const branch = `multiman/${t.id}`
  const worktreePath = `${t.repo}/.claude/worktrees/${t.id}`
  const res = await this.orch.adoptWorktree({ repo: t.repo, worktreePath, branch, ifExists: "return" })
  this.dao.updateTask(taskId, { kobe_task_id: res.id, work_dir: res.worktreePath })
  return { kobeTaskId: res.id, worktreePath: res.worktreePath }
}
```

(`onTaskDone` / `onTaskFailed` are added in Task 12; add empty private stubs now so it compiles:
```ts
private onTaskDone(_id: string): void {}
private onTaskFailed(_id: string): void {}
```)

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: PASS (after updating earlier tests to `await`).

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/kernel.ts packages/multiman/test/kernel.test.ts
git commit -m "feat(multiman): idempotent materialize via deterministic adopt"
```

### Task 12: createDag (cycle check) + gating (onTaskDone/onTaskFailed)

**Files:**
- Modify: `packages/multiman/src/kernel.ts`
- Test: extend `packages/multiman/test/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to test/kernel.test.ts
describe("DAG gating", () => {
  it("createDag rejects a cycle (no tasks created)", () => {
    const { kernel, dao } = makeKernel()
    expect(() => kernel.createDag(
      { title: "g" },
      [{ key: "a", title: "A" }, { key: "b", title: "B" }],
      [["a", "b"], ["b", "a"]],
    )).toThrow("cycle")
    expect(dao.listTasks().length).toBe(0) // transaction rolled back
  })
  it("blocks successors until predecessor done, then unblocks", async () => {
    const { kernel, dao } = makeKernel()
    const dag = kernel.createDag(
      { title: "g" },
      [{ key: "a", title: "A" }, { key: "b", title: "B" }],
      [["a", "b"]],
    )
    const a = dag.tasks["a"], b = dag.tasks["b"]
    expect(dao.getTask(a)?.status).toBe("pending")
    expect(dao.getTask(b)?.status).toBe("blocked")
    // drive A to done (no repo -> use a manual fast path: assign/claim/run needs repo;
    // for gating we set A running via repo then done)
    dao.updateTask(a, { repo: "/repo" })
    const role = dao.createRole({ name: "r", kind: "worker" })
    await kernel.transition(a, "assigned", "x", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(a, "running", "x")
    await kernel.transition(a, "done", "x")
    expect(dao.getTask(b)?.status).toBe("pending") // unblocked
  })
  it("onTaskFailed marks dag failed and keeps successors blocked", async () => {
    const { kernel, dao } = makeKernel()
    const dag = kernel.createDag({ title: "g" }, [{ key: "a", title: "A" }, { key: "b", title: "B" }], [["a", "b"]])
    const a = dag.tasks["a"], b = dag.tasks["b"]
    dao.updateTask(a, { repo: "/repo" })
    const role = dao.createRole({ name: "r", kind: "worker" })
    await kernel.transition(a, "assigned", "x", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(a, "running", "x")
    await kernel.transition(a, "failed", "x")
    expect(dao.getTask(b)?.status).toBe("blocked")
    expect(dao.raw().query("SELECT status FROM dag WHERE id=?").get(dag.dag.id)).toMatchObject({ status: "failed" })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: FAIL — `kernel.createDag` undefined.

- [ ] **Step 3: Implement createDag + gating**

```ts
// add to imports: import { hasCycle } from "@/dag"
// add to MultimanKernel:

createDag(
  info: { title?: string; source_inbox_item_id?: string | null; orchestrator_role_id?: string | null },
  tasks: { key: string; title: string; body?: string; role_id?: string | null; repo?: string | null; priority?: number }[],
  edges: [string, string][], // [fromKey, toKey]
): { dag: import("@/types").Dag; tasks: Record<string, string> } {
  const keys = tasks.map((t) => t.key)
  if (hasCycle(keys, edges)) throw new (require("@/errors").CyclicDagError)()
  return this.dao.transaction(() => {
    const dag = this.dao.createDagRow(info)
    const keyToId: Record<string, string> = {}
    const hasPred = new Set(edges.map(([, to]) => to))
    for (const spec of tasks) {
      const created = this.dao.createTask({
        title: spec.title, body: spec.body, role_id: spec.role_id ?? null,
        repo: spec.repo ?? null, priority: spec.priority ?? 0, dag_id: dag.id,
        source_kind: "orchestrator", source_ref: dag.id,
        status: hasPred.has(spec.key) ? "blocked" : "pending",
      })
      keyToId[spec.key] = created.id
    }
    for (const [from, to] of edges) this.dao.addEdge(dag.id, keyToId[from], keyToId[to])
    return { dag, tasks: keyToId }
  })
}

private onTaskDone(taskId: string): void {
  for (const succ of this.dao.successorsOf(taskId)) {
    const s = this.dao.getTask(succ)
    if (!s || s.status !== "blocked") continue
    const allDone = this.dao.predecessorsOf(succ)
      .every((p) => this.dao.getTask(p)?.status === "done")
    if (allDone) {
      const to = s.role_id ? "assigned" : "pending"
      this.dao.updateTask(succ, { status: to })
      this.publish("task.transitioned", this.dao.getTask(succ))
    }
  }
}

private onTaskFailed(taskId: string): void {
  const t = this.dao.getTask(taskId)
  if (t?.dag_id) this.dao.setDagStatus(t.dag_id, "failed")
  // successors intentionally stay blocked for human/orchestrator triage (#4a).
}
```

Note: replace the `require("@/errors")` with a top-of-file `import { CyclicDagError } from "@/errors"`
and `throw new CyclicDagError()`. (require shown inline only to keep the diff local; use the import.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/kernel.ts packages/multiman/test/kernel.test.ts
git commit -m "feat(multiman): DAG create with cycle check + gating"
```

### Task 13: heartbeat + reportTask

**Files:**
- Modify: `packages/multiman/src/kernel.ts`
- Test: extend `packages/multiman/test/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to test/kernel.test.ts
describe("heartbeat + report", () => {
  it("heartbeat renews last_heartbeat_at for a running task", async () => {
    let clock = "2026-06-05T00:00:00.000Z"
    const { kernel, dao } = makeKernel(() => clock)
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x")
    clock = "2026-06-05T00:05:00.000Z"
    kernel.heartbeat(t.id, role.id)
    expect(dao.getTask(t.id)?.last_heartbeat_at).toBe(clock)
  })
  it("heartbeat rejects when caller is not the claimer", async () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x")
    expect(() => kernel.heartbeat(t.id, "someone-else")).toThrow()
  })
  it("reportTask sets terminal status + result", async () => {
    const { kernel, dao } = makeKernel()
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x")
    await kernel.reportTask(t.id, { status: "in_review", result: "done-ish" })
    expect(dao.getTask(t.id)?.status).toBe("in_review")
    expect(dao.getTask(t.id)?.result).toBe("done-ish")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: FAIL — `heartbeat`/`reportTask` undefined.

- [ ] **Step 3: Implement heartbeat + reportTask**

```ts
heartbeat(taskId: string, roleId: string): void {
  const t = this.dao.getTask(taskId)
  if (!t) throw new GuardError(`task not found: ${taskId}`)
  if (t.status !== "running") throw new GuardError(`task not running: ${taskId}`)
  if (t.claimed_by !== roleId) throw new GuardError(`heartbeat from non-claimer: ${roleId}`)
  this.dao.updateTask(taskId, { last_heartbeat_at: this.now() })
}

async reportTask(
  id: string,
  r: { status: TaskStatus; result?: string; error?: string; sessionId?: string },
): Promise<Task> {
  if (r.result !== undefined || r.error !== undefined || r.sessionId !== undefined) {
    this.dao.updateTask(id, {
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.sessionId !== undefined ? { session_id: r.sessionId } : {}),
    })
  }
  return this.transition(id, r.status, "report")
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/kernel.ts packages/multiman/test/kernel.test.ts
git commit -m "feat(multiman): heartbeat lease renewal + reportTask"
```

---

## Phase 7 — Sweeper

### Task 14: sweep claimed timeouts + running lease expiry

**Files:**
- Modify: `packages/multiman/src/kernel.ts` (add a `sweep()` method)
- Create: `packages/multiman/src/sweeper.ts`
- Test: extend `packages/multiman/test/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to test/kernel.test.ts
describe("sweep", () => {
  it("reclaims a stale claimed task back to assigned", async () => {
    let clock = "2026-06-05T00:00:00.000Z"
    const { kernel, dao } = makeKernel(() => clock)
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id) // claimed_at = 00:00
    clock = "2026-06-05T00:10:00.000Z" // +10min > 90s recovery
    kernel.sweep()
    expect(dao.getTask(t.id)?.status).toBe("assigned")
  })
  it("reclaims a lease-expired running task to assigned and increments retry", async () => {
    let clock = "2026-06-05T00:00:00.000Z"
    const { kernel, dao } = makeKernel(() => clock)
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x") // heartbeat = 00:00
    clock = "2026-06-05T00:10:00.000Z" // +10min > 60s lease
    kernel.sweep()
    const after = dao.getTask(t.id)
    expect(after?.status).toBe("assigned")
    expect(after?.retry_count).toBe(1)
  })
  it("fails a running task after maxRetry exhausted", async () => {
    let clock = "2026-06-05T00:00:00.000Z"
    const { kernel, dao } = makeKernel(() => clock)
    const role = dao.createRole({ name: "r", kind: "worker" })
    const t = kernel.createTask({ title: "x", role_id: role.id, repo: "/repo" })
    dao.updateTask(t.id, { retry_count: 2 }) // already at maxRetry
    await kernel.transition(t.id, "assigned", "a", { roleId: role.id })
    kernel.claimNextTask(role.id)
    await kernel.transition(t.id, "running", "x")
    clock = "2026-06-05T00:10:00.000Z"
    kernel.sweep()
    expect(dao.getTask(t.id)?.status).toBe("failed")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: FAIL — `kernel.sweep` undefined.

- [ ] **Step 3: Implement sweep() + sweeper.ts**

Add to `MultimanKernel`:
```ts
sweep(): void {
  const nowMs = Date.parse(this.now())
  // claimed timeout -> assigned
  for (const t of this.dao.listTasks({ status: "claimed" })) {
    if (t.claimed_at && nowMs - Date.parse(t.claimed_at) > this.recoveryWindowMs) {
      this.dao.updateTask(t.id, { status: "assigned" })
      this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.sweep.claim_timeout", target_kind: "task", target_id: t.id, details: "{}" })
      this.publish("task.transitioned", this.dao.getTask(t.id))
    }
  }
  // running lease expiry -> assigned (retry) or failed
  for (const t of this.dao.listTasks({ status: "running" })) {
    const hb = t.last_heartbeat_at ?? t.claimed_at
    if (hb && nowMs - Date.parse(hb) > this.leaseWindowMs) {
      if (t.retry_count < this.maxRetry) {
        this.dao.updateTask(t.id, { status: "assigned", retry_count: t.retry_count + 1, last_heartbeat_at: null })
        this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.sweep.lease_retry", target_kind: "task", target_id: t.id, details: JSON.stringify({ retry: t.retry_count + 1 }) })
      } else {
        this.dao.updateTask(t.id, { status: "failed", error: "lease expired, max retries" })
        this.dao.logEvent({ actor_kind: "system", actor_id: null, action: "task.sweep.lease_failed", target_kind: "task", target_id: t.id, details: "{}" })
        this.onTaskFailed(t.id)
      }
      this.publish("task.transitioned", this.dao.getTask(t.id))
    }
  }
}
```

`src/sweeper.ts`:
```ts
import type { MultimanKernel } from "@/kernel"

export function startSweeper(kernel: MultimanKernel, opts: { intervalMs?: number } = {}): () => void {
  const intervalMs = opts.intervalMs ?? 30_000
  if (intervalMs <= 0) return () => {}
  let running = false
  const tick = () => {
    if (running) return
    running = true
    try { kernel.sweep() } catch (e) { console.error("[multiman] sweep error", e) } finally { running = false }
  }
  const timer = setInterval(tick, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
```

Note: sweep uses direct `dao.updateTask` (not `transition`) deliberately — these are
system-initiated recoveries that bypass the role guard but still respect the state graph
(claimed→assigned, running→assigned|failed are all legal edges).

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/kernel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/kernel.ts packages/multiman/src/sweeper.ts packages/multiman/test/kernel.test.ts
git commit -m "feat(multiman): sweeper for claim timeout + running lease"
```

---

## Phase 8 — RPC envelope

### Task 15: rpc.handle router + validation

**Files:**
- Create: `packages/multiman/src/rpc.ts`
- Test: `packages/multiman/test/rpc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/rpc.test.ts
import { describe, it, expect } from "bun:test"
import { openDb } from "@/db/open"
import { runMigrations } from "@/db/migrate"
import { Dao } from "@/db/dao"
import { MultimanKernel } from "@/kernel"
import { makeRpcHandler } from "@/rpc"

function makeHandler() {
  const db = openDb(":memory:"); runMigrations(db)
  let n = 0
  const dao = new Dao(db, () => "2026-06-05T00:00:00.000Z", () => `id-${++n}`)
  const orch = { async adoptWorktree(i: any) { return { id: `kobe-${i.branch}`, worktreePath: i.worktreePath } } }
  const kernel = new MultimanKernel({ dao, orchestrator: orch as any, now: () => "2026-06-05T00:00:00.000Z", publish: () => {} })
  return makeRpcHandler(kernel)
}

describe("rpc handle", () => {
  it("routes role.create and task.create", async () => {
    const h = makeHandler()
    const role = await h("role.create", { name: "r", kind: "worker" })
    expect((role as any).id).toBeTruthy()
    const task = await h("task.create", { title: "x" })
    expect((task as any).status).toBe("pending")
  })
  it("rejects unknown method", async () => {
    const h = makeHandler()
    await expect(h("bogus.method", {})).rejects.toThrow(/unknown/i)
  })
  it("rejects missing required param", async () => {
    const h = makeHandler()
    await expect(h("role.create", { kind: "worker" })).rejects.toThrow(/name/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/multiman && bun test test/rpc.test.ts`
Expected: FAIL — cannot resolve `@/rpc`.

- [ ] **Step 3: Implement rpc.ts**

```ts
// src/rpc.ts
import type { MultimanKernel } from "@/kernel"
import type { TaskStatus } from "@/types"

type Params = Record<string, unknown>
function reqStr(p: Params, k: string): string {
  const v = p[k]
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing/invalid param: ${k}`)
  return v
}
function optStr(p: Params, k: string): string | undefined {
  const v = p[k]; if (v === undefined || v === null) return undefined
  if (typeof v !== "string") throw new Error(`invalid param: ${k}`); return v
}

export type RpcHandler = (method: string, params: Params) => Promise<unknown>

export function makeRpcHandler(kernel: MultimanKernel): RpcHandler {
  const routes: Record<string, (p: Params) => unknown | Promise<unknown>> = {
    // task.* (S0 scope)
    "task.create": (p) => kernel.createTask({
      title: reqStr(p, "title"), body: optStr(p, "body"),
      role_id: optStr(p, "roleId") ?? null, repo: optStr(p, "repo") ?? null,
      priority: typeof p.priority === "number" ? p.priority : 0,
    }),
    "task.get": (p) => kernel.getTask(reqStr(p, "id")) ?? null,
    "task.list": (p) => kernel.listTasks({
      status: optStr(p, "status") as TaskStatus | undefined,
      role_id: optStr(p, "roleId"), dag_id: optStr(p, "dagId"),
    }),
    "task.transition": (p) => kernel.transition(reqStr(p, "id"), reqStr(p, "to") as TaskStatus, optStr(p, "reason") ?? "rpc", { roleId: optStr(p, "roleId") }),
    "task.claim": (p) => kernel.claimNextTask(reqStr(p, "roleId")),
    "task.report": (p) => kernel.reportTask(reqStr(p, "id"), { status: reqStr(p, "status") as TaskStatus, result: optStr(p, "result"), error: optStr(p, "error"), sessionId: optStr(p, "sessionId") }),
    "task.heartbeat": (p) => { kernel.heartbeat(reqStr(p, "id"), reqStr(p, "roleId")); return { ok: true } },
    // role.* (S0 scope)
    "role.create": (p) => kernel.createRoleViaDao(reqStr(p, "name"), reqStr(p, "kind") as any, optStr(p, "instructions"), optStr(p, "vendor"), optStr(p, "model")),
    "role.get": (p) => kernel.getRole(reqStr(p, "id")) ?? null,
    "role.list": () => kernel.listRoles(),
    // dag.* (S0 scope)
    "dag.create": (p) => kernel.createDag(
      { title: optStr(p, "title") },
      (p.tasks as any[]) ?? [],
      (p.edges as [string, string][]) ?? [],
    ),
    "dag.get": (p) => kernel.getDag(reqStr(p, "id")),
  }
  return async (method, params) => {
    const fn = routes[method]
    if (!fn) throw new Error(`unknown method: ${method}`)
    return await fn(params ?? {})
  }
}
```

Add thin pass-throughs to `MultimanKernel` so rpc doesn't reach into `dao` directly:
```ts
// in kernel.ts
createRoleViaDao(name: string, kind: import("@/types").RoleKind, instructions?: string, vendor?: string, model?: string) {
  const r = this.dao.createRole({ name, kind, instructions, vendor: vendor ?? null, model: model ?? null })
  this.publish("role.created", r); return r
}
getRole(id: string) { return this.dao.getRole(id) }
listRoles() { return this.dao.listRoles() }
getDag(id: string) {
  return {
    dag: this.dao.raw().query("SELECT * FROM dag WHERE id=?").get(id),
    tasks: this.dao.listTasks({ dag_id: id }),
    edges: this.dao.raw().query("SELECT * FROM dag_edge WHERE dag_id=?").all(id),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/multiman && bun test test/rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/multiman/src/rpc.ts packages/multiman/src/kernel.ts packages/multiman/test/rpc.test.ts
git commit -m "feat(multiman): RPC handler envelope + validation"
```

### Task 16: public exports + client wrapper

**Files:**
- Modify: `packages/multiman/src/index.ts`
- Create: `packages/multiman/src/client/index.ts`

- [ ] **Step 1: Write index.ts exports**

```ts
// src/index.ts
export { MultimanKernel } from "@/kernel"
export type { KernelDeps, KobeOrchestratorPort } from "@/kernel"
export { makeRpcHandler } from "@/rpc"
export type { RpcHandler } from "@/rpc"
export { openDb } from "@/db/open"
export { runMigrations } from "@/db/migrate"
export { Dao } from "@/db/dao"
export { startSweeper } from "@/sweeper"
export * from "@/types"
```

- [ ] **Step 2: Write client/index.ts**

```ts
// src/client/index.ts
// Thin wrapper. Zero heavy deps (no db/kernel import) so runner/TUI/CLI can use it.
export interface MultimanRpcTransport {
  request<T>(name: "multiman", payload: { method: string; params?: Record<string, unknown> }): Promise<T>
}

export class MultimanClient {
  constructor(private transport: MultimanRpcTransport) {}
  private call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.transport.request<T>("multiman", { method, params })
  }
  createRole(p: { name: string; kind: string; instructions?: string }) { return this.call("role.create", p) }
  listRoles() { return this.call("role.list") }
  createTask(p: { title: string; roleId?: string; repo?: string; priority?: number }) { return this.call("task.create", p) }
  listTasks(p: { status?: string } = {}) { return this.call("task.list", p) }
  transition(p: { id: string; to: string; reason?: string; roleId?: string }) { return this.call("task.transition", p) }
  claim(p: { roleId: string }) { return this.call("task.claim", p) }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/multiman && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/multiman/src/index.ts packages/multiman/src/client/index.ts
git commit -m "feat(multiman): public exports + thin RPC client"
```

---

## Phase 9 — kobe daemon integration

> These tasks modify `packages/kobe`. Read the exact current code first (the spec cites
> `daemon/protocol.ts`, `daemon/server.ts`, `daemon/event-bus.ts`). Match kobe's style.

### Task 17: protocol — add `"multiman"` request name + channel

**Files:**
- Modify: `packages/kobe/src/daemon/protocol.ts`

- [ ] **Step 1: Add the request name**

In the `DaemonRequestName` union add `"multiman"`. The request payload shape is
`{ method: string; params?: unknown }`.

- [ ] **Step 2: Add the event channel**

In `ChannelPayloads` add `multiman: { kind: string; payload: unknown }` and add `"multiman"`
to `CHANNEL_NAMES`.

- [ ] **Step 3: Verify kobe typechecks**

Run: `cd packages/kobe && bun run typecheck`
Expected: PASS (exhaustive switches may now require a `multiman` case — that's Task 18).

- [ ] **Step 4: Commit**

```bash
git add packages/kobe/src/daemon/protocol.ts
git commit -m "feat(kobe): multiman request name + event channel"
```

### Task 18: server — construct kernel, dispatch, sweeper, lifetime keepalive

**Files:**
- Modify: `packages/kobe/src/daemon/server.ts`

- [ ] **Step 1: Construct the kernel inside `startDaemonServer`**

After the orchestrator is available, build the DB + kernel:
```ts
import { openDb, runMigrations, Dao, MultimanKernel, startSweeper } from "@sma1lboy/multiman"
// ... resolve multiman db path next to tasks.json (homeDir + "multiman.db")
const mmDb = openDb(join(homeDir, "multiman.db"))
runMigrations(mmDb)
const mmDao = new Dao(mmDb, () => new Date().toISOString(), () => ulid())
const multimanKernel = new MultimanKernel({
  dao: mmDao,
  orchestrator: {
    adoptWorktree: (i) => orch.adoptWorktree({ ...i }),
  },
  now: () => new Date().toISOString(),
  publish: (kind, payload) => bus.publish("multiman", { kind, payload }),
})
const mmHandler = makeRpcHandler(multimanKernel)
const stopSweeper = startSweeper(multimanKernel)
```

- [ ] **Step 2: Add the dispatch case**

In `dispatch(req, client)`'s switch:
```ts
case "multiman": {
  const payload = req.payload as { method: string; params?: Record<string, unknown> }
  return await mmHandler(payload.method, payload.params ?? {})
}
```

- [ ] **Step 3: Lifetime keepalive (#1)**

Two changes to the idle-shutdown logic (around `server.ts:154-165`):
1. Treat a subscribe with `role: "runner"` as lifetime-holding (same refcount bucket as gui's `holdsLifetime`).
2. Before firing `stopSoon()` on idle, also check the kernel: if any non-terminal multiman task exists, do NOT stop.
```ts
const hasActiveMultiman = () =>
  multimanKernel.listTasks().some((t) => !["done", "cancelled"].includes(t.status))
// in the idle path: if (hasActiveMultiman()) return // keep daemon alive
```

- [ ] **Step 4: Wire cleanup**

In `serverApi.close()`: `stopSweeper()` and `mmDb.close()`.

- [ ] **Step 5: Verify kobe typechecks + existing tests still pass**

Run: `cd packages/kobe && bun run typecheck && bun test test/daemon`
Expected: PASS (or only the new socket test pending in Task 19).

- [ ] **Step 6: Commit**

```bash
git add packages/kobe/src/daemon/server.ts
git commit -m "feat(kobe): mount multiman kernel, dispatch, sweeper, lifetime keepalive"
```

### Task 19: socket + lifetime integration test

**Files:**
- Create: `packages/multiman/test/daemon.socket.test.ts`

- [ ] **Step 1: Write the test (gated by KOBE_INCLUDE_SOCKET=1)**

```ts
// test/daemon.socket.test.ts
import { describe, it, expect } from "bun:test"
// Start a daemon on a temp socket + temp KOBE_HOME_DIR, connect a KobeDaemonClient,
// send request("multiman", {method:"task.create", params:{title:"x"}}), assert a Task
// returns and a "multiman" channel event with kind "task.created" arrives.
const RUN = process.env.KOBE_INCLUDE_SOCKET === "1"
describe.runIf(RUN)("multiman over daemon socket", () => {
  it("creates a task and emits an event", async () => {
    // ... (mirror kobe's existing test/daemon setup helpers; use a temp homeDir)
    expect(true).toBe(true) // replace with real assertions following kobe test harness
  })
})
```

NOTE: copy the daemon bring-up helper from kobe's existing `test/daemon/*` so the harness
matches. Assert: (a) `task.create` round-trips a Task; (b) subscribing to channel `multiman`
receives `{kind:"task.created"}`; (c) a `runner`-role subscriber keeps the daemon alive after
the gui disconnects (lifetime, #1).

- [ ] **Step 2: Run the socket suite**

Run: `cd packages/multiman && KOBE_INCLUDE_SOCKET=1 bun test test/daemon.socket.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/multiman/test/daemon.socket.test.ts
git commit -m "test(multiman): daemon socket round-trip + lifetime"
```

---

## Phase 10 — CLI + manual acceptance

### Task 20: `kobe multiman` subcommand

**Files:**
- Modify: `packages/kobe/src/cli/index.ts`
- Create: `packages/kobe/src/cli/multiman-cmd.ts` (or inline, matching kobe's subcommand pattern)

- [ ] **Step 1: Implement the subcommand**

A thin client: connect `KobeDaemonClient` to the daemon socket, then map argv to
`request("multiman", {method, params})`. Support:
```
kobe multiman role create --name <n> --kind <worker|orchestrator|collector> [--instructions <s>]
kobe multiman role list
kobe multiman task create --title <t> [--role <id>] [--repo <path>] [--priority <n>]
kobe multiman task list [--status <s>]
kobe multiman task assign <taskId> --role <id>        # -> transition pending->assigned
kobe multiman task claim --role <id>                  # -> claimNextTask
kobe multiman task transition <taskId> --to <status>  # e.g. running (materializes)
kobe multiman task get <taskId>
```
Print JSON results. Follow kobe's existing arg-parsing util (grep `cli/` for the pattern).

- [ ] **Step 2: Verify typecheck + lint**

Run: `bun run typecheck && bun run lint` (from repo root or each package)
Expected: PASS.

- [ ] **Step 3: Manual acceptance (M0 Definition of Done)**

```bash
# start daemon (or let CLI autostart per kobe convention)
kobe daemon start    # or kobe's normal entrypoint
kobe multiman role create --name backend --kind worker
ROLE=$(kobe multiman role list | jq -r '.[0].id')
kobe multiman task create --title "first task" --role "$ROLE" --repo "$(pwd)"
TASK=$(kobe multiman task list --status pending | jq -r '.[0].id')
kobe multiman task assign "$TASK" --role "$ROLE"
kobe multiman task claim --role "$ROLE"
kobe multiman task transition "$TASK" --to running
```
Expected:
- `task transition --to running` materializes: `~/.kobe/multiman.db` has the task with
  `kobe_task_id` + `work_dir` set; `git worktree list` shows `.../.claude/worktrees/<taskId>`;
  the kobe Task appears in `kobe`'s normal task list.
- A second `kobe multiman task list` (separate process) returns the same state via RPC.

- [ ] **Step 4: Commit**

```bash
git add packages/kobe/src/cli/index.ts packages/kobe/src/cli/multiman-cmd.ts
git commit -m "feat(kobe): kobe multiman CLI subcommand"
```

### Task 21: Full green + push

- [ ] **Step 1: Run the whole suite**

Run: `cd packages/multiman && bun run test && KOBE_INCLUDE_SOCKET=1 bun test test/daemon.socket.test.ts`
Run: `cd packages/kobe && bun run typecheck && bun run lint`
Expected: all green.

- [ ] **Step 2: Push the branch to the fork**

```bash
git push origin multiman
```

---

## Self-Review

**Spec coverage:**
- SQLite schema (all 10 tables, indexes incl. idx_task_claim) → Task 4. ✓
- enum single-source (Finding 2) → Task 2 + Task 5. ✓
- state machine (table + guards) → Task 7 + kernel guards Task 9. ✓
- claimNextTask atomic pull → Task 10. ✓
- materialize deterministic adopt idempotency (Finding 1) → Task 11. ✓
- DAG cycle check (#4a) + gating onTaskDone/onTaskFailed → Task 8 + Task 12. ✓
- running lease/heartbeat (#3) + sweeper claimed+running → Task 13 + Task 14. ✓
- RPC envelope + validation → Task 15; client → Task 16. ✓
- daemon: dispatch + channel + sweeper + lifetime keepalive (#1) → Tasks 17/18/19. ✓
- multiman = sole source of truth, one-way projection (#2) → encoded in materialize (no read-back) Task 11 + no kobe→multiman writes anywhere. ✓
- bus = hint only, poll baseline (#4b) → no kernel logic depends on bus for correctness; events are fire-and-forget; runner poll is S1. Documented, nothing to build in S0. ✓
- CLI M0 acceptance → Task 20. ✓

**Deferred (D1, tables-only, no S0 CRUD/RPC):** inbox_item, schedule, schedule_run, asset, role_asset — tables created in 001_init.sql (Task 4), no kernel/rpc. ✓ (matches spec)

**Placeholder scan:** `dao.ts` per-table CRUD is fully written for S0 tables; the `require("@/errors")` in Task 12 is flagged to be replaced by a top import. The socket test (Task 19) is a harness stub that explicitly says to mirror kobe's existing `test/daemon` helpers — acceptable because the exact helper API must be read from kobe at impl time (not inventable here). No "TBD"/"handle edge cases" left.

**Type consistency:** `transition` is async everywhere after Task 11 (flagged to update earlier tests). `MultimanKernel` method names used by rpc.ts (createRoleViaDao/getRole/listRoles/getDag/createDag/createTask/getTask/listTasks/transition/claimNextTask/reportTask/heartbeat/sweep/materialize) are all defined. `Dao` methods used by kernel (createRole/getRole/listRoles/createTask/getTask/listTasks/updateTask/createDagRow/addEdge/predecessorsOf/successorsOf/setDagStatus/logEvent/transaction/raw) all defined in Task 6.

**Known impl-time confirmations (not placeholders, real lookups):**
1. kobe ulid export path (Task 2 ids.ts) — grep kobe; copy impl if not exported.
2. kobe `adoptWorktree` exact signature (Task 18) — spec verified it exists with `ifExists:"return"`; confirm param names.
3. `bun:sqlite` `RETURNING` support (Task 10) — fallback documented.
4. kobe daemon test harness helpers (Task 19) — mirror existing `test/daemon`.

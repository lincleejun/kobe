# multiman 子系统 0 — 数据层 + 协调内核 + IPC API（Design Spec）

> 地基子系统。定义 SQLite 数据模型、任务状态机、协调内核（Kernel）、以及跑在 kobe daemon
> socket 上的 IPC 契约。所有其它子系统（role/inbox/orchestrator/asset/多终端）都消费这层。
>
> 上位文档：`2026-06-05-multiman-roadmap.md`（含已拍板的决策记录）。
> 日期：2026-06-05 · 状态：草案，待 review

---

## 1. 范围

**本子系统做**
- 新 package `packages/multiman`（kobe monorepo 内，fork 的 `multiman` 分支）。
- `bun:sqlite` 持久化层：schema + 迁移 + 类型化 DAO。
- 任务状态机（转移表 + 守卫，纯函数，可单测）。
- `MultimanKernel`：进程内核心 API（同步 DB 操作 + 物化 kobe task 的异步操作）。
- IPC：在 kobe daemon 协议上加**一个**请求名 `"multiman"`（信封）+ **一个**事件 channel `"multiman"`。
- 后台 worker：`sweeper`（回收僵死 claimed + lease 过期的 running，#3）。
- **kobe 物化链路**：`transition(→running)` 触发 `materialize`，确定性 slug + `adoptWorktree({ifExists:'return'})`
  真正建出 worktree+tmux（物化硬性要求 + Finding 1 幂等）。
- **daemon 保活（#1）**：runner 订阅持有 lifetime + 有非终态任务时 keepalive，防 daemon 自停。
- **真相源契约（#2）**：multiman 为其托管任务状态唯一权威，multiman→kobe 单向投影，不回写。
- **running lease/heartbeat（#3）**：服务端 heartbeat 续约 + sweeper 按 lease 回收 running。
- **DAG 机制（#4a）**：createDag 拓扑环检测 + onTaskDone/onTaskFailed 门控级联。
- CLI：`kobe multiman ...` 子命令，足以手动 `role create` / `task create` / `task list` / `task transition`，用于 M0 验收。

**本子系统不做**（留给后续子系统）
- role-runner 自动领任务循环（子系统 1/5）。
- scheduler/cron、inbox 采集（子系统 2）。
- orchestrator DAG 拆分逻辑（子系统 3）；本层只建 DAG 表 + dag-gater 门控机制，不含「prompt 拆分」。
- asset 注入运行时（子系统 4）；本层只建 asset/role_asset 表 + CRUD。
- TUI 集成（子系统 5）。

**关键原则**：本层只提供**机制**（表、状态机、claim 原子性、门控、RPC），不提供**策略**
（拆分、采集、注入由上层 role 的 prompt/逻辑决定）。对应 CLAUDE 规则：code answers 确定性的事，
model 只做判断（判断在上层）。

---

## 2. Package 布局（方案 A：单包 + 内部模块 + 分层约束）

**决议**：multiman 用**单一 package** `packages/multiman`（贴合 kobe 自身「单包 + 内部模块」惯例；
kobe 只把工具链不同的 `branding`/Remotion 拆出去）。隔离靠**模块边界 + 内部分层规则**，不拆多包。
仓库形态：完整 fork 整个 kobe（含 branding 等所有部分），multiman 作为新增 package 叠加，不删既有内容。

**内部分层（强制单向依赖，禁止反向 import）**：
```
types  ◄── db  ◄── kernel(含 role/schedule/inbox/asset/dag/state-machine 业务)  ◄── rpc  ◄── client/cli
                                       ▲
                              kobe orchestrator（物化，注入）
```
- `types` / `client` 设计为**零重依赖**（不 import db/kernel/bun:sqlite），为将来子系统 5 的 runner
  成为独立构建产物时，无痛提升成方案 B 的 `@multiman/contract` + `@multiman/client` 两个包留接缝。
- 用 biome/eslint 的 import 边界规则或目录约定守住分层（如 `client/` 不许 import `db/`、`kernel/`）。

```
packages/multiman/
├── package.json          # name: "@sma1lboy/multiman", type: module, exports
├── tsconfig.json         # extends @tsconfig/bun，paths 同 kobe 风格
├── vitest.config.ts
├── src/
│   ├── index.ts          # 导出 MultimanKernel、类型
│   ├── types.ts          # Role/Task/Dag/InboxItem/Schedule/Asset + 枚举（零重依赖）
│   ├── ids.ts            # ULID 生成（复用 kobe ulid 工具）
│   ├── db/
│   │   ├── open.ts        # openDb(path): Database (bun:sqlite, WAL, foreign_keys=ON)
│   │   ├── migrate.ts     # runMigrations(db)；基于 user_version
│   │   ├── migrations/001_init.sql
│   │   └── dao.ts         # 各表类型化 CRUD（纯 DB，无业务）
│   ├── state-machine.ts  # 转移表 + canTransition()/assertTransition()（纯函数）
│   ├── kernel.ts         # MultimanKernel：组合 dao + state-machine + kobe orchestrator
│   ├── role/             # role 业务（S0：CRUD；后续子系统扩展）
│   ├── inbox/            # inbox 业务（S0：CRUD；采集逻辑→子系统2）
│   ├── schedule/         # schedule 业务（S0：表+CRUD；scheduler worker→子系统2）
│   ├── asset/            # asset 业务（S0：CRUD；注入运行时→子系统4）
│   ├── dag/              # dag 建图 + 门控函数（S0：建表+onTaskDone 门控；拆分逻辑→子系统3）
│   ├── rpc.ts            # handle(method, params) 路由表 + 入参校验
│   ├── sweeper.ts        # 后台 worker：回收僵死 claimed（S0 唯一 worker）
│   └── client/           # 薄 RPC client 封装（零重依赖；CLI 与未来 runner/TUI 共用）
└── test/
    ├── state-machine.test.ts
    ├── dao.test.ts
    ├── kernel.test.ts
    └── rpc.test.ts
```

> **S0 范围（D1 决议：schema 一次建全，逻辑只填 M0）**：
> - `001_init.sql` 一次建全 10 张表（完整数据模型一眼看全，避免子系统间改 schema）。
> - S0 **实现** CRUD/RPC 的：`task` / `role` / `dag`+`dag_edge` / `event_log`，加 `db` / `state-machine` /
>   `kernel`（claim/门控/物化）/ `rpc` / `sweeper` / `client`。
> - S0 **只建表、不写 CRUD/RPC** 的：`inbox_item` / `schedule` / `schedule_run` / `asset` / `role_asset`
>   —— 其 CRUD/RPC/业务随子系统 2/4 落地（目录先占位，避免后续大改结构）。

对 kobe 主包的改动（最小、隔离）：
- `packages/kobe/package.json`：依赖 `"@sma1lboy/multiman": "workspace:*"`。
- `daemon/protocol.ts`：`DaemonRequestName` 联合加 `"multiman"`；`ChannelPayloads` 加 `multiman` channel。
- `daemon/server.ts`：`dispatch` switch 加 `case "multiman"` → `kernel.handle(...)`；
  `startDaemonServer` 内构造 `MultimanKernel`、注册 `startSweeper`、`close()` 里停掉。
- **daemon 保活（#1，两者都做）**：
  · 扩展 idle-shutdown（`server.ts:154-165`）：新增订阅 role（如 `runner`）持有 `holdsLifetime`，
    在线时阻止自停；
  · kernel keepalive：DB 中存在非终态 multiman 任务（pending/assigned/claimed/running/blocked/in_review）
    时也阻止 idle-shutdown。runner 在线 **或** 有在飞任务 → daemon 不自停。
- **事件唤醒（#4b）**：kobe `event-bus.ts` 是 last-value replay，只作 best-effort 提示；
  runner 以 `task.claim` 慢轮询为正确性兜底；`event_log` 表为持久历史。不靠 bus 传状态或保证唤醒。
- `cli/index.ts`：注册 `multiman` 子命令（薄客户端，走 `KobeDaemonClient.request("multiman", {...})`）。

---

## 3. SQLite 数据层

### 3.1 连接与 PRAGMA（`db/open.ts`）

- 路径：`<kobeHome>/multiman.db`（复用 kobe `daemon/paths.ts` 的 home 解析，env `KOBE_HOME_DIR`）。
  测试用 `:memory:`。
- 用 `bun:sqlite` 的 `Database`（同步 API，零依赖）。
- PRAGMA：`journal_mode=WAL`（并发读 + 单写，配合 daemon 单进程写最合适）、`foreign_keys=ON`、
  `busy_timeout=5000`。
- **写者唯一**：只有 daemon 进程写 DB；runner/CLI/TUI 都经 RPC 让 daemon 写。这避免多写者，
  WAL 足够。（与 kobe tasks.json 的 lockfile 思路一致：集中写。）

### 3.2 迁移（`db/migrate.ts`）

- 用 `PRAGMA user_version` 做版本号。启动时跑 `migrations/NNN_*.sql` 中 > 当前版本的，
  每个文件包裹在事务里，跑完 `PRAGMA user_version = N`。
- 首版即 `001_init.sql`（下方 DDL）。

### 3.3 DDL（`migrations/001_init.sql`）

> id 一律 ULID 文本（与 kobe TaskId 一致，时间有序）。时间戳 ISO-8601 文本（与 kobe 一致）。
> 枚举用 `TEXT + CHECK` 约束，避免静默写坏。

```sql
-- role：执行单元（orchestrator / worker / collector）
CREATE TABLE role (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('orchestrator','worker','collector')),
  instructions  TEXT NOT NULL DEFAULT '',     -- role 的 prompt/SOP
  vendor        TEXT,                          -- 'claude' | 'codex' | NULL(继承默认)
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- dag：一次 orchestrator 拆分产出的任务图（子系统 3 填充；本层只建表 + 门控）
CREATE TABLE dag (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL DEFAULT '',
  source_inbox_item_id  TEXT,
  orchestrator_role_id  TEXT REFERENCES role(id),
  status                TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','done','failed','cancelled')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- task：核心工作单元
CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  role_id       TEXT REFERENCES role(id),      -- assignee；NULL = 未指派
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','assigned','claimed','running',
                                  'blocked','in_review','done','failed','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 0,    -- 越大越优先
  parent_task_id TEXT REFERENCES task(id),
  dag_id        TEXT REFERENCES dag(id),
  kobe_task_id  TEXT,                          -- 物化后的 kobe Task.id（ULID）
  repo          TEXT,                          -- 物化 worktree 用的源 repo 路径
  session_id    TEXT,                          -- engine 会话 id（跨重试复用）
  work_dir      TEXT,                          -- 物化的 worktree 绝对路径
  source_kind   TEXT NOT NULL DEFAULT 'manual'
                CHECK (source_kind IN ('manual','inbox','orchestrator')),
  source_ref    TEXT,                          -- inbox_item.id / dag.id 等
  result        TEXT,
  error         TEXT,
  claimed_by    TEXT REFERENCES role(id),      -- 实际领取的 role-runtime
  claimed_at    TEXT,
  last_heartbeat_at TEXT,                       -- running lease 续约时间（#3）；NULL=未运行
  retry_count   INTEGER NOT NULL DEFAULT 0,     -- lease 过期重派计数（#3）
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_task_status   ON task(status);
CREATE INDEX idx_task_role     ON task(role_id);
CREATE INDEX idx_task_dag      ON task(dag_id);
-- claim 热路径：status='assigned' AND role_id=? ORDER BY priority DESC, created_at ASC
CREATE INDEX idx_task_claim    ON task(status, role_id, priority, created_at);

-- dag_edge：依赖边（from 完成才解锁 to）
CREATE TABLE dag_edge (
  dag_id        TEXT NOT NULL REFERENCES dag(id),
  from_task_id  TEXT NOT NULL REFERENCES task(id),
  to_task_id    TEXT NOT NULL REFERENCES task(id),
  type          TEXT NOT NULL DEFAULT 'depends_on' CHECK (type IN ('depends_on')),
  PRIMARY KEY (from_task_id, to_task_id)
);
CREATE INDEX idx_edge_to ON dag_edge(to_task_id);

-- inbox_item：采集投递（子系统 2 填充；本层建表 + CRUD）
CREATE TABLE inbox_item (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,                   -- schedule_id | role_id
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',      -- JSON
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('action','attention','info')),
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','claimed','processed','archived')),
  consumed_by TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_inbox_status ON inbox_item(status);

-- schedule：定时/触发（子系统 2 用；本层建表 + CRUD）
CREATE TABLE schedule (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  trigger_kind       TEXT NOT NULL CHECK (trigger_kind IN ('cron','manual')),
  cron_expr          TEXT,
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  target_kind        TEXT NOT NULL CHECK (target_kind IN ('role','workflow')),
  target_ref         TEXT NOT NULL,
  execution_mode     TEXT NOT NULL DEFAULT 'collect'
                     CHECK (execution_mode IN ('collect','run_only')),
  concurrency_policy TEXT NOT NULL DEFAULT 'skip'
                     CHECK (concurrency_policy IN ('skip','queue','replace')),
  next_run_at        TEXT,
  last_run_at        TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
);

CREATE TABLE schedule_run (
  id                     TEXT PRIMARY KEY,
  schedule_id            TEXT NOT NULL REFERENCES schedule(id),
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','running','done','failed','skipped')),
  started_at             TEXT,
  finished_at            TEXT,
  produced_inbox_item_id TEXT REFERENCES inbox_item(id),
  error                  TEXT
);

-- asset：技能 / MCP（子系统 4 用；本层建表 + CRUD）
CREATE TABLE asset (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('skill','mcp')),
  name      TEXT NOT NULL,
  version   TEXT NOT NULL DEFAULT '0.1.0',
  spec      TEXT NOT NULL DEFAULT '{}',        -- JSON：skill 内容指针 / mcp server 定义
  path      TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (kind, name, version)
);

CREATE TABLE role_asset (
  role_id  TEXT NOT NULL REFERENCES role(id),
  asset_id TEXT NOT NULL REFERENCES asset(id),
  PRIMARY KEY (role_id, asset_id)
);

-- event_log：append-only 审计 + 给 dag-gater / TUI 提供事件溯源
CREATE TABLE event_log (
  id          TEXT PRIMARY KEY,
  actor_kind  TEXT NOT NULL,                   -- 'role' | 'human' | 'system'
  actor_id    TEXT,
  action      TEXT NOT NULL,                   -- 'task.transition' | 'task.claim' | ...
  target_kind TEXT NOT NULL,                   -- 'task' | 'inbox' | ...
  target_id   TEXT,
  details     TEXT NOT NULL DEFAULT '{}',      -- JSON
  ts          TEXT NOT NULL
);
CREATE INDEX idx_event_target ON event_log(target_kind, target_id);
```

---

## 4. 任务状态机（`state-machine.ts`）

纯函数，不碰 DB/IO，便于单测（对应规则 9：测试编码意图）。

### 4.1 状态与转移表

```
TaskStatus = pending | assigned | claimed | running | blocked
           | in_review | done | failed | cancelled
```

允许的转移（`from -> to`，附触发者与守卫）：

| from | to | 触发 | 守卫 |
|------|----|------|------|
| pending | assigned | 指派 role | role 存在且 active |
| pending | blocked | 建图时有未完成前驱 | 存在未 done 的 depends_on |
| assigned | claimed | runner `task.claim` | claimed_by 匹配 role；无其它活跃 claim |
| assigned | pending | 取消指派 | — |
| blocked | pending | dag-gater 解锁 | 所有 depends_on 已 done |
| blocked | assigned | dag-gater 解锁且已有 assignee | 同上 |
| claimed | running | runner 物化 kobe task 成功 | kobe_task_id 已写 |
| claimed | assigned | claim 超时回收(sweeper) | 过 recovery window |
| running | in_review | runner 报完成待审 | — |
| running | done | runner 直接报成功 | — |
| running | failed | runner 报失败 | — |
| running | blocked | 运行中发现需等待(如 worktree 锁) | — |
| in_review | done | 人/orchestrator 通过 | — |
| in_review | failed | 人/orchestrator 驳回 | — |
| in_review | assigned | 打回重做 | — |
| any(非终态) | cancelled | 人工取消 | — |
| failed | pending | 人工重试 | — |

终态：`done` / `cancelled`。`failed` 半终态（可重试回 pending）。

禁止：`done`↔`failed` 直接翻转（沿用 kobe `setStatus` 拒绝 done↔error 的精神）。

### 4.2 API

```ts
export function canTransition(from: TaskStatus, to: TaskStatus): boolean
export function assertTransition(from: TaskStatus, to: TaskStatus): void  // 非法抛 InvalidTransitionError
export const TERMINAL: ReadonlySet<TaskStatus>
```

守卫（role active、依赖满足、claim 唯一性）在 `kernel` 层做，因为需要查 DB；
`state-machine.ts` 只管「形状合法性」。两层分离便于测试。

---

## 5. 协调内核（`kernel.ts`）

`MultimanKernel` 组合 DAO + 状态机 + kobe orchestrator（物化）。它是 daemon 内单例。

### 5.1 构造

```ts
interface KernelDeps {
  db: Database                 // bun:sqlite
  orchestrator: Orchestrator   // kobe orchestrator（用于物化 worktree）
  publish: (kind: string, payload: unknown) => void  // 走 bus.publish("multiman", {kind, payload})
  now: () => string            // 注入时钟，便于测试（默认 () => new Date().toISOString()）
  recoveryWindowMs?: number    // 默认 90_000，对齐 multica
}
```

> 时钟注入：脚本/测试环境 `new Date()` 受限，注入 `now` 既可测又规避。

### 5.2 核心方法（机制，非策略）

**任务生命周期**
```ts
createTask(input): Task                       // 落 pending 或 blocked（若给了 deps）
getTask(id): Task | undefined
listTasks(filter?): Task[]                     // 按 status/role/dag 过滤
transition(id, to, reason, actor): Task        // 形状校验 + 守卫 + 写库 + event_log + publish
claimNextTask(roleId): Task | null             // ★ 原子：选 assigned 且 role 匹配、优先级/时间序，置 claimed
reportTask(id, {status, result?, error?, sessionId?}): Task   // 终态/审态上报
```

`claimNextTask` 的原子性（pull 模型核心）：单条 SQL
`UPDATE task SET status='claimed', claimed_by=?, claimed_at=? WHERE id = (SELECT id FROM task WHERE status='assigned' AND role_id=? ORDER BY priority DESC, created_at ASC LIMIT 1) RETURNING *`。
**⚠ 原子性来自架构（daemon 单写者 + 单条语句无交错），不是来自 SQL 锁**（Note A）：
- `kernel.ts` 须写明不变量注释「single-writer assumption — claim 原子性依赖它；勿加第二写者」。
- `RETURNING` 需 SQLite ≥3.35，实现时核实 bun:sqlite 版本；不支持则降级为 `db.transaction()` 内
  SELECT-then-UPDATE。
- 测试无法测真并发（无第二写者），改为断言排序（priority DESC, created_at ASC）正确。

**running lease / heartbeat（#3 决议：S0 全实现）**
```ts
heartbeat(taskId, roleId): void        // running 任务续约：写 task.last_heartbeat_at = now()
                                       // 校验 task.claimed_by===roleId 且 status==='running'
```
- running 任务必须周期性 heartbeat 续约（续约逻辑由 S1 runner 调用；S0 实现服务端 + 测试用注入时钟）。
- sweeper 回收 lease 过期的 running：`last_heartbeat_at < now - leaseWindow` →
  `retry_count < maxRetry` 则 `running→assigned`（重派，物化幂等会 re-adopt 同一 worktree，retry_count++）；
  否则 `running→failed`。
- leaseWindow 默认 60_000（可注入），maxRetry 默认 2。

**DAG（#4a 决议：环检测 + 失败级联）**
```ts
createDag(input, tasks, edges): Dag     // 事务建图前【拓扑环检测】，有环抛 CyclicDagError 拒绝
onTaskDone(taskId): void                // 解锁后继（所有 depends_on 已 done → blocked→pending/assigned）
onTaskFailed(taskId): void              // 失败级联：直接/间接后继保持 blocked 并标记，dag.status→failed
                                        // （后继不自动 cancel，留待人/orchestrator 处置；可见 dag failed）
```

**物化（连接 kobe；#2 决议：multiman 单向投影，唯一真相源）**
```ts
materialize(taskId): Promise<{ kobeTaskId: string, worktreePath: string }>
// 幂等物化（Finding 1 决议）：
//   1. 若 task.kobe_task_id 已写 → 快路径返回。
//   2. 否则从 multiman task.id 推出【确定性】branch/worktree 路径（如 branch=`multiman/<taskId>`），
//      调 orchestrator.adoptWorktree({repo, worktreePath, branch, ifExists:'return'})
//      —— adopt-or-return 幂等：崩溃重试会 re-adopt 同一个，不会产生孤儿/重复 worktree。
//   3. 回写 task.kobe_task_id/work_dir。
// 决议：transition(→running) 检测到未物化时内部先调本方法，物化失败则转移失败不留半态。
// runner 循环（子系统 1/5）也可显式调用；本层是唯一物化入口。
// ⚠ 不用 createTask（每次 mint 新 ULID，崩溃重试会建第二个）；必须走确定性 adopt 路径。
//
// #2 真相源契约（单向投影）：multiman 是其托管任务状态的【唯一权威】。
//   - 物化只把 multiman→kobe 投影（建/adopt worktree），【不】读 kobe Task.status 回写 multiman。
//   - kobe 侧状态（如用户 archive/done 那个 kobe task）仅用于展示，绝不反向改 multiman status。
//   - reconcile（轻量、可选）：仅校验 kobe_task_id 指向的 worktree 是否还在；
//     丢失则把 multiman task 标记需重新物化，不改其业务 status。
```

**DAG 门控（机制）**
```ts
createDag(input, tasks, edges): Dag            // 事务建图：tasks 落库，有前驱者置 blocked
onTaskDone(taskId): void                       // transition 到 done 后内部调；解锁后继
                                               // 对每个 to: 若其所有 from 都 done → blocked->(pending|assigned)
```

**role / inbox / schedule / asset**：本层提供直白 CRUD（create/get/list/update/mark/attach/detach），
策略留给上层。签名见 `rpc.ts` 路由表。

### 5.3 事件

每次写操作后 `publish(kind, payload)`，kind 如 `task.created` / `task.transitioned` /
`task.claimed` / `inbox.pushed`。daemon 把它转成 `bus.publish("multiman", {kind, payload})`，
订阅了 `multiman` channel 的 client/runner 收到。这给子系统 5 的 TUI 实时刷新和 runner 唤醒铺路。

---

## 6. IPC 契约（`rpc.ts` + kobe daemon 改动）

### 6.1 信封

kobe `DaemonRequestName` 加一个值 `"multiman"`。请求 payload：
```ts
{ method: string; params?: unknown }
```
daemon `dispatch` 里：
```ts
case "multiman": return kernel.handle(req.payload.method, req.payload.params)
```
`kernel.handle(method, params)` 内部是一张方法路由表 + 每方法 `zod`/手写校验（kobe 无 zod，
用与 kobe 一致的手写 `requireString/optional*` 风格，避免引依赖）。非法方法/入参抛 `DaemonError`
（沿用 kobe 错误包裹）。

事件：kobe `ChannelPayloads` 加
```ts
"multiman": { kind: string; payload: unknown }
```
`CHANNEL_NAMES` 加 `"multiman"`，订阅重放机制自动覆盖。

### 6.2 方法清单（method 名 → 入参 → 出参）

```
task.create   {title, body?, roleId?, priority?, repo?, source?, deps?:string[]}  -> Task
task.get      {id}                                   -> Task|null
task.list     {status?, roleId?, dagId?}             -> Task[]
task.transition {id, to, reason?}                    -> Task
task.claim    {roleId}                               -> Task|null
task.report   {id, status, result?, error?, sessionId?} -> Task

role.create   {name, kind, instructions?, vendor?, model?}  -> Role
role.get/list/update ...                             -> Role / Role[]

dag.create    {title?, tasks:[...], edges:[{from,to}]}  -> Dag
dag.get       {id}                                   -> {dag, tasks, edges}

# --- 以下 method 在 S0 不实现（表已建，CRUD/RPC 随子系统 2/4 落地）---
# inbox.push/list/claim/mark        -> 子系统 2
# schedule.create/list/update/enable/runNow -> 子系统 2
# asset.create/list/attach/detach   -> 子系统 4
```

> **D1 决议**：S0 只实现 `task.*` / `role.*` / `dag.create|get` 的 RPC。`inbox.*` / `schedule.*` /
> `asset.*` 表已在 001 建好，但 RPC + CRUD + worker 全部留给其拥有的子系统（2/4）。

---

## 7. 后台 worker（本层只做 sweeper）

`startSweeper(kernel, {intervalMs=30_000})`，按 kobe worker 模式（`setInterval` + `.unref()` +
skip-overlapping + 返回 stop 函数 + `close()` 清理）。每 tick：

- **claim 超时**：`claimed` 且 `claimed_at < now - recoveryWindow` → `transition(claimed→assigned, "claim timeout")`。
- **running lease 过期（#3）**：`running` 且 `last_heartbeat_at < now - leaseWindow` →
  `retry_count<maxRetry` 则 `running→assigned`（retry_count++，重派；物化幂等 re-adopt），否则 `running→failed`。

`scheduler` 后台循环留给子系统 2；`dag-gater` 的**门控函数**（`kernel.onTaskDone`/`onTaskFailed`）
本层实现并在 `transition→done`/`→failed` 时同步调用。

---

## 8. CLI（M0 验收面）

`kobe multiman <sub>`，薄客户端：连 daemon socket，发 `request("multiman", {method, params})`，打印结果。

```
kobe multiman role create --name backend --kind worker [--instructions ...]
kobe multiman role list
kobe multiman task create --title "..." [--role backend] [--repo /path]
kobe multiman task list [--status pending]
kobe multiman task assign <taskId> --role backend         # transition pending->assigned
kobe multiman task transition <taskId> --to running
kobe multiman task get <taskId>
```

---

## 9. 测试计划（vitest，对应规则 9）

- **state-machine.test.ts**：转移表全覆盖——每个合法转移 `canTransition` 真、每个非法（尤其
  `done↔failed`、从终态出发）假。编码「为什么」：如「claimed→running 必须先有 kobe_task_id」
  在 kernel 测里验证守卫。
- **dao.test.ts**（`:memory:`）：建表 + 各表 CRUD + CHECK 约束生效（写非法枚举应抛）+ 外键级联。
- **enum-sync.test.ts**（Finding 2）：types.ts 用 const 数组定义枚举（`TaskStatus` 由其推导）；
  本测试读 sqlite schema 里各 CHECK 的 `IN (...)` 取值，逐一与对应 TS 数组比对，不一致则失败
  ——防 TS/SQL 枚举漂移。CHECK 仍保留在 001.sql 做 DB 层防护。
- **kernel.test.ts**（`:memory:` + fake orchestrator + 注入 `now`）：
  - `claimNextTask` 原子性：两次连续 claim 不会拿到同一 task；按 priority/created_at 排序。
  - DAG 门控：A→B 边，B 初始 blocked；A done 后 B 自动 pending。
  - sweeper：claimed 超 recoveryWindow 后回 assigned（用注入时钟推进）。
  - **running lease（#3）**：running 任务 heartbeat 续约后不被回收；超 leaseWindow 未续约 →
    retry_count<max 回 assigned 且 retry_count++；达 max → failed（注入时钟）。
  - **DAG 环检测（#4a）**：createDag 收含环的 edges → 抛 CyclicDagError，不建任何 task（事务回滚）。
  - **失败级联（#4a）**：A→B，A failed → onTaskFailed 使 B 保持 blocked、dag.status=failed。
  - transition 守卫：指派给 disabled role 抛错。
  - 物化：transition(→running) 未物化时调 materialize（fake orchestrator 验证被调、kobe_task_id 回写）；
    materialize 失败时 transition 抛错且 task 不落 running（无半态）。
  - **物化幂等（Finding 1，强制回归测试）**：
    · materialize 调两次返回同一 kobeTaskId/worktree，不产生第二个（fake orchestrator 断言 adoptWorktree
      被 ifExists:'return' 调用、createTask 未被调用）。
    · 模拟崩溃（kobe_task_id 未回写但 worktree 已存在）后重试 materialize → re-adopt 同一个。
    · transition(→running) 走 adopt 路径而非 createTask（断言确定性 branch=`multiman/<taskId>`）。
- **db.test.ts**（补缺口）：openDb 后 PRAGMA 生效（journal_mode=wal, foreign_keys=on）；
  runMigrations 对空库 → user_version=1；重复 runMigrations 幂等（无副作用、版本不变）。
- **lifetime.test.ts**（#1，socket 集成）：仅 runner 订阅在线时 daemon 不自停；runner 全断但 DB
  有非终态任务时仍不自停；无 runner 且全终态后进入 idle-shutdown grace。
- **rpc.test.ts**：`handle` 入参校验（缺字段抛）、未知 method 抛、正常 method 往返。
- **socket 集成**（沿用 kobe `test:socket` 模式，`KOBE_INCLUDE_SOCKET=1`）：起 daemon、
  `request("multiman", {method:"task.create",...})` 端到端，验证事件 channel `multiman` 能收到 `task.created`。

验收标准（M0 Definition of Done）：
1. `bun run typecheck` + `bun run lint` 通过。
2. 上述单测全绿；socket 集成测试绿。
3. 手动：`kobe multiman role create` → `task create`（带 `--repo`）→ `task assign` → `task claim` →
   `task transition --to running`，该步**真正建出 kobe worktree**（`task.kobe_task_id`/`work_dir` 已写、
   `git worktree list` 可见、对应 kobe Task 出现在 `kobe` 任务列表里）；`task list` 反映状态；
   DB 文件 `~/.kobe/multiman.db` 存在且可被第二个 client 经 RPC 读到一致结果。

---

## 10. 已决议的关键点 + 残余风险

**已决议（review 拍板）**
- **物化硬性要求（claimed→running 必须先物化）**：`transition(→running)` 守卫硬性要求 `kobe_task_id`
  已写。为让 M0 无 runner 也能验收，`kernel.transition` 检测到目标态 `running` 且尚未物化时，
  **内部先调 `materialize(taskId)`**（建 kobe worktree+tmux、回写 `kobe_task_id`/`work_dir`），
  成功后才落 `running`；物化失败则转移失败并抛错（不留半态）。
  → 推论：**M0 范围包含 kobe 物化链路**（orchestrator.createTask + ensureWorktree 接通），
  验收必须真正建出 worktree。
- **读写一律走 RPC**：runner/CLI/TUI 不直连 DB；所有读写经 daemon RPC，保单一真相源 + 事件一致性。
  只读直连 DB 作为后续性能优化，本层不做。

**残余风险**
- **kobe 协议改动面**：仅 +1 请求名 +1 channel，低风险；确保 `protocolVersion` 对老 client 兼容
  （老 client 不发 multiman 请求即可，无需 bump 不兼容版本）。
- **物化失败的清理**：materialize 中途失败（worktree 建了但回写失败等）需保证幂等可重试——
  复用 kobe `ensureWorktree` 的幂等性（已核实：已存在则快路径返回）。
- **ULID 来源**：复用 kobe 现有 ulid 工具（`orchestrator` 里有），避免重复实现。

---

## 11. 实现顺序（交给 writing-plans 细化）

1. 建 package 骨架（package.json/tsconfig/vitest）+ workspace 接线。
2. `db/open.ts` + `migrate.ts` + `001_init.sql`(含 last_heartbeat_at/retry_count) + `dao.ts` + dao/enum-sync/db 测试。
3. `state-machine.ts` + 测试。
4. `kernel.ts`（CRUD → claim → 门控 onTaskDone/onTaskFailed → createDag 环检测 → heartbeat/lease →
   materialize 确定性 adopt + 单向投影）+ 测试。
5. `rpc.ts` 路由 + 校验 + 测试。
6. kobe daemon 接线（protocol/server/sweeper(claimed+running lease) + **daemon 保活 #1**）+ socket/lifetime 集成测试。
7. CLI 子命令 + 手动验收。

---

## 12. Eng Review 报告（plan-eng-review + codex 外部评审, 2026-06-05）

### Codex 外部评审（5 条，全部有效，已收进 spec）
对照 kobe 源码核实后，codex 补了内部评审漏掉的真问题：
- **#1 Critical — daemon 生命周期**：kobe daemon 最后一个 GUI 断开就自停（`server.ts:154-165`），
  无头 runner 撑不住 → 决议 **runner 持 lifetime + 有非终态任务 keepalive，两者都做**。
- **#2 Critical — 脑裂/真相源**：multiman row 与 kobe Task 各有 status，归属未定 → 决议
  **multiman 唯一真相源 + 单向投影，不回写**。
- **#3 High — running lease**：sweeper 只回收 claimed，running 无 lease → 决议 **S0 全实现
  heartbeat 续约 + sweeper 按 lease 回收 running（retry→failed）**。
- **#4a High — DAG 无环检测/失败语义** → 决议 **createDag 拓扑环检测 + onTaskFailed 失败级联**。
- **#4b High — 事件 bus 有损**（last-value replay，会丢事件，戳破内部评审 Note B）→ 决议
  **bus 仅 best-effort 提示，runner 慢轮询兜底，event_log 为持久历史**。

### NOT in scope（考虑过、明确推迟）
- `inbox`/`schedule`/`asset` 的 CRUD/RPC/worker —— 表已建（D1），逻辑随子系统 2/4（schema 不再变）。
- scheduler / dag-gater 的后台**循环** —— S0 只做 sweeper + `onTaskDone` 门控函数；定时循环属子系统 2/3。
- push dispatcher —— 只做 pull claim。
- runner 自动领任务循环、TUI 集成 —— 子系统 1/5。
- 只读直连 DB 优化 —— 一律走 RPC，优化留后。
- 真并发 claim 的运行时锁 —— 单写者架构下不需要（见下风险）。

### What already exists（复用，未重建）
- kobe `orchestrator.adoptWorktree/ensureWorktree/createTask`（物化；adopt-or-return 幂等是 Finding 1 的解）。
- kobe `daemon/server.ts` socket + `DaemonEventBus` + worker 注册/清理模式（sweeper 照搬）。
- kobe `daemon/protocol.ts` 的 frame/dispatch（仅 +1 请求名 +1 channel）。
- kobe ulid 工具、tmux client。
- **唯一新建**：SQLite 层 + 状态机 + kernel + rpc envelope。

### Failure modes（新 codepath × 生产失败场景）
| codepath | 失败场景 | 有测试? | 有错误处理? | 用户可见? |
|----------|---------|--------|-----------|----------|
| materialize | 崩溃中途 → 孤儿 worktree | ✅ (Finding 1 回归测试) | ✅ adopt-or-return 幂等 | 否（已消除） |
| transition | daemon 崩在写库前 | 提交态由 WAL 持久；in-flight RPC 丢 | ✅ client 连接断重试 | 是（连接断，可重试） |
| claimNextTask | 若误加第二写者 → 双领 | ⚠ 无运行时锁 | ⚠ 仅靠 invariant 注释 | **静默** ← 见下 |
| dao insert | 非法枚举 | ✅ CHECK + enum-sync 测试 | ✅ SQLITE_CONSTRAINT（loud） | 是（loud） |
| migrate | 迁移中途失败 | ✅ db.test | ✅ 每迁移包事务 | 是（启动报错） |

**Critical gap（1 个，结构性）**：`claimNextTask` 的原子性依赖「daemon 单写者」架构假设，无运行时锁。
S0 下只有一个写者，安全；但若将来有人加第二个写 DB 的进程，会**静默双领**。缓解：`kernel.ts`
强制 invariant 注释 + roadmap 决策记录「只 daemon 写 DB」。**这是全系统最该守住的不变量**。

### 并行化（实现步骤）
| 步骤 | 模块 | 依赖 |
|------|------|------|
| 1 包骨架+workspace | package | — |
| 2 db(open/migrate/dao) | db/ | 1 |
| 3 state-machine | state-machine.ts | 1 |
| 4 kernel | kernel.ts | 2,3 |
| 5 rpc | rpc.ts | 4 |
| 6 kobe daemon 接线 | kobe daemon/* | 5 |
| 7 CLI+验收 | cli/, client/ | 6 |

- **Lane A**: 步骤 2（db）  ‖  **Lane B**: 步骤 3（state-machine）—— 二者独立可并行。
- 汇合后 4→5→6→7 顺序执行（强依赖链）。并行收益有限（仅 2‖3），其余串行。

### Completion Summary
- Step 0 范围挑战：**scope 调整**（D1：schema 全建、逻辑只填 M0；defer inbox/schedule/asset 的 CRUD/RPC）
- 架构评审：1 finding（materialize 孤儿 worktree → 确定性 adopt 幂等）+ 2 notes（claim 原子性来源、RPC 信封）
- 代码质量：1 finding（枚举单一源 → TS 数组 + 同步测试）+ 1 note（DAO DRY 助手）
- 测试评审：覆盖图产出，4 缺口补入（db/migrate 测试 + materialize 幂等回归 ×3）
- 性能评审：1 note 落地（claim 复合索引）+ 1 note（S1 runner 事件唤醒而非紧轮询）
- Failure modes：1 critical gap 标记（单写者不变量，结构性，靠约定守）
- 并行化：2 lane 并行 + 5 步串行
- 外部评审（codex）：5 条 finding（2 Critical + 3 High），全部有效、已逐条拍板收进 spec
- 未决问题：无（D1 + Finding1/2 + codex #1~#4b 均已拍板）
- 注：codex #4b 推翻了内部评审 Note B（单 channel「S0 够用」的判断），已改为 bus 仅提示 + 轮询兜底
```

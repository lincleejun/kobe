# multiman — 全局拆解 Roadmap

> 在 kobe（终端原生多会话编排器）之上，叠加一套 multica 风格的多角色任务管理 +
> 消息采集/inbox + orchestrator DAG 拆分 + 资产管理，最终以「多终端协作」形态运行。

日期：2026-06-05 · 状态：草案，待 review

## 0. 决策记录（已拍板，不再讨论）

1. **形态**：本地内核 + 嵌入式 SQLite（`bun:sqlite`，零新依赖）。扩展 kobe daemon 作唯一本地
   协调者；**不**引入 Go server / Postgres / web 前端。
2. **多终端语义**：**两者都要** —— role-runner 常驻进程（自动领任务）+ TUI client（人旁观/干预）。
   推论：runner 与 client 共用同一套 IPC API，内核契约必须先定死（子系统 0）。
3. **代码位置**：在 **kobe fork** 上做，代码 + 设计文档都进 kobe 仓库。
   - `origin` = 上游 `Sma1lboy/kobe`（推不回，不动它）。
   - `lincleejun` = 自己的 fork `github.com/lincleejun/kobe.git`（推这里）。
   - 工作分支 `multiman`（基于 `main`），推到 `lincleejun`。
   - 新代码以 kobe monorepo 内新增 package 形式落地，函数级复用 daemon/orchestrator/tmux/types。

---

## 1. 设计依据（来自对 kobe / multica 的核实）

**kobe（地基，复用）**
- 技术栈：Bun + TypeScript + Solid/opentui TUI。
- 核心抽象：`Task = git worktree + tmux session + branch`；状态 `backlog/in_progress/in_review/done/canceled/error`。
- 架构：`daemon`（长驻，事件总线 + unix socket + pidfile）与 `TUI client`（多个）分离；
  IPC = 行分隔 JSON-RPC（frame: `request/response/event`，`switch(req.name)` 派发）。
- 持久化：`~/.kobe/tasks.json`（原子写 tmp+rename，lockfile 多进程安全）；**无任何 SQLite/DB 依赖**。
- 缺口（multiman 要补）：role、cron/schedule、inbox、DAG 拆分、asset 管理。

**multica（概念模型来源，不照搬技术栈）**
- 角色多态 actor：`member / agent / squad`（`actor_type + actor_id`）。
- 任务状态机：`queued→dispatched→running→completed/failed/cancelled`（+ `waiting_local_directory`）。
- inbox（`inbox_item`：kind/severity/read/archived）+ 订阅机制。
- 调度 autopilot：`schedule(cron)/webhook/api` 三 trigger + server sweeper 每 30s 扫；执行落 `autopilot_run`。
- 资产：`skill + agent_skill + agent.mcp_config`，daemon 启动 CLI 前注入到 provider 目录。
- DAG：multica **没有**真正 DAG，用 parent-child issue + dependency 近似 —— multiman 在这里**做真 DAG**。

---

## 2. 目标形态

```
~/.kobe/multiman.db   (SQLite: role, task, dag, dag_edge, inbox_item,
                        schedule, schedule_run, asset, role_asset, event_log)
        ▲
   kobe daemon (扩展)
     ├─ 协调内核 Kernel        : 状态机 / 派发 / DAG 门控
     ├─ 后台 worker            : sweeper / scheduler(cron) / dag-gater
     └─ IPC API (JSON-RPC over unix socket, 复用 kobe 协议)
        │
   ┌────┼──────────────┬───────────────────┐
   role-runner      role-runner          TUI client(人)
   (terminal A)     (terminal B)         (terminal C)
   orchestrator     worker:frontend      旁观 / 干预 / 点开任务
   自动领任务         自动领任务            = 正常 kobe task (worktree+tmux)
```

- multiman `task` 进入 `running` 时**物化为一个 kobe Task**（worktree+tmux+branch），
  `task.kobe_task_id` 双向关联。「点开就是正常 kobe task」= TUI client 打开该 kobe task 的 panes。
- role-runner = 常驻进程循环：`task.claim` → 物化/attach kobe task → 驱动 engine → `task.report`。

---

## 3. 子系统分解

按依赖排序；每个子系统是独立的 spec → plan → 实现循环。

| # | 子系统 | 依赖 | 职责一句话 |
|---|--------|------|-----------|
| **0** | **数据层 + 协调内核 + IPC API** | kobe daemon | SQLite schema、任务状态机、Kernel、socket 上的 RPC —— 所有子系统的地基与契约 |
| **1** | **Role & 任务指派 + 状态迁移** | 0 | role CRUD、assignee、claim/report、状态机执行、与 kobe Task 的物化映射 |
| **2** | **Inbox + 采集（schedule/cron）** | 0 | scheduler 定时跑 collector role/workflow → 投递 inbox_item → 消费策略 |
| **3** | **Orchestrator（DAG 拆分）** | 0,1,2 | 基于 prompt 把 inbox_item 拆成 task DAG → pending 池 → 判别分配给 role |
| **4** | **Asset 管理（skills / MCP）** | 0 | 资产目录 + 关联到 role + 运行前注入到 provider 目录 |
| **5** | **多终端运行形态** | 0,1 | role-runner 常驻进程 + TUI client（旁观/干预），共享内核协调 |

**构建顺序与并行**：0 先做（阻塞全部）→ 1 / 2 / 4 可并行 → 5（需 1）→ 3（最复杂，需 0,1,2）。

---

## 4. 统一数据模型（SQLite，架构级草图）

> 子系统 0 spec 给列级 DDL；这里只定表与关系。

- **role** — `id, name, kind(orchestrator|worker|collector), instructions, vendor, model, status, created_at`
- **task** — `id, title, body, role_id(assignee, nullable), status, priority, parent_task_id,
  dag_id, kobe_task_id, session_id, work_dir, source_kind(manual|inbox|orchestrator),
  source_ref, result, error, claimed_by, claimed_at, timestamps`
- **dag** — `id, title, source_inbox_item_id, orchestrator_role_id, status, created_at`
- **dag_edge** — `dag_id, from_task_id, to_task_id, type(depends_on)`
- **inbox_item** — `id, source(schedule_id|role_id), kind, payload(json), severity(action|attention|info),
  status(new|claimed|processed|archived), consumed_by, created_at`
- **schedule** — `id, name, trigger_kind(cron|webhook|manual), cron_expr, timezone,
  target_kind(role|workflow), target_ref, execution_mode(collect|run_only),
  concurrency_policy(skip|queue|replace), next_run_at, last_run_at, enabled`
- **schedule_run** — `id, schedule_id, status(pending|running|done|failed|skipped),
  started_at, finished_at, produced_inbox_item_id, error`
- **asset** — `id, kind(skill|mcp), name, version, spec(json), path`
- **role_asset** — `role_id, asset_id`（m2m）
- **event_log** — append-only：`id, actor_kind, actor_id, action, target_kind, target_id, details(json), ts`

---

## 5. 任务状态机（统一 kobe + multica）

```
            orchestrator 产出 / 手动建
                     │
                  pending ──(无依赖或依赖已满足且指派)──► assigned
                     ▲                                      │
        dag 依赖满足 │                                claim │
                  blocked ◄──(有未完成 depends_on)──┐      ▼
                     │                              │   claimed ──(recovery window)
                     │                              │      │ runner 物化 kobe task
                     │                              │      ▼
                     └──────────────────────────── running
                                                    │
                              ┌──────────┬──────────┼──────────┐
                              ▼          ▼          ▼          ▼
                          in_review    done      failed    cancelled
```

- **pending**：在 pending 池，未指派或已指派未领。orchestrator 的拆分结果落这里。
- **blocked**：DAG 中有未完成 `depends_on` 前驱（或等待本地 worktree 锁，对应 `waiting_local_directory`）。
- **claimed**：role-runner 已领（dispatched），sweeper 监控 recovery window 防僵死。
- **running**：物化为 kobe Task（worktree+tmux）执行中。
- **in_review / done / failed / cancelled**：终态（in_review 可被人/orchestrator 推进到 done/failed）。
- **门控规则（dag-gater）**：任一 task→`done` 时，解锁后继：`blocked`→（`pending` 或 `assigned`）。

---

## 6. 内核 IPC API（脊柱，子系统 0 定死）

复用 kobe daemon 的 JSON-RPC over unix socket。为最小化对 kobe 核心协议的改动，所有 multiman
方法走**单一命名空间信封**：请求名 `"multiman"`，payload `{method, params}`，daemon 路由到
`kernel.handle(method, params)`；事件走单一新增 channel `"multiman"`，payload `{kind, payload}`。

方法分组（`method` 取值）：

- **task**：`create, get, list(filter), update, transition(id,to,reason), claim(role_id)→task,
  report(id,status,result|error)`
- **role**：`create, get, list, update, register_runtime(role_id,terminal_id), heartbeat`
- **inbox**：`push(item), list(filter), claim(consumer)→item, mark(id,status)`
- **schedule**：`create, list, update, enable(id,bool), run_now(id)`
- **dag / orchestrator**：`orchestrator.submit(inbox_item_id), dag.create(tasks,edges), dag.get(id)`
- **asset**：`create, list, attach(role_id,asset_id), detach(role_id,asset_id)`

**派发模型**：默认 **pull**（runner 主动 `task.claim`，天然多进程安全 + 背压）；先不做 push dispatcher。

---

## 7. daemon 后台 worker

- **sweeper**：回收过了 recovery window 仍 `claimed`/`running` 的僵死任务；过期超长 pending。
- **scheduler**：每 N 秒扫 `schedule.next_run_at` 到期行 → 跑 collector role/workflow → 投 `inbox_item` →
  记 `schedule_run`；遵守 `concurrency_policy`。
- **dag-gater**：监听 task→done 事件，解锁后继 `blocked`→`pending/assigned`。

（均按 kobe 现有 worker 模式：`startDaemonServer()` 注册、返回 stop 函数、`close()` 清理、`timer.unref()`。）

---

## 8. 与 kobe 的集成点（已核实签名）

| multiman 需要 | kobe 现有（file） | 做法 |
|---------------|------------------|------|
| 物化执行环境 | `orchestrator/core.ts` `createTask`/`ensureWorktree`/`setStatus` | task→running 时建 worktree+tmux，存 `kobe_task_id` |
| 长驻协调进程 | `daemon/server.ts` `startDaemonServer` + 事件总线 + socket | daemon 内挂载 Kernel + worker + RPC handler |
| RPC 信封 | `daemon/protocol.ts` `DaemonRequestName` 联合 + `dispatch` switch | 新增请求名 `"multiman"` + channel `"multiman"`，路由进 kernel |
| 「点开 = 正常 kobe task」 | TUI `tui/app.tsx` 5-pane | TUI client 按 `kobe_task_id` 打开既有 panes |
| 资产注入 | engine adapter 读 provider 目录 | runner 启动 engine 前把 skill/mcp 写到 `.claude/skills/`、mcp config |

---

## 9. 里程碑

- **M0**：子系统 0 —— SQLite schema + Kernel + IPC API + 最小 sweeper。CLI 可建 role/task、手动 transition。
- **M1**：子系统 1 + 5（pull 模型）—— role-runner 自动领任务、物化 kobe task、report；TUI client 旁观。
- **M2**：子系统 2 + 4 —— cron 采集投 inbox；资产注入 role 运行时。
- **M3**：子系统 3 —— orchestrator 读 inbox、prompt 驱动 DAG 拆分、落 pending 池、判别分配。

---

## 10. 明确不做（YAGNI）

- 不做 web/desktop/mobile 前端。
- 不做远端 server / Postgres / 多机分布式（保留 SQLite→远端同步的边界，不实现）。
- 不做 webhook trigger（先只 cron + manual）。
- 不做 squad/团队多租户（单用户本地）。
- 不做 push dispatcher（先只 pull claim）。
- 不推 `origin`（上游），只推 `lincleejun`。

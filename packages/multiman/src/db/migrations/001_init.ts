// src/db/migrations/001_init.ts
// Authoritative migration SQL embedded as a TS module so it survives bundling
// in consumers (e.g. kobe's dist) — readFileSync(import.meta.url) breaks there.
export const INIT_SQL = `-- role：执行单元（orchestrator / worker / collector）
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
`

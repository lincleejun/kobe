// src/db/migrations/002_comment.ts
// Version-2 migration: comment/message model for the interactive console (S6).
// Applies on top of an existing v1 db (PRAGMA user_version). See 001_init.ts.
export const COMMENT_SQL = `CREATE TABLE comment (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('human','role','system')),
  author_id   TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_comment_task ON comment(task_id, created_at);
`

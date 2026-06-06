import type { Database } from "bun:sqlite"
import { INIT_SQL } from "./migrations/001_init"

interface Migration {
  version: number
  sql: string
}
const MIGRATIONS: Migration[] = [{ version: 1, sql: INIT_SQL }]

export function runMigrations(db: Database): void {
  const cur = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
  for (const m of MIGRATIONS) {
    if (m.version <= cur) continue
    const tx = db.transaction(() => {
      db.exec(m.sql)
      db.run(`PRAGMA user_version = ${m.version}`)
    })
    tx()
  }
}

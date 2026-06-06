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
      db.exec(sql)
      db.run(`PRAGMA user_version = ${m.version}`)
    })
    tx()
  }
}

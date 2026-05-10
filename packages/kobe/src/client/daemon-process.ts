import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultDaemonSocketPath } from "../daemon/paths.ts"
import { KobeDaemonClient } from "./index.ts"

export async function connectOrStartDaemon(): Promise<KobeDaemonClient> {
  const socketPath = defaultDaemonSocketPath()
  const client = new KobeDaemonClient(socketPath)
  if (await canConnect(client)) return client

  const entry = resolveKobedEntry()
  const child = spawn(process.execPath, [entry, "start"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  })
  child.unref()

  const deadline = Date.now() + 5000
  let lastErr: unknown
  while (Date.now() < deadline) {
    const next = new KobeDaemonClient(socketPath)
    try {
      await next.connect()
      return next
    } catch (err) {
      lastErr = err
      next.close()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(
    `kobe: daemon did not start at ${socketPath}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
}

async function canConnect(client: KobeDaemonClient): Promise<boolean> {
  try {
    await client.connect()
    return true
  } catch {
    client.close()
    return false
  }
}

function resolveKobedEntry(): string {
  const here = fileURLToPath(import.meta.url)
  const dir = dirname(here)
  const sourceEntry = resolve(dir, "../bin/kobed.ts")
  if (existsSync(sourceEntry)) return sourceEntry
  const distEntry = join(dirname(process.argv[1] ?? here), "bin", "kobed.js")
  if (existsSync(distEntry)) return distEntry
  return join(process.cwd(), "dist", "bin", "kobed.js")
}

#!/usr/bin/env bun
import { KobeDaemonClient } from "../client/index.ts"
import { createKobeCore } from "../core/index.ts"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "../daemon/paths.ts"
import { readPidFile, startDaemonServer } from "../daemon/server.ts"

async function main(): Promise<void> {
  const [, , command = "status"] = process.argv
  const socketPath = defaultDaemonSocketPath()
  const pidPath = defaultDaemonPidPath()

  if (command === "status") {
    const client = new KobeDaemonClient(socketPath)
    try {
      const status = await client.request<Record<string, unknown>>("daemon.status")
      console.log(JSON.stringify(status, null, 2))
    } catch {
      const pid = await readPidFile(pidPath)
      if (pid) console.log(`kobed: no daemon socket at ${socketPath} (stale pidfile pid=${pid})`)
      else console.log(`kobed: no daemon running at ${socketPath}`)
      process.exitCode = 1
    } finally {
      client.close()
    }
    return
  }

  if (command === "stop") {
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.request("daemon.stop")
      console.log("kobed: stop requested")
    } finally {
      client.close()
    }
    return
  }

  if (command === "restart") {
    const oldPid = await readPidFile(pidPath)
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.request("daemon.stop")
    } catch {
      // Missing daemon is fine; start below owns the final state.
    } finally {
      client.close()
    }
    // Poll the old daemon's pid until it's actually gone before we
    // start the new server. A fixed sleep (the previous 150ms) raced
    // against `server.close()` finishing on the old daemon and would
    // hit EADDRINUSE on `server.listen(socketPath)` whenever the
    // shutdown took longer than the sleep. `kill -0 pid` throws ESRCH
    // (process gone) — that's our signal to proceed.
    if (oldPid && oldPid !== process.pid) {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        try {
          process.kill(oldPid, 0)
          await new Promise((resolve) => setTimeout(resolve, 25))
        } catch {
          break
        }
      }
    }
  } else if (command !== "start") {
    console.error("usage: kobed start|stop|status|restart")
    process.exit(2)
  }

  const core = await createKobeCore()
  const server = await startDaemonServer(core.orchestrator, {
    socketPath,
    pidPath,
    homeDir: core.homeDir,
    onStop: async () => {
      await core.close()
    },
  })
  console.log(`kobed: listening on ${server.socketPath}`)

  const shutdown = async () => {
    await server.close()
    await core.close()
    process.exit(0)
  }
  process.once("SIGINT", () => void shutdown())
  process.once("SIGTERM", () => void shutdown())
}

main().catch((err) => {
  console.error("kobed failed:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})

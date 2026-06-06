// test/daemon.socket.test.ts
//
// Task 19 — automated daemon socket integration test (multiman over kobe's
// unix socket). The crucial thing this PROVES is "materialize-on-running": a
// multiman task transitioning to `running` materializes a REAL kobe git
// worktree on disk — the "点开就是正常 kobe task" claim.
//
// Bring-up approach: IN-PROCESS (Option B). We construct a real kobe core via
// `createKobeCore` (the same construction `cli/daemon-cmd.ts` uses) against a
// throwaway `KOBE_HOME_DIR`, then `startDaemonServer(core.orchestrator, …)` on
// a temp socket path, and drive it with a real `KobeDaemonClient`. The daemon
// mounts the multiman kernel in-process and tunnels `request("multiman", …)`
// straight to it (server.ts dispatch). In-process beats spawning `kobe daemon`
// here because the daemon's npm entry is the BUILT `dist/cli/index.js` (not
// present in a source checkout), and an in-process server gives deterministic
// teardown — no orphaned subprocess + socket to chase. We import kobe via its
// `src/*.ts` paths (the package ships no exports map; the workspace symlink at
// node_modules/@sma1lboy/kobe makes the src tree resolvable from bun).
//
// Gated by KOBE_INCLUDE_SOCKET=1 (mirrors kobe's KOBE_INCLUDE_SOCKET socket
// pool) so the default `bun test` run never touches sockets / a real ~/.kobe.
// Run: cd packages/multiman && KOBE_INCLUDE_SOCKET=1 bun test test/daemon.socket.test.ts

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { KobeDaemonClient } from "@sma1lboy/kobe/src/client/index.ts"
import { type KobeCore, createKobeCore } from "@sma1lboy/kobe/src/core/index.ts"
import { type DaemonServer, startDaemonServer } from "@sma1lboy/kobe/src/daemon/server.ts"

const ENABLED = process.env.KOBE_INCLUDE_SOCKET === "1"

interface Task {
  id: string
  status: string
  repo: string | null
  role_id: string | null
  kobe_task_id: string | null
  work_dir: string | null
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return predicate()
}

// describe.if so the whole suite is cleanly skipped (not failed) when the gate
// is off. The bring-up inside beforeAll never runs in that case.
describe.if(ENABLED)("daemon socket — multiman passthrough + materialize", () => {
  let homeDir: string
  let repoDir: string
  let socketPath: string
  let pidPath: string
  let core: KobeCore
  let server: DaemonServer
  let gui: KobeDaemonClient

  beforeAll(async () => {
    // Unique throwaway home — the real ~/.kobe is never touched.
    homeDir = mkdtempSync(join(tmpdir(), "mm-sock-home-"))
    repoDir = mkdtempSync(join(tmpdir(), "mm-sock-repo-"))
    socketPath = join(homeDir, "daemon.sock")
    pidPath = join(homeDir, "daemon.pid")

    // A real git repo with HEAD — adoptWorktree validates the worktree against
    // it, so it must have at least one commit.
    git(repoDir, "init", "-q")
    git(repoDir, "config", "user.email", "test@example.com")
    git(repoDir, "config", "user.name", "Multiman Test")
    execFileSync("git", ["-C", repoDir, "commit", "-q", "--allow-empty", "-m", "init"], { encoding: "utf8" })

    core = await createKobeCore({ homeDir })
    server = await startDaemonServer(core.orchestrator, {
      socketPath,
      pidPath,
      homeDir,
      // Disable background pollers — keep the test deterministic.
      updatePollMs: 0,
      autoTitlePollMs: 0,
    })

    gui = new KobeDaemonClient(socketPath)
    await gui.request("hello")
  }, 30_000)

  afterAll(async () => {
    gui?.close()
    await server?.close().catch(() => {})
    await core?.close().catch(() => {})
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  const mm = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    gui.request<T>("multiman", { method, params })

  // 1. task.create returns a Task with status "pending".
  it("task.create returns a pending task", async () => {
    const task = await mm<Task>("task.create", { title: "x" })
    expect(task.id).toBeTruthy()
    expect(task.status).toBe("pending")
  })

  // 2. The "multiman" channel delivers a {kind:"task.created"} event.
  //
  // Caveat: kobe's bus caches ONE last-value per channel and replays it on
  // subscribe; multiple creates race to be that last value. So we subscribe
  // FIRST, then create, and assert we observe a task.created for OUR task —
  // accepting any later event for the same channel as long as the create lands.
  it("publishes a task.created event on the multiman channel", async () => {
    const seen: Array<{ kind: string; payload: Task }> = []
    const sub = new KobeDaemonClient(socketPath)
    sub.onChannel("multiman" as never, (p) => seen.push(p as { kind: string; payload: Task }))
    await sub.subscribe({ role: "pane" })

    const task = await mm<Task>("task.create", { title: "evented" })

    const got = await until(() => seen.some((e) => e.kind === "task.created" && e.payload?.id === task.id), 2_000)
    expect(got).toBe(true)
    const ev = seen.find((e) => e.kind === "task.created" && e.payload?.id === task.id)
    expect(ev?.payload.status).toBe("pending")
    sub.close()
  })

  // 3. Lifetime: a runner subscriber holds the daemon alive. We can robustly
  // observe this via daemon.status's client/holder accounting after a gui
  // disconnects — the runner is still counted as a lifetime holder, so the
  // socket stays up (no idle self-stop is armed while a holder remains).
  it("a runner subscription holds the daemon alive after a gui disconnects", async () => {
    const runner = new KobeDaemonClient(socketPath)
    await runner.subscribe({ role: "runner" })

    const transient = new KobeDaemonClient(socketPath)
    await transient.subscribe({ role: "gui" })
    transient.close()

    // The runner keeps a lifetime hold → the daemon must NOT have torn down
    // its socket after the gui left (give any grace timer time to NOT fire).
    await new Promise((r) => setTimeout(r, 250))
    expect(existsSync(socketPath)).toBe(true)

    // And the daemon is still answering requests through the runner socket.
    const status = await runner.request<Record<string, unknown>>("daemon.status")
    expect(status).toBeTruthy()

    runner.close()
  })

  // 4. MATERIALIZE — the whole point. running ⇒ a real kobe git worktree on disk.
  it("transitioning a task to running materializes a real kobe worktree", async () => {
    const role = await mm<{ id: string }>("role.create", { name: "builder", kind: "worker" })
    expect(role.id).toBeTruthy()

    const created = await mm<Task>("task.create", {
      title: "materialize-me",
      roleId: role.id,
      repo: repoDir,
    })
    expect(created.repo).toBe(repoDir)

    await mm<Task>("task.transition", { id: created.id, to: "assigned", roleId: role.id })
    const claimed = await mm<Task | null>("task.claim", { roleId: role.id })
    expect(claimed?.id).toBe(created.id)

    // kobe's adoptWorktree ADOPTS an existing git worktree — it never runs
    // `git worktree add`. In production the runner (or a kobe hook) creates the
    // worktree on disk at the deterministic path the kernel computes, then
    // materialize-on-running adopts it. Mirror that: create the worktree at
    // `<repo>/.claude/worktrees/<taskId>` on `multiman/<taskId>` before the
    // running transition. (kernel.test.ts asserts the same "adopts, not
    // creates" contract with a fake orchestrator.)
    const expectedWorktree = join(repoDir, ".claude", "worktrees", created.id)
    git(repoDir, "worktree", "add", "-b", `multiman/${created.id}`, expectedWorktree, "HEAD")

    const running = await mm<Task>("task.transition", { id: created.id, to: "running" })

    // DB row reflects materialization.
    expect(running.status).toBe("running")
    expect(running.kobe_task_id).toBeTruthy()
    expect(running.work_dir).toBeTruthy()
    // kobe canonicalizes the worktree path via realpathSync on adopt
    // (/var → /private/var on macOS), so compare against the canonical form.
    const canonWorktree = realpathSync(expectedWorktree)
    expect(running.work_dir).toBe(canonWorktree)

    // A re-fetch through the socket sees the same persisted state.
    const fetched = await mm<Task>("task.get", { id: created.id })
    expect(fetched.kobe_task_id).toBe(running.kobe_task_id)
    expect(fetched.work_dir).toBe(canonWorktree)

    // The worktree actually exists on disk.
    expect(existsSync(expectedWorktree)).toBe(true)
    expect(existsSync(join(expectedWorktree, ".git"))).toBe(true)

    // …and git itself knows about it.
    const wtList = git(repoDir, "worktree", "list")
    expect(wtList).toContain(realpathSync(expectedWorktree))

    // The branch was created as multiman/<taskId>.
    const branchAtWt = git(expectedWorktree, "rev-parse", "--abbrev-ref", "HEAD")
    expect(branchAtWt).toBe(`multiman/${created.id}`)

    // Surface the evidence in the test log for the M0 acceptance record.
    // eslint-disable-next-line no-console
    console.log(
      `[materialize] taskId=${created.id} kobe_task_id=${running.kobe_task_id} work_dir=${running.work_dir}\n` +
        `git worktree list:\n${wtList}`,
    )
  }, 30_000)
})

import { homedir } from "node:os"
import { ClaudeCodeLocal } from "../engine/claude-code-local/index.ts"
import { type BridgeHandles, startBridge } from "../orchestrator/bridge/index.ts"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import type { AIEngine } from "../types/engine.ts"

export interface KobeCoreOptions {
  readonly homeDir?: string
  readonly engine?: AIEngine
  readonly startMcpBridge?: boolean
}

export interface KobeCore {
  readonly homeDir: string
  readonly orchestrator: Orchestrator
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
  readonly bridge: BridgeHandles | null
  close(): Promise<void>
}

export async function createKobeCore(options: KobeCoreOptions = {}): Promise<KobeCore> {
  const homeDir = options.homeDir ?? process.env.KOBE_HOME_DIR ?? homedir()
  const store = new TaskIndexStore({ homeDir })
  await store.load()

  const worktrees = new GitWorktreeManager()
  const engine = options.engine ?? new ClaudeCodeLocal()
  const orchestrator = new Orchestrator({ engine, store, worktrees })
  const bridge = options.startMcpBridge === false ? null : await startBridge(orchestrator, { homeDir })

  return {
    homeDir,
    orchestrator,
    store,
    worktrees,
    bridge,
    async close() {
      await bridge?.close()
      orchestrator.dispose()
    },
  }
}

/**
 * Bootstrap the orchestrator bridge: bind a Unix-socket RPC server
 * for the running orchestrator, write an MCP config that points
 * spawned `claude` processes at `kobe mcp-bridge`, and export
 * `KOBE_MCP_CONFIG` so the engine's `buildArgs` automatically
 * appends `--mcp-config <path>` to every spawn.
 *
 * Layout under `${homeDir}/.kobe/run/`:
 *   bridge-<pid>.sock      Unix socket the bridge subprocess connects to
 *   mcp-<pid>.json         claude's MCP config JSON
 *
 * Files are pid-scoped so two concurrent kobe processes don't trample
 * each other. The first call wins the env var; nested kobe instances
 * (a kobe-spawned task that itself runs kobe) inherit the parent's
 * bridge — sub-spawn agents see the same tool surface, which is the
 * desired behavior for now (no recursion guard yet).
 */

import { writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Orchestrator } from "../core.ts"
import { type BridgeServer, startBridgeServer } from "./server.ts"

export interface StartBridgeOpts {
  readonly homeDir?: string
}

export interface BridgeHandles {
  readonly socketPath: string
  readonly mcpConfigPath: string
  close(): Promise<void>
}

export async function startBridge(orch: Orchestrator, opts: StartBridgeOpts = {}): Promise<BridgeHandles> {
  const home = opts.homeDir ?? process.env.KOBE_HOME_DIR ?? homedir()
  const runDir = join(home, ".kobe", "run")
  const socketPath = join(runDir, `bridge-${process.pid}.sock`)
  const mcpConfigPath = join(runDir, `mcp-${process.pid}.json`)

  const server: BridgeServer = await startBridgeServer(orch, socketPath)

  // The mcp-bridge subcommand only exists in the `kobe` CLI entry
  // (src/cli/index.ts → dist/cli/index.js), not in `kobed`. Resolve
  // it relative to this module so the config is correct regardless
  // of who called startBridge — kobed daemon, TUI no-daemon path, or
  // test fixtures. Extension follows our own (`.ts` in dev, `.js` in
  // the built bundle), keyed off import.meta.url. process.argv[1] is
  // unsafe here: when kobed calls startBridge, argv[1] points at
  // kobed.ts which has no mcp-bridge handler. See KOB-54.
  const moduleExt = import.meta.url.endsWith(".ts") ? ".ts" : ".js"
  const entry = fileURLToPath(new URL(`../../cli/index${moduleExt}`, import.meta.url))
  const mcpConfig = {
    mcpServers: {
      kobe: {
        command: process.execPath,
        args: [entry, "mcp-bridge", `--socket=${socketPath}`],
      },
    },
  }
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8")
  process.env.KOBE_MCP_CONFIG = mcpConfigPath

  return {
    socketPath,
    mcpConfigPath,
    async close() {
      await server.close()
    },
  }
}

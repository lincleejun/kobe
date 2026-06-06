// src/assets.ts
// Pure mapping from a role's assets to the files to write into a task's worktree
// BEFORE the runner launches the engine. No I/O here — the kobe executor writes
// the returned files. See multiman-runner-cmd.ts for the call site.
import type { Asset } from "./types"

/** A file to materialize into the worktree. `path` is relative to the worktree root. */
export interface AssetFile {
  path: string
  content: string
}

/** Parse asset.spec (JSON text) defensively; returns {} on malformed input. */
function parseSpec(spec: string): Record<string, unknown> {
  try {
    const v = JSON.parse(spec)
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** One MCP server definition (the value side of `.mcp.json`'s mcpServers map). */
interface McpServerDef {
  command: string
  args?: unknown[]
  env?: Record<string, unknown>
}

/**
 * Compute the files to write for a role's assets:
 *   - skill → `.claude/skills/<name>/SKILL.md` from spec.content.
 *   - mcp   → merged into ONE `.mcp.json` = { mcpServers: { <name>: {command,args,env} } }.
 *
 * Malformed / incomplete assets are skipped (a skill without content, an mcp
 * without a command) — never throws, so one bad asset can't sink the batch.
 */
export function assetFiles(assets: Asset[]): AssetFile[] {
  const files: AssetFile[] = []
  const mcpServers: Record<string, McpServerDef> = {}

  for (const a of assets) {
    const spec = parseSpec(a.spec)
    if (a.kind === "skill") {
      const content = spec.content
      if (typeof content !== "string" || content.length === 0) continue
      files.push({ path: `.claude/skills/${a.name}/SKILL.md`, content })
    } else if (a.kind === "mcp") {
      const command = spec.command
      if (typeof command !== "string" || command.length === 0) continue
      const def: McpServerDef = { command }
      if (Array.isArray(spec.args)) def.args = spec.args
      if (spec.env && typeof spec.env === "object") def.env = spec.env as Record<string, unknown>
      mcpServers[a.name] = def
    }
  }

  if (Object.keys(mcpServers).length > 0) {
    files.push({ path: ".mcp.json", content: JSON.stringify({ mcpServers }, null, 2) })
  }
  return files
}

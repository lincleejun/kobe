/**
 * User slash-command discovery — runtime scan for the user's own
 * `.claude/{commands,skills}/` content.
 *
 * Ported from
 * `refs/vibe-kanban/crates/executors/src/executors/claude/slash_commands.rs`
 * (Rust → TS, same shape: `extract_description`, `scan_dir`,
 * `scan_base_path`, `discover_custom_command_descriptions`). The static
 * built-in manifest at `./builtin-slashes.ts` covers what ships with
 * claude-code; this module fills in the user's own additions.
 *
 * Lookup paths, project-first so project entries win on name collision:
 *
 *   1. `<worktreePath>/.claude/commands/*.md`
 *   2. `<worktreePath>/.claude/skills/<name>/SKILL.md`
 *   3. `~/.claude/commands/*.md`
 *   4. `~/.claude/skills/<name>/SKILL.md`
 *
 * Each `.md` must start with frontmatter:
 *
 *     ---
 *     description: One-line summary
 *     ---
 *     <prompt body>
 *
 * Files without frontmatter or without `description:` still register
 * (their name is the file basename / skill folder name) but render with
 * an empty description in the dropdown — matching what claude-code
 * itself does at runtime.
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { BuiltinSlash } from "./builtin-slashes"

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * Pull the `description:` value out of YAML frontmatter. Mirror of
 * `ClaudeCode::extract_description` (Rust). Returns null when the file
 * has no frontmatter, no closing `---`, or no `description:` key.
 */
function extractDescription(content: string): string | null {
  if (!content.startsWith("---")) return null
  const end = content.slice(3).indexOf("---")
  if (end < 0) return null
  const frontmatter = content.slice(3, 3 + end)
  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim()
    if (line.startsWith("description:")) {
      return line.slice("description:".length).trim()
    }
  }
  return null
}

async function tryReadDescription(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf-8")
    return extractDescription(content)
  } catch {
    return null
  }
}

async function scanCommandsDir(dir: string): Promise<BuiltinSlash[]> {
  const entries = await safeReaddir(dir)
  const out: BuiltinSlash[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const full = join(dir, entry)
    if (!(await isFile(full))) continue
    const name = entry.slice(0, -3) // strip .md
    const description = (await tryReadDescription(full)) ?? ""
    out.push({ name, description })
  }
  return out
}

async function scanSkillsDir(dir: string): Promise<BuiltinSlash[]> {
  const entries = await safeReaddir(dir)
  const out: BuiltinSlash[] = []
  for (const entry of entries) {
    const sub = join(dir, entry)
    if (!(await isDir(sub))) continue
    const skillMd = join(sub, "SKILL.md")
    if (!(await isFile(skillMd))) continue
    const description = (await tryReadDescription(skillMd)) ?? ""
    out.push({ name: entry, description })
  }
  return out
}

/**
 * Scan one `.claude` root for both commands and skills, returning a
 * deduplicated list (skills lose to commands on name collision since we
 * spread commands second — matches vibe-kanban's HashMap.extend order).
 */
async function scanBasePath(claudeDir: string): Promise<BuiltinSlash[]> {
  const [skills, commands] = await Promise.all([
    scanSkillsDir(join(claudeDir, "skills")),
    scanCommandsDir(join(claudeDir, "commands")),
  ])
  const map = new Map<string, BuiltinSlash>()
  for (const e of skills) map.set(e.name, e)
  for (const e of commands) map.set(e.name, e)
  return [...map.values()]
}

/**
 * Discover the user's slash commands + skills, project paths first.
 * Project entries win on name collision so a repo-local `/deploy.md`
 * shadows a global `~/.claude/commands/deploy.md`.
 *
 * Errors are swallowed silently — a missing dir, an unreadable file, or
 * malformed frontmatter must never break the composer's slash dropdown
 * (the dropdown still has built-ins to fall back on). Same posture as
 * claude-code itself — see refs/claude-code/src/utils/markdownConfigLoader.ts.
 */
export async function loadUserSlashes(worktreePath?: string): Promise<readonly BuiltinSlash[]> {
  const projectScan = worktreePath ? scanBasePath(join(worktreePath, ".claude")) : Promise.resolve([])
  const globalScan = scanBasePath(join(homedir(), ".claude"))
  const [project, global] = await Promise.all([projectScan, globalScan])
  // Project precedence: spread global first so project overrides on collision.
  const map = new Map<string, BuiltinSlash>()
  for (const e of global) map.set(e.name, e)
  for (const e of project) map.set(e.name, e)
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

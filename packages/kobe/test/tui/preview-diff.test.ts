/**
 * Unit tests for preview/diff.ts — focused on the git-toplevel resolution
 * fix (KOB-19): when a "main" task points at a subdirectory of a git
 * repo, FileTree emits toplevel-relative paths but `cat` / `git diff`
 * default to cwd-relative — without resolution they ENOENT and the UI
 * shows "file not found (rebased away?)".
 *
 * Each test creates a real on-disk git repo with the shape:
 *
 *   <root>/.git/
 *   <root>/top-level.md           (committed, then modified)
 *   <root>/sub/                    ← we point worktreePath here
 *
 * and asserts that calling readFile/readDiff/isPathChanged with
 * `worktreePath = <root>/sub` and `relPath = top-level.md` (toplevel-
 * relative) resolves correctly via the git-toplevel walk-up.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isPathChanged, readDiff, readFile } from "@/tui/panes/preview/diff"

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" })
}

describe("readFile / readDiff / isPathChanged with subdir worktreePath (KOB-19)", () => {
  let root: string
  let sub: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kobe-diff-test-"))
    sub = join(root, "sub")
    mkdirSync(sub, { recursive: true })
    git(["init", "-q", "-b", "main"], root)
    git(["config", "user.email", "test@kobe"], root)
    git(["config", "user.name", "kobe-test"], root)
    git(["config", "commit.gpgsign", "false"], root)
    writeFileSync(join(root, "top-level.md"), "v1\n")
    git(["add", "top-level.md"], root)
    git(["commit", "-q", "-m", "initial"], root)
    writeFileSync(join(root, "top-level.md"), "v1\nv2\n")
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("readFile resolves a toplevel-relative path even when worktreePath points at a subdir", async () => {
    const r = await readFile(sub, "top-level.md")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe("v1\nv2\n")
  })

  it("readDiff against HEAD returns the unified diff for a toplevel-relative path from a subdir cwd", async () => {
    const r = await readDiff(sub, "HEAD", "top-level.md")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain("--- a/top-level.md")
      expect(r.text).toContain("+++ b/top-level.md")
      expect(r.text).toContain("+v2")
    }
  })

  it("isPathChanged sees the modified file from the subdir cwd", async () => {
    const changed = await isPathChanged(sub, "top-level.md")
    expect(changed).toBe(true)
  })

  it("worktree-style cwd (worktreePath == toplevel) still works without regression", async () => {
    // The pre-existing behavior — for normal task worktrees the cwd
    // already IS the toplevel. Resolution should be a no-op there.
    const r = await readFile(root, "top-level.md")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe("v1\nv2\n")
  })

  it("non-git cwd falls back to cwd itself (no crash)", async () => {
    // If the cwd isn't inside a git repo, `git rev-parse --show-toplevel`
    // exits non-zero. Resolver must fall back to cwd; readFile then
    // returns the file as-is.
    const nonGit = mkdtempSync(join(tmpdir(), "kobe-non-git-"))
    try {
      writeFileSync(join(nonGit, "plain.txt"), "hello\n")
      const r = await readFile(nonGit, "plain.txt")
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.text).toBe("hello\n")
    } finally {
      rmSync(nonGit, { recursive: true, force: true })
    }
  })
})

// Sanity-check: confirm the underlying git invariant the fix relies on —
// `git status --porcelain` from a subdir emits toplevel-relative paths,
// not cwd-relative. If git ever changed this, our resolver would produce
// the wrong cwd (toplevel) for a path FileTree had already emitted in
// cwd-relative form.
describe("git invariant guard", () => {
  it("git status --porcelain from a subdir reports paths relative to repo toplevel", () => {
    const root = mkdtempSync(join(tmpdir(), "kobe-git-invariant-"))
    try {
      const sub = join(root, "sub")
      mkdirSync(sub)
      git(["init", "-q", "-b", "main"], root)
      git(["config", "user.email", "test@kobe"], root)
      git(["config", "user.name", "kobe-test"], root)
      git(["config", "commit.gpgsign", "false"], root)
      writeFileSync(join(root, "top.md"), "x")
      git(["add", "top.md"], root)
      git(["commit", "-q", "-m", "initial"], root)
      writeFileSync(join(root, "top.md"), "x changed")
      const r = spawnSync("git", ["status", "--porcelain"], {
        cwd: sub,
        encoding: "utf8",
        shell: false,
      })
      expect(r.status).toBe(0)
      // toplevel-relative ("top.md"), not cwd-relative ("../top.md")
      expect(r.stdout.trim()).toMatch(/^\s*M\s+top\.md$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

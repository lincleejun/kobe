/**
 * Unit tests for `listSessionsForCwd` + `extractFirstUserMessage`.
 *
 * Same shape as `history.test.ts` — write real JSONL files under a
 * tmpdir, point the impl at it via DI, assert. No mocks.
 *
 * Why we test this layer separately from `history.ts`: the picker UI
 * leans on the engine to produce a *summary* per session (preview +
 * mtime + count) without reading every record. If `extractFirstUserMessage`
 * mis-skips a `<command-name>` wrapper or a multi-block content array,
 * the picker shows wrong rows — and there's no other place to catch
 * that until a user notices the wrong preview at runtime.
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extractFirstUserMessage, listSessionsForCwd } from "@/engine/claude-code-local/sessions"
import { describe, expect, it } from "vitest"

describe("extractFirstUserMessage", () => {
  it("returns plain string content", () => {
    const lines = [JSON.stringify({ message: { role: "user", content: "hello world" } })]
    expect(extractFirstUserMessage(lines)).toBe("hello world")
  })

  it("concatenates text blocks from a content-block array", () => {
    const lines = [
      JSON.stringify({
        message: {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "tool_use", id: "x", name: "y", input: {} },
            { type: "text", text: "second" },
          ],
        },
      }),
    ]
    expect(extractFirstUserMessage(lines)).toBe("first second")
  })

  it("skips command-tag wrapper records", () => {
    const lines = [
      JSON.stringify({ message: { role: "user", content: "<command-name>/cost</command-name>" } }),
      JSON.stringify({ message: { role: "user", content: "real prompt" } }),
    ]
    expect(extractFirstUserMessage(lines)).toBe("real prompt")
  })

  it("skips Caveat: system-injected lines", () => {
    const lines = [
      JSON.stringify({ message: { role: "user", content: "Caveat: this is a notice" } }),
      JSON.stringify({ message: { role: "user", content: "the real one" } }),
    ]
    expect(extractFirstUserMessage(lines)).toBe("the real one")
  })

  it("skips assistant-only sessions", () => {
    const lines = [JSON.stringify({ message: { role: "assistant", content: "no user here" } })]
    expect(extractFirstUserMessage(lines)).toBeNull()
  })

  it("truncates with ellipsis at PREVIEW_MAX_CHARS=200", () => {
    const huge = "a".repeat(500)
    const lines = [JSON.stringify({ message: { role: "user", content: huge } })]
    const out = extractFirstUserMessage(lines)
    expect(out).not.toBeNull()
    expect(out!.endsWith("…")).toBe(true)
    expect(out!.length).toBeLessThanOrEqual(200)
  })

  it("returns null for an empty file", () => {
    expect(extractFirstUserMessage([])).toBeNull()
  })

  it("tolerates malformed JSON lines and keeps scanning", () => {
    const lines = ["not json {", JSON.stringify({ message: { role: "user", content: "after the bad line" } })]
    expect(extractFirstUserMessage(lines)).toBe("after the bad line")
  })
})

describe("listSessionsForCwd", () => {
  it("lists every JSONL in the encoded-cwd directory, newest first", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kobe-sessions-"))
    const cwd = "/proj/demo"
    const projectDir = path.join(root, "-proj-demo")
    mkdirSync(projectDir)

    writeFileSync(
      path.join(projectDir, "sess-old.jsonl"),
      `${JSON.stringify({ message: { role: "user", content: "older one" } })}\n`,
    )
    writeFileSync(
      path.join(projectDir, "sess-new.jsonl"),
      `${JSON.stringify({ message: { role: "user", content: "newer one" } })}\n`,
    )
    // Force the mtime delta — write order isn't guaranteed to differ
    // by enough on fast filesystems.
    const oldT = Date.now() / 1000 - 3600
    const newT = Date.now() / 1000
    utimesSync(path.join(projectDir, "sess-old.jsonl"), oldT, oldT)
    utimesSync(path.join(projectDir, "sess-new.jsonl"), newT, newT)

    const out = await listSessionsForCwd(cwd, {
      projectsDir: () => root,
      readdir: async (p) => (await import("node:fs/promises")).readdir(p),
      readFile: async (p) => (await import("node:fs/promises")).readFile(p, "utf8"),
      stat: async (p) => {
        const s = await (await import("node:fs/promises")).stat(p)
        return { mtimeMs: s.mtimeMs }
      },
    })

    expect(out.map((s) => s.sessionId)).toEqual(["sess-new", "sess-old"])
    expect(out[0]?.firstUserMessage).toBe("newer one")
    expect(out[1]?.firstUserMessage).toBe("older one")
    expect(out[0]?.messageCount).toBe(1)
  })

  it("returns [] when the cwd has no project dir", async () => {
    // Default deps swallow ENOENT in readdir (see sessions.ts:46-50);
    // the production contract is "missing project dir → empty list".
    // Mirror that here so we exercise the contract, not a degenerate
    // mock that re-throws.
    const root = mkdtempSync(path.join(tmpdir(), "kobe-sessions-empty-"))
    const out = await listSessionsForCwd("/no/such/place", {
      projectsDir: () => root,
      readdir: async (p) => {
        try {
          return await (await import("node:fs/promises")).readdir(p)
        } catch {
          return []
        }
      },
      readFile: async (p) => (await import("node:fs/promises")).readFile(p, "utf8"),
      stat: async (p) => {
        const s = await (await import("node:fs/promises")).stat(p)
        return { mtimeMs: s.mtimeMs }
      },
    })
    expect(out).toEqual([])
  })
})

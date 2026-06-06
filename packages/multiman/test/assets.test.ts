// test/assets.test.ts
import { describe, expect, it } from "bun:test"
import { type AssetFile, assetFiles } from "@/assets"
import type { Asset } from "@/types"

function asset(p: Partial<Asset> & Pick<Asset, "kind" | "name" | "spec">): Asset {
  return {
    id: p.id ?? "a",
    kind: p.kind,
    name: p.name,
    version: p.version ?? "0.1.0",
    spec: p.spec,
    path: p.path ?? null,
    created_at: p.created_at ?? "2026-06-05T00:00:00.000Z",
  }
}

function byPath(files: AssetFile[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.path, f.content]))
}

describe("assetFiles", () => {
  it("maps one skill to SKILL.md at the right path with its content", () => {
    const files = assetFiles([asset({ kind: "skill", name: "summarize", spec: '{"content":"# Summarize\\nbody"}' })])
    expect(files).toEqual([{ path: ".claude/skills/summarize/SKILL.md", content: "# Summarize\nbody" }])
  })

  it("merges two mcp assets into one .mcp.json with both servers", () => {
    const files = assetFiles([
      asset({ kind: "mcp", name: "fs", spec: '{"command":"npx","args":["fs"],"env":{"K":"v"}}' }),
      asset({ kind: "mcp", name: "git", spec: '{"command":"git-mcp"}' }),
    ])
    expect(files.length).toBe(1)
    expect(files[0]!.path).toBe(".mcp.json")
    const parsed = JSON.parse(files[0]!.content)
    expect(parsed).toEqual({
      mcpServers: {
        fs: { command: "npx", args: ["fs"], env: { K: "v" } },
        git: { command: "git-mcp" },
      },
    })
  })

  it("handles a mix of skills and mcp", () => {
    const files = assetFiles([
      asset({ kind: "skill", name: "s1", spec: '{"content":"c1"}' }),
      asset({ kind: "mcp", name: "m1", spec: '{"command":"run-m1"}' }),
    ])
    const m = byPath(files)
    expect(m[".claude/skills/s1/SKILL.md"]).toBe("c1")
    expect(JSON.parse(m[".mcp.json"]!)).toEqual({ mcpServers: { m1: { command: "run-m1" } } })
  })

  it("skips malformed/incomplete assets without throwing", () => {
    const files = assetFiles([
      asset({ kind: "skill", name: "no-content", spec: "{}" }),
      asset({ kind: "skill", name: "bad-json", spec: "not json" }),
      asset({ kind: "mcp", name: "no-command", spec: '{"args":[]}' }),
      asset({ kind: "skill", name: "good", spec: '{"content":"ok"}' }),
    ])
    expect(files).toEqual([{ path: ".claude/skills/good/SKILL.md", content: "ok" }])
  })

  it("omits .mcp.json entirely when there are no mcp assets", () => {
    const files = assetFiles([asset({ kind: "skill", name: "s1", spec: '{"content":"c"}' })])
    expect(files.some((f) => f.path === ".mcp.json")).toBe(false)
  })
})

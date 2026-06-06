// test/decompose-parse.test.ts
import { describe, expect, it } from "bun:test"
import { parseDecomposeOutput } from "@/decompose-parse"

describe("parseDecomposeOutput", () => {
  it("parses clean JSON", () => {
    const text = JSON.stringify({
      tasks: [
        { key: "a", title: "A", roleName: "backend" },
        { key: "b", title: "B" },
      ],
      edges: [["a", "b"]],
    })
    const r = parseDecomposeOutput(text)
    expect(r.tasks).toEqual([
      { key: "a", title: "A", roleName: "backend" },
      { key: "b", title: "B" },
    ])
    expect(r.edges).toEqual([["a", "b"]])
  })

  it("parses JSON inside a ```json fence", () => {
    const text = ["Here is the plan:", "```json", '{"tasks":[{"key":"a","title":"A"}],"edges":[]}', "```"].join("\n")
    const r = parseDecomposeOutput(text)
    expect(r.tasks).toEqual([{ key: "a", title: "A" }])
    expect(r.edges).toEqual([])
  })

  it("parses JSON inside a bare ``` fence", () => {
    const text = ["```", '{"tasks":[{"key":"a","title":"A"}]}', "```"].join("\n")
    const r = parseDecomposeOutput(text)
    expect(r.tasks).toEqual([{ key: "a", title: "A" }])
    expect(r.edges).toEqual([])
  })

  it("tolerates prose around the JSON object", () => {
    const text = 'Sure! I think this decomposition works:\n{"tasks":[{"key":"x","title":"X"}],"edges":[]}\nLet me know.'
    const r = parseDecomposeOutput(text)
    expect(r.tasks).toEqual([{ key: "x", title: "X" }])
  })

  it("defaults edges to [] when absent", () => {
    const r = parseDecomposeOutput('{"tasks":[{"key":"a","title":"A"}]}')
    expect(r.edges).toEqual([])
  })

  it("carries optional fields (body, repo, priority)", () => {
    const text = '{"tasks":[{"key":"a","title":"A","body":"do","roleName":"r","repo":"p","priority":3}],"edges":[]}'
    const r = parseDecomposeOutput(text)
    expect(r.tasks[0]).toEqual({ key: "a", title: "A", body: "do", roleName: "r", repo: "p", priority: 3 })
  })

  it("drops edges referencing an unknown key (does not throw)", () => {
    const text = '{"tasks":[{"key":"a","title":"A"},{"key":"b","title":"B"}],"edges":[["a","b"],["a","zzz"],["q","b"]]}'
    const r = parseDecomposeOutput(text)
    expect(r.edges).toEqual([["a", "b"]])
  })

  it("throws when tasks missing", () => {
    expect(() => parseDecomposeOutput('{"edges":[]}')).toThrow()
  })

  it("throws when tasks empty", () => {
    expect(() => parseDecomposeOutput('{"tasks":[],"edges":[]}')).toThrow()
  })

  it("throws when a task is missing key/title", () => {
    expect(() => parseDecomposeOutput('{"tasks":[{"title":"A"}]}')).toThrow()
    expect(() => parseDecomposeOutput('{"tasks":[{"key":"a"}]}')).toThrow()
  })

  it("throws on malformed / no JSON object", () => {
    expect(() => parseDecomposeOutput("not json at all")).toThrow()
    expect(() => parseDecomposeOutput("{not valid json}")).toThrow()
    expect(() => parseDecomposeOutput("")).toThrow()
  })
})

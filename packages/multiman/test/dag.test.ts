// test/dag.test.ts
import { describe, it, expect } from "bun:test"
import { hasCycle } from "@/dag"

describe("hasCycle", () => {
  it("false for a DAG", () => {
    expect(hasCycle(["a", "b", "c"], [["a", "b"], ["b", "c"]])).toBe(false)
  })
  it("true for a 2-node cycle", () => {
    expect(hasCycle(["a", "b"], [["a", "b"], ["b", "a"]])).toBe(true)
  })
  it("true for a 3-node cycle", () => {
    expect(hasCycle(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]])).toBe(true)
  })
})

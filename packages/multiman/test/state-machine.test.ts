// test/state-machine.test.ts
import { describe, expect, it } from "bun:test"
import { InvalidTransitionError } from "@/errors"
import { assertTransition, canTransition } from "@/state-machine"

describe("state machine", () => {
  it("allows the core happy path", () => {
    expect(canTransition("pending", "assigned")).toBe(true)
    expect(canTransition("assigned", "claimed")).toBe(true)
    expect(canTransition("claimed", "running")).toBe(true)
    expect(canTransition("running", "in_review")).toBe(true)
    expect(canTransition("in_review", "done")).toBe(true)
  })
  it("allows blocked gating and lease recovery edges", () => {
    expect(canTransition("blocked", "pending")).toBe(true)
    expect(canTransition("claimed", "assigned")).toBe(true) // claim timeout
    expect(canTransition("running", "assigned")).toBe(true) // lease expiry re-dispatch
  })
  it("forbids done<->failed flip and exits from terminal", () => {
    expect(canTransition("done", "failed")).toBe(false)
    expect(canTransition("failed", "done")).toBe(false)
    expect(canTransition("done", "running")).toBe(false)
    expect(canTransition("cancelled", "pending")).toBe(false)
  })
  it("allows failed->pending retry and any-nonterminal->cancelled", () => {
    expect(canTransition("failed", "pending")).toBe(true)
    expect(canTransition("running", "cancelled")).toBe(true)
    expect(canTransition("pending", "cancelled")).toBe(true)
  })
  it("assertTransition throws on illegal", () => {
    expect(() => assertTransition("done", "failed")).toThrow(InvalidTransitionError)
  })
})

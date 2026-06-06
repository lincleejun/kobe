// test/cron.test.ts
import { describe, expect, it } from "bun:test"
import { nextRun } from "@/cron"

describe("cron nextRun", () => {
  it("'* * * * *' -> next minute", () => {
    expect(nextRun("* * * * *", "2026-06-05T00:00:00.000Z")).toBe("2026-06-05T00:01:00.000Z")
  })
  it("'* * * * *' rolls minute even with seconds present", () => {
    expect(nextRun("* * * * *", "2026-06-05T00:00:30.000Z")).toBe("2026-06-05T00:01:00.000Z")
  })
  it("'*/5 * * * *' -> next 5-min boundary", () => {
    expect(nextRun("*/5 * * * *", "2026-06-05T00:02:00.000Z")).toBe("2026-06-05T00:05:00.000Z")
    expect(nextRun("*/5 * * * *", "2026-06-05T00:05:00.000Z")).toBe("2026-06-05T00:10:00.000Z")
  })
  it("'0 * * * *' -> next top of hour", () => {
    expect(nextRun("0 * * * *", "2026-06-05T00:30:00.000Z")).toBe("2026-06-05T01:00:00.000Z")
  })
  it("'0 9 * * 1' -> next Monday 09:00 UTC", () => {
    // 2026-06-05 is a Friday; next Monday is 2026-06-08
    expect(nextRun("0 9 * * 1", "2026-06-05T00:00:00.000Z")).toBe("2026-06-08T09:00:00.000Z")
  })
  it("supports ranges and lists", () => {
    // minutes 0,30 ; hours 8-9
    expect(nextRun("0,30 8-9 * * *", "2026-06-05T07:59:00.000Z")).toBe("2026-06-05T08:00:00.000Z")
    expect(nextRun("0,30 8-9 * * *", "2026-06-05T08:00:00.000Z")).toBe("2026-06-05T08:30:00.000Z")
    expect(nextRun("0,30 8-9 * * *", "2026-06-05T09:30:00.000Z")).toBe("2026-06-06T08:00:00.000Z")
  })
  it("throws on a malformed expr (wrong field count)", () => {
    expect(() => nextRun("* * * *", "2026-06-05T00:00:00.000Z")).toThrow()
  })
  it("throws on a malformed expr (non-numeric field)", () => {
    expect(() => nextRun("x * * * *", "2026-06-05T00:00:00.000Z")).toThrow()
  })
  it("throws on out-of-range value", () => {
    expect(() => nextRun("99 * * * *", "2026-06-05T00:00:00.000Z")).toThrow()
  })
})

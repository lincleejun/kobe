/**
 * The canonical example behavior test.
 *
 * Goal: prove the harness end-to-end on the 0.1-scaffold binary.
 * If this test passes, the load-bearing claim of Stream 0.4 holds:
 *   "An agent can run `bun run test:behavior` and have it spawn the
 *   kobe binary, drive it with keystrokes, capture the visible
 *   screen, and assert on visible state."
 *
 * Every subsequent stream's behavior test should follow the same
 * shape: spawn → wait → assert → exit.
 */

import { afterEach, expect, test } from "vitest"
import { type KobeHandle, spawnKobe } from "./driver"

let kobe: KobeHandle | null = null

afterEach(async () => {
  // Defensive: even if the test threw, we never want a zombie pty.
  if (kobe && !kobe.closed) {
    await kobe.exit()
  }
  kobe = null
})

test("kobe boots and renders its title in the bordered box", async () => {
  kobe = await spawnKobe()
  // The 0.1 scaffold renders a `<box title="kobe — booting" border>` —
  // we only assert on the substrings that survive ANSI stripping.
  // The em-dash `—` is part of the title; pinning to two short
  // tokens (`kobe` and `booting`) keeps the assertion robust to
  // future title tweaks while still proving the TUI repainted.
  const screen = await kobe.waitFor((s) => s.includes("kobe") && s.includes("booting"), 10_000)
  expect(screen).toContain("kobe")
  expect(screen).toContain("booting")
  // Phase-0.1 hint text in the body should also be visible.
  expect(screen).toContain("Phase 0.1 scaffold")
  await kobe.exit()
  expect(kobe.closed).toBe(true)
}, 20_000)

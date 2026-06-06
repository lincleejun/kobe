import type { MultimanKernel } from "@/kernel"

export function startSweeper(kernel: MultimanKernel, opts: { intervalMs?: number } = {}): () => void {
  const intervalMs = opts.intervalMs ?? 30_000
  if (intervalMs <= 0) return () => {}
  let running = false
  const tick = () => {
    if (running) return // skip overlapping ticks
    running = true
    try {
      kernel.sweep()
    } catch (e) {
      console.error("[multiman] sweep error", e)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}

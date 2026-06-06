// src/cron.ts
// Minimal standard 5-field cron (minute hour day-of-month month day-of-week),
// minute granularity, UTC. Supports '*', '*/n', ranges 'a-b', lists 'a,b,c' and
// combinations. Pure: given an expr and an ISO instant, returns the next matching
// ISO timestamp (millisecond-zeroed, 'Z'). Throws on a malformed expr.

interface FieldSpec {
  min: number
  max: number
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0 = Sunday)
]

// Parse one field into the set of allowed integer values.
function parseField(raw: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>()
  for (const part of raw.split(",")) {
    if (part.length === 0) throw new Error(`cron: empty field part in "${raw}"`)
    let range = part
    let step = 1
    const slash = part.indexOf("/")
    if (slash !== -1) {
      range = part.slice(0, slash)
      const stepStr = part.slice(slash + 1)
      step = Number(stepStr)
      if (!Number.isInteger(step) || step <= 0) throw new Error(`cron: invalid step "${part}"`)
    }
    let lo: number
    let hi: number
    if (range === "*") {
      lo = spec.min
      hi = spec.max
    } else if (range.includes("-")) {
      const [a, b] = range.split("-")
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(range)
      hi = lo
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`cron: non-numeric field "${part}"`)
    if (lo < spec.min || hi > spec.max || lo > hi) throw new Error(`cron: out-of-range field "${part}"`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

interface ParsedCron {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
}

function parse(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`cron: expected 5 fields, got ${fields.length} in "${expr}"`)
  return {
    minute: parseField(fields[0]!, FIELDS[0]!),
    hour: parseField(fields[1]!, FIELDS[1]!),
    dom: parseField(fields[2]!, FIELDS[2]!),
    month: parseField(fields[3]!, FIELDS[3]!),
    dow: parseField(fields[4]!, FIELDS[4]!),
  }
}

// Standard cron day-matching: if both DOM and DOW are restricted (not '*'),
// the minute matches when EITHER matches. Here we detect "restricted" as not
// covering the full range.
function isWildcard(set: Set<number>, spec: FieldSpec): boolean {
  return set.size === spec.max - spec.min + 1
}

export function nextRun(expr: string, afterIso: string): string {
  const p = parse(expr)
  const afterMs = Date.parse(afterIso)
  if (Number.isNaN(afterMs)) throw new Error(`cron: invalid after timestamp "${afterIso}"`)

  const domWild = isWildcard(p.dom, FIELDS[2]!)
  const dowWild = isWildcard(p.dow, FIELDS[4]!)

  // Start at the next whole minute strictly after `after`.
  const start = new Date(afterMs)
  start.setUTCSeconds(0, 0)
  start.setUTCMinutes(start.getUTCMinutes() + 1)

  const cap = 366 * 24 * 60 // minutes to scan before giving up
  const cur = new Date(start.getTime())
  for (let i = 0; i < cap; i++) {
    const matchDom = p.dom.has(cur.getUTCDate())
    const matchDow = p.dow.has(cur.getUTCDay())
    // both restricted -> OR; otherwise AND with the non-wildcard one(s).
    const dayOk = domWild && dowWild ? true : domWild ? matchDow : dowWild ? matchDom : matchDom || matchDow
    if (
      p.minute.has(cur.getUTCMinutes()) &&
      p.hour.has(cur.getUTCHours()) &&
      p.month.has(cur.getUTCMonth() + 1) &&
      dayOk
    ) {
      return cur.toISOString()
    }
    cur.setUTCMinutes(cur.getUTCMinutes() + 1)
  }
  throw new Error(`cron: no matching time within a year for "${expr}"`)
}

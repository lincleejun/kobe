/**
 * Minimal Crockford-base32 ULID implementation.
 *
 * Copied from packages/kobe/src/orchestrator/index/ulid.ts because that file
 * is internal to kobe (not exported from its public API). Adding an npm
 * dependency just for a ~80-line utility would be overkill.
 *
 * A ULID is a 26-character, lexicographically sortable identifier:
 *   - 10 chars of 48-bit timestamp (ms since epoch), high-order first.
 *   - 16 chars of 80-bit randomness.
 */

/** Crockford base32 alphabet — no I, L, O, U to avoid ambiguity. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const TIME_LEN = 10
const RAND_LEN = 16

/** Last emitted (timestamp_ms, encoded random tail). Drives monotonicity. */
let lastTime = -1
let lastRand: number[] = new Array(RAND_LEN).fill(0)

/**
 * Encode an integer into `len` chars of the Crockford alphabet, MSB first.
 */
function encodeTime(now: number, len: number): string {
  let out = ""
  let n = now
  for (let i = len - 1; i >= 0; i--) {
    const mod = n % 32
    out = ALPHABET[mod] + out
    n = (n - mod) / 32
  }
  return out
}

/** Generate `len` cryptographically random Crockford-alphabet indices. */
function randomIndices(len: number): number[] {
  const buf = new Uint8Array(len)
  crypto.getRandomValues(buf)
  const out: number[] = new Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = (buf[i] ?? 0) & 0x1f
  }
  return out
}

/** Increment a base-32 indices array in place. Returns false on overflow. */
function incrementIndices(indices: number[]): boolean {
  for (let i = indices.length - 1; i >= 0; i--) {
    const v = indices[i] ?? 0
    if (v < 31) {
      indices[i] = v + 1
      return true
    }
    indices[i] = 0
  }
  return false
}

function indicesToString(indices: number[]): string {
  let out = ""
  for (const idx of indices) {
    out += ALPHABET[idx] ?? "0"
  }
  return out
}

/**
 * Generate a fresh ULID string.
 *
 * @param now Optional timestamp override (ms). Tests inject this to make
 *   monotonicity assertions deterministic. Defaults to `Date.now()`.
 */
function ulid(now: number = Date.now()): string {
  let randIndices: number[]
  if (now === lastTime) {
    const next = lastRand.slice()
    if (!incrementIndices(next)) {
      randIndices = randomIndices(RAND_LEN)
    } else {
      randIndices = next
    }
  } else {
    randIndices = randomIndices(RAND_LEN)
  }
  lastTime = now
  lastRand = randIndices
  return encodeTime(now, TIME_LEN) + indicesToString(randIndices)
}

/** Generate a new unique ID (ULID). */
export function genId(): string {
  return ulid()
}

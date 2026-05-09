/**
 * Version check — compares the running build's version against the
 * latest published on the npm registry.
 *
 * Design notes:
 *
 *   - Current version is imported from `package.json` directly (Bun and
 *     TS 5+ both honour the `with { type: "json" }` import attribute).
 *     Single source of truth — bump in package.json, no string sync.
 *
 *   - "Latest" comes from `https://registry.npmjs.org/<name>/latest`.
 *     This endpoint returns *only* the latest dist-tag's manifest, which
 *     is much smaller than the full package metadata. Anonymous, no
 *     auth, generous rate limit.
 *
 *   - Result is cached in `~/.kobe/version-check.json` for 6h. We don't
 *     want to hit the registry on every TUI launch, and we definitely
 *     don't want a slow/offline npm to delay startup. Cache hit on
 *     subsequent runs returns immediately; cache miss fires the network
 *     request with a 3s timeout.
 *
 *   - All failure paths return `null`. Offline, network error, registry
 *     500, parse error — none of them should crash the TUI or surface
 *     a scary banner. Worst case: no update notification this session.
 *
 *   - Update behaviour is *informational only* — see the user request:
 *     "如果有新版本提示更新 暂时不提供更新api". We render a chip; the
 *     user runs the install command themselves.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import pkg from "../package.json" with { type: "json" }

/** Current build's version, read from package.json at compile time. */
export const CURRENT_VERSION: string = pkg.version

/** npm package name we resolve "latest" against. */
export const PACKAGE_NAME: string = pkg.name

/** How long a cached "latest" lookup is considered fresh. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

/** Network timeout for the registry call. */
const FETCH_TIMEOUT_MS = 3_000

export type UpdateInfo = {
  current: string
  latest: string
  hasUpdate: boolean
}

type CacheShape = {
  lastChecked: number
  latest: string
}

function cachePath(): string {
  const home = process.env.KOBE_HOME_DIR ?? homedir()
  return join(home, ".kobe", "version-check.json")
}

async function readCache(): Promise<CacheShape | null> {
  try {
    const raw = await readFile(cachePath(), "utf8")
    const parsed = JSON.parse(raw) as CacheShape
    if (typeof parsed.lastChecked !== "number" || typeof parsed.latest !== "string") return null
    return parsed
  } catch {
    return null
  }
}

async function writeCache(cache: CacheShape): Promise<void> {
  try {
    const path = cachePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cache, null, 2), "utf8")
  } catch {
    /* cache write is best-effort — failure here just means we'll retry next launch */
  }
}

async function fetchLatestFromRegistry(packageName: string): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    // Encode the scope's "/" — registry expects %2F in the path segment.
    const encoded = packageName.replace("/", "%2F")
    const res = await fetch(`https://registry.npmjs.org/${encoded}/latest`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    if (typeof body.version !== "string") return null
    return body.version
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Compare two semver strings — returns true when `latest` is strictly
 * greater than `current`. Handles plain `x.y.z`. Pre-release identifiers
 * (`-rc.1`, `-beta`) are stripped so we don't trigger an "update" chip
 * when the user is intentionally on a pre-release; they can opt back in
 * by bumping past the released version.
 */
export function isNewerSemver(latest: string, current: string): boolean {
  const norm = (v: string) => v.split("-")[0] ?? v
  const a = norm(latest).split(".").map((s) => Number.parseInt(s, 10))
  const b = norm(current).split(".").map((s) => Number.parseInt(s, 10))
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (Number.isNaN(av) || Number.isNaN(bv)) return false
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

/**
 * Resolve the latest published version. Hits the cache first; falls
 * through to the npm registry when the cache is stale or absent.
 *
 * Returns null on any failure (offline, slow network, parse error) so
 * callers can treat "no info" and "no update" as the same UI state.
 *
 * @param opts.force — bypass the cache and always re-query the registry.
 *                     Useful for an explicit "check for updates" command
 *                     once we wire one up.
 */
export async function checkLatestVersion(opts: { force?: boolean } = {}): Promise<UpdateInfo | null> {
  const now = Date.now()

  if (!opts.force) {
    const cached = await readCache()
    if (cached && now - cached.lastChecked < CACHE_TTL_MS) {
      return {
        current: CURRENT_VERSION,
        latest: cached.latest,
        hasUpdate: isNewerSemver(cached.latest, CURRENT_VERSION),
      }
    }
  }

  const latest = await fetchLatestFromRegistry(PACKAGE_NAME)
  if (!latest) return null
  await writeCache({ lastChecked: now, latest })
  return {
    current: CURRENT_VERSION,
    latest,
    hasUpdate: isNewerSemver(latest, CURRENT_VERSION),
  }
}

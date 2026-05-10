/**
 * Lazy branch-name suggestion via a one-shot `claude -p` call.
 *
 * As of KOB-16 the implementation lives on {@link MetadataSuggester}
 * (in `metadata-suggester.ts`); this module is now a thin shim that
 * delegates to a process-wide default instance. Existing callers keep
 * compiling without changes.
 *
 * New code should hold a `MetadataSuggester` instance directly —
 * either the orchestrator's injected one, or a fresh local instance —
 * rather than reaching for the singleton here. Sticking to instance
 * methods keeps the surface testable (fakes can be injected) and
 * future-proof against callers that need scoped config.
 */

import { MetadataSuggester } from "./metadata-suggester.ts"

const defaultSuggester = new MetadataSuggester()

/**
 * Ask claude (`-p`, one-shot) for a kebab-case slug for `prompt`.
 *
 * Returns a slug *without* any `kobe/` prefix or ulid suffix — the
 * caller composes the final branch name. Returns null on any failure
 * (binary missing, prompt empty, claude error, malformed response,
 * timeout).
 *
 * @deprecated Prefer constructing or injecting a {@link MetadataSuggester}
 *   and calling `suggestBranchSlug` on it. This top-level export
 *   stays only so existing imports keep working.
 */
export function suggestBranchSlug(prompt: string): Promise<string | null> {
  return defaultSuggester.suggestBranchSlug(prompt)
}

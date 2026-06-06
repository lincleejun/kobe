import type { DecomposeResult, DecomposedTask } from "./orchestrator"

/**
 * Extract + validate a DAG JSON from an LLM's raw text output.
 *
 * Tolerates prose around the object and ```json (or bare ```) fences. The JSON
 * is located by preferring a fenced block, else the first `{` through its
 * matching last `}`. Validates that `tasks` is a non-empty array of objects
 * each carrying a string `key` and `title` (`body`/`roleName`/`repo`/`priority`
 * optional); `edges` (default `[]`) is an array of `[from, to]` pairs — edges
 * referencing an unknown task key are silently dropped rather than fatal.
 *
 * Throws a clear error when no JSON object can be parsed or `tasks` is
 * missing/empty/malformed, so the orchestrator loop can archive the item.
 */
export function parseDecomposeOutput(text: string): DecomposeResult {
  const jsonText = extractJsonText(text)
  if (jsonText === null) {
    throw new Error("decompose output contains no JSON object")
  }

  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch (e) {
    throw new Error(`decompose output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("decompose output JSON is not an object")
  }
  const obj = raw as Record<string, unknown>

  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    throw new Error("decompose output is missing a non-empty `tasks` array")
  }

  const tasks: DecomposedTask[] = obj.tasks.map((t, i) => parseTask(t, i))
  const keys = new Set(tasks.map((t) => t.key))

  const edges: [string, string][] = []
  if (obj.edges !== undefined) {
    if (!Array.isArray(obj.edges)) throw new Error("`edges` must be an array")
    for (const e of obj.edges) {
      if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || typeof e[1] !== "string") continue
      const [from, to] = e as [string, string]
      // Drop edges that reference a key not present in tasks.
      if (!keys.has(from) || !keys.has(to)) continue
      edges.push([from, to])
    }
  }

  return { tasks, edges }
}

function parseTask(t: unknown, index: number): DecomposedTask {
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    throw new Error(`tasks[${index}] is not an object`)
  }
  const o = t as Record<string, unknown>
  if (typeof o.key !== "string" || o.key.length === 0) {
    throw new Error(`tasks[${index}] is missing a string \`key\``)
  }
  if (typeof o.title !== "string" || o.title.length === 0) {
    throw new Error(`tasks[${index}] is missing a string \`title\``)
  }
  const task: DecomposedTask = { key: o.key, title: o.title }
  if (typeof o.body === "string") task.body = o.body
  if (typeof o.roleName === "string") task.roleName = o.roleName
  if (typeof o.repo === "string") task.repo = o.repo
  if (typeof o.priority === "number") task.priority = o.priority
  return task
}

/**
 * Locate the JSON object text within an LLM response: prefer a fenced block
 * (```json … ``` or bare ``` … ```), else the substring from the first `{`
 * through the last `}`. Returns null when nothing object-like is present.
 */
function extractJsonText(text: string): string | null {
  const fence = matchFence(text)
  if (fence !== null) {
    const inner = fence.trim()
    if (inner.startsWith("{")) return inner
  }
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first === -1 || last === -1 || last < first) return null
  return text.slice(first, last + 1)
}

function matchFence(text: string): string | null {
  const m = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i)
  return m ? (m[1] ?? null) : null
}

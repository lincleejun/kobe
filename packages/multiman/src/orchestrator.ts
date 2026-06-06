import type { InboxItem } from "./types"

export interface DecomposedTask {
  key: string
  title: string
  body?: string
  roleName?: string
  repo?: string
  priority?: number
}

export interface DecomposeResult {
  tasks: DecomposedTask[]
  edges: [string, string][]
}

export interface OrchestratorDeps {
  claimInbox: () => Promise<InboxItem | null>
  decompose: (item: InboxItem) => Promise<DecomposeResult> // LLM planner; injected
  resolveRole: (roleName: string | undefined) => Promise<string | null> // name → roleId, or null if no match
  createDag: (
    info: { title: string; source_inbox_item_id?: string },
    tasks: {
      key: string
      title: string
      body?: string
      role_id?: string | null
      repo?: string | null
      priority?: number
    }[],
    edges: [string, string][],
  ) => Promise<unknown>
  markInbox: (id: string, status: string) => Promise<void>
  waitForWork: () => Promise<void>
  log?: (msg: string) => void
}

// One iteration. Claims an inbox item; if none → waitForWork and return null.
// Otherwise decompose → resolve each task's roleName → role_id → createDag → markInbox(processed).
// Returns the processed item, or null if there was no work. Never throws for normal
// decompose/createDag failures: it archives the item and logs instead, so the loop is safe.
export async function orchestrateOnce(deps: OrchestratorDeps): Promise<InboxItem | null> {
  const item = await deps.claimInbox()
  if (item === null) {
    await deps.waitForWork()
    return null
  }
  deps.log?.(`claimed inbox item ${item.id}`)

  let plan: DecomposeResult
  try {
    plan = await deps.decompose(item)
  } catch (e) {
    deps.log?.(`decompose failed for inbox item ${item.id}: ${String(e)} — archiving`)
    await deps.markInbox(item.id, "archived")
    return item
  }

  if (plan.tasks.length === 0) {
    deps.log?.(`decompose produced no tasks for inbox item ${item.id} — archiving`)
    await deps.markInbox(item.id, "archived")
    return item
  }

  // Resolve role names → role ids. Unmatched (or absent) name → null = unassigned,
  // lands the task pending and awaiting human dispatch.
  const tasks = []
  for (const t of plan.tasks) {
    const role_id = await deps.resolveRole(t.roleName)
    tasks.push({ key: t.key, title: t.title, body: t.body, role_id, repo: t.repo, priority: t.priority })
  }

  try {
    await deps.createDag({ title: item.kind, source_inbox_item_id: item.id }, tasks, plan.edges)
  } catch (e) {
    deps.log?.(`createDag failed for inbox item ${item.id}: ${String(e)} — archiving`)
    await deps.markInbox(item.id, "archived")
    return item
  }

  await deps.markInbox(item.id, "processed")
  deps.log?.(`processed inbox item ${item.id}`)
  return item
}

// Loop until stop() returns true. stop is checked before each claim.
export async function orchestrateLoop(deps: OrchestratorDeps, opts: { stop: () => boolean }): Promise<void> {
  while (!opts.stop()) {
    await orchestrateOnce(deps)
  }
}

// src/dag.ts
// Edge [from, to] means "to depends_on from" (from must finish first).
export function hasCycle(nodes: string[], edges: [string, string][]): boolean {
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]))
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]))
  for (const [from, to] of edges) {
    adj.get(from)!.push(to)
    indeg.set(to, (indeg.get(to) ?? 0) + 1)
  }
  const queue = nodes.filter((n) => (indeg.get(n) ?? 0) === 0)
  let visited = 0
  while (queue.length) {
    const n = queue.shift()!
    visited++
    for (const m of adj.get(n) ?? []) {
      indeg.set(m, indeg.get(m)! - 1)
      if (indeg.get(m) === 0) queue.push(m)
    }
  }
  return visited !== nodes.length
}

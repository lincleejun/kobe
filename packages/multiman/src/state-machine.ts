// src/state-machine.ts
import type { TaskStatus } from "@/types"
import { TERMINAL_STATUSES } from "@/types"
import { InvalidTransitionError } from "@/errors"

// Shape-legality only. DB-dependent guards (role active, deps satisfied, claim
// uniqueness) live in kernel.ts. This file stays pure for exhaustive unit tests.
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["assigned", "blocked", "cancelled"],
  assigned: ["claimed", "pending", "cancelled"],
  blocked: ["pending", "assigned", "cancelled"],
  claimed: ["running", "assigned", "cancelled"],
  running: ["in_review", "done", "failed", "blocked", "assigned", "cancelled"],
  in_review: ["done", "failed", "assigned", "cancelled"],
  done: [],
  failed: ["pending", "cancelled"],
  cancelled: [],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (TERMINAL_STATUSES.has(from)) return false
  return TRANSITIONS[from].includes(to)
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)
}

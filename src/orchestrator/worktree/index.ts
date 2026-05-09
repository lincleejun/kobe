/**
 * Barrel for the worktree manager (Stream B).
 *
 * The orchestrator (Wave 2 Stream E) imports from
 * `@orchestrator/worktree` — keep the surface flat. The
 * `WorktreeManager` interface and its `WorktreeInfo` shape are
 * re-exported from `@types/worktree` (Stream 0.3); this module ships
 * only the implementation plus the path helpers.
 */

export { GitWorktreeManager } from "./manager.ts"
export { GitCommandError, git } from "./git.ts"
export type { GitRunOpts, GitRunResult } from "./git.ts"
export {
  KOBE_WORKTREE_ROOT_SUBPATH,
  isKobeManagedPath,
  worktreePathFor,
  worktreeRootFor,
} from "./paths.ts"

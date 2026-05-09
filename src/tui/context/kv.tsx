/**
 * KV store (in-memory stub).
 *
 * Opencode's KV is a JSON file at `~/.config/opencode/state/kv.json` with a
 * cross-process flock. kobe will eventually want the same shape (so dialog
 * positions, theme picks, expanded sidebar groups, etc. survive restarts) but
 * we don't need that on day 0.2 — and `@opencode-ai/core` Filesystem/Flock
 * helpers aren't available outside that monorepo.
 *
 * For now: pure in-memory map with the same surface area opencode's `useKV`
 * exposes (`get`, `set`, `signal`). When Wave 1 stream D wires real
 * persistence, this file is the swap point.
 */

import type { Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [store, setStore] = createStore<Record<string, unknown>>({})

    const result = {
      get ready() {
        return true
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue as unknown)
        return [() => result.get(name) as T, (next: Setter<T>) => result.set(name, next)] as const
      },
      get(key: string, defaultValue?: unknown) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: unknown) {
        setStore(key, value)
      },
    }
    return result
  },
})

export type KVContext = ReturnType<typeof useKV>

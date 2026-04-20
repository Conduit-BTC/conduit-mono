import { useCallback, useSyncExternalStore } from "react"
import {
  clearRelayOverrides,
  getEffectiveRelayGroups,
  loadRelayOverrides,
  saveRelayOverrides,
} from "../config"
import { refreshNdkRelaySettings } from "../protocol/ndk"
import type { RelayActor, RelayEntry, RelayGroups, RelayOverrides, RelayRole } from "../types"

type Listener = () => void

let snapshot: RelayGroups = getEffectiveRelayGroups()
const listeners = new Set<Listener>()

function notify(): void {
  snapshot = getEffectiveRelayGroups()
  listeners.forEach((fn) => fn())
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): RelayGroups {
  return snapshot
}

export interface UseRelaySettingsResult {
  groups: RelayGroups
  visibleGroups: Partial<RelayGroups>
  addRelay: (role: RelayRole, url: string) => void
  removeRelay: (role: RelayRole, url: string) => void
  updateRelay: (
    role: RelayRole,
    url: string,
    next: Pick<RelayEntry, "out" | "in" | "find" | "dm">
  ) => void
  resetToDefaults: () => void
}

function persist(nextGroups: RelayGroups): void {
  const current = loadRelayOverrides() ?? {
    custom: { merchant: [], commerce: [], general: [] },
    states: { merchant: {}, commerce: {}, general: {} },
  }

  const nextOverrides: RelayOverrides = {
    ...current,
    custom: {
      merchant: nextGroups.merchant.filter((entry) => entry.source === "custom"),
      commerce: nextGroups.commerce.filter((entry) => entry.source === "custom"),
      general: nextGroups.general.filter((entry) => entry.source === "custom"),
    },
  }

  saveRelayOverrides(nextOverrides)
  notify()
  refreshNdkRelaySettings()
}

function persistOverrides(update: (current: RelayOverrides) => RelayOverrides): void {
  const current = loadRelayOverrides() ?? {
    custom: { merchant: [], commerce: [], general: [] },
    states: { merchant: {}, commerce: {}, general: {} },
  }

  saveRelayOverrides(update(current))
  notify()
  refreshNdkRelaySettings()
}

/**
 * React hook for reading and writing relay settings.
 * Updates are persisted to localStorage and reflected immediately.
 */
export function useRelaySettings(actor: RelayActor): UseRelaySettingsResult {
  const groups = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const visibleGroups: Partial<RelayGroups> =
    actor === "merchant"
      ? groups
      : { commerce: groups.commerce, general: groups.general }

  const addRelay = useCallback(
    (role: RelayRole, url: string) => {
      const trimmed = url.trim()
      if (!trimmed) return
      const current = getEffectiveRelayGroups()
      const group = current[role]
      if (group.some((entry) => entry.url === trimmed)) return
      const entry: RelayEntry = {
        url: trimmed,
        role,
        source: "custom",
        out: role !== "commerce",
        in: true,
        find: role !== "merchant",
        dm: role !== "commerce",
      }
      const updated: RelayGroups = {
        ...current,
        [role]: [...group, entry],
      }
      persist(updated)
    },
    [],
  )

  const removeRelay = useCallback(
    (role: RelayRole, url: string) => {
      const current = getEffectiveRelayGroups()
      const existing = current[role].find((entry) => entry.url === url)
      if (!existing) return

      if (existing.source === "custom") {
        const updated: RelayGroups = {
          ...current,
          [role]: current[role].filter((entry) => entry.url !== url),
        }
        persist(updated)
        return
      }

      persistOverrides((overrides) => ({
        ...overrides,
        states: {
          ...overrides.states,
          [role]: {
            ...overrides.states[role],
            [url]: { ...overrides.states[role][url], hidden: true },
          },
        },
      }))
    },
    [],
  )

  const updateRelay = useCallback(
    (role: RelayRole, url: string, next: Pick<RelayEntry, "out" | "in" | "find" | "dm">) => {
      const current = getEffectiveRelayGroups()
      const existing = current[role].find((entry) => entry.url === url)
      if (!existing) return

      if (existing.source === "custom") {
        const updated: RelayGroups = {
          ...current,
          [role]: current[role].map((entry) =>
            entry.url === url ? { ...entry, ...next } : entry,
          ),
        }
        persist(updated)
        return
      }

      persistOverrides((overrides) => ({
        ...overrides,
        states: {
          ...overrides.states,
          [role]: {
            ...overrides.states[role],
            [url]: {
              ...overrides.states[role][url],
              hidden: false,
              out: next.out,
              in: next.in,
              find: next.find,
              dm: next.dm,
            },
          },
        },
      }))
    },
    [],
  )

  const resetToDefaults = useCallback(() => {
    clearRelayOverrides()
    notify()
    refreshNdkRelaySettings()
  }, [])

  return { groups, visibleGroups, addRelay, removeRelay, updateRelay, resetToDefaults }
}

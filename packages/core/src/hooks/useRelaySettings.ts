import { useCallback, useSyncExternalStore } from "react"
import {
  clearRelayOverrides,
  getEffectiveRelayGroups,
  saveRelayOverrides,
} from "../config"
import { refreshNdkRelaySettings } from "../protocol/ndk"
import type { RelayActor, RelayEntry, RelayGroups, RelayRole } from "../types"

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
  updateRelay: (role: RelayRole, url: string, next: Pick<RelayEntry, "read" | "write">) => void
  resetToDefaults: () => void
}

function persist(nextGroups: RelayGroups): void {
  saveRelayOverrides(nextGroups)
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
        read: true,
        write: true,
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
      const updated: RelayGroups = {
        ...current,
        [role]: current[role].filter((entry) => entry.url !== url),
      }
      persist(updated)
    },
    [],
  )

  const updateRelay = useCallback(
    (role: RelayRole, url: string, next: Pick<RelayEntry, "read" | "write">) => {
      const current = getEffectiveRelayGroups()
      const updated: RelayGroups = {
        ...current,
        [role]: current[role].map((entry) =>
          entry.url === url ? { ...entry, read: next.read, write: next.write } : entry,
        ),
      }
      persist(updated)
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

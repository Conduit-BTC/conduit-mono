import { useSyncExternalStore } from "react"
import {
  getRelayStatusMap,
  subscribeNdkState,
  type RelayStatus,
} from "../protocol/ndk"

let cached: Record<string, RelayStatus> = getRelayStatusMap()
let cachedKey = serialize(cached)

function serialize(map: Record<string, RelayStatus>): string {
  const keys = Object.keys(map).sort()
  return keys.map((k) => `${k}:${map[k]}`).join("|")
}

function getSnapshot(): Record<string, RelayStatus> {
  const next = getRelayStatusMap()
  const nextKey = serialize(next)
  if (nextKey !== cachedKey) {
    cached = next
    cachedKey = nextKey
  }
  return cached
}

/**
 * React hook that returns a snapshot of per-relay live connection status,
 * keyed by normalized relay URL. Re-renders as NDK pool connectivity changes.
 */
export function useRelayStatusMap(): Record<string, RelayStatus> {
  return useSyncExternalStore(subscribeNdkState, getSnapshot, getSnapshot)
}

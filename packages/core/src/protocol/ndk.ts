import NDK, {
  NDKRelaySet,
  NDKRelayStatus,
  type NDKEvent,
  type NDKFilter,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import {
  getEffectiveDmRelayUrls,
  getEffectiveReadableRelayUrls,
  getEffectiveWritableRelayUrls,
} from "../config"
import type { RelayActor } from "../types"

export type NdkConnectionState = "idle" | "connecting" | "connected" | "error"

export type RelayStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "unknown"

export interface NdkState {
  status: NdkConnectionState
  connectedRelays: string[]
  error: string | null
}

export interface FetchEventsFanoutOptions {
  relayUrls?: string[]
  connectTimeoutMs?: number
  fetchTimeoutMs?: number
}

type Listener = () => void

let ndkInstance: NDK | null = null
let state: NdkState = {
  status: "idle",
  connectedRelays: [],
  error: null,
}
let connectPromise: Promise<void> | null = null
let requirePromise: Promise<NDK> | null = null
const listeners = new Set<Listener>()
let activeActor: RelayActor = "merchant"

function getReadableRelayUrls(actor = activeActor): string[] {
  return getEffectiveReadableRelayUrls(actor)
}

function getWritableRelayUrls(actor = activeActor): string[] {
  return getEffectiveWritableRelayUrls(actor)
}

export function getDmRelayUrls(actor = activeActor): string[] {
  return getEffectiveDmRelayUrls(actor)
}

function setState(partial: Partial<NdkState>): void {
  state = { ...state, ...partial }
  listeners.forEach((fn) => fn())
}

function getConnectedRelayUrls(ndk: NDK): string[] {
  return Array.from(ndk.pool?.relays?.entries() ?? [])
    .filter(([, relay]) => relay.status >= NDKRelayStatus.CONNECTED)
    .map(([url]) => url)
}

function statusFromRelay(status: number): RelayStatus {
  if (status >= NDKRelayStatus.CONNECTED) return "connected"
  if (
    status === NDKRelayStatus.CONNECTING ||
    status === NDKRelayStatus.RECONNECTING
  ) {
    return "connecting"
  }
  return "disconnected"
}

/**
 * Live per-relay connection status snapshot, keyed by normalized relay URL.
 * Relays not present in the NDK pool return `"unknown"` when queried.
 */
export function getRelayStatusMap(): Record<string, RelayStatus> {
  if (!ndkInstance) return {}
  const result: Record<string, RelayStatus> = {}
  for (const [url, relay] of ndkInstance.pool?.relays?.entries() ?? []) {
    result[url] = statusFromRelay(relay.status)
  }
  return result
}

function refreshConnectedRelays(): void {
  if (!ndkInstance) return
  const connected = getConnectedRelayUrls(ndkInstance)
  if (
    connected.length === state.connectedRelays.length &&
    connected.every((url) => state.connectedRelays.includes(url))
  ) {
    // No change in membership, but per-relay status may have shifted — still notify.
    listeners.forEach((fn) => fn())
    return
  }
  setState({ connectedRelays: connected })
}

function attachPoolListeners(ndk: NDK): void {
  const pool = ndk.pool
  if (!pool) return
  pool.on("relay:connect", refreshConnectedRelays)
  pool.on("relay:disconnect", refreshConnectedRelays)
  pool.on("relay:ready", refreshConnectedRelays)
}

export function subscribeNdkState(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getNdkState(): NdkState {
  return state
}

export function setRelayActor(actor: RelayActor): void {
  if (activeActor === actor) return
  activeActor = actor
  refreshNdkRelaySettings()
}

export function getNdk(): NDK {
  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: getReadableRelayUrls(),
    })
    attachPoolListeners(ndkInstance)
  }
  return ndkInstance
}

export function getWriteRelaySet(ndk = getNdk()): NDKRelaySet {
  const relayUrls = getWritableRelayUrls()
  if (relayUrls.length === 0) {
    throw new Error("No write-enabled relays configured")
  }

  return NDKRelaySet.fromRelayUrls(relayUrls, ndk)
}

function sleep<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

async function fetchEventsFromRelay(
  relayUrl: string,
  filter: NDKFilter,
  connectTimeoutMs: number,
  fetchTimeoutMs: number
): Promise<NDKEvent[]> {
  const ndk = new NDK({
    explicitRelayUrls: [relayUrl],
  })

  try {
    const connected = await Promise.race([
      ndk
        .connect(connectTimeoutMs)
        .then(() => true)
        .catch(() => false),
      sleep(connectTimeoutMs + 250, false),
    ])

    if (!connected) return []

    const events = await Promise.race([
      ndk.fetchEvents(filter),
      sleep(fetchTimeoutMs, new Set<NDKEvent>()),
    ])

    return Array.from(events) as NDKEvent[]
  } catch {
    return []
  } finally {
    for (const [, relay] of ndk.pool?.relays?.entries() ?? []) {
      relay.disconnect()
    }
  }
}

export async function fetchEventsFanout(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions = {}
): Promise<NDKEvent[]> {
  const relayUrls = (
    options.relayUrls && options.relayUrls.length > 0
      ? options.relayUrls
      : getReadableRelayUrls()
  )
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url, index, all) => all.indexOf(url) === index)

  if (relayUrls.length === 0) return []

  const connectTimeoutMs = options.connectTimeoutMs ?? 4_000
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 8_000

  const perRelayResults = await Promise.all(
    relayUrls.map((relayUrl) =>
      fetchEventsFromRelay(relayUrl, filter, connectTimeoutMs, fetchTimeoutMs)
    )
  )

  const merged = new Map<string, NDKEvent>()
  for (const events of perRelayResults) {
    for (const event of events) {
      const fallbackId = `${event.pubkey}:${event.kind}:${event.created_at ?? 0}`
      merged.set(event.id || fallbackId, event)
    }
  }

  return Array.from(merged.values())
}

export async function connectNdk(timeoutMs = 10_000): Promise<void> {
  const ndk = getNdk()

  // If already connected with live relays, skip
  if (state.status === "connected" && getConnectedRelayUrls(ndk).length > 0) {
    return
  }

  if (connectPromise) {
    await connectPromise
    return
  }

  setState({ status: "connecting", error: null })

  connectPromise = (async () => {
    try {
      await ndk.connect(timeoutMs)

      const connected = getConnectedRelayUrls(ndk)

      if (connected.length > 0) {
        setState({
          status: "connected",
          connectedRelays: connected,
          error: null,
        })
      } else {
        setState({
          status: "error",
          error: "No relays responded within timeout",
          connectedRelays: [],
        })
      }
    } catch (err) {
      setState({
        status: "error",
        error:
          err instanceof Error ? err.message : "Failed to connect to relays",
        connectedRelays: [],
      })
    } finally {
      connectPromise = null
    }
  })()

  await connectPromise
}

export async function requireNdkConnected(timeoutMs = 10_000): Promise<NDK> {
  // Deduplicate concurrent callers — only one retry path runs at a time
  if (requirePromise) {
    return requirePromise
  }

  requirePromise = (async () => {
    try {
      await connectNdk(timeoutMs)

      let ndk = getNdk()
      if (getConnectedRelayUrls(ndk).length > 0) {
        setState({
          status: "connected",
          connectedRelays: getConnectedRelayUrls(ndk),
          error: null,
        })
        return ndk
      }

      // First attempt failed — reset the NDK instance for fresh websocket connections and retry
      const savedSigner = ndk.signer
      ndkInstance = null
      connectPromise = null
      ndk = getNdk()
      if (savedSigner) ndk.signer = savedSigner

      await connectNdk(timeoutMs * 2)

      const retryRelays = getConnectedRelayUrls(ndk)
      if (retryRelays.length === 0) {
        throw new Error(state.error ?? "Failed to connect to relays")
      }

      setState({
        status: "connected",
        connectedRelays: retryRelays,
        error: null,
      })
      return ndk
    } finally {
      requirePromise = null
    }
  })()

  return requirePromise
}

export function setSigner(signer: NDKSigner): void {
  const ndk = getNdk()
  ndk.signer = signer
}

export function removeSigner(): void {
  const ndk = getNdk()
  ndk.signer = undefined
}

export function disconnectNdk(): void {
  if (ndkInstance) {
    ndkInstance.signer = undefined
    ndkInstance = null
  }
  connectPromise = null
  requirePromise = null
  setState({
    status: "idle",
    connectedRelays: [],
    error: null,
  })
}

export function refreshNdkRelaySettings(): void {
  const signer = ndkInstance?.signer
  disconnectNdk()
  if (signer) {
    getNdk().signer = signer
  }
  void connectNdk().catch(() => {
    // Connection failures are reflected through shared state.
  })
}

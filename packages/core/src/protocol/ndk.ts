import NDK, {
  NDKRelayStatus,
  type NDKEvent,
  type NDKFilter,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { config } from "../config"
import {
  getGeneralReadRelayUrls,
  setActiveRelaySettingsScope,
} from "./relay-settings"
import {
  partitionByHealth,
  recordRelayFailure,
  recordRelaySuccess,
} from "./relay-health"

export type NdkConnectionState = "idle" | "connecting" | "connected" | "error"

export interface NdkState {
  status: NdkConnectionState
  connectedRelays: string[]
  error: string | null
}

export interface FetchEventsFanoutOptions {
  relayUrls?: string[]
  connectTimeoutMs?: number
  fetchTimeoutMs?: number
  skipHealthFilter?: boolean
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
let ndkGeneration = 0
const listeners = new Set<Listener>()

function setState(partial: Partial<NdkState>): void {
  state = { ...state, ...partial }
  listeners.forEach((fn) => fn())
}

function getConnectedRelayUrls(ndk: NDK): string[] {
  return Array.from(ndk.pool?.relays?.entries() ?? [])
    .filter(([, relay]) => relay.status >= NDKRelayStatus.CONNECTED)
    .map(([url]) => url)
}

export function subscribeNdkState(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getNdkState(): NdkState {
  return state
}

export function getNdk(): NDK {
  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: getGeneralReadRelayUrls({
        fallbackRelayUrls: config.defaultRelays,
      }),
    })
  }
  return ndkInstance
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

    if (!connected) {
      recordRelayFailure(relayUrl)
      return []
    }

    const events = await Promise.race([
      ndk.fetchEvents(filter),
      sleep(fetchTimeoutMs, new Set<NDKEvent>()),
    ])

    recordRelaySuccess(relayUrl)
    return Array.from(events) as NDKEvent[]
  } catch {
    recordRelayFailure(relayUrl)
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
  const dedupedUrls = (
    options.relayUrls && options.relayUrls.length > 0
      ? options.relayUrls
      : getGeneralReadRelayUrls({ fallbackRelayUrls: config.defaultRelays })
  )
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url, index, all) => all.indexOf(url) === index)

  const relayUrls = options.skipHealthFilter
    ? dedupedUrls
    : (() => {
        const { healthy, parked } = partitionByHealth(dedupedUrls)
        // If health filter would leave no relays, fall back to the full set
        // so a transient cooldown does not silently break reads.
        return healthy.length > 0
          ? healthy
          : parked.length > 0
            ? dedupedUrls
            : []
      })()

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
  const generation = ndkGeneration

  // If already connected with live relays, skip
  if (state.status === "connected" && getConnectedRelayUrls(ndk).length > 0) {
    return
  }

  if (connectPromise) {
    await connectPromise
    return
  }

  if (generation === ndkGeneration) {
    setState({ status: "connecting", error: null })
  }

  connectPromise = (async () => {
    try {
      await ndk.connect(timeoutMs)
      if (generation !== ndkGeneration) return

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
      if (generation !== ndkGeneration) return
      setState({
        status: "error",
        error:
          err instanceof Error ? err.message : "Failed to connect to relays",
        connectedRelays: [],
      })
    } finally {
      if (generation === ndkGeneration) {
        connectPromise = null
      }
    }
  })()

  await connectPromise
}

export async function requireNdkConnected(timeoutMs = 10_000): Promise<NDK> {
  // Deduplicate concurrent callers — only one retry path runs at a time
  if (requirePromise) {
    return requirePromise
  }

  const generation = ndkGeneration
  const promise = (async () => {
    try {
      await connectNdk(timeoutMs)
      if (generation !== ndkGeneration) {
        return requireNdkConnected(timeoutMs)
      }

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
      if (generation !== ndkGeneration) {
        return requireNdkConnected(timeoutMs)
      }

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
      if (generation === ndkGeneration) {
        requirePromise = null
      }
    }
  })()

  requirePromise = promise
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
  ndkGeneration += 1
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

export function refreshNdkRelaySettings(scope?: string | null): void {
  ndkGeneration += 1
  if (scope !== undefined) {
    setActiveRelaySettingsScope(scope)
  }

  const savedSigner = ndkInstance?.signer

  if (ndkInstance) {
    for (const [, relay] of ndkInstance.pool?.relays?.entries() ?? []) {
      relay.disconnect()
    }
  }

  ndkInstance = null
  connectPromise = null
  requirePromise = null

  const ndk = getNdk()
  if (savedSigner) ndk.signer = savedSigner

  setState({
    status: "idle",
    connectedRelays: [],
    error: null,
  })
}

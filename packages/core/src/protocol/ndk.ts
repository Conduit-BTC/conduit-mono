import NDK, {
  NDKEvent,
  NDKRelayStatus,
  type NDKFilter,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { schnorr } from "@noble/curves/secp256k1"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex } from "@noble/hashes/utils"
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

export interface FetchEventsFanoutProgress {
  relayUrl: string
  events: NDKEvent[]
  mergedEvents: NDKEvent[]
}

const EVENT_SOURCE_RELAY_URLS = "__conduitSourceRelayUrls"

type EventWithSourceRelayUrls = NDKEvent & {
  [EVENT_SOURCE_RELAY_URLS]?: string[]
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

function uniqueRelayUrls(urls: readonly string[]): string[] {
  return Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)))
}

function attachEventSourceRelayUrl(event: NDKEvent, relayUrl: string): void {
  const eventWithSources = event as EventWithSourceRelayUrls
  const next = uniqueRelayUrls([
    ...(eventWithSources[EVENT_SOURCE_RELAY_URLS] ?? []),
    relayUrl,
  ])

  Object.defineProperty(eventWithSources, EVENT_SOURCE_RELAY_URLS, {
    value: next,
    enumerable: false,
    configurable: true,
  })
}

export function getEventSourceRelayUrls(event: NDKEvent): string[] {
  return [
    ...((event as EventWithSourceRelayUrls)[EVENT_SOURCE_RELAY_URLS] ?? []),
  ]
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

const MAX_CONCURRENT_RELAY_READS = 8
let activeRelayReads = 0
const relayReadWaiters: Array<() => void> = []

function acquireRelayReadSlot(): Promise<void> {
  if (activeRelayReads < MAX_CONCURRENT_RELAY_READS) {
    activeRelayReads += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => relayReadWaiters.push(resolve))
}

function releaseRelayReadSlot(): void {
  const next = relayReadWaiters.shift()
  if (next) {
    next()
    return
  }
  activeRelayReads = Math.max(0, activeRelayReads - 1)
}

type RawNostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

const MAX_EVENTS_PER_RELAY_READ = 2000
let relayReadSubCounter = 0

function computeEventId(event: RawNostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ])
  return bytesToHex(sha256(new TextEncoder().encode(serialized)))
}

function hasValidSignature(event: RawNostrEvent): boolean {
  try {
    if (
      typeof event?.id !== "string" ||
      typeof event.sig !== "string" ||
      typeof event.pubkey !== "string"
    ) {
      return false
    }
    if (computeEventId(event) !== event.id) return false
    return schnorr.verify(event.sig, event.id, event.pubkey)
  } catch {
    return false
  }
}

// Owned Nostr read: open one WebSocket, REQ, collect EVENTs until EOSE or
// timeout, then explicitly CLOSE and drop the socket. No auto-reconnect, so the
// browser socket pool cannot accumulate the way NDK's fetchEvents did.
function readRelayEvents(
  relayUrl: string,
  filter: NDKFilter,
  connectTimeoutMs: number,
  fetchTimeoutMs: number
): Promise<{ events: RawNostrEvent[]; ok: boolean }> {
  return new Promise((resolve) => {
    const subId = `cnd-${(relayReadSubCounter += 1)}`
    const events: RawNostrEvent[] = []
    let settled = false
    let ws: WebSocket
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let fetchTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (connectTimer) clearTimeout(connectTimer)
      if (fetchTimer) clearTimeout(fetchTimer)
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(["CLOSE", subId]))
        }
        ws.close()
      } catch {
        // ignore teardown errors
      }
      resolve({ events, ok })
    }

    try {
      ws = new WebSocket(relayUrl)
    } catch {
      resolve({ events: [], ok: false })
      return
    }

    connectTimer = setTimeout(() => finish(events.length > 0), connectTimeoutMs)

    ws.onopen = () => {
      if (connectTimer) {
        clearTimeout(connectTimer)
        connectTimer = undefined
      }
      fetchTimer = setTimeout(() => finish(events.length > 0), fetchTimeoutMs)
      try {
        ws.send(JSON.stringify(["REQ", subId, filter]))
      } catch {
        finish(false)
      }
    }

    ws.onmessage = (message) => {
      let parsed: unknown
      try {
        parsed =
          typeof message.data === "string" ? JSON.parse(message.data) : null
      } catch {
        return
      }
      if (!Array.isArray(parsed)) return
      const [type, sub] = parsed as [string, string, ...unknown[]]
      if (type === "EVENT" && sub === subId && parsed[2]) {
        events.push(parsed[2] as RawNostrEvent)
        if (events.length >= MAX_EVENTS_PER_RELAY_READ) finish(true)
      } else if (type === "EOSE" && sub === subId) {
        finish(true)
      } else if (type === "CLOSED" && sub === subId) {
        finish(events.length > 0)
      }
    }

    ws.onerror = () => finish(events.length > 0)
    ws.onclose = () => finish(events.length > 0)
  })
}

async function fetchEventsFromRelay(
  relayUrl: string,
  filter: NDKFilter,
  connectTimeoutMs: number,
  fetchTimeoutMs: number
): Promise<NDKEvent[]> {
  await acquireRelayReadSlot()
  try {
    const { events, ok } = await readRelayEvents(
      relayUrl,
      filter,
      connectTimeoutMs,
      fetchTimeoutMs
    )

    if (!ok && events.length === 0) {
      recordRelayFailure(relayUrl)
      return []
    }

    recordRelaySuccess(relayUrl)
    const verified: NDKEvent[] = []
    for (const raw of events) {
      if (!hasValidSignature(raw)) continue
      const event = new NDKEvent(undefined, raw)
      attachEventSourceRelayUrl(event, relayUrl)
      verified.push(event)
    }
    return verified
  } catch {
    recordRelayFailure(relayUrl)
    return []
  } finally {
    releaseRelayReadSlot()
  }
}

function resolveFanoutRelayUrls(options: FetchEventsFanoutOptions): string[] {
  const dedupedUrls = (
    options.relayUrls && options.relayUrls.length > 0
      ? options.relayUrls
      : getGeneralReadRelayUrls({ fallbackRelayUrls: config.defaultRelays })
  )
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url, index, all) => all.indexOf(url) === index)

  if (options.skipHealthFilter) return dedupedUrls

  const { healthy, parked } = partitionByHealth(dedupedUrls)
  if (healthy.length > 0) return healthy
  if (parked.length === 0) return []

  // Everything is parked (e.g. every relay is failing right now). Re-trying the
  // global fallback set on every read floods the browser console with
  // connection errors, so cap that implicit path. For explicit caller-provided
  // relay plans, keep the requested set intact so author-, recipient-, and
  // inbox-scoped reads do not get silently redirected onto unrelated default
  // relays (which would turn a transient transport failure into a false
  // negative read).
  if (options.relayUrls && options.relayUrls.length > 0) return dedupedUrls

  const defaultRelaySet = new Set(
    config.defaultRelays.map((url) => url.trim()).filter(Boolean)
  )
  const cappedFallback = dedupedUrls.filter((url) => defaultRelaySet.has(url))
  return cappedFallback.length > 0 ? cappedFallback : dedupedUrls.slice(0, 4)
}

function mergeEventsInto(
  merged: Map<string, NDKEvent>,
  events: NDKEvent[]
): void {
  for (const event of events) {
    const fallbackId = `${event.pubkey}:${event.kind}:${event.created_at ?? 0}`
    const key = event.id || fallbackId
    const existing = merged.get(key)
    if (existing) {
      for (const relayUrl of getEventSourceRelayUrls(event)) {
        attachEventSourceRelayUrl(existing, relayUrl)
      }
      continue
    }
    merged.set(key, event)
  }
}

export async function fetchEventsFanout(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions = {}
): Promise<NDKEvent[]> {
  const relayUrls = resolveFanoutRelayUrls(options)

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
    mergeEventsInto(merged, events)
  }

  return Array.from(merged.values())
}

export async function fetchEventsFanoutProgressive(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions = {},
  onProgress: (progress: FetchEventsFanoutProgress) => void | Promise<void>
): Promise<NDKEvent[]> {
  const relayUrls = resolveFanoutRelayUrls(options)
  if (relayUrls.length === 0) return []

  const connectTimeoutMs = options.connectTimeoutMs ?? 4_000
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 8_000
  const merged = new Map<string, NDKEvent>()

  await Promise.all(
    relayUrls.map(async (relayUrl) => {
      const events = await fetchEventsFromRelay(
        relayUrl,
        filter,
        connectTimeoutMs,
        fetchTimeoutMs
      )
      mergeEventsInto(merged, events)
      await onProgress({
        relayUrl,
        events,
        mergedEvents: Array.from(merged.values()),
      })
    })
  )

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

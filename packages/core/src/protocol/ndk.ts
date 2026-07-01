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

// One shared WebSocket per relay, with REQs multiplexed by subId across
// concurrent reads. Explicit CLOSE per sub; the socket stays warm and idle-closes
// once no reads are using it. No auto-reconnect, so failing relays are attempted
// once (not re-hammered by every concurrent read) and freed deterministically.
type RelaySubEnd = "eose" | "closed" | "drop"
type RelaySub = {
  onEvent: (raw: RawNostrEvent) => void
  end: (reason: RelaySubEnd) => void
}
type RelayConnection = {
  url: string
  ws: WebSocket
  ready: Promise<void>
  isOpen: boolean
  closed: boolean
  subs: Map<string, RelaySub>
  idleTimer?: ReturnType<typeof setTimeout>
}

const RELAY_CONNECTION_IDLE_MS = 20_000
const relayConnections = new Map<string, RelayConnection>()

function dropRelayConnection(conn: RelayConnection): void {
  if (relayConnections.get(conn.url) === conn) relayConnections.delete(conn.url)
  if (conn.closed) return
  conn.closed = true
  if (conn.idleTimer) clearTimeout(conn.idleTimer)
  const pending = [...conn.subs.values()]
  conn.subs.clear()
  for (const sub of pending) sub.end("drop")
  try {
    conn.ws.close()
  } catch {
    // ignore teardown errors
  }
}

function scheduleRelayConnectionIdleClose(conn: RelayConnection): void {
  if (conn.idleTimer) clearTimeout(conn.idleTimer)
  conn.idleTimer = setTimeout(() => {
    if (conn.subs.size === 0) dropRelayConnection(conn)
  }, RELAY_CONNECTION_IDLE_MS)
}

function getRelayConnection(url: string): RelayConnection {
  const existing = relayConnections.get(url)
  if (existing && !existing.closed) return existing

  const conn: RelayConnection = {
    url,
    ws: undefined as unknown as WebSocket,
    ready: undefined as unknown as Promise<void>,
    isOpen: false,
    closed: false,
    subs: new Map(),
  }

  conn.ready = new Promise<void>((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (error) {
      conn.closed = true
      reject(error as Error)
      return
    }
    conn.ws = ws

    ws.onopen = () => {
      conn.isOpen = true
      resolve()
    }
    ws.onerror = () => {
      if (!conn.isOpen) reject(new Error("relay connect failed"))
      dropRelayConnection(conn)
    }
    ws.onclose = () => {
      if (!conn.isOpen) reject(new Error("relay closed before open"))
      dropRelayConnection(conn)
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
      if (typeof sub !== "string") return
      const handler = conn.subs.get(sub)
      if (!handler) return
      if (type === "EVENT" && parsed[2]) {
        handler.onEvent(parsed[2] as RawNostrEvent)
      } else if (type === "EOSE") {
        handler.end("eose")
      } else if (type === "CLOSED") {
        handler.end("closed")
      }
    }
  })
  conn.ready.catch(() => {
    // Rejection is handled per-read; swallow here to avoid unhandled rejection.
  })

  relayConnections.set(url, conn)
  return conn
}

function closeAllRelayConnections(): void {
  for (const conn of [...relayConnections.values()]) dropRelayConnection(conn)
  relayConnections.clear()
}

function readRelayEvents(
  relayUrl: string,
  filter: NDKFilter,
  connectTimeoutMs: number,
  fetchTimeoutMs: number
): Promise<{ events: RawNostrEvent[]; ok: boolean }> {
  return new Promise((resolve) => {
    const conn = getRelayConnection(relayUrl)
    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer)
      conn.idleTimer = undefined
    }

    const subId = `cnd-${(relayReadSubCounter += 1)}`
    const events: RawNostrEvent[] = []
    let settled = false
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let fetchTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (connectTimer) clearTimeout(connectTimer)
      if (fetchTimer) clearTimeout(fetchTimer)
      conn.subs.delete(subId)
      if (!conn.closed && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(JSON.stringify(["CLOSE", subId]))
        } catch {
          // ignore
        }
      }
      if (!conn.closed && conn.subs.size === 0) {
        scheduleRelayConnectionIdleClose(conn)
      }
      resolve({ events, ok })
    }

    conn.subs.set(subId, {
      onEvent: (raw) => {
        events.push(raw)
        if (events.length >= MAX_EVENTS_PER_RELAY_READ) finish(true)
      },
      end: (reason) => finish(reason === "eose" ? true : events.length > 0),
    })

    connectTimer = setTimeout(() => finish(events.length > 0), connectTimeoutMs)

    conn.ready
      .then(() => {
        if (connectTimer) {
          clearTimeout(connectTimer)
          connectTimer = undefined
        }
        if (settled) return
        if (conn.closed || conn.ws.readyState !== WebSocket.OPEN) {
          finish(false)
          return
        }
        fetchTimer = setTimeout(() => finish(events.length > 0), fetchTimeoutMs)
        try {
          conn.ws.send(JSON.stringify(["REQ", subId, filter]))
        } catch {
          finish(false)
        }
      })
      .catch(() => finish(false))
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
  closeAllRelayConnections()
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
  closeAllRelayConnections()

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

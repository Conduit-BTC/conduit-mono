import NDK, {
  NDKEvent,
  NDKRelayStatus,
  type NDKFilter,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { schnorr } from "@noble/curves/secp256k1.js"
import { hexToBytes } from "@noble/curves/utils.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
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
  reuseRelayConnections?: boolean
}

export interface FetchEventsFanoutProgress {
  relayUrl: string
  events: NDKEvent[]
  mergedEvents: NDKEvent[]
}

export interface FetchEventsRelayStatus {
  relayUrl: string
  status: "success" | "partial" | "failed"
  eventCount: number
}

export interface FetchEventsFanoutResult {
  events: NDKEvent[]
  relays: FetchEventsRelayStatus[]
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

// Schnorr verification (~1-2ms) dominates read cost, and the same event arrives
// from many relays. Cache verified ids so the expensive check runs once per
// unique event, not once per relay copy. The id is always recomputed from
// content (cheap sha256), so a forged event reusing a known id can't skip it -
// a matching id guarantees identical signed content.
const MAX_VERIFIED_ID_CACHE = 20000
const verifiedEventIds = new Set<string>()

type SchnorrItem = { sig: string; id: string; pubkey: string }

// Cheap main-thread check: valid shape + id binds to content. Returns the
// verified-cache state so callers know whether schnorr still needs to run.
function checkEventId(
  event: RawNostrEvent
): "cached" | "needs-schnorr" | "invalid" {
  try {
    if (
      typeof event?.id !== "string" ||
      typeof event.sig !== "string" ||
      typeof event.pubkey !== "string"
    ) {
      return "invalid"
    }
    if (computeEventId(event) !== event.id) return "invalid"
    return verifiedEventIds.has(event.id) ? "cached" : "needs-schnorr"
  } catch {
    return "invalid"
  }
}

function verifySchnorrSync(items: SchnorrItem[]): boolean[] {
  return items.map((item) => {
    try {
      return schnorr.verify(
        hexToBytes(item.sig),
        hexToBytes(item.id),
        hexToBytes(item.pubkey)
      )
    } catch {
      return false
    }
  })
}

// Offload schnorr verification to a worker so the crypto never blocks the main
// thread. Falls back to sync verification when Workers are unavailable (SSR,
// tests) or the worker fails.
let verifyWorker: Worker | null | undefined
let verifyReqId = 0
type PendingVerifyBatch = {
  items: SchnorrItem[]
  resolve: (valid: boolean[]) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingVerify = new Map<number, PendingVerifyBatch>()

function resolvePendingVerifyBatch(
  reqId: number,
  valid: boolean[] | undefined
): void {
  const pending = pendingVerify.get(reqId)
  if (!pending) return

  pendingVerify.delete(reqId)
  clearTimeout(pending.timer)
  pending.resolve(valid ?? verifySchnorrSync(pending.items))
}

function failVerifyWorker(worker: Worker): void {
  if (verifyWorker === worker) verifyWorker = null
  try {
    worker.terminate()
  } catch {
    // ignore teardown errors
  }

  for (const reqId of [...pendingVerify.keys()]) {
    resolvePendingVerifyBatch(reqId, undefined)
  }
}

export function __resetNdkTestState(): void {
  if (verifyWorker) {
    try {
      verifyWorker.terminate()
    } catch {
      // ignore teardown errors
    }
  }
  verifyWorker = undefined
  for (const reqId of [...pendingVerify.keys()]) {
    resolvePendingVerifyBatch(reqId, undefined)
  }
  verifiedEventIds.clear()
}

function getVerifyWorker(): Worker | null {
  if (verifyWorker !== undefined) return verifyWorker
  try {
    if (typeof Worker === "undefined") {
      verifyWorker = null
      return null
    }
    const worker = new Worker(new URL("./verify-worker.ts", import.meta.url), {
      type: "module",
    })
    worker.onmessage = (
      event: MessageEvent<{ reqId: number; valid: boolean[] }>
    ) => {
      resolvePendingVerifyBatch(event.data.reqId, event.data.valid)
    }
    worker.onerror = () => {
      failVerifyWorker(worker)
    }
    verifyWorker = worker
  } catch {
    verifyWorker = null
  }
  return verifyWorker
}

function verifySchnorrBatch(items: SchnorrItem[]): Promise<boolean[]> {
  if (items.length === 0) return Promise.resolve([])
  const worker = getVerifyWorker()
  if (!worker) return Promise.resolve(verifySchnorrSync(items))
  return new Promise((resolve) => {
    const reqId = (verifyReqId += 1)
    const timer = setTimeout(() => {
      resolvePendingVerifyBatch(reqId, undefined)
    }, 8_000)
    pendingVerify.set(reqId, { items, resolve, timer })
    try {
      worker.postMessage({ reqId, items })
    } catch {
      failVerifyWorker(worker)
    }
  })
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

function dropRelayConnection(
  conn: RelayConnection,
  connections: Map<string, RelayConnection>
): void {
  if (connections.get(conn.url) === conn) connections.delete(conn.url)
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

function scheduleRelayConnectionIdleClose(
  conn: RelayConnection,
  connections: Map<string, RelayConnection>
): void {
  if (conn.idleTimer) clearTimeout(conn.idleTimer)
  conn.idleTimer = setTimeout(() => {
    if (conn.subs.size === 0) dropRelayConnection(conn, connections)
  }, RELAY_CONNECTION_IDLE_MS)
}

function getRelayConnection(
  url: string,
  connections: Map<string, RelayConnection>
): RelayConnection {
  const existing = connections.get(url)
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
      dropRelayConnection(conn, connections)
    }
    ws.onclose = () => {
      if (!conn.isOpen) reject(new Error("relay closed before open"))
      dropRelayConnection(conn, connections)
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

  connections.set(url, conn)
  return conn
}

function closeRelayConnections(
  connections: Map<string, RelayConnection>
): void {
  for (const conn of [...connections.values()]) {
    dropRelayConnection(conn, connections)
  }
  connections.clear()
}

function closeAllRelayConnections(): void {
  closeRelayConnections(relayConnections)
}

function readRelayEvents(
  relayUrl: string,
  filter: NDKFilter,
  connectTimeoutMs: number,
  fetchTimeoutMs: number,
  connections: Map<string, RelayConnection>
): Promise<{ events: RawNostrEvent[]; complete: boolean }> {
  return new Promise((resolve) => {
    const conn = getRelayConnection(relayUrl, connections)
    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer)
      conn.idleTimer = undefined
    }

    const subId = `cnd-${(relayReadSubCounter += 1)}`
    const events: RawNostrEvent[] = []
    let settled = false
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let fetchTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (complete: boolean) => {
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
        scheduleRelayConnectionIdleClose(conn, connections)
      }
      resolve({ events, complete })
    }

    conn.subs.set(subId, {
      onEvent: (raw) => {
        events.push(raw)
      },
      end: (reason) => finish(reason === "eose"),
    })

    connectTimer = setTimeout(() => finish(false), connectTimeoutMs)

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
        fetchTimer = setTimeout(() => finish(false), fetchTimeoutMs)
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
  fetchTimeoutMs: number,
  connections: Map<string, RelayConnection>
): Promise<{
  relayUrl: string
  events: NDKEvent[]
  status: FetchEventsRelayStatus["status"]
}> {
  await acquireRelayReadSlot()
  try {
    const { events, complete } = await readRelayEvents(
      relayUrl,
      filter,
      connectTimeoutMs,
      fetchTimeoutMs,
      connections
    )
    const status: FetchEventsRelayStatus["status"] = complete
      ? "success"
      : events.length > 0
        ? "partial"
        : "failed"

    if (status === "failed") {
      recordRelayFailure(relayUrl)
      return { relayUrl, events: [], status }
    }

    if (status === "success") recordRelaySuccess(relayUrl)
    else recordRelayFailure(relayUrl)

    // Main thread: cheap sha256 id-check + verified-id cache. Anything not
    // already cache-verified is batched to the worker for schnorr.
    const accepted = new Array<boolean>(events.length).fill(false)
    const schnorrItems: SchnorrItem[] = []
    const schnorrIndex: number[] = []
    for (let i = 0; i < events.length; i++) {
      const raw = events[i]
      const state = checkEventId(raw)
      if (state === "invalid") continue
      if (state === "cached") {
        accepted[i] = true
        continue
      }
      schnorrItems.push({ sig: raw.sig, id: raw.id, pubkey: raw.pubkey })
      schnorrIndex.push(i)
    }

    const schnorrValid = await verifySchnorrBatch(schnorrItems)
    for (let j = 0; j < schnorrIndex.length; j++) {
      if (!schnorrValid[j]) continue
      const i = schnorrIndex[j]
      accepted[i] = true
      if (verifiedEventIds.size >= MAX_VERIFIED_ID_CACHE)
        verifiedEventIds.clear()
      verifiedEventIds.add(events[i].id)
    }

    const verified: NDKEvent[] = []
    for (let i = 0; i < events.length; i++) {
      if (!accepted[i]) continue
      const event = new NDKEvent(undefined, events[i])
      attachEventSourceRelayUrl(event, relayUrl)
      verified.push(event)
    }
    return { relayUrl, events: verified, status }
  } catch {
    recordRelayFailure(relayUrl)
    return { relayUrl, events: [], status: "failed" }
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
  return (await fetchEventsFanoutDetailed(filter, options)).events
}

export async function fetchEventsFanoutDetailed(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions = {}
): Promise<FetchEventsFanoutResult> {
  const relayUrls = resolveFanoutRelayUrls(options)

  if (relayUrls.length === 0) return { events: [], relays: [] }

  const connectTimeoutMs = options.connectTimeoutMs ?? 4_000
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 8_000
  const connections =
    options.reuseRelayConnections === false
      ? new Map<string, RelayConnection>()
      : relayConnections

  try {
    const perRelayResults = await Promise.all(
      relayUrls.map((relayUrl) =>
        fetchEventsFromRelay(
          relayUrl,
          filter,
          connectTimeoutMs,
          fetchTimeoutMs,
          connections
        )
      )
    )

    const merged = new Map<string, NDKEvent>()
    for (const result of perRelayResults) {
      mergeEventsInto(merged, result.events)
    }

    return {
      events: Array.from(merged.values()),
      relays: perRelayResults.map((result) => ({
        relayUrl: result.relayUrl,
        status: result.status,
        eventCount: result.events.length,
      })),
    }
  } finally {
    if (connections !== relayConnections) closeRelayConnections(connections)
  }
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
  const connections =
    options.reuseRelayConnections === false
      ? new Map<string, RelayConnection>()
      : relayConnections

  try {
    await Promise.all(
      relayUrls.map(async (relayUrl) => {
        const result = await fetchEventsFromRelay(
          relayUrl,
          filter,
          connectTimeoutMs,
          fetchTimeoutMs,
          connections
        )
        mergeEventsInto(merged, result.events)
        await onProgress({
          relayUrl,
          events: result.events,
          mergedEvents: Array.from(merged.values()),
        })
      })
    )

    return Array.from(merged.values())
  } finally {
    if (connections !== relayConnections) closeRelayConnections(connections)
  }
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

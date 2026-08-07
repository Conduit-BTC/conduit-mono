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
import { matchFilter, validateEvent, type Filter } from "nostr-tools"
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
import type { SignedPublicNostrEvent } from "./signed-event"

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
  signal?: AbortSignal
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
  /**
   * True only when every returned event completed id and Schnorr verification
   * through this module's bounded worker-backed pipeline.
   */
  eventsVerified?: boolean
}

export interface VerifySignedPublicNostrEventsOptions {
  signal?: AbortSignal
  maxEvents?: number
}

export interface VerifySignedPublicNostrEventsResult {
  events: SignedPublicNostrEvent[]
  truncated: boolean
}

export interface FetchEventsFanoutDiagnosticsResult {
  events: NDKEvent[]
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
}

const EVENT_SOURCE_RELAY_URLS = "__conduitSourceRelayUrls"

type EventWithSourceRelayUrls = NDKEvent & {
  [EVENT_SOURCE_RELAY_URLS]?: string[]
}

type Listener = () => void

/**
 * Identifies the auth lifecycle that installed the shared NDK signer.
 * Cleanup must present the same lease so an older provider cannot clear a
 * signer installed by a newer provider during remounts or Fast Refresh.
 */
export type SignerLease = {
  readonly signer: NDKSigner
  readonly token: symbol
}

let ndkInstance: NDK | null = null
let activeSignerLease: SignerLease | null = null
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
    if (activeSignerLease) {
      // Relay-client resets must not silently disconnect the auth session.
      ndkInstance.signer = activeSignerLease.signer
    }
  }
  return ndkInstance
}

const MAX_CONCURRENT_RELAY_READS = 8
const MAX_QUEUED_RELAY_READS = 128
let activeRelayReads = 0
type RelayReadWaiter = {
  resolve: () => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}
const relayReadWaiters: RelayReadWaiter[] = []

function abortError(): Error {
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  )
}

function acquireRelayReadSlot(signal?: AbortSignal): Promise<void> {
  try {
    throwIfAborted(signal)
  } catch (error) {
    return Promise.reject(error)
  }

  if (activeRelayReads < MAX_CONCURRENT_RELAY_READS) {
    activeRelayReads += 1
    return Promise.resolve()
  }
  if (relayReadWaiters.length >= MAX_QUEUED_RELAY_READS) {
    return Promise.reject(new Error("Relay read queue is at capacity."))
  }

  return new Promise<void>((resolve, reject) => {
    const waiter: RelayReadWaiter = { resolve, reject, signal }
    if (signal) {
      waiter.onAbort = () => {
        const index = relayReadWaiters.indexOf(waiter)
        if (index >= 0) relayReadWaiters.splice(index, 1)
        reject(abortError())
      }
      signal.addEventListener("abort", waiter.onAbort, { once: true })
    }
    relayReadWaiters.push(waiter)
  })
}

function releaseRelayReadSlot(): void {
  while (relayReadWaiters.length > 0) {
    const next = relayReadWaiters.shift()!
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort)
    }
    if (next.signal?.aborted) {
      next.reject(abortError())
      continue
    }
    next.resolve()
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

const HEX_64 = /^[0-9a-f]{64}$/i
const HEX_128 = /^[0-9a-f]{128}$/i

function isCanonicalSignedPublicNostrEvent(
  event: RawNostrEvent
): event is SignedPublicNostrEvent {
  return (
    HEX_64.test(event.id) &&
    HEX_64.test(event.pubkey) &&
    HEX_128.test(event.sig) &&
    Number.isSafeInteger(event.created_at) &&
    event.created_at > 0 &&
    Number.isSafeInteger(event.kind) &&
    event.kind >= 0 &&
    event.kind <= 65_535 &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length > 0 &&
        tag.every((value) => typeof value === "string")
    )
  )
}

function requestedEventLimit(filter: NDKFilter): number | null {
  return typeof filter.limit === "number" &&
    Number.isSafeInteger(filter.limit) &&
    filter.limit > 0
    ? filter.limit
    : null
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
// from many relays. Cache the id+signature proof so the expensive check runs
// once per exact signed event, not once per relay copy. Event ids do not bind
// the signature itself, so caching by id alone would let a later invalid
// signature reuse an otherwise valid event id.
const MAX_VERIFIED_PROOF_CACHE = 20000
const verifiedEventProofs = new Set<string>()
const MAX_RAW_RELAY_EVENT_FRAMES = 5000
const MIN_RAW_RELAY_EVENT_FRAMES = 256
const MAX_RELAY_MESSAGE_CHARS = 512 * 1024
const MAX_RELAY_SUBSCRIPTION_CHARS = 8 * 1024 * 1024
const MAX_RELAY_CONNECTION_FRAMES = 10_000
const MAX_RELAY_CONNECTION_CHARS = 16 * 1024 * 1024
const MAX_SIGNATURES_PER_RELAY_READ = 512

type SchnorrItem = { sig: string; id: string; pubkey: string }

function verificationProofKey(event: RawNostrEvent): string {
  return `${event.id}:${event.sig}`
}

// Cheap main-thread check: valid shape + id binds to content. Returns the
// verified-cache state so callers know whether schnorr still needs to run.
function checkEventId(
  event: RawNostrEvent
): "cached" | "needs-schnorr" | "invalid" {
  try {
    if (!isCanonicalSignedPublicNostrEvent(event)) return "invalid"
    if (computeEventId(event) !== event.id) return "invalid"
    return verifiedEventProofs.has(verificationProofKey(event))
      ? "cached"
      : "needs-schnorr"
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

async function verifySchnorrChunked(
  items: SchnorrItem[],
  signal?: AbortSignal
): Promise<boolean[]> {
  const valid: boolean[] = []
  const chunkSize = 16
  for (let index = 0; index < items.length; index += chunkSize) {
    throwIfAborted(signal)
    valid.push(...verifySchnorrSync(items.slice(index, index + chunkSize)))
    if (index + chunkSize < items.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  throwIfAborted(signal)
  return valid
}

// Offload schnorr verification to a worker so the crypto never blocks the main
// thread. When Workers are unavailable (SSR/tests), verify in bounded chunks
// with cancellation points. Active worker failures reject their batches.
let verifyWorker: Worker | null | undefined
let verifyReqId = 0
const DEFAULT_VERIFY_WORKER_TIMEOUT_MS = 8_000
let verifyWorkerTimeoutMs = DEFAULT_VERIFY_WORKER_TIMEOUT_MS
type PendingVerifyBatch = {
  items: SchnorrItem[]
  resolve: (valid: boolean[]) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}
const pendingVerify = new Map<number, PendingVerifyBatch>()
let verifyWorkerRestartScheduled = false

function clearPendingVerifyBatch(
  reqId: number
): PendingVerifyBatch | undefined {
  const pending = pendingVerify.get(reqId)
  if (!pending) return undefined

  pendingVerify.delete(reqId)
  clearTimeout(pending.timer)
  if (pending.signal && pending.onAbort) {
    pending.signal.removeEventListener("abort", pending.onAbort)
  }
  return pending
}

function resolvePendingVerifyBatch(reqId: number, valid: boolean[]): void {
  const pending = clearPendingVerifyBatch(reqId)
  if (!pending) return

  if (pending.signal?.aborted) {
    pending.reject(abortError())
    return
  }
  pending.resolve(valid)
}

function rejectPendingVerifyBatch(reqId: number, reason: unknown): void {
  clearPendingVerifyBatch(reqId)?.reject(reason)
}

function scheduleVerifyWorkerRestart(): void {
  if (verifyWorkerRestartScheduled || !verifyWorker) return
  verifyWorkerRestartScheduled = true

  queueMicrotask(() => {
    verifyWorkerRestartScheduled = false
    const worker = verifyWorker
    if (worker) {
      verifyWorker = undefined
      worker.onmessage = null
      worker.onerror = null
      try {
        worker.terminate()
      } catch {
        // ignore teardown errors
      }
    }

    if (pendingVerify.size === 0) return
    const replacement = getVerifyWorker()
    if (!replacement) {
      for (const reqId of [...pendingVerify.keys()]) {
        rejectPendingVerifyBatch(
          reqId,
          new Error("Signature verification worker is unavailable.")
        )
      }
      return
    }

    for (const [reqId, pending] of [...pendingVerify.entries()]) {
      if (pending.signal?.aborted) {
        clearPendingVerifyBatch(reqId)?.reject(abortError())
        continue
      }
      try {
        replacement.postMessage({ reqId, items: pending.items })
      } catch {
        failVerifyWorker(replacement)
        break
      }
    }
  })
}

function cancelPendingVerifyBatch(reqId: number): void {
  const pending = clearPendingVerifyBatch(reqId)
  if (!pending) return
  pending.reject(abortError())
  // A Web Worker cannot remove an already-posted message from its queue.
  // Restarting clears stale crypto work; non-cancelled batches are re-posted.
  scheduleVerifyWorkerRestart()
}

function failVerifyWorker(worker: Worker): void {
  if (verifyWorker !== worker) return
  verifyWorker = null
  worker.onmessage = null
  worker.onerror = null
  try {
    worker.terminate()
  } catch {
    // ignore teardown errors
  }

  for (const reqId of [...pendingVerify.keys()]) {
    rejectPendingVerifyBatch(
      reqId,
      new Error("Signature verification worker failed.")
    )
  }
}

export function __setNdkVerifyTimeoutMsForTests(timeoutMs: number): void {
  verifyWorkerTimeoutMs = Math.max(1, Math.floor(timeoutMs))
}

export function __resetNdkTestState(): void {
  activeSignerLease = null
  if (ndkInstance) ndkInstance.signer = undefined
  if (verifyWorker) {
    verifyWorker.onmessage = null
    verifyWorker.onerror = null
    try {
      verifyWorker.terminate()
    } catch {
      // ignore teardown errors
    }
  }
  verifyWorker = undefined
  verifyWorkerRestartScheduled = false
  verifyWorkerTimeoutMs = DEFAULT_VERIFY_WORKER_TIMEOUT_MS
  for (const reqId of [...pendingVerify.keys()]) {
    clearPendingVerifyBatch(reqId)?.reject(abortError())
  }
  verifiedEventProofs.clear()
  for (const waiter of relayReadWaiters.splice(0)) {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort)
    }
    waiter.reject(abortError())
  }
  activeRelayReads = 0
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

function verifySchnorrBatch(
  items: SchnorrItem[],
  signal?: AbortSignal
): Promise<boolean[]> {
  throwIfAborted(signal)
  if (items.length === 0) return Promise.resolve([])
  const worker = getVerifyWorker()
  if (!worker) return verifySchnorrChunked(items, signal)
  if (pendingVerify.size >= MAX_CONCURRENT_RELAY_READS) {
    return Promise.reject(
      new Error("Signature verification queue is at capacity.")
    )
  }
  return new Promise((resolve, reject) => {
    const reqId = (verifyReqId += 1)
    const timer = setTimeout(() => {
      rejectPendingVerifyBatch(
        reqId,
        new Error("Signature verification worker timed out.")
      )
      scheduleVerifyWorkerRestart()
    }, verifyWorkerTimeoutMs)
    const pending: PendingVerifyBatch = {
      items,
      resolve,
      reject,
      timer,
      signal,
    }
    if (signal) {
      pending.onAbort = () => cancelPendingVerifyBatch(reqId)
      signal.addEventListener("abort", pending.onAbort, { once: true })
    }
    pendingVerify.set(reqId, pending)
    try {
      worker.postMessage({ reqId, items })
    } catch {
      failVerifyWorker(worker)
    }
  })
}

/**
 * Verify a bounded collection of already-parsed public events without running
 * Schnorr work on the browser's main thread. This is used for signed events
 * embedded inside other protocol payloads and for injectable fetch seams that
 * cannot attest to the fanout reader's verification pipeline.
 */
export async function verifySignedPublicNostrEvents(
  events: readonly SignedPublicNostrEvent[],
  options: VerifySignedPublicNostrEventsOptions = {}
): Promise<VerifySignedPublicNostrEventsResult> {
  throwIfAborted(options.signal)
  const requestedMax =
    options.maxEvents === undefined
      ? MAX_SIGNATURES_PER_RELAY_READ
      : Math.floor(options.maxEvents)
  const maxEvents = Number.isFinite(requestedMax)
    ? Math.max(0, Math.min(MAX_SIGNATURES_PER_RELAY_READ, requestedMax))
    : 0
  const boundedEvents = events.slice(0, maxEvents)
  const accepted = new Array<boolean>(boundedEvents.length).fill(false)
  const schnorrItems: SchnorrItem[] = []
  const schnorrIndexes: number[] = []

  for (let index = 0; index < boundedEvents.length; index += 1) {
    throwIfAborted(options.signal)
    const event = boundedEvents[index]
    if (!validateEvent(event)) continue
    const state = checkEventId(event)
    if (state === "invalid") continue
    if (state === "cached") {
      accepted[index] = true
      continue
    }
    schnorrItems.push({
      sig: event.sig,
      id: event.id,
      pubkey: event.pubkey,
    })
    schnorrIndexes.push(index)
  }

  const schnorrValid = await verifySchnorrBatch(schnorrItems, options.signal)
  throwIfAborted(options.signal)
  for (let index = 0; index < schnorrIndexes.length; index += 1) {
    if (!schnorrValid[index]) continue
    const eventIndex = schnorrIndexes[index]
    accepted[eventIndex] = true
    if (verifiedEventProofs.size >= MAX_VERIFIED_PROOF_CACHE) {
      verifiedEventProofs.clear()
    }
    verifiedEventProofs.add(verificationProofKey(boundedEvents[eventIndex]))
  }

  return {
    events: boundedEvents.filter((_, index) => accepted[index]),
    truncated: events.length > boundedEvents.length,
  }
}

// One shared WebSocket per relay, with REQs multiplexed by subId across
// concurrent reads. Explicit CLOSE per sub; the socket stays warm and idle-closes
// once no reads are using it. No auto-reconnect, so failing relays are attempted
// once (not re-hammered by every concurrent read) and freed deterministically.
type RelaySubEnd = "eose" | "closed" | "drop"
type RelaySub = {
  onEvent: (raw: RawNostrEvent, frameChars: number) => void
  end: (reason: RelaySubEnd) => void
}
type RelayConnection = {
  url: string
  ws: WebSocket
  ready: Promise<void>
  isOpen: boolean
  closed: boolean
  subs: Map<string, RelaySub>
  inboundFrames: number
  inboundChars: number
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
    inboundFrames: 0,
    inboundChars: 0,
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
      if (conn.closed) return
      if (
        typeof message.data !== "string" ||
        message.data.length > MAX_RELAY_MESSAGE_CHARS
      ) {
        // Treat oversized/unexpected relay frames as a transport failure so
        // affected reads cannot be reported as a complete empty observation.
        dropRelayConnection(conn, connections)
        return
      }
      conn.inboundFrames += 1
      conn.inboundChars += message.data.length
      if (
        conn.inboundFrames > MAX_RELAY_CONNECTION_FRAMES ||
        conn.inboundChars > MAX_RELAY_CONNECTION_CHARS
      ) {
        // Budget all inbound traffic, including malformed JSON, NOTICE/AUTH,
        // and events for unknown subscriptions, before parsing.
        dropRelayConnection(conn, connections)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        return
      }
      if (!Array.isArray(parsed)) return
      const [type, sub] = parsed as [string, string, ...unknown[]]
      if (typeof sub !== "string") return
      const handler = conn.subs.get(sub)
      if (!handler) return
      if (type === "EVENT" && parsed[2]) {
        handler.onEvent(parsed[2] as RawNostrEvent, message.data.length)
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
  connections: Map<string, RelayConnection>,
  signal?: AbortSignal
): Promise<{
  events: RawNostrEvent[]
  complete: boolean
  truncated: boolean
}> {
  try {
    throwIfAborted(signal)
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    const conn = getRelayConnection(relayUrl, connections)
    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer)
      conn.idleTimer = undefined
    }
    if (conn.subs.size === 0) {
      conn.inboundFrames = 0
      conn.inboundChars = 0
    }

    const subId = `cnd-${(relayReadSubCounter += 1)}`
    const events: RawNostrEvent[] = []
    const eventLimit = requestedEventLimit(filter)
    const rawFrameLimit =
      eventLimit === null
        ? MAX_RAW_RELAY_EVENT_FRAMES
        : Math.min(
            MAX_RAW_RELAY_EVENT_FRAMES,
            Math.max(MIN_RAW_RELAY_EVENT_FRAMES, eventLimit * 4)
          )
    let rawFrameCount = 0
    let rawFrameChars = 0
    let settled = false
    let connectTimer: ReturnType<typeof setTimeout> | undefined
    let fetchTimer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined

    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer)
      if (fetchTimer) clearTimeout(fetchTimer)
      if (signal && onAbort) signal.removeEventListener("abort", onAbort)
      conn.subs.delete(subId)
      if (!conn.closed && conn.ws.readyState === WebSocket.OPEN) {
        try {
          conn.ws.send(JSON.stringify(["CLOSE", subId]))
        } catch {
          // ignore
        }
      }
      if (!conn.closed && conn.subs.size === 0) {
        conn.inboundFrames = 0
        conn.inboundChars = 0
        scheduleRelayConnectionIdleClose(conn, connections)
      }
    }

    const finish = (complete: boolean, truncated = false) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ events, complete, truncated })
    }

    conn.subs.set(subId, {
      onEvent: (raw, frameChars) => {
        rawFrameCount += 1
        rawFrameChars += frameChars
        if (rawFrameChars > MAX_RELAY_SUBSCRIPTION_CHARS) {
          finish(false, true)
          return
        }
        try {
          if (
            validateEvent(raw) &&
            matchFilter(filter as Filter, raw) &&
            (eventLimit === null || events.length < rawFrameLimit)
          ) {
            events.push(raw)
          }
        } catch {
          // Ignore malformed or locally non-matching relay frames.
        }

        // A separate raw-frame guard bounds invalid, non-matching, and
        // unverified floods. Saturating it is truncation, never a complete
        // EOSE read.
        if (rawFrameCount >= rawFrameLimit) {
          finish(false, true)
        }
      },
      end: (reason) => finish(reason === "eose"),
    })

    if (signal) {
      onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(abortError())
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }

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
  connections: Map<string, RelayConnection>,
  signal?: AbortSignal
): Promise<{
  relayUrl: string
  events: NDKEvent[]
  status: FetchEventsRelayStatus["status"]
}> {
  await acquireRelayReadSlot(signal)
  try {
    throwIfAborted(signal)
    const { events, complete, truncated } = await readRelayEvents(
      relayUrl,
      filter,
      connectTimeoutMs,
      fetchTimeoutMs,
      connections,
      signal
    )
    throwIfAborted(signal)
    // Main thread: cheap sha256 id-check + verified-id cache. Anything not
    // already cache-verified is batched to the worker for schnorr.
    const accepted = new Array<boolean>(events.length).fill(false)
    const schnorrItems: SchnorrItem[] = []
    const schnorrIndex: number[] = []
    let verificationTruncated = false
    for (let i = 0; i < events.length; i++) {
      const raw = events[i]
      const state = checkEventId(raw)
      if (state === "invalid") continue
      if (state === "cached") {
        accepted[i] = true
        continue
      }
      if (schnorrItems.length >= MAX_SIGNATURES_PER_RELAY_READ) {
        verificationTruncated = true
        continue
      }
      schnorrItems.push({ sig: raw.sig, id: raw.id, pubkey: raw.pubkey })
      schnorrIndex.push(i)
    }

    const schnorrValid = await verifySchnorrBatch(schnorrItems, signal)
    throwIfAborted(signal)
    for (let j = 0; j < schnorrIndex.length; j++) {
      if (!schnorrValid[j]) continue
      const i = schnorrIndex[j]
      accepted[i] = true
      if (verifiedEventProofs.size >= MAX_VERIFIED_PROOF_CACHE) {
        verifiedEventProofs.clear()
      }
      verifiedEventProofs.add(verificationProofKey(events[i]))
    }

    const eventLimit = requestedEventLimit(filter)
    const verified: NDKEvent[] = []
    for (let i = 0; i < events.length; i++) {
      if (!accepted[i]) continue
      const event = new NDKEvent(undefined, events[i])
      attachEventSourceRelayUrl(event, relayUrl)
      verified.push(event)
      if (eventLimit !== null && verified.length >= eventLimit) break
    }

    const status: FetchEventsRelayStatus["status"] =
      truncated || verificationTruncated
        ? "partial"
        : complete
          ? "success"
          : verified.length > 0
            ? "partial"
            : "failed"

    if (status === "success") recordRelaySuccess(relayUrl)
    else recordRelayFailure(relayUrl)

    return { relayUrl, events: verified, status }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error
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
  throwIfAborted(options.signal)
  const relayUrls = resolveFanoutRelayUrls(options)

  if (relayUrls.length === 0) {
    return { events: [], relays: [], eventsVerified: true }
  }

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
          connections,
          options.signal
        )
      )
    )
    throwIfAborted(options.signal)

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
      eventsVerified: true,
    }
  } finally {
    if (connections !== relayConnections) closeRelayConnections(connections)
  }
}

export async function fetchEventsFanoutWithDiagnostics(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions = {}
): Promise<FetchEventsFanoutDiagnosticsResult> {
  const result = await fetchEventsFanoutDetailed(filter, options)

  return {
    events: result.events,
    attemptedRelayUrls: result.relays.map(({ relayUrl }) => relayUrl),
    successfulRelayUrls: result.relays
      .filter(({ status }) => status !== "failed")
      .map(({ relayUrl }) => relayUrl),
    failedRelayUrls: result.relays
      .filter(({ status }) => status !== "success")
      .map(({ relayUrl }) => relayUrl),
  }
}

export async function fetchEventsFanoutProgressive(
  filter: NDKFilter,
  options: FetchEventsFanoutOptions = {},
  onProgress: (progress: FetchEventsFanoutProgress) => void | Promise<void>
): Promise<NDKEvent[]> {
  throwIfAborted(options.signal)
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
          connections,
          options.signal
        )
        throwIfAborted(options.signal)
        mergeEventsInto(merged, result.events)
        await onProgress({
          relayUrl,
          events: result.events,
          mergedEvents: Array.from(merged.values()),
        })
      })
    )

    throwIfAborted(options.signal)
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
      ndkInstance = null
      connectPromise = null
      ndk = getNdk()

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

export function setSigner(signer: NDKSigner): SignerLease {
  const lease = Object.freeze({
    signer,
    token: Symbol("ndk-signer-lease"),
  })
  activeSignerLease = lease
  const ndk = getNdk()
  ndk.signer = signer
  return lease
}

export function removeSigner(lease: SignerLease): void {
  if (lease !== activeSignerLease) return
  activeSignerLease = null
  if (ndkInstance) {
    ndkInstance.signer = undefined
  }
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

  if (ndkInstance) {
    for (const [, relay] of ndkInstance.pool?.relays?.entries() ?? []) {
      relay.disconnect()
    }
  }
  closeAllRelayConnections()

  ndkInstance = null
  connectPromise = null
  requirePromise = null

  getNdk()

  setState({
    status: "idle",
    connectedRelays: [],
    error: null,
  })
}

/** Public reads own isolated sockets, bounded verification and source coverage. */
import type { SignedPublicNostrEvent } from "./signed-event"
import { matchFilter, validateEvent, type Filter } from "nostr-tools"
import { config } from "../config"
import {
  getConfiguredIsolatedE2eRelayUrl,
  getGeneralReadRelayUrls,
  normalizeSecureOrIsolatedE2eRelayUrls,
  tryNormalizeRelayUrl,
} from "./relay-settings"
import {
  isRelayRateLimited,
  partitionByHealth,
  recordRelayRateLimit,
  recordRelayFailure,
  recordRelaySuccess,
} from "./relay-health"
import {
  filterEligibleAccountRelayUrls,
  orderEquivalentAccountRelayOperations,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import { NostrSignerError } from "./nostr-event-signer"
import {
  verifySignedEvents as admitSignedEvents,
  __resetPublicEventVerificationForTests,
  __setPublicEventVerifyTimeoutMsForTests,
  sameSignedPublicEvent,
  snapshotSignedPublicEvent,
  signedPublicEventProofKey,
  PublicEventVerificationUnavailableError,
  type VerifiedNostrEvent,
  type VerifySignedPublicNostrEventsOptions,
} from "./verified-public-event"
export async function verifySignedEvents(
  events: readonly unknown[],
  options: VerifySignedPublicNostrEventsOptions = {}
) {
  // Bind each observation to its original bytes before admission yields. Index
  // only sources with metadata, avoiding a quadratic scan of every event batch.
  const sources = new Map<
    string,
    { event: SignedPublicNostrEvent; urls: string[] }[]
  >()
  const limit = Math.min(512, Math.max(0, Math.floor(options.maxEvents ?? 512)))
  for (const raw of events.slice(0, limit)) {
    if (!raw || typeof raw !== "object") continue
    const urls = getEventSourceRelayUrls(raw)
    if (!urls.length) continue
    try {
      const event = snapshotSignedPublicEvent(raw as SignedPublicNostrEvent)
      const key = signedPublicEventProofKey(event)
      const bucket = sources.get(key) ?? []
      bucket.push({ event, urls })
      sources.set(key, bucket)
    } catch {
      // A malformed envelope cannot contribute admitted source evidence.
    }
  }
  const restoreSources = (admitted: readonly VerifiedNostrEvent[]) => {
    for (const event of admitted) {
      for (const source of sources.get(signedPublicEventProofKey(event)) ??
        []) {
        if (sameSignedPublicEvent(event, source.event))
          for (const url of source.urls) attachEventSourceRelayUrl(event, url)
      }
    }
  }
  try {
    const result = await admitSignedEvents(events, options)
    restoreSources(result.events)
    return result
  } catch (error) {
    if (error instanceof PublicEventVerificationUnavailableError)
      restoreSources(error.events)
    throw error
  }
}
/** Admit every observation in bounded batches, preserving order and sources. */
export async function verifySignedEventBatches(
  events: readonly unknown[],
  options: { signal?: AbortSignal; batchSize?: 64 | 512 } = {}
): Promise<VerifiedNostrEvent[]> {
  const batchSize = options.batchSize ?? 512
  const verified: VerifiedNostrEvent[] = []
  for (let offset = 0; offset < events.length; offset += batchSize) {
    const batch = await verifySignedEvents(
      events.slice(offset, offset + batchSize),
      { signal: options.signal, maxEvents: batchSize }
    )
    verified.push(...batch.events)
  }
  return verified
}

export type {
  VerifySignedPublicNostrEventsOptions,
  VerifySignedPublicNostrEventsResult,
} from "./verified-public-event"

export interface PublicRelayReadSocket {
  readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent | Event) => void) | null
  send(payload: string): void
  close(): void
}
export interface PublicRelayReadSocketScope {
  createWebSocket: (url: string) => PublicRelayReadSocket
}
// The standard readyState value also applies to injected socket implementations.
const WEBSOCKET_OPEN = 1

export interface PublicRelayReadOptions {
  /** Separate public-only pool for injected transports; never an authenticated socket. */
  socketScope?: PublicRelayReadSocketScope
  onConnection?: (relayUrl: string) => void
  maxFramesPerRelay?: number
  maxEventsPerRelay?: number
  maxBytesPerRelay?: number

  /** Omit for configured defaults; pass an empty array for no relay traffic. */
  relayUrls?: string[]
  /**
   * Bound actual relay attempts after the live account source-policy check.
   * Policy-suppressed, throttled, and durably excluded candidates do not consume
   * this limit, allowing a later eligible source to fill the bounded fanout.
   */
  maxRelayAttempts?: number
  /**
   * Explicit account whose locally removed whole relays must be excluded.
   * Omit for guest/public reads; event authors and filter pubkeys are never
   * treated as the active account.
   */
  accountPubkey?: string | null
  /**
   * Active authenticated account. It must exactly match `accountPubkey` before
   * an owner-selected ws:// target can reach final I/O.
   */
  authenticatedPubkey?: string | null
  /**
   * Exact read-target subset selected by that authenticated account owner.
   * Remote/discovered relay hints must never populate this field.
   */
  ownerSelectedRelayUrls?: readonly string[]
  /** Exact candidates contributed by Conduit's app-owned relay layer. */
  appRelayUrls?: readonly string[]
  /** Exact candidates contributed by the owner's NIP-65 relay layer. */
  personalRelayUrls?: readonly string[]
  /** Exact candidates independently authorized outside the local source layers. */
  independentRelayUrls?: readonly string[]
  /** Injectable durable-state reader for deterministic boundary tests. */
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  /** Live caller authority, rechecked immediately before final relay I/O. */
  shouldContinue?: () => boolean
  connectTimeoutMs?: number
  fetchTimeoutMs?: number
  skipHealthFilter?: boolean
  reuseRelayConnections?: boolean
  signal?: AbortSignal
  /** Preserve one search relay's response order through verification and limiting. */
  preserveEventOrder?: boolean
  /** Cumulative verified observations after each relay finishes; not final coverage. */
  onProgress?: (result: PublicRelayReadResult) => void
  /** Per-source discovery over the same executor and coverage snapshots. */
  onRelayProgress?: (progress: PublicRelayReadProgress) => void | Promise<void>
}

export interface PublicRelayReadProgress {
  relayUrl: string
  events: VerifiedNostrEvent[]
  mergedEvents: VerifiedNostrEvent[]
  status?: PublicRelayReadSourceStatus["status"]
  result?: PublicRelayReadResult
}

export type PublicRelayReadOutcome =
  | "eose"
  | "closed"
  | "auth_required"
  | "rejected"
  | "rate_limited"
  | "disconnected"
  | "connect_timeout"
  | "timeout"
  | "cancelled"
  | "malformed"
  | "resource_limit"
  | "verification_failed"
  | "unavailable"
export interface PublicRelayReadSourceStatus {
  relayUrl: string
  status: "success" | "partial" | "failed"
  /** Distinct verified event ids selected from this source; copies are counted separately. */
  eventCount: number
  /** Structurally matching events rejected by id or signature verification. */
  rejectedEventCount?: number
  malformedEventCount?: number
  duplicateEventCount?: number
  unusableEventCount?: number
  eoseReceived?: boolean
  outcome?: PublicRelayReadOutcome
  /** Content-free rejection category; never retain the relay message. */
  failureReason?: "rate_limited"
}

export interface PublicRelayReadResult {
  events: VerifiedNostrEvent[]
  relays: PublicRelayReadSourceStatus[]
  eventSourceRelayUrls?: Record<string, string[]>
  /** Actual I/O attempts, distinct from policy/health-suppressed candidates. */
  attemptedRelayUrls?: string[]
  requestedRelayUrls?: string[]
  readCoverage?: "complete" | "partial" | "unavailable" | "cancelled"
  phase?: "progressive" | "terminal"
  startedAt?: number
  observedAt?: number
  /** Fresh within this operation only; domain caches decide stale/conflicting. */
  freshness?: "current"
  /** A bounded relay plan never establishes global absence. */
  globalAbsence?: false
  /**
   * Exact relays that passed final source-policy admission and consumed this
   * completed read's bounded attempt budget. Older injected adapters may omit
   * this field; coverage callers must then fall back to their requested plan.
   */
  admittedRelayUrls?: string[]
  /**
   * True only when every returned event completed id and Schnorr verification
   * through this module's bounded worker-backed pipeline.
   */
}

export interface PublicRelayReadDiagnosticsResult extends Partial<PublicRelayReadResult> {
  events: VerifiedNostrEvent[]
  attemptedRelayUrls: string[]
  successfulRelayUrls: string[]
  failedRelayUrls: string[]
  /** Relays whose response reached the filter limit and may be truncated. */
  cappedRelayUrls?: string[]
}

// Provenance is local evidence, never a field supplied on the wire. Object
// identity also prevents proof-cache hits from borrowing previous-read sources.
const eventSourceRelayUrls = new WeakMap<object, string[]>()

function uniqueRelayUrls(urls: readonly string[]): string[] {
  return Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)))
}

export function attachEventSourceRelayUrl(
  event: object,
  relayUrl: string
): void {
  eventSourceRelayUrls.set(
    event,
    uniqueRelayUrls([...(eventSourceRelayUrls.get(event) ?? []), relayUrl])
  )
}

export function getEventSourceRelayUrls(event: object): string[] {
  return [...(eventSourceRelayUrls.get(event) ?? [])]
}

export function mergeEventSourceRelayUrls(
  target: object,
  source: object
): void {
  for (const relayUrl of getEventSourceRelayUrls(source)) {
    attachEventSourceRelayUrl(target, relayUrl)
  }
}

const MAX_CONCURRENT_RELAY_READS = 8
const MAX_QUEUED_RELAY_READS = 128
let activeRelayReads = 0
let relaySettingsRefreshPending = false
type RelayReadWaiter = {
  resolve: () => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}
const relayReadWaiters: RelayReadWaiter[] = []
// A read owns its pool before it owns an execution slot, and through progress
// callbacks after that slot is released. Retirement must cover that lifetime.
const publicReadOperations = new Map<
  AbortController,
  {
    scope?: PublicRelayReadSocketScope
    connections: Map<string, RelayConnection>
  }
>()

function abortError(): Error {
  const error = new Error("The operation was aborted.")
  error.name = "AbortError"
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

// Policy storage only reads local state. Cancellation may abandon that wait;
// already-started caller callbacks still drain cooperatively.
function awaitReadPolicy<T>(
  pending: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })
    pending.then(
      (value) => {
        signal?.removeEventListener("abort", abort)
        resolve(value)
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", abort)
        reject(error)
      }
    )
  })
}

class RelayReadCallbackError extends Error {
  constructor(readonly reason: unknown) {
    super("Public relay observer failed.")
  }
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
  flushPendingRelaySettingsRefresh()
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

function requestedEventLimit(filter: Filter | Filter[]): number | null {
  if (Array.isArray(filter)) {
    const limits = filter.map(requestedEventLimit)
    return limits.every((limit) => limit !== null)
      ? limits.reduce<number>((sum, limit) => sum + (limit ?? 0), 0)
      : null
  }
  return typeof filter.limit === "number" &&
    Number.isSafeInteger(filter.limit) &&
    filter.limit >= 0
    ? filter.limit
    : null
}

let relayReadSubCounter = 0

const MAX_RAW_RELAY_EVENT_FRAMES = 5000
const MIN_RAW_RELAY_EVENT_FRAMES = 256
export const MAX_RELAY_MESSAGE_CHARS = 512 * 1024
const MAX_RELAY_SUBSCRIPTION_CHARS = 8 * 1024 * 1024
const MAX_RELAY_CONNECTION_FRAMES = 10_000
const MAX_RELAY_CONNECTION_CHARS = 16 * 1024 * 1024
const MAX_SIGNATURES_PER_RELAY_READ = 512

export const __setPublicReaderVerifyTimeoutMsForTests =
  __setPublicEventVerifyTimeoutMsForTests
export function __resetPublicReaderTestState(): void {
  closePublicRelayConnections()
  __resetPublicEventVerificationForTests()
  for (const waiter of relayReadWaiters.splice(0)) {
    if (waiter.signal && waiter.onAbort)
      waiter.signal.removeEventListener("abort", waiter.onAbort)
    waiter.reject(abortError())
  }
  activeRelayReads = 0
  publicReadOperations.clear()
}

// One shared WebSocket per relay, with REQs multiplexed by subId across
// concurrent reads. Explicit CLOSE per sub; the socket stays warm and idle-closes
// once no reads are using it. No auto-reconnect, so failing relays are attempted
// once (not re-hammered by every concurrent read) and freed deterministically.
type RelaySubEnd =
  | "eose"
  | "closed"
  | "disconnected"
  | "cancelled"
  | "rate_limited"
  | "auth_required"
  | "rejected"
  | "resource_limit"
type RelaySub = {
  onEvent: (raw: RawNostrEvent, frameChars: number) => void
  end: (reason: RelaySubEnd) => void
  malformed: () => void
  frame: (chars: number) => void
}
type RelayConnection = {
  url: string
  ws: PublicRelayReadSocket
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
const scopedPublicConnections = new Map<
  PublicRelayReadSocketScope,
  Map<string, RelayConnection>
>()

function dropRelayConnection(
  conn: RelayConnection,
  connections: Map<string, RelayConnection>,
  reason:
    | "disconnected"
    | "cancelled"
    | "rate_limited"
    | "resource_limit" = "disconnected"
): void {
  if (connections.get(conn.url) === conn) connections.delete(conn.url)
  if (conn.closed) return
  conn.closed = true
  if (conn.idleTimer) clearTimeout(conn.idleTimer)
  const pending = [...conn.subs.values()]
  conn.subs.clear()
  for (const sub of pending) sub.end(reason)
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
  connections: Map<string, RelayConnection>,
  socketScope?: PublicRelayReadSocketScope,
  signal?: AbortSignal
): RelayConnection {
  if (config.e2eRelayIsolationEnabled) {
    const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
    const normalized = tryNormalizeRelayUrl(url)
    if (
      !isolatedRelayUrl ||
      !normalized.ok ||
      normalized.url !== isolatedRelayUrl
    ) {
      throw new Error("Expected the configured E2E loopback relay target.")
    }
  }

  const existing = connections.get(url)
  if (existing && !existing.closed) return existing

  const conn: RelayConnection = {
    url,
    ws: undefined as unknown as PublicRelayReadSocket,
    ready: undefined as unknown as Promise<void>,
    isOpen: false,
    closed: false,
    subs: new Map(),
    inboundFrames: 0,
    inboundChars: 0,
  }

  conn.ready = new Promise<void>((resolve, reject) => {
    let ws: PublicRelayReadSocket
    try {
      ws = socketScope
        ? socketScope.createWebSocket(url)
        : (new WebSocket(url) as unknown as PublicRelayReadSocket)
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
        dropRelayConnection(conn, connections, "resource_limit")
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
        dropRelayConnection(conn, connections, "resource_limit")
        return
      }
      for (const handler of conn.subs.values())
        handler.frame(message.data.length)
      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        for (const handler of conn.subs.values()) handler.malformed()
        return
      }
      if (!Array.isArray(parsed)) {
        for (const handler of conn.subs.values()) handler.malformed()
        return
      }
      const [type, sub] = parsed as [string, string, ...unknown[]]
      if (typeof sub !== "string") {
        for (const handler of conn.subs.values()) handler.malformed()
        return
      }
      // NOTICE is connection-wide, not keyed by a subscription id. Congee uses
      // a space-separated prefix; other relays use the NIP-01 machine prefix.
      if (type === "NOTICE" && /^(rate-limited|rate limited):/i.test(sub)) {
        recordRelayRateLimit(conn.url)
        dropRelayConnection(conn, connections, "rate_limited")
        return
      }
      const handler = conn.subs.get(sub)
      if (!handler) return
      if (type === "EVENT") {
        handler.onEvent(parsed[2] as RawNostrEvent, message.data.length)
      } else if (type === "EOSE") {
        handler.end("eose")
      } else if (type === "CLOSED") {
        if (
          typeof parsed[2] === "string" &&
          /^(rate-limited|rate limited):/i.test(parsed[2])
        ) {
          recordRelayRateLimit(conn.url)
          handler.end("rate_limited")
        } else if (
          typeof parsed[2] === "string" &&
          parsed[2].startsWith("auth-required:")
        )
          handler.end("auth_required")
        else if (
          typeof parsed[2] === "string" &&
          parsed[2].startsWith("restricted:")
        )
          handler.end("rejected")
        else handler.end("closed")
      }
    }
  })
  conn.ready.catch(() => {
    // Rejection is handled per-read; swallow here to avoid unhandled rejection.
  })

  // An injected factory can retire the operation before returning its socket.
  // Fence registration so that socket cannot escape the retired pool.
  if (signal?.aborted) {
    dropRelayConnection(conn, connections, "cancelled")
    throw abortError()
  }
  connections.set(url, conn)
  return conn
}

function closeRelayConnections(
  connections: Map<string, RelayConnection>
): void {
  for (const conn of [...connections.values()]) {
    // Close subscriptions while the socket is still writable, then retire it.
    // Deliberate teardown is cancellation, never a relay-health failure.
    for (const sub of [...conn.subs.values()]) sub.end("cancelled")
    dropRelayConnection(conn, connections, "cancelled")
  }
  connections.clear()
}

function closeAllRelayConnections(): void {
  relaySettingsRefreshPending = false
  for (const [controller, operation] of [...publicReadOperations]) {
    controller.abort()
    closeRelayConnections(operation.connections)
  }
  closeRelayConnections(relayConnections)
  for (const connections of scopedPublicConnections.values())
    closeRelayConnections(connections)
  scopedPublicConnections.clear()
}

function refreshRelayConnectionsWhenIdle(): void {
  if (
    publicReadOperations.size > 0 ||
    activeRelayReads > 0 ||
    relayReadWaiters.length > 0
  ) {
    relaySettingsRefreshPending = true
    return
  }
  closeAllRelayConnections()
}

function flushPendingRelaySettingsRefresh(): void {
  if (
    relaySettingsRefreshPending &&
    publicReadOperations.size === 0 &&
    activeRelayReads === 0 &&
    relayReadWaiters.length === 0
  )
    closeAllRelayConnections()
}

function readRelayEvents(
  relayUrl: string,
  filter: Filter | Filter[],
  connectTimeoutMs: number,
  fetchTimeoutMs: number,
  connections: Map<string, RelayConnection>,
  signal?: AbortSignal,
  socketScope?: PublicRelayReadSocketScope,
  onConnection?: (relayUrl: string) => void,
  bounds: Pick<
    PublicRelayReadOptions,
    | "maxFramesPerRelay"
    | "maxEventsPerRelay"
    | "maxBytesPerRelay"
    | "shouldContinue"
  > = {}
): Promise<{
  events: RawNostrEvent[]
  complete: boolean
  truncated: boolean
  failureReason?: "rate_limited"
  outcome: PublicRelayReadOutcome
  malformedEventCount: number
  unusableEventCount: number
}> {
  try {
    throwIfAborted(signal)
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise((resolve, reject) => {
    const conn = getRelayConnection(relayUrl, connections, socketScope, signal)
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
    let malformedEventCount = 0
    let unusableEventCount = 0
    let rawFrameCount = 0
    let inboundFrames = 0
    let inboundChars = 0
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
      if (!conn.closed && conn.ws.readyState === WEBSOCKET_OPEN) {
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

    const finish = (
      complete: boolean,
      truncated = false,
      failureReason?: "rate_limited",
      outcome: PublicRelayReadOutcome = complete
        ? "eose"
        : truncated
          ? "resource_limit"
          : "disconnected"
    ) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        events,
        complete,
        truncated,
        failureReason,
        outcome,
        malformedEventCount,
        unusableEventCount,
      })
    }
    const cancel = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError())
    }

    conn.subs.set(subId, {
      frame: (chars) => {
        inboundFrames += 1
        inboundChars += chars
        if (
          inboundFrames >
            Math.min(
              bounds.maxFramesPerRelay ?? MAX_RELAY_CONNECTION_FRAMES,
              MAX_RELAY_CONNECTION_FRAMES
            ) ||
          inboundChars >
            Math.min(
              bounds.maxBytesPerRelay ?? MAX_RELAY_SUBSCRIPTION_CHARS,
              MAX_RELAY_SUBSCRIPTION_CHARS
            )
        )
          finish(false, true)
      },
      malformed: () => {
        malformedEventCount += 1
      },
      onEvent: (raw, frameChars) => {
        if (settled) return
        if (
          rawFrameCount >=
          (bounds.maxEventsPerRelay ?? MAX_RAW_RELAY_EVENT_FRAMES)
        ) {
          finish(false, true)
          return
        }
        rawFrameCount += 1
        rawFrameChars += frameChars
        if (rawFrameChars > MAX_RELAY_SUBSCRIPTION_CHARS) {
          finish(false, true)
          return
        }
        try {
          if (
            validateEvent(raw) &&
            raw.kind !== 1_059 &&
            (Array.isArray(filter)
              ? filter.some((item) => matchFilter(item, raw))
              : matchFilter(filter, raw)) &&
            (eventLimit === null || events.length < rawFrameLimit)
          ) {
            events.push(raw)
          } else if (!validateEvent(raw)) {
            malformedEventCount += 1
          } else {
            unusableEventCount += 1
          }
        } catch {
          malformedEventCount += 1
        }

        // A separate raw-frame guard bounds invalid, non-matching, and
        // unverified floods. Saturating it is truncation, never a complete
        // EOSE read.
        if (rawFrameCount >= rawFrameLimit) {
          finish(false, true)
        }
      },
      end: (reason) =>
        reason === "cancelled"
          ? cancel()
          : finish(
              reason === "eose",
              false,
              reason === "rate_limited" ? "rate_limited" : undefined,
              reason
            ),
    })

    if (signal) {
      onAbort = cancel
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }

    connectTimer = setTimeout(
      () => finish(false, false, undefined, "connect_timeout"),
      connectTimeoutMs
    )

    conn.ready.then(
      () => {
        try {
          if (connectTimer) {
            clearTimeout(connectTimer)
            connectTimer = undefined
          }
          if (settled) return
          if (conn.closed || conn.ws.readyState !== WEBSOCKET_OPEN) {
            finish(false)
            return
          }
          if (isRelayRateLimited(relayUrl)) {
            finish(false, false, "rate_limited")
            return
          }
          if (bounds.shouldContinue?.() === false) {
            cancel()
            return
          }
          onConnection?.(relayUrl)
          // Observers can cancel or retire the connection reentrantly. Fence
          // final I/O again before creating a timer or sending the subscription.
          if (
            settled ||
            signal?.aborted ||
            bounds.shouldContinue?.() === false
          ) {
            cancel()
            return
          }
          if (conn.closed || conn.ws.readyState !== WEBSOCKET_OPEN) {
            finish(false)
            return
          }
          fetchTimer = setTimeout(
            () => finish(false, false, undefined, "timeout"),
            fetchTimeoutMs
          )
          try {
            conn.ws.send(
              JSON.stringify([
                "REQ",
                subId,
                ...(Array.isArray(filter) ? filter : [filter]),
              ])
            )
          } catch {
            finish(false)
          }
        } catch (error) {
          if (settled) return
          settled = true
          cleanup()
          reject(new RelayReadCallbackError(error))
        }
      },
      () => finish(false)
    )
  })
}

interface FetchEventsFromRelayResult {
  outcome?: PublicRelayReadOutcome
  malformedEventCount?: number
  unusableEventCount?: number
  duplicateEventCount?: number
  eoseReceived?: boolean
  relayUrl: string
  events: VerifiedNostrEvent[]
  status: PublicRelayReadSourceStatus["status"]
  rejectedEventCount: number
  failureReason?: "rate_limited"
  /** No relay I/O occurred; retain the diagnostic without consuming a slot. */
  requestSuppressed?: true
}

async function fetchEventsFromRelay(
  relayUrl: string,
  filter: Filter | Filter[],
  connectTimeoutMs: number,
  fetchTimeoutMs: number,
  connections: Map<string, RelayConnection>,
  options: {
    onAdmission?: (url: string) => void
    onAttempt?: (url: string) => void
  } & Pick<
    PublicRelayReadOptions,
    | "accountPubkey"
    | "authenticatedPubkey"
    | "ownerSelectedRelayUrls"
    | "appRelayUrls"
    | "personalRelayUrls"
    | "independentRelayUrls"
    | "accountNetworkLocalStateRepository"
    | "shouldContinue"
    | "signal"
    | "preserveEventOrder"
    | "socketScope"
    | "onConnection"
    | "maxFramesPerRelay"
    | "maxEventsPerRelay"
    | "maxBytesPerRelay"
  >,
  rateLimitedAtPlan = false
): Promise<FetchEventsFromRelayResult | null> {
  let acquiredRelayReadSlot = false
  let admittedRelayUrl: string | null = null
  try {
    await acquireRelayReadSlot(options.signal)
    acquiredRelayReadSlot = true
    throwIfAborted(options.signal)
    if (options.accountPubkey === undefined || options.accountPubkey === null) {
      admittedRelayUrl =
        normalizeSecureOrIsolatedE2eRelayUrls([relayUrl])[0] ?? null
    } else {
      const eligibleRelayUrls = await awaitReadPolicy(
        filterEligibleAccountRelayUrls({
          accountPubkey: options.accountPubkey,
          authenticatedPubkey: options.authenticatedPubkey,
          candidateRelayUrls: [relayUrl],
          ownerSelectedRelayUrls: options.ownerSelectedRelayUrls,
          appRelayUrls: options.appRelayUrls,
          personalRelayUrls: options.personalRelayUrls,
          independentRelayUrls: options.independentRelayUrls,
          repository: options.accountNetworkLocalStateRepository,
        }),
        options.signal
      )
      admittedRelayUrl = eligibleRelayUrls[0] ?? null
    }
    // Eligibility is re-read only after this attempt owns an execution slot.
    // Once admitted, an in-flight socket may finish even if another tab commits
    // a removal; every later queued attempt observes the new durable state.
    if (!admittedRelayUrl) return null
    throwIfAborted(options.signal)
    if (options.shouldContinue?.() === false) {
      throw new NostrSignerError("authority_changed")
    }
    // Recheck after the execution queue and account policy await. Even an
    // explicit relay plan must respect throttling observed by a sibling read.
    if (rateLimitedAtPlan || isRelayRateLimited(admittedRelayUrl)) {
      return {
        relayUrl: admittedRelayUrl,
        events: [],
        status: "failed",
        rejectedEventCount: 0,
        failureReason: "rate_limited",
        outcome: "rate_limited",
        requestSuppressed: true,
      }
    }
    options.onAdmission?.(admittedRelayUrl)
    options.onAttempt?.(admittedRelayUrl)
    const {
      events,
      complete,
      truncated,
      failureReason,
      outcome,
      malformedEventCount,
      unusableEventCount,
    } = await readRelayEvents(
      admittedRelayUrl,
      filter,
      connectTimeoutMs,
      fetchTimeoutMs,
      connections,
      options.signal,
      options.socketScope,
      options.onConnection,
      options
    )
    throwIfAborted(options.signal)
    const orderedEvents = options.preserveEventOrder
      ? events
      : [...events].sort((left, right) => {
          if (left.created_at !== right.created_at) {
            return right.created_at - left.created_at
          }
          return left.id.localeCompare(right.id)
        })
    const uniqueCandidates: RawNostrEvent[] = []
    const byClaim = new Map<string, number[]>()
    const indexes = orderedEvents.map((raw) => {
      const key = `${raw.id}:${raw.sig}`
      const existing = byClaim.get(key) ?? []
      const match = existing.find((index) =>
        sameSignedPublicEvent(uniqueCandidates[index], raw)
      )
      if (match !== undefined) return match
      const index = uniqueCandidates.length
      uniqueCandidates.push(raw)
      byClaim.set(key, [...existing, index])
      return index
    })
    let verificationUnavailable = false
    const admission = await verifySignedEvents(uniqueCandidates, {
      signal: options.signal,
      maxEvents: MAX_SIGNATURES_PER_RELAY_READ,
    }).catch((error: unknown) => {
      if (!(error instanceof PublicEventVerificationUnavailableError))
        throw error
      verificationUnavailable = true
      return {
        events: error.events,
        truncated: uniqueCandidates.length > MAX_SIGNATURES_PER_RELAY_READ,
      }
    })
    throwIfAborted(options.signal)
    const admittedByClaim = new Map(
      admission.events.map((event) => [`${event.id}:${event.sig}`, event])
    )
    const verifiedEvents = indexes.flatMap((index) => {
      const raw = uniqueCandidates[index]
      const event = admittedByClaim.get(`${raw.id}:${raw.sig}`)
      return event && sameSignedPublicEvent(event, raw) ? [event] : []
    })
    const verificationTruncated = admission.truncated

    // A filter's limit belongs to that filter, not to a global bag. Select
    // the union of its ordered distinct matches; copies stay in observations.
    const selections = (Array.isArray(filter) ? filter : [filter]).map(
      (item) => ({
        filter: item,
        limit: requestedEventLimit(item),
        ids: new Set<string>(),
      })
    )
    const verified: VerifiedNostrEvent[] = []
    const uniqueIds = new Set<string>()
    let duplicateEventCount = 0
    for (const raw of verifiedEvents) {
      if (uniqueIds.has(raw.id)) {
        duplicateEventCount += 1
        continue
      }
      let selected = false
      for (const selection of selections) {
        if (selection.limit !== null && selection.ids.size >= selection.limit)
          continue
        if (
          !matchFilter(selection.filter, {
            ...raw,
            tags: raw.tags.map((tag) => [...tag]),
          })
        )
          continue
        selection.ids.add(raw.id)
        selected = true
      }
      if (!selected) continue
      const event = raw
      uniqueIds.add(event.id)
      attachEventSourceRelayUrl(event, admittedRelayUrl)
      verified.push(event)
    }
    const rejectedEventCount = verificationUnavailable
      ? 0
      : orderedEvents.length - verifiedEvents.length

    const status: PublicRelayReadSourceStatus["status"] =
      verificationUnavailable && verified.length === 0
        ? "failed"
        : verificationUnavailable ||
            truncated ||
            verificationTruncated ||
            rejectedEventCount > 0 ||
            malformedEventCount > 0 ||
            unusableEventCount > 0
          ? "partial"
          : complete
            ? "success"
            : verified.length > 0
              ? "partial"
              : "failed"

    if (status === "success") recordRelaySuccess(admittedRelayUrl)
    else if (!failureReason) recordRelayFailure(admittedRelayUrl)

    return {
      relayUrl: admittedRelayUrl,
      events: verified,
      status,
      rejectedEventCount,
      malformedEventCount,
      unusableEventCount,
      duplicateEventCount,
      eoseReceived: complete,
      outcome: verificationUnavailable
        ? "unavailable"
        : verificationTruncated
          ? "resource_limit"
          : rejectedEventCount > 0
            ? "verification_failed"
            : malformedEventCount > 0
              ? "malformed"
              : outcome,
      ...(failureReason ? { failureReason } : {}),
    }
  } catch (error) {
    if (error instanceof RelayReadCallbackError) throw error.reason
    if (options.signal?.aborted || isAbortError(error)) throw error
    if (
      error instanceof NostrSignerError &&
      error.code === "authority_changed"
    ) {
      throw error
    }
    // Queue-capacity and other pre-admission executor failures remain visible
    // as failed relay results, matching the public fanout contract. A policy
    // suppression returns above and is omitted because no attempt occurred.
    const failedRelayUrl = admittedRelayUrl ?? relayUrl
    if (acquiredRelayReadSlot) recordRelayFailure(failedRelayUrl)
    return {
      relayUrl: failedRelayUrl,
      events: [],
      status: "failed",
      rejectedEventCount: 0,
    }
  } finally {
    if (acquiredRelayReadSlot) releaseRelayReadSlot()
  }
}

async function runBoundedRelayAttempts(
  relayUrls: readonly string[],
  maxRelayAttempts: number | undefined,
  attempt: (relayUrl: string) => Promise<FetchEventsFromRelayResult | null>,
  retire: (reason: unknown) => void
): Promise<FetchEventsFromRelayResult[]> {
  let failure: { reason: unknown } | undefined
  const runAttempt = async (relayUrl: string) => {
    try {
      return await attempt(relayUrl)
    } catch (reason) {
      if (!failure) {
        failure = { reason }
        // Stop sibling sockets and queued work immediately, but keep awaiting
        // every started attempt, including its cooperative progress callback.
        retire(reason)
      }
      return null
    }
  }
  let results: FetchEventsFromRelayResult[]
  if (
    maxRelayAttempts === undefined ||
    !Number.isSafeInteger(maxRelayAttempts) ||
    maxRelayAttempts <= 0
  ) {
    results = (await Promise.all(relayUrls.map(runAttempt))).filter(
      (result): result is FetchEventsFromRelayResult => result !== null
    )
  } else {
    let nextIndex = 0
    const workerCount = Math.min(maxRelayAttempts, relayUrls.length)
    const workers = await Promise.all(
      Array.from({ length: workerCount }, async () => {
        const observations: FetchEventsFromRelayResult[] = []
        while (!failure && nextIndex < relayUrls.length) {
          const relayUrl = relayUrls[nextIndex]
          nextIndex += 1
          const result = await runAttempt(relayUrl)
          // Only an actual attempt consumes this worker's bounded slot. Keep
          // throttle diagnostics while backfilling from later eligible sources.
          if (result === null) continue
          observations.push(result)
          if (!result.requestSuppressed) break
        }
        return observations
      })
    )
    results = workers.flat()
  }
  // Preserve the first failure rather than the aborts it caused in siblings.
  if (failure) throw failure.reason
  return results
}

function resolveFanoutRelayUrls(options: PublicRelayReadOptions): string[] {
  if (options.relayUrls?.length === 0) return []

  if (config.e2eRelayIsolationEnabled) {
    const isolatedRelayUrl = getConfiguredIsolatedE2eRelayUrl()
    return isolatedRelayUrl ? [isolatedRelayUrl] : []
  }

  const dedupedUrls = (
    options.relayUrls ??
    getGeneralReadRelayUrls({ fallbackRelayUrls: config.defaultRelays })
  )
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url, index, all) => all.indexOf(url) === index)

  if (options.skipHealthFilter) return dedupedUrls

  const { healthy, parked } = partitionByHealth(dedupedUrls)
  if (healthy.length > 0) {
    const healthySet = new Set(healthy)
    // Preserve known suppression in coverage while transport preflight keeps
    // these sources quiet and backfills their slots from healthy peers.
    return dedupedUrls.filter(
      (url) => healthySet.has(url) || isRelayRateLimited(url)
    )
  }
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
  const fallback = new Set(
    cappedFallback.length > 0 ? cappedFallback : dedupedUrls.slice(0, 4)
  )
  return dedupedUrls.filter(
    (url) => fallback.has(url) || isRelayRateLimited(url)
  )
}

async function orderAccountRelayFanout(
  relayUrls: readonly string[],
  options: Pick<
    PublicRelayReadOptions,
    "accountPubkey" | "accountNetworkLocalStateRepository"
  >
): Promise<string[]> {
  if (options.accountPubkey === undefined || options.accountPubkey === null) {
    return [...relayUrls]
  }
  const ordered = await orderEquivalentAccountRelayOperations({
    accountPubkey: options.accountPubkey,
    operations: relayUrls.map((relayUrl) => ({
      relayUrl,
      equivalenceKey: "final-read-fanout",
      value: relayUrl,
    })),
    repository: options.accountNetworkLocalStateRepository,
  })
  return ordered.map((operation) => operation.value)
}

async function resolveFanoutRelayPlan(options: PublicRelayReadOptions) {
  const ordered = await orderAccountRelayFanout(
    resolveFanoutRelayUrls(options),
    options
  )
  const rateLimitedRelayUrls = new Set(
    ordered.filter((url) => isRelayRateLimited(url))
  )
  return {
    // Record known suppression before healthy reads consume the bounded
    // attempt budget. Each candidate still passes live account admission.
    relayUrls: [
      ...rateLimitedRelayUrls,
      ...ordered.filter((url) => !rateLimitedRelayUrls.has(url)),
    ],
    rateLimitedRelayUrls,
  }
}

function mergeEventsInto(
  merged: Map<string, VerifiedNostrEvent>,
  events: VerifiedNostrEvent[]
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

export async function fetchPublicEvents(
  filter: Filter,
  options: PublicRelayReadOptions = {}
): Promise<VerifiedNostrEvent[]> {
  return (await fetchSignedEventsFanoutDetailed(filter, options)).events
}

export class PublicRelayReadCancelledError extends Error {
  readonly result: PublicRelayReadResult
  constructor(result: PublicRelayReadResult) {
    super("The operation was aborted.")
    this.name = "AbortError"
    this.result = result
  }
}

export async function fetchSignedEventsFanoutDetailed(
  filter: Filter | Filter[],
  options: PublicRelayReadOptions = {}
): Promise<SignedEventRelayReadResult> {
  if (
    (Array.isArray(filter) ? filter : [filter]).some((item) =>
      item.kinds?.includes(1_059)
    )
  ) {
    throw new Error("Public reads cannot request protected inbox events.")
  }
  const startedAt = Date.now()
  // Capture the pool before planning yields, so teardown cannot be followed by
  // an obsolete operation registering a replacement pool for the same scope.
  let sharedConnections = relayConnections
  if (options.socketScope) {
    sharedConnections =
      scopedPublicConnections.get(options.socketScope) ?? new Map()
    scopedPublicConnections.set(options.socketScope, sharedConnections)
  }
  const connections =
    options.reuseRelayConnections === false
      ? new Map<string, RelayConnection>()
      : sharedConnections
  let relayUrls: string[] = []
  const merged = new Map<string, VerifiedNostrEvent>()
  const results: FetchEventsFromRelayResult[] = []
  const attempted = new Set<string>()
  const admitted = new Set<string>()
  const snapshot = (
    phase: "progressive" | "terminal",
    cancelled = false
  ): SignedEventRelayReadResult => {
    const events = Array.from(merged.values())
    const relays = results.map((result) => ({
      relayUrl: result.relayUrl,
      status: result.status,
      eventCount: result.events.length,
      rejectedEventCount: result.rejectedEventCount,
      malformedEventCount: result.malformedEventCount ?? 0,
      unusableEventCount: result.unusableEventCount ?? 0,
      duplicateEventCount: result.duplicateEventCount ?? 0,
      eoseReceived: result.eoseReceived === true,
      outcome: result.outcome ?? "unavailable",
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
    }))
    if (cancelled)
      for (const relayUrl of admitted) {
        if (!relays.some((relay) => relay.relayUrl === relayUrl))
          relays.push({
            relayUrl,
            status: "failed",
            eventCount: 0,
            rejectedEventCount: 0,
            malformedEventCount: 0,
            unusableEventCount: 0,
            duplicateEventCount: 0,
            eoseReceived: false,
            outcome: "cancelled",
          })
      }
    const coverage = cancelled
      ? "cancelled"
      : phase === "terminal" &&
          admitted.size > 0 &&
          relays.length === admitted.size &&
          relays.every((relay) => relay.status === "success")
        ? "complete"
        : relays.some((relay) => relay.status !== "failed")
          ? "partial"
          : "unavailable"
    return {
      events,
      eventSourceRelayUrls: Object.fromEntries(
        events.map((event) => [event.id, getEventSourceRelayUrls(event)])
      ),
      relays,
      requestedRelayUrls: [...(options.relayUrls ?? relayUrls)],
      admittedRelayUrls: [...admitted],
      attemptedRelayUrls: [...attempted],
      readCoverage: coverage,
      phase,
      startedAt,
      observedAt: Date.now(),
      freshness: "current",
      globalAbsence: false,
    }
  }
  const callerSignal = options.signal
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (callerSignal?.aborted) controller.abort()
  else callerSignal?.addEventListener("abort", abort, { once: true })
  const closePrivateConnections = () => {
    if (connections !== sharedConnections) closeRelayConnections(connections)
  }
  controller.signal.addEventListener("abort", closePrivateConnections, {
    once: true,
  })
  publicReadOperations.set(controller, {
    scope: options.socketScope,
    connections,
  })
  let cancellationAtFailure: boolean | undefined
  options = { ...options, signal: controller.signal }
  try {
    if (options.shouldContinue?.() === false)
      throw new NostrSignerError("authority_changed")
    const plan = await awaitReadPolicy(
      resolveFanoutRelayPlan(options),
      options.signal
    )
    relayUrls = plan.relayUrls
    throwIfAborted(options.signal)
    const settled = await runBoundedRelayAttempts(
      relayUrls,
      options.maxRelayAttempts,
      async (relayUrl) => {
        const result = await fetchEventsFromRelay(
          relayUrl,
          filter,
          options.connectTimeoutMs ?? 4_000,
          options.fetchTimeoutMs ?? 8_000,
          connections,
          {
            ...options,
            onAdmission: (url) => admitted.add(url),
            onAttempt: (url) => attempted.add(url),
          },
          plan.rateLimitedRelayUrls.has(relayUrl)
        )
        if (!result) return null
        results.push(result)
        mergeEventsInto(merged, result.events)
        throwIfAborted(options.signal)
        if (options.shouldContinue?.() === false) throw abortError()
        const progress = snapshot("progressive")
        options.onProgress?.(progress)
        throwIfAborted(options.signal)
        if (options.shouldContinue?.() === false) throw abortError()
        await options.onRelayProgress?.({
          relayUrl: result.relayUrl,
          events: result.events,
          mergedEvents: progress.events,
          status: result.status,
          result: progress,
        })
        throwIfAborted(options.signal)
        if (options.shouldContinue?.() === false) throw abortError()
        return result
      },
      (reason) => {
        cancellationAtFailure =
          isAbortError(reason) || controller.signal.aborted
        controller.abort()
      }
    )
    throwIfAborted(options.signal)
    if (options.shouldContinue?.() === false) throw abortError()
    results.splice(0, results.length, ...settled)
    return snapshot("terminal")
  } catch (error) {
    if (
      isAbortError(error) ||
      (cancellationAtFailure ?? options.signal?.aborted)
    )
      throw new PublicRelayReadCancelledError(snapshot("terminal", true))
    throw error
  } finally {
    controller.abort()
    if (connections !== sharedConnections) closeRelayConnections(connections)
    callerSignal?.removeEventListener("abort", abort)
    publicReadOperations.delete(controller)
    flushPendingRelaySettingsRefresh()
  }
}

export async function fetchPublicEventsWithDiagnostics(
  filter: Filter,
  options: PublicRelayReadOptions = {}
): Promise<PublicRelayReadDiagnosticsResult> {
  const result = await fetchSignedEventsFanoutDetailed(filter, options)
  const limit = requestedEventLimit(filter)

  return {
    ...result,
    events: result.events,
    attemptedRelayUrls: [...(result.attemptedRelayUrls ?? [])],
    successfulRelayUrls: result.relays
      .filter(({ status }) => status !== "failed")
      .map(({ relayUrl }) => relayUrl),
    failedRelayUrls: result.relays
      .filter(({ status }) => status !== "success")
      .map(({ relayUrl }) => relayUrl),
    cappedRelayUrls:
      limit === null
        ? []
        : result.relays
            .filter(
              ({ status, eventCount }) =>
                status !== "failed" && eventCount >= limit
            )
            .map(({ relayUrl }) => relayUrl),
  }
}

export async function fetchPublicEventsProgressive(
  filter: Filter,
  options: PublicRelayReadOptions = {},
  onProgress: (progress: PublicRelayReadProgress) => void | Promise<void>
): Promise<VerifiedNostrEvent[]> {
  return (
    await fetchSignedEventsFanoutDetailed(filter, {
      ...options,
      onRelayProgress: onProgress,
    })
  ).events
}

export function closePublicRelayConnections(
  scope?: PublicRelayReadSocketScope
): void {
  if (scope) {
    for (const [controller, operation] of [...publicReadOperations]) {
      if (operation.scope !== scope) continue
      controller.abort()
      closeRelayConnections(operation.connections)
    }
    const connections = scopedPublicConnections.get(scope)
    if (connections) closeRelayConnections(connections)
    scopedPublicConnections.delete(scope)
    return
  }
  closeAllRelayConnections()
}

export function refreshPublicRelayConnectionsWhenIdle(): void {
  refreshRelayConnectionsWhenIdle()
}

export type RelayReadOptions = PublicRelayReadOptions & { relayUrls: string[] }
export type RelayReadSourceStatus = PublicRelayReadSourceStatus
export interface SignedEventRelayReadResult extends PublicRelayReadResult {
  eventSourceRelayUrls: Record<string, string[]>
}
export type VerifySignedEventsOptions = VerifySignedPublicNostrEventsOptions

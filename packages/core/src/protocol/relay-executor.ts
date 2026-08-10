import { isValidSignedPublicNostrEvent } from "./signed-event"
import {
  assertProtectedReadAuthorization,
  getProtectedReadAuthenticationSuppression,
  getProtectedReadAuthorization,
  hasProtectedReadAuthority,
  suppressProtectedReadAuthentication,
  subscribeProtectedReadSignerRevocation,
  type ProtectedReadAuthorization,
} from "./protected-read-authorization"
import {
  NostrSignerError,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "./nostr-event-signer"
import { normalizeRelayUrl } from "./relay-settings"

export interface PlainNostrFilter {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
  search?: string
  [tag: `#${string}`]: string[] | undefined
}

export interface RelayRequest {
  relayUrls: string[]
  filters: PlainNostrFilter[]
  operation: "public_read" | "private_inbox_read"
}

export type RelayQuery = RelayRequest

export interface RelayExecutionOptions {
  signal?: AbortSignal
  authorization?: ProtectedReadAuthorization
  connectTimeoutMs?: number
  queryTimeoutMs?: number
  authTimeoutMs?: number
  maxAuthAttempts?: number
  maxFramesPerRelay?: number
  maxEventsPerRelay?: number
  maxBytesPerRelay?: number
}

export type RelayAuthEvidenceState =
  "untested" | "challenge_observed" | "succeeded" | "rejected" | "unavailable"

export type RelayAuthOutcome =
  | "not_challenged"
  | "challenge_observed"
  | "authentication_pending"
  | "succeeded"
  | "authentication_required"
  | "authentication_rejected"
  | "authentication_timed_out"
  | "signer_unavailable"
  | "signer_authorization_denied"
  | "authority_changed"
  | "subscription_rejected"
  | "challenge_invalid"
  | "challenge_replayed"

export type RelayFailureCode =
  | "transport_unavailable"
  | "authentication_required"
  | "missing_challenge"
  | "authentication_rejected"
  | "authentication_timed_out"
  | "signer_unavailable"
  | "signer_authorization_denied"
  | "authority_changed"
  | "subscription_rejected"
  | "challenge_invalid"
  | "challenge_replayed"
  | "challenge_loop"
  | "challenge_superseded"
  | "protocol_invalid"
  | "protocol_limit_exceeded"
  | "query_timed_out"
  | "aborted"

export type RelayObservation =
  | {
      type: "connection"
      relayIndex: number
      state: "connected" | "failed" | "closed"
    }
  | { type: "auth"; relayIndex: number; state: RelayAuthOutcome }
  | { type: "ok"; relayIndex: number; accepted: boolean }
  | { type: "event"; relayIndex: number }
  | { type: "eose"; relayIndex: number }
  | {
      type: "closed"
      relayIndex: number
      code: "auth_required" | "restricted" | "other"
    }
  | { type: "notice"; relayIndex: number }
  | { type: "timeout"; relayIndex: number; phase: "connect" | "auth" | "query" }
  | { type: "abort"; relayIndex: number }
  | { type: "duplicate"; relayIndex: number }
  | { type: "malformed"; relayIndex: number }
  | { type: "unusable"; relayIndex: number }

export interface RelaySourceResult {
  relayIndex: number
  status: "success" | "partial" | "failed" | "aborted"
  auth: RelayAuthOutcome
  eventCount: number
  duplicateCount: number
  malformedCount: number
  unusableCount: number
  failure?: RelayFailureCode
}

export interface RelayQueryResult {
  status: "success" | "partial" | "unavailable" | "aborted"
  events: SignedNostrEvent[]
  observations: RelayObservation[]
  relays: RelaySourceResult[]
  attemptedCount: number
  completedCount: number
  failedCount: number
  authoritativeEmpty: boolean
}

export interface CommerceRelayExecutor {
  req(
    request: RelayRequest,
    options?: RelayExecutionOptions
  ): AsyncIterable<RelayObservation>
  query(
    request: RelayQuery,
    options?: RelayExecutionOptions
  ): Promise<RelayQueryResult>
}

export interface RelayWebSocket {
  readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent | Event) => void) | null
  send(payload: string): void
  close(code?: number, reason?: string): void
}

type RelayWebSocketFactory = (url: string) => RelayWebSocket

export interface WebSocketRelayExecutorOptions {
  createWebSocket?: RelayWebSocketFactory
  now?: () => number
  createSubscriptionId?: () => string
}

type RelayFrame =
  | {
      type: "auth"
      challenge: string
      disposition: "new" | "duplicate" | "invalid" | "replayed"
    }
  | { type: "ok"; eventId: string; accepted: boolean }
  | { type: "event"; subscriptionId: string; event: unknown }
  | { type: "eose"; subscriptionId: string }
  | {
      type: "closed"
      subscriptionId: string
      reasonCode: "auth_required" | "restricted" | "other"
    }
  | { type: "notice" }
  | { type: "malformed" }
  | { type: "transport_closed" }
  | { type: "transport_error" }

type FrameListener = (frame: RelayFrame, wireBytes: number) => void

const DEFAULT_MAX_FRAMES_PER_RELAY = 4_096
const DEFAULT_MAX_EVENTS_PER_RELAY = 1_000
const DEFAULT_MAX_BYTES_PER_RELAY = 32 * 1024 * 1024
const MAX_INBOUND_FRAME_CHARACTERS = 2 * 1024 * 1024
const MAX_USED_CHALLENGES = 32

class RelayConnectError extends Error {
  readonly code: "failed" | "timeout"

  constructor(code: "failed" | "timeout") {
    super(`Relay connection ${code}`)
    this.name = "RelayConnectError"
    this.code = code
  }
}

class RelayAbortedError extends Error {
  constructor() {
    super("Relay operation aborted")
    this.name = "RelayAbortedError"
  }
}

class RelayAuthError extends Error {
  readonly code: RelayFailureCode

  constructor(code: RelayFailureCode) {
    super(`Relay authentication failed: ${code}`)
    this.name = "RelayAuthError"
    this.code = code
  }
}

class AsyncObservationQueue implements AsyncIterable<RelayObservation> {
  private readonly values: RelayObservation[] = []
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<RelayObservation>) => void
    reject: (error: unknown) => void
  }> = []
  private done = false
  private error: unknown = null

  push(value: RelayObservation): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.values.push(value)
  }

  close(): void {
    if (this.done) return
    this.done = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: unknown): void {
    if (this.done) return
    this.done = true
    this.error = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<RelayObservation> {
    return {
      next: async () => {
        const value = this.values.shift()
        if (value) return { value, done: false }
        if (this.error) throw this.error
        if (this.done) return { value: undefined, done: true }
        return await new Promise<IteratorResult<RelayObservation>>(
          (resolve, reject) => this.waiters.push({ resolve, reject })
        )
      },
    }
  }
}

function cloneRequest(request: RelayRequest): RelayRequest {
  return {
    operation: request.operation,
    relayUrls: [...request.relayUrls],
    filters: request.filters.map((filter) => {
      const clone: PlainNostrFilter = {}
      for (const [key, value] of Object.entries(filter)) {
        ;(clone as Record<string, unknown>)[key] = Array.isArray(value)
          ? [...value]
          : value
      }
      return clone
    }),
  }
}

function requestedEventLimit(request: RelayRequest): number {
  const requested = request.filters.reduce(
    (total, filter) => total + (filter.limit ?? DEFAULT_MAX_EVENTS_PER_RELAY),
    0
  )
  return Math.max(1, Math.min(requested, DEFAULT_MAX_EVENTS_PER_RELAY))
}

async function waitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return await promise
  if (signal.aborted) throw new RelayAbortedError()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new RelayAbortedError())
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

const signerQueues = new Map<string, Promise<void>>()

async function serializeSignerOperation<T>(
  sessionScope: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = signerQueues.get(sessionScope) ?? Promise.resolve()
  let release!: () => void
  const slot = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => undefined).then(() => slot)
  signerQueues.set(sessionScope, queued)
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (signerQueues.get(sessionScope) === queued) {
      signerQueues.delete(sessionScope)
    }
  }
}

function isValidChallenge(challenge: string): boolean {
  return (
    challenge.length > 0 &&
    challenge.length <= 4_096 &&
    !challenge.includes("\0")
  )
}

function closeReasonCode(
  reason: unknown
): "auth_required" | "restricted" | "other" {
  if (typeof reason !== "string") return "other"
  const normalized = reason.trim().toLowerCase()
  if (normalized.startsWith("auth-required:")) return "auth_required"
  if (normalized.startsWith("restricted:")) return "restricted"
  return "other"
}

function parseRelayFrame(payload: unknown): RelayFrame {
  if (typeof payload !== "string") return { type: "malformed" }
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return { type: "malformed" }
  }
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    return { type: "malformed" }
  }
  switch (value[0]) {
    case "AUTH":
      return typeof value[1] === "string"
        ? { type: "auth", challenge: value[1], disposition: "new" }
        : { type: "malformed" }
    case "OK":
      return typeof value[1] === "string" && typeof value[2] === "boolean"
        ? { type: "ok", eventId: value[1], accepted: value[2] }
        : { type: "malformed" }
    case "EVENT":
      return typeof value[1] === "string"
        ? { type: "event", subscriptionId: value[1], event: value[2] }
        : { type: "malformed" }
    case "EOSE":
      return typeof value[1] === "string"
        ? { type: "eose", subscriptionId: value[1] }
        : { type: "malformed" }
    case "CLOSED":
      return typeof value[1] === "string"
        ? {
            type: "closed",
            subscriptionId: value[1],
            reasonCode: closeReasonCode(value[2]),
          }
        : { type: "malformed" }
    case "NOTICE":
      return { type: "notice" }
    default:
      return { type: "malformed" }
  }
}

function asSignedEvent(value: unknown): SignedNostrEvent | null {
  if (!value || typeof value !== "object") return null
  const event = value as SignedNostrEvent
  if (!isValidSignedPublicNostrEvent(event)) return null
  return {
    ...event,
    tags: event.tags.map((tag) => [...tag]),
  }
}

function eventMatchesFilter(
  event: SignedNostrEvent,
  filter: PlainNostrFilter
): boolean {
  if (filter.ids && !filter.ids.some((id) => event.id.startsWith(id)))
    return false
  if (
    filter.authors &&
    !filter.authors.some((author) => event.pubkey.startsWith(author))
  )
    return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.since !== undefined && event.created_at < filter.since)
    return false
  if (filter.until !== undefined && event.created_at > filter.until)
    return false
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue
    const tagName = key.slice(1)
    if (
      !event.tags.some(
        (tag) => tag[0] === tagName && values.includes(tag[1] ?? "")
      )
    ) {
      return false
    }
  }
  return true
}

function eventMatchesRequest(
  event: SignedNostrEvent,
  request: RelayRequest
): boolean {
  return request.filters.some((filter) => eventMatchesFilter(event, filter))
}

function assertRequest(
  request: RelayRequest,
  authorization?: ProtectedReadAuthorization
): void {
  if (request.relayUrls.length === 0 || request.filters.length === 0) {
    throw new Error("Relay request requires relays and filters")
  }
  if (request.operation === "public_read") {
    if (authorization)
      throw new Error("Public reads cannot carry signer authorization")
    if (
      request.filters.some(
        (filter) =>
          !Array.isArray(filter.kinds) ||
          filter.kinds.length === 0 ||
          filter.kinds.includes(1_059)
      )
    ) {
      throw new Error(
        "Public reads require an explicit kind allowlist without protected inbox events"
      )
    }
    return
  }
  if (!authorization || authorization.operation !== "private_inbox_read") {
    throw new Error("Private inbox read requires active authorization")
  }
  assertProtectedReadAuthorization(authorization, authorization.expectedPubkey)
  const allowedPrivateFilterKeys = new Set([
    "kinds",
    "#p",
    "limit",
    "since",
    "until",
  ])
  for (const filter of request.filters) {
    const keys = Object.keys(filter)
    const limit = filter.limit
    const since = filter.since
    const until = filter.until
    if (
      keys.some((key) => !allowedPrivateFilterKeys.has(key)) ||
      filter.kinds?.length !== 1 ||
      filter.kinds[0] !== 1_059 ||
      filter["#p"]?.length !== 1 ||
      filter["#p"]?.[0]?.trim().toLowerCase() !==
        authorization.expectedPubkey ||
      (limit !== undefined &&
        (!Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > DEFAULT_MAX_EVENTS_PER_RELAY)) ||
      (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) ||
      (until !== undefined && (!Number.isSafeInteger(until) || until < 0)) ||
      (since !== undefined && until !== undefined && since > until)
    ) {
      throw new Error("Private inbox filter is not recipient-scoped kind 1059")
    }
  }
}

function exactAuthEvent(
  signed: SignedNostrEvent,
  draft: UnsignedNostrEvent,
  relayUrl: string,
  challenge: string
): boolean {
  return (
    isValidSignedPublicNostrEvent(signed) &&
    signed.kind === 22_242 &&
    signed.pubkey === draft.pubkey &&
    signed.created_at === draft.created_at &&
    signed.content === "" &&
    JSON.stringify(signed.tags) ===
      JSON.stringify([
        ["relay", relayUrl],
        ["challenge", challenge],
      ])
  )
}

type PendingAuth = {
  eventId: string
  resolve: () => void
  reject: (error: RelayAuthError) => void
}

class RelayConnection {
  readonly url: string
  private readonly socket: RelayWebSocket
  private readonly onClosed: () => void
  private readonly listeners = new Set<FrameListener>()
  private readonly usedChallenges = new Set<string>()
  private readonly authConsumers = new Set<symbol>()
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise: Promise<void>
  private pendingAuth: PendingAuth | null = null
  private authPromise: Promise<void> | null = null
  private authPromiseChallenge: string | null = null
  private cancelAuthAttempt: ((error: RelayAuthError) => void) | null = null
  private authenticatedChallenge: string | null = null
  private challenge: string | null = null
  private invalidChallenge = false
  private closed = false
  private closeNotified = false

  constructor(
    url: string,
    createWebSocket: RelayWebSocketFactory,
    onClosed: () => void
  ) {
    this.url = url
    this.onClosed = onClosed
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.socket = createWebSocket(url)
    this.socket.onopen = () => this.readyResolve()
    this.socket.onerror = () => {
      this.emit({ type: "transport_error" })
      this.readyReject(new RelayConnectError("failed"))
    }
    this.socket.onclose = () => {
      this.markClosed()
      this.readyReject(new RelayConnectError("failed"))
    }
    this.socket.onmessage = (event) => this.receive(event.data)
  }

  async ready(timeoutMs: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new RelayConnectError("timeout")),
            timeoutMs
          )
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  get currentChallenge(): string | null {
    return this.challenge
  }

  get isClosed(): boolean {
    return this.closed || this.socket.readyState >= 2
  }

  get isAuthenticatedForCurrentChallenge(): boolean {
    return (
      this.challenge !== null && this.authenticatedChallenge === this.challenge
    )
  }

  get hasInvalidChallenge(): boolean {
    return this.invalidChallenge
  }

  listen(listener: FrameListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  sendRequest(subscriptionId: string, filters: PlainNostrFilter[]): void {
    this.send(["REQ", subscriptionId, ...filters])
  }

  closeSubscription(subscriptionId: string): void {
    if (this.isClosed) return
    try {
      this.send(["CLOSE", subscriptionId])
    } catch {
      // Subscription cleanup is best-effort after a terminal result.
    }
  }

  close(): void {
    if (this.closed) return
    this.markClosed()
    this.listeners.clear()
    try {
      this.socket.close(1000, "connection disposed")
    } catch {
      // The connection is already locally revoked and removed from its pool.
    }
  }

  async authenticate(
    authorization: ProtectedReadAuthorization,
    now: () => number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    assertProtectedReadAuthorization(
      authorization,
      authorization.expectedPubkey
    )
    const challenge = this.challenge
    if (!challenge) throw new RelayAuthError("missing_challenge")
    if (this.invalidChallenge) throw new RelayAuthError("challenge_invalid")
    if (this.authenticatedChallenge === challenge) return
    if (this.usedChallenges.has(challenge)) {
      throw new RelayAuthError("challenge_replayed")
    }
    if (this.usedChallenges.size >= MAX_USED_CHALLENGES) {
      throw new RelayAuthError("challenge_loop")
    }
    if (this.authPromise) {
      if (this.authPromiseChallenge !== challenge) {
        throw new RelayAuthError("challenge_superseded")
      }
    } else {
      let cancellation: RelayAuthError | null = null
      let resolveCancellation!: (error: RelayAuthError) => void
      const cancellationPromise = new Promise<RelayAuthError>((resolve) => {
        resolveCancellation = resolve
      })
      let timeout: ReturnType<typeof setTimeout> | undefined
      const throwIfCancelled = () => {
        if (cancellation) throw cancellation
      }
      this.cancelAuthAttempt = (error) => {
        if (cancellation) {
          // Abort/supersession keeps the signer slot serialized, but the
          // original auth deadline must still be able to detach a signer that
          // never settles and establish the normal timeout suppression gate.
          if (error.code === "authentication_timed_out") {
            resolveCancellation(error)
          }
          return
        }
        cancellation = error
        if (error.code === "authentication_timed_out") {
          // A timeout suppresses additional background prompts until an
          // explicit retry. Other cancellations must keep holding the signer
          // queue until the external signer settles, or a second query could
          // open a concurrent wallet prompt.
          resolveCancellation(error)
        }
        this.pendingAuth?.reject(error)
        this.pendingAuth = null
      }
      const attempt = serializeSignerOperation(
        authorization.sessionScope,
        async () => {
          throwIfCancelled()
          const suppressed =
            getProtectedReadAuthenticationSuppression(authorization)
          if (suppressed) {
            suppressProtectedReadAuthentication(
              authorization,
              this.url,
              suppressed
            )
            throw new RelayAuthError(suppressed)
          }
          assertProtectedReadAuthorization(
            authorization,
            authorization.expectedPubkey
          )
          const signerPubkey = (await authorization.signer.getPublicKey())
            .trim()
            .toLowerCase()
          if (signerPubkey !== authorization.expectedPubkey) {
            throw new RelayAuthError("authority_changed")
          }
          throwIfCancelled()
          const suppressionAfterIdentity =
            getProtectedReadAuthenticationSuppression(authorization)
          if (suppressionAfterIdentity) {
            suppressProtectedReadAuthentication(
              authorization,
              this.url,
              suppressionAfterIdentity
            )
            throw new RelayAuthError(suppressionAfterIdentity)
          }
          const draft: UnsignedNostrEvent = {
            kind: 22_242,
            pubkey: authorization.expectedPubkey,
            created_at: Math.floor(now() / 1_000),
            tags: [
              ["relay", this.url],
              ["challenge", challenge],
            ],
            content: "",
          }
          let signed: SignedNostrEvent
          try {
            const signerResult = await Promise.race([
              authorization.signer.signEvent(draft).then((event) => ({
                status: "signed" as const,
                event,
              })),
              cancellationPromise.then((error) => ({
                status: "cancelled" as const,
                error,
              })),
            ])
            if (signerResult.status === "cancelled") {
              throw signerResult.error
            }
            signed = signerResult.event
          } catch (error) {
            if (error instanceof RelayAuthError) throw error
            if (error instanceof NostrSignerError) {
              switch (error.code) {
                case "authorization_denied":
                  suppressProtectedReadAuthentication(
                    authorization,
                    this.url,
                    "signer_authorization_denied"
                  )
                  throw new RelayAuthError("signer_authorization_denied")
                case "timeout":
                  suppressProtectedReadAuthentication(
                    authorization,
                    this.url,
                    "authentication_timed_out"
                  )
                  throw new RelayAuthError("authentication_timed_out")
                case "authority_changed":
                  throw new RelayAuthError("authority_changed")
                case "invalid_response":
                case "unavailable":
                  throw new RelayAuthError("signer_unavailable")
              }
            }
            throw new RelayAuthError("signer_unavailable")
          }
          throwIfCancelled()
          if (this.challenge !== challenge) {
            throw new RelayAuthError("challenge_superseded")
          }
          assertProtectedReadAuthorization(
            authorization,
            authorization.expectedPubkey
          )
          if (!exactAuthEvent(signed, draft, this.url, challenge)) {
            throw new RelayAuthError("signer_unavailable")
          }
          await new Promise<void>((resolve, reject) => {
            this.pendingAuth = {
              eventId: signed.id,
              resolve,
              reject,
            }
            try {
              this.send(["AUTH", signed])
              // Once an auth event has left this client, the connection must
              // never sign the same challenge again, even if the caller
              // aborts or a newer challenge supersedes the pending OK.
              this.usedChallenges.add(challenge)
            } catch {
              this.pendingAuth = null
              reject(new RelayAuthError("transport_unavailable"))
            }
          })
          throwIfCancelled()
          assertProtectedReadAuthorization(
            authorization,
            authorization.expectedPubkey
          )
          this.authenticatedChallenge = challenge
        }
      )
      this.authPromiseChallenge = challenge
      this.authPromise = Promise.race([
        attempt,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new RelayAuthError("authentication_timed_out")
            suppressProtectedReadAuthentication(
              authorization,
              this.url,
              "authentication_timed_out"
            )
            this.cancelAuthAttempt?.(error)
            reject(error)
          }, timeoutMs)
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
        this.authPromise = null
        this.authPromiseChallenge = null
        this.cancelAuthAttempt = null
      })
    }

    const consumer = Symbol("relay-auth-consumer")
    this.authConsumers.add(consumer)
    try {
      await waitWithAbort(this.authPromise, signal)
    } finally {
      this.authConsumers.delete(consumer)
      if (signal?.aborted && this.authConsumers.size === 0) {
        this.cancelAuthAttempt?.(new RelayAuthError("aborted"))
      }
    }
  }

  private receive(payload: unknown): void {
    if (
      typeof payload !== "string" ||
      payload.length > MAX_INBOUND_FRAME_CHARACTERS
    ) {
      this.emit(
        { type: "malformed" },
        typeof payload === "string" ? payload.length : 0
      )
      this.close()
      return
    }
    const parsed = parseRelayFrame(payload)
    const wireBytes = typeof payload === "string" ? payload.length : 0
    if (parsed.type === "auth") {
      if (!isValidChallenge(parsed.challenge)) {
        this.invalidChallenge = true
        this.challenge = null
        this.emit({ ...parsed, disposition: "invalid" }, wireBytes)
        return
      }
      if (parsed.challenge === this.challenge) {
        this.emit({ ...parsed, disposition: "duplicate" }, wireBytes)
        return
      }
      if (this.usedChallenges.has(parsed.challenge)) {
        this.emit({ ...parsed, disposition: "replayed" }, wireBytes)
        return
      }
      if (
        this.authPromiseChallenge &&
        this.authPromiseChallenge !== parsed.challenge
      ) {
        this.cancelAuthAttempt?.(new RelayAuthError("challenge_superseded"))
      }
      this.invalidChallenge = false
      this.challenge = parsed.challenge
      this.authenticatedChallenge = null
      this.emit(parsed, wireBytes)
      return
    }
    if (parsed.type === "ok" && this.pendingAuth) {
      if (parsed.eventId === this.pendingAuth.eventId) {
        const pending = this.pendingAuth
        this.pendingAuth = null
        if (parsed.accepted) pending.resolve()
        else pending.reject(new RelayAuthError("authentication_rejected"))
      }
    }
    this.emit(parsed, wireBytes)
  }

  private emit(frame: RelayFrame, wireBytes = 0): void {
    for (const listener of this.listeners) listener(frame, wireBytes)
  }

  private send(frame: unknown[]): void {
    if (this.isClosed) throw new Error("Relay connection is closed")
    this.socket.send(JSON.stringify(frame))
  }

  private markClosed(): void {
    if (!this.closed) {
      this.closed = true
      const error = new RelayAuthError("transport_unavailable")
      this.cancelAuthAttempt?.(error)
      this.pendingAuth?.reject(error)
      this.pendingAuth = null
      this.emit({ type: "transport_closed" })
    }
    if (!this.closeNotified) {
      this.closeNotified = true
      this.onClosed()
    }
  }
}

function authOutcomeForFailure(code: RelayFailureCode): RelayAuthOutcome {
  switch (code) {
    case "authentication_required":
    case "missing_challenge":
      return "authentication_required"
    case "authentication_rejected":
      return "authentication_rejected"
    case "authentication_timed_out":
      return "authentication_timed_out"
    case "signer_authorization_denied":
      return "signer_authorization_denied"
    case "signer_unavailable":
      return "signer_unavailable"
    case "authority_changed":
      return "authority_changed"
    case "subscription_rejected":
      return "subscription_rejected"
    case "challenge_invalid":
      return "challenge_invalid"
    case "challenge_replayed":
    case "challenge_loop":
    case "challenge_superseded":
      return "challenge_replayed"
    default:
      return "not_challenged"
  }
}

function evidenceForOutcome(outcome: RelayAuthOutcome): RelayAuthEvidenceState {
  switch (outcome) {
    case "challenge_observed":
    case "authentication_pending":
      return "challenge_observed"
    case "succeeded":
      return "succeeded"
    case "authentication_rejected":
      return "rejected"
    case "not_challenged":
      return "untested"
    default:
      return "unavailable"
  }
}

function uniqueNormalizedRelayUrls(relayUrls: readonly string[]): string[] {
  return Array.from(new Set(relayUrls.map((url) => normalizeRelayUrl(url))))
}

export class WebSocketCommerceRelayExecutor implements CommerceRelayExecutor {
  private readonly createWebSocket: RelayWebSocketFactory
  private readonly now: () => number
  private readonly createSubscriptionId: () => string
  private readonly publicConnections = new Map<string, RelayConnection>()
  private readonly authenticatedConnections = new Map<
    string,
    Map<string, RelayConnection>
  >()
  private readonly evidence = new Map<
    string,
    Map<string, RelayAuthEvidenceState>
  >()
  private readonly evidenceListeners = new Set<() => void>()
  private readonly connectionWaiters = new Map<RelayConnection, number>()
  private readonly unsubscribeRevocation: () => void
  private subscriptionSequence = 0

  constructor(options: WebSocketRelayExecutorOptions = {}) {
    this.createWebSocket =
      options.createWebSocket ??
      ((url) => new WebSocket(url) as unknown as RelayWebSocket)
    this.now = options.now ?? Date.now
    this.createSubscriptionId =
      options.createSubscriptionId ??
      (() => {
        this.subscriptionSequence += 1
        return `c-${this.subscriptionSequence.toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 10)}`
      })
    this.unsubscribeRevocation = subscribeProtectedReadSignerRevocation(
      (sessionScope) => this.closeSession(sessionScope)
    )
  }

  async *req(
    request: RelayRequest,
    options: RelayExecutionOptions = {}
  ): AsyncIterable<RelayObservation> {
    const queue = new AsyncObservationQueue()
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
    void this.execute(
      request,
      { ...options, signal: controller.signal },
      (observation) => queue.push(observation)
    ).then(
      () => queue.close(),
      (error: unknown) => queue.fail(error)
    )
    try {
      yield* queue
    } finally {
      controller.abort()
      options.signal?.removeEventListener("abort", abort)
    }
  }

  async query(
    request: RelayQuery,
    options: RelayExecutionOptions = {}
  ): Promise<RelayQueryResult> {
    const observations: RelayObservation[] = []
    return await this.execute(request, options, (observation) =>
      observations.push(observation)
    ).then((result) => ({ ...result, observations }))
  }

  closeAuthenticatedRelay(relayUrl: string): void {
    const normalized = normalizeRelayUrl(relayUrl)
    for (const connections of this.authenticatedConnections.values()) {
      connections.get(normalized)?.close()
      connections.delete(normalized)
    }
    for (const [scope, connections] of this.authenticatedConnections) {
      if (connections.size === 0) this.authenticatedConnections.delete(scope)
    }
    for (const [scope, byRelay] of this.evidence) {
      byRelay.delete(normalized)
      if (byRelay.size === 0) this.evidence.delete(scope)
    }
    this.notifyEvidence()
  }

  closeAllAuthenticated(): void {
    const scopes = new Set([
      ...this.authenticatedConnections.keys(),
      ...this.evidence.keys(),
      ...signerQueues.keys(),
    ])
    for (const scope of scopes) {
      this.closeSession(scope)
    }
  }

  closeAll(): void {
    this.closeAllAuthenticated()
    for (const connection of this.publicConnections.values()) connection.close()
    this.publicConnections.clear()
  }

  dispose(): void {
    this.closeAll()
    this.unsubscribeRevocation()
  }

  getAuthenticationEvidence(
    relayUrl: string,
    sessionScope: string
  ): RelayAuthEvidenceState | undefined {
    const normalized = normalizeRelayUrl(relayUrl)
    return this.evidence.get(sessionScope)?.get(normalized)
  }

  subscribeAuthenticationEvidence(listener: () => void): () => void {
    this.evidenceListeners.add(listener)
    return () => this.evidenceListeners.delete(listener)
  }

  private async execute(
    request: RelayRequest,
    options: RelayExecutionOptions,
    observe: (observation: RelayObservation) => void
  ): Promise<Omit<RelayQueryResult, "observations">> {
    const snapshot = cloneRequest(request)
    assertRequest(snapshot, options.authorization)
    const relayUrls = uniqueNormalizedRelayUrls(snapshot.relayUrls)
    const seenEventIds = new Set<string>()
    const events: SignedNostrEvent[] = []
    const protectedEventObservations: number[] = []
    const relayResults = await Promise.all(
      relayUrls.map((relayUrl, relayIndex) =>
        this.executeRelay(
          relayUrl,
          relayIndex,
          { ...snapshot, relayUrls },
          options,
          seenEventIds,
          events,
          protectedEventObservations,
          observe
        )
      )
    )
    const authorityLost =
      options.authorization !== undefined &&
      !hasProtectedReadAuthority(options.authorization)
    if (authorityLost) events.length = 0
    const relays = authorityLost
      ? relayResults.map((relay) => ({
          ...relay,
          status: "failed" as const,
          auth: "authority_changed" as const,
          eventCount: 0,
          failure: "authority_changed" as const,
        }))
      : relayResults
    if (authorityLost) {
      for (const relay of relays) {
        observe({
          type: "auth",
          relayIndex: relay.relayIndex,
          state: "authority_changed",
        })
      }
    } else {
      for (const relayIndex of protectedEventObservations) {
        observe({
          type: "event",
          relayIndex,
        })
      }
    }
    const completedCount = relays.filter(
      (relay) => relay.status === "success"
    ).length
    const failedCount = relays.filter(
      (relay) => relay.status !== "success"
    ).length
    const hasUsefulResult = relays.some(
      (relay) => relay.status === "success" || relay.status === "partial"
    )
    const allAborted = relays.every((relay) => relay.status === "aborted")
    const status: RelayQueryResult["status"] = allAborted
      ? "aborted"
      : completedCount === relays.length
        ? "success"
        : hasUsefulResult
          ? "partial"
          : "unavailable"
    return {
      status,
      events,
      relays,
      attemptedCount: relays.length,
      completedCount,
      failedCount,
      authoritativeEmpty: status === "success" && events.length === 0,
    }
  }

  private async executeRelay(
    relayUrl: string,
    relayIndex: number,
    request: RelayRequest,
    options: RelayExecutionOptions,
    seenEventIds: Set<string>,
    events: SignedNostrEvent[],
    protectedEventObservations: number[],
    observe: (observation: RelayObservation) => void
  ): Promise<RelaySourceResult> {
    const authorization = options.authorization
    const connectTimeoutMs = options.connectTimeoutMs ?? 4_000
    const queryTimeoutMs = options.queryTimeoutMs ?? 12_000
    const authTimeoutMs = options.authTimeoutMs ?? 15_000
    const maxAuthAttempts = options.maxAuthAttempts ?? 2
    const maxFramesPerRelay = Math.max(
      1,
      Math.min(
        options.maxFramesPerRelay ?? DEFAULT_MAX_FRAMES_PER_RELAY,
        DEFAULT_MAX_FRAMES_PER_RELAY
      )
    )
    const maxEventsPerRelay = Math.max(
      1,
      Math.min(
        options.maxEventsPerRelay ?? requestedEventLimit(request),
        requestedEventLimit(request)
      )
    )
    const maxBytesPerRelay = Math.max(
      1,
      Math.min(
        options.maxBytesPerRelay ?? DEFAULT_MAX_BYTES_PER_RELAY,
        DEFAULT_MAX_BYTES_PER_RELAY
      )
    )
    if (options.signal?.aborted) {
      observe({ type: "abort", relayIndex })
      return {
        relayIndex,
        status: "aborted",
        auth: "not_challenged",
        eventCount: 0,
        duplicateCount: 0,
        malformedCount: 0,
        unusableCount: 0,
        failure: "aborted",
      }
    }
    if (authorization) {
      const suppressed = getProtectedReadAuthenticationSuppression(
        authorization,
        relayUrl
      )
      if (suppressed) {
        const auth = authOutcomeForFailure(suppressed)
        this.recordEvidence(authorization.sessionScope, relayUrl, auth)
        observe({ type: "auth", relayIndex, state: auth })
        return {
          relayIndex,
          status: "failed",
          auth,
          eventCount: 0,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
          failure: suppressed,
        }
      }
    }
    let connection: RelayConnection
    try {
      connection = await this.getConnection(
        relayUrl,
        authorization,
        connectTimeoutMs,
        options.signal
      )
      observe({ type: "connection", relayIndex, state: "connected" })
    } catch (error) {
      if (error instanceof RelayAbortedError) {
        observe({ type: "abort", relayIndex })
        return {
          relayIndex,
          status: "aborted",
          auth: "not_challenged",
          eventCount: 0,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
          failure: "aborted",
        }
      }
      observe({ type: "connection", relayIndex, state: "failed" })
      if (error instanceof RelayConnectError && error.code === "timeout") {
        observe({ type: "timeout", relayIndex, phase: "connect" })
      }
      if (authorization) {
        this.setEvidence(authorization.sessionScope, relayUrl, "unavailable")
      }
      return {
        relayIndex,
        status: "failed",
        auth: "not_challenged",
        eventCount: 0,
        duplicateCount: 0,
        malformedCount: 0,
        unusableCount: 0,
        failure: "transport_unavailable",
      }
    }

    return await new Promise<RelaySourceResult>((resolve) => {
      let subscriptionId = ""
      let eventCount = 0
      let duplicateCount = 0
      let malformedCount = 0
      let unusableCount = 0
      let auth: RelayAuthOutcome = "not_challenged"
      let authAttempts = 0
      let authWork: Promise<void> | null = null
      let finished = false
      let queryTimer: ReturnType<typeof setTimeout> | undefined
      let frameCount = 0
      let eventFrameCount = 0
      let wireBytes = 0
      const protectedEvents = new Map<string, SignedNostrEvent>()

      const retireSubscription = (): void => {
        if (!subscriptionId) return
        connection.closeSubscription(subscriptionId)
        subscriptionId = ""
        protectedEvents.clear()
      }

      const commitProtectedEvents = (): boolean => {
        if (!authorization) return true
        if (!hasProtectedReadAuthority(authorization)) {
          auth = "authority_changed"
          return false
        }
        for (const event of protectedEvents.values()) {
          if (seenEventIds.has(event.id)) {
            duplicateCount += 1
            observe({ type: "duplicate", relayIndex })
            continue
          }
          seenEventIds.add(event.id)
          events.push(event)
          eventCount += 1
          protectedEventObservations.push(relayIndex)
        }
        protectedEvents.clear()
        return true
      }

      const finish = (failure?: RelayFailureCode, aborted = false): void => {
        if (finished) return
        finished = true
        if (queryTimer) clearTimeout(queryTimer)
        unsubscribe()
        options.signal?.removeEventListener("abort", onAbort)
        if (subscriptionId) connection.closeSubscription(subscriptionId)
        protectedEvents.clear()
        const status: RelaySourceResult["status"] = aborted
          ? "aborted"
          : failure
            ? eventCount > 0
              ? "partial"
              : "failed"
            : "success"
        resolve({
          relayIndex,
          status,
          auth,
          eventCount,
          duplicateCount,
          malformedCount,
          unusableCount,
          failure,
        })
        if (
          failure &&
          ([
            "transport_unavailable",
            "authentication_required",
            "missing_challenge",
            "authentication_rejected",
            "authentication_timed_out",
            "signer_unavailable",
            "signer_authorization_denied",
            "authority_changed",
            "challenge_invalid",
            "challenge_replayed",
            "challenge_loop",
            "subscription_rejected",
            "protocol_invalid",
            "protocol_limit_exceeded",
          ].includes(failure) ||
            (failure === "query_timed_out" && authorization))
        ) {
          this.discardConnection(relayUrl, authorization)
        }
      }

      const issueRequest = (): void => {
        if (finished) return
        if (authorization) {
          try {
            assertProtectedReadAuthorization(
              authorization,
              authorization.expectedPubkey
            )
          } catch {
            auth = "authority_changed"
            finish("authority_changed")
            return
          }
        }
        const previous = subscriptionId
        subscriptionId = this.createSubscriptionId().slice(0, 64)
        protectedEvents.clear()
        if (previous) connection.closeSubscription(previous)
        try {
          connection.sendRequest(subscriptionId, request.filters)
        } catch {
          subscriptionId = ""
          finish("transport_unavailable")
          return
        }
        startQueryTimer()
      }

      const startQueryTimer = (): void => {
        if (queryTimer) clearTimeout(queryTimer)
        queryTimer = setTimeout(() => {
          observe({ type: "timeout", relayIndex, phase: "query" })
          finish("query_timed_out")
        }, queryTimeoutMs)
      }

      const authenticateAndRetry = (): void => {
        if (finished || authWork) return
        if (!authorization) {
          auth = "authentication_required"
          finish("authentication_required")
          return
        }
        if (!connection.currentChallenge) {
          auth = "authentication_required"
          this.recordEvidence(authorization.sessionScope, relayUrl, auth)
          observe({ type: "auth", relayIndex, state: auth })
          finish("missing_challenge")
          return
        }
        const suppressed =
          getProtectedReadAuthenticationSuppression(authorization)
        if (suppressed) {
          suppressProtectedReadAuthentication(
            authorization,
            relayUrl,
            suppressed
          )
          auth = authOutcomeForFailure(suppressed)
          this.recordEvidence(authorization.sessionScope, relayUrl, auth)
          observe({ type: "auth", relayIndex, state: auth })
          finish(suppressed)
          return
        }
        if (authAttempts >= maxAuthAttempts) {
          auth = "challenge_replayed"
          finish("challenge_loop")
          return
        }
        authAttempts += 1
        if (queryTimer) {
          clearTimeout(queryTimer)
          queryTimer = undefined
        }
        auth = "challenge_observed"
        this.recordEvidence(authorization.sessionScope, relayUrl, auth)
        observe({ type: "auth", relayIndex, state: "challenge_observed" })
        retireSubscription()
        auth = "authentication_pending"
        observe({ type: "auth", relayIndex, state: auth })
        let retrySupersedingChallenge = false
        const work = connection
          .authenticate(authorization, this.now, authTimeoutMs, options.signal)
          .then(() => {
            if (finished) return
            if (!hasProtectedReadAuthority(authorization)) {
              throw new RelayAuthError("authority_changed")
            }
            auth = "succeeded"
            this.recordEvidence(authorization.sessionScope, relayUrl, auth)
            observe({ type: "auth", relayIndex, state: "succeeded" })
            issueRequest()
          })
          .catch((error: unknown) => {
            if (finished) return
            const failure =
              error instanceof RelayAuthError
                ? error.code
                : "signer_unavailable"
            if (failure === "challenge_superseded") {
              retrySupersedingChallenge = true
              return
            }
            if (
              failure === "signer_authorization_denied" ||
              failure === "authentication_timed_out"
            ) {
              suppressProtectedReadAuthentication(
                authorization,
                relayUrl,
                failure
              )
            }
            auth = authOutcomeForFailure(failure)
            this.recordEvidence(authorization.sessionScope, relayUrl, auth)
            if (failure === "authentication_timed_out") {
              observe({ type: "timeout", relayIndex, phase: "auth" })
            }
            observe({ type: "auth", relayIndex, state: auth })
            finish(failure)
          })
          .finally(() => {
            if (authWork === work) authWork = null
            if (retrySupersedingChallenge && !finished) {
              authenticateAndRetry()
            }
          })
        authWork = work
      }

      const onFrame: FrameListener = (frame, frameBytes) => {
        if (finished) return
        frameCount += 1
        wireBytes += frameBytes
        if (frameCount > maxFramesPerRelay || wireBytes > maxBytesPerRelay) {
          finish("protocol_limit_exceeded")
          return
        }
        if (
          (frame.type === "event" ||
            frame.type === "eose" ||
            frame.type === "closed") &&
          frame.subscriptionId !== subscriptionId
        ) {
          return
        }
        if (
          authorization &&
          (frame.type === "event" ||
            frame.type === "eose" ||
            frame.type === "closed") &&
          !hasProtectedReadAuthority(authorization)
        ) {
          auth = "authority_changed"
          finish("authority_changed")
          return
        }
        switch (frame.type) {
          case "auth":
            // NIP-42 challenges are connection-level. Public protocol reads
            // stay anonymous and may proceed when the relay permits them.
            if (!authorization) break
            if (frame.disposition === "invalid") {
              auth = "challenge_invalid"
              observe({ type: "malformed", relayIndex })
              finish("challenge_invalid")
            } else if (frame.disposition === "replayed") {
              auth = "challenge_replayed"
              observe({ type: "auth", relayIndex, state: auth })
              finish("challenge_replayed")
            } else if (
              frame.disposition === "new" ||
              !connection.isAuthenticatedForCurrentChallenge
            ) {
              authenticateAndRetry()
            }
            break
          case "ok":
            observe({ type: "ok", relayIndex, accepted: frame.accepted })
            break
          case "event": {
            eventFrameCount += 1
            if (eventFrameCount > maxEventsPerRelay) {
              finish("protocol_limit_exceeded")
              break
            }
            const event = asSignedEvent(frame.event)
            if (!event) {
              malformedCount += 1
              observe({ type: "malformed", relayIndex })
              break
            }
            if (request.operation === "public_read" && event.kind === 1_059) {
              unusableCount += 1
              observe({ type: "unusable", relayIndex })
              break
            }
            if (!eventMatchesRequest(event, request)) {
              unusableCount += 1
              observe({ type: "unusable", relayIndex })
              break
            }
            if (authorization && !hasProtectedReadAuthority(authorization)) {
              auth = "authority_changed"
              finish("authority_changed")
              break
            }
            if (authorization) {
              if (protectedEvents.has(event.id) || seenEventIds.has(event.id)) {
                duplicateCount += 1
                observe({ type: "duplicate", relayIndex })
              } else {
                protectedEvents.set(event.id, event)
              }
              break
            }
            if (seenEventIds.has(event.id)) {
              duplicateCount += 1
              observe({ type: "duplicate", relayIndex })
              break
            }
            seenEventIds.add(event.id)
            events.push(event)
            eventCount += 1
            observe({ type: "event", relayIndex })
            break
          }
          case "eose":
            if (
              auth === "challenge_observed" ||
              auth === "authentication_pending"
            ) {
              // The challenged subscription was closed and cannot prove an
              // authorized empty result. Wait for AUTH and the retried REQ.
              break
            }
            observe({ type: "eose", relayIndex })
            if (authorization?.policy === "required" && auth !== "succeeded") {
              auth = "authentication_required"
              this.recordEvidence(authorization.sessionScope, relayUrl, auth)
              observe({ type: "auth", relayIndex, state: auth })
              finish("authentication_required")
            } else if (!commitProtectedEvents()) {
              finish("authority_changed")
            } else if (malformedCount > 0 || unusableCount > 0) {
              finish("protocol_invalid")
            } else {
              finish()
            }
            break
          case "closed":
            observe({
              type: "closed",
              relayIndex,
              code: frame.reasonCode,
            })
            if (frame.reasonCode === "auth_required") {
              if (connection.currentChallenge) authenticateAndRetry()
              else {
                auth = "authentication_required"
                if (authorization) {
                  this.recordEvidence(
                    authorization.sessionScope,
                    relayUrl,
                    auth
                  )
                  observe({ type: "auth", relayIndex, state: auth })
                }
                finish("missing_challenge")
              }
            } else if (frame.reasonCode === "restricted") {
              finish("subscription_rejected")
            } else {
              finish("transport_unavailable")
            }
            break
          case "notice":
            observe({ type: "notice", relayIndex })
            break
          case "malformed":
            malformedCount += 1
            observe({ type: "malformed", relayIndex })
            break
          case "transport_closed":
          case "transport_error":
            observe({ type: "connection", relayIndex, state: "closed" })
            finish("transport_unavailable")
            break
        }
      }

      const onAbort = (): void => {
        observe({ type: "abort", relayIndex })
        finish("aborted", true)
      }
      const unsubscribe = connection.listen(onFrame)
      options.signal?.addEventListener("abort", onAbort, { once: true })

      if (options.signal?.aborted) {
        onAbort()
      } else if (authorization && connection.hasInvalidChallenge) {
        auth = "challenge_invalid"
        observe({ type: "malformed", relayIndex })
        finish("challenge_invalid")
      } else if (authorization && connection.currentChallenge) {
        authenticateAndRetry()
      } else {
        issueRequest()
      }
    })
  }

  private async getConnection(
    relayUrl: string,
    authorization: ProtectedReadAuthorization | undefined,
    connectTimeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<RelayConnection> {
    const connections = authorization
      ? this.getAuthenticatedConnections(authorization.sessionScope)
      : this.publicConnections
    let connection = connections.get(relayUrl)
    if (connection?.isClosed) {
      connections.delete(relayUrl)
      connection = undefined
    }
    if (!connection) {
      const sessionScope = authorization?.sessionScope
      let created: RelayConnection | null = null
      created = new RelayConnection(relayUrl, this.createWebSocket, () =>
        created
          ? this.handleConnectionClosed(relayUrl, sessionScope, created)
          : undefined
      )
      connection = created
      connections.set(relayUrl, connection)
      if (authorization) {
        this.setEvidence(authorization.sessionScope, relayUrl, "untested")
      }
    }
    this.connectionWaiters.set(
      connection,
      (this.connectionWaiters.get(connection) ?? 0) + 1
    )
    let waiterReleased = false
    const releaseWaiter = (): number => {
      if (waiterReleased) return this.connectionWaiters.get(connection) ?? 0
      waiterReleased = true
      const remaining = (this.connectionWaiters.get(connection) ?? 1) - 1
      if (remaining <= 0) this.connectionWaiters.delete(connection)
      else this.connectionWaiters.set(connection, remaining)
      return Math.max(0, remaining)
    }
    try {
      await waitWithAbort(connection.ready(connectTimeoutMs), signal)
      if (connection.isClosed) throw new RelayConnectError("failed")
      return connection
    } catch (error) {
      const remainingWaiters = releaseWaiter()
      if (remainingWaiters === 0 || connection.isClosed) {
        if (connections.get(relayUrl) === connection) {
          connections.delete(relayUrl)
        }
        connection.close()
      }
      throw error
    } finally {
      releaseWaiter()
    }
  }

  private getAuthenticatedConnections(
    sessionScope: string
  ): Map<string, RelayConnection> {
    let connections = this.authenticatedConnections.get(sessionScope)
    if (!connections) {
      connections = new Map()
      this.authenticatedConnections.set(sessionScope, connections)
    }
    return connections
  }

  private handleConnectionClosed(
    relayUrl: string,
    sessionScope: string | undefined,
    connection: RelayConnection
  ): void {
    if (!sessionScope) {
      if (this.publicConnections.get(relayUrl) === connection) {
        this.publicConnections.delete(relayUrl)
      }
      return
    }
    const connections = this.authenticatedConnections.get(sessionScope)
    if (connections?.get(relayUrl) === connection) {
      connections.delete(relayUrl)
      if (connections.size === 0) {
        this.authenticatedConnections.delete(sessionScope)
      }
    }
    const byRelay = this.evidence.get(sessionScope)
    const state = byRelay?.get(relayUrl)
    if (state !== "rejected" && state !== "unavailable") {
      byRelay?.delete(relayUrl)
      if (byRelay?.size === 0) this.evidence.delete(sessionScope)
      this.notifyEvidence()
    }
  }

  private discardConnection(
    relayUrl: string,
    authorization: ProtectedReadAuthorization | undefined
  ): void {
    if (!authorization) {
      this.publicConnections.get(relayUrl)?.close()
      this.publicConnections.delete(relayUrl)
      return
    }
    const connections = this.authenticatedConnections.get(
      authorization.sessionScope
    )
    connections?.get(relayUrl)?.close()
    connections?.delete(relayUrl)
    if (connections?.size === 0) {
      this.authenticatedConnections.delete(authorization.sessionScope)
    }
  }

  private closeSession(sessionScope: string): void {
    const connections = this.authenticatedConnections.get(sessionScope)
    for (const connection of [...(connections?.values() ?? [])]) {
      connection.close()
    }
    this.authenticatedConnections.delete(sessionScope)
    this.evidence.delete(sessionScope)
    signerQueues.delete(sessionScope)
    this.notifyEvidence()
  }

  private recordEvidence(
    sessionScope: string,
    relayUrl: string,
    outcome: RelayAuthOutcome
  ): void {
    this.setEvidence(sessionScope, relayUrl, evidenceForOutcome(outcome))
  }

  private setEvidence(
    sessionScope: string,
    relayUrl: string,
    state: RelayAuthEvidenceState
  ): void {
    let byRelay = this.evidence.get(sessionScope)
    if (!byRelay) {
      byRelay = new Map()
      this.evidence.set(sessionScope, byRelay)
    }
    byRelay.set(relayUrl, state)
    this.notifyEvidence()
  }

  private notifyEvidence(): void {
    for (const listener of this.evidenceListeners) listener()
  }
}

export const commerceRelayExecutor = new WebSocketCommerceRelayExecutor()

export function closeProtectedRelayConnectionsForRelay(relayUrl: string): void {
  commerceRelayExecutor.closeAuthenticatedRelay(relayUrl)
}

export function closeAllProtectedRelayConnections(): void {
  commerceRelayExecutor.closeAllAuthenticated()
}

export function getRelayAuthenticationEvidence(
  relayUrl: string,
  expectedPubkey?: string | null
): RelayAuthEvidenceState | undefined {
  if (!expectedPubkey) return undefined
  const authorization = getProtectedReadAuthorization(expectedPubkey)
  if (!authorization) return undefined
  return commerceRelayExecutor.getAuthenticationEvidence(
    relayUrl,
    authorization.sessionScope
  )
}

export function subscribeRelayAuthenticationEvidence(
  listener: () => void
): () => void {
  return commerceRelayExecutor.subscribeAuthenticationEvidence(listener)
}

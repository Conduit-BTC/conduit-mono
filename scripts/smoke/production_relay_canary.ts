import {
  giftWrap,
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools"
import { writeFile } from "node:fs/promises"

import { createInMemoryInboxDeclarationEvidenceRepository } from "@conduit/core/protocol/inbox-declaration-evidence"
import {
  __resetInboxRelayCache,
  buildDirectMessageRumor,
  parseDirectMessageRumor,
  publishPrivateMessage,
  publishPrivateMessageRelayDeclaration,
  unwrapGiftWrap,
} from "@conduit/core/protocol/messaging"
import { disconnectNdk } from "@conduit/core/protocol/ndk"
import type { NostrEventSigner } from "@conduit/core/protocol/nostr-event-signer"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import { readProtectedInbox } from "@conduit/core/protocol/protected-inbox-read"
import { WebSocketCommerceRelayExecutor } from "@conduit/core/protocol/relay-executor"
import {
  publishSignedEventToRelay,
  publishWithPlanner,
} from "@conduit/core/protocol/relay-publish"
import { resolveInboxDeclaration } from "@conduit/core/protocol/private-message-routing"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

export const PRODUCTION_RELAY_HTTP_URL = "https://relay.conduit.market/"
export const PRODUCTION_RELAY_WS_URL = "wss://relay.conduit.market"

const CONNECT_TIMEOUT_MS = 8_000
const QUERY_TIMEOUT_MS = 10_000
const AUTH_TIMEOUT_MS = 8_000
const NIP11_MAX_BYTES = 256 * 1024
const MAX_RELAY_FRAMES = 128
const MAX_RELAY_FRAME_BYTES = 512 * 1024
const CANARY_EXPIRATION_SECONDS = 60 * 60
const READ_AFTER_WRITE_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 3_000]

export const PRODUCTION_RELAY_CANARY_STAGE_ORDER = [
  "nip11",
  "websocket",
  "signed_event",
  "basic_publish_ack",
  "basic_readback",
  "inbox_declaration_publish_ack",
  "inbox_declaration_discovery",
  "nip17_wrap_publish_ack",
  "recipient_auth_fetch",
  "unwrap_decrypt",
  "unauthenticated_denied",
  "unrelated_denied",
  "recipient_refetch",
  "cleanup",
] as const

export type ProductionRelayCanaryStage =
  (typeof PRODUCTION_RELAY_CANARY_STAGE_ORDER)[number]

export type ProductionRelayCanaryStageResult = {
  stage: ProductionRelayCanaryStage
  status: "passed" | "failed"
  latencyMs: number
  code?: string
}

export interface ProductionRelayCanaryOperations {
  nip11(): Promise<void>
  websocket(): Promise<void>
  signedEvent(): Promise<void>
  basicPublishAck(): Promise<void>
  basicReadback(): Promise<void>
  inboxDeclarationPublishAck(): Promise<void>
  inboxDeclarationDiscovery(): Promise<void>
  nip17WrapPublishAck(): Promise<void>
  recipientAuthFetch(): Promise<void>
  unwrapDecrypt(): Promise<void>
  unauthenticatedDenied(): Promise<void>
  unrelatedDenied(): Promise<void>
  recipientRefetch(): Promise<void>
  cleanup(): Promise<void>
  dispose(): void
}

export class ProductionRelayCanaryFailure extends Error {
  override name = "ProductionRelayCanaryFailure"

  constructor(
    readonly stage: ProductionRelayCanaryStage,
    readonly code: string,
    readonly results: readonly ProductionRelayCanaryStageResult[],
    options: { cause?: unknown } = {}
  ) {
    super(`Production relay canary failed at ${stage}.`, options)
  }
}

export class ProductionRelayCanaryCheckError extends Error {
  override name = "ProductionRelayCanaryCheckError"

  constructor(readonly code: string) {
    super("Production relay canary check failed.")
  }
}

const SAFE_CHECK_FAILURE_CODES = new Set([
  "unauthenticated_scoped_event_exposed",
  "unauthenticated_scoped_denial_not_explicit",
  "unauthenticated_scoped_denial_invalid",
  "unauthenticated_id_only_event_exposed",
  "unauthenticated_id_only_denial_not_explicit",
  "unauthenticated_id_only_denial_invalid",
  "unauthenticated_id_only_denial_rate_limited",
  "unauthenticated_id_only_denial_error",
  "unauthenticated_id_only_denial_other",
  "unrelated_bootstrap_event_exposed",
  "unrelated_auth_not_required",
  "unrelated_bootstrap_invalid",
  "unrelated_auth_rejected",
  "unrelated_control_event_missing",
  "unrelated_control_event_mismatch",
  "unrelated_control_denied",
  "unrelated_scoped_event_exposed",
  "unrelated_scoped_denial_not_explicit",
  "unrelated_scoped_denial_invalid",
  "unrelated_id_only_event_exposed",
  "unrelated_id_only_denial_not_explicit",
  "unrelated_id_only_denial_invalid",
  "unrelated_scoped_denial_auth_required",
  "unrelated_scoped_denial_rate_limited",
  "unrelated_scoped_denial_error",
  "unrelated_scoped_denial_other",
  "unrelated_id_only_denial_auth_required",
  "unrelated_id_only_denial_rate_limited",
  "unrelated_id_only_denial_error",
  "unrelated_id_only_denial_other",
])

type CanaryIdentity = {
  secretKey: Uint8Array
  pubkey: string
  signer: NDKPrivateKeySigner
}

type RelayFrame = unknown[]

export type ProductionRelayDenialCategory =
  | "auth_required"
  | "restricted"
  | "invalid"
  | "blocked"
  | "rate_limited"
  | "error"
  | "other"

export interface ProductionRelayFrameConnection {
  connect(timeoutMs?: number): Promise<void>
  send(frame: unknown[]): void
  next(timeoutMs?: number): Promise<RelayFrame>
  close(): void
}

export type ProductionRelayFrameConnectionFactory =
  () => ProductionRelayFrameConnection

const STAGE_LABELS: Record<ProductionRelayCanaryStage, string> = {
  nip11: "NIP-11",
  websocket: "WS",
  signed_event: "signed event",
  basic_publish_ack: "basic publish/ACK",
  basic_readback: "basic readback",
  inbox_declaration_publish_ack: "kind:10050 publish/ACK",
  inbox_declaration_discovery: "kind:10050 discovery",
  nip17_wrap_publish_ack: "NIP-17 wrap/publish/ACK",
  recipient_auth_fetch: "recipient auth/fetch",
  unwrap_decrypt: "unwrap/decrypt",
  unauthenticated_denied: "unauthenticated denied",
  unrelated_denied: "unrelated denied",
  recipient_refetch: "recipient re-fetch",
  cleanup: "cleanup",
}

function createCanaryIdentity(): CanaryIdentity {
  const secretKey = generateSecretKey()
  return {
    secretKey,
    pubkey: getPublicKey(secretKey),
    signer: new NDKPrivateKeySigner(secretKey),
  }
}

function toCanaryAuthSigner(identity: CanaryIdentity): NostrEventSigner {
  return {
    // This runtime-only adapter exercises Conduit's protected-read state
    // machine. It does not claim NIP-07 extension or NIP-46 transport fidelity.
    authMethod: "nip07",
    getPublicKey: async () => identity.pubkey,
    signEvent: async (event) => finalizeEvent(event, identity.secretKey),
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

function expirationTag(): string[] {
  return ["expiration", String(nowSeconds() + CANARY_EXPIRATION_SECONDS)]
}

function assertSignedEvent(event: SignedPublicNostrEvent): void {
  if (!verifyEvent(event)) throw new Error("invalid_signed_event")
}

function assertAcked(status: string): void {
  if (status !== "acked") throw new Error("relay_not_acked")
}

async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0")
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("nip11_response_too_large")
  }
  if (!response.body) throw new Error("nip11_body_missing")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error("nip11_response_too_large")
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

export function validateProductionRelayNip11(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("nip11_invalid_document")
  }
  const supportedNips = (value as { supported_nips?: unknown }).supported_nips
  if (
    supportedNips !== undefined &&
    (!Array.isArray(supportedNips) ||
      supportedNips.some(
        (nip) => !Number.isSafeInteger(nip) || Number(nip) < 0
      ))
  ) {
    throw new Error("nip11_supported_nips_invalid")
  }
}

async function fetchProductionRelayNip11(): Promise<void> {
  const response = await fetch(PRODUCTION_RELAY_HTTP_URL, {
    headers: { Accept: "application/nostr+json" },
    redirect: "error",
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error("nip11_http_failure")
  const text = await readBoundedText(response, NIP11_MAX_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("nip11_invalid_json")
  }
  validateProductionRelayNip11(parsed)
}

class RelayFrameReader implements ProductionRelayFrameConnection {
  private readonly frames: RelayFrame[] = []
  private readonly waiters: Array<{
    resolve: (frame: RelayFrame) => void
    reject: (error: Error) => void
  }> = []
  private failure: Error | null = null
  private frameCount = 0
  private frameBytes = 0
  readonly socket: WebSocket

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.onmessage = (message) => {
      if (typeof message.data !== "string") {
        this.fail(new Error("relay_binary_frame"))
        return
      }
      this.frameCount += 1
      this.frameBytes += message.data.length
      if (
        this.frameCount > MAX_RELAY_FRAMES ||
        this.frameBytes > MAX_RELAY_FRAME_BYTES
      ) {
        this.fail(new Error("relay_frame_limit"))
        return
      }
      let frame: unknown
      try {
        frame = JSON.parse(message.data)
      } catch {
        this.fail(new Error("relay_malformed_frame"))
        return
      }
      if (!Array.isArray(frame)) return
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(frame)
      else this.frames.push(frame)
    }
    this.socket.onerror = () => this.fail(new Error("relay_socket_error"))
    this.socket.onclose = () => this.fail(new Error("relay_socket_closed"))
  }

  async connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("relay_connect_timeout"))
      }, timeoutMs)
      const onOpen = () => {
        clearTimeout(timeout)
        this.socket.removeEventListener("error", onError)
        resolve()
      }
      const onError = () => {
        clearTimeout(timeout)
        this.socket.removeEventListener("open", onOpen)
        reject(new Error("relay_connect_error"))
      }
      this.socket.addEventListener("open", onOpen, { once: true })
      this.socket.addEventListener("error", onError, { once: true })
    })
  }

  send(frame: unknown[]): void {
    this.socket.send(JSON.stringify(frame))
  }

  async next(timeoutMs = QUERY_TIMEOUT_MS): Promise<RelayFrame> {
    if (this.failure) throw this.failure
    const frame = this.frames.shift()
    if (frame) return frame
    return await new Promise<RelayFrame>((resolve, reject) => {
      const waiter = {
        resolve: (nextFrame: RelayFrame) => {
          clearTimeout(timeout)
          resolve(nextFrame)
        },
        reject: (error: Error) => {
          clearTimeout(timeout)
          reject(error)
        },
      }
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error("relay_frame_timeout"))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  close(): void {
    this.socket.onmessage = null
    this.socket.onerror = null
    this.socket.onclose = null
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close()
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }
}

export function classifyProductionRelayDenialReason(
  reason: unknown
): ProductionRelayDenialCategory {
  if (typeof reason !== "string") return "other"
  const normalized = reason.trim().toLowerCase()
  if (normalized.startsWith("auth-required:")) return "auth_required"
  if (normalized.startsWith("restricted:")) return "restricted"
  if (normalized.startsWith("invalid:")) return "invalid"
  if (normalized.startsWith("blocked:")) return "blocked"
  if (normalized.startsWith("rate-limited:")) return "rate_limited"
  if (normalized.startsWith("error:")) return "error"
  return "other"
}

function remainingProbeTime(deadlineAt: number): number {
  const remaining = Math.floor(deadlineAt - performance.now())
  if (remaining <= 0) throw new Error("relay_probe_deadline")
  return remaining
}

async function checkWebSocketAvailability(): Promise<void> {
  const connection = new RelayFrameReader(PRODUCTION_RELAY_WS_URL)
  try {
    await connection.connect()
  } finally {
    connection.close()
  }
}

function isSubscriptionFrame(
  frame: RelayFrame,
  type: "EVENT" | "EOSE" | "CLOSED",
  subscriptionId: string
): boolean {
  return frame[0] === type && frame[1] === subscriptionId
}

export async function requireUnauthenticatedDenial(input: {
  targetEventId: string
  recipientPubkey: string
  connectionFactory?: ProductionRelayFrameConnectionFactory
  deadlineMs?: number
}): Promise<void> {
  const connectionFactory =
    input.connectionFactory ??
    (() => new RelayFrameReader(PRODUCTION_RELAY_WS_URL))
  const deadlineMs = input.deadlineMs ?? QUERY_TIMEOUT_MS
  const filters = [
    {
      ids: [input.targetEventId],
      kinds: [1_059],
      "#p": [input.recipientPubkey],
      limit: 1,
    },
    { ids: [input.targetEventId], limit: 1 },
  ]
  for (const [index, filter] of filters.entries()) {
    const shape = index === 0 ? "scoped" : "id_only"
    const connection = connectionFactory()
    const subscriptionId = `unauth-${crypto.randomUUID()}`
    let challengeObserved = false
    const deadlineAt = performance.now() + deadlineMs
    try {
      await connection.connect(remainingProbeTime(deadlineAt))
      connection.send(["REQ", subscriptionId, filter])
      while (true) {
        const frame = await connection.next(remainingProbeTime(deadlineAt))
        if (frame[0] === "AUTH" && typeof frame[1] === "string") {
          challengeObserved = true
          continue
        }
        if (isSubscriptionFrame(frame, "EVENT", subscriptionId)) {
          throw new ProductionRelayCanaryCheckError(
            `unauthenticated_${shape}_event_exposed`
          )
        }
        if (isSubscriptionFrame(frame, "EOSE", subscriptionId)) {
          throw new ProductionRelayCanaryCheckError(
            `unauthenticated_${shape}_denial_not_explicit`
          )
        }
        if (isSubscriptionFrame(frame, "CLOSED", subscriptionId)) {
          const denial = classifyProductionRelayDenialReason(frame[2])
          const validDenial =
            shape === "scoped"
              ? denial === "auth_required"
              : denial === "auth_required" ||
                denial === "restricted" ||
                denial === "invalid" ||
                denial === "blocked"
          const validChallenge = shape === "scoped" ? challengeObserved : true
          if (!validChallenge || !validDenial) {
            throw new ProductionRelayCanaryCheckError(
              shape === "id_only" && !validDenial
                ? `unauthenticated_id_only_denial_${denial}`
                : `unauthenticated_${shape}_denial_invalid`
            )
          }
          break
        }
      }
    } finally {
      connection.close()
    }
  }
}

export async function requireUnrelatedDenial(input: {
  targetEventId: string
  recipientPubkey: string
  principal: Pick<CanaryIdentity, "pubkey" | "secretKey">
  principalControlEvent: SignedPublicNostrEvent
  connectionFactory?: ProductionRelayFrameConnectionFactory
  deadlineMs?: number
}): Promise<void> {
  const connection = (
    input.connectionFactory ??
    (() => new RelayFrameReader(PRODUCTION_RELAY_WS_URL))
  )()
  const deadlineAt = performance.now() + (input.deadlineMs ?? QUERY_TIMEOUT_MS)
  const bootstrapId = `bootstrap-${crypto.randomUUID()}`
  let challenge: string | null = null
  let bootstrapRejected = false
  try {
    await connection.connect(remainingProbeTime(deadlineAt))
    connection.send([
      "REQ",
      bootstrapId,
      {
        ids: [input.principalControlEvent.id],
        kinds: [1_059],
        "#p": [input.principal.pubkey],
        limit: 1,
      },
    ])
    while (!challenge || !bootstrapRejected) {
      const frame = await connection.next(remainingProbeTime(deadlineAt))
      if (frame[0] === "AUTH" && typeof frame[1] === "string") {
        challenge = frame[1]
      } else if (isSubscriptionFrame(frame, "EVENT", bootstrapId)) {
        throw new ProductionRelayCanaryCheckError(
          "unrelated_bootstrap_event_exposed"
        )
      } else if (isSubscriptionFrame(frame, "EOSE", bootstrapId)) {
        throw new ProductionRelayCanaryCheckError("unrelated_auth_not_required")
      } else if (isSubscriptionFrame(frame, "CLOSED", bootstrapId)) {
        bootstrapRejected =
          typeof frame[2] === "string" && frame[2].startsWith("auth-required:")
        if (!bootstrapRejected) {
          throw new ProductionRelayCanaryCheckError(
            "unrelated_bootstrap_invalid"
          )
        }
      }
    }

    const authEvent = finalizeEvent(
      {
        kind: 22_242,
        created_at: nowSeconds(),
        tags: [
          ["relay", PRODUCTION_RELAY_WS_URL],
          ["challenge", challenge],
        ],
        content: "",
      },
      input.principal.secretKey
    )
    connection.send(["AUTH", authEvent])
    while (true) {
      const frame = await connection.next(
        Math.min(AUTH_TIMEOUT_MS, remainingProbeTime(deadlineAt))
      )
      if (frame[0] !== "OK" || frame[1] !== authEvent.id) continue
      if (frame[2] !== true) {
        throw new ProductionRelayCanaryCheckError("unrelated_auth_rejected")
      }
      break
    }

    const controlId = `control-${crypto.randomUUID()}`
    connection.send([
      "REQ",
      controlId,
      {
        ids: [input.principalControlEvent.id],
        kinds: [1_059],
        "#p": [input.principal.pubkey],
        limit: 1,
      },
    ])
    let controlObserved = false
    while (true) {
      const frame = await connection.next(remainingProbeTime(deadlineAt))
      if (isSubscriptionFrame(frame, "EVENT", controlId)) {
        const controlEvent = frame[2]
        if (
          !controlEvent ||
          typeof controlEvent !== "object" ||
          !signedCanaryEventsMatchExactly(
            controlEvent as SignedPublicNostrEvent,
            input.principalControlEvent
          )
        ) {
          throw new ProductionRelayCanaryCheckError(
            "unrelated_control_event_mismatch"
          )
        }
        controlObserved = true
        continue
      }
      if (isSubscriptionFrame(frame, "CLOSED", controlId)) {
        throw new ProductionRelayCanaryCheckError("unrelated_control_denied")
      }
      if (isSubscriptionFrame(frame, "EOSE", controlId)) {
        if (!controlObserved) {
          throw new ProductionRelayCanaryCheckError(
            "unrelated_control_event_missing"
          )
        }
        break
      }
    }

    const filters = [
      {
        ids: [input.targetEventId],
        kinds: [1_059],
        "#p": [input.recipientPubkey],
        limit: 1,
      },
      { ids: [input.targetEventId], limit: 1 },
    ]
    for (const [index, filter] of filters.entries()) {
      const shape = index === 0 ? "scoped" : "id_only"
      const crossRecipientId = `cross-${crypto.randomUUID()}`
      connection.send(["REQ", crossRecipientId, filter])
      while (true) {
        const frame = await connection.next(remainingProbeTime(deadlineAt))
        if (isSubscriptionFrame(frame, "EVENT", crossRecipientId)) {
          throw new ProductionRelayCanaryCheckError(
            `unrelated_${shape}_event_exposed`
          )
        }
        if (isSubscriptionFrame(frame, "EOSE", crossRecipientId)) {
          throw new ProductionRelayCanaryCheckError(
            `unrelated_${shape}_denial_not_explicit`
          )
        }
        if (isSubscriptionFrame(frame, "CLOSED", crossRecipientId)) {
          const denial = classifyProductionRelayDenialReason(frame[2])
          const validDenial =
            denial === "restricted" ||
            denial === "blocked" ||
            (shape === "id_only" && denial === "invalid")
          if (!validDenial) {
            throw new ProductionRelayCanaryCheckError(
              `unrelated_${shape}_denial_${denial}`
            )
          }
          break
        }
      }
    }
  } finally {
    connection.close()
  }
}

export function signedCanaryEventsMatchExactly(
  actual: SignedPublicNostrEvent,
  expected: SignedPublicNostrEvent
): boolean {
  return (
    actual.id === expected.id &&
    actual.pubkey === expected.pubkey &&
    actual.created_at === expected.created_at &&
    actual.kind === expected.kind &&
    JSON.stringify(actual.tags) === JSON.stringify(expected.tags) &&
    actual.content === expected.content &&
    actual.sig === expected.sig
  )
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function signedDeletion(
  identity: CanaryIdentity,
  eventIds: readonly string[]
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: 5,
      created_at: nowSeconds(),
      tags: [...eventIds.map((eventId) => ["e", eventId]), expirationTag()],
      content: "",
    },
    identity.secretKey
  )
}

export function createLiveProductionRelayCanaryOperations(): ProductionRelayCanaryOperations {
  const sender = createCanaryIdentity()
  const recipient = createCanaryIdentity()
  const executor = new WebSocketCommerceRelayExecutor()
  const senderEvidence = createInMemoryInboxDeclarationEvidenceRepository()
  const recipientEvidence = createInMemoryInboxDeclarationEvidenceRepository()
  const payloadToken = crypto.randomUUID()
  const expectedPayload = JSON.stringify({
    type: "conduit-production-relay-canary",
    token: payloadToken,
  })

  let basicEvent: SignedPublicNostrEvent | null = null
  let senderDeclaration: SignedPublicNostrEvent | null = null
  let recipientDeclaration: SignedPublicNostrEvent | null = null
  let giftWrapEvent: SignedPublicNostrEvent | null = null
  let recipientFetchedEvent: SignedPublicNostrEvent | null = null
  let senderSelfCopyEvent: SignedPublicNostrEvent | null = null
  let senderInboxRelayUrls: string[] = []
  let senderDeclarationEventId: string | null = null
  let recipientInboxRelayUrls: string[] = []
  let recipientAuthorization: ReturnType<typeof getProtectedReadAuthorization> =
    null

  const requireEvent = <T>(value: T | null, code: string): T => {
    if (!value) throw new Error(code)
    return value
  }

  const publishDeclaration = async (
    identity: CanaryIdentity,
    evidenceRepository: ReturnType<
      typeof createInMemoryInboxDeclarationEvidenceRepository
    >
  ): Promise<SignedPublicNostrEvent> => {
    const event = await publishPrivateMessageRelayDeclaration({
      pubkey: identity.pubkey,
      signer: identity.signer,
      relayUrls: [PRODUCTION_RELAY_WS_URL],
      frontierCreatedAt: null,
      expectedFrontierEventId: null,
      getDiscoveryRelayUrls: () => [PRODUCTION_RELAY_WS_URL],
      evidenceRepository,
    })
    const signed = event.rawEvent() as SignedPublicNostrEvent
    assertSignedEvent(signed)
    return signed
  }

  const fetchRecipientWrap = async (): Promise<SignedPublicNostrEvent> => {
    recipientAuthorization ??= (() => {
      installProtectedReadSigner(
        toCanaryAuthSigner(recipient),
        recipient.pubkey,
        () => true
      )
      return getProtectedReadAuthorization(recipient.pubkey)
    })()
    if (!recipientAuthorization) throw new Error("recipient_auth_unavailable")
    const expected = requireEvent(giftWrapEvent, "gift_wrap_missing")
    for (const retryDelayMs of READ_AFTER_WRITE_RETRY_DELAYS_MS) {
      await delay(retryDelayMs)
      const result = await readProtectedInbox({
        principalPubkey: recipient.pubkey,
        relayUrls: [PRODUCTION_RELAY_WS_URL],
        limit: 20,
        authorization: recipientAuthorization,
        executor,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        queryTimeoutMs: QUERY_TIMEOUT_MS,
        authTimeoutMs: AUTH_TIMEOUT_MS,
      })
      if (
        result.coverage !== "complete" ||
        result.auth.state !== "authenticated"
      ) {
        continue
      }
      const fetched = result.events.find((event) => event.id === expected.id)
      if (fetched && signedCanaryEventsMatchExactly(fetched, expected)) {
        return fetched
      }
    }
    throw new Error("recipient_exact_wrap_missing")
  }

  return {
    nip11: fetchProductionRelayNip11,
    websocket: checkWebSocketAvailability,
    async signedEvent() {
      basicEvent = finalizeEvent(
        {
          kind: 1,
          created_at: nowSeconds(),
          tags: [["t", "conduit-production-relay-canary"], expirationTag()],
          content: "Conduit production relay canary",
        },
        sender.secretKey
      )
      assertSignedEvent(basicEvent)
    },
    async basicPublishAck() {
      const event = requireEvent(basicEvent, "basic_event_missing")
      assertAcked(
        await publishSignedEventToRelay({
          relayUrl: PRODUCTION_RELAY_WS_URL,
          authorPubkey: sender.pubkey,
          authenticatedPubkey: sender.pubkey,
          signedEvent: event,
        })
      )
    },
    async basicReadback() {
      const expected = requireEvent(basicEvent, "basic_event_missing")
      for (const retryDelayMs of READ_AFTER_WRITE_RETRY_DELAYS_MS) {
        await delay(retryDelayMs)
        const result = await executor.query(
          {
            relayUrls: [PRODUCTION_RELAY_WS_URL],
            operation: "public_read",
            filters: [
              {
                ids: [expected.id],
                authors: [sender.pubkey],
                kinds: [expected.kind],
                limit: 1,
              },
            ],
          },
          {
            connectTimeoutMs: CONNECT_TIMEOUT_MS,
            queryTimeoutMs: QUERY_TIMEOUT_MS,
          }
        )
        if (
          result.status === "success" &&
          result.events.length === 1 &&
          signedCanaryEventsMatchExactly(result.events[0]!, expected)
        ) {
          return
        }
      }
      throw new Error("basic_exact_readback_missing")
    },
    async inboxDeclarationPublishAck() {
      senderDeclaration = await publishDeclaration(sender, senderEvidence)
      recipientDeclaration = await publishDeclaration(
        recipient,
        recipientEvidence
      )
      __resetInboxRelayCache()
    },
    async inboxDeclarationDiscovery() {
      const expectedSender = requireEvent(
        senderDeclaration,
        "sender_declaration_missing"
      )
      const expected = requireEvent(
        recipientDeclaration,
        "recipient_declaration_missing"
      )
      for (const retryDelayMs of READ_AFTER_WRITE_RETRY_DELAYS_MS) {
        await delay(retryDelayMs)
        __resetInboxRelayCache()
        const [senderResolution, resolution] = await Promise.all([
          resolveInboxDeclaration(sender.pubkey, {
            relayUrls: [PRODUCTION_RELAY_WS_URL],
            sharedConfirmationRelayUrls: [PRODUCTION_RELAY_WS_URL],
            evidenceRepository: senderEvidence,
            freshnessMs: 0,
          }),
          resolveInboxDeclaration(recipient.pubkey, {
            relayUrls: [PRODUCTION_RELAY_WS_URL],
            sharedConfirmationRelayUrls: [PRODUCTION_RELAY_WS_URL],
            evidenceRepository: recipientEvidence,
            freshnessMs: 0,
          }),
        ])
        if (
          senderResolution.state === "declared" &&
          senderResolution.eventId === expectedSender.id &&
          senderResolution.observation?.coverage === "complete" &&
          senderResolution.relayUrls.includes(PRODUCTION_RELAY_WS_URL) &&
          resolution.state === "declared" &&
          resolution.eventId === expected.id &&
          resolution.observation?.coverage === "complete" &&
          resolution.relayUrls.includes(PRODUCTION_RELAY_WS_URL)
        ) {
          senderInboxRelayUrls = [...senderResolution.relayUrls]
          senderDeclarationEventId = senderResolution.eventId ?? null
          recipientInboxRelayUrls = [...resolution.relayUrls]
          return
        }
      }
      throw new Error("recipient_declaration_not_discovered")
    },
    async nip17WrapPublishAck() {
      if (
        !senderDeclarationEventId ||
        senderInboxRelayUrls.length === 0 ||
        recipientInboxRelayUrls.length === 0
      ) {
        throw new Error("recipient_inbox_route_missing")
      }
      const rumor = buildDirectMessageRumor({
        senderPubkey: sender.pubkey,
        recipientPubkey: recipient.pubkey,
        content: expectedPayload,
        subject: "conduit-production-relay-canary",
        appId: "market",
      })
      const result = await publishPrivateMessage({
        rumor,
        senderPubkey: sender.pubkey,
        recipientPubkey: recipient.pubkey,
        signer: sender.signer,
        rumorKind: 14,
        recipientInboxRelays: recipientInboxRelayUrls,
        senderInboxRelays: senderInboxRelayUrls,
        inspectOwnInboxReadiness: async () => ({
          state: "ready",
          eventId: senderDeclarationEventId,
          relayUrls: senderInboxRelayUrls,
          stale: false,
          distributionRepairable: false,
        }),
        giftWrapFn: async (
          event: NDKEvent,
          recipientUser,
          signer: NDKSigner,
          params
        ) =>
          await giftWrap(event, recipientUser, signer, {
            ...params,
            wrapTags: [expirationTag()],
          }),
        publishFn: publishWithPlanner,
      })
      if (
        !result.recipientDelivery.successfulRelayUrls.includes(
          PRODUCTION_RELAY_WS_URL
        ) ||
        result.selfCopyError !== null ||
        !result.wrappedToSelf
      ) {
        throw new Error("gift_wrap_not_acked")
      }
      giftWrapEvent =
        result.wrappedToRecipient.rawEvent() as SignedPublicNostrEvent
      senderSelfCopyEvent =
        result.wrappedToSelf.rawEvent() as SignedPublicNostrEvent
      assertSignedEvent(giftWrapEvent)
      assertSignedEvent(senderSelfCopyEvent)
      if (
        giftWrapEvent.kind !== 1_059 ||
        !giftWrapEvent.tags.some(
          (tag) => tag[0] === "p" && tag[1] === recipient.pubkey
        )
      ) {
        throw new Error("gift_wrap_invalid")
      }
    },
    async recipientAuthFetch() {
      recipientFetchedEvent = await fetchRecipientWrap()
    },
    async unwrapDecrypt() {
      const fetched = requireEvent(
        recipientFetchedEvent,
        "recipient_fetched_wrap_missing"
      )
      const outcome = await unwrapGiftWrap(
        new NDKEvent(undefined, fetched),
        recipient.signer,
        { timeoutMs: QUERY_TIMEOUT_MS }
      )
      if (outcome.status !== "ok" || outcome.category !== "direct") {
        throw new Error("gift_wrap_unwrap_failed")
      }
      const parsed = parseDirectMessageRumor(outcome.rumor)
      if (
        parsed.senderPubkey !== sender.pubkey ||
        parsed.recipientPubkey !== recipient.pubkey ||
        parsed.content !== expectedPayload
      ) {
        throw new Error("canary_payload_mismatch")
      }
    },
    async unauthenticatedDenied() {
      const target = requireEvent(giftWrapEvent, "gift_wrap_missing")
      await requireUnauthenticatedDenial({
        targetEventId: target.id,
        recipientPubkey: recipient.pubkey,
      })
    },
    async unrelatedDenied() {
      const target = requireEvent(giftWrapEvent, "gift_wrap_missing")
      const control = requireEvent(
        senderSelfCopyEvent,
        "sender_self_copy_missing"
      )
      await requireUnrelatedDenial({
        targetEventId: target.id,
        recipientPubkey: recipient.pubkey,
        principal: sender,
        principalControlEvent: control,
      })
    },
    async recipientRefetch() {
      const fetchedAgain = await fetchRecipientWrap()
      const expected = requireEvent(giftWrapEvent, "gift_wrap_missing")
      if (!signedCanaryEventsMatchExactly(fetchedAgain, expected)) {
        throw new Error("recipient_refetch_mismatch")
      }
    },
    async cleanup() {
      const senderEventIds = [basicEvent?.id, senderDeclaration?.id].filter(
        (eventId): eventId is string => Boolean(eventId)
      )
      const recipientEventIds = [recipientDeclaration?.id].filter(
        (eventId): eventId is string => Boolean(eventId)
      )
      const cleanupEvents = [
        ...(senderEventIds.length > 0
          ? [
              {
                identity: sender,
                event: signedDeletion(sender, senderEventIds),
              },
            ]
          : []),
        ...(recipientEventIds.length > 0
          ? [
              {
                identity: recipient,
                event: signedDeletion(recipient, recipientEventIds),
              },
            ]
          : []),
      ]
      for (const cleanup of cleanupEvents) {
        assertAcked(
          await publishSignedEventToRelay({
            relayUrl: PRODUCTION_RELAY_WS_URL,
            authorPubkey: cleanup.identity.pubkey,
            authenticatedPubkey: cleanup.identity.pubkey,
            signedEvent: cleanup.event,
          })
        )
      }
    },
    dispose() {
      __resetProtectedReadSigner()
      __resetInboxRelayCache()
      executor.dispose()
      disconnectNdk()
    },
  }
}

function operationForStage(
  operations: ProductionRelayCanaryOperations,
  stage: ProductionRelayCanaryStage
): () => Promise<void> {
  const operationsByStage: Record<
    ProductionRelayCanaryStage,
    () => Promise<void>
  > = {
    nip11: () => operations.nip11(),
    websocket: () => operations.websocket(),
    signed_event: () => operations.signedEvent(),
    basic_publish_ack: () => operations.basicPublishAck(),
    basic_readback: () => operations.basicReadback(),
    inbox_declaration_publish_ack: () =>
      operations.inboxDeclarationPublishAck(),
    inbox_declaration_discovery: () => operations.inboxDeclarationDiscovery(),
    nip17_wrap_publish_ack: () => operations.nip17WrapPublishAck(),
    recipient_auth_fetch: () => operations.recipientAuthFetch(),
    unwrap_decrypt: () => operations.unwrapDecrypt(),
    unauthenticated_denied: () => operations.unauthenticatedDenied(),
    unrelated_denied: () => operations.unrelatedDenied(),
    recipient_refetch: () => operations.recipientRefetch(),
    cleanup: () => operations.cleanup(),
  }
  return operationsByStage[stage]
}

export async function runProductionRelayCanary(
  operations: ProductionRelayCanaryOperations = createLiveProductionRelayCanaryOperations()
): Promise<ProductionRelayCanaryStageResult[]> {
  const results: ProductionRelayCanaryStageResult[] = []
  let failure: ProductionRelayCanaryFailure | null = null
  try {
    for (const stage of PRODUCTION_RELAY_CANARY_STAGE_ORDER) {
      const startedAt = performance.now()
      try {
        await operationForStage(operations, stage)()
        results.push({
          stage,
          status: "passed",
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        })
      } catch (error) {
        const code =
          error instanceof ProductionRelayCanaryCheckError &&
          SAFE_CHECK_FAILURE_CODES.has(error.code)
            ? error.code
            : `${stage}_failed`
        results.push({
          stage,
          status: "failed",
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          code,
        })
        if (stage !== "cleanup") {
          const cleanupStartedAt = performance.now()
          try {
            await operations.cleanup()
            results.push({
              stage: "cleanup",
              status: "passed",
              latencyMs: Math.max(
                0,
                Math.round(performance.now() - cleanupStartedAt)
              ),
            })
          } catch {
            results.push({
              stage: "cleanup",
              status: "failed",
              latencyMs: Math.max(
                0,
                Math.round(performance.now() - cleanupStartedAt)
              ),
              code: "cleanup_failed",
            })
          }
        }
        failure = new ProductionRelayCanaryFailure(stage, code, results, {
          cause: error,
        })
        break
      }
    }
  } finally {
    try {
      operations.dispose()
    } catch (error) {
      const cleanupIndex = results.findLastIndex(
        (result) => result.stage === "cleanup"
      )
      const disposeFailure: ProductionRelayCanaryStageResult = {
        stage: "cleanup",
        status: "failed",
        latencyMs: 0,
        code: "dispose_failed",
      }
      if (cleanupIndex >= 0) results[cleanupIndex] = disposeFailure
      else results.push(disposeFailure)
      failure ??= new ProductionRelayCanaryFailure(
        "cleanup",
        "dispose_failed",
        results,
        { cause: error }
      )
    }
  }
  if (failure) throw failure
  return results
}

export function latencyBucket(latencyMs: number): string {
  if (latencyMs < 250) return "<250ms"
  if (latencyMs < 1_000) return "<1s"
  if (latencyMs < 3_000) return "<3s"
  if (latencyMs < 10_000) return "<10s"
  return ">=10s"
}

export function formatProductionRelayCanaryLadder(
  results: readonly ProductionRelayCanaryStageResult[]
): string {
  return results
    .map((result) => {
      const status = result.status === "passed" ? "✓" : "✗"
      return `${STAGE_LABELS[result.stage]} ${status} (${latencyBucket(result.latencyMs)})`
    })
    .join(" → ")
}

export function formatProductionRelayCanarySummary(
  results: readonly ProductionRelayCanaryStageResult[],
  options: { forceFailed?: boolean; testedSha?: string } = {}
): string {
  const failed = results.find((result) => result.status === "failed")
  const outcome = failed || options.forceFailed ? "FAILED" : "PASSED"
  const testedSha =
    options.testedSha && /^[0-9a-f]{40}$/i.test(options.testedSha)
      ? options.testedSha.toLowerCase()
      : null
  const lines = [
    "## Production relay canary",
    "",
    `**${outcome}** — runtime-local synthetic canary signers; no user data or persistent keys.`,
  ]
  if (testedSha) lines.push("", `Tested commit: \`${testedSha}\``)
  const ladder = formatProductionRelayCanaryLadder(results)
  if (ladder) lines.push("", ladder)
  else if (options.forceFailed) {
    lines.push("", "The canary failed before stage diagnostics were available.")
  }
  if (failed) lines.push("", `Failure code: \`${failed.code}\``)
  return `${lines.join("\n")}\n`
}

async function main(): Promise<void> {
  let results: readonly ProductionRelayCanaryStageResult[] = []
  const testedSha = process.env.GITHUB_SHA
  try {
    results = await runProductionRelayCanary()
  } catch (error) {
    results =
      error instanceof ProductionRelayCanaryFailure ? error.results : results
    console.error(formatProductionRelayCanaryLadder(results))
    const failed = results.find((result) => result.status === "failed")
    if (failed?.code) console.error(`Failure code: ${failed.code}`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      await writeFile(
        process.env.GITHUB_STEP_SUMMARY,
        formatProductionRelayCanarySummary(results, {
          forceFailed: true,
          testedSha,
        }),
        { mode: 0o600 }
      )
    }
    process.exitCode = 1
    return
  }

  console.log(formatProductionRelayCanaryLadder(results))
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      formatProductionRelayCanarySummary(results, { testedSha }),
      { mode: 0o600 }
    )
  }
}

if (import.meta.main) await main()

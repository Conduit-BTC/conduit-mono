import { isDeepStrictEqual } from "node:util"

import { NDKEvent, NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools"

import {
  createProtectedReadSessionLifecycle,
  fetchBtcUsdRate,
  getAtomicProductDetail,
  getMerchantConversationList,
  getNdk,
  isPricingRateQuoteFresh,
  NostrSignerError,
  parseAuthSession,
  removeSigner,
  RemoteSignerError,
  restoreRemoteSigner,
  SessionSigner,
  setSigner,
  type BtcUsdRateQuote,
  type CommerceProductRecord,
  type MerchantConversationSummary,
  type Nip46AuthSession,
} from "@conduit/core"
import { normalizePubkey } from "@conduit/core/utils"

import { createNdkNostrEventSigner } from "../../packages/core/src/protocol/ndk-nostr-event-signer"
import { createGuestOrderSigningIdentity } from "../../apps/market/src/lib/guest-order-identity"
import {
  buildCheckoutOrderRumor,
  type ReadyCheckoutPricing,
} from "../../apps/market/src/lib/checkout-order"
import {
  buildCheckoutPricingIntent,
  CHECKOUT_QUOTE_MAX_AGE_MS,
} from "../../apps/market/src/lib/checkout-payment"
import {
  createCartItemFromProduct,
  getCartCommerceFingerprint,
  type CartItem,
} from "../../apps/market/src/lib/cart-model"
import { publishBuyerOrderMessage } from "../../apps/market/src/lib/order-publish"
import {
  UNAVAILABLE_GUEST_CHECKOUT_ORDER_RELAY_EVIDENCE,
  type GuestCheckoutOrderSmokeRelayEvidence,
  type GuestCheckoutOrderSmokeStage as EvidenceStage,
  type GuestCheckoutOrderSmokeStatus as EvidenceStatus,
} from "./guest_checkout_order_evidence"

const DEFAULT_RECOVERY_TIMEOUT_MS = 90_000
const DEFAULT_RECOVERY_POLL_MS = 2_000
const MAX_RECOVERY_TIMEOUT_MS = 180_000
const MAX_NIP46_SESSION_AGE_MS = 90 * 24 * 60 * 60 * 1_000
const MAX_NIP46_SESSION_FUTURE_SKEW_MS = 5 * 60 * 1_000
const MAX_NIP46_PUBLIC_SESSION_BYTES = 8_192
const MERCHANT_SIGNER_CLOSE_TIMEOUT_MS = 5_000
const NIP46_SESSION_KEYS = [
  "clientKeyId",
  "createdAt",
  "relayUrls",
  "remoteSignerPubkey",
  "type",
  "updatedAt",
  "userPubkey",
  "version",
] as const
const NIP46_CLIENT_KEY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NIP46_PUBLIC_SESSION_POLICY_SNAPSHOT = Object.freeze({
  maxSessionBytes: MAX_NIP46_PUBLIC_SESSION_BYTES,
  sessionKeys: Object.freeze([...NIP46_SESSION_KEYS]),
  clientKeyIdPattern: Object.freeze({
    source: NIP46_CLIENT_KEY_ID_PATTERN.source,
    flags: NIP46_CLIENT_KEY_ID_PATTERN.flags,
  }),
})

export function getGuestCheckoutOrderSmokeNip46PolicySnapshot() {
  return NIP46_PUBLIC_SESSION_POLICY_SNAPSHOT
}
const SMOKE_CONTACT = {
  email: "guest-order-smoke@example.invalid",
  phone: "+1555010100",
}

export type GuestCheckoutOrderSmokeStage = EvidenceStage

export type GuestCheckoutOrderSmokeStatus = EvidenceStatus

export type GuestCheckoutOrderSmokeFailureEvidence = {
  status: Exclude<GuestCheckoutOrderSmokeStatus, "passed">
  stage: GuestCheckoutOrderSmokeStage
  summary: string
}

class GuestCheckoutOrderSmokeFailure extends Error {
  override name = "GuestCheckoutOrderSmokeFailure"

  constructor(
    readonly stage: GuestCheckoutOrderSmokeStage,
    readonly status: Exclude<GuestCheckoutOrderSmokeStatus, "passed">,
    cause: unknown
  ) {
    super(`Guest checkout order smoke ${status} at ${stage}.`, { cause })
  }
}

class GuestCheckoutOrderSmokeInconclusive extends Error {
  override name = "GuestCheckoutOrderSmokeInconclusive"
}

function stageFailure(
  stage: GuestCheckoutOrderSmokeStage,
  error: unknown
): GuestCheckoutOrderSmokeFailure {
  const signerUnavailable = isSignerUnavailable(error)
  return new GuestCheckoutOrderSmokeFailure(
    stage,
    error instanceof GuestCheckoutOrderSmokeInconclusive || signerUnavailable
      ? "inconclusive"
      : "failed",
    error
  )
}

function isSignerUnavailable(error: unknown, depth = 0): boolean {
  if (depth > 4) return false
  if (
    (error instanceof RemoteSignerError &&
      (error.code === "timeout" || error.code === "unavailable")) ||
    (error instanceof NostrSignerError &&
      (error.code === "timeout" || error.code === "unavailable"))
  ) {
    return true
  }
  return (
    error instanceof Error &&
    error.cause !== undefined &&
    isSignerUnavailable(error.cause, depth + 1)
  )
}

type Environment = Record<string, string | undefined>

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  )
}

export type GuestCheckoutOrderSmokeConfig = {
  merchantPubkey: string
  productAddress: string
  merchantNip46Session: Nip46AuthSession
  merchantNip46ClientSecretKeyHex: string
  recoveryTimeoutMs: number
  recoveryPollMs: number
}

type GuestIdentity = ReturnType<typeof createGuestOrderSigningIdentity>

export type GuestCheckoutOrderSmokeMerchantSigner = {
  signer: NDKSigner
  invalidate(): void
  close(): Promise<void>
  interactiveAuthorizationRequired?(): boolean
}

export type GuestCheckoutOrderSmokeDependencies = {
  getProduct?: typeof getAtomicProductDetail
  getPricingRate?: () => Promise<BtcUsdRateQuote>
  createOrderId?: () => string
  createGuestIdentity?: (
    orderId: string,
    merchantPubkey: string
  ) => GuestIdentity
  publishOrder?: typeof publishBuyerOrderMessage
  getMerchantOrders?: typeof getMerchantConversationList
  connectMerchantSigner?: (
    config: GuestCheckoutOrderSmokeConfig
  ) => Promise<GuestCheckoutOrderSmokeMerchantSigner>
  restoreMerchantSigner?: typeof restoreRemoteSigner
  preflightMerchantSigner?: (
    signer: NDKSigner,
    config: GuestCheckoutOrderSmokeConfig
  ) => Promise<void>
  merchantSignerCloseTimeoutMs?: number
  onRelayEvidence?: (evidence: GuestCheckoutOrderSmokeRelayEvidence) => void
  nowMs?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function parsePubkey(env: Environment, name: string): string {
  const pubkey = normalizePubkey(required(env, name))
  if (!pubkey) throw new Error(`${name} must be a valid Nostr public key.`)
  return pubkey
}

function skipWhitespace(value: string, start: number): number {
  let index = start
  while (/\s/.test(value[index] ?? "")) index += 1
  return index
}

function findJsonStringEnd(value: string, start: number): number | null {
  if (value[start] !== '"') return null
  let escaped = false
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) {
      escaped = false
    } else if (character === "\\") {
      escaped = true
    } else if (character === '"') {
      return index + 1
    }
  }
  return null
}

function findTopLevelJsonValueEnd(value: string, start: number): number | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === "{" || character === "[") {
      stack.push(character)
      continue
    }
    if (character === "}" || character === "]") {
      if (stack.length === 0) return character === "}" ? index : null
      const opener = stack.pop()
      if (
        (character === "}" && opener !== "{") ||
        (character === "]" && opener !== "[")
      ) {
        return null
      }
      continue
    }
    if (character === "," && stack.length === 0) return index
  }
  return null
}

function getTopLevelJsonObjectKeys(raw: string): string[] | null {
  let index = skipWhitespace(raw, 0)
  if (raw[index] !== "{") return null
  index = skipWhitespace(raw, index + 1)
  if (raw[index] === "}") {
    return skipWhitespace(raw, index + 1) === raw.length ? [] : null
  }

  const keys: string[] = []
  while (index < raw.length) {
    const keyEnd = findJsonStringEnd(raw, index)
    if (keyEnd === null) return null
    let key: unknown
    try {
      key = JSON.parse(raw.slice(index, keyEnd))
    } catch {
      return null
    }
    if (typeof key !== "string") return null
    keys.push(key)

    index = skipWhitespace(raw, keyEnd)
    if (raw[index] !== ":") return null
    index = skipWhitespace(raw, index + 1)
    const valueEnd = findTopLevelJsonValueEnd(raw, index)
    if (valueEnd === null) return null
    index = skipWhitespace(raw, valueEnd)
    if (raw[index] === ",") {
      index = skipWhitespace(raw, index + 1)
      continue
    }
    if (raw[index] === "}") {
      return skipWhitespace(raw, index + 1) === raw.length ? keys : null
    }
    return null
  }
  return null
}

function parseMerchantNip46Session(
  raw: string,
  merchantPubkey: string,
  nowMs: number
): Nip46AuthSession {
  if (
    new TextEncoder().encode(raw).byteLength > MAX_NIP46_PUBLIC_SESSION_BYTES
  ) {
    throw new Error("Guest checkout smoke remote signer session is invalid.")
  }
  let rawSession: unknown
  try {
    rawSession = JSON.parse(raw)
  } catch {
    throw new Error("Guest checkout smoke remote signer session is invalid.")
  }
  const rawKeys = getTopLevelJsonObjectKeys(raw)
  if (
    typeof rawSession !== "object" ||
    rawSession === null ||
    Array.isArray(rawSession) ||
    !rawKeys ||
    rawKeys.length !== new Set(rawKeys).size ||
    JSON.stringify(Object.keys(rawSession).sort()) !==
      JSON.stringify([...NIP46_SESSION_KEYS].sort())
  ) {
    throw new Error(
      "Guest checkout smoke remote signer session must use the public canary schema."
    )
  }
  const rawRecord = rawSession as Record<string, unknown>
  if (
    typeof rawRecord.clientKeyId !== "string" ||
    !NIP46_CLIENT_KEY_ID_PATTERN.test(rawRecord.clientKeyId) ||
    !Array.isArray(rawRecord.relayUrls) ||
    !rawRecord.relayUrls.every(isPublicNip46RelayUrl)
  ) {
    throw new Error(
      "Guest checkout smoke remote signer session contains unsafe public metadata."
    )
  }
  const session = parseAuthSession(raw)
  if (
    session?.type !== "nip46" ||
    session.userPubkey !== merchantPubkey ||
    session.remoteSignerPubkey === session.userPubkey
  ) {
    throw new Error(
      "Guest checkout smoke remote signer session does not match the configured merchant."
    )
  }
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(session.createdAt) ||
    !Number.isFinite(session.updatedAt) ||
    session.createdAt > session.updatedAt ||
    session.createdAt > nowMs + MAX_NIP46_SESSION_FUTURE_SKEW_MS ||
    session.updatedAt > nowMs + MAX_NIP46_SESSION_FUTURE_SKEW_MS ||
    nowMs - session.createdAt > MAX_NIP46_SESSION_AGE_MS
  ) {
    throw new Error(
      "Guest checkout smoke remote signer session is outside its allowed age."
    )
  }
  return session
}

function isPublicNip46RelayUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return isPublicNip46RelayUrlMetadata(url)
  } catch {
    return false
  }
}

export function isPublicNip46RelayUrlMetadata(input: {
  protocol: string
  username: string
  password: string
  search: string
  hash: string
}): boolean {
  return (
    input.protocol === "wss:" &&
    input.username === "" &&
    input.password === "" &&
    input.search === "" &&
    input.hash === ""
  )
}

function parseNip46ClientSecretKey(
  raw: string,
  session: Nip46AuthSession
): string {
  try {
    const normalized = raw.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error("Unexpected client key encoding.")
    }
    const clientPubkey = getPublicKey(hexToBytes(normalized))
    if (
      clientPubkey === session.userPubkey ||
      clientPubkey === session.remoteSignerPubkey
    ) {
      throw new Error("NIP-46 client identity must be independent.")
    }
    return normalized
  } catch (error) {
    throw new Error("Guest checkout smoke NIP-46 client key is invalid.", {
      cause: error,
    })
  }
}

function parseProductAddress(raw: string, merchantPubkey: string): string {
  const match = raw.match(/^30402:([0-9a-fA-F]{64}):(.+)$/)
  if (
    !match ||
    match[1]?.toLowerCase() !== merchantPubkey ||
    !match[2]?.trim()
  ) {
    throw new Error(
      "Guest checkout smoke product must be a kind 30402 coordinate owned by the configured merchant."
    )
  }
  return `30402:${merchantPubkey}:${match[2]}`
}

function parseDuration(
  env: Environment,
  name: string,
  fallback: number,
  maximum: number
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} is outside its allowed range.`)
  }
  return value
}

export function parseGuestCheckoutOrderSmokeConfig(
  env: Environment = process.env,
  now: () => number = Date.now
): GuestCheckoutOrderSmokeConfig {
  try {
    const merchantPubkey = parsePubkey(
      env,
      "GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY"
    )
    const merchantNip46Session = parseMerchantNip46Session(
      required(env, "GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_SESSION"),
      merchantPubkey,
      now()
    )
    const merchantNip46ClientSecretKeyHex = parseNip46ClientSecretKey(
      required(
        env,
        "GUEST_CHECKOUT_SMOKE_MERCHANT_NIP46_CLIENT_SECRET_KEY_HEX"
      ),
      merchantNip46Session
    )

    return {
      merchantPubkey,
      productAddress: parseProductAddress(
        required(env, "GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS"),
        merchantPubkey
      ),
      merchantNip46Session,
      merchantNip46ClientSecretKeyHex,
      recoveryTimeoutMs: parseDuration(
        env,
        "GUEST_CHECKOUT_SMOKE_RECOVERY_TIMEOUT_MS",
        DEFAULT_RECOVERY_TIMEOUT_MS,
        MAX_RECOVERY_TIMEOUT_MS
      ),
      recoveryPollMs: parseDuration(
        env,
        "GUEST_CHECKOUT_SMOKE_RECOVERY_POLL_MS",
        DEFAULT_RECOVERY_POLL_MS,
        10_000
      ),
    }
  } catch (error) {
    throw stageFailure("configuration", error)
  }
}

async function closeMerchantSignerWithinTimeout(
  connection: GuestCheckoutOrderSmokeMerchantSigner,
  timeoutMs: number
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new RemoteSignerError(
          "timeout",
          "Guest checkout smoke remote signer cleanup timed out.",
          { operation: "close" }
        )
      )
    }, timeoutMs)
  })
  try {
    await Promise.race([connection.close(), timeout])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

async function connectMerchantNip46Signer(
  config: GuestCheckoutOrderSmokeConfig,
  restore: typeof restoreRemoteSigner = restoreRemoteSigner
): Promise<GuestCheckoutOrderSmokeMerchantSigner> {
  let interactiveAuthorizationRequired = false
  const authorizationController = new AbortController()
  try {
    const connection = await restore(config.merchantNip46Session, {
      signal: authorizationController.signal,
      onAuthUrl: () => {
        interactiveAuthorizationRequired = true
        authorizationController.abort()
      },
      keyVault: {
        prepare: async () => undefined,
        store: async () => {
          throw new Error("Guest checkout smoke NIP-46 vault is read-only.")
        },
        load: async (clientKeyId) =>
          clientKeyId === config.merchantNip46Session.clientKeyId
            ? config.merchantNip46ClientSecretKeyHex
            : null,
        remove: async () => {
          throw new Error("Guest checkout smoke NIP-46 vault is read-only.")
        },
      },
    })
    return {
      signer: connection.signer,
      invalidate: () => connection.signer.invalidate(),
      close: async () => connection.bunkerSigner.close(),
      interactiveAuthorizationRequired: () => interactiveAuthorizationRequired,
    }
  } catch (error) {
    if (interactiveAuthorizationRequired) {
      throw new GuestCheckoutOrderSmokeInconclusive(
        "Guest checkout smoke remote signer requires interactive authorization."
      )
    }
    throw error
  }
}

async function preflightMerchantNip46Signer(
  signer: NDKSigner,
  config: GuestCheckoutOrderSmokeConfig
): Promise<void> {
  const protectedSigner = createNdkNostrEventSigner(
    signer,
    config.merchantPubkey,
    "nip46"
  )
  await protectedSigner.signEvent({
    kind: 22_242,
    pubkey: config.merchantPubkey,
    created_at: Math.floor(Date.now() / 1_000),
    tags: [
      ["relay", config.merchantNip46Session.relayUrls[0]!],
      ["challenge", `guest-checkout-smoke-${crypto.randomUUID()}`],
    ],
    content: "",
  })

  const probeSenderKey = generateSecretKey()
  const probeSenderPubkey = getPublicKey(probeSenderKey)
  const probePlaintext = `guest-checkout-smoke-${crypto.randomUUID()}`
  const probeConversationKey = nip44.v2.utils.getConversationKey(
    probeSenderKey,
    config.merchantPubkey
  )
  const probeCiphertext = nip44.v2.encrypt(probePlaintext, probeConversationKey)
  const decrypted = await signer.decrypt(
    new NDKUser({ pubkey: probeSenderPubkey }),
    probeCiphertext,
    "nip44"
  )
  if (decrypted !== probePlaintext) {
    throw new RemoteSignerError(
      "invalid_response",
      "Guest checkout smoke remote signer returned invalid preflight data.",
      { operation: "NIP-44 preflight" }
    )
  }
}

function requireGuestOrderCartItem(
  record: CommerceProductRecord | null,
  config: GuestCheckoutOrderSmokeConfig
): CartItem {
  if (!record || record.product.pubkey !== config.merchantPubkey) {
    throw new Error("Guest checkout smoke product could not be verified.")
  }
  const product = record.product
  if (product.type !== "simple") {
    throw new Error(
      "Guest checkout smoke supports only a simple product fixture."
    )
  }
  if (record.addressId !== config.productAddress) {
    throw new Error("Guest checkout smoke product could not be verified.")
  }
  if (product.stock === 0) {
    throw new Error("Guest checkout smoke product is out of stock.")
  }

  const item: CartItem = {
    ...createCartItemFromProduct(product),
    productId: config.productAddress,
    quantity: 1,
  }
  if (
    item.format !== "digital" ||
    item.shippingCostSats !== undefined ||
    item.sourceShippingCost !== undefined ||
    item.shippingOptionId !== undefined ||
    item.shippingOptionDTag !== undefined ||
    (item.shippingCountries?.length ?? 0) > 0 ||
    (item.shippingCountryRules?.length ?? 0) > 0
  ) {
    throw new Error(
      "Guest checkout smoke requires a digital fixture without shipping data."
    )
  }
  return item
}

function getGuestOrderCartItemFingerprint(item: CartItem): string {
  return JSON.stringify({
    commerce: getCartCommerceFingerprint([item]),
    selectedSpecifications: item.selectedSpecifications ?? null,
  })
}

function requireCurrentProductRead(meta: {
  source: string
  stale: boolean
  degraded: boolean
  capped?: boolean
}): void {
  if (
    meta.source !== "commerce" ||
    meta.stale ||
    meta.degraded ||
    meta.capped
  ) {
    throw new GuestCheckoutOrderSmokeInconclusive(
      "Guest checkout smoke requires current product data from a complete network read."
    )
  }
}

async function buildGuestOrderPricing(
  item: CartItem,
  getPricingRate: () => Promise<BtcUsdRateQuote>,
  nowMs: () => number
): Promise<ReadyCheckoutPricing> {
  let pricing = buildCheckoutPricingIntent([item], null, nowMs())
  if (pricing.status !== "ok") {
    const quote = await getPricingRate()
    pricing = buildCheckoutPricingIntent([item], quote, nowMs())
  }
  if (pricing.status !== "ok") {
    throw new Error(pricing.reason)
  }
  return pricing
}

export function buildGuestCheckoutOrderRumor(input: {
  orderId: string
  identity: GuestIdentity
  merchantPubkey: string
  pricing: ReadyCheckoutPricing
  rumorCreatedAt: number
}): NDKEvent {
  return buildCheckoutOrderRumor({
    orderId: input.orderId,
    merchantPubkey: input.merchantPubkey,
    buyerPubkey: input.identity.pubkey,
    buyerIdentityKind: "guest_ephemeral",
    pricing: input.pricing,
    guestContact: SMOKE_CONTACT,
    note: "Automated guest checkout smoke - do not fulfill.",
    createdAt: input.identity.createdAt,
    ndk: getNdk(),
    rumorCreatedAt: input.rumorCreatedAt,
  })
}

function hasRecoveredGuestOrder(
  conversations: readonly MerchantConversationSummary[],
  input: {
    orderId: string
    merchantPubkey: string
    buyerPubkey: string
    productAddress: string
    expectedPayload: unknown
  }
): boolean {
  const conversation = conversations.find(
    (candidate) => candidate.orderId === input.orderId
  )
  if (
    !conversation ||
    conversation.merchantPubkey !== input.merchantPubkey ||
    conversation.buyerPubkey !== input.buyerPubkey
  ) {
    return false
  }
  const order = conversation.messages?.find(
    (message) => message.type === "order" && message.orderId === input.orderId
  )
  return (
    order?.type === "order" &&
    order.payload.buyerIdentityKind === "guest_ephemeral" &&
    order.payload.merchantPubkey === input.merchantPubkey &&
    order.payload.buyerPubkey === input.buyerPubkey &&
    order.payload.items.some(
      (item) => item.productId === input.productAddress
    ) &&
    isDeepStrictEqual(order.payload, input.expectedPayload)
  )
}

async function recoverOrderAsMerchant(
  config: GuestCheckoutOrderSmokeConfig,
  input: { orderId: string; buyerPubkey: string; expectedPayload: unknown },
  dependencies: Required<
    Pick<
      GuestCheckoutOrderSmokeDependencies,
      "getMerchantOrders" | "nowMs" | "sleep"
    >
  >
): Promise<void> {
  const deadline = dependencies.nowMs() + config.recoveryTimeoutMs
  let lastError: unknown
  let sawCompleteRead = false
  let sawIncompleteRead = false
  do {
    try {
      const result = await dependencies.getMerchantOrders({
        principalPubkey: config.merchantPubkey,
        limit: 200,
      })
      const completeRead =
        result.meta.source === "commerce" &&
        !result.meta.stale &&
        !result.meta.degraded &&
        !result.meta.capped &&
        result.meta.inbox?.coverage === "complete"
      if (
        completeRead &&
        hasRecoveredGuestOrder(result.data, {
          ...input,
          merchantPubkey: config.merchantPubkey,
          productAddress: config.productAddress,
        })
      ) {
        return
      }
      if (completeRead) {
        sawCompleteRead = true
        lastError = new Error(
          "Merchant recovery did not observe the order in a complete inbox read."
        )
      } else {
        sawIncompleteRead = true
        lastError = new GuestCheckoutOrderSmokeInconclusive(
          "Merchant recovery requires a current complete inbox read."
        )
      }
    } catch (error) {
      lastError = error
    }
    await dependencies.sleep(config.recoveryPollMs)
  } while (dependencies.nowMs() < deadline)

  if (sawIncompleteRead && !sawCompleteRead) {
    throw new GuestCheckoutOrderSmokeInconclusive(
      "Merchant recovery exhausted incomplete inbox evidence.",
      { cause: lastError }
    )
  }
  throw new Error("Merchant did not recover the guest order before timeout.", {
    cause: lastError,
  })
}

export async function runGuestCheckoutOrderSmoke(
  config: GuestCheckoutOrderSmokeConfig,
  dependencies: GuestCheckoutOrderSmokeDependencies = {}
): Promise<{ status: "passed" }> {
  let connection: GuestCheckoutOrderSmokeMerchantSigner
  try {
    connection = dependencies.connectMerchantSigner
      ? await dependencies.connectMerchantSigner(config)
      : await connectMerchantNip46Signer(
          config,
          dependencies.restoreMerchantSigner
        )
  } catch (error) {
    throw stageFailure("merchant_signer", error)
  }

  let authorityCurrent = true
  let sessionSigner: SessionSigner | null = null
  let result: { status: "passed" } | null = null
  let primaryFailure: GuestCheckoutOrderSmokeFailure | null = null
  try {
    sessionSigner = new SessionSigner(connection.signer, {
      expectedPubkey: config.merchantPubkey,
      hasAuthority: () => authorityCurrent,
    })
    await (
      dependencies.preflightMerchantSigner ?? preflightMerchantNip46Signer
    )(sessionSigner, config)
    result = await runGuestCheckoutOrderSmokeWithMerchantSigner(
      config,
      sessionSigner,
      dependencies
    )
  } catch (error) {
    if (connection.interactiveAuthorizationRequired?.()) {
      const stage =
        error instanceof GuestCheckoutOrderSmokeFailure
          ? error.stage
          : "merchant_signer"
      primaryFailure = stageFailure(
        stage,
        new GuestCheckoutOrderSmokeInconclusive(
          "Guest checkout smoke remote signer requires interactive authorization."
        )
      )
    } else if (error instanceof GuestCheckoutOrderSmokeFailure) {
      primaryFailure = error
    } else {
      primaryFailure = stageFailure("merchant_signer", error)
    }
  }

  authorityCurrent = false
  let cleanupFailure: unknown
  try {
    sessionSigner?.invalidateLocal()
    connection.invalidate()
  } catch (error) {
    cleanupFailure = error
  }
  try {
    await closeMerchantSignerWithinTimeout(
      connection,
      dependencies.merchantSignerCloseTimeoutMs ??
        MERCHANT_SIGNER_CLOSE_TIMEOUT_MS
    )
  } catch (error) {
    cleanupFailure ??= error
  }

  if (primaryFailure) throw primaryFailure
  if (cleanupFailure) {
    throw new GuestCheckoutOrderSmokeFailure(
      "merchant_signer",
      "failed",
      cleanupFailure
    )
  }
  if (!result) {
    throw stageFailure(
      "merchant_signer",
      new Error("Guest checkout smoke completed without a result.")
    )
  }
  return result
}

async function runGuestCheckoutOrderSmokeWithMerchantSigner(
  config: GuestCheckoutOrderSmokeConfig,
  merchantSigner: SessionSigner,
  dependencies: GuestCheckoutOrderSmokeDependencies = {}
): Promise<{ status: "passed" }> {
  const getProduct = dependencies.getProduct ?? getAtomicProductDetail
  const createOrderId =
    dependencies.createOrderId ?? (() => `smoke-${crypto.randomUUID()}`)
  const createGuestIdentity =
    dependencies.createGuestIdentity ?? createGuestOrderSigningIdentity
  const publishOrder = dependencies.publishOrder ?? publishBuyerOrderMessage
  const getMerchantOrders =
    dependencies.getMerchantOrders ?? getMerchantConversationList
  const onRelayEvidence = dependencies.onRelayEvidence ?? (() => {})
  const nowMs = dependencies.nowMs ?? Date.now
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))

  let pricing: ReadyCheckoutPricing
  let productFingerprint: string
  try {
    const product = await getProduct({
      productId: config.productAddress,
      revalidateCanonical: true,
    })
    requireCurrentProductRead(product.meta)
    const item = requireGuestOrderCartItem(product.data, config)
    productFingerprint = getGuestOrderCartItemFingerprint(item)
    pricing = await buildGuestOrderPricing(
      item,
      dependencies.getPricingRate ?? fetchBtcUsdRate,
      nowMs
    )
  } catch (error) {
    throw stageFailure("product_read", error)
  }

  let orderId: string
  let identity: GuestIdentity
  let rumor: NDKEvent
  let expectedPayload: unknown
  try {
    orderId = createOrderId()
    identity = createGuestIdentity(orderId, config.merchantPubkey)
    rumor = buildGuestCheckoutOrderRumor({
      orderId,
      identity,
      merchantPubkey: config.merchantPubkey,
      pricing,
      rumorCreatedAt: nowMs(),
    })
    expectedPayload = JSON.parse(rumor.content)
  } catch (error) {
    throw stageFailure("order_build", error)
  }

  try {
    const product = await getProduct({
      productId: config.productAddress,
      revalidateCanonical: true,
    })
    requireCurrentProductRead(product.meta)
    const refreshedItem = requireGuestOrderCartItem(product.data, config)
    if (
      getGuestOrderCartItemFingerprint(refreshedItem) !== productFingerprint
    ) {
      throw new Error(
        "Guest checkout smoke product terms changed before publication."
      )
    }
    if (
      pricing.approximate &&
      !isPricingRateQuoteFresh(
        pricing.quote,
        nowMs(),
        CHECKOUT_QUOTE_MAX_AGE_MS
      )
    ) {
      throw new Error(
        "Guest checkout smoke pricing quote expired before publication."
      )
    }
  } catch (error) {
    throw stageFailure("product_read", error)
  }

  try {
    onRelayEvidence({
      ...UNAVAILABLE_GUEST_CHECKOUT_ORDER_RELAY_EVIDENCE,
    })
    const delivery = await publishOrder(
      rumor,
      getNdk(),
      config.merchantPubkey,
      identity
    )
    if (delivery.deliveryRoute !== "declared_inbox") {
      throw new Error(
        "Guest checkout smoke requires the merchant's declared inbox route."
      )
    }
    const relayDelivery = delivery.orderRelayDelivery?.relayDelivery
    if (relayDelivery) {
      const relayAcknowledgementCount = relayDelivery.filter(
        (target) => target.status === "acked"
      ).length
      const relayAttemptCount = Math.max(
        relayAcknowledgementCount,
        relayDelivery.reduce(
          (total, target) =>
            total + Math.max(0, Math.floor(target.attemptCount)),
          0
        )
      )
      onRelayEvidence({
        relayAttemptCount,
        relayAcknowledgementCount,
        relayObservation: "available",
      })
    }
  } catch (error) {
    throw stageFailure("order_publish", error)
  }

  const merchantSignerLease = setSigner(merchantSigner)
  const protectedReadSession = createProtectedReadSessionLifecycle()
  let merchantSignerAuthorityCurrent = true
  try {
    // This uses Merchant's production NIP-46 signer and protected-read adapters.
    // It proves remote protocol operations, not mobile approval or handoff UX.
    protectedReadSession.activate(
      createNdkNostrEventSigner(merchantSigner, config.merchantPubkey, "nip46"),
      config.merchantPubkey,
      () => merchantSignerAuthorityCurrent && getNdk().signer === merchantSigner
    )
    await recoverOrderAsMerchant(
      config,
      { orderId, buyerPubkey: identity.pubkey, expectedPayload },
      { getMerchantOrders, nowMs, sleep }
    )
  } catch (error) {
    throw stageFailure("merchant_recovery", error)
  } finally {
    merchantSignerAuthorityCurrent = false
    try {
      protectedReadSession.deactivate()
    } finally {
      removeSigner(merchantSignerLease)
    }
  }

  return { status: "passed" }
}

export function formatGuestCheckoutOrderSmokeFailure(error: unknown): string {
  return getGuestCheckoutOrderSmokeFailureEvidence(error).summary
}

export function getGuestCheckoutOrderSmokeFailureEvidence(
  error: unknown
): GuestCheckoutOrderSmokeFailureEvidence {
  const stage =
    error instanceof GuestCheckoutOrderSmokeFailure
      ? error.stage
      : "configuration"
  const status =
    error instanceof GuestCheckoutOrderSmokeFailure ? error.status : "failed"
  return {
    status,
    stage,
    summary: `Guest checkout order smoke ${status} at ${stage}.`,
  }
}

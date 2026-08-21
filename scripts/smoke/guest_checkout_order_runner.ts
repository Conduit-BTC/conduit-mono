import { isDeepStrictEqual } from "node:util"

import { NDKEvent, NDKPrivateKeySigner, nip19 } from "@nostr-dev-kit/ndk"
import { getPublicKey } from "nostr-tools"

import {
  createProtectedReadSessionLifecycle,
  fetchBtcUsdRate,
  getAtomicProductDetail,
  getMerchantConversationList,
  getNdk,
  getShippingOptionsDetailed as fetchShippingOptions,
  removeSigner,
  setSigner,
  type BtcUsdRateQuote,
  type CommerceProductRecord,
  type MerchantConversationSummary,
  type ParsedShippingOption,
} from "@conduit/core"
import { normalizePubkey } from "@conduit/core/utils"

import { createNdkNostrEventSigner } from "../../packages/core/src/protocol/ndk-nostr-event-signer"
import { createGuestOrderSigningIdentity } from "../../apps/market/src/lib/guest-order-identity"
import {
  buildCheckoutOrderRumor,
  type ReadyCheckoutPricing,
} from "../../apps/market/src/lib/checkout-order"
import { buildCheckoutPricingIntent } from "../../apps/market/src/lib/checkout-payment"
import {
  getCartShippingDestinationEligibility,
  hasPhysicalItemsMissingShippingSnapshot,
  hasPhysicalItemsMissingShippingZone,
} from "../../apps/market/src/lib/cart-shipping-options"
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
  return new GuestCheckoutOrderSmokeFailure(
    stage,
    error instanceof GuestCheckoutOrderSmokeInconclusive
      ? "inconclusive"
      : "failed",
    error
  )
}

type Environment = Record<string, string | undefined>

export type GuestCheckoutOrderSmokeConfig = {
  merchantPubkey: string
  productAddress: string
  merchantPrivateKey: Uint8Array
  shippingCountry: string
  shippingPostalCode: string
  recoveryTimeoutMs: number
  recoveryPollMs: number
}

type GuestIdentity = ReturnType<typeof createGuestOrderSigningIdentity>

export type GuestCheckoutOrderSmokeDependencies = {
  getProduct?: typeof getAtomicProductDetail
  getPricingRate?: () => Promise<BtcUsdRateQuote>
  getShippingOptions?: typeof fetchShippingOptions
  createOrderId?: () => string
  createGuestIdentity?: (
    orderId: string,
    merchantPubkey: string
  ) => GuestIdentity
  publishOrder?: typeof publishBuyerOrderMessage
  getMerchantOrders?: typeof getMerchantConversationList
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

function parseMerchantPrivateKey(raw: string): Uint8Array {
  try {
    const decoded = nip19.decode(raw)
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("Unexpected signer encoding.")
    }
    getPublicKey(decoded.data)
    return decoded.data
  } catch (error) {
    throw new Error("Guest checkout smoke merchant signer is invalid.", {
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
  env: Environment = process.env
): GuestCheckoutOrderSmokeConfig {
  try {
    const merchantPubkey = parsePubkey(
      env,
      "GUEST_CHECKOUT_SMOKE_MERCHANT_PUBKEY"
    )
    const merchantPrivateKey = parseMerchantPrivateKey(
      required(env, "GUEST_CHECKOUT_SMOKE_MERCHANT_NSEC")
    )
    if (getPublicKey(merchantPrivateKey) !== merchantPubkey) {
      throw new Error(
        "Guest checkout smoke merchant signer does not match the configured merchant."
      )
    }

    const shippingCountry =
      env.GUEST_CHECKOUT_SMOKE_SHIPPING_COUNTRY?.trim().toUpperCase() || "US"
    if (!/^[A-Z]{2}$/.test(shippingCountry)) {
      throw new Error(
        "GUEST_CHECKOUT_SMOKE_SHIPPING_COUNTRY must be an ISO country code."
      )
    }
    const shippingPostalCode =
      env.GUEST_CHECKOUT_SMOKE_SHIPPING_POSTAL_CODE?.trim() || "00000"
    if (!shippingPostalCode || shippingPostalCode.length > 32) {
      throw new Error("GUEST_CHECKOUT_SMOKE_SHIPPING_POSTAL_CODE is invalid.")
    }

    return {
      merchantPubkey,
      productAddress: parseProductAddress(
        required(env, "GUEST_CHECKOUT_SMOKE_PRODUCT_ADDRESS"),
        merchantPubkey
      ),
      merchantPrivateKey,
      shippingCountry,
      shippingPostalCode,
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

  return {
    ...createCartItemFromProduct(product),
    productId: config.productAddress,
    quantity: 1,
  }
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
  config: GuestCheckoutOrderSmokeConfig,
  getPricingRate: () => Promise<BtcUsdRateQuote>,
  getShippingOptions: typeof fetchShippingOptions,
  nowMs: () => number
): Promise<ReadyCheckoutPricing> {
  let merchantShippingOptions: ParsedShippingOption[] = []
  const requiresMerchantShippingOptions =
    item.format !== "digital" &&
    hasPhysicalItemsMissingShippingSnapshot([item]) &&
    !hasPhysicalItemsMissingShippingZone([item])
  if (requiresMerchantShippingOptions) {
    try {
      const shippingOptionsRead = await getShippingOptions(
        config.merchantPubkey,
        { strict: true }
      )
      if (shippingOptionsRead.coverage !== "complete") {
        throw new GuestCheckoutOrderSmokeInconclusive(
          "Guest checkout smoke requires complete merchant shipping option evidence."
        )
      }
      merchantShippingOptions = shippingOptionsRead.options.filter(
        (option) =>
          option.pubkey === config.merchantPubkey &&
          (!item.shippingOptionId || option.id === item.shippingOptionId) &&
          (!item.shippingOptionDTag || option.dTag === item.shippingOptionDTag)
      )
      if (
        (!item.shippingOptionId && !item.shippingOptionDTag) ||
        merchantShippingOptions.length !== 1
      ) {
        throw new GuestCheckoutOrderSmokeInconclusive(
          "Guest checkout smoke requires one exact merchant shipping option."
        )
      }
    } catch (error) {
      if (error instanceof GuestCheckoutOrderSmokeInconclusive) throw error
      throw new GuestCheckoutOrderSmokeInconclusive(
        "Guest checkout smoke could not read the merchant shipping options.",
        { cause: error }
      )
    }
  }

  const destinationEligibility = getCartShippingDestinationEligibility(
    {
      country: config.shippingCountry,
      postalCode: config.shippingPostalCode,
    },
    [item],
    merchantShippingOptions
  )
  if (destinationEligibility.eligible !== true) {
    if (
      destinationEligibility.eligible === null &&
      requiresMerchantShippingOptions
    ) {
      throw new GuestCheckoutOrderSmokeInconclusive(
        "Guest checkout smoke requires current shipping eligibility evidence."
      )
    }
    throw new Error(
      `Guest checkout smoke shipping destination is not eligible: ${destinationEligibility.reason}.`
    )
  }

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
  shippingCountry: string
  shippingPostalCode: string
  rumorCreatedAt: number
}): NDKEvent {
  const hasPhysicalItem = input.pricing.items.some(
    (item) => item.format === "physical"
  )
  return buildCheckoutOrderRumor({
    orderId: input.orderId,
    merchantPubkey: input.merchantPubkey,
    buyerPubkey: input.identity.pubkey,
    buyerIdentityKind: "guest_ephemeral",
    pricing: input.pricing,
    ...(hasPhysicalItem
      ? {
          shippingAddress: {
            name: "Guest Checkout Smoke",
            street: "Automated test order - do not fulfill",
            city: "Test",
            postalCode: input.shippingPostalCode,
            country: input.shippingCountry,
          },
        }
      : {}),
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
    const product = await getProduct({ productId: config.productAddress })
    requireCurrentProductRead(product.meta)
    const item = requireGuestOrderCartItem(product.data, config)
    productFingerprint = getGuestOrderCartItemFingerprint(item)
    pricing = await buildGuestOrderPricing(
      item,
      config,
      dependencies.getPricingRate ?? fetchBtcUsdRate,
      dependencies.getShippingOptions ?? fetchShippingOptions,
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
      shippingCountry: config.shippingCountry,
      shippingPostalCode: config.shippingPostalCode,
      rumorCreatedAt: nowMs(),
    })
    expectedPayload = JSON.parse(rumor.content)
  } catch (error) {
    throw stageFailure("order_build", error)
  }

  try {
    const product = await getProduct({ productId: config.productAddress })
    requireCurrentProductRead(product.meta)
    const refreshedItem = requireGuestOrderCartItem(product.data, config)
    if (
      getGuestOrderCartItemFingerprint(refreshedItem) !== productFingerprint
    ) {
      throw new Error(
        "Guest checkout smoke product terms changed before publication."
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

  const merchantSigner = new NDKPrivateKeySigner(
    nip19.nsecEncode(config.merchantPrivateKey)
  )
  const merchantSignerLease = setSigner(merchantSigner)
  const protectedReadSession = createProtectedReadSessionLifecycle()
  let merchantSignerAuthorityCurrent = true
  try {
    // This headless adapter exercises the same NIP-07-shaped signEvent boundary
    // as Merchant with real cryptography. It is not extension approval or UX
    // evidence, and it does not claim NIP-46 mobile-wallet coverage.
    protectedReadSession.activate(
      createNdkNostrEventSigner(merchantSigner, config.merchantPubkey, "nip07"),
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

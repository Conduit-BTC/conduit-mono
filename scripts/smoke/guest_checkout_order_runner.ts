import { NDKEvent, NDKPrivateKeySigner, nip19 } from "@nostr-dev-kit/ndk"
import { getPublicKey } from "nostr-tools"

import {
  createProtectedReadSessionLifecycle,
  fetchBtcUsdRate,
  getAtomicProductDetail,
  getMerchantConversationList,
  getNdk,
  removeSigner,
  setSigner,
  type BtcUsdRateQuote,
  type CommerceProductRecord,
  type MerchantConversationSummary,
} from "@conduit/core"
import { normalizePubkey } from "@conduit/core/utils"

import { createNdkNostrEventSigner } from "../../packages/core/src/protocol/ndk-nostr-event-signer"
import { createGuestOrderSigningIdentity } from "../../apps/market/src/lib/guest-order-identity"
import {
  buildCheckoutOrderRumor,
  type ReadyCheckoutPricing,
} from "../../apps/market/src/lib/checkout-order"
import { buildCheckoutPricingIntent } from "../../apps/market/src/lib/checkout-payment"
import { getCartShippingDestinationEligibility } from "../../apps/market/src/lib/cart-shipping-options"
import { createCartItemFromProduct } from "../../apps/market/src/lib/cart-model"
import { publishBuyerOrderMessage } from "../../apps/market/src/lib/order-publish"

const DEFAULT_RECOVERY_TIMEOUT_MS = 90_000
const DEFAULT_RECOVERY_POLL_MS = 2_000
const MAX_RECOVERY_TIMEOUT_MS = 180_000
const SMOKE_CONTACT = {
  email: "guest-order-smoke@example.invalid",
  phone: "+1555010100",
}

export type GuestCheckoutOrderSmokeStage =
  | "configuration"
  | "product_read"
  | "order_build"
  | "order_publish"
  | "merchant_recovery"

export type GuestCheckoutOrderSmokeStatus = "passed" | "failed" | "inconclusive"

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
  createOrderId?: () => string
  createGuestIdentity?: (
    orderId: string,
    merchantPubkey: string
  ) => GuestIdentity
  publishOrder?: typeof publishBuyerOrderMessage
  getMerchantOrders?: typeof getMerchantConversationList
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

async function buildGuestOrderPricing(
  record: CommerceProductRecord | null,
  config: GuestCheckoutOrderSmokeConfig,
  getPricingRate: () => Promise<BtcUsdRateQuote>,
  nowMs: number
): Promise<ReadyCheckoutPricing> {
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

  const item = {
    ...createCartItemFromProduct(product),
    productId: config.productAddress,
    selectedSpecifications: undefined,
    quantity: 1,
  }

  const destinationEligibility = getCartShippingDestinationEligibility(
    {
      country: config.shippingCountry,
      postalCode: config.shippingPostalCode,
    },
    [item],
    []
  )
  if (destinationEligibility.eligible !== true) {
    throw new Error(
      `Guest checkout smoke shipping destination is not eligible: ${destinationEligibility.reason}.`
    )
  }

  let pricing = buildCheckoutPricingIntent([item], null, nowMs)
  if (pricing.status !== "ok") {
    pricing = buildCheckoutPricingIntent([item], await getPricingRate(), nowMs)
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
  createdAt: number
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
    createdAt: input.createdAt,
    ndk: getNdk(),
    rumorCreatedAt: input.createdAt,
  })
}

function hasRecoveredGuestOrder(
  conversations: readonly MerchantConversationSummary[],
  input: {
    orderId: string
    merchantPubkey: string
    buyerPubkey: string
    productAddress: string
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
    order.payload.items.some((item) => item.productId === input.productAddress)
  )
}

async function recoverOrderAsMerchant(
  config: GuestCheckoutOrderSmokeConfig,
  input: { orderId: string; buyerPubkey: string },
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
  const nowMs = dependencies.nowMs ?? Date.now
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))

  let pricing: ReadyCheckoutPricing
  try {
    const product = await getProduct({ productId: config.productAddress })
    if (
      product.meta.source !== "commerce" ||
      product.meta.stale ||
      product.meta.degraded ||
      product.meta.capped
    ) {
      throw new GuestCheckoutOrderSmokeInconclusive(
        "Guest checkout smoke requires current product data from a complete network read."
      )
    }
    pricing = await buildGuestOrderPricing(
      product.data,
      config,
      dependencies.getPricingRate ?? fetchBtcUsdRate,
      nowMs()
    )
  } catch (error) {
    throw stageFailure("product_read", error)
  }

  const orderId = createOrderId()
  const identity = createGuestIdentity(orderId, config.merchantPubkey)
  let rumor: NDKEvent
  try {
    rumor = buildGuestCheckoutOrderRumor({
      orderId,
      identity,
      merchantPubkey: config.merchantPubkey,
      pricing,
      shippingCountry: config.shippingCountry,
      shippingPostalCode: config.shippingPostalCode,
      createdAt: nowMs(),
    })
  } catch (error) {
    throw stageFailure("order_build", error)
  }

  try {
    await publishOrder(rumor, getNdk(), config.merchantPubkey, identity)
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
      { orderId, buyerPubkey: identity.pubkey },
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

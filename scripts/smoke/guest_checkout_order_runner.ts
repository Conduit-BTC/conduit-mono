import { NDKEvent, NDKPrivateKeySigner, nip19 } from "@nostr-dev-kit/ndk"
import { getPublicKey } from "nostr-tools"

import {
  EVENT_KINDS,
  appendConduitClientTag,
  getMerchantConversationList,
  getNdk,
  getProductDetail,
  orderSchema,
  removeSigner,
  setSigner,
  type CommerceProductRecord,
  type MerchantConversationSummary,
} from "@conduit/core"
import { normalizePubkey } from "@conduit/core/utils"

import { createGuestOrderSigningIdentity } from "../../apps/market/src/lib/guest-order-identity"
import { publishBuyerOrderMessage } from "../../apps/market/src/lib/order-publish"

const DEFAULT_RECOVERY_TIMEOUT_MS = 90_000
const DEFAULT_RECOVERY_POLL_MS = 2_000
const MAX_RECOVERY_TIMEOUT_MS = 180_000
const SMOKE_CONTACT = {
  email: "guest-order-smoke@example.invalid",
  phone: "+1555010100",
}

type GuestCheckoutOrderSmokeStage =
  | "configuration"
  | "product_read"
  | "order_build"
  | "order_publish"
  | "merchant_recovery"

class GuestCheckoutOrderSmokeFailure extends Error {
  override name = "GuestCheckoutOrderSmokeFailure"

  constructor(
    readonly stage: GuestCheckoutOrderSmokeStage,
    cause: unknown
  ) {
    super(`Guest checkout order smoke failed at ${stage}.`, { cause })
  }
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

type GuestOrderPricing = {
  itemSubtotalSats: number
  shippingCostSats: number
  totalSats: number
  shippingCostStatus: "not_required" | "priced" | "manual"
  items: Array<{
    productAddress: string
    title: string
    format: "physical" | "digital"
    quantity: number
    unitPriceSats: number
    unitShippingSats: number
    shippingOptionId?: string
    shippingOptionDTag?: string
    shippingCountries: string[]
    shippingCountryRules: Array<{
      code: string
      name: string
      restrictTo: string[]
      exclude: string[]
    }>
  }>
}

export type GuestCheckoutOrderSmokeDependencies = {
  getProduct?: typeof getProductDetail
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

    const shippingCountry = (env.GUEST_CHECKOUT_SMOKE_SHIPPING_COUNTRY ?? "US")
      .trim()
      .toUpperCase()
    if (!/^[A-Z]{2}$/.test(shippingCountry)) {
      throw new Error(
        "GUEST_CHECKOUT_SMOKE_SHIPPING_COUNTRY must be an ISO country code."
      )
    }
    const shippingPostalCode = (
      env.GUEST_CHECKOUT_SMOKE_SHIPPING_POSTAL_CODE ?? "00000"
    ).trim()
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
    throw new GuestCheckoutOrderSmokeFailure("configuration", error)
  }
}

function buildGuestOrderPricing(
  record: CommerceProductRecord | null,
  config: GuestCheckoutOrderSmokeConfig
): GuestOrderPricing {
  if (
    !record ||
    record.addressId !== config.productAddress ||
    record.product.pubkey !== config.merchantPubkey
  ) {
    throw new Error("Guest checkout smoke product could not be verified.")
  }
  const product = record.product
  const unitPriceSats =
    Number.isSafeInteger(product.priceSats) && (product.priceSats ?? 0) > 0
      ? product.priceSats!
      : product.currency.toUpperCase() === "SATS" &&
          Number.isSafeInteger(product.price) &&
          product.price > 0
        ? product.price
        : null
  if (unitPriceSats === null || product.stock === 0) {
    throw new Error("Guest checkout smoke product is not orderable in sats.")
  }
  const unitShippingSats =
    product.format === "physical" &&
    Number.isSafeInteger(product.shippingCostSats) &&
    (product.shippingCostSats ?? -1) >= 0
      ? product.shippingCostSats!
      : 0
  const rules = (product.shippingCountryRules ?? []).map((rule) => ({
    code: rule.code,
    name: rule.name,
    restrictTo: [...rule.restrictTo],
    exclude: [...rule.exclude],
  }))
  return {
    itemSubtotalSats: unitPriceSats,
    shippingCostSats: unitShippingSats,
    totalSats: unitPriceSats + unitShippingSats,
    shippingCostStatus:
      product.format === "digital"
        ? "not_required"
        : product.shippingCostSats === undefined
          ? "manual"
          : "priced",
    items: [
      {
        productAddress: config.productAddress,
        title: product.title,
        format: product.format,
        quantity: 1,
        unitPriceSats,
        unitShippingSats,
        ...(product.shippingOptionId
          ? { shippingOptionId: product.shippingOptionId }
          : {}),
        ...(product.shippingOptionDTag
          ? { shippingOptionDTag: product.shippingOptionDTag }
          : {}),
        shippingCountries: [...(product.shippingCountries ?? [])],
        shippingCountryRules: rules,
      },
    ],
  }
}

function buildOrderItems(pricing: GuestOrderPricing) {
  return pricing.items.map((line) => ({
    productId: line.productAddress,
    title: line.title,
    format: line.format,
    quantity: line.quantity,
    priceAtPurchase: line.unitPriceSats,
    currency: "SATS",
    shippingCostSats: line.unitShippingSats,
    ...(line.shippingOptionId
      ? { shippingOptionId: line.shippingOptionId }
      : {}),
    ...(line.shippingOptionDTag
      ? { shippingOptionDTag: line.shippingOptionDTag }
      : {}),
    shippingCountries: line.shippingCountries,
    shippingCountryRules: line.shippingCountryRules,
  }))
}

export function buildGuestCheckoutOrderRumor(input: {
  orderId: string
  identity: GuestIdentity
  merchantPubkey: string
  pricing: GuestOrderPricing
  shippingCountry: string
  shippingPostalCode: string
  createdAt: number
}): NDKEvent {
  const hasPhysicalItem = input.pricing.items.some(
    (item) => item.format === "physical"
  )
  const payload = orderSchema.parse({
    id: input.orderId,
    merchantPubkey: input.merchantPubkey,
    buyerPubkey: input.identity.pubkey,
    buyerIdentityKind: "guest_ephemeral",
    items: buildOrderItems(input.pricing),
    subtotal: input.pricing.totalSats,
    currency: "SATS",
    shippingCostSats: input.pricing.shippingCostSats,
    shippingCostStatus: input.pricing.shippingCostStatus,
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
  })

  const rumor = new NDKEvent(getNdk())
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = Math.floor(input.createdAt / 1_000)
  rumor.tags = appendConduitClientTag(
    [
      ["p", input.merchantPubkey],
      ["type", "order"],
      ["order", input.orderId],
      ["amount", String(input.pricing.totalSats)],
      ["currency", "SATS"],
      ...input.pricing.items.flatMap((item) => [
        ["item", item.productAddress, String(item.quantity)],
        ...(item.shippingOptionId ? [["shipping", item.shippingOptionId]] : []),
      ]),
    ],
    "market"
  )
  rumor.content = JSON.stringify(payload)
  return rumor
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
  do {
    try {
      const result = await dependencies.getMerchantOrders({
        principalPubkey: config.merchantPubkey,
        limit: 200,
      })
      if (
        hasRecoveredGuestOrder(result.data, {
          ...input,
          merchantPubkey: config.merchantPubkey,
          productAddress: config.productAddress,
        })
      ) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await dependencies.sleep(config.recoveryPollMs)
  } while (dependencies.nowMs() < deadline)

  throw new Error("Merchant did not recover the guest order before timeout.", {
    cause: lastError,
  })
}

export async function runGuestCheckoutOrderSmoke(
  config: GuestCheckoutOrderSmokeConfig,
  dependencies: GuestCheckoutOrderSmokeDependencies = {}
): Promise<{ status: "passed" }> {
  const getProduct = dependencies.getProduct ?? getProductDetail
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

  let pricing: GuestOrderPricing
  try {
    const product = await getProduct({
      productId: config.productAddress,
      revalidateCanonical: true,
    })
    pricing = buildGuestOrderPricing(product.data, config)
  } catch (error) {
    throw new GuestCheckoutOrderSmokeFailure("product_read", error)
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
    throw new GuestCheckoutOrderSmokeFailure("order_build", error)
  }

  try {
    await publishOrder(rumor, getNdk(), config.merchantPubkey, identity)
  } catch (error) {
    throw new GuestCheckoutOrderSmokeFailure("order_publish", error)
  }

  const merchantSigner = new NDKPrivateKeySigner(
    nip19.nsecEncode(config.merchantPrivateKey)
  )
  setSigner(merchantSigner)
  try {
    await recoverOrderAsMerchant(
      config,
      { orderId, buyerPubkey: identity.pubkey },
      { getMerchantOrders, nowMs, sleep }
    )
  } catch (error) {
    throw new GuestCheckoutOrderSmokeFailure("merchant_recovery", error)
  } finally {
    removeSigner()
  }

  return { status: "passed" }
}

export function formatGuestCheckoutOrderSmokeFailure(error: unknown): string {
  const stage =
    error instanceof GuestCheckoutOrderSmokeFailure
      ? error.stage
      : "configuration"
  return `Guest checkout order smoke failed at ${stage}.`
}

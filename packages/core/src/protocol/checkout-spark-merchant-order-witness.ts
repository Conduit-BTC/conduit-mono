import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  orderPickupFulfillmentSchema,
  orderSchema,
  type OrderSchema,
} from "../schemas"
import { canonicalizeShippingCost, isSatsLikeCurrency } from "../pricing"
import { parseOrderMessageRumorEvent, type ParsedOrderMessage } from "./orders"
import { validateAddressConsistency } from "./address-validation"
import {
  getShippingDestinationEligibility,
  type ParsedShippingOption,
} from "./shipping"
import { resolveCheckoutSparkSignedShipping } from "./checkout-spark-shipping-evidence"
import {
  resolveCheckoutSparkSignedPickup,
  type CheckoutSparkSignedPickup,
} from "./checkout-spark-pickup-evidence"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  restoreCheckoutSparkSettledPlan,
  type CheckoutSparkSettledPlan,
} from "./checkout-spark-settled-router"

const HEX_64 = /^[0-9a-f]{64}$/
const CONTENT_DOMAIN = "conduit:checkout-spark-merchant-order-content:v1"

function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value)
}

function contentHash(content: string): string {
  return bytesToHex(
    sha256(new TextEncoder().encode(`${CONTENT_DOMAIN}\0${content}`))
  )
}

type OrderShippingSnapshot = Pick<
  OrderSchema["items"][number],
  | "shippingCostSats"
  | "sourceShippingCost"
  | "shippingOptionId"
  | "shippingOptionDTag"
  | "shippingCountries"
  | "shippingCountryRules"
>

type OrderPickupSnapshot = OrderShippingSnapshot &
  Pick<OrderSchema["items"][number], "fulfillment">

/** Compare the full public pickup snapshot with independently verified terms. */
export function matchesCheckoutSparkOrderPickupSnapshot(
  item: OrderPickupSnapshot,
  exactPickup: CheckoutSparkSignedPickup
): boolean {
  const actual = orderPickupFulfillmentSchema.safeParse(item.fulfillment)
  const expected = orderPickupFulfillmentSchema.safeParse(exactPickup)
  return (
    actual.success &&
    expected.success &&
    JSON.stringify(actual.data) === JSON.stringify(expected.data) &&
    item.shippingCostSats === exactPickup.costSats &&
    item.shippingOptionId === exactPickup.option.coordinate &&
    item.shippingOptionDTag ===
      exactPickup.option.coordinate.split(":").slice(2).join(":") &&
    item.sourceShippingCost?.amount === exactPickup.sourceCost.amount &&
    item.sourceShippingCost?.currency === exactPickup.sourceCost.currency &&
    item.sourceShippingCost?.normalizedCurrency ===
      exactPickup.sourceCost.normalizedCurrency &&
    item.shippingCountries?.length === 0 &&
    item.shippingCountryRules?.length === 0
  )
}

/** Compare only public fulfillment terms with an independently verified revision. */
export function matchesCheckoutSparkOrderShippingSnapshot(
  item: OrderShippingSnapshot,
  option: ParsedShippingOption
): boolean {
  const expected = canonicalizeShippingCost(option.price, option.currency)
  return (
    item.shippingCostSats === expected.shippingCostSats &&
    item.shippingOptionId === option.id &&
    item.shippingOptionDTag === option.dTag &&
    item.sourceShippingCost?.amount === expected.sourceShippingCost?.amount &&
    item.sourceShippingCost?.currency ===
      expected.sourceShippingCost?.currency &&
    item.sourceShippingCost?.normalizedCurrency ===
      expected.sourceShippingCost?.normalizedCurrency &&
    JSON.stringify(item.shippingCountries) ===
      JSON.stringify(option.countries) &&
    JSON.stringify(item.shippingCountryRules) ===
      JSON.stringify(option.countryRules)
  )
}

export interface CheckoutSparkMerchantOrderEvidence {
  readonly buyerPubkey: string
  readonly merchantPubkey: string
  readonly orderId: string
  readonly rumorId: string
  readonly contentHash: string
  readonly orderCreatedAt: number
  readonly commerceTotalSats: number
  readonly lines: readonly {
    readonly productCoordinate: string
    readonly quantity: number
    readonly unitMerchandiseSats: number
    readonly unitShippingSats: number
    readonly sourcePriceAmount?: number
    readonly sourcePriceCurrency?: string
    readonly shipping?: OrderShippingSnapshot
    readonly pickup?: OrderPickupSnapshot
  }[]
}

/** Persisted local binding only; no order body, buyer contact, or wallet data. */
export interface CheckoutSparkMerchantOrderWitness {
  readonly schemaVersion: 1
  readonly merchantPubkey: string
  readonly buyerPubkey: string
  readonly orderId: string
  readonly rumorId: string
  readonly contentHash: string
  readonly checkoutId: string
  readonly planDigest: string
}

/**
 * Read only a seal-authenticated NIP-59 rumor. The caller MUST first verify
 * the outer signature, exact recipient, seal signature, and seal/rumor author;
 * this helper additionally verifies the unsigned rumor's NIP-01 event hash.
 */
export function readCheckoutSparkMerchantOrderEvidence(
  rumor: NDKEvent
): CheckoutSparkMerchantOrderEvidence | null {
  try {
    if (
      !isHex64(rumor.id) ||
      rumor.id !== rumor.getEventHash() ||
      !isHex64(rumor.pubkey) ||
      rumor.sig !== undefined ||
      typeof rumor.created_at !== "number" ||
      !Number.isSafeInteger(rumor.created_at) ||
      rumor.created_at < 0
    ) {
      return null
    }
    const message = parseOrderMessageRumorEvent(rumor)
    if (
      message.type !== "order" ||
      message.checkoutPaymentRoute !== "spark_router_v1" ||
      message.senderPubkey !== rumor.pubkey ||
      !isHex64(message.recipientPubkey) ||
      message.payload.items.some(
        (item) =>
          item.familyProductId !== undefined ||
          item.selectedSpecifications !== undefined ||
          (item.format === "digital" &&
            (item.sourceShippingCost !== undefined ||
              item.shippingOptionDTag !== undefined ||
              item.shippingCountries !== undefined ||
              item.shippingCountryRules !== undefined))
      )
    ) {
      return null
    }
    // Validate private input now, then discard it. The later witness comparison
    // verifies these exact public country rules against the signed revision.
    const shippingItems = message.payload.items.filter(
      (item) => item.fulfillment?.type === "shipping"
    )
    if (shippingItems.length > 0) {
      const address = message.payload.shippingAddress
      if (
        !address ||
        !validateAddressConsistency(address).canDirectPay ||
        shippingItems.some(
          (item) =>
            item.fulfillment?.type !== "shipping" ||
            !item.shippingOptionId ||
            !item.shippingOptionDTag ||
            !item.sourceShippingCost ||
            !item.shippingCountries ||
            !item.shippingCountryRules ||
            getShippingDestinationEligibility(address, [
              { countryRules: item.shippingCountryRules },
            ]).eligible !== true
        )
      )
        return null
    }
    return {
      buyerPubkey: message.senderPubkey,
      merchantPubkey: message.recipientPubkey,
      orderId: message.orderId,
      rumorId: rumor.id,
      contentHash: contentHash(rumor.content),
      orderCreatedAt: message.payload.createdAt,
      commerceTotalSats: message.payload.subtotal,
      lines: message.payload.items.map((item) => ({
        productCoordinate: item.productId,
        quantity: item.quantity,
        unitMerchandiseSats: item.priceAtPurchase,
        unitShippingSats: item.shippingCostSats ?? 0,
        ...(item.fulfillment?.type === "shipping"
          ? {
              shipping: {
                shippingCostSats: item.shippingCostSats,
                sourceShippingCost: item.sourceShippingCost,
                shippingOptionId: item.shippingOptionId,
                shippingOptionDTag: item.shippingOptionDTag,
                shippingCountries: item.shippingCountries,
                shippingCountryRules: item.shippingCountryRules,
              },
            }
          : {}),
        ...(item.fulfillment?.type === "pickup"
          ? {
              pickup: {
                fulfillment: item.fulfillment,
                shippingCostSats: item.shippingCostSats,
                sourceShippingCost: item.sourceShippingCost,
                shippingOptionId: item.shippingOptionId,
                shippingOptionDTag: item.shippingOptionDTag,
                shippingCountries: item.shippingCountries,
                shippingCountryRules: item.shippingCountryRules,
              },
            }
          : {}),
        ...(item.sourcePrice
          ? {
              sourcePriceAmount: item.sourcePrice.amount,
              sourcePriceCurrency: item.sourcePrice.normalizedCurrency,
            }
          : {}),
      })),
    }
  } catch {
    return null
  }
}

/** Pair an authenticated buyer order with the exact frozen recovery plan. */
export function createCheckoutSparkMerchantOrderWitness(
  plan: CheckoutSparkSettledPlan,
  evidence: CheckoutSparkMerchantOrderEvidence,
  recoverySenderPubkey: string,
  sourceEvents?: readonly SignedPublicNostrEvent[]
): CheckoutSparkMerchantOrderWitness | null {
  try {
    const frozen = restoreCheckoutSparkSettledPlan(plan)
    const quote = frozen.commerceQuote
    const lines = new Map(
      quote.lines.map((line) => [line.productCoordinate, line])
    )
    if (
      !isHex64(evidence.buyerPubkey) ||
      evidence.buyerPubkey !== recoverySenderPubkey ||
      evidence.merchantPubkey !== frozen.merchantPubkey ||
      evidence.orderId !== frozen.orderId ||
      !isHex64(evidence.rumorId) ||
      !isHex64(evidence.contentHash) ||
      !Number.isSafeInteger(evidence.orderCreatedAt) ||
      evidence.orderCreatedAt < frozen.createdAt ||
      evidence.commerceTotalSats !== quote.commerceTotalSats ||
      evidence.lines.length !== quote.lines.length ||
      lines.size !== quote.lines.length ||
      new Set(evidence.lines.map((line) => line.productCoordinate)).size !==
        evidence.lines.length ||
      evidence.lines.some((item) => {
        const line = lines.get(item.productCoordinate)
        let fulfillmentMatches =
          !line?.shippingOption &&
          !line?.pickup &&
          item.shipping === undefined &&
          item.pickup === undefined
        if (line?.pickup && item.pickup && item.shipping === undefined) {
          const productEvent = sourceEvents?.find(
            (event) => event.id === line.productEventId
          )
          if (!productEvent || !sourceEvents) return true
          const pickup = resolveCheckoutSparkSignedPickup({
            productEvent,
            line,
            sourceEvents,
            acceptedAtMs: frozen.createdAt,
          })
          fulfillmentMatches =
            pickup !== undefined &&
            matchesCheckoutSparkOrderPickupSnapshot(item.pickup, pickup)
        } else if (
          line?.shippingOption &&
          !line.pickup &&
          item.shipping &&
          item.pickup === undefined
        ) {
          const productEvent = sourceEvents?.find(
            (event) => event.id === line.productEventId
          )
          if (!productEvent) return true
          const option = resolveCheckoutSparkSignedShipping({
            productEvent,
            line,
            shippingEvents: sourceEvents,
          })
          fulfillmentMatches =
            option !== undefined &&
            matchesCheckoutSparkOrderShippingSnapshot(item.shipping, option)
        }
        return (
          !line ||
          line.merchantPubkey !== frozen.merchantPubkey ||
          line.quantity !== item.quantity ||
          line.unitMerchandiseSats !== item.unitMerchandiseSats ||
          line.unitShippingSats !== item.unitShippingSats ||
          !fulfillmentMatches ||
          (item.sourcePriceAmount !== undefined &&
            (item.sourcePriceAmount !== line.unitMerchandiseSats ||
              !isSatsLikeCurrency(item.sourcePriceCurrency ?? "")))
        )
      })
    ) {
      return null
    }
    return {
      schemaVersion: 1,
      merchantPubkey: frozen.merchantPubkey,
      buyerPubkey: evidence.buyerPubkey,
      orderId: frozen.orderId,
      rumorId: evidence.rumorId,
      contentHash: evidence.contentHash,
      checkoutId: frozen.checkoutId,
      planDigest: frozen.planDigest,
    }
  } catch {
    return null
  }
}

/** Fail closed on malformed local records before projecting any paid state. */
export function restoreCheckoutSparkMerchantOrderWitness(
  witness: CheckoutSparkMerchantOrderWitness,
  plan?: CheckoutSparkSettledPlan
): CheckoutSparkMerchantOrderWitness {
  if (
    !witness ||
    typeof witness !== "object" ||
    Object.keys(witness).length !== 8 ||
    Object.keys(witness).some(
      (key) =>
        ![
          "schemaVersion",
          "merchantPubkey",
          "buyerPubkey",
          "orderId",
          "rumorId",
          "contentHash",
          "checkoutId",
          "planDigest",
        ].includes(key)
    ) ||
    witness.schemaVersion !== 1 ||
    !isHex64(witness.merchantPubkey) ||
    !isHex64(witness.buyerPubkey) ||
    !isHex64(witness.rumorId) ||
    !isHex64(witness.contentHash) ||
    !isHex64(witness.planDigest) ||
    typeof witness.orderId !== "string" ||
    !witness.orderId ||
    witness.orderId.length > 512 ||
    witness.orderId.trim() !== witness.orderId ||
    typeof witness.checkoutId !== "string" ||
    !witness.checkoutId ||
    witness.checkoutId.length > 512 ||
    witness.checkoutId.trim() !== witness.checkoutId
  ) {
    throw new Error("Checkout Spark order witness is invalid.")
  }
  if (plan) {
    const frozen = restoreCheckoutSparkSettledPlan(plan)
    if (
      witness.merchantPubkey !== frozen.merchantPubkey ||
      witness.orderId !== frozen.orderId ||
      witness.checkoutId !== frozen.checkoutId ||
      witness.planDigest !== frozen.planDigest
    ) {
      throw new Error("Checkout Spark order witness does not match plan.")
    }
  }
  return { ...witness }
}

/**
 * A generic cached conversation is not authority. This exact digest check only
 * attaches a previously authenticated witness to its matching displayed order.
 */
export function matchesCheckoutSparkMerchantOrderWitness(
  witness: CheckoutSparkMerchantOrderWitness,
  message: ParsedOrderMessage
): boolean {
  try {
    const exact = restoreCheckoutSparkMerchantOrderWitness(witness)
    if (
      message.type !== "order" ||
      message.checkoutPaymentRoute !== "spark_router_v1" ||
      message.id !== exact.rumorId ||
      message.orderId !== exact.orderId ||
      message.senderPubkey !== exact.buyerPubkey ||
      message.recipientPubkey !== exact.merchantPubkey ||
      contentHash(message.rawContent) !== exact.contentHash
    ) {
      return false
    }
    const parsed = orderSchema.parse(JSON.parse(message.rawContent) as unknown)
    return JSON.stringify(parsed) === JSON.stringify(message.payload)
  } catch {
    return false
  }
}

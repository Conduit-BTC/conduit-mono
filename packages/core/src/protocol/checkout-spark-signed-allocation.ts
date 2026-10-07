import type { Product } from "../types"
import type { CheckoutSparkCommerceQuote } from "./checkout-spark-reconciliation"
import type {
  CheckoutSparkCommerceObligationInput,
  CheckoutSparkOrganizerObligationInput,
} from "./checkout-spark-router-obligations"
import {
  allocateProductSupplierShares,
  parseProductSupplierAllocationTags,
} from "./product-supplier-allocation"
import { parseProductEvent } from "./products"
import { resolveCheckoutSparkSignedPickup } from "./checkout-spark-pickup-evidence"
import {
  assertCheckoutSparkCommerceShippingPolicies,
  resolveCheckoutSparkSignedShipping,
} from "./checkout-spark-shipping-evidence"
import type { SignedPublicNostrEvent } from "./signed-event"
import { assertCheckoutSparkCommerceProductPrice } from "./checkout-spark-commerce-pricing"

const EVENT_ID = /^[0-9a-f]{64}$/
const MAX_SAFE_SATS = BigInt(Number.MAX_SAFE_INTEGER)

function unavailable(): never {
  throw new Error(
    "Checkout Spark requires the exact signed product allocation evidence before funding."
  )
}

export type CheckoutSparkSignedCommerceObligation = Readonly<{
  kind: "merchant" | "supplier"
  recipientId: string
  amountSats: number
}>

interface SignedCommerceInput {
  quote: CheckoutSparkCommerceQuote
  products: readonly Product[]
  merchantPubkey: string
  shippingEvents?: readonly SignedPublicNostrEvent[]
  pickupSourceEvents?: readonly SignedPublicNostrEvent[]
  acceptedAtMs?: number
  organizer?: CheckoutSparkOrganizerObligationInput | null
}

/**
 * Bind a sat-denominated simple-product quote to each exact signed kind-30402
 * revision. An unmarked signed revision allocates its entire line to the
 * merchant; marked terms use the shared merchant-remainder rounding rule.
 * Canonical fixed shipping and legacy pickup go entirely to the merchant,
 * never suppliers. Pickup requires exact graph evidence and acceptance time.
 * Return only stable recipient identities and amounts: payout endpoints and
 * invoice proof remain independent later gates.
 */
export function deriveCheckoutSparkSignedCommerceObligations(
  input: SignedCommerceInput
): readonly CheckoutSparkSignedCommerceObligation[] {
  const { quote, products, merchantPubkey } = input
  if (
    !EVENT_ID.test(merchantPubkey) ||
    input.organizer != null ||
    products.length !== quote.lines.length ||
    quote.lines.length === 0 ||
    !Number.isSafeInteger(quote.commerceTotalSats) ||
    quote.commerceTotalSats <= 0
  ) {
    unavailable()
  }

  const byCoordinate = new Map(products.map((product) => [product.id, product]))
  if (byCoordinate.size !== quote.lines.length) unavailable()
  assertCheckoutSparkCommerceShippingPolicies(quote, input.acceptedAtMs)

  const expected = new Map<string, bigint>()
  const seenCoordinates = new Set<string>()
  let total = 0n
  const addShare = (
    kind: "merchant" | "supplier",
    pubkey: string,
    sats: bigint
  ) => {
    if (!EVENT_ID.test(pubkey) || sats <= 0n) unavailable()
    const key = `${kind}:${pubkey}`
    const aggregate = (expected.get(key) ?? 0n) + sats
    if (aggregate > MAX_SAFE_SATS) unavailable()
    expected.set(key, aggregate)
  }

  for (const line of quote.lines) {
    if (seenCoordinates.has(line.productCoordinate)) unavailable()
    seenCoordinates.add(line.productCoordinate)
    const product = byCoordinate.get(line.productCoordinate)
    const allocation = product?.supplierAllocation
    const event = allocation?.revisionEvent
    if (
      !product ||
      !allocation ||
      !event ||
      allocation.issues.length !== 0 ||
      allocation.revisionEventId !== line.productEventId ||
      allocation.revisionCreatedAt !== event.created_at ||
      event.id !== line.productEventId ||
      event.pubkey !== merchantPubkey ||
      event.kind !== 30_402 ||
      product.pubkey !== merchantPubkey ||
      product.sourceEventId !== line.productEventId ||
      product.updatedAt !== event.created_at * 1_000 ||
      line.merchantPubkey !== merchantPubkey ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      !Number.isSafeInteger(line.unitMerchandiseSats) ||
      line.unitMerchandiseSats <= 0
    ) {
      unavailable()
    }

    const dTags = event.tags.filter((tag) => tag[0] === "d")
    if (
      dTags.length !== 1 ||
      !dTags[0]?.[1] ||
      line.productCoordinate !== `30402:${merchantPubkey}:${dTags[0][1]}`
    ) {
      unavailable()
    }
    const signed = parseProductSupplierAllocationTags({
      tags: event.tags,
      merchantPubkey,
      signedRevisionEvent: event,
    })
    if (
      signed.state === "invalid" ||
      signed.state !== allocation.state ||
      signed.revisionEventId !== line.productEventId ||
      signed.revisionCreatedAt !== event.created_at ||
      signed.recipients.length !== allocation.recipients.length ||
      !signed.recipients.every((recipient, index) => {
        const projected = allocation.recipients[index]
        return (
          projected?.pubkey === recipient.pubkey &&
          projected.relayHint === recipient.relayHint &&
          projected.weight === recipient.weight &&
          projected.role === recipient.role
        )
      })
    ) {
      unavailable()
    }

    // Reparse the exact signed event rather than trusting a mutable Product
    // projection or quote line for the source economic amount. A retained
    // buyer-approved conversion fixes final sats, not exchange-rate authenticity.
    // Organizer fees still require separate signed admission.
    const signedProduct = parseProductEvent(event)
    if (
      signedProduct.id !== product.id ||
      signedProduct.priceEvidenceMalformed ||
      product.priceEvidenceMalformed ||
      product.currency !== signedProduct.currency ||
      signedProduct.price !== product.price ||
      signedProduct.priceSats !== product.priceSats ||
      JSON.stringify(signedProduct.sourcePrice) !==
        JSON.stringify(product.sourcePrice) ||
      product.format !== signedProduct.format ||
      product.type !== signedProduct.type ||
      product.parentProductId !== signedProduct.parentProductId ||
      JSON.stringify(product.specifications) !==
        JSON.stringify(signedProduct.specifications)
    ) {
      unavailable()
    }
    try {
      assertCheckoutSparkCommerceProductPrice({
        product: signedProduct,
        line,
        pricing: quote.pricing,
        acceptedAtMs: input.acceptedAtMs,
      })
      if (line.pickup !== undefined) {
        if (input.acceptedAtMs === undefined) unavailable()
        resolveCheckoutSparkSignedPickup({
          productEvent: event,
          line,
          sourceEvents: input.pickupSourceEvents ?? [],
          acceptedAtMs: input.acceptedAtMs,
        })
      } else {
        resolveCheckoutSparkSignedShipping({
          productEvent: event,
          line,
          shippingEvents: input.shippingEvents,
          pricing: quote.pricing,
          acceptedAtMs: input.acceptedAtMs,
        })
      }
    } catch {
      unavailable()
    }

    const lineSats = BigInt(line.quantity) * BigInt(line.unitMerchandiseSats)
    const shippingSats = line.shippingPolicy
      ? BigInt(line.shippingPolicy.allocatedCostSats)
      : BigInt(line.quantity) * BigInt(line.unitShippingSats)
    if (lineSats <= 0n || lineSats > MAX_SAFE_SATS) unavailable()
    total += lineSats + shippingSats
    if (total > MAX_SAFE_SATS) unavailable()
    if (shippingSats > 0n) addShare("merchant", merchantPubkey, shippingSats)

    if (signed.state === "absent") {
      addShare("merchant", merchantPubkey, lineSats)
      continue
    }

    // The shared helper floors each weighted share and gives the whole-sat
    // residue to the merchant. A zero-sat leg cannot have an exact invoice.
    const shares = allocateProductSupplierShares(Number(lineSats), signed)
    if (
      shares.filter((share) => share.role === "merchant").length !== 1 ||
      !shares.some((share) => share.role === "supplier")
    ) {
      unavailable()
    }
    for (const share of shares) {
      addShare(share.role, share.pubkey, BigInt(share.sats))
    }
  }

  if (total !== BigInt(quote.commerceTotalSats)) unavailable()
  if (!expected.has(`merchant:${merchantPubkey}`)) unavailable()
  return Object.freeze(
    [...expected.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, amountSats]) => {
        const kind = key.startsWith("merchant:") ? "merchant" : "supplier"
        return Object.freeze({
          kind,
          recipientId: key.slice(kind.length + 1),
          amountSats: Number(amountSats),
        })
      })
  )
}

/** Compare proposed payout legs with the exact signed weighted allocations. */
export function assertCheckoutSparkSignedCommerceAllocations(
  input: SignedCommerceInput & {
    commerce: readonly Pick<
      CheckoutSparkCommerceObligationInput,
      "kind" | "recipientId" | "amountSats"
    >[]
  }
): void {
  const expected = new Map<string, bigint>(
    deriveCheckoutSparkSignedCommerceObligations(input).map(
      (obligation) =>
        [
          `${obligation.kind}:${obligation.recipientId}`,
          BigInt(obligation.amountSats),
        ] as const
    )
  )
  const actual = new Set<string>()
  for (const obligation of input.commerce) {
    const key = `${obligation.kind}:${obligation.recipientId}`
    if (
      actual.has(key) ||
      !EVENT_ID.test(obligation.recipientId) ||
      !Number.isSafeInteger(obligation.amountSats) ||
      obligation.amountSats <= 0 ||
      expected.get(key) !== BigInt(obligation.amountSats)
    ) {
      unavailable()
    }
    actual.add(key)
  }
  if (
    actual.size !== expected.size ||
    !actual.has(`merchant:${input.merchantPubkey}`)
  ) {
    unavailable()
  }
}

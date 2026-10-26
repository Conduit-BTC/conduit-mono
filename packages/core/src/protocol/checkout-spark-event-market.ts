import { z } from "zod"
import type { CheckoutSparkCommerceQuote } from "./checkout-spark-reconciliation"
import { normalizeCheckoutSparkReceiverAddress } from "./checkout-spark-receiver-capability"
import { parseAddressableCoordinate } from "./event-market"
import { computeEventMarketAssignmentDTag } from "./event-market-assignment"
import {
  assertCurrentEventMarketOrganizerFeeTerms,
  calculateEventMarketOrganizerFeeSats,
  type EventMarketOrganizerFeeTerms,
} from "./event-market-organizer-fee"

const HEX_64 = /^[0-9a-f]{64}$/
const MAX_STOCK = 2_147_483_647
const MAX_SAFE_SATS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
const DIGEST_DOMAIN = "conduit:checkout-spark-event-market:v1"
const hashSchema = z.string().regex(HEX_64)
const satsSchema = z.number().int().safe().nonnegative().max(MAX_SAFE_SATS)
const quantitySchema = z.number().int().positive().max(MAX_STOCK)
const secondsSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .refine((value) => Number.isSafeInteger(value * 1_000))
const feeBindingShape = {
  marketCoordinate: z.string(),
  organizerPubkey: hashSchema,
  eventId: hashSchema,
  createdAt: secondsSchema,
}
const organizerFeeSchema = z.union([
  z
    .object({
      ...feeBindingShape,
      state: z.enum(["absent", "disabled", "revoked"]),
    })
    .strict(),
  z
    .object({
      ...feeBindingShape,
      state: z.literal("active"),
      basisPoints: z.number().int().safe().nonnegative(),
      minimumSats: satsSchema,
      lightningAddress: z.string(),
      expiresAt: secondsSchema.optional(),
    })
    .strict(),
])
const bindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    organizerPubkey: hashSchema,
    marketCoordinate: z.string(),
    marketEventId: hashSchema,
    occurrenceCoordinate: z.string(),
    occurrenceEventId: hashSchema,
    schedule: z
      .object({ coordinate: z.string(), eventId: hashSchema })
      .strict()
      .optional(),
    grantEventId: hashSchema,
    grantAncestryEventIds: z.array(hashSchema).min(1).max(128),
    observedDeletionEventIds: z.array(hashSchema).max(128),
    mode: z.enum(["merchant_present", "organizer_handoff"]),
    assignment: z
      .string()
      .refine(
        (value) =>
          value.length > 0 &&
          value.trim() === value &&
          new TextEncoder().encode(value).length <= 120 &&
          !/\p{Cc}/u.test(value)
      ),
    lines: z
      .array(
        z
          .object({
            productCoordinate: z.string(),
            productEventId: hashSchema,
            assignmentCoordinate: z.string(),
            assignmentEventId: hashSchema,
            quantity: quantitySchema,
            stockPoolId: hashSchema.optional(),
            parentProduct: z
              .object({ coordinate: z.string(), eventId: hashSchema })
              .strict()
              .optional(),
          })
          .strict()
      )
      .min(1),
    organizerFee: organizerFeeSchema,
    organizerFeeSats: satsSchema,
  })
  .strict()

// Only the already-validated quote's economic facts are needed here. Signed
// source, variation and rate validation remain the commerce boundary's job.
const quoteEconomicsSchema = z.object({
  commerceTotalSats: satsSchema,
  lines: z
    .array(
      z.object({
        productCoordinate: z.string(),
        productEventId: hashSchema,
        merchantPubkey: hashSchema,
        quantity: quantitySchema,
        unitMerchandiseSats: satsSchema,
        unitShippingSats: satsSchema,
        shippingPolicy: z.object({ allocatedCostSats: satsSchema }).optional(),
        variation: z
          .object({ familyCoordinate: z.string().optional() })
          .optional(),
      })
    )
    .min(1),
})

export interface CheckoutSparkEventMarketBinding {
  readonly schemaVersion: 1
  readonly organizerPubkey: string
  readonly marketCoordinate: string
  readonly marketEventId: string
  readonly occurrenceCoordinate: string
  readonly occurrenceEventId: string
  readonly schedule?: { readonly coordinate: string; readonly eventId: string }
  readonly grantEventId: string
  readonly grantAncestryEventIds: readonly string[]
  readonly observedDeletionEventIds: readonly string[]
  readonly mode: "merchant_present" | "organizer_handoff"
  readonly assignment: string
  readonly lines: readonly {
    readonly productCoordinate: string
    readonly productEventId: string
    readonly assignmentCoordinate: string
    readonly assignmentEventId: string
    readonly quantity: number
    readonly stockPoolId?: string
    readonly parentProduct?: {
      readonly coordinate: string
      readonly eventId: string
    }
  }[]
  readonly organizerFee: EventMarketOrganizerFeeTerms
  readonly organizerFeeSats: number
}

function invalid(): never {
  throw new Error("Event Market checkout binding is invalid.")
}

function assertCoordinate(
  value: string,
  kinds: readonly number[],
  author: string
): void {
  const coordinate = parseAddressableCoordinate(value, kinds)
  if (
    !coordinate ||
    coordinate.coordinate !== value ||
    coordinate.authorPubkey !== author
  )
    invalid()
}

function compareLines(
  a: { productCoordinate: string },
  b: { productCoordinate: string }
): number {
  return a.productCoordinate < b.productCoordinate
    ? -1
    : a.productCoordinate > b.productCoordinate
      ? 1
      : 0
}

/**
 * Freeze the exact shape and economics of one Event Market checkout. These
 * references are not signature, roster, stock-writer or fulfillment authority;
 * admission must independently verify the exact retained signed sources.
 */
export function freezeCheckoutSparkEventMarketBinding(
  input: unknown,
  context: {
    merchantPubkey: string
    commerceQuote: CheckoutSparkCommerceQuote
    acceptedAtMs: number
  }
): CheckoutSparkEventMarketBinding {
  const parsed = bindingSchema.safeParse(input)
  const quote = quoteEconomicsSchema.safeParse(context.commerceQuote)
  if (
    !parsed.success ||
    !quote.success ||
    !HEX_64.test(context.merchantPubkey) ||
    !Number.isSafeInteger(context.acceptedAtMs) ||
    context.acceptedAtMs < 0
  )
    return invalid()
  const binding = parsed.data
  const { merchantPubkey } = context
  if (
    !binding.grantAncestryEventIds.includes(binding.grantEventId) ||
    new Set(binding.grantAncestryEventIds).size !==
      binding.grantAncestryEventIds.length ||
    new Set(binding.observedDeletionEventIds).size !==
      binding.observedDeletionEventIds.length
  )
    invalid()
  assertCoordinate(binding.marketCoordinate, [30_409], binding.organizerPubkey)
  assertCoordinate(
    binding.occurrenceCoordinate,
    [31_922, 31_923],
    binding.organizerPubkey
  )
  if (binding.schedule)
    assertCoordinate(
      binding.schedule.coordinate,
      [31_924],
      binding.organizerPubkey
    )
  if (
    binding.mode === "organizer_handoff" &&
    binding.organizerPubkey === merchantPubkey
  )
    invalid()

  const products = new Set<string>()
  const assignments = new Set<string>()
  const pools = new Set<string>()
  for (const line of binding.lines) {
    assertCoordinate(line.productCoordinate, [30_402], merchantPubkey)
    assertCoordinate(line.assignmentCoordinate, [30_410], merchantPubkey)
    if (line.parentProduct)
      assertCoordinate(line.parentProduct.coordinate, [30_402], merchantPubkey)
    const dTag = computeEventMarketAssignmentDTag({
      marketCoordinate: binding.marketCoordinate,
      occurrenceCoordinate: binding.occurrenceCoordinate,
      productCoordinate: line.productCoordinate,
    })
    if (
      line.assignmentCoordinate !== `30410:${merchantPubkey}:${dTag}` ||
      products.has(line.productCoordinate) ||
      assignments.has(line.assignmentCoordinate) ||
      (binding.mode === "organizer_handoff"
        ? !line.stockPoolId || pools.has(line.stockPoolId)
        : line.stockPoolId !== undefined)
    )
      invalid()
    products.add(line.productCoordinate)
    assignments.add(line.assignmentCoordinate)
    if (line.stockPoolId) pools.add(line.stockPoolId)
  }

  const quoteProducts = new Set<string>()
  let commerceTotal = 0n
  if (quote.data.lines.length !== binding.lines.length) invalid()
  for (const line of quote.data.lines) {
    const bound = binding.lines.find(
      (candidate) => candidate.productCoordinate === line.productCoordinate
    )
    if (
      !bound ||
      quoteProducts.has(line.productCoordinate) ||
      line.merchantPubkey !== merchantPubkey ||
      line.productEventId !== bound.productEventId ||
      line.quantity !== bound.quantity ||
      line.variation?.familyCoordinate !== bound.parentProduct?.coordinate ||
      bound.parentProduct?.coordinate === line.productCoordinate
    )
      invalid()
    quoteProducts.add(line.productCoordinate)
    commerceTotal +=
      BigInt(line.quantity) * BigInt(line.unitMerchandiseSats) +
      (line.shippingPolicy
        ? BigInt(line.shippingPolicy.allocatedCostSats)
        : BigInt(line.quantity) * BigInt(line.unitShippingSats))
  }
  if (commerceTotal !== BigInt(quote.data.commerceTotalSats)) invalid()

  const fee = binding.organizerFee
  if (
    fee.marketCoordinate !== binding.marketCoordinate ||
    fee.organizerPubkey !== binding.organizerPubkey ||
    fee.eventId !== binding.marketEventId
  )
    invalid()
  assertCurrentEventMarketOrganizerFeeTerms(fee, context.acceptedAtMs)
  let expectedFee = 0
  if (fee.state === "active") {
    if (
      (fee.basisPoints === 0 && fee.minimumSats === 0) ||
      normalizeCheckoutSparkReceiverAddress(fee.lightningAddress) !==
        fee.lightningAddress ||
      (fee.expiresAt !== undefined && fee.expiresAt <= fee.createdAt)
    )
      invalid()
    expectedFee = calculateEventMarketOrganizerFeeSats({
      commerceTotalSats: quote.data.commerceTotalSats,
      basisPoints: fee.basisPoints,
      minimumSats: fee.minimumSats,
    })
  }
  if (binding.organizerFeeSats !== expectedFee) invalid()

  return Object.freeze({
    ...binding,
    ...(binding.schedule ? { schedule: Object.freeze(binding.schedule) } : {}),
    grantAncestryEventIds: Object.freeze(binding.grantAncestryEventIds.sort()),
    observedDeletionEventIds: Object.freeze(
      binding.observedDeletionEventIds.sort()
    ),
    lines: Object.freeze(
      binding.lines.sort(compareLines).map((line) =>
        Object.freeze({
          ...line,
          ...(line.parentProduct
            ? { parentProduct: Object.freeze(line.parentProduct) }
            : {}),
        })
      )
    ),
    organizerFee: Object.freeze(fee),
  })
}

/** Locale-independent fixed tuples; absence is explicit, not key-order dependent. */
export function checkoutSparkEventMarketBindingDigestValue(
  binding: CheckoutSparkEventMarketBinding
): unknown[] {
  const fee = binding.organizerFee
  return [
    DIGEST_DOMAIN,
    binding.schemaVersion,
    binding.organizerPubkey,
    binding.marketCoordinate,
    binding.marketEventId,
    binding.occurrenceCoordinate,
    binding.occurrenceEventId,
    binding.schedule
      ? [binding.schedule.coordinate, binding.schedule.eventId]
      : null,
    binding.grantEventId,
    [...binding.grantAncestryEventIds].sort(),
    [...binding.observedDeletionEventIds].sort(),
    binding.mode,
    binding.assignment,
    [...binding.lines]
      .sort(compareLines)
      .map((line) => [
        line.productCoordinate,
        line.productEventId,
        line.assignmentCoordinate,
        line.assignmentEventId,
        line.quantity,
        line.stockPoolId ?? null,
        line.parentProduct
          ? [line.parentProduct.coordinate, line.parentProduct.eventId]
          : null,
      ]),
    [
      fee.marketCoordinate,
      fee.organizerPubkey,
      fee.eventId,
      fee.createdAt,
      fee.state,
      ...(fee.state === "active"
        ? [
            fee.basisPoints,
            fee.minimumSats,
            fee.lightningAddress,
            fee.expiresAt ?? null,
          ]
        : []),
    ],
    binding.organizerFeeSats,
  ]
}

const snapshotReferenceSchema = z.object({
  coordinate: z.string(),
  eventId: hashSchema,
})
const orderSnapshotSchema = z.object({
  type: z.literal("event_market_pickup"),
  organizerPubkey: hashSchema,
  merchantPubkey: hashSchema,
  payeePubkey: hashSchema,
  market: snapshotReferenceSchema,
  calendar: snapshotReferenceSchema,
  schedule: snapshotReferenceSchema.optional(),
  grant: z.object({
    kind: z.literal(3841),
    pubkey: hashSchema,
    eventId: hashSchema,
    ancestryEventIds: z.array(hashSchema).min(1).max(128),
    observedDeletionEventIds: z.array(hashSchema).max(128),
  }),
  product: snapshotReferenceSchema,
  occurrenceAssignment: snapshotReferenceSchema,
  parentProduct: snapshotReferenceSchema.optional(),
  mode: z.enum(["merchant_present", "organizer_handoff"]),
  assignment: z.string(),
})

function sameIdSet(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  return (
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  )
}

/**
 * Compare public order snapshot references only. This deliberately does not
 * authenticate embedded events or establish stock/payment/handout authority.
 */
export function matchesCheckoutSparkOrderEventMarketSnapshot(
  fulfillment: unknown,
  binding: CheckoutSparkEventMarketBinding,
  productCoordinate: string
): boolean {
  try {
    const parsed = orderSnapshotSchema.safeParse(fulfillment)
    const line = binding.lines.find(
      (candidate) => candidate.productCoordinate === productCoordinate
    )
    const product = parseAddressableCoordinate(productCoordinate, [30_402])
    if (!parsed.success || !line || product?.coordinate !== productCoordinate)
      return false
    const snapshot = parsed.data
    return (
      snapshot.organizerPubkey === binding.organizerPubkey &&
      snapshot.merchantPubkey === product.authorPubkey &&
      snapshot.payeePubkey === product.authorPubkey &&
      snapshot.market.coordinate === binding.marketCoordinate &&
      snapshot.market.eventId === binding.marketEventId &&
      snapshot.calendar.coordinate === binding.occurrenceCoordinate &&
      snapshot.calendar.eventId === binding.occurrenceEventId &&
      snapshot.schedule?.coordinate === binding.schedule?.coordinate &&
      snapshot.schedule?.eventId === binding.schedule?.eventId &&
      snapshot.grant.pubkey === binding.organizerPubkey &&
      snapshot.grant.eventId === binding.grantEventId &&
      sameIdSet(
        snapshot.grant.ancestryEventIds,
        binding.grantAncestryEventIds
      ) &&
      sameIdSet(
        snapshot.grant.observedDeletionEventIds,
        binding.observedDeletionEventIds
      ) &&
      snapshot.mode === binding.mode &&
      snapshot.assignment === binding.assignment &&
      snapshot.product.coordinate === line.productCoordinate &&
      snapshot.product.eventId === line.productEventId &&
      snapshot.occurrenceAssignment.coordinate === line.assignmentCoordinate &&
      snapshot.occurrenceAssignment.eventId === line.assignmentEventId &&
      snapshot.parentProduct?.coordinate === line.parentProduct?.coordinate &&
      snapshot.parentProduct?.eventId === line.parentProduct?.eventId
    )
  } catch {
    return false
  }
}

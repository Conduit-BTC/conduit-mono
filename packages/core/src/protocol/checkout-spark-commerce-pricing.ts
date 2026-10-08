import { z } from "zod"
import {
  isPricingRateQuoteFresh,
  normalizeCommercePrice,
  normalizeCurrencyCode,
  isSatsLikeCurrency,
  isFiatCurrencyCode,
  type SourcePriceQuote,
} from "../pricing"
import type { Product } from "../types"
import type { CheckoutSparkCommerceQuoteLine } from "./checkout-spark-reconciliation"
import type { ShippingPolicyQuote } from "./shipping-policy"
import {
  checkoutSparkPricingRateAttestationDigestValue,
  type CheckoutSparkPricingRateAttestation,
} from "./checkout-spark-pricing-authority"

/**
 * Retained conversion evidence, not a merchant-signed exchange-rate oracle.
 * Wire reads preserve historical currencies; new admission uses pricing policy.
 */
export const checkoutSparkCommercePricingSchema = z
  .object({
    version: z.literal(1),
    rate: z
      .object({
        rate: z.number().finite().positive(),
        fetchedAt: z.number().int().safe().nonnegative(),
        source: z.enum(["env", "mempool", "coinbase"]),
        fiatUsdRates: z
          .record(
            z
              .string()
              .refine(
                (key) => /^[A-Z]{3}$/.test(key) && isFiatCurrencyCode(key)
              ),
            z.number().finite().positive()
          )
          .optional(),
        fiatSource: z
          .enum(["frankfurter", "exchange-rate-api", "env", "mempool"])
          .optional(),
        fiatSources: z
          .record(
            z.string().regex(/^[A-Z]{3}$/),
            z.enum(["frankfurter", "exchange-rate-api", "env", "mempool"])
          )
          .optional(),
      })
      .strict(),
  })
  .strict()

export type CheckoutSparkCommercePricing = z.infer<
  typeof checkoutSparkCommercePricingSchema
>

export function freezeCheckoutSparkCommercePricing(
  input: unknown
): CheckoutSparkCommercePricing {
  const pricing = checkoutSparkCommercePricingSchema.parse(input)
  if (pricing.rate.fiatUsdRates) Object.freeze(pricing.rate.fiatUsdRates)
  if (pricing.rate.fiatSources) Object.freeze(pricing.rate.fiatSources)
  Object.freeze(pricing.rate)
  return Object.freeze(pricing)
}

export const checkoutSparkSourcePriceSchema = z
  .object({
    amount: z.number().finite().nonnegative(),
    currency: z.string().min(1).max(16),
    normalizedCurrency: z.string().min(1).max(16),
  })
  .strict()
  .refine(
    (source) =>
      source.normalizedCurrency === normalizeCurrencyCode(source.currency)
  )

export const checkoutSparkCommerceVariationSchema = z
  .object({
    familyCoordinate: z
      .string()
      .regex(/^30402:[0-9a-f]{64}:.+$/)
      .optional(),
    specifications: z.array(
      z
        .object({
          key: z.string().min(1).max(80),
          value: z.string().min(1).max(200),
        })
        .strict()
    ),
  })
  .strict()

export interface CheckoutSparkCommerceVariation {
  familyCoordinate?: string
  specifications: readonly { key: string; value: string }[]
}

export function freezeCheckoutSparkCommerceEvidence<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value))
      freezeCheckoutSparkCommerceEvidence(nested)
    Object.freeze(value)
  }
  return value
}

/** Stable JSON evidence ordering, independent of browser locale and key insertion. */
export function canonicalCheckoutSparkCommerceEvidence(
  value: unknown
): unknown {
  if (Array.isArray(value))
    return value.map(canonicalCheckoutSparkCommerceEvidence)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [
          key,
          canonicalCheckoutSparkCommerceEvidence(entry),
        ])
    )
  return value
}

/** Keep the original tuple byte-identical when no extension is present. */
export function checkoutSparkCommerceQuoteDigestValue(quote: {
  commerceTotalSats: number
  lines: readonly CheckoutSparkCommerceQuoteLine[]
  pricing?: CheckoutSparkCommercePricing
  pricingAuthority?: CheckoutSparkPricingRateAttestation
}): unknown[] {
  return [
    quote.commerceTotalSats,
    quote.lines.map((line) => [
      line.productCoordinate,
      line.productEventId,
      line.merchantPubkey,
      line.quantity,
      line.unitMerchandiseSats,
      line.unitShippingSats,
      line.shippingOption
        ? [line.shippingOption.coordinate, line.shippingOption.eventId]
        : null,
      ...(line.pickup
        ? [
            [
              "pickup",
              line.pickup.calendar.coordinate,
              line.pickup.calendar.eventId,
              line.pickup.collection.coordinate,
              line.pickup.collection.eventId,
            ],
          ]
        : []),
      ...(line.sourcePrice
        ? [
            [
              "source_price",
              line.sourcePrice.amount,
              line.sourcePrice.currency,
              line.sourcePrice.normalizedCurrency,
            ],
          ]
        : []),
      ...(line.sourceShippingCost
        ? [
            [
              "source_shipping",
              line.sourceShippingCost.amount,
              line.sourceShippingCost.currency,
              line.sourceShippingCost.normalizedCurrency,
            ],
          ]
        : []),
      ...(line.variation
        ? [
            [
              "variation",
              line.variation.familyCoordinate ?? null,
              line.variation.specifications.map((specification) => [
                specification.key,
                specification.value,
              ]),
            ],
          ]
        : []),
      ...(line.shippingPolicy
        ? [
            [
              "shipping_policy",
              line.shippingPolicy.allocatedCostSats,
              canonicalCheckoutSparkCommerceEvidence(line.shippingPolicy.quote),
            ],
          ]
        : []),
    ]),
    ...(quote.pricing
      ? [
          [
            "pricing",
            quote.pricing.version,
            quote.pricing.rate.rate,
            quote.pricing.rate.fetchedAt,
            quote.pricing.rate.source,
            Object.entries(quote.pricing.rate.fiatUsdRates ?? {}).sort(
              ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
            ),
            quote.pricing.rate.fiatSource ?? null,
            ...(quote.pricing.rate.fiatSources
              ? [
                  [
                    "fiat_sources",
                    Object.entries(quote.pricing.rate.fiatSources).sort(
                      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
                    ),
                  ],
                ]
              : []),
          ],
        ]
      : []),
    ...(quote.pricingAuthority
      ? [checkoutSparkPricingRateAttestationDigestValue(quote.pricingAuthority)]
      : []),
  ]
}

export function hasSameCheckoutSparkSourcePrice(
  left: SourcePriceQuote | undefined,
  right: SourcePriceQuote | undefined
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.amount === right.amount &&
        left.currency === right.currency &&
        left.normalizedCurrency === right.normalizedCurrency
}

/** Shape/economic admission only; the exact signed source is verified separately. */
export function matchesCheckoutSparkOrderPrice(
  input: {
    sourcePrice?: SourcePriceQuote
    priceAtPurchase: number
  },
  pricing?: CheckoutSparkCommercePricing,
  allowZero = false
): boolean {
  if (!input.sourcePrice) return true
  if (
    isSatsLikeCurrency(input.sourcePrice.currency) &&
    isSatsLikeCurrency(input.sourcePrice.normalizedCurrency)
  )
    return (
      input.sourcePrice.amount === input.priceAtPurchase &&
      (allowZero || input.priceAtPurchase > 0)
    )
  if (
    allowZero &&
    input.sourcePrice.amount === 0 &&
    input.priceAtPurchase === 0
  )
    return (
      input.sourcePrice.normalizedCurrency ===
      normalizeCurrencyCode(input.sourcePrice.currency)
    )
  const converted = normalizeCommercePrice(
    input.sourcePrice.amount,
    input.sourcePrice.currency,
    pricing?.rate ?? null,
    { allowZero, currencyPolicy: "historical" }
  )
  return (
    converted.status === "ok" &&
    converted.sats === input.priceAtPurchase &&
    hasSameCheckoutSparkSourcePrice(converted.source, input.sourcePrice)
  )
}

/** Exact order/lifecycle line binding; signed source authenticity is a separate gate. */
export function matchesCheckoutSparkCommerceOrderLine(
  item: {
    productId: string
    quantity: number
    priceAtPurchase: number
    sourcePrice?: SourcePriceQuote
    familyProductId?: string
    selectedSpecifications?: readonly { key: string; value: string }[]
    shippingCostSats?: number
    sourceShippingCost?: SourcePriceQuote
    shippingOptionId?: string
    shippingPolicyQuote?: ShippingPolicyQuote
    shippingAllocatedCostSats?: number
  },
  line: CheckoutSparkCommerceQuoteLine
): boolean {
  return (
    item.productId === line.productCoordinate &&
    item.quantity === line.quantity &&
    item.priceAtPurchase === line.unitMerchandiseSats &&
    (item.shippingCostSats ?? 0) === line.unitShippingSats &&
    item.shippingOptionId === line.shippingOption?.coordinate &&
    (line.sourcePrice
      ? hasSameCheckoutSparkSourcePrice(item.sourcePrice, line.sourcePrice)
      : item.sourcePrice === undefined ||
        (item.sourcePrice.amount === line.unitMerchandiseSats &&
          isSatsLikeCurrency(item.sourcePrice.currency) &&
          isSatsLikeCurrency(item.sourcePrice.normalizedCurrency))) &&
    item.familyProductId === line.variation?.familyCoordinate &&
    (line.variation
      ? JSON.stringify(item.selectedSpecifications ?? []) ===
        JSON.stringify(line.variation.specifications)
      : item.selectedSpecifications === undefined) &&
    (line.shippingPolicy
      ? item.shippingAllocatedCostSats ===
          line.shippingPolicy.allocatedCostSats &&
        JSON.stringify(
          canonicalCheckoutSparkCommerceEvidence(item.shippingPolicyQuote)
        ) ===
          JSON.stringify(
            canonicalCheckoutSparkCommerceEvidence(line.shippingPolicy.quote)
          )
      : item.shippingPolicyQuote === undefined &&
        item.shippingAllocatedCostSats === undefined) &&
    (line.sourceShippingCost
      ? hasSameCheckoutSparkSourcePrice(
          item.sourceShippingCost,
          line.sourceShippingCost
        )
      : item.sourceShippingCost === undefined ||
        (!!line.shippingOption &&
          !line.shippingPolicy &&
          item.sourceShippingCost.amount === line.unitShippingSats &&
          isSatsLikeCurrency(item.sourceShippingCost.currency) &&
          isSatsLikeCurrency(item.sourceShippingCost.normalizedCurrency)))
  )
}

/** Recompute final whole sats from the exact signed source and the frozen rate. */
export function assertCheckoutSparkCommerceProductPrice(input: {
  product: Product
  line: CheckoutSparkCommerceQuoteLine
  pricing?: CheckoutSparkCommercePricing
  acceptedAtMs?: number
}): void {
  const { product, line } = input
  const pricing =
    input.pricing === undefined
      ? undefined
      : freezeCheckoutSparkCommercePricing(input.pricing)
  const conversion = normalizeCommercePrice(
    product.sourcePrice?.amount ?? product.price,
    product.sourcePrice?.currency ?? product.currency,
    pricing?.rate ?? null,
    { currencyPolicy: "historical" }
  )
  if (
    product.priceEvidenceMalformed ||
    product.type === "variable" ||
    (product.type === "variation" &&
      (!line.variation || !product.parentProductId)) ||
    (line.variation !== undefined &&
      (line.variation.familyCoordinate !== product.parentProductId ||
        JSON.stringify(line.variation.specifications) !==
          JSON.stringify(product.specifications ?? []))) ||
    conversion.status !== "ok" ||
    conversion.sats !== line.unitMerchandiseSats ||
    (line.sourcePrice !== undefined &&
      !hasSameCheckoutSparkSourcePrice(line.sourcePrice, conversion.source)) ||
    (conversion.approximate &&
      (!pricing ||
        line.sourcePrice === undefined ||
        input.acceptedAtMs === undefined ||
        !isPricingRateQuoteFresh(pricing.rate, input.acceptedAtMs)))
  ) {
    throw new Error("Checkout Spark frozen product pricing is unavailable.")
  }
}

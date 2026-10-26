import { isFiatCurrencyCode, normalizeCurrencyIdentity } from "../pricing"
import type { CheckoutSparkCommerceQuote } from "./checkout-spark-reconciliation"
import type { ShippingPolicyQuote } from "./shipping-policy"
import {
  checkoutSparkPricingRateDigestValue,
  verifyCheckoutSparkPricingRateAttestation,
  type CheckoutSparkPricingRateAuthorization,
} from "./checkout-spark-pricing-authority"

function shippingFiatCurrencies(shipping: ShippingPolicyQuote): string[] {
  const currencies = new Set<string>()
  const add = (currency: string | undefined, amount: number) => {
    if (!currency || amount === 0) return
    const normalized = normalizeCurrencyIdentity(currency)
    if (isFiatCurrencyCode(normalized)) currencies.add(normalized)
  }
  add(shipping.currency, shipping.amountMinor)
  // A zero-price band can still depend on fiat subtotal/handling conversion.
  // The policy schema independently recomputes whether the rate was used.
  if (shipping.pricingRate !== null && shipping.pricingRate !== undefined) {
    for (const item of shipping.items) {
      if (
        normalizeCurrencyIdentity(item.currency) !==
        normalizeCurrencyIdentity(shipping.currency)
      ) {
        add(item.currency, item.subtotalMinor)
        add(shipping.currency, item.subtotalMinor)
      }
      if ("shippingHandling" in item && item.shippingHandling) {
        const handling = item.shippingHandling
        if (
          normalizeCurrencyIdentity(handling.currency) !==
          normalizeCurrencyIdentity(shipping.currency)
        ) {
          add(handling.currency, handling.amount)
          add(shipping.currency, handling.amount)
        }
      }
    }
  }
  return [...currencies].sort()
}

/** Only economic conversions require authority, not incidental display rates. */
export function getCheckoutSparkRequiredFiatCurrencies(
  quote: Pick<CheckoutSparkCommerceQuote, "lines">
): string[] {
  const currencies = new Set<string>()
  for (const line of quote.lines) {
    for (const source of [line.sourcePrice, line.sourceShippingCost]) {
      if (source && source.amount !== 0) {
        const normalized = normalizeCurrencyIdentity(source.normalizedCurrency)
        if (isFiatCurrencyCode(normalized)) currencies.add(normalized)
      }
    }
    if (line.shippingPolicy)
      for (const currency of shippingFiatCurrencies(line.shippingPolicy.quote))
        currencies.add(currency)
  }
  return [...currencies].sort()
}

export type CheckoutSparkCommercePricingAuthorization =
  "deterministic" | CheckoutSparkPricingRateAuthorization

/**
 * Authenticate the one frozen rate used by every economic conversion. Callers
 * must separately recompute signed listing, variation, shipping and allocations.
 * Recovery acceptedAtMs must be the independently observed provider request time.
 */
export function assessCheckoutSparkCommercePricingAuthority(input: {
  quote: CheckoutSparkCommerceQuote
  acceptedAtMs: number
  nowMs?: number
  trustedPublicKeys: ReadonlyMap<string, string> | null | undefined
}): CheckoutSparkCommercePricingAuthorization {
  const currencies = getCheckoutSparkRequiredFiatCurrencies(input.quote)
  if (!currencies.length) return "deterministic"
  const pricing = input.quote.pricing
  if (!pricing) return "invalid"
  const authorization = verifyCheckoutSparkPricingRateAttestation({
    attestation: input.quote.pricingAuthority,
    pricing,
    acceptedAtMs: input.acceptedAtMs,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    trustedPublicKeys: input.trustedPublicKeys,
  })
  if (authorization !== "verified") return authorization
  if (
    currencies.some(
      (currency) => currency !== "USD" && !pricing.rate.fiatUsdRates?.[currency]
    )
  )
    return "invalid"
  for (const line of input.quote.lines) {
    const shipping = line.shippingPolicy?.quote
    if (!shipping || !shippingFiatCurrencies(shipping).length) continue
    const rate = shipping.pricingRate
    if (
      !rate ||
      typeof rate !== "object" ||
      JSON.stringify(checkoutSparkPricingRateDigestValue(rate)) !==
        JSON.stringify(checkoutSparkPricingRateDigestValue(pricing.rate))
    )
      return "invalid"
  }
  return "verified"
}

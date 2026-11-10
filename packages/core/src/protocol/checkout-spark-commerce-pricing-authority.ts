import {
  isFiatCurrencyCode,
  isPricingRateQuoteFresh,
  normalizeCurrencyIdentity,
  type BtcUsdRateQuote,
} from "../pricing"
import {
  fetchHistoricalPricingRate,
  type HistoricalPricingRateQuote,
} from "../pricing/historical-rate-provider"
import { CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY } from "./checkout-spark-commerce-pricing"
import type { CheckoutSparkCommerceQuote } from "./checkout-spark-reconciliation"
import {
  convertShippingMinor,
  parsePrivateOrderShippingPolicyTags,
  previewShippingPolicy,
  type ShippingPolicyQuote,
} from "./shipping-policy"
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
  if (!pricing || pricing.version !== 1) return "invalid"
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

type Ratio = { n: bigint; d: bigint }

/** JSON decimal rates are exact inputs; the 1% bound has no float epsilon. */
function decimalRatio(value: number): Ratio {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid rate.")
  const [coefficient, power = "0"] = String(value).toLowerCase().split("e")
  const [whole, fraction = ""] = coefficient!.split(".")
  const exponent = Number(power) - fraction.length
  const n = BigInt(whole! + fraction)
  return exponent >= 0
    ? { n: n * 10n ** BigInt(exponent), d: 1n }
    : { n, d: 10n ** BigInt(-exponent) }
}

function satsPerUnit(currency: string, rate: BtcUsdRateQuote): Ratio {
  const code = normalizeCurrencyIdentity(currency)
  if (code === "SATS") return { n: 1n, d: 1n }
  if (code === "BTC") return { n: 100_000_000n, d: 1n }
  if (code === "MSATS") return { n: 1n, d: 1_000n }
  const usd = decimalRatio(
    code === "USD" ? 1 : (rate.fiatUsdRates?.[code] ?? NaN)
  )
  const btc = decimalRatio(rate.rate)
  return { n: 100_000_000n * usd.n * btc.d, d: usd.d * btc.n }
}

function withinOnePercent(
  from: string,
  to: string,
  claimed: BtcUsdRateQuote,
  benchmark: BtcUsdRateQuote
): boolean {
  const cf = satsPerUnit(from, claimed)
  const ct = satsPerUnit(to, claimed)
  const bf = satsPerUnit(from, benchmark)
  const bt = satsPerUnit(to, benchmark)
  const n = cf.n * ct.d * bf.d * bt.n
  const d = cf.d * ct.n * bf.n * bt.d
  return n * 100n >= d * 99n && n * 100n <= d * 101n
}

/** A rate tolerance cannot change which signed free-shipping threshold applies. */
function matchesHistoricalShipping(
  shipping: ShippingPolicyQuote,
  claimed: BtcUsdRateQuote,
  benchmark: BtcUsdRateQuote
): boolean {
  const policy = parsePrivateOrderShippingPolicyTags(shipping.policyEvent.tags)
  if (!policy) return false
  const table =
    shipping.destination.country.trim().toUpperCase() === policy.originCountry
      ? policy.domestic
      : policy.international
  const needsSubtotal =
    policy.version === 1 || table?.freeShippingThresholdMinor !== undefined
  for (const item of shipping.items) {
    if (
      needsSubtotal &&
      item.subtotalMinor !== 0 &&
      !withinOnePercent(item.currency, shipping.currency, claimed, benchmark)
    )
      return false
    if (
      "shippingHandling" in item &&
      item.shippingHandling &&
      item.shippingHandling.amount !== 0 &&
      !withinOnePercent(
        item.shippingHandling.currency,
        shipping.currency,
        claimed,
        benchmark
      )
    )
      return false
  }
  const calculation = previewShippingPolicy({
    policy,
    items: shipping.items,
    destination: shipping.destination,
    rateInput: benchmark,
  })
  if (
    calculation.status !== "quoted" ||
    calculation.freeShippingApplied !== shipping.freeShippingApplied ||
    calculation.bandMaxWeightGrams !== shipping.bandMaxWeightGrams ||
    calculation.bandPriceMinor !== shipping.bandPriceMinor
  )
    return false
  const expectedSats = convertShippingMinor(
    calculation.amountMinor,
    shipping.currency,
    "SATS",
    benchmark
  )
  const actualSats =
    shipping.amountSats ??
    convertShippingMinor(
      shipping.amountMinor,
      shipping.currency,
      "SATS",
      claimed
    )
  if (!Number.isSafeInteger(actualSats)) return false
  // Cross-currency handling is rounded in policy minor units first. Bound the
  // final debit too, so that intermediate rounding cannot widen the allowance.
  const actual = BigInt(actualSats) * 100n
  const expected = BigInt(expectedSats)
  return actual >= expected * 99n - 100n && actual <= expected * 101n + 100n
}

// Cache public observations only, never a receipt, order or authorization.
const historicalReads = new Map<
  string,
  {
    expiresAt: number
    value: Promise<HistoricalPricingRateQuote>
  }
>()

function readHistoricalRate(
  acceptedAtMs: number,
  currencies: string[],
  override?: typeof fetchHistoricalPricingRate
): Promise<HistoricalPricingRateQuote> {
  const input = { acceptedAtMs, currencies }
  if (override) return override(input)
  const key = `${acceptedAtMs}:${currencies.join(",")}`
  const previous = historicalReads.get(key)
  if (previous && previous.expiresAt > Date.now()) return previous.value
  const value = fetchHistoricalPricingRate(input)
  historicalReads.delete(key)
  historicalReads.set(key, { expiresAt: Date.now() + 60_000, value })
  if (historicalReads.size > 32)
    historicalReads.delete(historicalReads.keys().next().value!)
  void value.catch(() => {
    if (historicalReads.get(key)?.value === value) historicalReads.delete(key)
  })
  return value
}

/** New pricing evidence is checked against history at the provider invoice time. */
export async function verifyCheckoutSparkCommercePricingAuthority(input: {
  quote: CheckoutSparkCommerceQuote
  acceptedAtMs: number
  nowMs?: number
  trustedPublicKeys: ReadonlyMap<string, string> | null | undefined
  fetchHistoricalRate?: typeof fetchHistoricalPricingRate
}): Promise<CheckoutSparkCommercePricingAuthorization | "unavailable"> {
  const pricing = input.quote.pricing
  if (pricing?.version !== 2)
    return assessCheckoutSparkCommercePricingAuthority(input)
  if (
    pricing.policy !== CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY ||
    input.quote.pricingAuthority !== undefined
  )
    return "invalid"
  const currencies = getCheckoutSparkRequiredFiatCurrencies(input.quote)
  if (!currencies.length) return "deterministic"
  if (
    pricing.rate.source === "env" ||
    !isPricingRateQuoteFresh(pricing.rate, input.acceptedAtMs) ||
    (input.nowMs !== undefined &&
      (input.nowMs < input.acceptedAtMs ||
        !isPricingRateQuoteFresh(pricing.rate, input.nowMs)))
  )
    return "expired"
  for (const line of input.quote.lines) {
    const shipping = line.shippingPolicy?.quote
    if (
      shipping &&
      shippingFiatCurrencies(shipping).length &&
      (!shipping.pricingRate ||
        typeof shipping.pricingRate !== "object" ||
        JSON.stringify(
          checkoutSparkPricingRateDigestValue(shipping.pricingRate)
        ) !== JSON.stringify(checkoutSparkPricingRateDigestValue(pricing.rate)))
    )
      return "invalid"
  }
  let benchmark: BtcUsdRateQuote
  try {
    const observed = await readHistoricalRate(
      input.acceptedAtMs,
      currencies,
      input.fetchHistoricalRate
    )
    benchmark = {
      rate: observed.rate,
      source: observed.source,
      fetchedAt: observed.fetchedAt,
      fiatUsdRates: observed.fiatUsdRates,
      fiatSource: observed.fiatSource,
      fiatSources: observed.fiatSources,
    }
  } catch {
    return "unavailable"
  }
  try {
    if (
      currencies.some(
        (currency) =>
          !withinOnePercent(currency, "SATS", pricing.rate, benchmark)
      )
    )
      return "invalid"
    for (const line of input.quote.lines) {
      if (
        line.shippingPolicy &&
        !matchesHistoricalShipping(
          line.shippingPolicy.quote,
          pricing.rate,
          benchmark
        )
      )
        return "invalid"
    }
    return "verified"
  } catch {
    return "invalid"
  }
}

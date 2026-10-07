import { SUPPORTED_PRODUCT_PRICE_CURRENCIES } from "@conduit/core/pricing"
import {
  freezeCheckoutSparkCommercePricing,
  type CheckoutSparkCommercePricing,
} from "@conduit/core/protocol/checkout-spark-commerce-pricing"
import {
  freezeCheckoutSparkPricingRateAttestation,
  verifyCheckoutSparkPricingRateAttestation,
  type CheckoutSparkPricingRateAttestation,
} from "@conduit/core/protocol/checkout-spark-pricing-authority"
import {
  getCheckoutSparkPricingConfiguration,
  type CheckoutSparkPricingConfiguration,
} from "@conduit/core/protocol/checkout-spark-pricing-config"

export interface CheckoutSparkAuthorizedPricing {
  readonly pricing: CheckoutSparkCommercePricing
  readonly pricingAuthority: CheckoutSparkPricingRateAttestation
}

export class CheckoutSparkAuthorizedPricingUnavailable extends Error {
  constructor(
    readonly code: "unconfigured" | "unavailable" | "session_changed"
  ) {
    super(
      code === "session_changed"
        ? "Checkout changed. Review it before paying."
        : "Current currency pricing is unavailable. Try again before paying."
    )
    this.name = "CheckoutSparkAuthorizedPricingUnavailable"
  }
}

/** The service receives currency codes only, never private checkout evidence. */
export async function fetchCheckoutSparkAuthorizedPricing(input: {
  currencies: readonly string[]
  shouldContinue: () => boolean
  nowMs?: () => number
  configuration?: CheckoutSparkPricingConfiguration | null
  fetchImpl?: typeof fetch
}): Promise<CheckoutSparkAuthorizedPricing> {
  const assertCurrent = () => {
    if (!input.shouldContinue())
      throw new CheckoutSparkAuthorizedPricingUnavailable("session_changed")
  }
  assertCurrent()
  const configuration =
    input.configuration === undefined
      ? getCheckoutSparkPricingConfiguration()
      : input.configuration
  if (!configuration)
    throw new CheckoutSparkAuthorizedPricingUnavailable("unconfigured")
  const currencies = [...new Set(input.currencies)].sort()
  if (
    !currencies.length ||
    currencies.length > SUPPORTED_PRODUCT_PRICE_CURRENCIES.length - 1 ||
    currencies.some(
      (currency) =>
        !SUPPORTED_PRODUCT_PRICE_CURRENCIES.some(
          (supported) => supported !== "SATS" && supported === currency
        )
    )
  )
    throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
    void reader?.cancel().catch(() => {})
  }, 15_000)
  try {
    const response = await (input.fetchImpl ?? fetch)(configuration.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currencies }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    })
    assertCurrent()
    const declaredLength = response.headers.get("content-length")
    if (
      !response.ok ||
      !response.body ||
      response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json" ||
      (declaredLength &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 16_384))
    )
      throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const next = await reader.read()
      assertCurrent()
      if (timedOut)
        throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
      if (next.done) break
      size += next.value.byteLength
      if (size > 16_384)
        throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      Object.keys(result).length !== 2 ||
      !("pricing" in result) ||
      !("pricingAuthority" in result)
    )
      throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
    const pricing = freezeCheckoutSparkCommercePricing(result.pricing)
    const pricingAuthority = freezeCheckoutSparkPricingRateAttestation(
      result.pricingAuthority
    )
    const nowMs = (input.nowMs ?? Date.now)()
    if (
      verifyCheckoutSparkPricingRateAttestation({
        attestation: pricingAuthority,
        pricing,
        acceptedAtMs: nowMs,
        nowMs,
        trustedPublicKeys: configuration.publicKeys,
      }) !== "verified" ||
      currencies.some(
        (currency) =>
          currency !== "USD" && !pricing.rate.fiatUsdRates?.[currency]
      )
    )
      throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
    assertCurrent()
    return Object.freeze({ pricing, pricingAuthority })
  } catch (error) {
    assertCurrent()
    if (error instanceof CheckoutSparkAuthorizedPricingUnavailable) throw error
    throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
  } finally {
    clearTimeout(timeout)
    controller.abort()
    if (reader) {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

import { SUPPORTED_PRODUCT_PRICE_CURRENCIES } from "./index"
import {
  freezeCheckoutSparkCommercePricing,
  type CheckoutSparkCommercePricing,
} from "../protocol/checkout-spark-commerce-pricing"
import {
  CHECKOUT_SPARK_PRICING_LIVE_ISSUANCE_SKEW_MS,
  freezeCheckoutSparkPricingRateAttestation,
  verifyCheckoutSparkPricingRateAttestation,
  type CheckoutSparkPricingRateAttestation,
} from "../protocol/checkout-spark-pricing-authority"
import {
  getCheckoutSparkPricingConfiguration,
  type CheckoutSparkPricingConfiguration,
} from "../protocol/checkout-spark-pricing-config"

/** One public feed for both apps and checkout, never a cart-specific request. */
export const SIGNED_PRICING_FEED_CURRENCIES = Object.freeze(
  SUPPORTED_PRODUCT_PRICE_CURRENCIES.filter((currency) => currency !== "SATS")
    .slice()
    .sort()
)
const REFRESH_AFTER_MS = 4 * 60_000
const MAX_CACHE_ENTRIES = 8

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

interface PricingCacheEntry {
  snapshot?: CheckoutSparkAuthorizedPricing
  pending?: Promise<CheckoutSparkAuthorizedPricing>
}

function configurationCacheKey(
  configuration: CheckoutSparkPricingConfiguration
): string {
  return JSON.stringify([
    configuration.url,
    [...configuration.publicKeys.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    ),
  ])
}

function verifyLiveSnapshot(
  snapshot: CheckoutSparkAuthorizedPricing,
  configuration: CheckoutSparkPricingConfiguration,
  nowMs: number,
  allowClockSkew = false
): boolean {
  return (
    verifyCheckoutSparkPricingRateAttestation({
      attestation: snapshot.pricingAuthority,
      pricing: snapshot.pricing,
      acceptedAtMs: nowMs,
      nowMs,
      trustedPublicKeys: configuration.publicKeys,
      ...(allowClockSkew ? { allowLiveIssuanceClockSkew: true as const } : {}),
    }) === "verified"
  )
}

/** Bounded JSON reads; upstream response contents never escape as diagnostics. */
async function readSnapshot(
  configuration: CheckoutSparkPricingConfiguration,
  fetchImpl: typeof fetch,
  nowMs: () => number
): Promise<CheckoutSparkAuthorizedPricing> {
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
    void reader?.cancel().catch(() => {})
  }, 15_000)
  try {
    const response = await fetchImpl(configuration.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currencies: SIGNED_PRICING_FEED_CURRENCIES }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    })
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
    const snapshot = Object.freeze({
      pricing: freezeCheckoutSparkCommercePricing(result.pricing),
      pricingAuthority: freezeCheckoutSparkPricingRateAttestation(
        result.pricingAuthority
      ),
    })
    if (!verifyLiveSnapshot(snapshot, configuration, nowMs(), true))
      throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
    return snapshot
  } catch {
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

/**
 * One bounded cache per app runtime. Concurrent display/checkout consumers share
 * a lookup; refreshing or serving a snapshot never rewrites its signed age.
 * Recovery deliberately does not call this client or depend on its cache.
 */
export function createCheckoutSparkPricingClient(
  dependencies: {
    fetchImpl?: typeof fetch
    nowMs?: () => number
    wait?: (milliseconds: number) => Promise<void>
  } = {}
) {
  const entries = new Map<string, PricingCacheEntry>()
  const nowMs = dependencies.nowMs ?? Date.now
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  return {
    async fetch(input: {
      configuration: CheckoutSparkPricingConfiguration | null
      currencies: readonly string[]
    }): Promise<CheckoutSparkAuthorizedPricing> {
      const configuration = input.configuration
      if (!configuration)
        throw new CheckoutSparkAuthorizedPricingUnavailable("unconfigured")
      if (
        !input.currencies.length ||
        input.currencies.some(
          (currency) =>
            !SIGNED_PRICING_FEED_CURRENCIES.some(
              (supported) => supported === currency
            )
        )
      )
        throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
      const key = configurationCacheKey(configuration)
      let entry = entries.get(key)
      if (!entry) {
        if (entries.size >= MAX_CACHE_ENTRIES)
          entries.delete(entries.keys().next().value!)
        entry = {}
        entries.set(key, entry)
      }
      const current = entry.snapshot
      const currentTime = nowMs()
      const valid =
        current && verifyLiveSnapshot(current, configuration, currentTime, true)
      let snapshot: CheckoutSparkAuthorizedPricing
      if (
        valid &&
        currentTime - current.pricing.rate.fetchedAt < REFRESH_AFTER_MS
      ) {
        snapshot = current
      } else {
        if (!entry.pending) {
          const pending = readSnapshot(
            configuration,
            dependencies.fetchImpl ?? fetch,
            nowMs
          ).then((next) => {
            entry.snapshot = next
            return next
          })
          entry.pending = pending
          void pending
            .finally(() => {
              if (entry.pending === pending) entry.pending = undefined
            })
            .catch(() => {})
        }
        try {
          snapshot = await entry.pending
        } catch (error) {
          if (
            !current ||
            !verifyLiveSnapshot(current, configuration, nowMs(), true)
          )
            throw error
          snapshot = current
        }
      }
      // Tolerance permits a short clock catch-up, not a future-dated quote for
      // downstream consumers. Never rewrite the signed fetch/issue/expiry times
      // or relax the independent native funding anchor used by recovery.
      const beforeWait = nowMs()
      const readyAt = Math.max(
        snapshot.pricing.rate.fetchedAt,
        snapshot.pricingAuthority.issuedAtMs
      )
      const delay = readyAt - beforeWait
      if (
        !verifyLiveSnapshot(snapshot, configuration, beforeWait, true) ||
        delay > CHECKOUT_SPARK_PRICING_LIVE_ISSUANCE_SKEW_MS
      )
        throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
      if (delay > 0) await wait(delay)
      const acceptedAt = nowMs()
      if (
        acceptedAt < beforeWait ||
        acceptedAt < readyAt ||
        !verifyLiveSnapshot(snapshot, configuration, acceptedAt) ||
        input.currencies.some(
          (currency) =>
            currency !== "USD" &&
            !snapshot.pricing.rate.fiatUsdRates?.[currency]
        )
      )
        throw new CheckoutSparkAuthorizedPricingUnavailable("unavailable")
      return snapshot
    },
  }
}

const sharedPricingClient = createCheckoutSparkPricingClient()

export function fetchCheckoutSparkPricingRate(
  input: {
    currencies?: readonly string[]
    configuration?: CheckoutSparkPricingConfiguration | null
    fetchImpl?: typeof fetch
    nowMs?: () => number
    wait?: (milliseconds: number) => Promise<void>
  } = {}
): Promise<CheckoutSparkAuthorizedPricing> {
  const client =
    input.fetchImpl || input.nowMs || input.wait
      ? createCheckoutSparkPricingClient(input)
      : sharedPricingClient
  return client.fetch({
    currencies: input.currencies ?? ["USD"],
    configuration:
      input.configuration === undefined
        ? getCheckoutSparkPricingConfiguration()
        : input.configuration,
  })
}

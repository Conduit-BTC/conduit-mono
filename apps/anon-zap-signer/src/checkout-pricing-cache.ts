import {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
} from "@conduit/core/pricing"
import {
  fetchCommonPricingRateQuote,
  type PricingProviderAttempt,
} from "@conduit/core/pricing/common-rate-provider"
import {
  checkoutSparkAuthorizedPricingRateSchema,
  freezeCheckoutSparkPricingRateAttestation,
  verifyCheckoutSparkPricingRateAttestation,
  type CheckoutSparkPricingRateAttestation,
} from "@conduit/core/protocol/checkout-spark-pricing-authority"
import { createCheckoutSparkPricingRateAttestation } from "@conduit/core/protocol/checkout-spark-pricing-authority-server"

const COMMON_FIAT_CURRENCIES: readonly string[] =
  SUPPORTED_PRODUCT_PRICE_CURRENCIES.filter(
    (currency) => currency !== "SATS" && currency !== "USD"
  )
const REFRESH_AFTER_MS = 240_000
const FAILED_REFRESH_PAUSE_MS = 5_000
async function cacheDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Pricing cache is unavailable.")),
          250
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
export interface PricingSnapshotStore {
  read(key: string): Promise<unknown>
  write(
    key: string,
    snapshot: CheckoutSparkPricingRateAttestation,
    now: number
  ): Promise<void>
}

/** Cache only a public signed payload; never cache origin-specific responses. */
export function nativePricingSnapshotStore(
  origin: string
): PricingSnapshotStore | undefined {
  const cache = (
    globalThis as typeof globalThis & { caches?: { default?: Cache } }
  ).caches?.default
  if (!cache) return undefined
  const request = (key: string) =>
    new Request(
      `${origin}/__pricing-cache/ordered-3-v1/${encodeURIComponent(key)}`
    )
  return {
    async read(key) {
      const response = await cache.match(request(key))
      if (!response) return undefined
      const text = await response.text()
      if (text.length > 16_384) throw new Error("Invalid pricing cache.")
      return JSON.parse(text) as unknown
    },
    async write(key, snapshot, now) {
      const ttl = Math.floor((snapshot.expiresAtMs - now) / 1_000)
      if (ttl <= 0) return
      await cache.put(
        request(key),
        new Response(JSON.stringify(snapshot), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${ttl}`,
          },
        })
      )
    },
  }
}

type SnapshotInput = {
  keyId: string
  privateKeyHex: string
  publicKey: string
  nowMs: () => number
  fetchPricingRate: typeof fetchCommonPricingRateQuote
  fetchImpl?: typeof fetch
  store?: PricingSnapshotStore
  waitUntil?: (promise: Promise<unknown>) => void
}

/** One in-flight refresh per isolate. Edge eviction safely becomes a cold lookup. */
export function createCheckoutSparkPricingAuthorityCache() {
  let snapshot: CheckoutSparkPricingRateAttestation | undefined
  let pending: Promise<CheckoutSparkPricingRateAttestation> | undefined
  let nextAttemptMs = 0
  let cacheState = "miss"
  let refreshState = "none"
  let storeState = "unused"
  let attempts: PricingProviderAttempt[] = []
  const valid = (
    value: CheckoutSparkPricingRateAttestation | undefined,
    input: SnapshotInput
  ) =>
    value &&
    value.keyId === input.keyId &&
    value.issuedAtMs <= input.nowMs() &&
    input.nowMs() < value.expiresAtMs

  const startRefresh = (input: SnapshotInput, key: string) => {
    if (pending) return pending
    refreshState = "pending"
    attempts = []
    const previous = snapshot
    const refresh = (async () => {
      const fetched = await input.fetchPricingRate({
        preferredFiatCurrencies: COMMON_FIAT_CURRENCIES,
        includeFiatRates: true,
        nowMs: input.nowMs,
        timeoutMs: 2_000,
        totalTimeoutMs: 6_000,
        fetchImpl: input.fetchImpl,
        onProviderAttempt: (event) => {
          if (attempts.length < 6) attempts.push(event)
        },
      })
      const fiatUsdRates: Record<string, number> = {}
      const fiatSources: Record<string, string> = {}
      for (const currency of COMMON_FIAT_CURRENCIES) {
        const value = fetched.fiatUsdRates?.[currency]
        if (value === undefined || !Number.isFinite(value) || value <= 0)
          continue
        fiatUsdRates[currency] = value
        if (fetched.fiatSources)
          fiatSources[currency] = fetched.fiatSources[currency]
      }
      const rate = checkoutSparkAuthorizedPricingRateSchema.parse({
        rate: fetched.rate,
        fetchedAt: fetched.fetchedAt,
        source: fetched.source,
        ...(Object.keys(fiatUsdRates).length
          ? {
              fiatUsdRates,
              fiatSource: fetched.fiatSource,
              ...(fetched.fiatSources ? { fiatSources } : {}),
            }
          : {}),
      })
      if (
        rate.fetchedAt > input.nowMs() ||
        input.nowMs() >= rate.fetchedAt + DEFAULT_PRICING_RATE_MAX_AGE_MS
      )
        throw new Error("Checkout pricing is unavailable.")
      // Do not discard still-valid coverage during an incomplete refresh, or mix old/new ages.
      if (
        valid(previous, input) &&
        Object.keys(previous!.rate.fiatUsdRates ?? {}).some(
          (currency) => rate.fiatUsdRates?.[currency] === undefined
        )
      )
        throw new Error("Pricing refresh has incomplete coverage.")
      const candidate = createCheckoutSparkPricingRateAttestation({
        rate,
        keyId: input.keyId,
        privateKeyHex: input.privateKeyHex,
        issuedAtMs: input.nowMs(),
      })
      snapshot = freezeCheckoutSparkPricingRateAttestation(candidate)
      refreshState = "ok"
      nextAttemptMs = 0
      if (input.store) {
        try {
          await cacheDeadline(input.store.write(key, snapshot, input.nowMs()))
          storeState = "ok"
        } catch {
          storeState =
            "unavailable" /* Cache storage never extends or invalidates a genuine fresh quote. */
        }
      }
      return snapshot
    })().catch((error) => {
      refreshState = "unavailable"
      nextAttemptMs = input.nowMs() + FAILED_REFRESH_PAUSE_MS
      throw error
    })
    pending = refresh
    void refresh
      .finally(() => {
        if (pending === refresh) pending = undefined
      })
      .catch(() => {})
    return refresh
  }

  return {
    diagnostics(): HeadersInit {
      return {
        "x-pricing-cache": cacheState,
        "x-pricing-refresh": refreshState,
        "x-pricing-cache-store": storeState,
        "server-timing": attempts
          .map((a) => `${a.provider};dur=${a.durationMs};desc="${a.outcome}"`)
          .join(", "),
      }
    },
    async snapshot(
      input: SnapshotInput
    ): Promise<CheckoutSparkPricingRateAttestation> {
      const key = `${input.keyId}:${input.publicKey}:${COMMON_FIAT_CURRENCIES.join(",")}`
      cacheState = valid(snapshot, input) ? "memory" : "miss"
      if (!valid(snapshot, input) && input.store && !pending) {
        try {
          const stored = freezeCheckoutSparkPricingRateAttestation(
            await cacheDeadline(input.store.read(key))
          )
          if (
            Object.keys(stored.rate.fiatUsdRates ?? {}).some(
              (c) => !COMMON_FIAT_CURRENCIES.includes(c)
            )
          )
            throw new Error("Pricing cache policy changed.")
          if (
            verifyCheckoutSparkPricingRateAttestation({
              attestation: stored,
              pricing: { version: 1, rate: stored.rate },
              acceptedAtMs: input.nowMs(),
              nowMs: input.nowMs(),
              trustedPublicKeys: new Map([[input.keyId, input.publicKey]]),
            }) !== "verified"
          )
            throw new Error("Invalid pricing cache.")
          snapshot = stored
          cacheState = "edge"
          storeState = "ok"
        } catch {
          storeState =
            "miss" /* Invalid, expired and evicted entries require a live fetch. */
        }
      }
      if (valid(snapshot, input)) {
        if (
          input.nowMs() - snapshot!.rate.fetchedAt >= REFRESH_AFTER_MS &&
          input.nowMs() >= nextAttemptMs
        ) {
          const refresh = startRefresh(input, key)
          if (input.waitUntil) input.waitUntil(refresh.catch(() => {}))
          else {
            try {
              await refresh
            } catch {
              /* Preserve the original snapshot only until signed expiry. */
            }
          }
        }
        if (valid(snapshot, input)) return snapshot!
      }
      if (input.nowMs() < nextAttemptMs && !pending)
        throw new Error("Checkout pricing is unavailable.")
      await startRefresh(input, key)
      if (!valid(snapshot, input))
        throw new Error("Checkout pricing is unavailable.")
      return snapshot!
    },
  }
}

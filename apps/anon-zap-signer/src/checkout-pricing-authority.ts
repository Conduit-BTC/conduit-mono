import {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  SUPPORTED_PRODUCT_PRICE_CURRENCIES,
  type BtcUsdRateQuote,
} from "@conduit/core/pricing"
import { fetchTrustedPricingRateQuote } from "@conduit/core/pricing/trusted-rate-provider"
import {
  checkoutSparkAuthorizedPricingRateSchema,
  parseCheckoutSparkPricingAuthorityPublicKeys,
  type CheckoutSparkPricingRateAttestation,
} from "@conduit/core/protocol/checkout-spark-pricing-authority"
import {
  createCheckoutSparkPricingRateAttestation,
  getCheckoutSparkPricingAuthorityPublicKey,
} from "@conduit/core/protocol/checkout-spark-pricing-authority-server"

/**
 * Dormant standalone Worker entry, intentionally not wired to the anonymous-zap
 * Worker. Deployment and the shared public trust ring require separate approval.
 * This service sees currency codes only, never a cart, order, identity or invoice.
 */
export interface CheckoutSparkPricingAuthorityEnv {
  CHECKOUT_SPARK_PRICING_ALLOWED_ORIGINS?: string
  CHECKOUT_SPARK_PRICING_KEY_ID?: string
  CHECKOUT_SPARK_PRICING_PRIVATE_KEY_HEX?: string
  CHECKOUT_SPARK_PRICING_PUBLIC_KEYS?: string
  CHECKOUT_SPARK_PRICING_RATE_LIMITER?: {
    limit(input: { key: string }): Promise<{ success: boolean }>
  }
}

interface CheckoutSparkPricingAuthorityDependencies {
  nowMs: () => number
  fetchPricingRate: typeof fetchTrustedPricingRateQuote
  cache: ReturnType<typeof createCheckoutSparkPricingAuthorityCache>
}

const COMMON_FIAT_CURRENCIES = SUPPORTED_PRODUCT_PRICE_CURRENCIES.filter(
  (currency) => currency !== "SATS" && currency !== "USD"
)
const PROVIDER_REFRESH_AFTER_MS = 4 * 60_000

/** Per-isolate bounded caches contain generic rates and public attestations only. */
export function createCheckoutSparkPricingAuthorityCache() {
  let rate: BtcUsdRateQuote | undefined
  let pending: Promise<BtcUsdRateQuote> | undefined
  const signed = new Map<
    string,
    { rate: BtcUsdRateQuote; snapshot: CheckoutSparkPricingRateAttestation }
  >()
  const isValid = (candidate: BtcUsdRateQuote | undefined, nowMs: number) =>
    candidate &&
    candidate.fetchedAt <= nowMs &&
    nowMs < candidate.fetchedAt + DEFAULT_PRICING_RATE_MAX_AGE_MS
  return {
    async snapshot(input: {
      keyId: string
      privateKeyHex: string
      publicKey: string
      nowMs: () => number
      fetchPricingRate: typeof fetchTrustedPricingRateQuote
    }): Promise<CheckoutSparkPricingRateAttestation> {
      const previous = rate
      const currentTime = input.nowMs()
      if (
        !isValid(rate, currentTime) ||
        currentTime - rate!.fetchedAt >= PROVIDER_REFRESH_AFTER_MS
      ) {
        if (!pending) {
          pending = input
            .fetchPricingRate({
              preferredFiatCurrencies: COMMON_FIAT_CURRENCIES,
              includeFiatRates: true,
              nowMs: input.nowMs,
              timeoutMs: 3_000,
            })
            .then((fetched) => {
              const fiatUsdRates: Record<string, number> = {}
              const fiatSources: NonNullable<BtcUsdRateQuote["fiatSources"]> =
                {}
              for (const currency of COMMON_FIAT_CURRENCIES) {
                const value = fetched.fiatUsdRates?.[currency]
                if (
                  value === undefined ||
                  !Number.isFinite(value) ||
                  value <= 0
                )
                  continue
                fiatUsdRates[currency] = value
                if (fetched.fiatSources)
                  fiatSources[currency] = fetched.fiatSources[currency]
              }
              const candidate = checkoutSparkAuthorizedPricingRateSchema.parse({
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
              if (!isValid(candidate, input.nowMs()))
                throw new Error("Checkout pricing is unavailable.")
              if (candidate.fiatUsdRates) Object.freeze(candidate.fiatUsdRates)
              if (candidate.fiatSources) Object.freeze(candidate.fiatSources)
              rate = Object.freeze(candidate)
              return rate
            })
          const lookup = pending
          void lookup
            .finally(() => {
              if (pending === lookup) pending = undefined
            })
            .catch(() => {})
        }
        try {
          await pending
        } catch (error) {
          if (!isValid(previous, input.nowMs())) throw error
          rate = previous
        }
      }
      if (!rate || !isValid(rate, input.nowMs()))
        throw new Error("Checkout pricing is unavailable.")
      const key = `${input.keyId}:${input.publicKey}`
      const existing = signed.get(key)
      if (existing?.rate === rate) return existing.snapshot
      const snapshot = createCheckoutSparkPricingRateAttestation({
        rate,
        keyId: input.keyId,
        privateKeyHex: input.privateKeyHex,
        issuedAtMs: input.nowMs(),
      })
      if (signed.size >= 16) signed.delete(signed.keys().next().value!)
      signed.set(key, { rate, snapshot })
      return snapshot
    },
  }
}

const sharedPricingAuthorityCache = createCheckoutSparkPricingAuthorityCache()

function requestCurrencies(input: unknown): string[] {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !("currencies" in input) ||
    !Array.isArray(input.currencies) ||
    input.currencies.length < 1 ||
    input.currencies.length > SUPPORTED_PRODUCT_PRICE_CURRENCIES.length - 1 ||
    !input.currencies.every(
      (currency: unknown): currency is string =>
        typeof currency === "string" &&
        SUPPORTED_PRODUCT_PRICE_CURRENCIES.some(
          (supported) => supported !== "SATS" && supported === currency
        )
    )
  )
    throw new Error("Pricing request is unavailable.")
  return [...new Set<string>(input.currencies)].sort()
}

function allowedOrigins(raw: string | undefined): ReadonlySet<string> | null {
  if (!raw || raw.length > 4_096) return null
  const values = raw.split(",").map((value) => value.trim())
  if (values.length > 32) return null
  const origins = new Set<string>()
  try {
    for (const value of values) {
      const url = new URL(value)
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.origin !== value
      )
        return null
      origins.add(value)
    }
  } catch {
    return null
  }
  return origins.size ? origins : null
}

function response(
  body: unknown,
  status: number,
  origin?: string,
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers(extraHeaders)
  headers.set("content-type", "application/json")
  headers.set("cache-control", "no-store")
  headers.set("x-content-type-options", "nosniff")
  headers.set("vary", "Origin")
  if (origin) {
    headers.set("access-control-allow-origin", origin)
    headers.set("access-control-allow-methods", "POST, OPTIONS")
    headers.set("access-control-allow-headers", "content-type")
  }
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers,
  })
}

async function readBoundedRequest(request: Request): Promise<unknown> {
  const maximumBytes = 2_048
  const declaredLength = request.headers.get("content-length")
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)
  )
    throw new Error("Pricing request is unavailable.")
  if (!request.body) throw new Error("Pricing request is unavailable.")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    void reader.cancel().catch(() => {})
  }, 2_000)
  try {
    for (;;) {
      const chunk = await reader.read()
      if (timedOut) throw new Error("Pricing request is unavailable.")
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maximumBytes)
        throw new Error("Pricing request is unavailable.")
      chunks.push(chunk.value)
    }
  } finally {
    clearTimeout(timeout)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

async function applyRateLimit(
  env: CheckoutSparkPricingAuthorityEnv
): Promise<"ok" | "limited" | "unavailable"> {
  if (!env.CHECKOUT_SPARK_PRICING_RATE_LIMITER) return "unavailable"
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      env.CHECKOUT_SPARK_PRICING_RATE_LIMITER.limit({
        key: "checkout-spark-pricing:global",
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Unavailable.")), 2_000)
      }),
    ])
    return result.success ? "ok" : "limited"
  } catch {
    return "unavailable"
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export async function handleCheckoutSparkPricingAuthorityRequest(
  request: Request,
  env: CheckoutSparkPricingAuthorityEnv,
  overrides: Partial<CheckoutSparkPricingAuthorityDependencies> = {}
): Promise<Response> {
  const url = new URL(request.url)
  if (
    url.pathname !== "/api/checkout-spark-pricing" ||
    url.search ||
    url.username ||
    url.password
  )
    return response({ error: "Not found." }, 404)
  const origins = allowedOrigins(env.CHECKOUT_SPARK_PRICING_ALLOWED_ORIGINS)
  if (!origins)
    return response({ error: "Checkout pricing is unavailable." }, 503)
  const origin = request.headers.get("origin") ?? ""
  if (!origins.has(origin))
    return response({ error: "Origin is not allowed." }, 403)
  if (request.method === "OPTIONS") return response(null, 204, origin)
  if (request.method !== "POST")
    return response({ error: "Method is not allowed." }, 405, origin, {
      allow: "POST, OPTIONS",
    })
  const keyId = env.CHECKOUT_SPARK_PRICING_KEY_ID
  const privateKeyHex = env.CHECKOUT_SPARK_PRICING_PRIVATE_KEY_HEX
  const publicKeys = parseCheckoutSparkPricingAuthorityPublicKeys(
    env.CHECKOUT_SPARK_PRICING_PUBLIC_KEYS
  )
  if (
    !keyId ||
    !privateKeyHex ||
    !publicKeys ||
    publicKeys.get(keyId) !==
      getCheckoutSparkPricingAuthorityPublicKey(privateKeyHex)
  )
    return response({ error: "Checkout pricing is unavailable." }, 503, origin)
  const rateLimit = await applyRateLimit(env)
  if (rateLimit !== "ok")
    return response(
      {
        error:
          rateLimit === "limited"
            ? "Checkout pricing is rate limited."
            : "Checkout pricing is unavailable.",
      },
      rateLimit === "limited" ? 429 : 503,
      origin,
      rateLimit === "limited" ? { "retry-after": "60" } : undefined
    )
  try {
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      throw new Error("Pricing request is unavailable.")
    requestCurrencies(await readBoundedRequest(request))
  } catch {
    return response({ error: "Invalid pricing request." }, 400, origin)
  }
  const dependencies = {
    nowMs: () => Date.now(),
    fetchPricingRate: fetchTrustedPricingRateQuote,
    cache:
      Object.keys(overrides).length > 0
        ? createCheckoutSparkPricingAuthorityCache()
        : sharedPricingAuthorityCache,
    ...overrides,
  }
  try {
    const pricingAuthority = await dependencies.cache.snapshot({
      keyId,
      privateKeyHex,
      publicKey: publicKeys.get(keyId)!,
      nowMs: dependencies.nowMs,
      fetchPricingRate: dependencies.fetchPricingRate,
    })
    return response(
      {
        pricing: { version: 1, rate: pricingAuthority.rate },
        pricingAuthority,
      },
      200,
      origin
    )
  } catch {
    return response({ error: "Checkout pricing is unavailable." }, 503, origin)
  }
}

export default {
  fetch(request: Request, env: CheckoutSparkPricingAuthorityEnv) {
    return handleCheckoutSparkPricingAuthorityRequest(request, env)
  },
}

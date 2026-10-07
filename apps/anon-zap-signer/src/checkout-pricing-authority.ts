import { SUPPORTED_PRODUCT_PRICE_CURRENCIES } from "@conduit/core/pricing"
import { fetchTrustedPricingRateQuote } from "@conduit/core/pricing/trusted-rate-provider"
import { parseCheckoutSparkPricingAuthorityPublicKeys } from "@conduit/core/protocol/checkout-spark-pricing-authority"
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
}

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
  let currencies: string[]
  try {
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      throw new Error("Pricing request is unavailable.")
    currencies = requestCurrencies(await readBoundedRequest(request))
  } catch {
    return response({ error: "Invalid pricing request." }, 400, origin)
  }
  const dependencies = {
    nowMs: () => Date.now(),
    fetchPricingRate: fetchTrustedPricingRateQuote,
    ...overrides,
  }
  try {
    const requiredFiatCurrencies = currencies.filter(
      (currency) => currency !== "USD"
    )
    const fetched = await dependencies.fetchPricingRate({
      requiredFiatCurrencies,
      includeFiatRates: requiredFiatCurrencies.length > 0,
      nowMs: dependencies.nowMs,
      timeoutMs: 3_000,
    })
    const fiatUsdRates: Record<string, number> = {}
    for (const currency of requiredFiatCurrencies) {
      const value = fetched.fiatUsdRates?.[currency]
      if (value === undefined || !Number.isFinite(value) || value <= 0)
        throw new Error("Checkout pricing is unavailable.")
      fiatUsdRates[currency] = value
    }
    const rate = {
      rate: fetched.rate,
      fetchedAt: fetched.fetchedAt,
      source: fetched.source,
      ...(requiredFiatCurrencies.length
        ? { fiatUsdRates, fiatSource: fetched.fiatSource }
        : {}),
    }
    const pricingAuthority = createCheckoutSparkPricingRateAttestation({
      rate,
      keyId,
      privateKeyHex,
      issuedAtMs: dependencies.nowMs(),
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

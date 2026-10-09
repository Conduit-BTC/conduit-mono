import {
  PRICING_PROVIDER_URLS,
  type PricingProvider,
} from "@conduit/core/pricing/common-rate-provider"

/** Operator deployment configuration only. No request field can activate a fault. */
export function previewPricingQualification(
  raw: string | undefined,
  hostname: string,
  now: number
):
  | {
      phase: "normal" | "secondary" | "tertiary" | "outage" | "complete"
      fetchImpl?: typeof fetch
    }
  | undefined {
  if (!raw) return undefined
  if (raw.length > 512)
    throw new Error("Invalid preview qualification configuration.")
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid preview qualification configuration.")
  const config = value as Record<string, unknown>
  if (
    Object.keys(config).sort().join(",") !== "endMs,hostname,startMs" ||
    config.hostname !== hostname ||
    !/^conduit-checkout-pricing-preview\.[a-z0-9-]+\.workers\.dev$/.test(
      hostname
    ) ||
    typeof config.startMs !== "number" ||
    !Number.isSafeInteger(config.startMs) ||
    config.startMs <= 0 ||
    typeof config.endMs !== "number" ||
    !Number.isSafeInteger(config.endMs) ||
    config.endMs - config.startMs < 18 * 60_000 ||
    config.endMs - config.startMs > 30 * 60_000
  )
    throw new Error("Invalid preview qualification configuration.")
  if (now < config.startMs) return { phase: "normal" }
  if (now >= config.endMs) return { phase: "complete" }
  const stage = Math.min(
    2,
    Math.floor((3 * (now - config.startMs)) / (config.endMs - config.startMs))
  )
  const blocked: readonly PricingProvider[] =
    stage === 0
      ? ["mempool", "frankfurter"]
      : stage === 1
        ? ["mempool", "coinbase", "frankfurter", "floatrates"]
        : (Object.keys(PRICING_PROVIDER_URLS) as PricingProvider[])
  const blockedUrls = new Set<string>(
    blocked.map((p) => PRICING_PROVIDER_URLS[p])
  )
  return {
    phase: (["secondary", "tertiary", "outage"] as const)[stage],
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
      blockedUrls.has(String(input))
        ? Promise.resolve(new Response(null, { status: 503 }))
        : fetch(input, init)) as typeof fetch,
  }
}

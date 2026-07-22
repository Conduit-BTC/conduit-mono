import { describe, expect, it } from "bun:test"
import type {
  AuthorizedAnonZapPricing,
  BtcUsdRateQuote,
  SignedPublicNostrEvent,
} from "@conduit/core"
import { fetchTrustedPricingRateQuote } from "@conduit/core/pricing/trusted-rate-provider"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import {
  authorizeAnonZapRequest,
  enforceAnonZapAuthorityRateLimit,
  getAnonZapCommerceRelays,
  signAuthorizedAnonZapRequest,
  type AnonZapPagesDependencies,
  type AnonZapPagesEnv,
} from "../apps/market/functions/_lib/anon-zap-checkout-auth"
import {
  onRequest as anonZapConfigMethod,
  onRequestGet as getAnonZapConfig,
} from "../apps/market/functions/api/anon-zap-config"
import {
  onRequest as authorizeAnonZapMethod,
  onRequestOptions as authorizeAnonZapOptions,
  onRequestPost as authorizeAnonZap,
} from "../apps/market/functions/api/anon-zap-authorize"
import {
  onRequest as signAnonZapMethod,
  onRequestOptions as signAnonZapOptions,
  onRequestPost as signAnonZap,
} from "../apps/market/functions/api/anon-zap-sign"
import { onRequestOptions as rootAuthorizeAnonZapOptions } from "../functions/api/anon-zap-authorize"
import { onRequestGet as getRootAnonZapConfig } from "../functions/api/anon-zap-config"
import { onRequestOptions as rootSignAnonZapOptions } from "../functions/api/anon-zap-sign"

const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 4])
const SHOPPER_SECRET = Uint8Array.from([...new Uint8Array(31), 6])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const NOW_SECONDS = 1_800_000_000
const PRODUCT_D_TAG = "cnd-150-pages-test"
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}`
const AUTH_SECRET = "11".repeat(32)
const ATTESTATION_KEY_ID = "test-2026"
const ATTESTATION_PRIVATE_KEY_HEX = "0".repeat(63) + "9"
const ATTESTATION_PUBKEY = getPublicKey(
  Uint8Array.from([...new Uint8Array(31), 9])
)

type AuthorizationResponse = {
  authorizationToken: string
  expiresAt: number
  draft: {
    kind: number
    createdAt: number
    content: string
    tags: string[][]
  }
  relayUrls: string[]
  pricing: AuthorizedAnonZapPricing
}

type SignerCall = {
  url: string
  body: string
  headers: Headers
}

function signMerchantEvent(input: {
  kind: number
  tags?: string[][]
  content?: string
}): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: input.kind,
      created_at: NOW_SECONDS - 60,
      tags: input.tags ?? [],
      content: input.content ?? "",
    },
    MERCHANT_SECRET
  )
}

function productEvent(
  overrides: {
    price?: number
    currency?: string
    shippingCost?: number
    shippingCurrency?: string
  } = {}
): SignedPublicNostrEvent {
  const currency = overrides.currency ?? "SATS"
  const tags: string[][] = [
    ["d", PRODUCT_D_TAG],
    ["title", "CND-150 Pages test"],
    ["price", String(overrides.price ?? 10), currency],
    [
      "type",
      "simple",
      overrides.shippingCost === undefined ? "digital" : "physical",
    ],
    ["image", "https://cdn.example/cnd-150-pages.png"],
    ["checkout_public_zaps", "true"],
    ["checkout_zap_message_policy", "generic_only"],
  ]
  if (overrides.shippingCost !== undefined) {
    tags.push([
      "shipping_cost",
      String(overrides.shippingCost),
      overrides.shippingCurrency ?? currency,
    ])
    tags.push(["shipping_country", "US"])
  }
  return signMerchantEvent({
    kind: 30402,
    tags,
    content: "A signed public Pages authorization fixture.",
  })
}

function profileEvent(): SignedPublicNostrEvent {
  return signMerchantEvent({
    kind: 0,
    content: JSON.stringify({ lud16: "merchant@wallet.example" }),
  })
}

function rateLimitService(
  handler: (
    keys: string[],
    scope: "authorization" | "authority"
  ) => boolean | Promise<boolean> = () => true
) {
  return {
    async fetch(request: Request) {
      const body = (await request.json()) as {
        keys: string[]
        scope: "authorization" | "authority"
      }
      return new Response(null, {
        status: (await handler(body.keys, body.scope)) ? 204 : 429,
      })
    },
  }
}

function env(overrides: Partial<AnonZapPagesEnv> = {}): AnonZapPagesEnv {
  return {
    ANON_ZAP_ALLOWED_ORIGINS:
      "https://shop.conduit.market,https://*.conduit-market-coo.pages.dev",
    ANON_ZAP_SIGNER_URL: "https://anon-signer.example",
    ANON_ZAP_SIGNER_ALLOWED_HOSTS: "anon-signer.example",
    ANON_SIGNER_REQUEST_AUTH_SECRET: AUTH_SECRET,
    ANON_ZAP_COMMERCE_RELAYS: "wss://commerce.example",
    ANON_ZAP_RECEIPT_RELAYS: "wss://receipts.example",
    ANON_ZAP_LNURL_ALLOWED_HOSTS: "wallet.example",
    ANON_ZAP_PROVIDER_ATTESTATION_KEY_ID: ATTESTATION_KEY_ID,
    ANON_ZAP_PROVIDER_ATTESTATION_PRIVATE_KEY_HEX: ATTESTATION_PRIVATE_KEY_HEX,
    ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS: `${ATTESTATION_KEY_ID}:${ATTESTATION_PUBKEY}`,
    ANON_ZAP_RATE_LIMIT_SERVICE: rateLimitService(),
    ...overrides,
  }
}

function post(
  url: string,
  body: unknown,
  origin = "https://shop.conduit.market"
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "cf-connecting-ip": "203.0.113.10",
    },
    body: JSON.stringify(body),
  })
}

function checkoutIntent(extra: Record<string, unknown> = {}) {
  return {
    merchantPubkey: MERCHANT_PUBKEY,
    items: [{ productAddress: PRODUCT_ADDRESS, quantity: 1 }],
    ...extra,
  }
}

function createDependencies(
  options: {
    nowSeconds?: number
    signerStatus?: number
    signerCalls?: SignerCall[]
    publicEventFilters?: unknown[]
    product?: SignedPublicNostrEvent
    pricingRate?: BtcUsdRateQuote
    pricingRateCalls?: string[][]
    pricingRateError?: Error
    incompleteRead?:
      "products" | "profile" | "address_deletions" | "event_deletions"
    saturatedRead?:
      "products" | "profile" | "address_deletions" | "event_deletions"
  } = {}
): AnonZapPagesDependencies {
  const signerCalls = options.signerCalls ?? []
  return {
    async fetchPublicEvents(filter, relayUrls) {
      options.publicEventFilters?.push(filter)
      const readKind = filter.kinds.includes(30402)
        ? "products"
        : filter.kinds.includes(0)
          ? "profile"
          : filter["#a"]
            ? "address_deletions"
            : "event_deletions"
      const status = options.incompleteRead === readKind ? "partial" : "success"
      let events: SignedPublicNostrEvent[] = []
      if (filter.kinds.includes(30402)) {
        events = [options.product ?? productEvent()]
      }
      if (filter.kinds.includes(0)) events = [profileEvent()]
      return {
        events,
        relays: relayUrls.map((relayUrl) => ({
          relayUrl,
          status,
          eventCount:
            options.saturatedRead === readKind ? filter.limit : events.length,
        })),
      }
    },
    async fetchPricingRateQuote(currencies) {
      options.pricingRateCalls?.push([...currencies])
      if (options.pricingRateError) throw options.pricingRateError
      return (
        options.pricingRate ?? {
          rate: 100_000,
          fetchedAt: NOW_SECONDS * 1000,
          source: "mempool",
        }
      )
    },
    async fetchSigner(input, init) {
      const body = String(init?.body ?? "")
      const headers = new Headers(init?.headers)
      signerCalls.push({ url: String(input), body, headers })
      const status = options.signerStatus ?? 200
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status,
          headers: { "content-type": "application/json" },
        })
      }
      const parsed = JSON.parse(body) as {
        zapRequest: AuthorizationResponse["draft"]
      }
      const rawEvent = finalizeEvent(
        {
          kind: parsed.zapRequest.kind,
          created_at: parsed.zapRequest.createdAt,
          content: parsed.zapRequest.content,
          tags: parsed.zapRequest.tags,
        },
        SHOPPER_SECRET
      )
      return Response.json({ id: rawEvent.id, rawEvent })
    },
    nowSeconds: () => options.nowSeconds ?? NOW_SECONDS,
  }
}

async function issueAuthorization(
  dependencies: AnonZapPagesDependencies,
  body: Record<string, unknown> = checkoutIntent()
): Promise<AuthorizationResponse> {
  const response = await authorizeAnonZapRequest(
    post("https://shop.conduit.market/api/anon-zap-authorize", body),
    env(),
    dependencies
  )
  expect(response.status).toBe(200)
  return (await response.json()) as AuthorizationResponse
}

function decodeAuthorizationToken(token: string): Record<string, unknown> {
  const encoded = token.split(".")[0]!
  const padded = encoded
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(encoded.length / 4) * 4, "=")
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

async function hmacHex(
  secret: string,
  timestamp: string,
  body: string
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`)
  )
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

describe("Anon zap Pages proxy", () => {
  it("derives trusted cross-fiat rates from the primary provider", async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return Response.json({ USD: 100_000, EUR: 80_000 })
    }) as unknown as typeof fetch

    const quote = await fetchTrustedPricingRateQuote({
      requiredFiatCurrencies: ["EUR"],
      fetchImpl,
      nowMs: () => NOW_SECONDS * 1000,
    })

    expect(calls).toEqual(["https://mempool.space/api/v1/prices"])
    expect(quote).toMatchObject({
      rate: 100_000,
      fetchedAt: NOW_SECONDS * 1000,
      source: "mempool",
      fiatUsdRates: { EUR: 1.25 },
      fiatSource: "mempool",
    })
  })

  it("augments the primary quote when all shopper fiat rates are requested", async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes("mempool.space")) {
        return Response.json({ USD: 100_000, EUR: 80_000 })
      }
      if (url.includes("frankfurter.dev")) {
        return Response.json({ rates: { EUR: 0.8, JPY: 150 } })
      }
      throw new Error(`Unexpected provider ${url}`)
    }) as unknown as typeof fetch

    const quote = await fetchTrustedPricingRateQuote({
      includeFiatRates: true,
      fetchImpl,
      nowMs: () => NOW_SECONDS * 1000,
    })

    expect(calls).toEqual([
      "https://mempool.space/api/v1/prices",
      "https://api.frankfurter.dev/v1/latest?base=USD",
    ])
    expect(quote).toMatchObject({
      rate: 100_000,
      source: "mempool",
      fiatUsdRates: { EUR: 1.25, JPY: 1 / 150 },
      fiatSource: "frankfurter",
    })
  })

  it("falls back to independent BTC and fiat providers", async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes("mempool.space"))
        return new Response(null, { status: 503 })
      if (url.includes("coinbase.com")) {
        return Response.json({ data: { amount: "100000" } })
      }
      if (url.includes("frankfurter.dev")) {
        return Response.json({ rates: { EUR: 0.8 } })
      }
      throw new Error(`Unexpected provider ${url}`)
    }) as unknown as typeof fetch

    const quote = await fetchTrustedPricingRateQuote({
      requiredFiatCurrencies: ["EUR"],
      fetchImpl,
      nowMs: () => NOW_SECONDS * 1000,
    })

    expect(calls).toEqual([
      "https://mempool.space/api/v1/prices",
      "https://api.coinbase.com/v2/prices/BTC-USD/spot",
      "https://api.frankfurter.dev/v1/latest?base=USD",
    ])
    expect(quote).toMatchObject({
      rate: 100_000,
      source: "coinbase",
      fiatUsdRates: { EUR: 1.25 },
      fiatSource: "frankfurter",
    })
  })

  it("fails fast when the signer boundary is disabled", async () => {
    let dependencyCalls = 0
    const dependencies = createDependencies()
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env({ ANON_ZAP_SIGNER_URL: "" }),
      {
        ...dependencies,
        async fetchPublicEvents(filter, relayUrls) {
          dependencyCalls += 1
          return dependencies.fetchPublicEvents(filter, relayUrls)
        },
      }
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap signer is not configured.",
    })
    expect(dependencyCalls).toBe(0)
  })

  it("rejects unsafe or non-allowlisted signer Worker URLs before relay access", async () => {
    const cases: Array<Partial<AnonZapPagesEnv>> = [
      { ANON_ZAP_SIGNER_URL: "http://anon-signer.example" },
      { ANON_ZAP_SIGNER_URL: "https://user@anon-signer.example" },
      { ANON_ZAP_SIGNER_URL: "https://anon-signer.example?token=secret" },
      { ANON_ZAP_SIGNER_URL: "https://anon-signer.example#fragment" },
      { ANON_ZAP_SIGNER_URL: "https://anon-signer.example:8443" },
      {
        ANON_ZAP_SIGNER_URL: "https://127.0.0.1:7010",
        ANON_ZAP_SIGNER_ALLOWED_HOSTS: "127.0.0.1",
      },
      {
        ANON_ZAP_SIGNER_URL: "https://8.8.8.8",
        ANON_ZAP_SIGNER_ALLOWED_HOSTS: "8.8.8.8",
      },
      { ANON_ZAP_SIGNER_ALLOWED_HOSTS: "other-signer.example" },
    ]

    for (const overrides of cases) {
      let relayCalls = 0
      const dependencies = createDependencies()
      const response = await authorizeAnonZapRequest(
        post(
          "https://shop.conduit.market/api/anon-zap-authorize",
          checkoutIntent()
        ),
        env(overrides),
        {
          ...dependencies,
          async fetchPublicEvents(filter, relayUrls) {
            relayCalls += 1
            return dependencies.fetchPublicEvents(filter, relayUrls)
          },
        }
      )

      expect(response.status).toBe(403)
      expect(relayCalls).toBe(0)
    }
  })

  it("fails fast when the signer host allow-list is missing", async () => {
    let relayCalls = 0
    const dependencies = createDependencies()
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env({ ANON_ZAP_SIGNER_ALLOWED_HOSTS: "" }),
      {
        ...dependencies,
        async fetchPublicEvents(filter, relayUrls) {
          relayCalls += 1
          return dependencies.fetchPublicEvents(filter, relayUrls)
        },
      }
    )

    expect(response.status).toBe(503)
    expect(relayCalls).toBe(0)
  })

  it("allows explicitly opted-in local signer URLs for development", async () => {
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env({
        ANON_ZAP_SIGNER_URL: "http://localhost:7010",
        ANON_ZAP_SIGNER_ALLOWED_HOSTS: "localhost",
        ANON_ZAP_ALLOW_INSECURE_LOCALHOST: "true",
      }),
      createDependencies()
    )

    expect(response.status).toBe(200)
  })

  it("fails closed on an undersized request-auth secret", async () => {
    let dependencyCalls = 0
    const dependencies = createDependencies()
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env({ ANON_SIGNER_REQUEST_AUTH_SECRET: "too-short" }),
      {
        ...dependencies,
        async fetchPublicEvents(filter, relayUrls) {
          dependencyCalls += 1
          return dependencies.fetchPublicEvents(filter, relayUrls)
        },
      }
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error:
        "Anon zap authorization is not configured with a valid 256-bit secret.",
    })
    expect(dependencyCalls).toBe(0)
  })

  it("fails fast when the provider attestation key ring does not match the signer", async () => {
    let relayCalls = 0
    const dependencies = createDependencies()
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env({
        ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS: `${ATTESTATION_KEY_ID}:${"f".repeat(64)}`,
      }),
      {
        ...dependencies,
        async fetchPublicEvents(filter, relayUrls) {
          relayCalls += 1
          return dependencies.fetchPublicEvents(filter, relayUrls)
        },
      }
    )

    expect(response.status).toBe(503)
    expect(relayCalls).toBe(0)
  })

  it("requires the Worker-backed authorization rate-limit service", async () => {
    let relayCalls = 0
    const dependencies = createDependencies()
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env({ ANON_ZAP_RATE_LIMIT_SERVICE: undefined }),
      {
        ...dependencies,
        async fetchPublicEvents(filter, relayUrls) {
          relayCalls += 1
          return dependencies.fetchPublicEvents(filter, relayUrls)
        },
      }
    )

    expect(response.status).toBe(503)
    expect(relayCalls).toBe(0)
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap authorization rate limiting is unavailable.",
    })
  })

  it("applies all authorization buckets before public relay work without exposing the source", async () => {
    const keys: string[] = []
    const scopes: string[] = []
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env({
        ANON_ZAP_RATE_LIMIT_SERVICE: rateLimitService((received, scope) => {
          keys.push(...received)
          scopes.push(scope)
          return true
        }),
      }),
      createDependencies()
    )

    expect(response.status).toBe(200)
    expect(scopes).toEqual(["authorization"])
    expect(keys[0]).toBe("authorization:global")
    expect(keys[1]).toMatch(/^authorization:source:[0-9a-f]{64}$/)
    expect(keys[2]).toMatch(/^authorization:merchant:[0-9a-f]{64}$/)
    expect(JSON.stringify(keys)).not.toContain("203.0.113.10")
    expect(JSON.stringify(keys)).not.toContain(MERCHANT_PUBKEY)
  })

  it("fails closed when Cloudflare request-source identity is unavailable", async () => {
    const request = post(
      "https://shop.conduit.market/api/anon-zap-authorize",
      checkoutIntent()
    )
    request.headers.delete("cf-connecting-ip")
    const response = await authorizeAnonZapRequest(
      request,
      env(),
      createDependencies()
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap authorization request source is unavailable.",
    })
  })

  it("returns a bounded retry response when any authorization bucket rejects", async () => {
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env({ ANON_ZAP_RATE_LIMIT_SERVICE: rateLimitService(() => false) }),
      createDependencies()
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("60")
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap authorization is rate limited.",
    })
  })

  it("fails closed before relay access when an authorization limiter is unavailable", async () => {
    let relayCalls = 0
    const dependencies = createDependencies()
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env({
        ANON_ZAP_RATE_LIMIT_SERVICE: {
          async fetch() {
            throw new Error("binding unavailable")
          },
        },
      }),
      {
        ...dependencies,
        async fetchPublicEvents(filter, relayUrls) {
          relayCalls += 1
          return dependencies.fetchPublicEvents(filter, relayUrls)
        },
      }
    )

    expect(response.status).toBe(503)
    expect(relayCalls).toBe(0)
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap authorization rate limiting is unavailable.",
    })
  })

  it("rejects malformed authorization and signing requests", async () => {
    const authorizeResponse = await authorizeAnonZap({
      request: post("https://shop.conduit.market/api/anon-zap-authorize", {}),
      env: env(),
    })
    const signResponse = await signAnonZap({
      request: post("https://shop.conduit.market/api/anon-zap-sign", {}),
      env: env(),
    })

    expect(authorizeResponse.status).toBe(400)
    expect(signResponse.status).toBe(400)
    await expect(authorizeResponse.json()).resolves.toEqual({
      error: "Invalid checkout intent.",
    })
    await expect(signResponse.json()).resolves.toEqual({
      error: "Invalid signing request.",
    })
  })

  it("rejects authorization requests from disallowed origins", async () => {
    const response = await authorizeAnonZap({
      request: post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        {},
        "https://evil.example"
      ),
      env: env(),
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: "Origin is not allowed.",
    })
  })

  it("handles CORS preflights through app and repo-root routes", () => {
    const request = new Request(
      "https://shop.conduit.market/api/anon-zap-authorize",
      {
        method: "OPTIONS",
        headers: { origin: "https://shop.conduit.market" },
      }
    )
    const authorize = authorizeAnonZapOptions({ request, env: env() })
    const sign = signAnonZapOptions({
      request: new Request("https://shop.conduit.market/api/anon-zap-sign", {
        method: "OPTIONS",
        headers: { origin: "https://shop.conduit.market" },
      }),
      env: env(),
    })
    const rootAuthorize = rootAuthorizeAnonZapOptions({ request, env: env() })
    const rootSign = rootSignAnonZapOptions({
      request: new Request("https://shop.conduit.market/api/anon-zap-sign", {
        method: "OPTIONS",
        headers: { origin: "https://shop.conduit.market" },
      }),
      env: env(),
    })

    for (const response of [authorize, sign, rootAuthorize, rootSign]) {
      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://shop.conduit.market"
      )
    }
  })

  it("publishes the exact server receipt relay configuration through both routes", async () => {
    const context = {
      request: new Request("https://shop.conduit.market/api/anon-zap-config"),
      env: env({
        ANON_ZAP_RECEIPT_RELAYS:
          "wss://receipts-a.example,wss://receipts-b.example,wss://receipts-a.example",
      }),
    }
    for (const response of [
      getAnonZapConfig(context),
      getRootAnonZapConfig(context),
    ]) {
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        receiptRelayUrls: [
          "wss://receipts-a.example",
          "wss://receipts-b.example",
        ],
      })
    }
  })

  it("exports the exact commerce relay authority", () => {
    expect(
      getAnonZapCommerceRelays(
        env({
          ANON_ZAP_COMMERCE_RELAYS:
            "wss://commerce-a.example,wss://commerce-b.example,wss://commerce-a.example",
        })
      )
    ).toEqual(["wss://commerce-a.example", "wss://commerce-b.example"])
  })

  it("rate limits authority lookups with pseudonymous source and source-recipient keys", async () => {
    const keys: string[] = []
    const request = new Request(
      "https://shop.conduit.market/api/anon-zap-authority",
      {
        headers: {
          origin: "https://shop.conduit.market",
          "cf-connecting-ip": "203.0.113.10",
        },
      }
    )
    const result = await enforceAnonZapAuthorityRateLimit(
      request,
      env({
        ANON_ZAP_RATE_LIMIT_SERVICE: rateLimitService((received) => {
          keys.push(...received)
          return true
        }),
      }),
      MERCHANT_PUBKEY
    )

    expect(result).toBeNull()
    expect(keys).toHaveLength(3)
    expect(keys[0]).toBe("authority:global")
    expect(keys[1]).toMatch(/^authority:source:[0-9a-f]{64}$/)
    expect(keys[2]).toMatch(/^authority:source-recipient:[0-9a-f]{64}$/)
    expect(JSON.stringify(keys)).not.toContain("203.0.113.10")
    expect(JSON.stringify(keys)).not.toContain(MERCHANT_PUBKEY)
  })

  it("deduplicates batched authority recipients while preserving source-recipient budgets", async () => {
    const keys: string[] = []
    const secondRecipient = "f".repeat(64)
    const result = await enforceAnonZapAuthorityRateLimit(
      new Request("https://shop.conduit.market/api/anon-zap-authority", {
        headers: {
          origin: "https://shop.conduit.market",
          "cf-connecting-ip": "203.0.113.10",
        },
      }),
      env({
        ANON_ZAP_RATE_LIMIT_SERVICE: rateLimitService((received) => {
          keys.push(...received)
          return true
        }),
      }),
      [MERCHANT_PUBKEY, MERCHANT_PUBKEY.toUpperCase(), secondRecipient]
    )

    expect(result).toBeNull()
    expect(keys).toHaveLength(4)
    expect(keys[0]).toBe("authority:global")
    expect(new Set(keys).size).toBe(4)
  })

  it("does not let one request source consume another source's recipient budget", async () => {
    const sourceRecipientKeys: string[] = []
    const rateLimitEnv = env({
      ANON_ZAP_RATE_LIMIT_SERVICE: rateLimitService((received) => {
        sourceRecipientKeys.push(
          ...received.filter((key) =>
            key.startsWith("authority:source-recipient:")
          )
        )
        return true
      }),
    })

    for (const source of ["203.0.113.10", "203.0.113.11"]) {
      const result = await enforceAnonZapAuthorityRateLimit(
        new Request("https://shop.conduit.market/api/anon-zap-authority", {
          headers: {
            origin: "https://shop.conduit.market",
            "cf-connecting-ip": source,
          },
        }),
        rateLimitEnv,
        MERCHANT_PUBKEY
      )
      expect(result).toBeNull()
    }

    expect(sourceRecipientKeys).toHaveLength(2)
    expect(new Set(sourceRecipientKeys).size).toBe(2)
  })

  it("fails authority lookup closed when its limiter is absent or rejects", async () => {
    const request = new Request(
      "https://shop.conduit.market/api/anon-zap-authority",
      {
        headers: {
          origin: "https://shop.conduit.market",
          "cf-connecting-ip": "203.0.113.10",
        },
      }
    )
    const missing = await enforceAnonZapAuthorityRateLimit(
      request,
      env({ ANON_ZAP_RATE_LIMIT_SERVICE: undefined }),
      MERCHANT_PUBKEY
    )
    const rejected = await enforceAnonZapAuthorityRateLimit(
      request,
      env({
        ANON_ZAP_RATE_LIMIT_SERVICE: rateLimitService(() => false),
      }),
      MERCHANT_PUBKEY
    )

    expect(missing?.status).toBe(503)
    expect(rejected?.status).toBe(429)
    expect(rejected?.headers.get("retry-after")).toBe("60")
  })

  it("returns JSON 405 responses for unsupported methods", async () => {
    for (const response of [
      anonZapConfigMethod(),
      authorizeAnonZapMethod(),
      signAnonZapMethod(),
    ]) {
      expect(response.status).toBe(405)
      await expect(response.json()).resolves.toEqual({
        error: "Method not allowed.",
      })
    }
  })

  it("rejects disallowed CORS preflights without allow-origin", () => {
    const response = authorizeAnonZapOptions({
      request: new Request(
        "https://shop.conduit.market/api/anon-zap-authorize",
        {
          method: "OPTIONS",
          headers: { origin: "https://evil.example" },
        }
      ),
      env: env(),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("does not allow an unexpected port through a preview wildcard", async () => {
    const response = await authorizeAnonZap({
      request: post(
        "https://preview.conduit-market-coo.pages.dev:444/api/anon-zap-authorize",
        checkoutIntent(),
        "https://preview.conduit-market-coo.pages.dev:444"
      ),
      env: env(),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("uses same-origin as the fallback allowed origin", async () => {
    const response = await authorizeAnonZap({
      request: post(
        "https://market.example/api/anon-zap-authorize",
        {},
        "https://market.example"
      ),
      env: env({ ANON_ZAP_ALLOWED_ORIGINS: undefined }),
    })

    expect(response.status).toBe(400)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://market.example"
    )
  })

  it("rejects private checkout fields at the authorization boundary", async () => {
    const privateValues = {
      orderId: "private-order-id",
      email: "buyer-private@example.com",
      phone: "+15551234567",
      shippingAddress: "123 Private Street",
      invoice: "lnbc-private-invoice",
      note: "private buyer note",
      walletSecret: "nostr+walletconnect://private",
    }
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent(privateValues)
      ),
      env(),
      createDependencies()
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Invalid checkout intent.",
    })
  })

  it("rejects a browser-provided amount at the authorization boundary", async () => {
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent({ amountMsats: 1 })
      ),
      env(),
      createDependencies()
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Invalid checkout intent.",
    })
  })

  it("issues a short-lived token containing only canonical public state", async () => {
    const pricingRateCalls: string[][] = []
    const authorization = await issueAuthorization(
      createDependencies({ pricingRateCalls })
    )
    const tokenPayload = decodeAuthorizationToken(
      authorization.authorizationToken
    )

    expect(authorization.expiresAt).toBe(NOW_SECONDS + 120)
    expect(authorization.draft.content).toBe(
      "Zapped out 1 item at https://shop.conduit.market/"
    )
    expect(authorization.draft.tags).toContainEqual(["amount", "10000"])
    expect(
      authorization.draft.tags.some((tag) => tag[0] === "omf_provider")
    ).toBe(false)
    expect(
      authorization.draft.tags.find((tag) => tag[0] === "omf_auth")
    ).toEqual([
      "omf_auth",
      ATTESTATION_KEY_ID,
      expect.stringMatching(/^[0-9a-f]{128}$/),
    ])
    expect(authorization.pricing).toMatchObject({
      itemSubtotalSats: 10,
      shippingCostSats: 0,
      totalSats: 10,
      totalMsats: 10_000,
    })
    expect(pricingRateCalls).toEqual([])
    expect(tokenPayload).toMatchObject({
      version: 1,
      expiresAt: NOW_SECONDS + 120,
    })
    expect(authorization).not.toHaveProperty("lnurlCallback")
    expect(authorization).not.toHaveProperty("lnurlNostrPubkey")
    expect(tokenPayload).not.toHaveProperty("lnurlCallback")
    expect(tokenPayload).not.toHaveProperty("lnurlNostrPubkey")
  })

  it("prices a fiat listing with a server-owned quote", async () => {
    const pricingRateCalls: string[][] = []
    const authorization = await issueAuthorization(
      createDependencies({
        product: productEvent({
          price: 10,
          currency: "USD",
          shippingCost: 5,
          shippingCurrency: "USD",
        }),
        pricingRateCalls,
      })
    )

    expect(pricingRateCalls).toEqual([["USD"]])
    expect(authorization.draft.tags).toContainEqual(["amount", "15000000"])
    expect(authorization.pricing).toMatchObject({
      itemSubtotalSats: 10_000,
      shippingCostSats: 5_000,
      totalSats: 15_000,
      totalMsats: 15_000_000,
      quote: {
        rate: 100_000,
        fetchedAt: NOW_SECONDS * 1000,
        source: "mempool",
      },
    })
  })

  it("does not fetch a rate for zero-cost fiat shipping", async () => {
    const pricingRateCalls: string[][] = []
    const authorization = await issueAuthorization(
      createDependencies({
        product: productEvent({
          price: 10,
          currency: "SATS",
          shippingCost: 0,
          shippingCurrency: "USD",
        }),
        pricingRateCalls,
      })
    )

    expect(pricingRateCalls).toEqual([])
    expect(authorization.pricing).toMatchObject({
      itemSubtotalSats: 10,
      shippingCostSats: 0,
      totalSats: 10,
    })
  })

  it("fails closed when the server pricing quote is unavailable", async () => {
    const response = await authorizeAnonZapRequest(
      post(
        "https://shop.conduit.market/api/anon-zap-authorize",
        checkoutIntent()
      ),
      env(),
      createDependencies({
        product: productEvent({ price: 10, currency: "USD" }),
        pricingRateError: new Error("provider unavailable"),
      })
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Checkout pricing is temporarily unavailable.",
    })
  })

  it("mints an independent opaque rate-limit key for each authorization", async () => {
    const dependencies = createDependencies()
    const first = decodeAuthorizationToken(
      (await issueAuthorization(dependencies)).authorizationToken
    )
    const second = decodeAuthorizationToken(
      (await issueAuthorization(dependencies)).authorizationToken
    )
    const firstAuthorization = first.authorization as {
      checkoutSessionId: string
    }
    const secondAuthorization = second.authorization as {
      checkoutSessionId: string
    }

    expect(firstAuthorization.checkoutSessionId).toMatch(/^[0-9a-f]{64}$/)
    expect(secondAuthorization.checkoutSessionId).toMatch(/^[0-9a-f]{64}$/)
    expect(firstAuthorization.checkoutSessionId).not.toBe(
      secondAuthorization.checkoutSessionId
    )
  })

  it("queries deletions by product address and exact event id", async () => {
    const publicEventFilters: unknown[] = []
    await issueAuthorization(createDependencies({ publicEventFilters }))

    expect(publicEventFilters).toContainEqual({
      kinds: [5],
      authors: [MERCHANT_PUBKEY],
      "#a": [PRODUCT_ADDRESS],
      limit: 300,
    })
    expect(publicEventFilters).toContainEqual({
      kinds: [5],
      authors: [MERCHANT_PUBKEY],
      "#e": [productEvent().id],
      limit: 300,
    })
    expect(publicEventFilters).not.toContainEqual({
      kinds: [5],
      authors: [MERCHANT_PUBKEY],
      limit: 300,
    })
  })

  it("fails closed unless every configured relay completes every authorization read", async () => {
    for (const incompleteRead of [
      "products",
      "profile",
      "address_deletions",
      "event_deletions",
    ] as const) {
      const response = await authorizeAnonZapRequest(
        post(
          "https://shop.conduit.market/api/anon-zap-authorize",
          checkoutIntent()
        ),
        env({
          ANON_ZAP_COMMERCE_RELAYS:
            "wss://commerce-a.example,wss://commerce-b.example",
        }),
        createDependencies({ incompleteRead })
      )

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        error: "Checkout public relay reads are temporarily unavailable.",
      })
    }
  })

  it("fails closed when an EOSE-complete authorization read saturates its limit", async () => {
    for (const saturatedRead of [
      "products",
      "profile",
      "address_deletions",
      "event_deletions",
    ] as const) {
      const response = await authorizeAnonZapRequest(
        post(
          "https://shop.conduit.market/api/anon-zap-authorize",
          checkoutIntent()
        ),
        env(),
        createDependencies({ saturatedRead })
      )

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        error: "Checkout public relay reads are temporarily unavailable.",
      })
    }
  })

  it("forwards authenticated retries in one rate-limit bucket", async () => {
    const signerCalls: SignerCall[] = []
    const dependencies = createDependencies({ signerCalls })
    const authorization = await issueAuthorization(dependencies)
    const responses = []

    for (let attempt = 0; attempt < 2; attempt += 1) {
      responses.push(
        await signAuthorizedAnonZapRequest(
          post("https://shop.conduit.market/api/anon-zap-sign", {
            authorizationToken: authorization.authorizationToken,
            zapRequest: authorization.draft,
          }),
          env(),
          dependencies
        )
      )
    }

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const signed = await Promise.all(
      responses.map((response) => response.json() as Promise<{ id: string }>)
    )
    expect(signed[0]!.id).toBe(signed[1]!.id)
    expect(signerCalls).toHaveLength(2)
    expect(signerCalls[0]!.body).toBe(signerCalls[1]!.body)
    expect(signerCalls[0]!.url).toBe("https://anon-signer.example")

    const timestamp = signerCalls[0]!.headers.get(
      "x-conduit-anon-signer-timestamp"
    )!
    const signature = signerCalls[0]!.headers.get(
      "x-conduit-anon-signer-signature"
    )
    expect(timestamp).toBe(String(NOW_SECONDS))
    expect(signature).toBe(
      await hmacHex(AUTH_SECRET, timestamp, signerCalls[0]!.body)
    )

    const forwarded = JSON.parse(signerCalls[0]!.body) as {
      authorization: { checkoutSessionId: string }
    }
    expect(forwarded.authorization.checkoutSessionId).toMatch(/^[0-9a-f]{64}$/)
  })

  it("uses the signer service binding when configured", async () => {
    const signerCalls: SignerCall[] = []
    const dependencies = createDependencies({
      signerCalls,
      signerStatus: 503,
    })
    const authorization = await issueAuthorization(dependencies)
    const boundRequests: Request[] = []
    const response = await signAuthorizedAnonZapRequest(
      post("https://shop.conduit.market/api/anon-zap-sign", {
        authorizationToken: authorization.authorizationToken,
        zapRequest: authorization.draft,
      }),
      env({
        ANON_ZAP_SIGNER_SERVICE: {
          async fetch(request) {
            boundRequests.push(request)
            const body = (await request.json()) as {
              zapRequest: AuthorizationResponse["draft"]
            }
            const rawEvent = finalizeEvent(
              {
                kind: body.zapRequest.kind,
                created_at: body.zapRequest.createdAt,
                content: body.zapRequest.content,
                tags: body.zapRequest.tags,
              },
              SHOPPER_SECRET
            )
            return Response.json({ id: rawEvent.id, rawEvent })
          },
        },
      }),
      dependencies
    )

    expect(response.status).toBe(200)
    expect(boundRequests).toHaveLength(1)
    expect(boundRequests[0]!.url).toBe("https://anon-signer.example/")
    expect(
      boundRequests[0]!.headers.get("x-conduit-anon-signer-signature")
    ).toMatch(/^[0-9a-f]{64}$/)
    expect(signerCalls).toHaveLength(0)
  })

  it("fails closed when the deployed signer service binding is missing", async () => {
    const authorization = await issueAuthorization(createDependencies())
    const response = await signAuthorizedAnonZapRequest(
      post("https://shop.conduit.market/api/anon-zap-sign", {
        authorizationToken: authorization.authorizationToken,
        zapRequest: authorization.draft,
      }),
      env({ ANON_ZAP_SIGNER_SERVICE: undefined })
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap signer is not configured.",
    })
  })

  it("rejects token tampering, expiry, and draft mutation before the Worker", async () => {
    const signerCalls: SignerCall[] = []
    const dependencies = createDependencies({ signerCalls })
    const authorization = await issueAuthorization(dependencies)
    const mutatedDraft = {
      ...authorization.draft,
      tags: authorization.draft.tags.map((tag) =>
        tag[0] === "amount" ? ["amount", "11000"] : [...tag]
      ),
    }
    const tokenLast = authorization.authorizationToken.at(-1)
    const tamperedToken = `${authorization.authorizationToken.slice(0, -1)}${
      tokenLast === "a" ? "b" : "a"
    }`

    const mutationResponse = await signAuthorizedAnonZapRequest(
      post("https://shop.conduit.market/api/anon-zap-sign", {
        authorizationToken: authorization.authorizationToken,
        zapRequest: mutatedDraft,
      }),
      env(),
      dependencies
    )
    const tamperResponse = await signAuthorizedAnonZapRequest(
      post("https://shop.conduit.market/api/anon-zap-sign", {
        authorizationToken: tamperedToken,
        zapRequest: authorization.draft,
      }),
      env(),
      dependencies
    )
    const expiryResponse = await signAuthorizedAnonZapRequest(
      post("https://shop.conduit.market/api/anon-zap-sign", {
        authorizationToken: authorization.authorizationToken,
        zapRequest: authorization.draft,
      }),
      env(),
      createDependencies({ nowSeconds: NOW_SECONDS + 121, signerCalls })
    )

    expect(mutationResponse.status).toBe(403)
    expect(tamperResponse.status).toBe(403)
    expect(expiryResponse.status).toBe(403)
    await expect(mutationResponse.json()).resolves.toEqual({
      error: "Zap request does not match checkout authorization.",
    })
    await expect(expiryResponse.json()).resolves.toEqual({
      error: "Checkout authorization has expired.",
    })
    expect(signerCalls).toHaveLength(0)
  })

  it("reports signer unavailability as a pre-invoice fallback signal", async () => {
    const dependencies = createDependencies({ signerStatus: 503 })
    const authorization = await issueAuthorization(dependencies)
    const response = await signAuthorizedAnonZapRequest(
      post("https://shop.conduit.market/api/anon-zap-sign", {
        authorizationToken: authorization.authorizationToken,
        zapRequest: authorization.draft,
      }),
      env(),
      dependencies
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap signer is temporarily unavailable.",
    })
  })
})

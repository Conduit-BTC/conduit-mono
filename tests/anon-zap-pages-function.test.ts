import { describe, expect, it } from "bun:test"
import type { LnurlPayMetadata, SignedPublicNostrEvent } from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import {
  authorizeAnonZapRequest,
  signAuthorizedAnonZapRequest,
  type AnonZapPagesDependencies,
  type AnonZapPagesEnv,
} from "../apps/market/functions/_lib/anon-zap-checkout-auth"
import {
  onRequestOptions as authorizeAnonZapOptions,
  onRequestPost as authorizeAnonZap,
} from "../apps/market/functions/api/anon-zap-authorize"
import {
  onRequestOptions as signAnonZapOptions,
  onRequestPost as signAnonZap,
} from "../apps/market/functions/api/anon-zap-sign"
import { onRequestOptions as rootAuthorizeAnonZapOptions } from "../functions/api/anon-zap-authorize"
import { onRequestOptions as rootSignAnonZapOptions } from "../functions/api/anon-zap-sign"

const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 4])
const RECEIPT_SECRET = Uint8Array.from([...new Uint8Array(31), 5])
const SHOPPER_SECRET = Uint8Array.from([...new Uint8Array(31), 6])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const RECEIPT_PUBKEY = getPublicKey(RECEIPT_SECRET)
const NOW_SECONDS = 1_800_000_000
const PRODUCT_D_TAG = "cnd-150-pages-test"
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}`
const AUTH_SECRET = "test-only anon signer request auth secret"

type AuthorizationResponse = {
  authorizationToken: string
  expiresAt: number
  draft: {
    kind: number
    createdAt: number
    content: string
    tags: string[][]
  }
  lnurlCallback: string
  lnurlNostrPubkey: string
  relayUrls: string[]
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

function productEvent(): SignedPublicNostrEvent {
  return signMerchantEvent({
    kind: 30402,
    tags: [
      ["d", PRODUCT_D_TAG],
      ["title", "CND-150 Pages test"],
      ["price", "10", "SATS"],
      ["type", "simple", "digital"],
      ["image", "https://cdn.example/cnd-150-pages.png"],
      ["checkout_public_zaps", "true"],
      ["checkout_zap_message_policy", "generic_only"],
    ],
    content: "A signed public Pages authorization fixture.",
  })
}

function profileEvent(): SignedPublicNostrEvent {
  return signMerchantEvent({
    kind: 0,
    content: JSON.stringify({ lud16: "merchant@wallet.example" }),
  })
}

function lnurlMetadata(): LnurlPayMetadata {
  return {
    payRequestUrl: "https://wallet.example/.well-known/lnurlp/merchant",
    lnurl: "lnurl1cnd150pagestest",
    callback: "https://wallet.example/lnurl/callback",
    minSendable: 1_000,
    maxSendable: 100_000_000,
    tag: "payRequest",
    allowsNostr: true,
    nostrPubkey: RECEIPT_PUBKEY,
    metadata: "[]",
  }
}

function env(overrides: Partial<AnonZapPagesEnv> = {}): AnonZapPagesEnv {
  return {
    ANON_ZAP_ALLOWED_ORIGINS:
      "https://shop.conduit.market,https://*.conduit-market-coo.pages.dev",
    ANON_ZAP_SIGNER_URL: "https://anon-signer.example",
    ANON_SIGNER_REQUEST_AUTH_SECRET: AUTH_SECRET,
    ANON_ZAP_COMMERCE_RELAYS: "wss://commerce.example",
    ANON_ZAP_RECEIPT_RELAYS: "wss://receipts.example",
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
    amountMsats: 10_000,
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
  } = {}
): AnonZapPagesDependencies {
  const signerCalls = options.signerCalls ?? []
  return {
    async fetchPublicEvents(filter) {
      options.publicEventFilters?.push(filter)
      if (filter.kinds.includes(30402)) return [productEvent()]
      if (filter.kinds.includes(0)) return [profileEvent()]
      return []
    },
    async fetchLnurlMetadata() {
      return lnurlMetadata()
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
        async fetchLnurlMetadata(lud16) {
          dependencyCalls += 1
          return dependencies.fetchLnurlMetadata(lud16)
        },
      }
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap signer is not configured.",
    })
    expect(dependencyCalls).toBe(0)
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

  it("issues a short-lived token containing only canonical public state", async () => {
    const authorization = await issueAuthorization(createDependencies())
    const tokenPayload = decodeAuthorizationToken(
      authorization.authorizationToken
    )

    expect(authorization.expiresAt).toBe(NOW_SECONDS + 120)
    expect(authorization.draft.content).toBe("Zapped out 1 item on Conduit")
    expect(authorization.draft.tags).toContainEqual(["amount", "10000"])
    expect(tokenPayload).toMatchObject({
      version: 1,
      expiresAt: NOW_SECONDS + 120,
    })
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

  it("forwards an authenticated canonical draft and replays idempotently", async () => {
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

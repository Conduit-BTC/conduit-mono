import { describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import { createAnonZapProviderAttestation } from "@conduit/core/protocol/anon-zap"
import {
  buildAnonZapCheckoutContent,
  type AuthorizedAnonZapPricing,
} from "@conduit/core/protocol/anon-zap-checkout"
import { encodeLnurl } from "@conduit/core/protocol/lightning"

import {
  createAnonZapCanaryFetch,
  formatAnonZapCanaryFailure,
  runAnonZapAuthorizationCanary,
  type AnonZapCanaryConfig,
} from "../scripts/smoke/anon_zap_authorization"

const MERCHANT_PUBKEY = "11".repeat(32)
const PROVIDER_PUBKEY = "22".repeat(32)
const OTHER_PROVIDER_PUBKEY = "33".repeat(32)
const SIGNER_SECRET = Uint8Array.from([...new Uint8Array(31), 4])
const OTHER_SIGNER_SECRET = Uint8Array.from([...new Uint8Array(31), 5])
const SIGNER_PUBKEY = getPublicKey(SIGNER_SECRET)
const ATTESTATION_PRIVATE_KEY = "0".repeat(63) + "6"
const ATTESTATION_PUBLIC_KEY = getPublicKey(
  Uint8Array.from([...new Uint8Array(31), 6])
)
const ATTESTATION_KEY_ID = "preview-2026"
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:canary-product`
const LNURL = encodeLnurl(
  "https://wallet.example/.well-known/lnurlp/canary-merchant"
)
const CALLBACK = "https://wallet.example/lnurl/callback"
const RELAYS = ["wss://relay.example", "wss://receipts.example"]
const NOW_SECONDS = 1_800_000_000

type JsonRecord = Record<string, unknown>
type Call = {
  pathname: string
  body: JsonRecord
  method: string
  origin: string | null
  redirect: RequestRedirect
}

type FixtureOverrides = {
  mutateAuthorization?: (authorization: JsonRecord) => void
  mutateSignerResponse?: (response: JsonRecord) => void
}

function json(body: JsonRecord): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function createPricing(): AuthorizedAnonZapPricing {
  return {
    itemSubtotalSats: 21,
    shippingCostSats: 0,
    totalSats: 21,
    totalMsats: 21_000,
    items: [
      {
        productAddress: PRODUCT_ADDRESS,
        productEventId: "44".repeat(32),
        format: "digital",
        quantity: 1,
        unitPriceSats: 21,
        unitShippingSats: 0,
        lineTotalSats: 21,
        shippingCountryRules: [],
      },
    ],
  }
}

function createFixture(overrides: FixtureOverrides = {}) {
  const pricing = createPricing()
  const unsignedDraft = {
    kind: 9734,
    createdAt: NOW_SECONDS,
    content: buildAnonZapCheckoutContent(1),
    tags: [
      ["p", MERCHANT_PUBKEY],
      ["amount", String(pricing.totalMsats)],
      ["lnurl", LNURL],
      ["relays", ...RELAYS],
      ["omf", "zapout"],
      ["omf_provider", PROVIDER_PUBKEY],
      ["client", "conduit-market"],
    ],
  }
  const draft = {
    ...unsignedDraft,
    tags: [
      ...unsignedDraft.tags,
      createAnonZapProviderAttestation(
        unsignedDraft,
        ATTESTATION_KEY_ID,
        ATTESTATION_PRIVATE_KEY
      ),
    ],
  }
  const authorization: JsonRecord = {
    authorizationToken: "preview-canary-token",
    expiresAt: NOW_SECONDS + 120,
    draft,
    lnurlCallback: CALLBACK,
    lnurlNostrPubkey: PROVIDER_PUBKEY,
    relayUrls: RELAYS,
    pricing,
  }
  overrides.mutateAuthorization?.(authorization)

  const authorizedDraft = authorization.draft as typeof draft
  const rawEvent = finalizeEvent(
    {
      kind: authorizedDraft.kind,
      created_at: authorizedDraft.createdAt,
      content: authorizedDraft.content,
      tags: authorizedDraft.tags,
    },
    SIGNER_SECRET
  )
  const signerResponse: JsonRecord = {
    id: rawEvent.id,
    rawEvent,
    requestCreatedAt: authorizedDraft.createdAt,
    lnurlCallback: authorization.lnurlCallback,
    lnurl: LNURL,
    lnurlNostrPubkey: authorization.lnurlNostrPubkey,
    relayUrls: authorization.relayUrls,
  }
  overrides.mutateSignerResponse?.(signerResponse)

  const calls: Call[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const body = (await request.json()) as JsonRecord
    const pathname = new URL(request.url).pathname
    calls.push({
      pathname,
      body,
      method: request.method,
      origin: request.headers.get("origin"),
      redirect: request.redirect,
    })
    if (pathname === "/api/anon-zap-authorize") return json(authorization)
    if (pathname === "/api/anon-zap-sign") return json(signerResponse)
    return new Response(null, { status: 404 })
  }

  const config: AnonZapCanaryConfig = {
    baseUrl: new URL("https://preview.example"),
    merchantPubkey: MERCHANT_PUBKEY,
    productAddress: PRODUCT_ADDRESS,
    signerPubkey: SIGNER_PUBKEY,
    expectedLnurl: LNURL,
    expectedProviderPubkey: PROVIDER_PUBKEY,
    attestationPublicKeys: `${ATTESTATION_KEY_ID}:${ATTESTATION_PUBLIC_KEY}`,
  }
  return { calls, config, fetchImpl }
}

function replaceTag(
  authorization: JsonRecord,
  name: string,
  replacement: string[]
): void {
  const draft = authorization.draft as { tags: string[][] }
  draft.tags = draft.tags.map((tag) => (tag[0] === name ? replacement : tag))
}

describe("anonymous zap deployment canary", () => {
  it("validates authorize/sign without a browser amount, invoice, publish, or payment", async () => {
    const fixture = createFixture()

    await expect(
      runAnonZapAuthorizationCanary(fixture.config, {
        fetchImpl: fixture.fetchImpl,
      })
    ).resolves.toEqual({ status: "passed" })

    expect(fixture.calls.map((call) => call.pathname)).toEqual([
      "/api/anon-zap-authorize",
      "/api/anon-zap-sign",
    ])
    expect(
      fixture.calls.every((call) => call.origin === "https://preview.example")
    ).toBe(true)
    expect(fixture.calls.every((call) => call.method === "POST")).toBe(true)
    expect(fixture.calls.every((call) => call.redirect === "error")).toBe(true)
    expect(fixture.calls[0]?.body).toEqual({
      merchantPubkey: MERCHANT_PUBKEY,
      items: [{ productAddress: PRODUCT_ADDRESS, quantity: 1 }],
    })
    expect(fixture.calls[0]?.body).not.toHaveProperty("amountMsats")
  })

  it("blocks redirects, unexpected paths, and unexpected methods", async () => {
    let networkCalls = 0
    const guardedFetch = createAnonZapCanaryFetch(
      new URL("https://preview.example"),
      async () => {
        networkCalls += 1
        return new Response(null, { status: 204 })
      }
    )

    await expect(
      guardedFetch("https://preview.example/api/anon-zap-sign", {
        method: "GET",
      })
    ).rejects.toThrow("unexpected network call")
    await expect(
      guardedFetch("https://preview.example/lnurl/callback", {
        method: "POST",
      })
    ).rejects.toThrow("unexpected network call")
    await expect(
      guardedFetch("https://other.example/api/anon-zap-sign", {
        method: "POST",
      })
    ).rejects.toThrow("unexpected network call")
    expect(networkCalls).toBe(0)
  })

  it("rejects altered content, amount, provider, relays, and attestation", async () => {
    const mutations: Array<(authorization: JsonRecord) => void> = [
      (authorization) => {
        const draft = authorization.draft as { content: string }
        draft.content = "Zapped out N items"
      },
      (authorization) =>
        replaceTag(authorization, "amount", ["amount", "22000"]),
      (authorization) =>
        replaceTag(authorization, "omf_provider", [
          "omf_provider",
          OTHER_PROVIDER_PUBKEY,
        ]),
      (authorization) => {
        authorization.relayUrls = ["wss://different.example"]
      },
      (authorization) => {
        const draft = authorization.draft as { tags: string[][] }
        draft.tags = draft.tags.map((tag) =>
          tag[0] === "omf_auth"
            ? [
                tag[0],
                tag[1]!,
                `${tag[2]!.slice(0, -1)}${tag[2]!.endsWith("0") ? "1" : "0"}`,
              ]
            : tag
        )
      },
    ]

    for (const mutateAuthorization of mutations) {
      const fixture = createFixture({ mutateAuthorization })
      await expect(
        runAnonZapAuthorizationCanary(fixture.config, {
          fetchImpl: fixture.fetchImpl,
        })
      ).rejects.toThrow()
    }
  })

  it("rejects malformed configured and authorized LNURLs", async () => {
    const invalidLnurls = [
      "lnurl1conduitcanary",
      `${LNURL.slice(0, -1)}${LNURL.endsWith("q") ? "p" : "q"}`,
    ]

    for (const invalidLnurl of invalidLnurls) {
      const fixture = createFixture({
        mutateAuthorization: (authorization) => {
          replaceTag(authorization, "lnurl", ["lnurl", invalidLnurl])
        },
      })
      fixture.config.expectedLnurl = invalidLnurl
      await expect(
        runAnonZapAuthorizationCanary(fixture.config, {
          fetchImpl: fixture.fetchImpl,
        })
      ).rejects.toThrow("authorization_validation")
    }
  })

  it("rejects unsafe callbacks and signer responses", async () => {
    for (const callback of [
      "https://user:pass@wallet.example/callback",
      "https://localhost/callback",
      "https://127.0.0.1/callback",
      "https://wallet.example:8443/callback",
    ]) {
      const unsafeCallback = createFixture({
        mutateAuthorization: (authorization) => {
          authorization.lnurlCallback = callback
        },
      })
      await expect(
        runAnonZapAuthorizationCanary(unsafeCallback.config, {
          fetchImpl: unsafeCallback.fetchImpl,
        })
      ).rejects.toThrow()
    }

    const wrongSigner = createFixture({
      mutateSignerResponse: (response) => {
        const draft = (response.rawEvent as { tags: string[][] }).tags
        const rawEvent = finalizeEvent(
          {
            kind: 9734,
            created_at: NOW_SECONDS,
            content: buildAnonZapCheckoutContent(1),
            tags: draft,
          },
          OTHER_SIGNER_SECRET
        )
        response.id = rawEvent.id
        response.rawEvent = rawEvent
      },
    })
    await expect(
      runAnonZapAuthorizationCanary(wrongSigner.config, {
        fetchImpl: wrongSigner.fetchImpl,
      })
    ).rejects.toThrow()
  })

  it("never formats server-provided error details into operator logs", async () => {
    const sentinel = `${MERCHANT_PUBKEY}:${PRODUCT_ADDRESS}:secret-sentinel`
    const fixture = createFixture()
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: sentinel }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })

    let failure: unknown
    try {
      await runAnonZapAuthorizationCanary(fixture.config, { fetchImpl })
    } catch (error) {
      failure = error
    }
    const formatted = formatAnonZapCanaryFailure(failure)
    expect(formatted).toBe("Anon zap canary failed at authorization.")
    expect(formatted).not.toContain(sentinel)
    expect(formatted).not.toContain(MERCHANT_PUBKEY)
    expect(formatted).not.toContain(PRODUCT_ADDRESS)
  })
})

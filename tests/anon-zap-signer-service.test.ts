import { describe, expect, it } from "bun:test"
import { EVENT_KINDS, OMF_ZAPOUT_MARKER_TAG } from "@conduit/core"
import { createAnonZapProviderAttestation } from "@conduit/core/protocol/anon-zap"
import { getPublicKey } from "nostr-tools"
import {
  handleAnonZapSignerRequest,
  signAnonZapRequestDraft,
  type AnonZapSignerEnv,
} from "../apps/anon-zap-signer/src/signer"
import type { AnonZapRequestDraft } from "@conduit/core"

const PRIVATE_KEY_HEX = "0".repeat(63) + "1"
const REQUEST_AUTH_SECRET = "22".repeat(32)
const ATTESTATION_KEY_ID = "test-2026"
const ATTESTATION_PRIVATE_KEY_HEX = "0".repeat(63) + "2"
const ATTESTATION_PUBKEY = getPublicKey(
  Uint8Array.from([...new Uint8Array(31), 2])
)
const MERCHANT_PUBKEY = "b".repeat(64)
const MARKET_NIP89_PUBKEY = "c".repeat(64)
const MARKET_NIP89_ADDRESS = `31990:${MARKET_NIP89_PUBKEY}:conduit-market`
const MARKET_NIP89_RELAY_HINT = "wss://relay.conduit.market"
const EXPECTED_PUBKEY = getPublicKey(
  Uint8Array.from([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 1,
  ])
)
const NOW_SECONDS = 1_800_000_000

function env(overrides: Partial<AnonZapSignerEnv> = {}): AnonZapSignerEnv {
  return {
    ANON_CONDUIT_SHOPPER_PRIVATE_KEY_HEX: PRIVATE_KEY_HEX,
    ANON_CONDUIT_SHOPPER_PUBKEY: EXPECTED_PUBKEY,
    ANON_SIGNER_REQUEST_AUTH_SECRET: REQUEST_AUTH_SECRET,
    ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS: `${ATTESTATION_KEY_ID}:${ATTESTATION_PUBKEY}`,
    ANON_SIGNER_ALLOWED_ORIGINS: "http://localhost:7000",
    ANON_SIGNER_RATE_LIMITER: {
      async limit() {
        return { success: true }
      },
    },
    ANON_AUTHORIZATION_RATE_LIMITER: {
      async limit() {
        return { success: true }
      },
    },
    ANON_AUTHORITY_RATE_LIMITER: {
      async limit() {
        return { success: true }
      },
    },
    ...overrides,
  }
}

function envWithMarketNip89(
  overrides: Partial<AnonZapSignerEnv> = {}
): AnonZapSignerEnv {
  return env({
    ANON_CONDUIT_MARKET_NIP89_ADDRESS: MARKET_NIP89_ADDRESS,
    ANON_CONDUIT_MARKET_NIP89_RELAY_HINT: MARKET_NIP89_RELAY_HINT,
    ...overrides,
  })
}

function draft(
  overrides: Partial<AnonZapRequestDraft> = {}
): AnonZapRequestDraft {
  return {
    kind: EVENT_KINDS.ZAP_REQUEST,
    createdAt: NOW_SECONDS,
    content: "Zapped out 1 item at https://shop.conduit.market/",
    tags: [
      ["p", MERCHANT_PUBKEY],
      ["amount", "50000"],
      ["lnurl", "lnurl1test"],
      ["relays", "wss://relay.example"],
      ["client", "conduit-market"],
    ],
    ...overrides,
  }
}

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    checkoutSessionId: "checkout-session-test",
    merchantPubkey: MERCHANT_PUBKEY,
    amountMsats: 50_000,
    lnurl: "lnurl1test",
    publicZapPolicy: "anonymous_public_zap_allowed",
    ...overrides,
  }
}

function signingRequestBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    zapRequest: draft(),
    authorization: authorization(),
    ...overrides,
  }
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function signRequestBody(
  bodyText: string,
  timestamp = Math.floor(Date.now() / 1000)
): Promise<{ signature: string; timestamp: string }> {
  const encoder = new TextEncoder()
  const timestampText = String(timestamp)
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(REQUEST_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestampText}.${bodyText}`)
  )
  return { signature: bytesToHex(signature), timestamp: timestampText }
}

async function postRequest(
  body: unknown,
  origin = "http://localhost:7000"
): Promise<Request> {
  const bodyText = JSON.stringify(body)
  const auth = await signRequestBody(bodyText)
  return new Request("http://localhost:7010", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-conduit-anon-signer-timestamp": auth.timestamp,
      "x-conduit-anon-signer-signature": auth.signature,
    },
    body: bodyText,
  })
}

describe("Anon zap signer service", () => {
  it("signs a validated kind 9734 zap request with the configured anon key", async () => {
    const signed = await signAnonZapRequestDraft(draft(), env(), {
      nowSeconds: NOW_SECONDS,
    })

    expect(signed.kind).toBe(EVENT_KINDS.ZAP_REQUEST)
    expect(signed.pubkey).toBe(EXPECTED_PUBKEY)
    expect(signed.id).toHaveLength(64)
    expect(signed.sig).toHaveLength(128)
    expect(signed.tags).toEqual(draft().tags)
  })

  it("allows the canonical OMF zapout marker before signing", async () => {
    const baseDraft = draft({
      tags: [
        ...draft().tags,
        [...OMF_ZAPOUT_MARKER_TAG],
        ["omf_provider", "d".repeat(64)],
      ],
    })
    const tags = [
      ...baseDraft.tags,
      createAnonZapProviderAttestation(
        baseDraft,
        ATTESTATION_KEY_ID,
        ATTESTATION_PRIVATE_KEY_HEX
      ),
    ]
    const signed = await signAnonZapRequestDraft(draft({ tags }), env(), {
      nowSeconds: NOW_SECONDS,
    })

    expect(signed.tags).toEqual(tags)
  })

  it("rejects a provider change after the server attests the public request", async () => {
    const baseDraft = draft({
      tags: [
        ...draft().tags,
        [...OMF_ZAPOUT_MARKER_TAG],
        ["omf_provider", "d".repeat(64)],
      ],
    })
    const providerAttestation = createAnonZapProviderAttestation(
      baseDraft,
      ATTESTATION_KEY_ID,
      ATTESTATION_PRIVATE_KEY_HEX
    )

    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [
            ...baseDraft.tags.map((tag) =>
              tag[0] === "omf_provider" ? ["omf_provider", "e".repeat(64)] : tag
            ),
            providerAttestation,
          ],
        }),
        env(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request provider attestation is invalid.")
  })

  it("rejects private tags before signing", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [
            ["p", "b".repeat(64)],
            ["amount", "50000"],
            ["lnurl", "lnurl1test"],
            ["relays", "wss://relay.example"],
            ["order", "private-order-id"],
          ],
        }),
        env(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request contains private tags.")
  })

  it("rejects expanded OMF marker payloads before signing", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [...draft().tags, ["omf", "zapout", "order-123"]],
        }),
        env(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request tag payload is invalid.")
  })

  it("rejects duplicate OMF marker tags before signing", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [
            ...draft().tags,
            [...OMF_ZAPOUT_MARKER_TAG],
            [...OMF_ZAPOUT_MARKER_TAG],
          ],
        }),
        env(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request provider authority is invalid.")
  })

  it("rejects extra payload fields on allowed public tags before signing", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [
            ["p", "b".repeat(64)],
            ["amount", "50000", "order-123"],
            ["lnurl", "lnurl1test"],
            ["relays", "wss://relay.example"],
          ],
        }),
        env(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request tag payload is invalid.")
  })

  it("rejects arbitrary client tag values before signing", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [
            ["p", "b".repeat(64)],
            ["amount", "50000"],
            ["lnurl", "lnurl1test"],
            ["relays", "wss://relay.example"],
            ["client", "order-123"],
          ],
        }),
        env(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request tag payload is invalid.")
  })

  it("rejects malformed NIP-89 client tag values before signing", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [
            ["p", "b".repeat(64)],
            ["amount", "50000"],
            ["lnurl", "lnurl1test"],
            ["relays", "wss://relay.example"],
            [
              "client",
              "Conduit Market",
              `31990:${"c".repeat(64)}:private-order-id`,
              "wss://relay.conduit.market",
            ],
          ],
        }),
        env(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request tag payload is invalid.")
  })

  it("allows the configured Conduit Market NIP-89 client tag before signing", async () => {
    const tags = [
      ["p", "b".repeat(64)],
      ["amount", "50000"],
      ["lnurl", "lnurl1test"],
      ["relays", "wss://relay.example"],
      [
        "client",
        "Conduit Market",
        MARKET_NIP89_ADDRESS,
        MARKET_NIP89_RELAY_HINT,
      ],
    ]
    const signed = await signAnonZapRequestDraft(
      draft({ tags }),
      envWithMarketNip89(),
      { nowSeconds: NOW_SECONDS }
    )

    expect(signed.tags).toEqual(tags)
  })

  it("allows configured NIP-89 client tags with uppercase pubkey casing", async () => {
    const uppercaseAddress = `31990:${MARKET_NIP89_PUBKEY.toUpperCase()}:conduit-market`
    const tags = [
      ["p", "b".repeat(64)],
      ["amount", "50000"],
      ["lnurl", "lnurl1test"],
      ["relays", "wss://relay.example"],
      ["client", "Conduit Market", uppercaseAddress, MARKET_NIP89_RELAY_HINT],
    ]
    const signed = await signAnonZapRequestDraft(
      draft({ tags }),
      envWithMarketNip89(),
      { nowSeconds: NOW_SECONDS }
    )

    expect(signed.tags).toEqual(tags)
  })

  it("allows configured NIP-89 client tags with path-based relay hints", async () => {
    const relayHint = "wss://relay.example/nostr"
    const tags = [
      ["p", "b".repeat(64)],
      ["amount", "50000"],
      ["lnurl", "lnurl1test"],
      ["relays", "wss://relay.example"],
      ["client", "Conduit Market", MARKET_NIP89_ADDRESS, relayHint],
    ]
    const signed = await signAnonZapRequestDraft(
      draft({ tags }),
      envWithMarketNip89({
        ANON_CONDUIT_MARKET_NIP89_RELAY_HINT: relayHint,
      }),
      { nowSeconds: NOW_SECONDS }
    )

    expect(signed.tags).toEqual(tags)
  })

  it("rejects a non-configured NIP-89 handler address before signing", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [
            ["p", "b".repeat(64)],
            ["amount", "50000"],
            ["lnurl", "lnurl1test"],
            ["relays", "wss://relay.example"],
            [
              "client",
              "Conduit Market",
              `31990:${"d".repeat(64)}:conduit-market`,
              MARKET_NIP89_RELAY_HINT,
            ],
          ],
        }),
        envWithMarketNip89(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request tag payload is invalid.")
  })

  it("rejects NIP-89 relay hints with path or query payloads before signing", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft({
          tags: [
            ["p", "b".repeat(64)],
            ["amount", "50000"],
            ["lnurl", "lnurl1test"],
            ["relays", "wss://relay.example"],
            [
              "client",
              "Conduit Market",
              MARKET_NIP89_ADDRESS,
              `${MARKET_NIP89_RELAY_HINT}/private-order-id?session=abc`,
            ],
          ],
        }),
        envWithMarketNip89(),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Zap request tag payload is invalid.")
  })

  it("rejects a signer secret that does not match the expected pubkey", async () => {
    await expect(
      signAnonZapRequestDraft(
        draft(),
        env({ ANON_CONDUIT_SHOPPER_PUBKEY: "a".repeat(64) }),
        { nowSeconds: NOW_SECONDS }
      )
    ).rejects.toThrow("Anon signer private key does not match expected pubkey.")
  })

  it("serves signed events over the local POST endpoint", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(signingRequestBody()),
      env({ ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000" })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:7000"
    )
    expect(body).toMatchObject({
      id: expect.any(String),
      rawEvent: {
        pubkey: EXPECTED_PUBKEY,
        kind: EVENT_KINDS.ZAP_REQUEST,
        content: draft().content,
        tags: draft().tags,
      },
    })
  })

  it("rejects disallowed browser origins", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(signingRequestBody(), "https://evil.example"),
      env({ ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000" })
    )

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("allows single-label preview origins with a wildcard pattern", async () => {
    const origin = "https://ae855b59.conduit-market-coo.pages.dev"
    const response = await handleAnonZapSignerRequest(
      await postRequest(signingRequestBody(), origin),
      env({
        ANON_SIGNER_ALLOWED_ORIGINS:
          "https://shop.conduit.market,https://*.conduit-market-coo.pages.dev",
        ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000",
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(origin)
  })

  it("rejects nested or lookalike wildcard origins", async () => {
    const envWithWildcard = env({
      ANON_SIGNER_ALLOWED_ORIGINS: "https://*.conduit-market-coo.pages.dev",
      ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000",
    })
    const nested = await handleAnonZapSignerRequest(
      await postRequest(
        signingRequestBody(),
        "https://nested.preview.conduit-market-coo.pages.dev"
      ),
      envWithWildcard
    )
    const lookalike = await handleAnonZapSignerRequest(
      await postRequest(
        signingRequestBody(),
        "https://preview.conduit-market-coo.pages.dev.evil.example"
      ),
      envWithWildcard
    )

    expect(nested.status).toBe(403)
    expect(lookalike.status).toBe(403)
  })

  it("allows authenticated server-to-server POST requests without an origin", async () => {
    const bodyText = JSON.stringify(signingRequestBody())
    const auth = await signRequestBody(bodyText)
    const response = await handleAnonZapSignerRequest(
      new Request("http://localhost:7010", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conduit-anon-signer-timestamp": auth.timestamp,
          "x-conduit-anon-signer-signature": auth.signature,
        },
        body: bodyText,
      }),
      env({ ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000" })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("rejects POST requests without request authentication", async () => {
    const response = await handleAnonZapSignerRequest(
      new Request("http://localhost:7010", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:7000",
        },
        body: JSON.stringify(signingRequestBody()),
      }),
      env()
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Anon signer request authentication is missing.",
    })
  })

  it("fails closed on an undersized request-auth secret", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(signingRequestBody()),
      env({ ANON_SIGNER_REQUEST_AUTH_SECRET: "too-short" })
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error:
        "Anon signer request auth is not configured with a valid 256-bit secret.",
    })
  })

  it("returns 429 when the signer runtime rate limiter rejects a request", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(signingRequestBody()),
      env({
        ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000",
        ANON_SIGNER_RATE_LIMITER: {
          async limit() {
            return { success: false }
          },
        },
      })
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("60")
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:7000"
    )
    await expect(response.json()).resolves.toEqual({
      error: "Anon zap signing is rate limited.",
    })
  })

  it("serves authenticated opaque rate-limit batches for the Pages service binding", async () => {
    const keys = [`authorization:source:${"a".repeat(64)}`]
    const bodyText = JSON.stringify({ scope: "authorization", keys })
    const auth = await signRequestBody(bodyText)
    const consumed: string[] = []
    const response = await handleAnonZapSignerRequest(
      new Request("https://anon-zap-rate-limit.internal/internal/rate-limit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conduit-anon-signer-timestamp": auth.timestamp,
          "x-conduit-anon-signer-signature": auth.signature,
        },
        body: bodyText,
      }),
      env({
        ANON_AUTHORIZATION_RATE_LIMITER: {
          async limit({ key }) {
            consumed.push(key)
            return { success: true }
          },
        },
      })
    )

    expect(response.status).toBe(204)
    expect(consumed).toEqual(keys)
  })

  it("accepts source-recipient authority keys through the Worker boundary", async () => {
    const keys = [
      "authority:global",
      `authority:source:${"a".repeat(64)}`,
      `authority:source-recipient:${"b".repeat(64)}`,
    ]
    const bodyText = JSON.stringify({ scope: "authority", keys })
    const auth = await signRequestBody(bodyText)
    const consumed: string[] = []
    const response = await handleAnonZapSignerRequest(
      new Request("https://anon-zap-rate-limit.internal/internal/rate-limit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conduit-anon-signer-timestamp": auth.timestamp,
          "x-conduit-anon-signer-signature": auth.signature,
        },
        body: bodyText,
      }),
      env({
        ANON_AUTHORITY_RATE_LIMITER: {
          async limit({ key }) {
            consumed.push(key)
            return { success: true }
          },
        },
      })
    )

    expect(response.status).toBe(204)
    expect(consumed).toEqual(keys)
  })

  it("rejects key types that are not legal for the selected limiter scope", async () => {
    for (const input of [
      {
        scope: "authorization",
        key: `authorization:source-recipient:${"a".repeat(64)}`,
      },
      { scope: "authority", key: `authority:merchant:${"a".repeat(64)}` },
    ]) {
      const bodyText = JSON.stringify({ scope: input.scope, keys: [input.key] })
      const auth = await signRequestBody(bodyText)
      const response = await handleAnonZapSignerRequest(
        new Request(
          "https://anon-zap-rate-limit.internal/internal/rate-limit",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-conduit-anon-signer-timestamp": auth.timestamp,
              "x-conduit-anon-signer-signature": auth.signature,
            },
            body: bodyText,
          }
        ),
        env()
      )

      expect(response.status).toBe(400)
    }
  })

  it("rejects rate-limit keys routed through the wrong limiter scope", async () => {
    const bodyText = JSON.stringify({
      scope: "authority",
      keys: [`authorization:source:${"a".repeat(64)}`],
    })
    const auth = await signRequestBody(bodyText)
    const response = await handleAnonZapSignerRequest(
      new Request("https://anon-zap-rate-limit.internal/internal/rate-limit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conduit-anon-signer-timestamp": auth.timestamp,
          "x-conduit-anon-signer-signature": auth.signature,
        },
        body: bodyText,
      }),
      env()
    )

    expect(response.status).toBe(400)
  })

  it("rate limits both the authorization session and stable merchant", async () => {
    const keys: string[] = []
    const response = await handleAnonZapSignerRequest(
      await postRequest(signingRequestBody()),
      env({
        ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000",
        ANON_SIGNER_RATE_LIMITER: {
          async limit({ key }) {
            keys.push(key)
            return { success: true }
          },
        },
      })
    )

    expect(response.status).toBe(200)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(keys[1]).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(keys)).not.toContain("checkout-session-test")
    expect(JSON.stringify(keys)).not.toContain(MERCHANT_PUBKEY)
  })

  it("does not let fresh authorization sessions bypass the merchant bucket", async () => {
    let merchantAttempts = 0
    let limiterCalls = 0
    const sharedEnv = env({
      ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000",
      ANON_SIGNER_RATE_LIMITER: {
        async limit() {
          limiterCalls += 1
          const isMerchantKey = limiterCalls % 2 === 0
          if (isMerchantKey) merchantAttempts += 1
          return {
            success: !isMerchantKey || merchantAttempts < 2,
          }
        },
      },
    })
    const first = await handleAnonZapSignerRequest(
      await postRequest(
        signingRequestBody({
          authorization: authorization({
            checkoutSessionId: "checkout-session-first",
          }),
        })
      ),
      sharedEnv
    )
    const second = await handleAnonZapSignerRequest(
      await postRequest(
        signingRequestBody({
          authorization: authorization({
            checkoutSessionId: "checkout-session-second",
          }),
        })
      ),
      sharedEnv
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(merchantAttempts).toBe(2)
  })

  it("fails closed when the signer runtime rate limiter throws", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(signingRequestBody()),
      env({
        ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000",
        ANON_SIGNER_RATE_LIMITER: {
          async limit() {
            throw new Error("binding unavailable")
          },
        },
      })
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: "Anon signer rate limiter is unavailable.",
    })
  })

  it("fails closed when the signer runtime rate limiter is not configured", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(signingRequestBody()),
      env({
        ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000",
        ANON_SIGNER_RATE_LIMITER: undefined,
      })
    )

    expect(response.status).toBe(503)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:7000"
    )
    await expect(response.json()).resolves.toEqual({
      error: "Anon signer rate limiter is not configured.",
    })
  })

  it("rejects oversized streamed bodies before request authentication", async () => {
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"))
        controller.enqueue(new Uint8Array(8_193))
        controller.close()
      },
    })
    const response = await handleAnonZapSignerRequest(
      new Request("http://localhost:7010", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:7000",
        },
        body: oversizedBody,
      }),
      env()
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Request body is too large.",
    })
  })

  it("rejects POST requests with a forged Origin but invalid request authentication", async () => {
    const response = await handleAnonZapSignerRequest(
      new Request("http://localhost:7010", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:7000",
          "x-conduit-anon-signer-timestamp": String(
            Math.floor(Date.now() / 1000)
          ),
          "x-conduit-anon-signer-signature": "a".repeat(64),
        },
        body: JSON.stringify(signingRequestBody()),
      }),
      env()
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Anon signer request authentication is invalid.",
    })
  })

  it("fails closed when allowed origins are not configured", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(signingRequestBody()),
      env({ ANON_SIGNER_ALLOWED_ORIGINS: "" })
    )

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("handles allowed CORS preflight without signing", async () => {
    const response = await handleAnonZapSignerRequest(
      new Request("http://localhost:7010", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:7000" },
      }),
      env()
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:7000"
    )
  })

  it("rejects missing checkout authorization", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest({ zapRequest: draft() }),
      env({ ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000" })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid zap request authorization.",
    })
  })

  it("rejects checkout authorization for a different merchant", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(
        signingRequestBody({
          authorization: authorization({ merchantPubkey: "c".repeat(64) }),
        })
      ),
      env({ ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000" })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Zap request authorization does not match merchant.",
    })
  })

  it("rejects checkout authorization for a different amount", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(
        signingRequestBody({
          authorization: authorization({ amountMsats: 100_000 }),
        })
      ),
      env({ ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000" })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Zap request authorization does not match amount.",
    })
  })

  it("rejects checkout authorization for a different LNURL", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(
        signingRequestBody({
          authorization: authorization({ lnurl: "lnurl1different" }),
        })
      ),
      env({ ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000" })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Zap request authorization does not match LNURL.",
    })
  })

  it("rejects checkout authorization without anonymous public zap policy", async () => {
    const response = await handleAnonZapSignerRequest(
      await postRequest(
        signingRequestBody({
          authorization: authorization({ publicZapPolicy: "private_invoice" }),
        })
      ),
      env({ ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS: "100000000" })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid zap request authorization.",
    })
  })
})

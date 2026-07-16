import { describe, expect, it, mock } from "bun:test"
import {
  encodeLnurl,
  type LnurlPayMetadata,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { createAnonZapProviderAttestation } from "@conduit/core/protocol/anon-zap"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import {
  fetchZapoutAuthorityProfileEvents,
  onRequest as authorityMethod,
  onRequestOptions as authorityOptions,
  onRequestPost as authorityPost,
  verifyZapoutAuthorityRequest,
} from "../apps/market/functions/api/zapout-authority"
import { onRequestOptions as rootAuthorityOptions } from "../functions/api/zapout-authority"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 21])
const SHOPPER_SECRET = Uint8Array.from([...new Uint8Array(31), 22])
const PROVIDER_SECRET = Uint8Array.from([...new Uint8Array(31), 23])
const OTHER_PROVIDER_SECRET = Uint8Array.from([...new Uint8Array(31), 24])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const SHOPPER_PUBKEY = getPublicKey(SHOPPER_SECRET)
const PROVIDER_PUBKEY = getPublicKey(PROVIDER_SECRET)
const NOW_SECONDS = Math.floor(Date.now() / 1000) - 60
const PAY_REQUEST_URL = "https://wallet.example/.well-known/lnurlp/merchant"
const LUD16 = "merchant@wallet.example"
const AUTH_SECRET = "11".repeat(32)
const ATTESTATION_KEY_ID = "test-2026"
const ATTESTATION_PRIVATE_KEY_HEX = "0".repeat(63) + "9"
const ATTESTATION_PUBKEY = getPublicKey(
  Uint8Array.from([...new Uint8Array(31), 9])
)
const ROTATED_ATTESTATION_KEY_ID = "test-2027"
const ROTATED_ATTESTATION_PUBKEY = getPublicKey(
  Uint8Array.from([...new Uint8Array(31), 10])
)

function profileEvent(
  lud16 = LUD16,
  createdAt = NOW_SECONDS - 60
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify({ lud16 }),
    },
    MERCHANT_SECRET
  )
}

function zapRequest(attestProvider = false, payRequestUrl = PAY_REQUEST_URL) {
  return finalizeEvent(
    {
      kind: 9734,
      created_at: NOW_SECONDS,
      content: "Zapped out 2 items at https://shop.conduit.market/",
      tags: [
        ["p", MERCHANT_PUBKEY],
        ["amount", "42000"],
        ["lnurl", encodeLnurl(payRequestUrl)],
        ["relays", "wss://receipts.example"],
        ["omf", "zapout"],
        ...(attestProvider ? [["omf_provider", PROVIDER_PUBKEY]] : []),
        ["client", "conduit-market"],
      ],
    },
    SHOPPER_SECRET
  )
}

function invoice(description: string): string {
  return makeBolt11Fixture({
    hrp: "lnbc420n",
    createdAt: NOW_SECONDS,
    fields: [bolt11PaymentHashField(), bolt11DescriptionHashField(description)],
  })
}

function receipt(
  providerSecret = PROVIDER_SECRET,
  attestProvider = false,
  payRequestUrl = PAY_REQUEST_URL
) {
  const request = zapRequest(attestProvider, payRequestUrl)
  return receiptForRequest(request, providerSecret)
}

function receiptForRequest(
  request: ReturnType<typeof zapRequest>,
  providerSecret = PROVIDER_SECRET
) {
  const description = JSON.stringify(request)
  return finalizeEvent(
    {
      kind: 9735,
      created_at: NOW_SECONDS + 2,
      content: "",
      tags: [
        ["p", MERCHANT_PUBKEY],
        ["P", SHOPPER_PUBKEY],
        ["amount", "42000"],
        ["bolt11", invoice(description)],
        ["description", description],
      ],
    },
    providerSecret
  )
}

async function serverAttestedReceipt(
  providerSecret = PROVIDER_SECRET
): Promise<ReturnType<typeof receipt>> {
  const baseRequest = zapRequest(true)
  const draft = {
    kind: baseRequest.kind,
    createdAt: baseRequest.created_at,
    content: baseRequest.content,
    tags: baseRequest.tags,
  }
  const request = finalizeEvent(
    {
      kind: baseRequest.kind,
      created_at: baseRequest.created_at,
      content: baseRequest.content,
      tags: [
        ...baseRequest.tags,
        createAnonZapProviderAttestation(
          draft,
          ATTESTATION_KEY_ID,
          ATTESTATION_PRIVATE_KEY_HEX
        ),
      ],
    },
    SHOPPER_SECRET
  )
  return receiptForRequest(request, providerSecret)
}

function metadata(overrides: Partial<LnurlPayMetadata> = {}): LnurlPayMetadata {
  return {
    payRequestUrl: PAY_REQUEST_URL,
    lnurl: encodeLnurl(PAY_REQUEST_URL),
    callback: "https://wallet.example/lnurl/callback",
    minSendable: 1_000,
    maxSendable: 100_000_000,
    tag: "payRequest",
    allowsNostr: true,
    nostrPubkey: PROVIDER_PUBKEY,
    metadata: "[]",
    ...overrides,
  }
}

function env(rateLimitSuccess = true) {
  return {
    ANON_ZAP_ALLOWED_ORIGINS: "https://shop.conduit.market",
    ANON_SIGNER_REQUEST_AUTH_SECRET: AUTH_SECRET,
    ANON_ZAP_COMMERCE_RELAYS: "wss://commerce.example",
    ANON_ZAP_LNURL_ALLOWED_HOSTS: "wallet.example",
    ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS: `${ATTESTATION_KEY_ID}:${ATTESTATION_PUBKEY}`,
    ANON_ZAP_RATE_LIMIT_SERVICE: {
      async fetch() {
        return new Response(null, {
          status: rateLimitSuccess ? 204 : 429,
        })
      },
    },
  }
}

function post(events = [receipt()]): Request {
  return new Request("https://shop.conduit.market/api/zapout-authority", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://shop.conduit.market",
      "cf-connecting-ip": "203.0.113.20",
    },
    body: JSON.stringify({ receipts: events }),
  })
}

function dependencies(options: {
  profileEvents?: SignedPublicNostrEvent[]
  complete?: boolean
  lnurlMetadata?: LnurlPayMetadata
  metadataError?: Error
  nowMs?: number
}) {
  const fetchLnurlMetadata = mock(async () => {
    if (options.metadataError) throw options.metadataError
    return options.lnurlMetadata ?? metadata()
  })
  return {
    value: {
      async fetchProfileEvents() {
        return {
          events: options.profileEvents ?? [profileEvent()],
          complete: options.complete ?? true,
        }
      },
      fetchLnurlMetadata,
      nowMs: () => options.nowMs ?? NOW_SECONDS * 1000,
    } as Parameters<typeof verifyZapoutAuthorityRequest>[2],
    fetchLnurlMetadata,
  }
}

describe("Zapouts payment-time authority Pages function", () => {
  it("isolates relay connections between consecutive authority requests", async () => {
    const originalWebSocket = globalThis.WebSocket
    const sockets: Array<{ readyState: number }> = []

    class RequestScopedWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readyState = RequestScopedWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null

      constructor() {
        sockets.push(this)
        queueMicrotask(() => {
          this.readyState = RequestScopedWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }

      send(payload: string): void {
        const [type, subId] = JSON.parse(payload) as [string, string]
        if (type !== "REQ") return
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify(["EOSE", subId]),
          } as MessageEvent<string>)
        })
      }

      close(): void {
        this.readyState = RequestScopedWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: RequestScopedWebSocket,
    })

    try {
      for (let request = 0; request < 2; request += 1) {
        const result = await fetchZapoutAuthorityProfileEvents(
          [MERCHANT_PUBKEY],
          ["wss://commerce.example"]
        )
        expect(result.complete).toBe(true)
      }

      expect(sockets).toHaveLength(2)
      expect(sockets.every((socket) => socket.readyState === 3)).toBe(true)
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      })
    }
  })

  it("verifies a receipt while the recipient's current authority is unchanged", async () => {
    const deps = dependencies({ profileEvents: [profileEvent()] })
    const event = receipt()
    const response = await verifyZapoutAuthorityRequest(
      post([event]),
      env(),
      deps.value
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      results: [{ id: event.id, status: "verified" }],
    })
    expect(deps.fetchLnurlMetadata).toHaveBeenCalledWith(LUD16, {
      timeoutMs: 2_500,
    })
  })

  it("uses retained public attestation keys across shopper, provider, and attestor rotation", async () => {
    const event = await serverAttestedReceipt()
    const deps = dependencies({
      profileEvents: [
        profileEvent("merchant@new-wallet.example", NOW_SECONDS + 30),
      ],
    })
    const response = await verifyZapoutAuthorityRequest(
      post([event]),
      {
        ...env(),
        ANON_SIGNER_REQUEST_AUTH_SECRET: "44".repeat(32),
        ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS: [
          `${ROTATED_ATTESTATION_KEY_ID}:${ROTATED_ATTESTATION_PUBKEY}`,
          `${ATTESTATION_KEY_ID}:${ATTESTATION_PUBKEY}`,
        ].join(","),
      },
      deps.value
    )

    expect(await response.json()).toEqual({
      results: [{ id: event.id, status: "verified" }],
    })
    expect(deps.fetchLnurlMetadata).toHaveBeenCalledTimes(0)
  })

  it("reports a revoked or unknown attestation key as unavailable", async () => {
    const event = await serverAttestedReceipt()
    const response = await verifyZapoutAuthorityRequest(
      post([event]),
      {
        ...env(),
        ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS: `${ROTATED_ATTESTATION_KEY_ID}:${ROTATED_ATTESTATION_PUBKEY}`,
      },
      dependencies({}).value
    )

    expect(await response.json()).toEqual({
      results: [{ id: event.id, status: "authority_unavailable" }],
    })
  })

  it("does not trust a shopper-signed provider tag without the server proof", async () => {
    const event = receipt(PROVIDER_SECRET, true)
    const deps = dependencies({
      profileEvents: [
        profileEvent("merchant@new-wallet.example", NOW_SECONDS + 30),
      ],
    })
    const response = await verifyZapoutAuthorityRequest(
      post([event]),
      env(),
      deps.value
    )

    expect(await response.json()).toEqual({
      results: [{ id: event.id, status: "invalid" }],
    })
    expect(deps.fetchLnurlMetadata).toHaveBeenCalledTimes(0)
  })

  it("distinguishes incomplete authority from immutable LNURL binding mismatches", async () => {
    const event = receipt()
    const unavailable = await verifyZapoutAuthorityRequest(
      post([event]),
      env(),
      dependencies({ complete: false }).value
    )
    expect(await unavailable.json()).toEqual({
      results: [{ id: event.id, status: "authority_unavailable" }],
    })

    const mismatched = await verifyZapoutAuthorityRequest(
      post([event]),
      env(),
      dependencies({
        lnurlMetadata: metadata({
          payRequestUrl: "https://wallet.example/.well-known/lnurlp/different",
        }),
      }).value
    )
    expect(await mismatched.json()).toEqual({
      results: [{ id: event.id, status: "invalid" }],
    })
  })

  it("reports missing payment-time profile history as unavailable", async () => {
    const event = receipt()
    const response = await verifyZapoutAuthorityRequest(
      post([event]),
      env(),
      dependencies({
        profileEvents: [
          profileEvent("merchant@new-wallet.example", NOW_SECONDS + 30),
        ],
      }).value
    )

    expect(await response.json()).toEqual({
      results: [{ id: event.id, status: "authority_unavailable" }],
    })
  })

  it("does not treat mutable current metadata as historical payment-time authority", async () => {
    const event = receipt()
    const deps = dependencies({
      nowMs: (NOW_SECONDS + 301) * 1000,
    })
    const response = await verifyZapoutAuthorityRequest(
      post([event]),
      env(),
      deps.value
    )

    expect(await response.json()).toEqual({
      results: [{ id: event.id, status: "authority_unavailable" }],
    })
    expect(deps.fetchLnurlMetadata).toHaveBeenCalledTimes(0)
  })

  it("does not misclassify provider rotation and avoids authority egress for malformed receipts", async () => {
    const wrongProvider = receipt(OTHER_PROVIDER_SECRET)
    const wrongProviderResponse = await verifyZapoutAuthorityRequest(
      post([wrongProvider]),
      env(),
      dependencies({}).value
    )
    expect(await wrongProviderResponse.json()).toEqual({
      results: [{ id: wrongProvider.id, status: "authority_unavailable" }],
    })

    const rateLimitKeys: string[] = []
    const malformed = { ...receipt(), content: "tampered" }
    const deps = dependencies({})
    const malformedResponse = await verifyZapoutAuthorityRequest(
      post([malformed]),
      {
        ...env(),
        ANON_ZAP_RATE_LIMIT_SERVICE: {
          async fetch(request: Request) {
            const body = (await request.json()) as { keys: string[] }
            rateLimitKeys.push(...body.keys)
            return new Response(null, { status: 204 })
          },
        },
      },
      deps.value
    )
    expect(await malformedResponse.json()).toEqual({
      results: [{ id: malformed.id, status: "invalid" }],
    })
    expect(deps.fetchLnurlMetadata).toHaveBeenCalledTimes(0)
    expect(rateLimitKeys).toHaveLength(2)
    expect(rateLimitKeys[0]).toBe("authority:global")
    expect(rateLimitKeys[1]).toMatch(/^authority:source:/)
  })

  it("rejects spoofed request LNURLs before charging the recipient egress bucket", async () => {
    const spoofed = receipt(
      PROVIDER_SECRET,
      false,
      "https://wallet.example/.well-known/lnurlp/spoofed"
    )
    const rateLimitKeys: string[] = []
    const deps = dependencies({})
    const response = await verifyZapoutAuthorityRequest(
      post([spoofed]),
      {
        ...env(),
        ANON_ZAP_RATE_LIMIT_SERVICE: {
          async fetch(request: Request) {
            const body = (await request.json()) as { keys: string[] }
            rateLimitKeys.push(...body.keys)
            return new Response(null, { status: 204 })
          },
        },
      },
      deps.value
    )

    expect(await response.json()).toEqual({
      results: [{ id: spoofed.id, status: "invalid" }],
    })
    expect(rateLimitKeys).toHaveLength(2)
    expect(
      rateLimitKeys.some((key) => key.includes(":source-recipient:"))
    ).toBe(false)
    expect(deps.fetchLnurlMetadata).toHaveBeenCalledTimes(0)
  })

  it("isolates fallback source-recipient rate limits without suppressing attested receipts", async () => {
    const fallback = receipt()
    const attested = await serverAttestedReceipt()
    const response = await verifyZapoutAuthorityRequest(
      post([fallback, attested]),
      {
        ...env(),
        ANON_ZAP_RATE_LIMIT_SERVICE: {
          async fetch(request: Request) {
            const body = (await request.json()) as { keys: string[] }
            const recipientLookup = body.keys.some((key) =>
              key.startsWith("authority:source-recipient:")
            )
            return new Response(null, { status: recipientLookup ? 429 : 204 })
          },
        },
      },
      dependencies({}).value
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      results: [
        { id: fallback.id, status: "authority_unavailable" },
        { id: attested.id, status: "verified" },
      ],
    })
  })

  it("fails closed when authority abuse controls are unavailable or exceeded", async () => {
    const unavailable = await verifyZapoutAuthorityRequest(
      post(),
      { ...env(), ANON_ZAP_RATE_LIMIT_SERVICE: undefined },
      dependencies({}).value
    )
    expect(unavailable.status).toBe(503)

    const limited = await verifyZapoutAuthorityRequest(
      post(),
      env(false),
      dependencies({}).value
    )
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("60")
  })

  it("enforces origin, preflight, root wiring, and method boundaries", async () => {
    const forbidden = await authorityPost({
      request: post(),
      env: {
        ...env(),
        ANON_ZAP_ALLOWED_ORIGINS: "https://other.example",
      },
    })
    expect(forbidden.status).toBe(403)
    expect(authorityMethod()).toHaveProperty("status", 405)
    expect(authorityOptions({ request: post(), env: env() }).status).toBe(204)
    expect(rootAuthorityOptions({ request: post(), env: env() }).status).toBe(
      204
    )
  })
})

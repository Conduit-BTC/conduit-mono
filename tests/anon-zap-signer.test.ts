import { describe, expect, it, mock } from "bun:test"
import { EVENT_KINDS } from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import {
  type AnonZapSigningAuthorization,
  isAnonZapSignerConfigured,
  signCheckoutZapRequestWithAnonSigner,
  validateAnonZapSignerDraft,
} from "../apps/market/src/lib/anon-zap-signer"
import type { CheckoutZapRequestDraft } from "../apps/market/src/lib/checkout-payment"

const PRIVATE_KEY_BYTES = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 1,
])
const ANON_PUBKEY = getPublicKey(PRIVATE_KEY_BYTES)

type SignedTestZapRequest = ReturnType<typeof finalizeEvent>

function cloneSignedEvent(event: SignedTestZapRequest): SignedTestZapRequest {
  return {
    id: event.id,
    pubkey: event.pubkey,
    sig: event.sig,
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags.map((tag) => [...tag]),
  }
}

function draft(
  overrides: Partial<CheckoutZapRequestDraft> = {}
): CheckoutZapRequestDraft {
  return {
    kind: EVENT_KINDS.ZAP_REQUEST,
    createdAt: 1_700_000_000,
    content: "Anon shopper supported this merchant on Conduit",
    tags: [
      ["p", "b".repeat(64)],
      ["amount", "50000"],
      ["lnurl", "lnurl1test"],
      ["relays", "wss://relay.example"],
      ["client", "conduit-market"],
    ],
    ...overrides,
  }
}

function authorization(
  overrides: Partial<AnonZapSigningAuthorization> = {}
): AnonZapSigningAuthorization {
  return {
    checkoutSessionId: "checkout-session-test",
    merchantPubkey: "b".repeat(64),
    amountMsats: 50_000,
    lnurl: "lnurl1test",
    publicZapPolicy: "anonymous_public_zap_allowed",
    ...overrides,
  }
}

async function signedRawEventFor(request: CheckoutZapRequestDraft) {
  return cloneSignedEvent(
    finalizeEvent(
      {
        kind: request.kind,
        created_at: request.createdAt,
        content: request.content,
        tags: request.tags.map((tag) => [...tag]),
      },
      PRIVATE_KEY_BYTES
    )
  )
}

describe("Anon zap signer client", () => {
  it("requires the expected anon signer pubkey config", () => {
    expect(
      isAnonZapSignerConfigured({
        anonZapSignerUrl: null,
        anonZapSignerPubkey: ANON_PUBKEY,
      })
    ).toBe(true)
    expect(
      isAnonZapSignerConfigured({
        anonZapSignerUrl: "https://signer.example/zap",
        anonZapSignerPubkey: null,
      })
    ).toBe(false)
    expect(
      isAnonZapSignerConfigured({
        anonZapSignerUrl: "https://signer.example/zap",
        anonZapSignerPubkey: ANON_PUBKEY,
      })
    ).toBe(true)
  })

  it("rejects arbitrary/private tags before calling the signer", () => {
    const result = validateAnonZapSignerDraft(
      draft({
        tags: [
          ["p", "b".repeat(64)],
          ["amount", "50000"],
          ["lnurl", "lnurl1test"],
          ["relays", "wss://relay.example"],
          ["order", "private-order-id"],
        ],
      })
    )

    expect(result).toEqual({
      ok: false,
      reason: "Zap request contains private tags.",
    })
  })

  it("rejects signer calls without an expected Anon pubkey", async () => {
    const fetchImpl = mock(
      async () => new Response("{}")
    ) as unknown as typeof fetch

    await expect(
      signCheckoutZapRequestWithAnonSigner(draft(), {
        signerUrl: "https://signer.example/zap",
        fetchImpl,
        authorization: authorization(),
      })
    ).rejects.toThrow("Anon zap signer pubkey is not configured.")
    expect(fetchImpl).toHaveBeenCalledTimes(0)
  })

  it("posts only the validated zap request and returns the signed event", async () => {
    const request = draft()
    const rawEvent = await signedRawEventFor(request)
    let postedBody: unknown = null
    const fetchImpl = mock(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        postedBody = init?.body ? JSON.parse(String(init.body)) : null
        return new Response(
          JSON.stringify({
            id: rawEvent.id,
            rawEvent,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
    ) as unknown as typeof fetch

    const signed = await signCheckoutZapRequestWithAnonSigner(request, {
      expectedPubkey: ANON_PUBKEY,
      authorization: authorization(),
      fetchImpl,
    })

    expect(postedBody).toEqual({
      zapRequest: request,
      authorization: authorization(),
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(signed.id).toBe(rawEvent.id)
    expect(signed.rawEvent).toMatchObject({
      pubkey: ANON_PUBKEY,
      kind: request.kind,
      content: request.content,
      tags: request.tags,
    })
  })

  it("normalizes NIP-89 client tags before posting to the signer", async () => {
    const request = draft({
      tags: [
        ["p", "b".repeat(64)],
        ["amount", "50000"],
        ["lnurl", "lnurl1test"],
        ["relays", "wss://relay.example"],
        [
          "client",
          "Conduit Market",
          `31990:${"c".repeat(64)}:conduit-market`,
          "wss://relay.conduit.market",
        ],
      ],
    })
    const signerRequest = {
      ...request,
      tags: [
        ["p", "b".repeat(64)],
        ["amount", "50000"],
        ["lnurl", "lnurl1test"],
        ["relays", "wss://relay.example"],
        ["client", "conduit-market"],
      ],
    }
    const rawEvent = await signedRawEventFor(signerRequest)
    let postedBody: unknown = null
    const fetchImpl = mock(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        postedBody = init?.body ? JSON.parse(String(init.body)) : null
        return new Response(
          JSON.stringify({
            id: rawEvent.id,
            rawEvent,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
    ) as unknown as typeof fetch

    const signed = await signCheckoutZapRequestWithAnonSigner(request, {
      expectedPubkey: ANON_PUBKEY,
      authorization: authorization(),
      fetchImpl,
    })

    expect(postedBody).toEqual({
      zapRequest: signerRequest,
      authorization: authorization(),
    })
    expect(signed.rawEvent.tags).toEqual(signerRequest.tags)
  })

  it("rejects signer responses from an unexpected pubkey", async () => {
    const request = draft()
    const rawEvent = await signedRawEventFor(request)
    const fetchImpl = mock(async () => {
      return new Response(
        JSON.stringify({
          id: rawEvent.id,
          rawEvent: {
            ...rawEvent,
            pubkey: "e".repeat(64),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }) as unknown as typeof fetch

    await expect(
      signCheckoutZapRequestWithAnonSigner(request, {
        signerUrl: "https://signer.example/zap",
        expectedPubkey: ANON_PUBKEY,
        authorization: authorization(),
        fetchImpl,
      })
    ).rejects.toThrow("Anon zap signer returned the wrong pubkey.")
  })

  it("rejects signer responses with an invalid signature", async () => {
    const request = draft()
    const rawEvent = await signedRawEventFor(request)
    const fetchImpl = mock(async () => {
      return new Response(
        JSON.stringify({
          id: rawEvent.id,
          rawEvent: {
            ...rawEvent,
            sig: "d".repeat(128),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }) as unknown as typeof fetch

    await expect(
      signCheckoutZapRequestWithAnonSigner(request, {
        signerUrl: "https://signer.example/zap",
        expectedPubkey: ANON_PUBKEY,
        authorization: authorization(),
        fetchImpl,
      })
    ).rejects.toThrow("Anon zap signer returned an invalid signature.")
  })
})

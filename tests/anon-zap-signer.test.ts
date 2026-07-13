import { describe, expect, it, mock } from "bun:test"
import { EVENT_KINDS, OMF_ZAPOUT_MARKER_TAG } from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import {
  AnonZapAuthorizationError,
  isAnonZapSignerConfigured,
  signCheckoutZapRequestWithAnonSigner,
  validateAnonZapSignerDraft,
  type AnonZapCheckoutAuthorizationContext,
} from "../apps/market/src/lib/anon-zap-signer"
import type { CheckoutZapRequestDraft } from "../apps/market/src/lib/checkout-payment"

const MERCHANT_PUBKEY = "b".repeat(64)
const RECEIPT_PUBKEY = "c".repeat(64)
const SHOPPER_SECRET = Uint8Array.from([...new Uint8Array(31), 7])
const OTHER_SECRET = Uint8Array.from([...new Uint8Array(31), 8])
const SHOPPER_PUBKEY = getPublicKey(SHOPPER_SECRET)
const NOW_SECONDS = 1_800_000_000

function draft(
  overrides: Partial<CheckoutZapRequestDraft> = {}
): CheckoutZapRequestDraft {
  return {
    kind: EVENT_KINDS.ZAP_REQUEST,
    createdAt: NOW_SECONDS,
    content: "Zapped out 1 item on Conduit",
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

function context(): AnonZapCheckoutAuthorizationContext {
  return {
    merchantPubkey: MERCHANT_PUBKEY,
    amountMsats: 50_000,
    items: [
      {
        productAddress: `30402:${MERCHANT_PUBKEY}:test-product`,
        quantity: 1,
      },
    ],
  }
}

function signerConfig(pubkey = SHOPPER_PUBKEY) {
  return {
    anonZapSignerUrl: "/api/anon-zap-sign",
    anonZapSignerPubkey: pubkey,
  }
}

function createSignerFetch(
  options: {
    signerSecret?: Uint8Array
    signedContent?: string
    authorizeStatus?: number
  } = {}
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ url, body })
      if (url.endsWith("/api/anon-zap-authorize")) {
        if (options.authorizeStatus && options.authorizeStatus !== 200) {
          return Response.json(
            { error: "Anon zap authorization is unavailable." },
            { status: options.authorizeStatus }
          )
        }
        return Response.json({
          authorizationToken: "signed.checkout.token",
          expiresAt: NOW_SECONDS + 120,
          draft: draft(),
          lnurlCallback: "https://wallet.example/lnurl/callback",
          lnurlNostrPubkey: RECEIPT_PUBKEY,
          relayUrls: ["wss://relay.example"],
        })
      }

      const zapRequest = body.zapRequest as CheckoutZapRequestDraft
      const rawEvent = finalizeEvent(
        {
          kind: zapRequest.kind,
          created_at: zapRequest.createdAt,
          content: options.signedContent ?? zapRequest.content,
          tags: zapRequest.tags,
        },
        options.signerSecret ?? SHOPPER_SECRET
      )
      return Response.json({
        id: rawEvent.id,
        rawEvent,
        requestCreatedAt: zapRequest.createdAt,
        lnurlCallback: "https://wallet.example/lnurl/callback",
        lnurl: "lnurl1test",
        lnurlNostrPubkey: RECEIPT_PUBKEY,
        relayUrls: ["wss://relay.example"],
      })
    }
  ) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe("Anon zap signer client", () => {
  it("enables only with a client endpoint and valid public signer identity", () => {
    expect(isAnonZapSignerConfigured(signerConfig())).toBe(true)
    expect(
      isAnonZapSignerConfigured({
        anonZapSignerUrl: "",
        anonZapSignerPubkey: SHOPPER_PUBKEY,
      })
    ).toBe(false)
    expect(
      isAnonZapSignerConfigured({
        anonZapSignerUrl: "/api/anon-zap-sign",
        anonZapSignerPubkey: "not-a-pubkey",
      })
    ).toBe(false)
  })

  it("rejects arbitrary/private tags before signer authorization", () => {
    const result = validateAnonZapSignerDraft(
      draft({
        tags: [
          ["p", MERCHANT_PUBKEY],
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

  it("allows the canonical OMF zapout marker before authorization", () => {
    expect(
      validateAnonZapSignerDraft(
        draft({ tags: [...draft().tags, [...OMF_ZAPOUT_MARKER_TAG]] })
      )
    ).toEqual({ ok: true })
  })

  it("rejects expanded OMF marker payloads before authorization", () => {
    expect(
      validateAnonZapSignerDraft(
        draft({
          tags: [...draft().tags, ["omf", "zapout", "order-123"]],
        })
      )
    ).toEqual({
      ok: false,
      reason: "Zap request tag payload is invalid.",
    })
  })

  it("authorizes public coordinates, signs the canonical draft, and verifies the signer", async () => {
    const { fetchImpl, calls } = createSignerFetch()
    const signed = await signCheckoutZapRequestWithAnonSigner(
      draft(),
      context(),
      { fetchImpl, config: signerConfig() }
    )

    expect(calls.map((call) => call.url)).toEqual([
      "/api/anon-zap-authorize",
      "/api/anon-zap-sign",
    ])
    expect(calls[0]!.body).toEqual(context())
    expect(calls[1]!.body).toEqual({
      authorizationToken: "signed.checkout.token",
      zapRequest: draft(),
    })
    expect(signed.rawEvent).toMatchObject({
      id: signed.id,
      pubkey: SHOPPER_PUBKEY,
      kind: 9734,
    })
    expect(signed).toMatchObject({
      requestCreatedAt: NOW_SECONDS,
      lnurlCallback: "https://wallet.example/lnurl/callback",
      lnurl: "lnurl1test",
      lnurlNostrPubkey: RECEIPT_PUBKEY,
      relayUrls: ["wss://relay.example"],
    })
    expect(JSON.stringify(calls)).not.toContain("private-order-id")
  })

  it("rejects a valid event from any identity other than configured Anon Shopper", async () => {
    const { fetchImpl } = createSignerFetch({ signerSecret: OTHER_SECRET })
    await expect(
      signCheckoutZapRequestWithAnonSigner(draft(), context(), {
        fetchImpl,
        config: signerConfig(),
      })
    ).rejects.toThrow("Anon zap signer returned an invalid event.")
  })

  it("rejects a signed event that differs from the authorized draft", async () => {
    const { fetchImpl } = createSignerFetch({ signedContent: "mutated" })
    await expect(
      signCheckoutZapRequestWithAnonSigner(draft(), context(), {
        fetchImpl,
        config: signerConfig(),
      })
    ).rejects.toThrow("Anon zap signer returned an invalid event.")
  })

  it("fails before network access when signer configuration is invalid", async () => {
    const { fetchImpl } = createSignerFetch()
    await expect(
      signCheckoutZapRequestWithAnonSigner(draft(), context(), {
        fetchImpl,
        config: {
          anonZapSignerUrl: "",
          anonZapSignerPubkey: SHOPPER_PUBKEY,
        },
      })
    ).rejects.toBeInstanceOf(AnonZapAuthorizationError)
    expect(fetchImpl).toHaveBeenCalledTimes(0)
  })

  it("classifies authorization endpoint failures as pre-invoice failures", async () => {
    const { fetchImpl } = createSignerFetch({ authorizeStatus: 503 })
    await expect(
      signCheckoutZapRequestWithAnonSigner(draft(), context(), {
        fetchImpl,
        config: signerConfig(),
      })
    ).rejects.toThrow("Anon zap authorization is unavailable.")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("bounds a stalled authorization before invoice creation", async () => {
    const fetchImpl = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          )
        })
    ) as unknown as typeof fetch

    await expect(
      signCheckoutZapRequestWithAnonSigner(draft(), context(), {
        fetchImpl,
        config: signerConfig(),
        authorizationTimeoutMs: 5,
      })
    ).rejects.toThrow("Anon zap authorization timed out.")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

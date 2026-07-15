import { describe, expect, it, mock } from "bun:test"
import { EVENT_KINDS } from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools"

import {
  AnonZapAuthorizationError,
  authorizeCheckoutWithAnonSigner,
  isAnonZapSignerConfigured,
  prepareAnonZapCheckout,
  signCheckoutZapRequestWithAnonSigner,
  validateAnonZapSignerDraft,
  type AuthorizedAnonZapCheckoutClient,
  type AnonZapCheckoutAuthorizationContext,
} from "../apps/market/src/lib/anon-zap-signer"
import type {
  CheckoutPricingIntent,
  CheckoutZapRequestDraft,
} from "../apps/market/src/lib/checkout-payment"

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
    content: "Zapped out 1 item at https://shop.conduit.market/",
    tags: [
      ["p", MERCHANT_PUBKEY],
      ["amount", "50000"],
      ["lnurl", "lnurl1test"],
      ["relays", "wss://relay.example"],
      ["omf", "zapout"],
      ["omf_provider", RECEIPT_PUBKEY],
      ["omf_auth", "test-2026", "a".repeat(128)],
      ["client", "conduit-market"],
    ],
    ...overrides,
  }
}

function context(): AnonZapCheckoutAuthorizationContext {
  return {
    merchantPubkey: MERCHANT_PUBKEY,
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

function localPricing(
  unitPriceSats = 50
): Extract<CheckoutPricingIntent, { status: "ok" }> {
  return {
    status: "ok",
    itemSubtotalSats: unitPriceSats,
    totalSats: unitPriceSats,
    totalMsats: unitPriceSats * 1_000,
    items: [
      {
        productId: `30402:${MERCHANT_PUBKEY}:test-product`,
        format: "digital",
        quantity: 1,
        priceAtPurchase: unitPriceSats,
        currency: "SATS",
        shippingCostSats: 0,
      },
    ],
    shippingCost: {
      status: "not_required",
      totalSats: 0,
      missingProductIds: [],
    },
    approximate: false,
  }
}

function authorization(unitPriceSats = 50): AuthorizedAnonZapCheckoutClient {
  return {
    authorizationToken: "signed.checkout.token",
    expiresAt: NOW_SECONDS + 120,
    draft: draft({
      tags: draft().tags.map((tag) =>
        tag[0] === "amount" ? ["amount", String(unitPriceSats * 1_000)] : tag
      ),
    }),
    lnurlCallback: "https://wallet.example/lnurl/callback",
    lnurlNostrPubkey: RECEIPT_PUBKEY,
    relayUrls: ["wss://relay.example"],
    pricing: {
      itemSubtotalSats: unitPriceSats,
      shippingCostSats: 0,
      totalSats: unitPriceSats,
      totalMsats: unitPriceSats * 1_000,
      items: [
        {
          productAddress: `30402:${MERCHANT_PUBKEY}:test-product`,
          productEventId: "d".repeat(64),
          format: "digital",
          quantity: 1,
          unitPriceSats,
          unitShippingSats: 0,
          lineTotalSats: unitPriceSats,
          shippingCountryRules: [],
        },
      ],
    },
  }
}

function createSignerFetch(
  options: {
    signerSecret?: Uint8Array
    signedContent?: string
    authorizeStatus?: number
    shippingOptionId?: unknown
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
          pricing: {
            itemSubtotalSats: 50,
            shippingCostSats: 0,
            totalSats: 50,
            totalMsats: 50_000,
            items: [
              {
                productAddress: `30402:${MERCHANT_PUBKEY}:test-product`,
                productEventId: "d".repeat(64),
                format: "digital",
                quantity: 1,
                unitPriceSats: 50,
                unitShippingSats: 0,
                lineTotalSats: 50,
                shippingCountryRules: [],
                ...(options.shippingOptionId === undefined
                  ? {}
                  : { shippingOptionId: options.shippingOptionId }),
              },
            ],
          },
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
    expect(validateAnonZapSignerDraft(draft())).toEqual({ ok: true })
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

  it("rejects malformed server fulfillment identity before signing", async () => {
    const { fetchImpl } = createSignerFetch({ shippingOptionId: 42 })
    await expect(
      authorizeCheckoutWithAnonSigner(context(), {
        fetchImpl,
        config: signerConfig(),
      })
    ).rejects.toThrow("Anon zap authorization pricing is invalid.")
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

  it("does not sign when checkout authorization fails", async () => {
    let signCalls = 0

    await expect(
      prepareAnonZapCheckout({
        context: context(),
        localPricing: localPricing(),
        destination: { country: "US", postalCode: "94107" },
        dependencies: {
          authorize: async () => {
            throw new Error("authorization rejected")
          },
          sign: async () => {
            signCalls += 1
            throw new Error("must not sign")
          },
        },
      })
    ).rejects.toThrow("authorization rejected")
    expect(signCalls).toBe(0)
  })

  it("requires pricing review before signing a newly authorized request", async () => {
    let signCalls = 0

    const result = await prepareAnonZapCheckout({
      context: context(),
      localPricing: localPricing(50),
      destination: { country: "US", postalCode: "94107" },
      dependencies: {
        authorize: async () => authorization(51),
        sign: async () => {
          signCalls += 1
          throw new Error("must not sign")
        },
      },
    })

    expect(result.status).toBe("review_required")
    expect(result.checkoutPricing.totalSats).toBe(51)
    expect(signCalls).toBe(0)
  })
})

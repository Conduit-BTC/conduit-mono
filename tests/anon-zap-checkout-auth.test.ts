import { describe, expect, it } from "bun:test"
import {
  authorizeAnonZapCheckout,
  parseAnonZapCheckoutIntent,
  type LnurlPayMetadata,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { finalizeEvent, getPublicKey } from "nostr-tools"

const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 2])
const RECEIPT_SECRET = Uint8Array.from([...new Uint8Array(31), 3])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const RECEIPT_PUBKEY = getPublicKey(RECEIPT_SECRET)
const NOW_SECONDS = 1_800_000_000
const PRODUCT_D_TAG = "cnd-150-test-product"
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}`

function signMerchantEvent(input: {
  kind: number
  createdAt?: number
  tags?: string[][]
  content?: string
}): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: input.kind,
      created_at: input.createdAt ?? NOW_SECONDS - 60,
      tags: input.tags ?? [],
      content: input.content ?? "",
    },
    MERCHANT_SECRET
  )
}

function productEvent(
  overrides: {
    createdAt?: number
    priceSats?: number
    publicZapPolicy?: "true" | "false" | "unknown"
    shippingCostSats?: number | null
    dTag?: string
  } = {}
): SignedPublicNostrEvent {
  const publicZapPolicy = overrides.publicZapPolicy ?? "true"
  const shippingCostSats = overrides.shippingCostSats
  const tags: string[][] = [
    ["d", overrides.dTag ?? PRODUCT_D_TAG],
    ["title", "CND-150 test product"],
    ["price", String(overrides.priceSats ?? 10), "SATS"],
    ["type", "simple", shippingCostSats === undefined ? "digital" : "physical"],
    ["image", "https://cdn.example/cnd-150.png"],
    ["checkout_zap_message_policy", "generic_only"],
  ]
  if (publicZapPolicy !== "unknown") {
    tags.push(["checkout_public_zaps", publicZapPolicy])
  }
  if (shippingCostSats !== undefined && shippingCostSats !== null) {
    tags.push(["shipping_cost", String(shippingCostSats)])
  }
  return signMerchantEvent({
    kind: 30402,
    createdAt: overrides.createdAt,
    tags,
    content: "A signed public checkout fixture.",
  })
}

function profileEvent(): SignedPublicNostrEvent {
  return signMerchantEvent({
    kind: 0,
    content: JSON.stringify({ lud16: "merchant@wallet.example" }),
  })
}

function lnurlMetadata(
  overrides: Partial<LnurlPayMetadata> = {}
): LnurlPayMetadata {
  return {
    payRequestUrl: "https://wallet.example/.well-known/lnurlp/merchant",
    lnurl: "lnurl1cnd150test",
    callback: "https://wallet.example/lnurl/callback",
    minSendable: 1_000,
    maxSendable: 100_000_000,
    tag: "payRequest",
    allowsNostr: true,
    nostrPubkey: RECEIPT_PUBKEY,
    metadata: "[]",
    ...overrides,
  }
}

function authorize(
  overrides: Partial<Parameters<typeof authorizeAnonZapCheckout>[0]> = {}
) {
  return authorizeAnonZapCheckout({
    intent: {
      merchantPubkey: MERCHANT_PUBKEY,
      amountMsats: 10_000,
      items: [{ productAddress: PRODUCT_ADDRESS, quantity: 1 }],
    },
    productEvents: [productEvent()],
    profileEvents: [profileEvent()],
    deletionEvents: [],
    lnurlMetadata: lnurlMetadata(),
    receiptRelayUrls: ["wss://relay.example"],
    nowSeconds: NOW_SECONDS,
    ...overrides,
  })
}

describe("anonymous public zap checkout authorization", () => {
  it("parses only bounded public product coordinates", () => {
    expect(
      parseAnonZapCheckoutIntent({
        merchantPubkey: MERCHANT_PUBKEY.toUpperCase(),
        amountMsats: 20_000,
        items: [{ productAddress: PRODUCT_ADDRESS, quantity: 2 }],
      })
    ).toEqual({
      merchantPubkey: MERCHANT_PUBKEY,
      amountMsats: 20_000,
      items: [{ productAddress: PRODUCT_ADDRESS, quantity: 2 }],
    })

    expect(
      parseAnonZapCheckoutIntent({
        merchantPubkey: MERCHANT_PUBKEY,
        amountMsats: 20_000,
        items: [{ productAddress: PRODUCT_ADDRESS, quantity: 2 }],
        orderId: "must-not-be-trusted",
        email: "private@example.com",
      })
    ).toBeNull()

    expect(
      parseAnonZapCheckoutIntent({
        merchantPubkey: MERCHANT_PUBKEY,
        amountMsats: 20_000,
        items: [
          {
            productAddress: PRODUCT_ADDRESS,
            quantity: 2,
            note: "private item note",
          },
        ],
      })
    ).toBeNull()

    expect(
      parseAnonZapCheckoutIntent({
        merchantPubkey: MERCHANT_PUBKEY,
        amountMsats: 10_000,
        items: [
          {
            productAddress: `30402:${RECEIPT_PUBKEY}:${PRODUCT_D_TAG}`,
            quantity: 1,
          },
        ],
      })
    ).toBeNull()

    for (const dTag of ["bad\nvalue", "x".repeat(129)]) {
      expect(
        parseAnonZapCheckoutIntent({
          merchantPubkey: MERCHANT_PUBKEY,
          amountMsats: 10_000,
          items: [
            {
              productAddress: `30402:${MERCHANT_PUBKEY}:${dTag}`,
              quantity: 1,
            },
          ],
        })
      ).toBeNull()
    }
  })

  it("builds a server-owned generic request from signed public state", () => {
    const result = authorize({
      intent: {
        merchantPubkey: MERCHANT_PUBKEY,
        amountMsats: 30_000,
        items: [{ productAddress: PRODUCT_ADDRESS, quantity: 2 }],
      },
      productEvents: [productEvent({ shippingCostSats: 5 })],
    })

    expect(result.draft).toEqual({
      kind: 9734,
      createdAt: NOW_SECONDS,
      content: "Zapped out 2 items on Conduit",
      tags: [
        ["p", MERCHANT_PUBKEY],
        ["amount", "30000"],
        ["lnurl", "lnurl1cnd150test"],
        ["relays", "wss://relay.example"],
        ["omf", "zapout"],
        ["client", "conduit-market"],
      ],
    })
    expect(result.authorization).toEqual({
      merchantPubkey: MERCHANT_PUBKEY,
      amountMsats: 30_000,
      lnurl: "lnurl1cnd150test",
      publicZapPolicy: "anonymous_public_zap_allowed",
    })
    expect(result.lnurlNostrPubkey).toBe(RECEIPT_PUBKEY)
  })

  it("rejects client amount mutation", () => {
    expect(() =>
      authorize({
        intent: {
          merchantPubkey: MERCHANT_PUBKEY,
          amountMsats: 11_000,
          items: [{ productAddress: PRODUCT_ADDRESS, quantity: 1 }],
        },
      })
    ).toThrow("Checkout amount does not match current product pricing.")
  })

  it("requires an explicit current public-zap opt-in", () => {
    for (const publicZapPolicy of ["false", "unknown"] as const) {
      expect(() =>
        authorize({ productEvents: [productEvent({ publicZapPolicy })] })
      ).toThrow("Checkout product does not explicitly allow public zaps.")
    }
  })

  it("rejects invalid signatures and conflicting latest listings", () => {
    const signed = productEvent()
    const tampered = { ...signed, content: "tampered after signing" }
    expect(() => authorize({ productEvents: [tampered] })).toThrow(
      "Checkout product is unavailable."
    )

    expect(() =>
      authorize({
        productEvents: [
          productEvent({ createdAt: NOW_SECONDS - 10, priceSats: 10 }),
          productEvent({ createdAt: NOW_SECONDS - 10, priceSats: 11 }),
        ],
      })
    ).toThrow("Checkout product has conflicting latest events.")
  })

  it("rejects products deleted by address or exact event id", () => {
    const product = productEvent()
    for (const target of [
      ["a", PRODUCT_ADDRESS],
      ["e", product.id],
    ]) {
      const deletion = signMerchantEvent({
        kind: 5,
        createdAt: NOW_SECONDS,
        tags: [target],
      })
      expect(() =>
        authorize({ productEvents: [product], deletionEvents: [deletion] })
      ).toThrow("Checkout product is no longer active.")
    }
  })

  it("rejects coordinated shipping", () => {
    expect(() =>
      authorize({ productEvents: [productEvent({ shippingCostSats: null })] })
    ).toThrow("Checkout product requires merchant-coordinated shipping.")
  })

  it("binds authorization to the merchant profile LNURL endpoint", () => {
    expect(() =>
      authorize({
        lnurlMetadata: lnurlMetadata({
          payRequestUrl: "https://attacker.example/.well-known/lnurlp/merchant",
        }),
      })
    ).toThrow("Merchant Lightning Address metadata is invalid.")

    expect(() =>
      authorize({
        lnurlMetadata: lnurlMetadata({ allowsNostr: false }),
      })
    ).toThrow("Merchant Lightning Address does not support public zaps.")
  })
})

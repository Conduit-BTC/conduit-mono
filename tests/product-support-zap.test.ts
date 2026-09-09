import { describe, expect, it, mock } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"

import {
  buildProductSupportZapRequest,
  normalizeProductSupportZapNote,
  prepareProductSupportZapInvoice,
  PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS,
  type ProductSupportZapDependencies,
} from "../packages/core/src/protocol/product-support-zap"
import type { NostrEventSigner } from "../packages/core/src/protocol/nostr-event-signer"

const SHOPPER_SECRET = generateSecretKey()
const MERCHANT_SECRET = generateSecretKey()
const PROVIDER_SECRET = generateSecretKey()
const SHOPPER_PUBKEY = getPublicKey(SHOPPER_SECRET)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const PROVIDER_PUBKEY = getPublicKey(PROVIDER_SECRET)
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:coffee-mug`

function signer(
  pubkey = SHOPPER_PUBKEY,
  secret = SHOPPER_SECRET
): NostrEventSigner {
  return {
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, secret),
  }
}

function dependencies(overrides: Partial<ProductSupportZapDependencies> = {}) {
  return {
    fetchLnurlPayMetadata: mock(async () => ({
      payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
      lnurl: "lnurl1product",
      callback: "https://pay.example/zap",
      minSendable: 1_000,
      maxSendable: 1_000_000_000,
      tag: "payRequest",
      allowsNostr: true,
      nostrPubkey: PROVIDER_PUBKEY,
      metadata: "[]",
    })),
    fetchZapInvoice: mock(async () => ({ invoice: "lnbc1bound" })),
    validateLightningInvoiceForPayment: mock(() => ({
      ok: true as const,
      metadata: {
        msats: 21_000,
        sats: 21,
        currency: "MSATS" as const,
        createdAt: 1_700_000_001,
        expiresAt: 1_700_003_601,
      },
    })),
    ...overrides,
  } satisfies ProductSupportZapDependencies
}

describe("product support zap request", () => {
  it("builds one canonical NIP-57 product target with the note only in content", () => {
    const draft = buildProductSupportZapRequest({
      shopperPubkey: SHOPPER_PUBKEY.toUpperCase(),
      recipientPubkey: MERCHANT_PUBKEY.toUpperCase(),
      productAddress: PRODUCT_ADDRESS,
      amountMsats: 21_000,
      lnurl: "lnurl1product",
      relayUrls: [
        "wss://relay.example/",
        "wss://relay.example",
        "http://insecure.example",
      ],
      note: "  great\r\nproduct 🔥  ",
      nowSeconds: 1_700_000_000,
    })

    expect(draft).toMatchObject({
      kind: 9734,
      pubkey: SHOPPER_PUBKEY,
      created_at: 1_700_000_000,
      content: "great\nproduct 🔥",
    })
    expect(draft.tags.slice(0, 6)).toEqual([
      ["p", MERCHANT_PUBKEY],
      ["amount", "21000"],
      ["lnurl", "lnurl1product"],
      ["relays", "wss://relay.example"],
      ["a", PRODUCT_ADDRESS],
      ["k", "30402"],
    ])
    expect(draft.tags.some((tag) => tag[0] === "omf")).toBe(false)
    expect(draft.content).not.toContain("nostr:")
  })

  it("preserves the target while an empty note stays empty", () => {
    const draft = buildProductSupportZapRequest({
      shopperPubkey: SHOPPER_PUBKEY,
      recipientPubkey: MERCHANT_PUBKEY,
      productAddress: PRODUCT_ADDRESS,
      amountMsats: 1_000,
      lnurl: "lnurl1product",
      relayUrls: ["wss://relay.example"],
      note: " \r\n\t ",
      nowSeconds: 1_700_000_000,
    })

    expect(draft.content).toBe("")
    expect(draft.tags).toContainEqual(["a", PRODUCT_ADDRESS])
  })

  it("normalizes controls and truncates by Unicode code point", () => {
    const note = `${"a".repeat(279)}🔥b\u0000`
    const normalized = normalizeProductSupportZapNote(note)

    expect(Array.from(normalized)).toHaveLength(
      PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS
    )
    expect(normalized).toBe(`${"a".repeat(279)}🔥`)
    expect(normalized.endsWith("\ud83d")).toBe(false)
  })

  it("rejects invalid identity, target, amount, LNURL, or relay inputs", () => {
    const valid = {
      shopperPubkey: SHOPPER_PUBKEY,
      recipientPubkey: MERCHANT_PUBKEY,
      productAddress: PRODUCT_ADDRESS,
      amountMsats: 21_000,
      lnurl: "lnurl1product",
      relayUrls: ["wss://relay.example"],
      nowSeconds: 1_700_000_000,
    }

    expect(() =>
      buildProductSupportZapRequest({ ...valid, shopperPubkey: "invalid" })
    ).toThrow("shopper")
    expect(() =>
      buildProductSupportZapRequest({
        ...valid,
        recipientPubkey: PROVIDER_PUBKEY,
      })
    ).toThrow("recipient")
    expect(() =>
      buildProductSupportZapRequest({ ...valid, amountMsats: 1.5 })
    ).toThrow("amount")
    expect(() =>
      buildProductSupportZapRequest({ ...valid, lnurl: "https://pay.example" })
    ).toThrow("LNURL")
    expect(() =>
      buildProductSupportZapRequest({
        ...valid,
        relayUrls: ["ws://insecure.example"],
      })
    ).toThrow("relay")
  })
})

describe("product support zap invoice preparation", () => {
  it("signs the exact public request and asks for a description-bound invoice", async () => {
    const deps = dependencies()
    const result = await prepareProductSupportZapInvoice(
      {
        signer: signer(),
        shopperPubkey: SHOPPER_PUBKEY,
        recipientPubkey: MERCHANT_PUBKEY,
        productAddress: PRODUCT_ADDRESS,
        lud16: "merchant@example.com",
        amountSats: 21,
        note: "nice mug",
        relayUrls: ["wss://relay.example"],
        nowSeconds: 1_700_000_000,
      },
      deps
    )

    expect(result).toMatchObject({
      invoice: "lnbc1bound",
      amountMsats: 21_000,
      productAddress: PRODUCT_ADDRESS,
      receiptPubkey: PROVIDER_PUBKEY,
      receiptRelayUrls: ["wss://relay.example"],
    })
    expect(result.zapRequest.content).toBe("nice mug")
    expect(deps.fetchLnurlPayMetadata).toHaveBeenCalledWith(
      "merchant@example.com"
    )
    expect(deps.fetchZapInvoice).toHaveBeenCalledTimes(1)
    const zapRequestJson = deps.fetchZapInvoice.mock.calls[0]?.[2]
    expect(deps.fetchZapInvoice).toHaveBeenCalledWith(
      "https://pay.example/zap",
      21_000,
      expect.any(String),
      "lnurl1product"
    )
    expect(JSON.parse(zapRequestJson ?? "{}")).toEqual(result.zapRequest)
    expect(deps.validateLightningInvoiceForPayment).toHaveBeenCalledWith({
      invoice: "lnbc1bound",
      expectedAmountMsats: 21_000,
    })
  })

  it("does not copy caller-supplied commerce-private fields into the public event", async () => {
    const deps = dependencies()
    await prepareProductSupportZapInvoice(
      {
        signer: signer(),
        shopperPubkey: SHOPPER_PUBKEY,
        recipientPubkey: MERCHANT_PUBKEY,
        productAddress: PRODUCT_ADDRESS,
        lud16: "merchant@example.com",
        amountSats: 21,
        note: "public note",
        relayUrls: ["wss://relay.example"],
        nowSeconds: 1_700_000_000,
        orderId: "private-order",
        shippingAddress: "private-address",
        invoice: "private-invoice",
        walletSecret: "private-secret",
      } as Parameters<typeof prepareProductSupportZapInvoice>[0] &
        Record<string, string>,
      deps
    )

    const emitted = deps.fetchZapInvoice.mock.calls[0]?.[2] ?? ""
    expect(emitted).toContain("public note")
    for (const privateValue of [
      "private-order",
      "private-address",
      "private-invoice",
      "private-secret",
    ]) {
      expect(emitted).not.toContain(privateValue)
    }
  })

  it("fails before signing when the endpoint cannot issue public zaps", async () => {
    const sign = mock(signer().signEvent)
    const deps = dependencies({
      fetchLnurlPayMetadata: mock(async () => ({
        payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
        lnurl: "lnurl1product",
        callback: "https://pay.example/zap",
        minSendable: 1_000,
        maxSendable: 1_000_000,
        tag: "payRequest",
        allowsNostr: false,
        metadata: "[]",
      })),
    })

    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: { ...signer(), signEvent: sign },
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          lud16: "merchant@example.com",
          amountSats: 21,
          relayUrls: ["wss://relay.example"],
        },
        deps
      )
    ).rejects.toThrow("does not support public zaps")
    expect(sign).toHaveBeenCalledTimes(0)
    expect(deps.fetchZapInvoice).toHaveBeenCalledTimes(0)
  })

  it("fails closed for invalid provider identity or an out-of-range amount", async () => {
    const invalidProvider = dependencies({
      fetchLnurlPayMetadata: mock(async () => ({
        payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
        lnurl: "lnurl1product",
        callback: "https://pay.example/zap",
        minSendable: 1_000,
        maxSendable: 1_000_000,
        tag: "payRequest",
        allowsNostr: true,
        nostrPubkey: "f".repeat(64),
        metadata: "[]",
      })),
    })
    const input = {
      signer: signer(),
      shopperPubkey: SHOPPER_PUBKEY,
      recipientPubkey: MERCHANT_PUBKEY,
      productAddress: PRODUCT_ADDRESS,
      lud16: "merchant@example.com",
      amountSats: 21,
      relayUrls: ["wss://relay.example"],
    }

    await expect(
      prepareProductSupportZapInvoice(input, invalidProvider)
    ).rejects.toThrow("receipt key")

    const outOfRange = dependencies({
      fetchLnurlPayMetadata: mock(async () => ({
        payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
        lnurl: "lnurl1product",
        callback: "https://pay.example/zap",
        minSendable: 50_000,
        maxSendable: 100_000,
        tag: "payRequest",
        allowsNostr: true,
        nostrPubkey: PROVIDER_PUBKEY,
        metadata: "[]",
      })),
    })
    await expect(
      prepareProductSupportZapInvoice(input, outOfRange)
    ).rejects.toThrow("outside the merchant wallet range")
  })

  it("rejects signer authority changes and altered signed requests before invoice fetch", async () => {
    const changedAuthority = dependencies()
    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: signer(MERCHANT_PUBKEY, MERCHANT_SECRET),
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          lud16: "merchant@example.com",
          amountSats: 21,
          relayUrls: ["wss://relay.example"],
        },
        changedAuthority
      )
    ).rejects.toThrow("does not match")
    expect(changedAuthority.fetchZapInvoice).toHaveBeenCalledTimes(0)

    const alteredRequest = dependencies()
    const alteringSigner: NostrEventSigner = {
      ...signer(),
      signEvent: async (event) =>
        finalizeEvent({ ...event, content: "changed" }, SHOPPER_SECRET),
    }
    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: alteringSigner,
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          lud16: "merchant@example.com",
          amountSats: 21,
          note: "original",
          relayUrls: ["wss://relay.example"],
        },
        alteredRequest
      )
    ).rejects.toThrow("altered")
    expect(alteredRequest.fetchZapInvoice).toHaveBeenCalledTimes(0)
  })

  it("does not surface an invoice that fails amount, network, or expiry validation", async () => {
    const deps = dependencies({
      validateLightningInvoiceForPayment: mock(() => ({
        ok: false as const,
        reason: "The invoice amount does not match.",
        metadata: {
          msats: 1_000,
          sats: 1,
          currency: "MSATS" as const,
          createdAt: 1_700_000_001,
          expiresAt: 1_700_003_601,
        },
      })),
    })

    await expect(
      prepareProductSupportZapInvoice(
        {
          signer: signer(),
          shopperPubkey: SHOPPER_PUBKEY,
          recipientPubkey: MERCHANT_PUBKEY,
          productAddress: PRODUCT_ADDRESS,
          lud16: "merchant@example.com",
          amountSats: 21,
          relayUrls: ["wss://relay.example"],
        },
        deps
      )
    ).rejects.toThrow("invoice amount does not match")
  })
})

import { describe, expect, it, mock } from "bun:test"
import type { LnurlPayMetadata } from "@conduit/core"
import { resolveCheckoutSparkLnurlInvoice } from "../apps/market/src/lib/checkout-spark-lnurl-invoice"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  type Bolt11FixtureField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW_SECONDS = 1_800_000_000
const LUD16 = "seller@wallet.conduit.market"
const CALLBACK = "https://wallet.conduit.market/lnurlp/callback"
const PAYMENT_HASH = "07".repeat(32)

function signedInvoice(
  amountSats: number,
  options: {
    network?: "mainnet" | "regtest"
    createdAt?: number
    fields?: Bolt11FixtureField[]
    invalidSignature?: boolean
  } = {}
): string {
  const prefix = options.network === "regtest" ? "lnbcrt" : "lnbc"
  return makeSignedBolt11Fixture({
    hrp: `${prefix}${amountSats * 10}n`,
    createdAt: options.createdAt ?? NOW_SECONDS,
    fields: options.fields ?? [
      bolt11PaymentHashField(),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
    invalidSignature: options.invalidSignature,
  })
}

function lnurlMetadata(
  overrides: Partial<LnurlPayMetadata> = {}
): LnurlPayMetadata {
  return {
    payRequestUrl: "https://wallet.conduit.market/.well-known/lnurlp/seller",
    lnurl: "lnurl1test",
    callback: CALLBACK,
    minSendable: 1_000,
    maxSendable: 1_000_000,
    tag: "payRequest",
    allowsNostr: false,
    metadata: "[]",
    ...overrides,
  }
}

function request(amountSats = 5) {
  return {
    lud16: LUD16,
    amountSats,
    network: "mainnet" as const,
    nowSeconds: NOW_SECONDS,
    shouldContinue: () => true,
  }
}

describe("checkout Spark private LNURL invoice resolution", () => {
  it("returns a signed exact invoice from a plain two-argument callback without requiring Nostr support", async () => {
    const invoice = signedInvoice(5)
    const fetchMetadata = mock(async () => lnurlMetadata())
    const fetchInvoice = mock(async () => ({ invoice }))

    expect(
      await resolveCheckoutSparkLnurlInvoice(request(), {
        fetchMetadata,
        fetchInvoice,
      })
    ).toEqual({
      paymentRequest: invoice,
      paymentHash: PAYMENT_HASH,
      expiresAt: NOW_SECONDS + 3_600,
    })
    expect(fetchMetadata).toHaveBeenCalledWith(LUD16)
    expect(fetchInvoice).toHaveBeenCalledTimes(1)
    expect(fetchInvoice).toHaveBeenCalledWith(CALLBACK, 5_000)
  })

  it("rejects invalid recipient, amount, network, and time before network I/O", async () => {
    const fetchMetadata = mock(async () => lnurlMetadata())
    for (const input of [
      { ...request(), lud16: "not-an-address" },
      { ...request(), amountSats: 0 },
      { ...request(), amountSats: Number.MAX_SAFE_INTEGER },
      { ...request(), amountSats: 1.5 },
      { ...request(), network: "testnet" as "mainnet" },
      { ...request(), nowSeconds: -1 },
    ]) {
      await expect(
        resolveCheckoutSparkLnurlInvoice(input, { fetchMetadata })
      ).rejects.toThrow()
    }
    expect(fetchMetadata).toHaveBeenCalledTimes(0)
  })

  it("enforces the LNURL minimum and maximum before requesting an invoice", async () => {
    let minSendable = 2_000
    const fetchMetadata = mock(async () => lnurlMetadata({ minSendable }))
    const fetchInvoice = mock(async () => ({ invoice: signedInvoice(5) }))
    for (const amountSats of [1, 1_001]) {
      await expect(
        resolveCheckoutSparkLnurlInvoice(request(amountSats), {
          fetchMetadata,
          fetchInvoice,
        })
      ).rejects.toThrow()
    }
    expect(fetchInvoice).toHaveBeenCalledTimes(0)

    minSendable = 1_000
    await expect(
      resolveCheckoutSparkLnurlInvoice(request(1), {
        fetchMetadata,
        fetchInvoice: async () => ({ invoice: signedInvoice(1) }),
      })
    ).resolves.toMatchObject({ paymentHash: PAYMENT_HASH })
  })

  it("refuses an unsafe callback supplied by a degraded metadata adapter", async () => {
    const fetchInvoice = mock(async () => ({ invoice: signedInvoice(5) }))
    await expect(
      resolveCheckoutSparkLnurlInvoice(request(), {
        fetchMetadata: async () =>
          lnurlMetadata({ callback: "https://127.0.0.1/callback" }),
        fetchInvoice,
      })
    ).rejects.toThrow("callback is unsafe")
    expect(fetchInvoice).toHaveBeenCalledTimes(0)
  })

  it("rejects wrong amount, network, expiry, signature, and payment-hash evidence", async () => {
    const duplicateHashFields = [
      bolt11PaymentHashField(),
      bolt11PaymentHashField(),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ]
    const badInvoices = [
      signedInvoice(6),
      signedInvoice(5, { network: "regtest" }),
      signedInvoice(5, { createdAt: NOW_SECONDS - 3_600 }),
      signedInvoice(5, { invalidSignature: true }),
      signedInvoice(5, { fields: duplicateHashFields }),
    ]
    for (const invoice of badInvoices) {
      await expect(
        resolveCheckoutSparkLnurlInvoice(request(), {
          fetchMetadata: async () => lnurlMetadata(),
          fetchInvoice: async () => ({ invoice }),
        })
      ).rejects.toThrow()
    }
  })

  it("fails closed on metadata and invoice transport errors without exposing endpoint details", async () => {
    await expect(
      resolveCheckoutSparkLnurlInvoice(request(), {
        fetchMetadata: async () => {
          throw new Error(`network failure for ${LUD16}`)
        },
      })
    ).rejects.toThrow("recipient payment endpoint is unavailable")
    await expect(
      resolveCheckoutSparkLnurlInvoice(request(), {
        fetchMetadata: async () => lnurlMetadata(),
        fetchInvoice: async () => {
          throw new Error(`network failure for ${CALLBACK}`)
        },
      })
    ).rejects.toThrow("recipient invoice is unavailable")
  })

  it("stops after each network await if the authorized checkout changes", async () => {
    let current = true
    const fetchInvoice = mock(async () => ({ invoice: signedInvoice(5) }))
    await expect(
      resolveCheckoutSparkLnurlInvoice(
        { ...request(), shouldContinue: () => current },
        {
          fetchMetadata: async () => {
            current = false
            return lnurlMetadata()
          },
          fetchInvoice,
        }
      )
    ).rejects.toThrow("payout authority changed")
    expect(fetchInvoice).toHaveBeenCalledTimes(0)

    current = true
    await expect(
      resolveCheckoutSparkLnurlInvoice(
        { ...request(), shouldContinue: () => current },
        {
          fetchMetadata: async () => lnurlMetadata(),
          fetchInvoice: async () => {
            current = false
            return { invoice: signedInvoice(5) }
          },
        }
      )
    ).rejects.toThrow("payout authority changed")
  })
})

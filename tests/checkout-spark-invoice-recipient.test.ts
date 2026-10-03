import { describe, expect, it, spyOn } from "bun:test"
import {
  createCheckoutSparkInvoiceRecipientRecord,
  hasCheckoutSparkInvoiceRecipient,
  verifyCheckoutSparkInvoiceRecipient,
} from "../packages/core/src/protocol/checkout-spark-invoice-recipient"
import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import type { CheckoutSparkSettledOutgoingTarget } from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const MERCHANT = "a".repeat(64)

function invoice(amount: number, byte: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amount * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(byte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function fixture(address = "merchant@coinos.io", checkoutId = "checkout-1") {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId,
    orderId: "order-1",
    merchantPubkey: MERCHANT,
    walletId: "wallet-1",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 60_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:item`,
          productEventId: "b".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-1",
      paymentRequest: invoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: address,
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
        destination: {
          type: "lightning_address",
          value: CONDUIT_CHECKOUT_FEE_RECIPIENT,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  const credited = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer-1",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: NOW + 1,
    }
  )
  const recipient = plan.recipients[0]!
  const state = prepareCheckoutSparkSettledLeg(credited, {
    legId: recipient.legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, recipient.legId),
    paymentRequest: invoice(995, 4),
    paymentHash: "04".repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: NOW + 2,
  })
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: plan.walletId,
    network: plan.network,
    legId: recipient.legId,
    recipientId: recipient.recipientId,
    allocationSats: 1_000,
    unpaidAllocationSats: 1_111,
    intent: state.legs[0]!.intent!,
  }
  return {
    plan,
    target,
    now: NOW + 3,
    assertCurrent: () => undefined,
    canonical: {
      id: "provider-invoice-1",
      type: "lightning",
      text: target.intent.paymentRequest,
      hash: target.intent.paymentRequest,
      paymentHash: target.intent.paymentHash,
      amount: target.intent.invoiceAmountSats,
      uid: "provider-user-1",
      user: { id: "provider-user-1", username: "merchant" },
    },
  }
}

describe("Coinos invoice recipient attribution", () => {
  it("looks up the exact invoice and persists only the bound verification record", async () => {
    const input = fixture()
    let requested = ""
    const result = await verifyCheckoutSparkInvoiceRecipient(input, {
      fetchInvoiceRecord: async (url, options) => {
        requested = url
        expect(options.signal.aborted).toBe(false)
        return input.canonical
      },
    })
    expect(requested).toBe(
      `https://coinos.io/api/invoice/${encodeURIComponent(input.target.intent.paymentRequest)}`
    )
    expect(result.status).toBe("verified")
    if (result.status !== "verified") throw new Error("Expected verification")
    expect(Object.keys(result.proof)).toEqual([])
    const record = createCheckoutSparkInvoiceRecipientRecord(
      input.plan,
      input.target,
      result.proof
    )
    expect(Object.keys(record).sort()).toEqual([
      "intentDigest",
      "legId",
      "schemaVersion",
      "source",
      "verifiedAt",
    ])
    expect(record.source).toBe("coinos_account_lookup_v1")
    expect(record.verifiedAt).toBe(input.now)
    expect(
      hasCheckoutSparkInvoiceRecipient(
        structuredClone(record),
        input.plan,
        input.target
      )
    ).toBe(true)
    // Completing a different leg does not invalidate this exact intent's proof.
    expect(
      hasCheckoutSparkInvoiceRecipient(record, input.plan, {
        ...input.target,
        unpaidAllocationSats: 1_000,
      })
    ).toBe(true)
    const another = fixture("merchant@coinos.io", "checkout-2")
    expect(
      hasCheckoutSparkInvoiceRecipient(record, another.plan, another.target)
    ).toBe(false)
  })

  it("can verify an expired, previously issued invoice without creating another", async () => {
    const input = fixture()
    const result = await verifyCheckoutSparkInvoiceRecipient(
      { ...input, now: NOW + 7_200_000 },
      {
        fetchInvoiceRecord: async () => input.canonical,
      }
    )
    expect(result.status).toBe("verified")
  })

  it("keeps invoice attribution distinct from settlement", async () => {
    const input = fixture()
    // This helper does not turn a provider invoice record into paid-leg evidence.
    const result = await verifyCheckoutSparkInvoiceRecipient(input, {
      fetchInvoiceRecord: async () => ({
        ...input.canonical,
        received: 0,
        settled: null,
      }),
    })
    expect(result.status).toBe("verified")
    expect("paid" in result).toBe(false)
  })

  it("does not query providers outside the explicit compatibility adapter", async () => {
    let calls = 0
    const result = await verifyCheckoutSparkInvoiceRecipient(
      fixture("merchant@example.test"),
      {
        fetchInvoiceRecord: async () => {
          calls += 1
          return {}
        },
      }
    )
    expect(result).toEqual({ status: "unsupported" })
    expect(calls).toBe(0)
  })

  it("returns conflicting for a provider's different canonical account", async () => {
    const input = fixture()
    expect(
      await verifyCheckoutSparkInvoiceRecipient(input, {
        fetchInvoiceRecord: async () => ({
          ...input.canonical,
          user: { id: "provider-user-2", username: "another" },
        }),
      })
    ).toEqual({ status: "conflicting" })
  })

  it("returns conflicting if a regenerated provider record no longer matches", async () => {
    const input = fixture()
    expect(
      await verifyCheckoutSparkInvoiceRecipient(input, {
        fetchInvoiceRecord: async () => ({
          ...input.canonical,
          text: invoice(996, 5),
          hash: invoice(996, 5),
          paymentHash: "05".repeat(32),
          amount: 996,
        }),
      })
    ).toEqual({ status: "conflicting" })
  })

  it("treats a transport timeout as unavailable without retaining error contents", async () => {
    const input = fixture()
    expect(
      await verifyCheckoutSparkInvoiceRecipient(input, {
        fetchInvoiceRecord: async () => {
          throw new DOMException("request timeout", "TimeoutError")
        },
      })
    ).toEqual({ status: "unavailable" })
  })

  it("bounds an unresponsive transport and aborts its request", async () => {
    let signal: AbortSignal | undefined
    const result = await verifyCheckoutSparkInvoiceRecipient(fixture(), {
      fetchInvoiceRecord: async (_, options) => {
        signal = options.signal
        return new Promise(() => undefined)
      },
    })
    expect(result).toEqual({ status: "unavailable" })
    expect(signal?.aborted).toBe(true)
  }, 10_000)

  it("uses credentialless non-redirecting GET for the default transport", async () => {
    const input = fixture()
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(input.canonical)
    )
    try {
      expect((await verifyCheckoutSparkInvoiceRecipient(input)).status).toBe(
        "verified"
      )
      const [url, options] = fetchMock.mock.calls[0]!
      expect(url).toBe(
        `https://coinos.io/api/invoice/${encodeURIComponent(input.target.intent.paymentRequest)}`
      )
      expect(options).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      })
      expect(options?.headers).toEqual({ Accept: "application/json" })
    } finally {
      fetchMock.mockRestore()
    }
  })

  it("treats ordinary non-JSON provider outages as unavailable", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Service unavailable", { status: 503 })
    )
    try {
      expect(await verifyCheckoutSparkInvoiceRecipient(fixture())).toEqual({
        status: "unavailable",
      })
    } finally {
      fetchMock.mockRestore()
    }
  })

  it("does not release a proof after the current account changes", async () => {
    const input = fixture()
    let current = true
    let complete: (record: unknown) => void = () => undefined
    const pending = verifyCheckoutSparkInvoiceRecipient(
      {
        ...input,
        assertCurrent: () => {
          if (!current) throw new Error("Account changed")
        },
      },
      {
        fetchInvoiceRecord: () =>
          new Promise((resolve) => {
            complete = resolve
          }),
      }
    )
    current = false
    complete(input.canonical)
    await expect(pending).rejects.toThrow("Account changed")
  })
})

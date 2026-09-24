import { describe, expect, it, mock } from "bun:test"
import {
  buildCheckoutSparkRouterObligations,
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
} from "@conduit/core"
import {
  assertCheckoutSparkRouterInvoiceWitnesses,
  resolveCheckoutSparkConduitInvoiceWitness,
} from "../apps/market/src/lib/checkout-spark-recipient-invoice-witness"
import { mockRouterInvoiceWitnesses } from "./support/checkout-spark-invoice-witness-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW_SECONDS = 1_800_000_000
const CHECKOUT_ID = "checkout-invoice-witness-1"
const MERCHANT = "a".repeat(64)
const SUPPLIER = "b".repeat(64)
const ORGANIZER = "c".repeat(64)

function invoice(amountSats: number, hashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: NOW_SECONDS,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function routerInput() {
  return {
    checkoutId: CHECKOUT_ID,
    network: "mainnet" as const,
    routerObligationInputs: {
      commerceTotalSats: 1_000,
      commerce: [
        {
          kind: "merchant" as const,
          recipientId: MERCHANT,
          paymentRequest: invoice(500, 1),
          amountSats: 500,
          maxFeeSats: 20,
        },
        {
          kind: "supplier" as const,
          recipientId: SUPPLIER,
          paymentRequest: invoice(500, 2),
          amountSats: 500,
          maxFeeSats: 20,
        },
      ],
      organizer: {
        recipientId: ORGANIZER,
        paymentRequest: invoice(50, 3),
        amountSats: 50,
        maxFeeSats: 10,
      },
      conduit: {
        paymentRequest: invoice(111, 4),
        maxFeeSats: 10,
      },
    },
  }
}

function obligations(input: ReturnType<typeof routerInput>) {
  return buildCheckoutSparkRouterObligations({
    ...input.routerObligationInputs,
    network: input.network,
    nowSeconds: NOW_SECONDS,
  }).obligations
}

describe("checkout Spark router payout invoice authority", () => {
  it("matches one fresh resolver witness to every merchant, supplier, organizer, and Conduit leg", async () => {
    const input = routerInput()
    const witnesses = await mockRouterInvoiceWitnesses(input, NOW_SECONDS)
    expect(witnesses).toHaveLength(4)
    expect(() =>
      assertCheckoutSparkRouterInvoiceWitnesses({
        checkoutId: CHECKOUT_ID,
        network: "mainnet",
        nowSeconds: NOW_SECONDS,
        obligations: obligations(input),
        witnesses,
      })
    ).not.toThrow()
  })

  it("rejects a different, valid invoice for the same recipient and amount", async () => {
    const input = routerInput()
    const witnesses = await mockRouterInvoiceWitnesses(input, NOW_SECONDS)
    const swapped = {
      ...input,
      routerObligationInputs: {
        ...input.routerObligationInputs,
        commerce: [
          {
            ...input.routerObligationInputs.commerce[0]!,
            paymentRequest:
              input.routerObligationInputs.commerce[1]!.paymentRequest,
          },
          {
            ...input.routerObligationInputs.commerce[1]!,
            paymentRequest:
              input.routerObligationInputs.commerce[0]!.paymentRequest,
          },
        ],
      },
    }
    expect(() =>
      assertCheckoutSparkRouterInvoiceWitnesses({
        checkoutId: CHECKOUT_ID,
        network: "mainnet",
        nowSeconds: NOW_SECONDS,
        obligations: obligations(swapped),
        witnesses,
      })
    ).toThrow("witnesses do not match")
  })

  it("rejects copied, missing, duplicated, cross-checkout, or ended-session witnesses", async () => {
    const input = routerInput()
    let current = true
    const witnesses = await mockRouterInvoiceWitnesses(
      input,
      NOW_SECONDS,
      () => current
    )
    const base = {
      checkoutId: CHECKOUT_ID,
      network: "mainnet" as const,
      nowSeconds: NOW_SECONDS,
      obligations: obligations(input),
    }
    expect(() =>
      assertCheckoutSparkRouterInvoiceWitnesses({
        ...base,
        witnesses: undefined as never,
      })
    ).toThrow("witnesses do not match")
    for (const altered of [
      [],
      [witnesses[0]!, witnesses[1]!, witnesses[2]!, { ...witnesses[3]! }],
      [witnesses[0]!, witnesses[0]!, witnesses[2]!, witnesses[3]!],
    ]) {
      expect(() =>
        assertCheckoutSparkRouterInvoiceWitnesses({
          ...base,
          witnesses: altered,
        })
      ).toThrow()
    }
    expect(() =>
      assertCheckoutSparkRouterInvoiceWitnesses({
        ...base,
        checkoutId: "different-checkout",
        witnesses,
      })
    ).toThrow("witness is not current")

    current = false
    expect(() =>
      assertCheckoutSparkRouterInvoiceWitnesses({ ...base, witnesses })
    ).toThrow("witness is not current")
  })

  it("resolves the Conduit leg from only the fixed plain LNURL address", async () => {
    const paymentRequest = invoice(111, 5)
    const fetchMetadata = mock(async () => ({
      payRequestUrl: "https://strike.me/.well-known/lnurlp/conduithodlings",
      lnurl: "lnurl1test",
      callback: "https://strike.me/lnurlp/callback",
      minSendable: 1_000,
      maxSendable: 1_000_000,
      tag: "payRequest" as const,
      allowsNostr: false,
      metadata: "[]",
    }))
    const fetchInvoice = mock(async () => ({ invoice: paymentRequest }))

    const witness = await resolveCheckoutSparkConduitInvoiceWitness(
      {
        checkoutId: CHECKOUT_ID,
        amountSats: 111,
        network: "mainnet",
        nowSeconds: NOW_SECONDS,
        shouldContinue: () => true,
      },
      { fetchMetadata, fetchInvoice }
    )

    expect(fetchMetadata).toHaveBeenCalledWith(CONDUIT_CHECKOUT_FEE_RECIPIENT)
    expect(fetchInvoice).toHaveBeenCalledWith(
      "https://strike.me/lnurlp/callback",
      111_000
    )
    expect(fetchInvoice.mock.calls[0]).toHaveLength(2)
    expect(witness).toMatchObject({
      recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
      lud16: CONDUIT_CHECKOUT_FEE_RECIPIENT,
      paymentRequest,
      amountSats: 111,
    })
    expect(Object.isFrozen(witness)).toBe(true)
  })
})

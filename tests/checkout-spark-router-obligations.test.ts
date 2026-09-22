import { describe, expect, it } from "bun:test"
import {
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  buildCheckoutSparkRouterObligations,
  calculateConduitCheckoutFeeSats,
} from "@conduit/core"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW_SECONDS = 1_800_000_000

function invoice(
  amountSats: number,
  paymentHashByte: number,
  options: { network?: "mainnet" | "regtest"; createdAt?: number } = {}
): string {
  const prefix = options.network === "regtest" ? "lnbcrt" : "lnbc"
  return makeSignedBolt11Fixture({
    hrp: `${prefix}${amountSats * 10}n`,
    createdAt: options.createdAt ?? NOW_SECONDS,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(paymentHashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

describe("checkout Spark router obligations", () => {
  it("calculates the exact Conduit fee with its 111-sat floor", () => {
    expect(calculateConduitCheckoutFeeSats(1)).toBe(111)
    expect(calculateConduitCheckoutFeeSats(52_857)).toBe(1_110)
    expect(calculateConduitCheckoutFeeSats(100_000)).toBe(2_100)
  })

  it("orders exact commerce, organizer, and Conduit obligations", () => {
    const merchantInvoice = invoice(800, 1)
    const supplierInvoice = invoice(200, 2)
    const organizerInvoice = invoice(50, 3)
    const conduitInvoice = invoice(111, 4)
    const result = buildCheckoutSparkRouterObligations({
      network: "mainnet",
      nowSeconds: NOW_SECONDS,
      commerceTotalSats: 1_000,
      commerce: [
        {
          kind: "supplier",
          recipientId: "supplier@example.com",
          paymentRequest: supplierInvoice,
          amountSats: 200,
          maxFeeSats: 6,
        },
        {
          kind: "merchant",
          recipientId: "merchant@example.com",
          paymentRequest: merchantInvoice,
          amountSats: 800,
          maxFeeSats: 5,
        },
      ],
      organizer: {
        recipientId: "organizer@example.com",
        paymentRequest: organizerInvoice,
        amountSats: 50,
        maxFeeSats: 7,
      },
      conduit: {
        paymentRequest: conduitInvoice,
        maxFeeSats: 8,
      },
    })

    expect(result).toEqual({
      commerceTotalSats: 1_000,
      conduitFeeSats: 111,
      requiredNetSats: 1_187,
      obligations: [
        {
          kind: "merchant",
          recipientId: "merchant@example.com",
          paymentRequest: merchantInvoice,
          amountSats: 800,
          maxFeeSats: 5,
        },
        {
          kind: "supplier",
          recipientId: "supplier@example.com",
          paymentRequest: supplierInvoice,
          amountSats: 200,
          maxFeeSats: 6,
        },
        {
          kind: "organizer",
          recipientId: "organizer@example.com",
          paymentRequest: organizerInvoice,
          amountSats: 50,
          maxFeeSats: 7,
        },
        {
          kind: "conduit",
          recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
          paymentRequest: conduitInvoice,
          amountSats: 111,
          maxFeeSats: 8,
        },
      ],
    })
  })

  it("rejects commerce drift before a plan or wallet can be created", () => {
    expect(() =>
      buildCheckoutSparkRouterObligations({
        network: "mainnet",
        nowSeconds: NOW_SECONDS,
        commerceTotalSats: 1_000,
        commerce: [
          {
            kind: "merchant",
            recipientId: "merchant@example.com",
            paymentRequest: invoice(999, 1),
            amountSats: 999,
            maxFeeSats: 5,
          },
        ],
        conduit: {
          paymentRequest: invoice(111, 4),
          maxFeeSats: 8,
        },
      })
    ).toThrow("commerce obligations do not match")
  })

  it("rejects missing or duplicate merchant authority", () => {
    const conduit = {
      paymentRequest: invoice(111, 4),
      maxFeeSats: 8,
    }
    expect(() =>
      buildCheckoutSparkRouterObligations({
        network: "mainnet",
        nowSeconds: NOW_SECONDS,
        commerceTotalSats: 100,
        commerce: [
          {
            kind: "supplier",
            recipientId: "supplier@example.com",
            paymentRequest: invoice(100, 2),
            amountSats: 100,
            maxFeeSats: 1,
          },
        ],
        conduit,
      })
    ).toThrow("exactly one merchant")

    expect(() =>
      buildCheckoutSparkRouterObligations({
        network: "mainnet",
        nowSeconds: NOW_SECONDS,
        commerceTotalSats: 100,
        commerce: [
          {
            kind: "merchant",
            recipientId: "merchant-a@example.com",
            paymentRequest: invoice(50, 1),
            amountSats: 50,
            maxFeeSats: 1,
          },
          {
            kind: "merchant",
            recipientId: "merchant-b@example.com",
            paymentRequest: invoice(50, 2),
            amountSats: 50,
            maxFeeSats: 1,
          },
        ],
        conduit,
      })
    ).toThrow("exactly one merchant")
  })

  it("rejects duplicate economic destinations and invoices", () => {
    const base = {
      network: "mainnet" as const,
      nowSeconds: NOW_SECONDS,
      commerceTotalSats: 1_000,
      conduit: {
        paymentRequest: invoice(111, 4),
        maxFeeSats: 8,
      },
    }
    expect(() =>
      buildCheckoutSparkRouterObligations({
        ...base,
        commerce: [
          {
            kind: "merchant",
            recipientId: "merchant@example.com",
            paymentRequest: invoice(800, 9),
            amountSats: 800,
            maxFeeSats: 5,
          },
          {
            kind: "supplier",
            recipientId: "supplier@example.com",
            paymentRequest: invoice(200, 9),
            amountSats: 200,
            maxFeeSats: 6,
          },
        ],
      })
    ).toThrow("payment hash is duplicated")

    expect(() =>
      buildCheckoutSparkRouterObligations({
        ...base,
        commerce: [
          {
            kind: "merchant",
            recipientId: "merchant@example.com",
            paymentRequest: invoice(800, 1),
            amountSats: 800,
            maxFeeSats: 5,
          },
          {
            kind: "supplier",
            recipientId: "supplier@example.com",
            paymentRequest: invoice(100, 2),
            amountSats: 100,
            maxFeeSats: 6,
          },
          {
            kind: "supplier",
            recipientId: "supplier@example.com",
            paymentRequest: invoice(100, 3),
            amountSats: 100,
            maxFeeSats: 6,
          },
        ],
      })
    ).toThrow("recipient is duplicated")
  })

  it("rejects unsafe amounts and fee arithmetic", () => {
    expect(() => calculateConduitCheckoutFeeSats(0)).toThrow(
      "commerce total is invalid"
    )
    expect(() =>
      buildCheckoutSparkRouterObligations({
        network: "mainnet",
        nowSeconds: NOW_SECONDS,
        commerceTotalSats: 1,
        commerce: [
          {
            kind: "merchant",
            recipientId: "merchant@example.com",
            paymentRequest: invoice(1, 1),
            amountSats: 1,
            maxFeeSats: Number.MAX_SAFE_INTEGER,
          },
        ],
        conduit: {
          paymentRequest: invoice(111, 4),
          maxFeeSats: 0,
        },
      })
    ).toThrow("required funding is unsafe")

    expect(() =>
      buildCheckoutSparkRouterObligations({
        network: "mainnet",
        nowSeconds: NOW_SECONDS,
        commerceTotalSats: 100,
        commerce: [
          {
            kind: "merchant",
            recipientId: "merchant@example.com",
            paymentRequest: invoice(100, 1),
            amountSats: 100,
            maxFeeSats: -1,
          },
        ],
        conduit: {
          paymentRequest: invoice(111, 4),
          maxFeeSats: 1,
        },
      })
    ).toThrow("maximum fee is invalid")
  })

  it("rejects malformed, mismatched, and expired outgoing invoices", () => {
    const build = (paymentRequest: string) =>
      buildCheckoutSparkRouterObligations({
        network: "mainnet",
        nowSeconds: NOW_SECONDS,
        commerceTotalSats: 100,
        commerce: [
          {
            kind: "merchant",
            recipientId: "merchant@example.com",
            paymentRequest,
            amountSats: 100,
            maxFeeSats: 1,
          },
        ],
        conduit: {
          paymentRequest: invoice(111, 4),
          maxFeeSats: 1,
        },
      })

    expect(() => build("not-an-invoice")).toThrow("payment request is invalid")
    expect(() => build(invoice(99, 1))).toThrow(
      "payment request amount is invalid"
    )
    expect(() => build(invoice(100, 1, { network: "regtest" }))).toThrow(
      "payment request network is invalid"
    )
    expect(() =>
      build(invoice(100, 1, { createdAt: NOW_SECONDS - 3_600 }))
    ).toThrow("payment request is expired")
  })
})

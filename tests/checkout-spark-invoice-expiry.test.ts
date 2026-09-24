import { describe, expect, it } from "bun:test"
import {
  assertCheckoutSparkOutgoingInvoiceLifetime,
  CHECKOUT_SPARK_PROVIDER_SEND_WINDOW_MS,
  hasCheckoutSparkProviderSendWindow,
} from "@conduit/core"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000

function invoiceExpiringAt(expiresAtMs: number): string {
  return makeSignedBolt11Fixture({
    hrp: "lnbc10000n",
    createdAt: expiresAtMs / 1_000 - 3_600,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(3)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

describe("checkout Spark outgoing invoice windows", () => {
  it("requires each signed obligation to outlive funding plus the execution allowance", () => {
    const deadline = NOW + 600_000 + 300_000
    expect(() =>
      assertCheckoutSparkOutgoingInvoiceLifetime({
        obligations: [{ paymentRequest: invoiceExpiringAt(deadline) }],
        fundingExpiresAt: NOW + 600_000,
        takeoverAt: NOW + 120_000,
      })
    ).toThrow("lifetime is insufficient")
    expect(() =>
      assertCheckoutSparkOutgoingInvoiceLifetime({
        obligations: [{ paymentRequest: invoiceExpiringAt(deadline + 1_000) }],
        fundingExpiresAt: NOW + 600_000,
        takeoverAt: NOW + 120_000,
      })
    ).not.toThrow()
  })

  it("uses the later takeover deadline and at least one minute per leg", () => {
    const deadline = NOW + 900_000 + 360_000
    expect(() =>
      assertCheckoutSparkOutgoingInvoiceLifetime({
        obligations: Array.from({ length: 6 }, () => ({
          paymentRequest: invoiceExpiringAt(deadline),
        })),
        fundingExpiresAt: NOW + 600_000,
        takeoverAt: NOW + 900_000,
      })
    ).toThrow("lifetime is insufficient")
  })

  it("fails closed on invalid invoices and unsafe deadlines", () => {
    expect(() =>
      assertCheckoutSparkOutgoingInvoiceLifetime({
        obligations: [{ paymentRequest: "lnbc-unsigned" }],
        fundingExpiresAt: NOW + 600_000,
        takeoverAt: NOW + 120_000,
      })
    ).toThrow("lifetime is insufficient")
    expect(() =>
      assertCheckoutSparkOutgoingInvoiceLifetime({
        obligations: [{ paymentRequest: invoiceExpiringAt(NOW + 900_000) }],
        fundingExpiresAt: Number.MAX_SAFE_INTEGER,
        takeoverAt: NOW,
      })
    ).toThrow("window is unsafe")
  })

  it("requires strictly more than a provider-send window at the moment of send", () => {
    const deadline = NOW + CHECKOUT_SPARK_PROVIDER_SEND_WINDOW_MS
    expect(
      hasCheckoutSparkProviderSendWindow({
        paymentRequest: invoiceExpiringAt(deadline),
        nowMs: NOW,
      })
    ).toBe(false)
    expect(
      hasCheckoutSparkProviderSendWindow({
        paymentRequest: invoiceExpiringAt(deadline + 1_000),
        nowMs: NOW,
      })
    ).toBe(true)
    expect(
      hasCheckoutSparkProviderSendWindow({
        paymentRequest: "lnbc-unsigned",
        nowMs: NOW,
      })
    ).toBe(false)
  })
})

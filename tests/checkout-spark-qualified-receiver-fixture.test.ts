import { describe, expect, it } from "bun:test"
import { decodeLightningInvoiceMetadata } from "../packages/core/src/protocol/lightning"
import {
  qualifiedReceiverInvoiceFixture,
  qualifiedReceiverMetadataFixture,
} from "./support/checkout-spark-qualified-receiver-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"

const NOW = 1_800_000_000

describe("ordinary qualified receiver fixture scaffolding", () => {
  it.each(["mainnet", "regtest"] as const)(
    "resolves the same exact metadata-bound invoice on %s",
    async (network) => {
      const lud16 = "merchant@receiver.conduit.cash"
      const paymentRequest = qualifiedReceiverInvoiceFixture({
        lud16,
        amountSats: 995,
        paymentHash: "04".repeat(32),
        network,
        createdAt: NOW,
        expiresSeconds: 59,
      })
      let callbacks = 0
      const resolved = await resolveCheckoutSparkFixtureInvoice(
        {
          lud16,
          amountSats: 995,
          network,
          nowSeconds: NOW + 1,
          receiverMode: "private",
          shouldContinue: () => true,
        },
        paymentRequest,
        { onInvoice: () => callbacks++ }
      )
      expect(resolved.paymentRequest === paymentRequest).toBe(true)
      expect(resolved.origin !== undefined).toBe(true)
      expect(resolved.receiverBinding?.mode).toBe("private")
      expect(resolved.expiresAt).toBe(NOW + 59)
      expect(decodeLightningInvoiceMetadata(paymentRequest).msats).toBe(995_000)
      expect(callbacks).toBe(1)
    }
  )

  it("binds supplier metadata and an exact verifier to the requested ordinary endpoint", async () => {
    const lud16 = "supplier@receiver.conduit.cash"
    const provider = qualifiedReceiverMetadataFixture(lud16)
    const paymentRequest = qualifiedReceiverInvoiceFixture({
      lud16,
      amountSats: 79_999,
      paymentHash: "05".repeat(32),
      createdAt: NOW,
    })
    const resolved = await resolveCheckoutSparkFixtureInvoice(
      {
        lud16,
        amountSats: 79_999,
        network: "mainnet",
        nowSeconds: NOW + 1,
        receiverMode: "private",
        shouldContinue: () => true,
      },
      paymentRequest
    )
    expect(
      resolved.receiverBinding?.metadata === provider.metadata.metadata
    ).toBe(true)
    expect(
      resolved.receiverBinding?.verifyUrl ===
        provider.verifyUrl(resolved.paymentHash)
    ).toBe(true)
    expect(resolved.paymentRequest === paymentRequest).toBe(true)
  })
})

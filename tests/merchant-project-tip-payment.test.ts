import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { classifyMerchantTipPaymentError } from "../apps/merchant/src/lib/project-tip-payment"

const connection = {
  walletPubkey: "a".repeat(64),
  secret: randomBytes(32).toString("hex"),
  relays: ["wss://relay.example"],
}

describe("Merchant project tip NWC fallback", () => {
  it("offers manual payment for a documented wallet refusal", () => {
    const error = Object.assign(new Error("Insufficient balance"), {
      code: "INSUFFICIENT_BALANCE",
    })
    expect(classifyMerchantTipPaymentError(error, connection).status).toBe(
      "manual"
    )
  })

  it("offers manual payment when relay connection failed before publish", () => {
    expect(
      classifyMerchantTipPaymentError(
        new Error("Failed to connect to NWC relay(s)"),
        connection
      ).status
    ).toBe("manual")
  })

  it("keeps timeout and unknown outcomes ambiguous", () => {
    for (const error of [
      new Error("NWC request timed out"),
      new Error("Wallet payment result unavailable"),
      new Error("Insufficient balance"),
    ]) {
      expect(classifyMerchantTipPaymentError(error, connection).status).toBe(
        "ambiguous"
      )
    }
  })
})

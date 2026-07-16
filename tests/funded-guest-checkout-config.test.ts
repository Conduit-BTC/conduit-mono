import { describe, expect, it } from "bun:test"
import { nip19 } from "@nostr-dev-kit/ndk"
import { getPublicKey } from "nostr-tools"

import {
  formatFundedGuestSmokeConfigFailure,
  parseFundedGuestSmokeConfig,
} from "../scripts/smoke/funded_guest_checkout_config"

const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 7])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const WALLET_PUBKEY = getPublicKey(Uint8Array.from([...new Uint8Array(31), 8]))
const WALLET_SECRET = "9".repeat(64)
const NWC_URI = `nostr+walletconnect://${WALLET_PUBKEY}?relay=wss%3A%2F%2Frelay.example&secret=${WALLET_SECRET}`

function environment(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    FUNDED_GUEST_SMOKE_BASE_URL: "https://shop.example",
    FUNDED_GUEST_SMOKE_MERCHANT_NSEC: nip19.nsecEncode(MERCHANT_SECRET),
    FUNDED_GUEST_SMOKE_MERCHANT_PUBKEY: MERCHANT_PUBKEY,
    FUNDED_GUEST_SMOKE_MERCHANT_LUD16: "fixture@rizful.example",
    FUNDED_GUEST_SMOKE_PRODUCT_ADDRESS: `30402:${MERCHANT_PUBKEY}:fixture`,
    FUNDED_GUEST_SMOKE_PROVIDER_HOST: "rizful.example",
    FUNDED_GUEST_SMOKE_RECEIPT_RELAYS:
      "wss://relay.example,wss://relay2.example",
    FUNDED_GUEST_SMOKE_ANON_SHOPPER_PUBKEY: "a".repeat(64),
    FUNDED_GUEST_SMOKE_MAX_PAYMENT_SATS: "10",
    FUNDED_GUEST_SMOKE_PAYER_NWC_URI: NWC_URI,
    ...overrides,
  }
}

describe("funded guest checkout fixture configuration", () => {
  it("validates the protected signer, payer wallet, and public fixture", () => {
    const config = parseFundedGuestSmokeConfig(environment())

    expect(config.merchantPubkey).toBe(MERCHANT_PUBKEY)
    expect(config.productAddress).toBe(`30402:${MERCHANT_PUBKEY}:fixture`)
    expect(config.providerHost).toBe("rizful.example")
    expect(config.maxPaymentSats).toBe(10)
    expect(config.receiptRelayUrls).toHaveLength(2)
    expect(config.payerWallet.walletPubkey).toBe(WALLET_PUBKEY)
  })

  it("rejects a signer that does not own the configured merchant fixture", () => {
    const error = (() => {
      try {
        parseFundedGuestSmokeConfig(
          environment({ FUNDED_GUEST_SMOKE_MERCHANT_PUBKEY: "b".repeat(64) })
        )
      } catch (caught) {
        return caught
      }
    })()

    expect(formatFundedGuestSmokeConfigFailure(error)).toBe(
      "Funded guest smoke fixture failed at configuration."
    )
  })

  it("rejects products owned by another merchant and mismatched providers", () => {
    for (const overrides of [
      {
        FUNDED_GUEST_SMOKE_PRODUCT_ADDRESS: `30402:${"c".repeat(64)}:fixture`,
      },
      { FUNDED_GUEST_SMOKE_PROVIDER_HOST: "other.example" },
    ]) {
      expect(() =>
        parseFundedGuestSmokeConfig(environment(overrides))
      ).toThrow()
    }
  })

  it("enforces a bounded payment cap and safe relay set", () => {
    for (const overrides of [
      { FUNDED_GUEST_SMOKE_MAX_PAYMENT_SATS: "0" },
      { FUNDED_GUEST_SMOKE_MAX_PAYMENT_SATS: "1001" },
      { FUNDED_GUEST_SMOKE_RECEIPT_RELAYS: "ws://relay.example" },
    ]) {
      expect(() =>
        parseFundedGuestSmokeConfig(environment(overrides))
      ).toThrow()
    }
  })

  it("never formats credential or provider error details", () => {
    const merchantSecret = environment().FUNDED_GUEST_SMOKE_MERCHANT_NSEC!
    const payerSecret = environment().FUNDED_GUEST_SMOKE_PAYER_NWC_URI!
    let error: unknown
    try {
      parseFundedGuestSmokeConfig(
        environment({ FUNDED_GUEST_SMOKE_PAYER_NWC_URI: "private-invalid" })
      )
    } catch (caught) {
      error = caught
    }
    const formatted = formatFundedGuestSmokeConfigFailure(error)

    expect(formatted).toBe(
      "Funded guest smoke fixture failed at configuration."
    )
    expect(formatted).not.toContain(merchantSecret)
    expect(formatted).not.toContain(payerSecret)
    expect(formatted).not.toContain("private-invalid")
  })
})

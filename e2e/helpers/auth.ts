import type { Page } from "@playwright/test"

export const TEST_BUYER_PUBKEY = "b".repeat(64)
export const TEST_MERCHANT_PUBKEY = "a".repeat(64)

export async function installTestSigner(
  page: Page,
  pubkey: string
): Promise<void> {
  await page.addInitScript((signerPubkey) => {
    localStorage.setItem("conduit:auth", signerPubkey)

    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        async getPublicKey() {
          return signerPubkey
        },
        async getRelays() {
          return {
            "ws://127.0.0.1:7777": { read: true, write: true },
          }
        },
        async signEvent(event: Record<string, unknown>) {
          return {
            ...event,
            id: "0".repeat(64),
            sig: "1".repeat(128),
          }
        },
        nip04: {
          async encrypt(_pubkey: string, plaintext: string) {
            return plaintext
          },
          async decrypt(_pubkey: string, ciphertext: string) {
            return ciphertext
          },
        },
      },
    })
  }, pubkey)
}

export async function seedMarketCart(page: Page): Promise<void> {
  await page.addInitScript((merchantPubkey) => {
    localStorage.setItem(
      "conduit:cart",
      JSON.stringify({
        items: [
          {
            productId: "e2e-smoke-product",
            merchantPubkey,
            title: "E2E Smoke Product",
            price: 1_000,
            currency: "SATS",
            priceSats: 1_000,
            format: "physical",
            shippingCostSats: 0,
            quantity: 1,
          },
        ],
      })
    )
  }, TEST_MERCHANT_PUBKEY)
}

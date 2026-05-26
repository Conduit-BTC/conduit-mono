import type { Page } from "@playwright/test"

export const TEST_BUYER_PUBKEY = "b".repeat(64)
export const TEST_MERCHANT_PUBKEY = "a".repeat(64)

type TestSignerOptions = {
  rememberAuth?: boolean
  getRelaysThrows?: boolean
  relays?: Record<string, { read: boolean; write: boolean }>
}

export async function installTestSigner(
  page: Page,
  pubkey: string,
  options: TestSignerOptions = {}
): Promise<void> {
  await page.addInitScript(
    ([signerPubkey, signerOptions]) => {
      if (signerOptions.rememberAuth !== false) {
        localStorage.setItem("conduit:auth", signerPubkey)
      }

      Object.defineProperty(window, "nostr", {
        configurable: true,
        value: {
          async getPublicKey() {
            return signerPubkey
          },
          async getRelays() {
            if (signerOptions.getRelaysThrows) {
              throw new Error("getRelays not supported")
            }
            return (
              signerOptions.relays ?? {
                "ws://127.0.0.1:7777": { read: true, write: true },
              }
            )
          },
          async signEvent(event: Record<string, unknown>) {
            return {
              ...event,
              pubkey: signerPubkey,
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
          nip44: {
            async encrypt(_pubkey: string, plaintext: string) {
              return plaintext
            },
            async decrypt(_pubkey: string, ciphertext: string) {
              return ciphertext
            },
          },
        },
      })
    },
    [pubkey, options] as const
  )
}

export async function installRejectingTestSigner(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        async getPublicKey() {
          throw new Error("User rejected the request")
        },
        async getRelays() {
          return {}
        },
        async signEvent(event: Record<string, unknown>) {
          return event
        },
      },
    })
  })
}

export async function installLockedTestSigner(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let resolvePublicKey: ((pubkey: string) => void) | null = null

    window.addEventListener("conduit-test:unlock-signer", (event) => {
      resolvePublicKey?.((event as CustomEvent<string>).detail)
      resolvePublicKey = null
    })

    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        getPublicKey() {
          return new Promise<string>((resolve) => {
            resolvePublicKey = resolve
          })
        },
        async getRelays() {
          return {}
        },
        async signEvent(event: Record<string, unknown>) {
          return event
        },
      },
    })
  })
}

export async function unlockTestSigner(
  page: Page,
  pubkey: string
): Promise<void> {
  await page.evaluate((signerPubkey) => {
    window.dispatchEvent(
      new CustomEvent("conduit-test:unlock-signer", {
        detail: signerPubkey,
      })
    )
  }, pubkey)
}

export async function installLateTestSigner(
  page: Page,
  pubkey: string,
  delayMs = 500
): Promise<void> {
  await page.addInitScript(
    ([signerPubkey, delay]) => {
      setTimeout(() => {
        Object.defineProperty(window, "nostr", {
          configurable: true,
          value: {
            async getPublicKey() {
              return signerPubkey
            },
            async getRelays() {
              return {}
            },
            async signEvent(event: Record<string, unknown>) {
              return {
                ...event,
                pubkey: signerPubkey,
                id: "0".repeat(64),
                sig: "1".repeat(128),
              }
            },
          },
        })
      }, delay)
    },
    [pubkey, delayMs] as const
  )
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

import type { Page } from "@playwright/test"
import { SimplePool, type Filter } from "nostr-tools"
import { finalizeEvent, type Event, type EventTemplate } from "nostr-tools/pure"

export const TEST_BUYER_PUBKEY = "b".repeat(64)
export const TEST_MERCHANT_PUBKEY = "a".repeat(64)
export const TEST_RELAY_URL = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT ?? "7777"}`

export async function publishTestRelayEvents(events: Event[]): Promise<void> {
  const pool = new SimplePool()

  try {
    for (const event of events) {
      await Promise.all(
        pool.publish([TEST_RELAY_URL], event, { maxWait: 2_000 })
      )
    }
  } finally {
    pool.close([TEST_RELAY_URL])
  }
}

type SeedTestRelayIdentityOptions = {
  inboxDeclaration?: "ready" | "empty" | "omit"
}

export async function seedTestRelayIdentity(
  secretKey: Uint8Array,
  options: SeedTestRelayIdentityOptions = {}
): Promise<void> {
  const createdAt = Math.floor(Date.now() / 1_000)
  const events = [
    finalizeEvent(
      { kind: 0, created_at: createdAt, tags: [], content: "{}" },
      secretKey
    ),
    finalizeEvent(
      {
        kind: 10_002,
        created_at: createdAt,
        tags: [["r", TEST_RELAY_URL]],
        content: "",
      },
      secretKey
    ),
  ]
  if (options.inboxDeclaration !== "omit") {
    events.push(
      finalizeEvent(
        {
          kind: 10_050,
          created_at: createdAt,
          tags:
            options.inboxDeclaration === "empty"
              ? []
              : [["relay", TEST_RELAY_URL]],
          content: "",
        },
        secretKey
      )
    )
  }
  await publishTestRelayEvents(events)
}

export async function readTestRelayEvents(filter: Filter): Promise<Event[]> {
  const pool = new SimplePool()

  try {
    return await pool.querySync([TEST_RELAY_URL], filter, {
      maxWait: 2_000,
    })
  } finally {
    pool.close([TEST_RELAY_URL])
  }
}

type TestSignerOptions = {
  rememberAuth?: boolean
  getRelaysThrows?: boolean
  nip44?: boolean
  relays?: Record<string, { read: boolean; write: boolean }>
  secretKey?: Uint8Array
}

export async function installTestSigner(
  page: Page,
  pubkey: string,
  options: TestSignerOptions = {}
): Promise<void> {
  const { secretKey, ...browserOptions } = options
  const signerOptions = {
    ...browserOptions,
    relays: browserOptions.relays ?? {
      [TEST_RELAY_URL]: { read: true, write: true },
    },
  }
  const signEventBinding = `__conduitSignEvent${pubkey.slice(0, 12)}`
  if (secretKey) {
    await page.exposeFunction(signEventBinding, (event: EventTemplate) =>
      finalizeEvent(event, secretKey)
    )
  }
  await page.addInitScript(
    ([signerPubkey, signerOptions, signerBinding]) => {
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
            return signerOptions.relays
          },
          async signEvent(event: Record<string, unknown>) {
            if (signerBinding) {
              return (
                window as unknown as Record<
                  string,
                  (event: Record<string, unknown>) => Promise<unknown>
                >
              )[signerBinding]!(event)
            }
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
          ...(signerOptions.nip44 === false
            ? {}
            : {
                nip44: {
                  async encrypt(_pubkey: string, plaintext: string) {
                    return plaintext
                  },
                  async decrypt(_pubkey: string, ciphertext: string) {
                    return ciphertext
                  },
                },
              }),
        },
      })
    },
    [pubkey, signerOptions, secretKey ? signEventBinding : null] as const
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
    let unlockedPubkey: string | null = null

    window.addEventListener("conduit-test:unlock-signer", (event) => {
      const pubkey = (event as CustomEvent<string>).detail
      unlockedPubkey = pubkey
      resolvePublicKey?.(pubkey)
      resolvePublicKey = null
    })

    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        getPublicKey() {
          if (unlockedPubkey) return Promise.resolve(unlockedPubkey)
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

export async function seedStoredAuth(
  page: Page,
  pubkey: string
): Promise<void> {
  await page.addInitScript((signerPubkey) => {
    localStorage.setItem("conduit:auth", signerPubkey)
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
        version: 2,
        items: [
          {
            productId: `30402:${merchantPubkey}:e2e-smoke-product`,
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

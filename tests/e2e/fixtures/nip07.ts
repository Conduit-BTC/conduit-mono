import type { Page } from "@playwright/test"

/**
 * Deterministic test pubkey (hex, 32 bytes). Generated once and reused so
 * screenshots diff cleanly across runs.
 */
export const TEST_PUBKEY =
  "7459b5c3a4e1d2f0a8b9c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e289"

/**
 * A second test pubkey for signer-switch scenarios.
 */
export const TEST_PUBKEY_2 =
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aa"

/**
 * Inject a minimal NIP-07 `window.nostr` shim before any page script runs.
 *
 * This covers the methods Conduit actually touches during connect + UI
 * rendering:
 *   - getPublicKey: NDKNip07Signer calls it from signer.user()
 *   - signEvent: no-op stub (we don't exercise signing in these tests)
 *   - getRelays: returns a known mix of read/write relays so we can assert
 *     the Settings page reflects the signer relay list
 *   - nip04/nip44 encrypt/decrypt stubs: present to avoid feature-detection
 *     failures in code paths that probe for capabilities
 *
 * The shim is intentionally incapable of signing real events. If a test
 * ever needs to publish, swap this for a proper key-based signer.
 */
export async function installNip07Shim(
  page: Page,
  opts: {
    pubkey?: string
    relays?: Record<string, { read: boolean; write: boolean }>
  } = {}
): Promise<void> {
  const pubkey = opts.pubkey ?? TEST_PUBKEY
  const relays = opts.relays ?? {
    "wss://relay.damus.io": { read: true, write: true },
    "wss://nos.lol": { read: true, write: false },
    "wss://relay.nostr.band": { read: false, write: true },
  }

  await page.addInitScript(
    ([injectedPubkey, injectedRelays]) => {
      // Stable stub event id/sig so nothing downstream crashes on empty
      // fields if signEvent is ever called incidentally.
      const stubSig =
        "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      const stubId =
        "0000000000000000000000000000000000000000000000000000000000000000"

      ;(window as unknown as { nostr: unknown }).nostr = {
        getPublicKey: async () => injectedPubkey,
        signEvent: async (event: Record<string, unknown>) => ({
          ...event,
          id: stubId,
          pubkey: injectedPubkey,
          sig: stubSig,
        }),
        getRelays: async () => injectedRelays,
        nip04: {
          encrypt: async (_pk: string, plaintext: string) => plaintext,
          decrypt: async (_pk: string, ciphertext: string) => ciphertext,
        },
        nip44: {
          encrypt: async (_pk: string, plaintext: string) => plaintext,
          decrypt: async (_pk: string, ciphertext: string) => ciphertext,
        },
      }
    },
    [pubkey, relays] as const
  )
}

/**
 * Inject a NIP-07 shim that simulates a locked extension: `getPublicKey`
 * hangs indefinitely until the page signals it should resolve.
 *
 * Useful to test:
 *  - "Connecting..." / "Waiting for signer approval..." states
 *  - 30-second timeout producing an actionable error message
 *
 * Call `resolveLockedSigner(page, pubkey)` to unblock getPublicKey.
 */
export async function installLockedNip07Shim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let resolvePublicKey: ((pk: string) => void) | null = null

    // Listen for the test's unblock signal.
    window.addEventListener("conduit-test:unlock-signer", (ev) => {
      const pubkey = (ev as CustomEvent<string>).detail
      resolvePublicKey?.(pubkey)
      resolvePublicKey = null
    })
    ;(window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: () =>
        new Promise<string>((resolve) => {
          resolvePublicKey = resolve
        }),
      signEvent: async (event: Record<string, unknown>) => event,
      getRelays: async () => ({}),
      nip04: {
        encrypt: async (_pk: string, plaintext: string) => plaintext,
        decrypt: async (_pk: string, ciphertext: string) => ciphertext,
      },
      nip44: {
        encrypt: async (_pk: string, plaintext: string) => plaintext,
        decrypt: async (_pk: string, ciphertext: string) => ciphertext,
      },
    }
  })
}

/**
 * Unlock the locked signer shim, resolving `getPublicKey` with the given pubkey.
 */
export async function resolveLockedSigner(
  page: Page,
  pubkey: string = TEST_PUBKEY
): Promise<void> {
  await page.evaluate((pk) => {
    window.dispatchEvent(
      new CustomEvent("conduit-test:unlock-signer", { detail: pk })
    )
  }, pubkey)
}

/**
 * Inject a NIP-07 shim that simulates a signer that rejects the connection
 * (e.g. user denies permission in the extension).
 */
export async function installRejectingNip07Shim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: async () => {
        throw new Error("User rejected the request")
      },
      signEvent: async (event: Record<string, unknown>) => event,
      getRelays: async () => ({}),
      nip04: {
        encrypt: async (_pk: string, plaintext: string) => plaintext,
        decrypt: async (_pk: string, ciphertext: string) => ciphertext,
      },
      nip44: {
        encrypt: async (_pk: string, plaintext: string) => plaintext,
        decrypt: async (_pk: string, ciphertext: string) => ciphertext,
      },
    }
  })
}

/**
 * Simulate a late-injecting extension by NOT installing window.nostr
 * at page load, then injecting it after a delay.
 *
 * Tests the 2-second async injection wait in AuthContext.connect().
 */
export async function installLateNip07Shim(
  page: Page,
  delayMs: number = 500,
  pubkey: string = TEST_PUBKEY
): Promise<void> {
  await page.addInitScript(
    ([delay, pk]) => {
      const stubSig =
        "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
      const stubId =
        "0000000000000000000000000000000000000000000000000000000000000000"

      setTimeout(() => {
        ;(window as unknown as { nostr: unknown }).nostr = {
          getPublicKey: async () => pk,
          signEvent: async (event: Record<string, unknown>) => ({
            ...event,
            id: stubId,
            pubkey: pk,
            sig: stubSig,
          }),
          getRelays: async () => ({}),
          nip04: {
            encrypt: async (_pk2: string, plaintext: string) => plaintext,
            decrypt: async (_pk2: string, ciphertext: string) => ciphertext,
          },
          nip44: {
            encrypt: async (_pk2: string, plaintext: string) => plaintext,
            decrypt: async (_pk2: string, ciphertext: string) => ciphertext,
          },
        }
      }, delay)
    },
    [delayMs, pubkey] as const
  )
}

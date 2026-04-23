import type { Page } from "@playwright/test"

/**
 * Deterministic test pubkey (hex, 32 bytes). Generated once and reused so
 * screenshots diff cleanly across runs.
 */
export const TEST_PUBKEY =
  "7459b5c3a4e1d2f0a8b9c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e289"

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

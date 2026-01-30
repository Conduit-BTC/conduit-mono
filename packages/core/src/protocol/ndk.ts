import NDK, { NDKNip07Signer } from "@nostr-dev-kit/ndk"

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.snort.social",
]

let ndkInstance: NDK | null = null

export interface NdkConfig {
  explicitRelayUrls?: string[]
  enableSigner?: boolean
}

/**
 * Get or create the NDK singleton instance
 */
export function getNdk(config?: NdkConfig): NDK {
  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: config?.explicitRelayUrls ?? DEFAULT_RELAYS,
    })
  }
  return ndkInstance
}

/**
 * Connect NDK to relays
 */
export async function connectNdk(timeoutMs = 5000): Promise<void> {
  const ndk = getNdk()
  await ndk.connect(timeoutMs)
}

/**
 * Enable NIP-07 browser extension signer
 */
export async function enableNip07Signer(): Promise<boolean> {
  const ndk = getNdk()

  try {
    const signer = new NDKNip07Signer()
    ndk.signer = signer

    // Verify signer works by getting pubkey
    await signer.user()
    return true
  } catch {
    console.error("NIP-07 signer not available")
    return false
  }
}

/**
 * Get the current user's pubkey if signed in
 */
export async function getCurrentPubkey(): Promise<string | null> {
  const ndk = getNdk()
  if (!ndk.signer) return null

  try {
    const user = await ndk.signer.user()
    return user.pubkey
  } catch {
    return null
  }
}

/**
 * Disconnect and reset NDK instance
 */
export function disconnectNdk(): void {
  if (ndkInstance) {
    // NDK doesn't have a disconnect method, just reset
    ndkInstance = null
  }
}

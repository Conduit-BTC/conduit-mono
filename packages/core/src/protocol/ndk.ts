// Event construction/publishing compatibility: owned by the publishing and envelope migrations.
import NDK from "@nostr-dev-kit/ndk"
import { setActiveRelaySettingsScope } from "./relay-settings"
import {
  __resetPublicReaderTestState,
  closePublicRelayConnections,
  refreshPublicRelayConnectionsWhenIdle,
} from "./relay-reader"
let ndkInstance: NDK | null = null
/**
 * Return the shared NDK compatibility context used for event construction,
 * and explicitly planned publishes. Account authority lives in SessionSigner.
 *
 * The instance is deliberately offline: Conduit owns relay discovery and read
 * execution, and publish callers must provide an approved relay set. Keeping
 * NDK's outbox and signer-relay auto-connect disabled prevents library defaults
 * or third-party relay hints from creating ambient WebSocket destinations.
 */
export function getNdk(): NDK {
  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: [],
      enableOutboxModel: false,
      autoConnectUserRelays: false,
    })
  }
  return ndkInstance
}

function disconnectNdkPools(ndk: NDK): void {
  const relays = new Set(
    ndk.pools.flatMap((pool) => Array.from(pool.relays.values()))
  )
  for (const relay of relays) relay.disconnect()
}

export function disconnectNdk(): void {
  if (ndkInstance) {
    disconnectNdkPools(ndkInstance)
    ndkInstance = null
  }
  closePublicRelayConnections()
}

export function refreshNdkRelaySettings(scope?: string | null): void {
  if (scope !== undefined) {
    setActiveRelaySettingsScope(scope)
  }

  if (ndkInstance) {
    disconnectNdkPools(ndkInstance)
  }
  closePublicRelayConnections()

  ndkInstance = null
}

/** Apply same-session relay settings without disturbing active NDK work. */
export function refreshNdkRelaySettingsWhenIdle(scope?: string | null): void {
  if (scope !== undefined) {
    setActiveRelaySettingsScope(scope)
  }

  // A same-session settings refresh can arrive while normal app reads are in
  // flight. Each later planned operation rechecks its account exclusions at
  // the final I/O boundary, so rebuilding this compatibility instance is
  // unnecessary and could interrupt active signer or relay work. Identity
  // transitions still revoke it through disconnectNdk().
  refreshPublicRelayConnectionsWhenIdle()
}

export function __resetNdkTestState(): void {
  // Detach test-owned relays first: NDK treats simultaneous disconnects in a
  // populated pool as an outage and can reconnect during fixture teardown.
  if (ndkInstance) {
    const relays = new Set(
      ndkInstance.pools.flatMap((pool) => Array.from(pool.relays.values()))
    )
    for (const pool of ndkInstance.pools) {
      const urls = [...pool.relays.keys()]
      pool.relays.clear()
      // With the relays detached, removeRelay clears their temporary timers.
      for (const url of urls) pool.removeRelay(url)
    }
    for (const relay of relays) relay.disconnect()
  }
  disconnectNdk()
  __resetPublicReaderTestState()
}

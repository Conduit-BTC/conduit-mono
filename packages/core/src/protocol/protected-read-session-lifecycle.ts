import type { NostrEventSigner } from "./nostr-event-signer"
import {
  installProtectedReadSigner,
  removeProtectedReadSigner,
  type ProtectedReadSignerLease,
} from "./protected-read-authorization"

export interface ProtectedReadSessionLifecycle {
  activate(
    signer: NostrEventSigner,
    expectedPubkey: string,
    hasAuthority: () => boolean
  ): ProtectedReadSignerLease
  deactivate(): void
  currentLease(): ProtectedReadSignerLease | null
}

export interface ProtectedReadSessionLifecycleDependencies {
  install: typeof installProtectedReadSigner
  remove: typeof removeProtectedReadSigner
}

/**
 * Own the exact protected-read lease for one AuthProvider instance. Replacing
 * or clearing the session revokes the prior lease synchronously before the new
 * session can expose account-scoped relay state.
 */
export function createProtectedReadSessionLifecycle(
  dependencies: ProtectedReadSessionLifecycleDependencies = {
    install: installProtectedReadSigner,
    remove: removeProtectedReadSigner,
  }
): ProtectedReadSessionLifecycle {
  let activeLease: ProtectedReadSignerLease | null = null

  return {
    activate(signer, expectedPubkey, hasAuthority) {
      if (activeLease) {
        const previous = activeLease
        activeLease = null
        dependencies.remove(previous)
      }
      const installed = dependencies.install(
        signer,
        expectedPubkey,
        hasAuthority
      )
      activeLease = installed
      return installed
    },
    deactivate() {
      if (!activeLease) return
      const previous = activeLease
      activeLease = null
      dependencies.remove(previous)
    },
    currentLease() {
      return activeLease
    },
  }
}

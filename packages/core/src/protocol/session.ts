import type { ConduitAppId } from "./nip89"

export type ConduitSessionMode = "guest" | "signed_in"

export interface ConduitSession {
  appId: ConduitAppId
  mode: ConduitSessionMode
  pubkey: string | null
  relayScope: string | null
}

export interface ResolveConduitSessionInput {
  appId: ConduitAppId
  pubkey?: string | null
  allowGuest?: boolean
}

export interface ConduitRelaySettingsReadinessInput {
  mode: ConduitSessionMode
  identityReady: boolean
  localAuthorityReady: boolean
  relayScope: string | null
  activatedRelayScope: string | null
}

export interface ConduitIdentityReadinessInput {
  mode: ConduitSessionMode
  profileHasName: boolean
  profileInitialLoading: boolean
}

/**
 * Wait for the first signed-in profile lookup without letting later background
 * refreshes revoke an already usable session.
 */
export function isConduitIdentityReady(
  input: ConduitIdentityReadinessInput
): boolean {
  return (
    input.mode === "guest" ||
    input.profileHasName ||
    !input.profileInitialLoading
  )
}

/**
 * Local retained authority must be installed before a signed-in scope becomes
 * ready. Fresh relay reconciliation is then a background refresh rather than
 * an app-readiness gate.
 */
export function isConduitRelaySettingsReady(
  input: ConduitRelaySettingsReadinessInput
): boolean {
  return (
    input.identityReady &&
    (input.mode === "guest" || input.localAuthorityReady) &&
    input.activatedRelayScope === input.relayScope &&
    !!(input.relayScope || input.mode === "guest")
  )
}

export function getAccountRelayScope(pubkey: string): string {
  return `account:${pubkey.trim().toLowerCase()}`
}

export function shouldCloseProtectedConnectionsForScopeTransition(
  activeScope: string | null,
  nextScope: string | null
): boolean {
  return activeScope !== null && activeScope !== nextScope
}

export function getSignedInRelayScope(
  _appId: ConduitAppId,
  pubkey: string
): string {
  return getAccountRelayScope(pubkey)
}

export function getGuestRelayScope(appId: ConduitAppId): string | null {
  return appId === "market" ? "market:guest" : null
}

export function resolveConduitSession(
  input: ResolveConduitSessionInput
): ConduitSession {
  const pubkey = input.pubkey?.trim() || null

  if (pubkey) {
    return {
      appId: input.appId,
      mode: "signed_in",
      pubkey,
      relayScope: getSignedInRelayScope(input.appId, pubkey),
    }
  }

  const relayScope = input.allowGuest ? getGuestRelayScope(input.appId) : null

  return {
    appId: input.appId,
    mode: "guest",
    pubkey: null,
    relayScope,
  }
}

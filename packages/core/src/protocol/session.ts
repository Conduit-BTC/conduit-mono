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

/** App-scoped keys used before signed Network preferences became account-wide. */
export function getLegacySignedInRelayScopes(pubkey: string): string[] {
  const normalized = pubkey.trim().toLowerCase()
  return [`market:${normalized}`, `merchant:${normalized}`]
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

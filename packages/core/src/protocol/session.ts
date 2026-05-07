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

export function getSignedInRelayScope(
  appId: ConduitAppId,
  pubkey: string
): string {
  return `${appId}:${pubkey}`
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

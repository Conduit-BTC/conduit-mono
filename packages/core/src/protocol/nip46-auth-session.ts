import type { AuthSessionMetadata } from "./auth-session"

export interface Nip46AuthSession extends AuthSessionMetadata {
  type: "nip46"
  clientKeyId: string
  remoteSignerPubkey: string
  relayUrls: string[]
  createdAt: number
  updatedAt: number
}

function isHexKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}
function isRelayUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    return new URL(value).protocol === "wss:"
  } catch {
    return false
  }
}

export function parseNip46AuthSession(
  record: Record<string, unknown>
): Nip46AuthSession | null {
  if (
    record.type === "nip46" &&
    typeof record.clientKeyId === "string" &&
    record.clientKeyId.length >= 16 &&
    isHexKey(record.remoteSignerPubkey) &&
    Array.isArray(record.relayUrls) &&
    record.relayUrls.length > 0 &&
    record.relayUrls.every(isRelayUrl) &&
    isHexKey(record.userPubkey) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt)
  ) {
    return {
      version: 1,
      type: "nip46",
      clientKeyId: record.clientKeyId,
      remoteSignerPubkey: record.remoteSignerPubkey,
      relayUrls: [...new Set(record.relayUrls as string[])],
      userPubkey: record.userPubkey,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(typeof record.authClaim === "string"
        ? { authClaim: record.authClaim }
        : {}),
    }
  }
  return null
}

/** Credential identity is stable across authority claims and route updates. */
export function getNip46CredentialIdentity(session: Nip46AuthSession) {
  return {
    version: session.version,
    type: session.type,
    clientKeyId: session.clientKeyId,
    remoteSignerPubkey: session.remoteSignerPubkey,
    userPubkey: session.userPubkey,
  }
}

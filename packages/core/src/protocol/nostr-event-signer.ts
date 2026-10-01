import { isTransientNip07BridgeError } from "./signing-retry"
import type { SignedPublicNostrEvent } from "./signed-event"

export interface UnsignedNostrEvent {
  kind: number
  pubkey: string
  created_at: number
  tags: string[][]
  content: string
}

export type SignedNostrEvent = SignedPublicNostrEvent

export interface NostrEventSigner {
  /** Protected-read eligibility is limited to externally backed account sessions. */
  readonly authMethod?: "nip07" | "nip46"
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>
}

export type NostrSignerFailureCode =
  | "authorization_denied"
  | "timeout"
  | "unavailable"
  | "unsupported_operation"
  | "disconnected"
  | "authority_changed"
  | "invalid_response"

export class NostrSignerError extends Error {
  readonly code: NostrSignerFailureCode

  constructor(code: NostrSignerFailureCode) {
    super(`Nostr signer failed: ${code}`)
    this.name = "NostrSignerError"
    this.code = code
  }
}

/** Current operation availability, not an assertion of blanket signer permission. */
export interface AccountSignerCapabilities {
  readonly signEvent: boolean
  readonly nip44: boolean
  readonly nip04Decrypt: boolean
}

/** Plain key operations; local guest implementations remain purpose-scoped. */
export interface NostrKeySigner extends NostrEventSigner {
  readonly pubkey: string
  encryptNip44(recipientPubkey: string, plaintext: string): Promise<string>
  decryptNip44(senderPubkey: string, ciphertext: string): Promise<string>
  decryptLegacy(senderPubkey: string, ciphertext: string): Promise<string>
}

/** Established account authority. Guest order keys never implement this grant. */
export interface AccountSigner extends NostrKeySigner {
  readonly revision: string
  readonly authMethod: "nip07" | "nip46"
  readonly capabilities: AccountSignerCapabilities
}

export function classifyNostrSignerError(error: unknown): NostrSignerError {
  if (error instanceof NostrSignerError) return error
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined
  const code = String(record?.code ?? "")
    .trim()
    .toLowerCase()
  const name = String(record?.name ?? "")
    .trim()
    .toLowerCase()
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof record?.message === "string"
          ? record.message
          : ""
  if (isTransientNip07BridgeError(new Error(message))) {
    return new NostrSignerError("unavailable")
  }
  if (
    [
      "4001",
      "action_rejected",
      "authorization_denied",
      "declined",
      "denied",
      "not_allowed",
      "permission_denied",
      "permission_rejected",
      "rejected",
      "request_rejected",
      "user_cancelled",
      "user_denied",
      "user_rejected",
    ].includes(code) ||
    name === "notallowederror"
  ) {
    return new NostrSignerError("authorization_denied")
  }
  if (code === "unsupported_operation" || code === "unsupported")
    return new NostrSignerError("unsupported_operation")
  if (code === "disconnected") return new NostrSignerError(code)
  if (code === "timeout") return new NostrSignerError("timeout")
  if (
    code === "authority_changed" ||
    code === "identity_changed" ||
    code === "session_identity_mismatch"
  ) {
    return new NostrSignerError("authority_changed")
  }
  if (code === "invalid_response") {
    return new NostrSignerError("invalid_response")
  }
  if (
    /(?:user|request|permission|authorization).{0,80}(?:reject(?:ed|ion)?|den(?:ied|ial)|declin(?:ed|e)|cancel(?:led|ed))|(?:reject(?:ed|ion)?|den(?:ied|ial)|declin(?:ed|e)|cancel(?:led|ed)).{0,80}(?:by|from)\s+(?:the\s+)?(?:user|signer|extension)/i.test(
      message
    )
  ) {
    return new NostrSignerError("authorization_denied")
  }
  return new NostrSignerError("unavailable")
}

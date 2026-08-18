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

import type { NDKSigner, NostrEvent } from "@nostr-dev-kit/ndk"
import { getEventHash } from "nostr-tools"
import {
  NostrSignerError,
  type NostrEventSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "./nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "./signed-event"

function normalizePubkey(value: string): string {
  return value.trim().toLowerCase()
}

function classifySignerError(error: unknown): NostrSignerError {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : ""
  if (code === "rejected" || code === "authorization_denied") {
    return new NostrSignerError("authorization_denied")
  }
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
  if (error instanceof Error && /reject|denied|cancel/i.test(error.message)) {
    return new NostrSignerError("authorization_denied")
  }
  return new NostrSignerError("unavailable")
}

/**
 * Temporary NDK signer edge. Relay execution sees only cloned plain events.
 */
export function createNdkNostrEventSigner(
  signer: NDKSigner,
  expectedPubkey: string,
  authMethod: "nip07" | "nip46"
): NostrEventSigner {
  const expected = normalizePubkey(expectedPubkey)
  return {
    authMethod,
    async getPublicKey(): Promise<string> {
      return expected
    },
    async signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
      if (normalizePubkey(event.pubkey) !== expected) {
        throw new NostrSignerError("authority_changed")
      }
      const draft = {
        kind: event.kind,
        pubkey: expected,
        created_at: event.created_at,
        tags: event.tags.map((tag) => [...tag]),
        content: event.content,
      }
      let sig: string
      try {
        sig = await signer.sign(draft as NostrEvent)
      } catch (error) {
        throw classifySignerError(error)
      }
      const signed: SignedNostrEvent = {
        kind: draft.kind,
        pubkey: draft.pubkey,
        created_at: draft.created_at,
        tags: draft.tags,
        content: draft.content,
        id: getEventHash(draft),
        sig,
      }
      if (!isValidSignedPublicNostrEvent(signed)) {
        throw new NostrSignerError("invalid_response")
      }
      return {
        ...signed,
        tags: signed.tags.map((tag) => [...tag]),
      }
    },
  }
}

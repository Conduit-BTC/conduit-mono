import type { NDKSigner, NostrEvent } from "@nostr-dev-kit/ndk"
import { getEventHash } from "nostr-tools"
import {
  NostrSignerError,
  classifyNostrSignerError,
  type NostrEventSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "./nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "./signed-event"

function normalizePubkey(value: string): string {
  return value.trim().toLowerCase()
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
        throw classifyNostrSignerError(error)
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

import type { NDKSigner, NostrEvent } from "@nostr-dev-kit/ndk"
import { getEventHash } from "nostr-tools"
import {
  NostrSignerError,
  type NostrEventSigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "./nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "./signed-event"
import { isTransientNip07BridgeError } from "./signing-retry"

function normalizePubkey(value: string): string {
  return value.trim().toLowerCase()
}

function classifySignerError(error: unknown): NostrSignerError {
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

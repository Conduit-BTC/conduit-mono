import {
  NDKNip07Signer,
  type NDKEncryptionScheme,
  type NDKUser,
  type NostrEvent,
} from "@nostr-dev-kit/ndk"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export type Nip07SessionSignerErrorCode =
  "identity_changed" | "invalid_response"

export class Nip07SessionSignerError extends Error {
  readonly code: Nip07SessionSignerErrorCode

  constructor(code: Nip07SessionSignerErrorCode, message: string) {
    super(message)
    this.name = "Nip07SessionSignerError"
    this.code = code
  }
}

export interface Nip07SessionSignerOptions {
  onInvalidated?: (error: Nip07SessionSignerError) => void
}

type Nip07SignedEventBridge = {
  getPublicKey: () => Promise<string>
  signEvent: (event: {
    created_at: number
    kind: number
    tags: string[][]
    content: string
  }) => Promise<unknown>
}

function normalizePubkey(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null
}

function hasSameTags(a: string[][], b: string[][]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * NDK's NIP-07 signer caches the account returned during initial connection
 * and later keeps only the signature returned by window.nostr.signEvent().
 * This wrapper binds every key operation to that initial account and validates
 * the complete signed event before NDK is allowed to accept its signature.
 */
export class Nip07SessionSigner extends NDKNip07Signer {
  private sessionPubkey: string | null = null
  private invalidated = false
  private readonly onInvalidated?: Nip07SessionSignerOptions["onInvalidated"]

  constructor(options: Nip07SessionSignerOptions = {}) {
    super()
    this.onInvalidated = options.onInvalidated
  }

  override async blockUntilReady(): Promise<NDKUser> {
    const user = await super.blockUntilReady()
    const pubkey = normalizePubkey(user.pubkey)
    if (!pubkey) {
      return this.invalidate(
        "invalid_response",
        "The signer returned an invalid account. Reconnect it and try again."
      )
    }
    if (this.sessionPubkey && this.sessionPubkey !== pubkey) {
      return this.invalidate(
        "identity_changed",
        "The signer account changed. Conduit disconnected it before continuing. Reconnect the intended account and try again."
      )
    }
    this.sessionPubkey = pubkey
    return user
  }

  override async sign(event: NostrEvent): Promise<string> {
    const expectedPubkey = await this.assertLiveIdentity()
    if (
      normalizePubkey(event.pubkey) !== expectedPubkey ||
      !Number.isSafeInteger(event.created_at) ||
      (event.created_at ?? 0) <= 0 ||
      !Number.isSafeInteger(event.kind) ||
      event.kind === undefined ||
      typeof event.content !== "string" ||
      !Array.isArray(event.tags) ||
      event.tags.some(
        (tag) =>
          !Array.isArray(tag) ||
          tag.length === 0 ||
          tag.some((value) => typeof value !== "string")
      )
    ) {
      return this.invalidate(
        "invalid_response",
        "The event uses a different account and was not sent to the signer."
      )
    }

    const bridge = window.nostr as unknown as Nip07SignedEventBridge | undefined
    if (!bridge) throw new Error("NIP-07 extension not available")
    const expectedTags = event.tags.map((tag) => [...tag])
    const draft = {
      created_at: event.created_at as number,
      kind: event.kind as number,
      tags: expectedTags.map((tag) => [...tag]),
      content: event.content,
    }
    const response = await bridge.signEvent(draft)
    if (!response || typeof response !== "object") {
      return this.invalidate(
        "invalid_response",
        "The signer returned an invalid event. Conduit rejected it and disconnected the signer."
      )
    }
    const signed = response as SignedPublicNostrEvent

    if (normalizePubkey(signed.pubkey) !== expectedPubkey) {
      return this.invalidate(
        "identity_changed",
        "The event was signed with a different account. Conduit rejected it and disconnected the signer."
      )
    }
    if (
      signed.created_at !== draft.created_at ||
      signed.kind !== draft.kind ||
      signed.content !== draft.content ||
      !hasSameTags(signed.tags, expectedTags)
    ) {
      return this.invalidate(
        "invalid_response",
        "The signer changed the event payload. Conduit rejected it and disconnected the signer."
      )
    }
    if (!isValidSignedPublicNostrEvent(signed as SignedPublicNostrEvent)) {
      return this.invalidate(
        "invalid_response",
        "The signer returned an invalid event. Conduit rejected it and disconnected the signer."
      )
    }

    await this.assertLiveIdentity()
    return signed.sig
  }

  override async encrypt(
    recipient: NDKUser,
    value: string,
    scheme?: NDKEncryptionScheme
  ): Promise<string> {
    await this.assertLiveIdentity()
    const encrypted = await super.encrypt(recipient, value, scheme)
    await this.assertLiveIdentity()
    return encrypted
  }

  override async decrypt(
    sender: NDKUser,
    value: string,
    scheme?: NDKEncryptionScheme
  ): Promise<string> {
    await this.assertLiveIdentity()
    const decrypted = await super.decrypt(sender, value, scheme)
    await this.assertLiveIdentity()
    return decrypted
  }

  private async assertLiveIdentity(): Promise<string> {
    if (this.invalidated) {
      throw new Nip07SessionSignerError(
        "identity_changed",
        "The signer session is no longer available. Reconnect the intended account and try again."
      )
    }

    const expectedPubkey =
      this.sessionPubkey ?? normalizePubkey((await this.user()).pubkey)
    if (!expectedPubkey) {
      return this.invalidate(
        "invalid_response",
        "The signer returned an invalid account. Reconnect it and try again."
      )
    }

    const livePubkey = normalizePubkey(await window.nostr?.getPublicKey())
    if (livePubkey !== expectedPubkey) {
      return this.invalidate(
        "identity_changed",
        "The signer account changed. Conduit disconnected it before continuing. Reconnect the intended account and try again."
      )
    }
    return expectedPubkey
  }

  private invalidate(
    code: Nip07SessionSignerErrorCode,
    message: string
  ): never {
    const error = new Nip07SessionSignerError(code, message)
    if (!this.invalidated) {
      this.invalidated = true
      this.onInvalidated?.(error)
    }
    throw error
  }
}

import {
  NostrSignerError,
  type NostrKeySigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "./nostr-event-signer"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  withTransientNip07ReadinessRetry,
  type TransientNip07ReadinessRetryOptions,
} from "./signing-retry"

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
  readinessRetryDelaysMs?: readonly number[]
}

type Nip07EncryptionBridge = {
  encrypt: (pubkey: string, plaintext: string) => Promise<string>
  decrypt: (pubkey: string, ciphertext: string) => Promise<string>
}

type Nip07Bridge = {
  getPublicKey: () => Promise<string>
  signEvent: (event: {
    created_at: number
    kind: number
    tags: string[][]
    content: string
  }) => Promise<unknown>
  nip04?: Nip07EncryptionBridge
  nip44?: Nip07EncryptionBridge
}

function normalizePubkey(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null
}

function hasSameTags(
  a: readonly (readonly string[])[],
  b: readonly (readonly string[])[]
): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Bind browser key operations to the connection account and validate their
 * complete responses. SessionSigner owns authority and prompt serialization.
 */
export class Nip07SessionSigner implements NostrKeySigner {
  private sessionPubkey: string | null = null
  private readyPromise: Promise<string> | null = null
  private invalidated = false
  private readonly onInvalidated?: Nip07SessionSignerOptions["onInvalidated"]
  private readonly readinessRetry: TransientNip07ReadinessRetryOptions

  constructor(options: Nip07SessionSignerOptions = {}) {
    this.onInvalidated = options.onInvalidated
    this.readinessRetry = {
      retryDelaysMs: options.readinessRetryDelaysMs,
    }
  }

  get pubkey(): string {
    this.assertAvailableSession()
    if (!this.sessionPubkey) throw new Error("Not ready")
    return this.sessionPubkey
  }

  async getPublicKey(): Promise<string> {
    this.assertAvailableSession()
    this.readyPromise ??= this.initializeIdentity()
    try {
      return await this.readyPromise
    } catch (error) {
      this.readyPromise = null
      throw error
    }
  }

  private async initializeIdentity(): Promise<string> {
    this.assertAvailableSession()
    const { pubkey } = await this.readReadyBridge()
    if (this.sessionPubkey && this.sessionPubkey !== pubkey) {
      return this.invalidate(
        "identity_changed",
        "The signer account changed. Conduit disconnected it before continuing. Reconnect the intended account and try again."
      )
    }
    this.sessionPubkey = pubkey
    return pubkey
  }

  async signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
    const { bridge, pubkey: expectedPubkey } = await this.assertLiveIdentity()
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
    return signed
  }

  async encryptNip44(peer: string, value: string): Promise<string> {
    return this.keyOperation(peer, value, "nip44", "encrypt")
  }

  async decryptNip44(peer: string, value: string): Promise<string> {
    return this.keyOperation(peer, value, "nip44", "decrypt")
  }

  async decryptLegacy(peer: string, value: string): Promise<string> {
    return this.keyOperation(peer, value, "nip04", "decrypt")
  }

  private async keyOperation(
    peer: string,
    value: string,
    scheme: "nip44" | "nip04",
    operation: "encrypt" | "decrypt"
  ): Promise<string> {
    const { bridge } = await this.assertLiveIdentity()
    const lane = bridge[scheme]
    if (typeof lane?.[operation] !== "function")
      throw new NostrSignerError("unsupported_operation")
    const result = await lane[operation](peer, value)
    if (typeof result !== "string" || (operation === "encrypt" && !result))
      throw new NostrSignerError("invalid_response")
    await this.assertLiveIdentity()
    return result
  }

  private assertAvailableSession(): void {
    if (this.invalidated) {
      throw new Nip07SessionSignerError(
        "identity_changed",
        "The signer session is no longer available. Reconnect the intended account and try again."
      )
    }
  }

  private getCurrentBridge(): Nip07Bridge | undefined {
    return typeof window === "undefined"
      ? undefined
      : (window.nostr as Nip07Bridge | undefined)
  }

  private async readReadyBridge(): Promise<{
    bridge: Nip07Bridge
    pubkey: string
  }> {
    const ready = await withTransientNip07ReadinessRetry(async () => {
      const bridge = this.getCurrentBridge()
      if (!bridge || typeof bridge.getPublicKey !== "function") {
        throw new Error("NIP-07 extension not available")
      }
      return { bridge, rawPubkey: await bridge.getPublicKey() }
    }, this.readinessRetry)
    const pubkey = normalizePubkey(ready.rawPubkey)
    if (!pubkey) {
      return this.invalidate(
        "invalid_response",
        "The signer returned an invalid account. Reconnect it and try again."
      )
    }
    return { bridge: ready.bridge, pubkey }
  }

  private async assertLiveIdentity(): Promise<{
    bridge: Nip07Bridge
    pubkey: string
  }> {
    this.assertAvailableSession()

    const expectedPubkey = this.sessionPubkey ?? (await this.getPublicKey())
    if (!expectedPubkey) {
      return this.invalidate(
        "invalid_response",
        "The signer returned an invalid account. Reconnect it and try again."
      )
    }

    const live = await this.readReadyBridge()
    if (live.pubkey !== expectedPubkey) {
      return this.invalidate(
        "identity_changed",
        "The signer account changed. Conduit disconnected it before continuing. Reconnect the intended account and try again."
      )
    }
    return live
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

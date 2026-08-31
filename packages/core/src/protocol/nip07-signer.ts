import {
  NDKNip07Signer,
  NDKUser,
  type NDKEncryptionScheme,
  type NostrEvent,
} from "@nostr-dev-kit/ndk"
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
  private sessionUser: NDKUser | null = null
  private readyPromise: Promise<NDKUser> | null = null
  private encryptionTail: Promise<void> = Promise.resolve()
  private invalidated = false
  private readonly onInvalidated?: Nip07SessionSignerOptions["onInvalidated"]
  private readonly readinessRetry: TransientNip07ReadinessRetryOptions

  constructor(options: Nip07SessionSignerOptions = {}) {
    super()
    this.onInvalidated = options.onInvalidated
    this.readinessRetry = {
      retryDelaysMs: options.readinessRetryDelaysMs,
    }
  }

  override get pubkey(): string {
    if (!this.sessionPubkey) throw new Error("Not ready")
    return this.sessionPubkey
  }

  override get userSync(): NDKUser {
    if (!this.sessionUser) throw new Error("User not ready")
    return this.sessionUser
  }

  override async user(): Promise<NDKUser> {
    this.readyPromise ??= this.blockUntilReady()
    try {
      return await this.readyPromise
    } catch (error) {
      this.readyPromise = null
      throw error
    }
  }

  override async blockUntilReady(): Promise<NDKUser> {
    this.assertAvailableSession()
    const { pubkey } = await this.readReadyBridge()
    if (this.sessionPubkey && this.sessionPubkey !== pubkey) {
      return this.invalidate(
        "identity_changed",
        "The signer account changed. Conduit disconnected it before continuing. Reconnect the intended account and try again."
      )
    }
    this.sessionPubkey = pubkey
    this.sessionUser ??= new NDKUser({ pubkey })
    return this.sessionUser
  }

  override async sign(event: NostrEvent): Promise<string> {
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
    return signed.sig
  }

  override async encrypt(
    recipient: NDKUser,
    value: string,
    scheme?: NDKEncryptionScheme
  ): Promise<string> {
    return this.runEncryptionOperation(async () => {
      const resolvedScheme = scheme ?? "nip04"
      const { bridge } = await this.assertLiveIdentity()
      const encryptionBridge = bridge[resolvedScheme]
      if (typeof encryptionBridge?.encrypt !== "function") {
        throw new Error(
          `${resolvedScheme} encryption is not available from your browser extension`
        )
      }
      const encrypted = await encryptionBridge.encrypt(recipient.pubkey, value)
      if (!encrypted) throw new Error("Failed to encrypt")
      await this.assertLiveIdentity()
      return encrypted
    })
  }

  override async decrypt(
    sender: NDKUser,
    value: string,
    scheme?: NDKEncryptionScheme
  ): Promise<string> {
    return this.runEncryptionOperation(async () => {
      const resolvedScheme = scheme ?? "nip04"
      const { bridge } = await this.assertLiveIdentity()
      const encryptionBridge = bridge[resolvedScheme]
      if (typeof encryptionBridge?.decrypt !== "function") {
        throw new Error(
          `${resolvedScheme} decryption is not available from your browser extension`
        )
      }
      const decrypted = await encryptionBridge.decrypt(sender.pubkey, value)
      if (!decrypted) throw new Error("Failed to decrypt")
      await this.assertLiveIdentity()
      return decrypted
    })
  }

  override async encryptionEnabled(
    scheme?: NDKEncryptionScheme
  ): Promise<NDKEncryptionScheme[]> {
    this.assertAvailableSession()
    const bridge = await withTransientNip07ReadinessRetry(async () => {
      const currentBridge = this.getCurrentBridge()
      if (!currentBridge) throw new Error("NIP-07 extension not available")
      return currentBridge
    }, this.readinessRetry)
    const enabled: NDKEncryptionScheme[] = []
    if (
      (!scheme || scheme === "nip04") &&
      typeof bridge?.nip04?.encrypt === "function" &&
      typeof bridge.nip04.decrypt === "function"
    ) {
      enabled.push("nip04")
    }
    if (
      (!scheme || scheme === "nip44") &&
      typeof bridge?.nip44?.encrypt === "function" &&
      typeof bridge.nip44.decrypt === "function"
    ) {
      enabled.push("nip44")
    }
    return enabled
  }

  private assertAvailableSession(): void {
    if (this.invalidated) {
      throw new Nip07SessionSignerError(
        "identity_changed",
        "The signer session is no longer available. Reconnect the intended account and try again."
      )
    }
  }

  private async runEncryptionOperation<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.encryptionTail
    let release = () => {}
    this.encryptionTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
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

    const expectedPubkey =
      this.sessionPubkey ?? normalizePubkey((await this.user()).pubkey)
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

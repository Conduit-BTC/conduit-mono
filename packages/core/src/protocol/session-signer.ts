import type NDK from "@nostr-dev-kit/ndk"
import type {
  NDKEncryptionScheme,
  NDKRelay,
  NDKSigner,
  NDKUser,
  NostrEvent,
} from "@nostr-dev-kit/ndk"

export type SessionSignerErrorCode = "authority_changed" | "identity_changed"

export class SessionSignerError extends Error {
  readonly code: SessionSignerErrorCode

  constructor(code: SessionSignerErrorCode, message: string) {
    super(message)
    this.name = "SessionSignerError"
    this.code = code
  }
}

export interface SessionSignerOptions {
  expectedPubkey: string
  hasAuthority: () => boolean
  onInvalidated?: (error: SessionSignerError) => void
}

function normalizePubkey(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Binds any external signer implementation to one authenticated Conduit
 * session. This is the final authority fence for NIP-07 and NIP-46: a stale
 * tab or replaced auth claim cannot start or complete a key operation.
 */
export class SessionSigner implements NDKSigner {
  private readonly signer: NDKSigner
  private readonly expectedPubkey: string
  private readonly hasAuthority: SessionSignerOptions["hasAuthority"]
  private readonly onInvalidated?: SessionSignerOptions["onInvalidated"]
  private invalidated = false

  constructor(signer: NDKSigner, options: SessionSignerOptions) {
    this.signer = signer
    this.expectedPubkey = normalizePubkey(options.expectedPubkey)
    this.hasAuthority = options.hasAuthority
    this.onInvalidated = options.onInvalidated
  }

  /** Revoke this exact in-memory lease even when browser storage is blocked. */
  invalidateLocal(): void {
    this.invalidated = true
  }

  get pubkey(): string {
    this.assertAuthority()
    const pubkey = normalizePubkey(this.signer.pubkey)
    this.assertExpectedPubkey(pubkey)
    return pubkey
  }

  get userSync(): NDKUser {
    this.assertAuthority()
    const user = this.signer.userSync
    this.assertExpectedPubkey(user.pubkey)
    return user
  }

  async blockUntilReady(): Promise<NDKUser> {
    this.assertAuthority()
    const user = await this.signer.blockUntilReady()
    this.assertExpectedPubkey(user.pubkey)
    this.assertAuthority()
    return user
  }

  async user(): Promise<NDKUser> {
    this.assertAuthority()
    const user = await this.signer.user()
    this.assertExpectedPubkey(user.pubkey)
    this.assertAuthority()
    return user
  }

  async sign(event: NostrEvent): Promise<string> {
    this.assertAuthority()
    this.assertExpectedPubkey(event.pubkey)
    const signature = await this.signer.sign(event)
    this.assertAuthority()
    return signature
  }

  async relays(ndk?: NDK): Promise<NDKRelay[]> {
    this.assertAuthority()
    const relays = this.signer.relays ? await this.signer.relays(ndk) : []
    this.assertAuthority()
    return relays
  }

  async encryptionEnabled(
    scheme?: NDKEncryptionScheme
  ): Promise<NDKEncryptionScheme[]> {
    this.assertAuthority()
    const enabled = this.signer.encryptionEnabled
      ? await this.signer.encryptionEnabled(scheme)
      : []
    this.assertAuthority()
    return enabled
  }

  async encrypt(
    recipient: NDKUser,
    value: string,
    scheme?: NDKEncryptionScheme
  ): Promise<string> {
    this.assertAuthority()
    const encrypted = await this.signer.encrypt(recipient, value, scheme)
    this.assertAuthority()
    return encrypted
  }

  async decrypt(
    sender: NDKUser,
    value: string,
    scheme?: NDKEncryptionScheme
  ): Promise<string> {
    this.assertAuthority()
    const decrypted = await this.signer.decrypt(sender, value, scheme)
    this.assertAuthority()
    return decrypted
  }

  toPayload(): string {
    this.assertAuthority()
    return this.signer.toPayload()
  }

  private assertAuthority(): void {
    if (this.invalidated || !this.hasAuthority()) {
      this.reject(
        "authority_changed",
        "This signer session was replaced in another tab. Conduit disconnected it before continuing. Reconnect the intended account and try again."
      )
    }
  }

  private assertExpectedPubkey(pubkey: string): void {
    if (normalizePubkey(pubkey) !== this.expectedPubkey) {
      this.reject(
        "identity_changed",
        "The active signer does not match the connected account. Conduit disconnected it before continuing."
      )
    }
  }

  private reject(code: SessionSignerErrorCode, message: string): never {
    const error = new SessionSignerError(code, message)
    if (!this.invalidated) {
      this.invalidated = true
      this.onInvalidated?.(error)
    }
    throw error
  }
}

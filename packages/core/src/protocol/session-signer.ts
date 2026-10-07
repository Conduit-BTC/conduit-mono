import type { ProtectedReadSessionLifecycle } from "./protected-read-session-lifecycle"
import type { AuthMethod } from "./auth-session"
import {
  classifyNostrSignerError,
  NostrSignerError,
  type AccountSigner,
  type AccountSignerCapabilities,
  type NostrKeySigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "./nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "./signed-event"

export type SessionSignerErrorCode =
  "authority_changed" | "identity_changed" | "timeout" | "invalid_response"

export class SessionSignerError extends Error {
  readonly code: SessionSignerErrorCode

  constructor(code: SessionSignerErrorCode, message: string) {
    super(message)
    this.name = "SessionSignerError"
    this.code = code
  }
}

// Relay clients are recreated independently of account authority. The auth
// provider installs and retires this exact owner, never a relay-client signer.
let activeAccountSigner: SessionSigner | null = null

export function activateAccountSigner(signer: SessionSigner): void {
  signer.pubkey
  if (activeAccountSigner !== signer) activeAccountSigner?.invalidateLocal()
  activeAccountSigner = signer
}

/** Commit the existing account owner only after protected-read installation. */
export function installAccountSigner(
  signer: SessionSigner,
  protectedReads: ProtectedReadSessionLifecycle,
  hasAuthority: () => boolean
): void {
  try {
    protectedReads.activate(signer, signer.pubkey, hasAuthority)
    activateAccountSigner(signer)
  } catch (cause) {
    protectedReads.deactivate()
    signer.invalidateLocal(cause)
    throw cause
  }
}

export function retireAccountSigner(signer: SessionSigner): void {
  if (activeAccountSigner === signer) activeAccountSigner = null
  signer.invalidateLocal()
}

export function getAccountSigner(): AccountSigner | undefined {
  const signer = activeAccountSigner
  if (!signer) return undefined
  try {
    signer.pubkey
    return signer
  } catch {
    // Stale authority has already been retired by the session owner.
    return undefined
  }
}

export interface SessionSignerOptions {
  expectedPubkey: string
  revision: string
  authMethod: AuthMethod
  getCapabilities: () => AccountSignerCapabilities
  operationTimeoutMs?: number
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
export class SessionSigner implements AccountSigner {
  private readonly signer: NostrKeySigner
  private readonly expectedPubkey: string
  private readonly hasAuthority: SessionSignerOptions["hasAuthority"]
  private readonly onInvalidated?: SessionSignerOptions["onInvalidated"]
  readonly revision: string
  readonly authMethod: AuthMethod
  private readonly getCapabilities: () => AccountSignerCapabilities
  private readonly operationTimeoutMs: number
  private operationTail: Promise<void> = Promise.resolve()
  private readonly cancellation = new AbortController()
  private invalidated = false

  constructor(signer: NostrKeySigner, options: SessionSignerOptions) {
    this.signer = signer
    this.revision = options.revision
    this.authMethod = options.authMethod
    this.getCapabilities = options.getCapabilities
    this.operationTimeoutMs = options.operationTimeoutMs ?? 60_000
    this.expectedPubkey = normalizePubkey(options.expectedPubkey)
    if (
      !/^[0-9a-f]{64}$/.test(this.expectedPubkey) ||
      !this.revision ||
      !Number.isFinite(this.operationTimeoutMs) ||
      this.operationTimeoutMs <= 0
    ) {
      throw new NostrSignerError("invalid_response")
    }
    this.hasAuthority = options.hasAuthority
    this.onInvalidated = options.onInvalidated
  }

  /** Revoke this exact in-memory lease even when browser storage is blocked. */
  invalidateLocal(
    cause: unknown = new NostrSignerError("authority_changed")
  ): void {
    this.invalidated = true
    this.cancellation.abort(classifyNostrSignerError(cause))
  }

  get pubkey(): string {
    this.assertAuthority()
    const pubkey = normalizePubkey(this.signer.pubkey)
    this.assertExpectedPubkey(pubkey)
    return pubkey
  }

  get capabilities(): AccountSignerCapabilities {
    this.assertAuthority()
    return Object.freeze({ ...this.getCapabilities() })
  }

  async getPublicKey(): Promise<string> {
    try {
      return this.pubkey
    } catch (error) {
      throw classifyNostrSignerError(error)
    }
  }

  async signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
    // Snapshot before queueing: neither caller nor provider may change consent.
    try {
      if (
        typeof event.pubkey !== "string" ||
        !/^[0-9a-f]{64}$/i.test(event.pubkey) ||
        !Array.isArray(event.tags) ||
        event.tags.some(
          (tag) =>
            !Array.isArray(tag) ||
            tag.length === 0 ||
            tag.some((value) => typeof value !== "string")
        ) ||
        !Number.isSafeInteger(event.kind) ||
        !Number.isSafeInteger(event.created_at) ||
        event.created_at < 0 ||
        typeof event.content !== "string"
      ) {
        throw new NostrSignerError("invalid_response")
      }
      const expected = {
        kind: event.kind,
        pubkey: event.pubkey,
        created_at: event.created_at,
        tags: event.tags.map((tag) => [...tag]),
        content: event.content,
      }
      this.assertAuthority()
      this.assertExpectedPubkey(expected.pubkey)
      return await this.runOperation("signEvent", async () => {
        const draft = {
          ...expected,
          tags: expected.tags.map((tag) => [...tag]),
        }
        const signed = await this.signer.signEvent(draft)
        this.assertAuthority()
        if (!isValidSignedPublicNostrEvent(signed)) {
          this.reject(
            "invalid_response",
            "The signer returned an invalid signature. Reconnect the intended account and try again."
          )
        }
        if (
          signed.pubkey !== expected.pubkey ||
          signed.kind !== expected.kind ||
          signed.created_at !== expected.created_at ||
          signed.content !== expected.content ||
          JSON.stringify(signed.tags) !== JSON.stringify(expected.tags)
        ) {
          this.reject(
            "invalid_response",
            "The signer changed the event. Reconnect the intended account and try again."
          )
        }
        return { ...expected, id: signed.id, sig: signed.sig }
      })
    } catch (error) {
      throw classifyNostrSignerError(error)
    }
  }

  async encryptNip44(
    recipientPubkey: string,
    plaintext: string
  ): Promise<string> {
    return this.runKeyOperation("encrypt", recipientPubkey, plaintext, "nip44")
  }

  async decryptNip44(
    senderPubkey: string,
    ciphertext: string
  ): Promise<string> {
    return this.runKeyOperation("decrypt", senderPubkey, ciphertext, "nip44")
  }

  async decryptLegacy(
    senderPubkey: string,
    ciphertext: string
  ): Promise<string> {
    return this.runKeyOperation("decrypt", senderPubkey, ciphertext, "nip04")
  }

  private async runKeyOperation(
    operation: "encrypt" | "decrypt",
    peerPubkey: string,
    value: string,
    scheme: "nip44" | "nip04"
  ): Promise<string> {
    if (!/^[0-9a-f]{64}$/i.test(peerPubkey))
      throw new NostrSignerError("invalid_response")
    const peer = normalizePubkey(peerPubkey)
    const result = await this.runOperation(
      scheme === "nip04" ? "nip04Decrypt" : "nip44",
      () =>
        operation === "encrypt"
          ? this.signer.encryptNip44(peer, value)
          : scheme === "nip44"
            ? this.signer.decryptNip44(peer, value)
            : this.signer.decryptLegacy(peer, value)
    )
    if (
      typeof result !== "string" ||
      (operation === "encrypt" && result.length === 0)
    )
      throw new NostrSignerError("invalid_response")
    return result
  }

  private async runOperation<T>(
    capability: keyof AccountSignerCapabilities,
    operation: () => Promise<T>
  ): Promise<T> {
    let release: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      this.assertAuthority()
      const slot = new Promise<void>((resolve) => {
        release = resolve
      })
      const previous = this.operationTail
      this.operationTail = previous.then(() => slot)
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(classifyNostrSignerError(this.cancellation.signal.reason))
        this.cancellation.signal.addEventListener("abort", onAbort, {
          once: true,
        })
      })
      let rejectTimeout!: (error: NostrSignerError) => void
      const timeout = new Promise<never>((_, reject) => {
        rejectTimeout = reject
      })
      const task = (async () => {
        await previous
        this.assertAuthority()
        if (!this.capabilities[capability])
          throw new NostrSignerError("unsupported_operation")
        // Queueing does not consume another operation's approval window.
        timer = setTimeout(() => {
          try {
            this.reject(
              "timeout",
              "The signer did not answer in time. Reconnect it and try again."
            )
          } catch (error) {
            rejectTimeout(classifyNostrSignerError(error))
          }
        }, this.operationTimeoutMs)
        const result = await operation()
        this.assertAuthority()
        if (!this.capabilities[capability])
          throw new NostrSignerError("unsupported_operation")
        return result
      })()
      return await Promise.race([task, cancelled, timeout])
    } catch (error) {
      throw classifyNostrSignerError(error)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort)
        this.cancellation.signal.removeEventListener("abort", onAbort)
      release?.()
    }
  }

  private assertAuthority(): void {
    if (this.invalidated || !this.hasAuthority()) {
      this.reject(
        "authority_changed",
        "This signer session was replaced in another tab. Conduit disconnected it before continuing. Reconnect the intended account and try again."
      )
    }
    this.assertExpectedPubkey(this.signer.pubkey)
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
      // Publish the cause before auth cleanup can revoke the local lease.
      this.cancellation.abort(error)
      this.onInvalidated?.(error)
    }
    throw error
  }
}

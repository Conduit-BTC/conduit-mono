import type { AuthSession } from "./auth-session"
import type { LocalKeySigner } from "./local-key"
import type { NostrKeySigner } from "./nostr-event-signer"
import type { RemoteSignerConnection } from "./remote-signer"
import { createProtectedReadSessionLifecycle } from "./protected-read-session-lifecycle"
import {
  installAccountSigner,
  retireAccountSigner,
  SessionSigner,
  SessionSignerError,
  type SessionSignerOptions,
} from "./session-signer"

/**
 * One AuthProvider connection owns live resources from acquisition to retirement.
 * Pending authority requires the attempt fence; successful handoff detaches that
 * fence, retaining the installed session's metadata/revision authority. Durable
 * credential rollback/removal remains under the provider's browser auth lock.
 */
export class AuthConnection {
  private phase: "pending" | "installed" | "retired" = "pending"
  private readonly reads = createProtectedReadSessionLifecycle()
  private owner: SessionSigner | null = null
  private localProvider: LocalKeySigner | null = null
  private remoteProvider: RemoteSignerConnection | null = null
  private boundSession: AuthSession | null = null

  constructor(
    private readonly isCurrent: () => boolean,
    private readonly signal?: AbortSignal,
    private readonly onPendingRetired?: () => void
  ) {
    signal?.addEventListener("abort", this.abort, { once: true })
    if (signal?.aborted) this.retire()
  }

  get session(): AuthSession | null {
    return this.boundSession
  }
  get local(): LocalKeySigner | null {
    return this.localProvider
  }
  get remote(): RemoteSignerConnection | null {
    return this.remoteProvider
  }

  ownLocal(provider: LocalKeySigner): void {
    this.localProvider = provider
    this.assertPending()
  }

  ownRemote(provider: RemoteSignerConnection): void {
    this.remoteProvider = provider
    this.assertPending()
  }

  install(
    provider: NostrKeySigner,
    session: AuthSession,
    options: Omit<
      SessionSignerOptions,
      "expectedPubkey" | "revision" | "authMethod"
    >
  ): void {
    this.assertPending()
    this.boundSession = session
    const hasAuthority = () =>
      this.phase !== "retired" &&
      (this.phase === "installed" || this.isCurrent()) &&
      options.hasAuthority()
    this.owner = new SessionSigner(provider, {
      ...options,
      expectedPubkey: session.userPubkey,
      revision: session.authClaim!,
      authMethod: session.type,
      hasAuthority,
    })
    try {
      installAccountSigner(this.owner, this.reads, hasAuthority)
    } catch (cause) {
      this.retire(cause)
      throw cause
    }
  }

  /** Synchronous, one-way handoff after every asynchronous install step. */
  complete(): SessionSigner {
    this.assertPending()
    if (!this.owner?.pubkey)
      throw new Error("Signer installation is incomplete")
    this.phase = "installed"
    this.signal?.removeEventListener("abort", this.abort)
    return this.owner
  }

  /** Revoke exact live resources now; storage failure cannot delay revocation. */
  retire(cause?: unknown): void {
    const wasPending = this.phase === "pending"
    this.phase = "retired"
    this.signal?.removeEventListener("abort", this.abort)
    this.owner?.invalidateLocal(cause)
    if (this.owner) retireAccountSigner(this.owner)
    this.reads.deactivate()
    this.localProvider?.invalidate()
    this.remoteProvider?.signer.invalidate()
    if (wasPending) this.onPendingRetired?.()
  }

  private readonly abort = () => this.retire()

  private assertPending(): void {
    if (this.phase === "pending" && this.isCurrent() && !this.signal?.aborted)
      return
    this.retire()
    throw new SessionSignerError(
      "authority_changed",
      "The signer connection is no longer current."
    )
  }
}

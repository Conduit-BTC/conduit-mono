import type { NostrEventSigner } from "./nostr-event-signer"

export type ProtectedReadOperation = "private_inbox_read"
export type ProtectedReadAuthPolicy = "required" | "when_challenged"
type ProtectedReadSessionAuthenticationSuppression =
  | "signer_authorization_denied"
  | "authentication_timed_out"
  | "signer_unavailable"

export type ProtectedReadRelayAuthenticationSuppression =
  | "authentication_required"
  | "missing_challenge"
  | "authentication_rejected"
  | "authentication_timed_out"
  | "subscription_rejected"
  | "query_timed_out"
  | "transport_unavailable"
  | "challenge_invalid"
  | "challenge_replayed"
  | "challenge_loop"
  | "protocol_invalid"
  | "protocol_limit_exceeded"

export type ProtectedReadAuthenticationSuppression =
  | ProtectedReadSessionAuthenticationSuppression
  | ProtectedReadRelayAuthenticationSuppression

type ProtectedReadAuthenticationSuppressionRequest =
  | {
      scope: "session"
      reason: ProtectedReadSessionAuthenticationSuppression
    }
  | {
      scope: "relay"
      relayUrl: string
      reason: ProtectedReadRelayAuthenticationSuppression
    }

const AUTHORIZATION_BRAND: unique symbol = Symbol(
  "protected-read-authorization"
)

type ActiveSignerLease = {
  readonly sessionScope: string
  readonly expectedPubkey: string
  readonly signer: NostrEventSigner
  readonly hasAuthority: () => boolean
  authenticationSuppression: {
    sessionReason: ProtectedReadSessionAuthenticationSuppression | null
    relayReasons: Map<string, ProtectedReadRelayAuthenticationSuppression>
  }
  active: boolean
}

export interface ProtectedReadAuthorization {
  readonly operation: ProtectedReadOperation
  readonly policy: ProtectedReadAuthPolicy
  readonly expectedPubkey: string
  readonly sessionScope: string
  readonly signer: NostrEventSigner
  readonly [AUTHORIZATION_BRAND]: ActiveSignerLease
}

export interface ProtectedReadSignerLease {
  readonly sessionScope: string
  readonly expectedPubkey: string
}

type RevocationListener = (sessionScope: string) => void

const revocationListeners = new Set<RevocationListener>()
let activeLease: ActiveSignerLease | null = null
let fallbackSessionSequence = 0

function normalizePubkey(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Protected-read signer pubkey is invalid")
  }
  return normalized
}

function createSessionScope(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  fallbackSessionSequence += 1
  return `session-${Date.now()}-${fallbackSessionSequence}`
}

function revokeLease(lease: ActiveSignerLease): void {
  if (!lease.active) return
  lease.active = false
  for (const listener of revocationListeners) listener(lease.sessionScope)
}

function hasCurrentLeaseAuthority(lease: ActiveSignerLease): boolean {
  const authorityCurrent = (() => {
    try {
      return lease.hasAuthority() === true
    } catch {
      return false
    }
  })()
  if (!authorityCurrent && lease === activeLease) {
    activeLease = null
    revokeLease(lease)
  }
  return authorityCurrent
}

/** Internal auth-provider hook. Install only externally backed account signers. */
export function installProtectedReadSigner(
  signer: NostrEventSigner,
  expectedPubkey: string,
  hasAuthority: () => boolean
): ProtectedReadSignerLease {
  if (signer.authMethod !== "nip07" && signer.authMethod !== "nip46") {
    throw new Error("Protected reads require a NIP-07 or NIP-46 account signer")
  }
  if (activeLease) revokeLease(activeLease)
  const lease: ActiveSignerLease = {
    sessionScope: createSessionScope(),
    expectedPubkey: normalizePubkey(expectedPubkey),
    signer,
    hasAuthority,
    authenticationSuppression: {
      sessionReason: null,
      relayReasons: new Map(),
    },
    active: true,
  }
  activeLease = lease
  return lease
}

/** Exact-lease removal prevents stale cleanup from revoking a newer account. */
export function removeProtectedReadSigner(
  lease: ProtectedReadSignerLease
): void {
  if (
    !activeLease ||
    activeLease.sessionScope !== lease.sessionScope ||
    activeLease.expectedPubkey !== lease.expectedPubkey
  ) {
    return
  }
  const revoked = activeLease
  activeLease = null
  revokeLease(revoked)
}

export function getProtectedReadAuthorization(
  expectedPubkey: string,
  policy: ProtectedReadAuthPolicy = "when_challenged"
): ProtectedReadAuthorization | null {
  let normalized: string
  try {
    normalized = normalizePubkey(expectedPubkey)
  } catch {
    return null
  }
  const lease = activeLease
  if (
    !lease?.active ||
    !hasCurrentLeaseAuthority(lease) ||
    lease.expectedPubkey !== normalized
  ) {
    return null
  }
  return {
    operation: "private_inbox_read",
    policy,
    expectedPubkey: lease.expectedPubkey,
    sessionScope: lease.sessionScope,
    signer: lease.signer,
    [AUTHORIZATION_BRAND]: lease,
  }
}

export function assertProtectedReadAuthorization(
  authorization: ProtectedReadAuthorization,
  expectedPubkey: string
): void {
  const lease = authorization[AUTHORIZATION_BRAND]
  const authorityCurrent = lease ? hasCurrentLeaseAuthority(lease) : false
  if (
    lease !== activeLease ||
    !lease?.active ||
    !authorityCurrent ||
    authorization.sessionScope !== lease.sessionScope ||
    authorization.signer !== lease.signer ||
    authorization.expectedPubkey !== lease.expectedPubkey ||
    lease.expectedPubkey !== normalizePubkey(expectedPubkey)
  ) {
    throw new Error("Protected-read signer authority is unavailable")
  }
}

export function hasProtectedReadAuthority(
  authorization: ProtectedReadAuthorization
): boolean {
  try {
    assertProtectedReadAuthorization(
      authorization,
      authorization.expectedPubkey
    )
    return true
  } catch {
    return false
  }
}

/**
 * Signer denial, unavailability, and external-signer timeout suppress
 * background auth prompts for the account session. Relay terminal failures,
 * including AUTH-OK timeout, suppress only that relay. Reads may still use a
 * suppressed relay when it no longer challenges after policy rollback.
 */
export function suppressProtectedReadAuthentication(
  authorization: ProtectedReadAuthorization,
  suppression: ProtectedReadAuthenticationSuppressionRequest
): boolean {
  const lease = authorization[AUTHORIZATION_BRAND]
  if (
    lease !== activeLease ||
    !lease.active ||
    !hasCurrentLeaseAuthority(lease) ||
    authorization.sessionScope !== lease.sessionScope ||
    authorization.expectedPubkey !== lease.expectedPubkey ||
    authorization.signer !== lease.signer
  ) {
    return false
  }
  if (suppression.scope === "session") {
    lease.authenticationSuppression.sessionReason ??= suppression.reason
  } else if (
    !lease.authenticationSuppression.relayReasons.has(suppression.relayUrl)
  ) {
    lease.authenticationSuppression.relayReasons.set(
      suppression.relayUrl,
      suppression.reason
    )
  }
  return true
}

export function getProtectedReadAuthenticationSuppression(
  authorization: ProtectedReadAuthorization,
  relayUrl?: string
): ProtectedReadAuthenticationSuppression | null {
  const lease = authorization[AUTHORIZATION_BRAND]
  if (
    lease !== activeLease ||
    !lease.active ||
    !hasCurrentLeaseAuthority(lease) ||
    authorization.sessionScope !== lease.sessionScope ||
    authorization.expectedPubkey !== lease.expectedPubkey ||
    authorization.signer !== lease.signer
  ) {
    return null
  }
  const suppression = lease.authenticationSuppression
  if (suppression.sessionReason) return suppression.sessionReason
  if (relayUrl === undefined) return null
  return suppression.relayReasons.get(relayUrl) ?? null
}

/** Explicit user retry hook; never clears another account's session. */
export function clearProtectedReadAuthenticationSuppression(
  expectedPubkey: string
): boolean {
  let normalized: string
  try {
    normalized = normalizePubkey(expectedPubkey)
  } catch {
    return false
  }
  const lease = activeLease
  if (
    !lease?.active ||
    lease.expectedPubkey !== normalized ||
    !hasCurrentLeaseAuthority(lease)
  ) {
    return false
  }
  lease.authenticationSuppression.sessionReason = null
  lease.authenticationSuppression.relayReasons.clear()
  return true
}

export function subscribeProtectedReadSignerRevocation(
  listener: RevocationListener
): () => void {
  revocationListeners.add(listener)
  return () => revocationListeners.delete(listener)
}

/** Test-only reset. */
export function __resetProtectedReadSigner(): void {
  if (activeLease) revokeLease(activeLease)
  activeLease = null
}

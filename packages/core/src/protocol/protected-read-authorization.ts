import type { NostrEventSigner } from "./nostr-event-signer"

export type ProtectedReadOperation = "private_inbox_read"
export type ProtectedReadAuthPolicy = "required" | "when_challenged"

const AUTHORIZATION_BRAND: unique symbol = Symbol(
  "protected-read-authorization"
)

type ActiveSignerLease = {
  readonly sessionScope: string
  readonly expectedPubkey: string
  readonly signer: NostrEventSigner
  readonly hasAuthority: () => boolean
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

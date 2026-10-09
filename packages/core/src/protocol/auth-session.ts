import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { generateId } from "../utils"
import { withBrowserAuthOperationLock } from "./auth-operation-lock"
import {
  getNip46CredentialIdentity,
  parseNip46AuthSession,
  type Nip46AuthSession,
} from "./nip46-auth-session"

export const AUTH_STORAGE_KEY = "conduit:auth"
export const AUTH_REVISION_STORAGE_KEY = "conduit:auth:revision"
const AUTH_SESSION_REVOCATION_STORAGE_PREFIX = "conduit:auth:revoked:"
const LOCAL_KEY_REMOVAL_STORAGE_KEY = "conduit:auth:local-removal"
export const AUTH_SESSION_VERSION = 1 as const
export type AuthMethod = AuthSession["type"]
export type AuthSessionDisposition = "retain_for_restore" | "discard"

/** Content-free metadata/authority failure, independent of signer transport. */
export class AuthSessionError extends Error {
  readonly operation?: string
  constructor(
    readonly code: "unavailable",
    message: string,
    options?: { cause?: unknown; operation?: string }
  ) {
    super(message, { cause: options?.cause })
    this.name = "AuthSessionError"
    this.operation = options?.operation
  }
}

function isHexKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

export function getDefaultAuthStorage(): AuthStorage | undefined {
  if (typeof window === "undefined") return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export interface AuthSessionMetadata {
  version: typeof AUTH_SESSION_VERSION
  userPubkey: string
  authClaim?: string
}

export interface Nip07AuthSession extends AuthSessionMetadata {
  type: "nip07"
}

export interface LocalKeyAuthSession extends AuthSessionMetadata {
  type: "local"
  localKeyRevision: string
}

export type AuthSession =
  Nip07AuthSession | Nip46AuthSession | LocalKeyAuthSession

export interface AuthStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function parseAuthSession(raw: string | null): AuthSession | null {
  if (raw === null) return null

  const legacyPubkey = raw.toLowerCase()
  if (isHexKey(legacyPubkey)) {
    return {
      version: AUTH_SESSION_VERSION,
      type: "nip07",
      userPubkey: legacyPubkey,
    }
  }

  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "object" || value === null) return null
    const record = value as Record<string, unknown>
    if (record.version !== AUTH_SESSION_VERSION) return null

    if (record.type === "nip07" && isHexKey(record.userPubkey)) {
      return {
        version: AUTH_SESSION_VERSION,
        type: "nip07",
        userPubkey: record.userPubkey,
        ...(typeof record.authClaim === "string"
          ? { authClaim: record.authClaim }
          : {}),
      }
    }

    if (
      record.type === "local" &&
      isHexKey(record.userPubkey) &&
      typeof record.localKeyRevision === "string" &&
      /^[a-zA-Z0-9-]{1,80}$/.test(record.localKeyRevision)
    ) {
      return {
        version: AUTH_SESSION_VERSION,
        type: "local",
        userPubkey: record.userPubkey,
        localKeyRevision: record.localKeyRevision,
        ...(typeof record.authClaim === "string"
          ? { authClaim: record.authClaim }
          : {}),
      }
    }
    return parseNip46AuthSession(record)
  } catch {
    return null
  }
}

function getAuthSessionRevocationStorageKey(session: AuthSession): string {
  const identity =
    session.type === "nip46"
      ? getNip46CredentialIdentity(session)
      : {
          version: session.version,
          type: session.type,
          userPubkey: session.userPubkey,
          authClaim: session.authClaim ?? null,
          ...(session.type === "local"
            ? { localKeyRevision: session.localKeyRevision }
            : {}),
        }
  const digest = bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify(identity)))
  )
  return `${AUTH_SESSION_REVOCATION_STORAGE_PREFIX}${digest}`
}

export function isAuthSessionRevoked(
  session: AuthSession,
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): boolean {
  if (!storage) return false
  try {
    if (session.type === "local") {
      const pending = parseAuthSession(
        storage.getItem(LOCAL_KEY_REMOVAL_STORAGE_KEY)
      )
      if (
        pending?.type === "local" &&
        pending.userPubkey === session.userPubkey &&
        pending.localKeyRevision === session.localKeyRevision
      )
        return true
    }
    return storage.getItem(getAuthSessionRevocationStorageKey(session)) === "1"
  } catch {
    return true
  }
}

export function markAuthSessionRevoked(
  session: AuthSession,
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): boolean {
  if (!storage) return false
  const key = getAuthSessionRevocationStorageKey(session)
  try {
    storage.setItem(key, "1")
    return storage.getItem(key) === "1"
  } catch {
    return false
  }
}

export function readAuthSession(
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): AuthSession | null {
  if (!storage) return null
  try {
    const session = parseAuthSession(storage.getItem(AUTH_STORAGE_KEY))
    return session && !isAuthSessionRevoked(session, storage) ? session : null
  } catch {
    return null
  }
}

/** A failed local deletion remains removable after restart, never restorable. */
export function readPendingLocalKeyRemoval(
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): LocalKeyAuthSession | null {
  if (!storage) return null
  try {
    const pending = parseAuthSession(
      storage.getItem(LOCAL_KEY_REMOVAL_STORAGE_KEY)
    )
    if (pending?.type === "local") return pending
    const session = parseAuthSession(storage.getItem(AUTH_STORAGE_KEY))
    return session?.type === "local" && isAuthSessionRevoked(session, storage)
      ? session
      : null
  } catch {
    return null
  }
}

/** Public removal journal; never contains key bytes or an import representation. */
export function writePendingLocalKeyRemoval(
  session: LocalKeyAuthSession,
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): boolean {
  if (!storage) return false
  try {
    const publicSession = parseAuthSession(JSON.stringify(session))
    const encoded = JSON.stringify(publicSession)
    storage.setItem(LOCAL_KEY_REMOVAL_STORAGE_KEY, encoded)
    return storage.getItem(LOCAL_KEY_REMOVAL_STORAGE_KEY) === encoded
  } catch {
    return false
  }
}

export function clearPendingLocalKeyRemoval(
  session: LocalKeyAuthSession,
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): boolean {
  if (!storage) return false
  try {
    const pending = parseAuthSession(
      storage.getItem(LOCAL_KEY_REMOVAL_STORAGE_KEY)
    )
    if (
      pending?.type !== "local" ||
      pending.localKeyRevision !== session.localKeyRevision ||
      pending.userPubkey !== session.userPubkey
    )
      return true
    storage.removeItem(LOCAL_KEY_REMOVAL_STORAGE_KEY)
    return storage.getItem(LOCAL_KEY_REMOVAL_STORAGE_KEY) === null
  } catch {
    return false
  }
}

type AuthSessionStorageSnapshot =
  | { status: "empty" }
  | { status: "invalid" }
  | { status: "session"; session: AuthSession }

function inspectAuthSessionStorage(
  storage: AuthStorage | undefined,
  operation: string
): AuthSessionStorageSnapshot {
  if (!storage) {
    throw new AuthSessionError(
      "unavailable",
      "The browser could not verify the saved signer session.",
      { operation }
    )
  }

  let raw: string | null
  try {
    raw = storage.getItem(AUTH_STORAGE_KEY)
  } catch (cause) {
    throw new AuthSessionError(
      "unavailable",
      "The browser could not verify the saved signer session.",
      { cause, operation }
    )
  }
  if (raw === null) return { status: "empty" }

  const session = parseAuthSession(raw)
  return session ? { status: "session", session } : { status: "invalid" }
}

export function authSessionsEqual(
  left: AuthSession | null,
  right: AuthSession | null
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function shouldRetireAuthSessionAfterAuthorityChange(
  invalidatedSession: AuthSession | null,
  storedSession: AuthSession | null
): boolean {
  return (
    invalidatedSession !== null &&
    (storedSession === null ||
      !authSessionsEqual(invalidatedSession, storedSession))
  )
}

export function canStartAuthConnection(
  mode: "interactive" | "restore",
  recoveryRequired: boolean,
  retirementBlocked = false
): boolean {
  return !retirementBlocked && (mode === "restore" || !recoveryRequired)
}

export function writeAuthSession(
  session: AuthSession,
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): boolean {
  if (!storage) return false
  const parsed = parseAuthSession(JSON.stringify(session))
  if (!parsed || isAuthSessionRevoked(parsed, storage)) return false
  try {
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(parsed))
    return true
  } catch {
    return false
  }
}

export type InvalidatedAuthSessionCleanupStatus =
  "removed" | "absent" | "replacement"

export interface InvalidatedAuthSessionCleanupOptions {
  storage?: AuthStorage
  retireCredentials: (
    expected: AuthSession,
    replacement: AuthSession | null
  ) => Promise<void>
  withLock?: <T>(task: () => Promise<T>) => Promise<T>
  /** Explicit logout only, when the caller owns the exact expected session. */
  retireExpectedCredentialsOnMetadataFailure?: boolean
  /** Local keys retain revoked public removal metadata until deletion commits. */
  retireCredentialsBeforeMetadata?: boolean
}

/**
 * Retire one invalidated session without deleting a concurrently installed
 * replacement. Metadata removal and key retirement are verified while the
 * shared browser auth lock is held.
 */
export async function cleanupInvalidatedAuthSession(
  expected: AuthSession,
  options: InvalidatedAuthSessionCleanupOptions
): Promise<InvalidatedAuthSessionCleanupStatus> {
  const storage = options.storage ?? getDefaultAuthStorage()
  const withLock = options.withLock ?? withBrowserAuthOperationLock

  return withLock(async () => {
    const operation = "retire invalidated signer session"
    if (options.retireCredentialsBeforeMetadata) {
      let replacement: AuthSession | null = null
      try {
        const snapshot = inspectAuthSessionStorage(storage, operation)
        if (
          snapshot.status === "session" &&
          !authSessionsEqual(snapshot.session, expected)
        )
          replacement = snapshot.session
      } catch (error) {
        if (!options.retireExpectedCredentialsOnMetadataFailure) throw error
      }
      await options.retireCredentials(expected, replacement)
    }
    let status: InvalidatedAuthSessionCleanupStatus = "absent"
    let metadataError: unknown = null
    let replacement: AuthSession | null = null

    try {
      const before = inspectAuthSessionStorage(storage, operation)
      if (before.status === "empty") {
        status = "absent"
      } else if (
        before.status === "session" &&
        !authSessionsEqual(before.session, expected)
      ) {
        status = "replacement"
      } else {
        try {
          storage?.removeItem(AUTH_STORAGE_KEY)
        } catch (cause) {
          throw new AuthSessionError(
            "unavailable",
            "The browser could not erase the invalidated signer session.",
            { cause, operation }
          )
        }

        const afterRemoval = inspectAuthSessionStorage(storage, operation)
        if (
          afterRemoval.status === "invalid" ||
          (afterRemoval.status === "session" &&
            authSessionsEqual(afterRemoval.session, expected))
        ) {
          throw new AuthSessionError(
            "unavailable",
            "The browser could not verify that the invalidated signer session was erased.",
            { operation }
          )
        }
        status = afterRemoval.status === "session" ? "replacement" : "removed"
      }

      const current = inspectAuthSessionStorage(storage, operation)
      replacement = current.status === "session" ? current.session : null
    } catch (cause) {
      metadataError = cause
    }

    if (metadataError && !options.retireExpectedCredentialsOnMetadataFailure) {
      throw metadataError
    }

    if (!options.retireCredentialsBeforeMetadata)
      await options.retireCredentials(expected, replacement)

    if (metadataError) throw metadataError
    return status
  })
}

export function forgetAuthSession(
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): boolean {
  if (!storage) return false
  try {
    storage.removeItem(AUTH_STORAGE_KEY)
    return storage.getItem(AUTH_STORAGE_KEY) === null
  } catch {
    return false
  }
}

export function readAuthRevision(
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): string {
  if (!storage) return ""
  try {
    return storage.getItem(AUTH_REVISION_STORAGE_KEY) ?? ""
  } catch {
    return ""
  }
}

export interface AuthRevisionClaim {
  revision: string
  persisted: boolean
}

export interface AuthSessionAuthorityRevocation {
  freshRevisionPersisted: boolean
  authorityRevoked: boolean
  sessionRetained: boolean
}

export interface AuthSessionAuthorityRevocationOptions {
  sessionDisposition?: AuthSessionDisposition
}

/**
 * Acquire a fresh cross-tab authority claim and prove it was written. A caller
 * must not treat an older readable revision as its own when setItem() fails.
 */
export function claimAuthRevision(
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): AuthRevisionClaim {
  const revision = generateId()
  if (!storage) return { revision, persisted: false }
  try {
    storage.setItem(AUTH_REVISION_STORAGE_KEY, revision)
    return {
      revision,
      persisted: storage.getItem(AUTH_REVISION_STORAGE_KEY) === revision,
    }
  } catch {
    return { revision, persisted: false }
  }
}

/**
 * Revoke one active session before asynchronous cleanup begins. Recoverable
 * metadata is retained only when a fresh cross-tab revision was written and
 * read back and the exact saved session remains available.
 */
export function revokeAuthSessionAuthority(
  expected: AuthSession,
  storage: AuthStorage | undefined = getDefaultAuthStorage(),
  options: AuthSessionAuthorityRevocationOptions = {}
): AuthSessionAuthorityRevocation {
  const claim = claimAuthRevision(storage)
  if (options.sessionDisposition !== "discard" && claim.persisted) {
    let sessionRetained: boolean
    try {
      const snapshot = inspectAuthSessionStorage(
        storage,
        "revoke signer authority"
      )
      sessionRetained =
        snapshot.status === "session" &&
        authSessionsEqual(snapshot.session, expected)
    } catch {
      sessionRetained = false
    }
    if (sessionRetained) {
      return {
        freshRevisionPersisted: true,
        authorityRevoked: true,
        sessionRetained: true,
      }
    }
  }

  const revocationMarked = markAuthSessionRevoked(expected, storage)
  if (revocationMarked) {
    return {
      freshRevisionPersisted: claim.persisted,
      authorityRevoked: true,
      sessionRetained: false,
    }
  }

  if (!storage) {
    return {
      freshRevisionPersisted: claim.persisted,
      authorityRevoked: false,
      sessionRetained: false,
    }
  }

  try {
    const before = inspectAuthSessionStorage(storage, "revoke signer authority")
    if (
      before.status === "empty" ||
      (before.status === "session" &&
        !authSessionsEqual(before.session, expected))
    ) {
      return {
        freshRevisionPersisted: false,
        authorityRevoked: true,
        sessionRetained: false,
      }
    }
    storage.removeItem(AUTH_STORAGE_KEY)
    const after = inspectAuthSessionStorage(storage, "revoke signer authority")
    const authorityRevoked =
      after.status === "empty" ||
      (after.status === "session" &&
        !authSessionsEqual(after.session, expected))
    return {
      freshRevisionPersisted: claim.persisted,
      authorityRevoked,
      sessionRetained: false,
    }
  } catch {
    return {
      freshRevisionPersisted: claim.persisted,
      authorityRevoked: false,
      sessionRetained: false,
    }
  }
}

export function bumpAuthRevision(
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): string {
  if (!storage) return ""
  const revision = generateId()
  try {
    storage.setItem(AUTH_REVISION_STORAGE_KEY, String(revision))
    return revision
  } catch {
    return readAuthRevision(storage)
  }
}

/** A saved provider is the restore target, never a fallback to another provider. */
export function resolveAuthConnectionMethod(
  mode: "interactive" | "restore",
  savedSession: AuthSession | null,
  requested?: AuthMethod
): AuthMethod | undefined {
  if (mode === "interactive") return requested ?? "nip07"
  if (requested && savedSession && requested !== savedSession.type) {
    throw new AuthSessionError(
      "unavailable",
      "The saved signer method changed. Reconnect the intended account.",
      { operation: "restore session" }
    )
  }
  return savedSession?.type
}

/** Metadata is a restore candidate; only the current claim grants authority. */
export function hasAuthSessionAuthority(
  expected: AuthSession,
  metadataPersisted: boolean,
  storage: AuthStorage | undefined = getDefaultAuthStorage()
): boolean {
  if (!expected.authClaim || readAuthRevision(storage) !== expected.authClaim)
    return false
  return (
    !metadataPersisted || authSessionsEqual(readAuthSession(storage), expected)
  )
}

export function isAccountAuthMethod(value: unknown): value is AuthMethod {
  return value === "nip07" || value === "nip46" || value === "local"
}

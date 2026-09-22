import {
  NDKUser,
  type NDKEncryptionScheme,
  type NDKSigner,
  type NostrEvent,
} from "@nostr-dev-kit/ndk"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { generateSecretKey, getPublicKey } from "nostr-tools"
import {
  BunkerSigner,
  createNostrConnectURI,
  type BunkerPointer,
  type BunkerSignerParams,
  type ClientMetadata,
} from "nostr-tools/nip46"
import { SimplePool } from "nostr-tools/pool"
import type { EventTemplate, VerifiedEvent } from "nostr-tools"
import { generateId } from "../utils"
import {
  createBrowserRemoteSignerKeyVault,
  withBrowserAuthOperationLock,
  type RemoteSignerKeyVault,
} from "./remote-signer-vault"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import {
  ConduitNip46Signer,
  Nip46TransportError,
  type Nip46RpcRequestOptions,
} from "./nip46-rpc"

export type { RemoteSignerKeyVault } from "./remote-signer-vault"

export const AUTH_STORAGE_KEY = "conduit:auth"
export const AUTH_REVISION_STORAGE_KEY = "conduit:auth:revision"
const AUTH_SESSION_REVOCATION_STORAGE_PREFIX = "conduit:auth:revoked:"
export const REMOTE_SIGNER_SESSION_VERSION = 1 as const
export const DEFAULT_REMOTE_SIGNER_TIMEOUT_MS = 30_000
export const DEFAULT_REMOTE_SIGNER_PAIR_TIMEOUT_MS = 120_000
export const CONDUIT_NIP46_PERMISSIONS = [
  "sign_event",
  "get_public_key",
  "nip44_encrypt",
  "nip44_decrypt",
  "nip04_decrypt",
] as const

const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/

export type RemoteSignerErrorCode =
  | "invalid_uri"
  | "timeout"
  | "rejected"
  | "unsupported"
  | "unavailable"
  | "credential_unavailable"
  | "invalid_response"
  | "session_identity_mismatch"

export class RemoteSignerError extends Error {
  readonly code: RemoteSignerErrorCode
  readonly operation?: string

  constructor(
    code: RemoteSignerErrorCode,
    message: string,
    options?: { cause?: unknown; operation?: string }
  ) {
    super(message, { cause: options?.cause })
    this.name = "RemoteSignerError"
    this.code = code
    this.operation = options?.operation
  }
}

export function requiresRemoteSignerSessionCleanup(error: unknown): boolean {
  return (
    error instanceof RemoteSignerError &&
    (error.code === "credential_unavailable" ||
      error.code === "invalid_response" ||
      error.code === "session_identity_mismatch")
  )
}

export interface Nip07AuthSession {
  version: typeof REMOTE_SIGNER_SESSION_VERSION
  type: "nip07"
  userPubkey: string
  authClaim?: string
}

export interface Nip46AuthSession {
  version: typeof REMOTE_SIGNER_SESSION_VERSION
  type: "nip46"
  clientKeyId: string
  remoteSignerPubkey: string
  relayUrls: string[]
  userPubkey: string
  createdAt: number
  updatedAt: number
  authClaim?: string
}

export type AuthSession = Nip07AuthSession | Nip46AuthSession

export interface AuthStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface RemoteBunkerSigner {
  bp: BunkerPointer
  sendRequest(
    method: string,
    params: string[],
    options?: Nip46RpcRequestOptions
  ): Promise<string | null>
  ping(options?: Nip46RpcRequestOptions): Promise<void>
  getPublicKey(options?: Nip46RpcRequestOptions): Promise<string>
  switchRelays(): Promise<boolean>
  signEvent(
    event: EventTemplate,
    options?: Nip46RpcRequestOptions
  ): Promise<VerifiedEvent>
  nip04Encrypt(
    pubkey: string,
    plaintext: string,
    options?: Nip46RpcRequestOptions
  ): Promise<string>
  nip04Decrypt(
    pubkey: string,
    ciphertext: string,
    options?: Nip46RpcRequestOptions
  ): Promise<string>
  nip44Encrypt(
    pubkey: string,
    plaintext: string,
    options?: Nip46RpcRequestOptions
  ): Promise<string>
  nip44Decrypt(
    pubkey: string,
    ciphertext: string,
    options?: Nip46RpcRequestOptions
  ): Promise<string>
  logout(options?: Nip46RpcRequestOptions): Promise<void>
  close(): Promise<void>
  resume?(): void
  hasPendingRequests?: () => boolean
  isTransportAvailable?: () => boolean
  onLifecycleFailure?: (
    listener: (failure: Nip46TransportError) => void
  ) => () => void
}

export type BunkerSignerFactory = (
  clientPrivateKey: Uint8Array,
  pointer: BunkerPointer,
  params: BunkerSignerParams
) => RemoteBunkerSigner

export type NostrConnectSignerFactory = (
  clientPrivateKey: Uint8Array,
  uri: string,
  params: BunkerSignerParams,
  signal: AbortSignal
) => Promise<RemoteBunkerSigner>

export interface RemoteSignerTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface RemoteSignerDependencies {
  createBunkerSigner?: BunkerSignerFactory
  generateClientPrivateKey?: () => Uint8Array
  timers?: RemoteSignerTimers
  now?: () => number
}

export type RemoteSignerAdapterInvalidation =
  | Readonly<{
      type: "permanently_unusable"
      reason: "request_timeout"
      source: NdkBunkerSignerAdapter
      sessionDisposition: "retain_for_restore"
      error: RemoteSignerError
    }>
  | Readonly<{
      type: "permanently_unusable"
      reason: "transport_unavailable"
      source: NdkBunkerSignerAdapter
      sessionDisposition: "retain_for_restore"
      error: RemoteSignerError
    }>
  | Readonly<{
      type: "permanently_unusable"
      reason: "integrity_failure"
      source: NdkBunkerSignerAdapter
      sessionDisposition: "discard"
      error: RemoteSignerError
    }>

export interface RemoteSignerOptions extends RemoteSignerDependencies {
  timeoutMs?: number
  onAuthUrl?: (url: string) => void
  onAdapterInvalidated?: (transition: RemoteSignerAdapterInvalidation) => void
  keyVault?: RemoteSignerKeyVault
  authStorage?: AuthStorage
  signal?: AbortSignal
}

export interface PairRemoteSignerOptions extends RemoteSignerOptions {
  clientMetadata?: ClientMetadata
}

export interface PairNostrConnectSignerOptions extends PairRemoteSignerOptions {
  generatePairingSecret?: () => string
  createNostrConnectSigner?: NostrConnectSignerFactory
  onNostrConnectUri?: (uri: string) => void
}

export interface RemoteSignerConnection {
  session: Nip46AuthSession
  bunkerSigner: RemoteBunkerSigner
  signer: NdkBunkerSignerAdapter
  clientPrivateKey: string
  clientKeyAlreadyPersisted: boolean
}

export async function verifyRemoteSignerConnection(
  connection: RemoteSignerConnection,
  options: RemoteSignerOptions = {}
): Promise<void> {
  connection.bunkerSigner.resume?.()
  const actualPubkey = requireUserPubkey(
    await withRemoteSignerTimeout(
      "resume identity",
      (signal) => connection.bunkerSigner.getPublicKey({ signal }),
      options
    ),
    "resume identity"
  )
  if (actualPubkey !== connection.session.userPubkey) {
    throw new RemoteSignerError(
      "session_identity_mismatch",
      "The remote signer returned a different account. Sign in again.",
      { operation: "resume identity" }
    )
  }
}

const defaultTimers: RemoteSignerTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function isHexKey(value: unknown): value is string {
  return typeof value === "string" && HEX_KEY_PATTERN.test(value)
}

function isRelayUrl(value: unknown): value is string {
  if (typeof value !== "string") return false

  try {
    return new URL(value).protocol === "wss:"
  } catch {
    return false
  }
}

function getDefaultStorage(): AuthStorage | undefined {
  if (typeof window === "undefined") return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function parseBunkerUri(uri: string): BunkerPointer {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch (cause) {
    throw new RemoteSignerError(
      "invalid_uri",
      "Enter a valid bunker:// connection URI.",
      { cause }
    )
  }

  const remoteSignerPubkey = parsed.hostname.toLowerCase()
  const relayUrls = parsed.searchParams.getAll("relay")
  if (
    parsed.protocol !== "bunker:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.hash !== "" ||
    !isHexKey(remoteSignerPubkey) ||
    relayUrls.length === 0 ||
    !relayUrls.every(isRelayUrl)
  ) {
    throw new RemoteSignerError(
      "invalid_uri",
      "Enter a bunker:// URI with a signer pubkey and at least one secure relay URL."
    )
  }

  return {
    pubkey: remoteSignerPubkey,
    relays: [...new Set(relayUrls)],
    secret: parsed.searchParams.get("secret"),
  }
}

export function parseAuthSession(raw: string | null): AuthSession | null {
  if (raw === null) return null

  const legacyPubkey = raw.toLowerCase()
  if (isHexKey(legacyPubkey)) {
    return {
      version: REMOTE_SIGNER_SESSION_VERSION,
      type: "nip07",
      userPubkey: legacyPubkey,
    }
  }

  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "object" || value === null) return null
    const record = value as Record<string, unknown>
    if (record.version !== REMOTE_SIGNER_SESSION_VERSION) return null

    if (record.type === "nip07" && isHexKey(record.userPubkey)) {
      return {
        version: REMOTE_SIGNER_SESSION_VERSION,
        type: "nip07",
        userPubkey: record.userPubkey,
        ...(typeof record.authClaim === "string"
          ? { authClaim: record.authClaim }
          : {}),
      }
    }

    if (
      record.type === "nip46" &&
      typeof record.clientKeyId === "string" &&
      record.clientKeyId.length >= 16 &&
      isHexKey(record.remoteSignerPubkey) &&
      Array.isArray(record.relayUrls) &&
      record.relayUrls.length > 0 &&
      record.relayUrls.every(isRelayUrl) &&
      isHexKey(record.userPubkey) &&
      typeof record.createdAt === "number" &&
      Number.isFinite(record.createdAt) &&
      typeof record.updatedAt === "number" &&
      Number.isFinite(record.updatedAt)
    ) {
      return {
        version: REMOTE_SIGNER_SESSION_VERSION,
        type: "nip46",
        clientKeyId: record.clientKeyId,
        remoteSignerPubkey: record.remoteSignerPubkey,
        relayUrls: [...new Set(record.relayUrls as string[])],
        userPubkey: record.userPubkey,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(typeof record.authClaim === "string"
          ? { authClaim: record.authClaim }
          : {}),
      }
    }
  } catch {
    return null
  }

  return null
}

function getAuthSessionRevocationStorageKey(session: AuthSession): string {
  const identity =
    session.type === "nip46"
      ? {
          version: session.version,
          type: session.type,
          clientKeyId: session.clientKeyId,
          remoteSignerPubkey: session.remoteSignerPubkey,
          userPubkey: session.userPubkey,
        }
      : {
          version: session.version,
          type: session.type,
          userPubkey: session.userPubkey,
          authClaim: session.authClaim ?? null,
        }
  const digest = bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify(identity)))
  )
  return `${AUTH_SESSION_REVOCATION_STORAGE_PREFIX}${digest}`
}

export function isAuthSessionRevoked(
  session: AuthSession,
  storage: AuthStorage | undefined = getDefaultStorage()
): boolean {
  if (!storage) return false
  try {
    return storage.getItem(getAuthSessionRevocationStorageKey(session)) === "1"
  } catch {
    return true
  }
}

export function markAuthSessionRevoked(
  session: AuthSession,
  storage: AuthStorage | undefined = getDefaultStorage()
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
  storage: AuthStorage | undefined = getDefaultStorage()
): AuthSession | null {
  if (!storage) return null
  try {
    const session = parseAuthSession(storage.getItem(AUTH_STORAGE_KEY))
    return session && !isAuthSessionRevoked(session, storage) ? session : null
  } catch {
    return null
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
    throw new RemoteSignerError(
      "unavailable",
      "The browser could not verify the saved signer session.",
      { operation }
    )
  }

  let raw: string | null
  try {
    raw = storage.getItem(AUTH_STORAGE_KEY)
  } catch (cause) {
    throw new RemoteSignerError(
      "unavailable",
      "The browser could not verify the saved signer session.",
      { cause, operation }
    )
  }
  if (raw === null) return { status: "empty" }

  const session = parseAuthSession(raw)
  return session ? { status: "session", session } : { status: "invalid" }
}

function authSessionsMatch(left: AuthSession, right: AuthSession): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function shouldRetireAuthSessionAfterAuthorityChange(
  invalidatedSession: AuthSession | null,
  storedSession: AuthSession | null
): boolean {
  return (
    invalidatedSession !== null &&
    (storedSession === null ||
      !authSessionsMatch(invalidatedSession, storedSession))
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
  storage: AuthStorage | undefined = getDefaultStorage()
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

function getDefaultKeyVault(): RemoteSignerKeyVault {
  return createBrowserRemoteSignerKeyVault()
}

export async function prepareRemoteSignerSessionStorage(
  keyVault: RemoteSignerKeyVault = getDefaultKeyVault()
): Promise<void> {
  try {
    await keyVault.prepare()
  } catch (error) {
    throw new RemoteSignerError(
      "unavailable",
      "Encrypted remote signer storage is unavailable. Open Conduit over HTTPS in an updated browser, then try again.",
      { cause: error, operation: "prepare session storage" }
    )
  }
}

function readAuthSessionForCleanup(
  storage: AuthStorage | undefined,
  operation: "persist session" | "rollback session"
): AuthSession | null {
  if (!storage) {
    throw new RemoteSignerError(
      "unavailable",
      "The browser could not verify the remote signer session before cleanup.",
      { operation }
    )
  }
  try {
    return parseAuthSession(storage.getItem(AUTH_STORAGE_KEY))
  } catch (cause) {
    throw new RemoteSignerError(
      "unavailable",
      "The browser could not verify the remote signer session before cleanup.",
      { cause, operation }
    )
  }
}

export async function persistRemoteSignerSession(
  connection: Pick<
    RemoteSignerConnection,
    "session" | "clientPrivateKey" | "clientKeyAlreadyPersisted"
  >,
  storage: AuthStorage | undefined = getDefaultStorage(),
  keyVault: RemoteSignerKeyVault = getDefaultKeyVault(),
  shouldCommit: () => boolean = () => true
): Promise<boolean> {
  const rollbackNewClientKey = async (): Promise<void> => {
    try {
      await keyVault.remove(connection.session.clientKeyId)
    } catch (cleanupError) {
      throw new RemoteSignerError(
        "unavailable",
        "The browser could not safely roll back the remote signer connection key.",
        { cause: cleanupError, operation: "persist session" }
      )
    }
  }
  const rollbackOwnedMetadata = (): void => {
    const current = readAuthSessionForCleanup(storage, "persist session")
    if (JSON.stringify(current) !== JSON.stringify(connection.session)) return
    if (!forgetAuthSession(storage)) {
      throw new RemoteSignerError(
        "unavailable",
        "The browser could not roll back the stale remote signer session.",
        { operation: "rollback session" }
      )
    }
  }
  if (!connection.clientKeyAlreadyPersisted) {
    try {
      await keyVault.store(
        connection.session.clientKeyId,
        connection.clientPrivateKey
      )
    } catch (error) {
      await rollbackNewClientKey()
      throw new RemoteSignerError(
        "unavailable",
        "This browser could not securely save the remote signer connection, so Conduit disconnected it. Check site storage permissions and try again over HTTPS.",
        { cause: error, operation: "persist session" }
      )
    }
  }
  if (!shouldCommit()) {
    if (!connection.clientKeyAlreadyPersisted) {
      await rollbackNewClientKey()
    }
    return false
  }
  if (writeAuthSession(connection.session, storage)) {
    if (shouldCommit()) return true
    rollbackOwnedMetadata()
    if (!connection.clientKeyAlreadyPersisted) {
      await rollbackNewClientKey()
    }
    return false
  }
  if (!connection.clientKeyAlreadyPersisted) {
    await rollbackNewClientKey()
  }
  return false
}

export async function rollbackNewRemoteSignerSession(
  connection: Pick<
    RemoteSignerConnection,
    "session" | "clientKeyAlreadyPersisted"
  >,
  storage: AuthStorage | undefined = getDefaultStorage(),
  keyVault: RemoteSignerKeyVault = getDefaultKeyVault()
): Promise<void> {
  if (connection.clientKeyAlreadyPersisted) return
  const current = readAuthSessionForCleanup(storage, "rollback session")
  if (JSON.stringify(current) === JSON.stringify(connection.session)) {
    if (!forgetAuthSession(storage)) {
      throw new RemoteSignerError(
        "unavailable",
        "The browser could not roll back the stale remote signer session.",
        { operation: "rollback session" }
      )
    }
  }
  try {
    await forgetRemoteSignerKey(connection.session, keyVault)
  } catch (cause) {
    throw new RemoteSignerError(
      "unavailable",
      "The browser could not safely roll back the remote signer connection key.",
      { cause, operation: "rollback session" }
    )
  }
}

export function abandonRemoteSignerConnection(
  connection: RemoteSignerConnection
): void {
  connection.signer.invalidate()
  if (connection.clientKeyAlreadyPersisted) {
    void closeRemoteSigner(connection.bunkerSigner)
    return
  }
  void logoutRemoteSigner(connection.bunkerSigner)
}

export async function rollbackAndAbandonRemoteSignerConnection(
  connection: RemoteSignerConnection,
  storage?: AuthStorage,
  keyVault?: RemoteSignerKeyVault
): Promise<void> {
  try {
    await rollbackNewRemoteSignerSession(connection, storage, keyVault)
  } finally {
    abandonRemoteSignerConnection(connection)
  }
}

export async function forgetRemoteSignerKey(
  session: Nip46AuthSession,
  keyVault: RemoteSignerKeyVault = getDefaultKeyVault()
): Promise<void> {
  await keyVault.remove(session.clientKeyId)
  if ((await keyVault.load(session.clientKeyId)) !== null) {
    throw new RemoteSignerError(
      "unavailable",
      "The browser could not verify that the remote signer connection key was erased.",
      { operation: "forget remote signer key" }
    )
  }
}

export type InvalidatedAuthSessionCleanupStatus =
  "removed" | "absent" | "replacement"

export interface InvalidatedAuthSessionCleanupOptions {
  storage?: AuthStorage
  keyVault?: RemoteSignerKeyVault
  withLock?: <T>(task: () => Promise<T>) => Promise<T>
  /** Explicit logout only, when the caller owns the exact expected session. */
  retireExpectedKeyOnMetadataFailure?: boolean
}

/**
 * Retire one invalidated session without deleting a concurrently installed
 * replacement. Metadata removal and key retirement are verified while the
 * shared browser auth lock is held.
 */
export async function cleanupInvalidatedAuthSession(
  expected: AuthSession,
  options: InvalidatedAuthSessionCleanupOptions = {}
): Promise<InvalidatedAuthSessionCleanupStatus> {
  const storage = options.storage ?? getDefaultStorage()
  const keyVault = options.keyVault ?? getDefaultKeyVault()
  const withLock = options.withLock ?? withBrowserAuthOperationLock

  return withLock(async () => {
    const operation = "retire invalidated signer session"
    let status: InvalidatedAuthSessionCleanupStatus = "absent"
    let metadataError: unknown = null
    let replacementUsesExpectedKey = false

    try {
      const before = inspectAuthSessionStorage(storage, operation)
      if (before.status === "empty") {
        status = "absent"
      } else if (
        before.status === "session" &&
        !authSessionsMatch(before.session, expected)
      ) {
        status = "replacement"
      } else {
        try {
          storage?.removeItem(AUTH_STORAGE_KEY)
        } catch (cause) {
          throw new RemoteSignerError(
            "unavailable",
            "The browser could not erase the invalidated signer session.",
            { cause, operation }
          )
        }

        const afterRemoval = inspectAuthSessionStorage(storage, operation)
        if (
          afterRemoval.status === "invalid" ||
          (afterRemoval.status === "session" &&
            authSessionsMatch(afterRemoval.session, expected))
        ) {
          throw new RemoteSignerError(
            "unavailable",
            "The browser could not verify that the invalidated signer session was erased.",
            { operation }
          )
        }
        status = afterRemoval.status === "session" ? "replacement" : "removed"
      }

      if (expected.type === "nip46") {
        const current = inspectAuthSessionStorage(storage, operation)
        replacementUsesExpectedKey =
          current.status === "session" &&
          !authSessionsMatch(current.session, expected) &&
          current.session.type === "nip46" &&
          current.session.clientKeyId === expected.clientKeyId
      }
    } catch (cause) {
      metadataError = cause
    }

    if (metadataError && !options.retireExpectedKeyOnMetadataFailure) {
      throw metadataError
    }

    if (expected.type === "nip46" && !replacementUsesExpectedKey) {
      try {
        await forgetRemoteSignerKey(expected, keyVault)
      } catch (cause) {
        throw new RemoteSignerError(
          "unavailable",
          "The browser could not erase the invalidated remote signer connection key.",
          { cause, operation }
        )
      }
    }

    if (metadataError) throw metadataError
    return status
  })
}

export function forgetAuthSession(
  storage: AuthStorage | undefined = getDefaultStorage()
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
  storage: AuthStorage | undefined = getDefaultStorage()
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
  sessionDisposition?: "retain_for_restore" | "discard"
}

/**
 * Acquire a fresh cross-tab authority claim and prove it was written. A caller
 * must not treat an older readable revision as its own when setItem() fails.
 */
export function claimAuthRevision(
  storage: AuthStorage | undefined = getDefaultStorage()
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
  storage: AuthStorage | undefined = getDefaultStorage(),
  options: AuthSessionAuthorityRevocationOptions = {}
): AuthSessionAuthorityRevocation {
  const claim = claimAuthRevision(storage)
  if (options.sessionDisposition !== "discard" && claim.persisted) {
    let sessionRetained = false
    try {
      const snapshot = inspectAuthSessionStorage(
        storage,
        "revoke signer authority"
      )
      sessionRetained =
        snapshot.status === "session" &&
        authSessionsMatch(snapshot.session, expected)
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
        !authSessionsMatch(before.session, expected))
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
        !authSessionsMatch(after.session, expected))
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
  storage: AuthStorage | undefined = getDefaultStorage()
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

function classifyRemoteSignerError(
  error: unknown,
  operation: string
): RemoteSignerError {
  if (error instanceof RemoteSignerError) return error
  if (error instanceof Nip46TransportError) {
    return new RemoteSignerError(
      error.code,
      error.code === "unsupported"
        ? `The remote signer does not support ${operation}.`
        : error.code === "rejected"
          ? `The remote signer rejected the ${operation} request.`
          : error.code === "invalid_response"
            ? `The remote signer returned an invalid response during ${operation}.`
            : `The remote signer is unavailable for ${operation}. Check the signer and relay connection.`,
      { cause: error, operation }
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/unsupported|unknown method|not implemented/i.test(message)) {
    return new RemoteSignerError(
      "unsupported",
      `The remote signer does not support ${operation}.`,
      { cause: error, operation }
    )
  }
  if (/reject|denied|declined|cancel|permission/i.test(message)) {
    return new RemoteSignerError(
      "rejected",
      `The remote signer rejected the ${operation} request.`,
      { cause: error, operation }
    )
  }
  return new RemoteSignerError(
    "unavailable",
    `The remote signer is unavailable for ${operation}. Check the signer and relay connection.`,
    { cause: error, operation }
  )
}

async function withRemoteSignerTimeout<T>(
  operation: string,
  task: (signal: AbortSignal) => Promise<T>,
  options: RemoteSignerOptions
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_SIGNER_TIMEOUT_MS
  const timers = options.timers ?? defaultTimers
  const controller = new AbortController()
  let handle: unknown
  let rejectAborted: ((error: RemoteSignerError) => void) | null = null
  const abort = () => {
    rejectAborted?.(
      new RemoteSignerError("rejected", "Remote signer pairing was canceled.", {
        operation,
      })
    )
    controller.abort()
  }
  if (options.signal?.aborted) {
    throw new RemoteSignerError(
      "rejected",
      "Remote signer pairing was canceled.",
      { operation }
    )
  }
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
  })
  const timeout = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(() => {
      const timeoutError = new RemoteSignerError(
        "timeout",
        `The remote signer timed out during ${operation}. Try again or check its relay connection.`,
        { operation }
      )
      reject(timeoutError)
      controller.abort()
    }, timeoutMs)
  })

  try {
    return await Promise.race([task(controller.signal), timeout, aborted])
  } catch (error) {
    throw classifyRemoteSignerError(error, operation)
  } finally {
    if (handle !== undefined) timers.clearTimeout(handle)
    options.signal?.removeEventListener("abort", abort)
    controller.abort()
    rejectAborted = null
  }
}

function createBunkerSigner(
  clientPrivateKey: Uint8Array,
  pointer: BunkerPointer,
  options: RemoteSignerOptions
): RemoteBunkerSigner {
  const factory =
    options.createBunkerSigner ??
    ((key, bunkerPointer, params) =>
      new ConduitNip46Signer(key, bunkerPointer, params))
  try {
    return factory(clientPrivateKey, pointer, { onauth: options.onAuthUrl })
  } catch (error) {
    throw classifyRemoteSignerError(error, "session setup")
  }
}

function requireUserPubkey(pubkey: string, operation: string): string {
  const normalized = pubkey.toLowerCase()
  if (!isHexKey(normalized)) {
    throw new RemoteSignerError(
      "invalid_response",
      `The remote signer returned an invalid user pubkey during ${operation}.`,
      { operation }
    )
  }
  return normalized
}

function requireRemoteSignerPubkey(pubkey: string, operation: string): string {
  const normalized = pubkey.toLowerCase()
  if (!isHexKey(normalized)) {
    throw new RemoteSignerError(
      "invalid_response",
      "The remote signer returned an invalid signer pubkey.",
      { operation }
    )
  }
  return normalized
}

// Remote signer sessions retain this already-connected relay set. nostr-tools
// relay migration cannot be canceled and may mutate after a local timeout.
function requireSignerRelayUrls(
  bunkerSigner: RemoteBunkerSigner,
  operation: string
): string[] {
  const relayUrls = bunkerSigner.bp.relays
  if (relayUrls.length === 0 || !relayUrls.every(isRelayUrl)) {
    throw new RemoteSignerError(
      "invalid_response",
      "The remote signer returned an invalid secure relay list.",
      { operation }
    )
  }
  return [...new Set(relayUrls)]
}

function createRemoteSignerConnection(
  bunkerSigner: RemoteBunkerSigner,
  clientPrivateKey: Uint8Array,
  remoteSignerPubkey: string,
  relayUrls: string[],
  userPubkey: string,
  options: RemoteSignerOptions,
  existingSession?: Nip46AuthSession
): RemoteSignerConnection {
  if (bunkerSigner.isTransportAvailable?.() === false) {
    throw new RemoteSignerError(
      "unavailable",
      "The remote signer transport closed before the session became active.",
      { operation: "session setup" }
    )
  }
  const now = (options.now ?? Date.now)()
  const session: Nip46AuthSession = existingSession ?? {
    version: REMOTE_SIGNER_SESSION_VERSION,
    type: "nip46",
    clientKeyId: generateId(),
    remoteSignerPubkey,
    relayUrls,
    userPubkey,
    createdAt: now,
    updatedAt: now,
  }
  const signer = new NdkBunkerSignerAdapter(bunkerSigner, userPubkey, options)
  // A transport can close after the last identity response settles but before
  // the adapter subscribes to lifecycle failures. Never install that gap as a
  // connected session.
  signer.assertUsable()
  return {
    session,
    bunkerSigner,
    signer,
    clientPrivateKey: bytesToHex(clientPrivateKey),
    clientKeyAlreadyPersisted: existingSession !== undefined,
  }
}

export async function pairRemoteSigner(
  uri: string,
  options: PairRemoteSignerOptions = {}
): Promise<RemoteSignerConnection> {
  const pointer = parseBunkerUri(uri)
  await prepareRemoteSignerSessionStorage(options.keyVault)
  const clientPrivateKey = (
    options.generateClientPrivateKey ?? generateSecretKey
  )()
  if (clientPrivateKey.length !== 32) {
    throw new RemoteSignerError(
      "unavailable",
      "Unable to generate a valid local NIP-46 client key."
    )
  }
  const bunkerSigner = createBunkerSigner(clientPrivateKey, pointer, options)
  let connected = false

  try {
    const connectParams = [pointer.pubkey, pointer.secret ?? ""]
    if (options.clientMetadata) {
      connectParams.push("", JSON.stringify(options.clientMetadata))
    }
    const connectResult = await withRemoteSignerTimeout(
      "connect",
      (signal) =>
        bunkerSigner.sendRequest("connect", connectParams, { signal }),
      {
        ...options,
        timeoutMs: options.timeoutMs ?? DEFAULT_REMOTE_SIGNER_PAIR_TIMEOUT_MS,
      }
    )
    if (
      connectResult !== "ack" &&
      (!pointer.secret || connectResult !== pointer.secret)
    ) {
      throw new RemoteSignerError(
        "invalid_response",
        "The remote signer returned an invalid connection acknowledgement.",
        { operation: "connect" }
      )
    }
    connected = true
    const relayUrls = requireSignerRelayUrls(bunkerSigner, "session setup")
    const userPubkey = requireUserPubkey(
      await withRemoteSignerTimeout(
        "get public key",
        (signal) => bunkerSigner.getPublicKey({ signal }),
        options
      ),
      "get public key"
    )
    return createRemoteSignerConnection(
      bunkerSigner,
      clientPrivateKey,
      pointer.pubkey,
      relayUrls,
      userPubkey,
      options
    )
  } catch (error) {
    if (connected) {
      await logoutRemoteSigner(bunkerSigner, options)
    } else {
      await closeRemoteSigner(bunkerSigner, options)
    }
    throw error
  }
}

async function listenForNostrConnectSigner(
  clientPrivateKey: Uint8Array,
  uri: string,
  options: PairNostrConnectSignerOptions
): Promise<RemoteBunkerSigner> {
  const operation = "nostrconnect pairing"
  const controller = new AbortController()
  const timers = options.timers ?? defaultTimers
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_SIGNER_PAIR_TIMEOUT_MS
  const now = options.now ?? Date.now
  const deadline = now() + timeoutMs
  const foreground = typeof document === "undefined" ? null : document
  let timedOut = false
  let completed = false
  let resumeListener: (() => void) | undefined
  const onReturn = () => {
    if (foreground?.visibilityState !== "visible") return
    if (now() >= deadline) {
      timedOut = true
      controller.abort()
    } else {
      resumeListener?.()
    }
  }
  const abortFromCaller = () => controller.abort()
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          new RemoteSignerError(
            timedOut ? "timeout" : "rejected",
            timedOut
              ? "Remote signer pairing timed out. Start a new pairing attempt."
              : "Remote signer pairing was canceled.",
            { operation }
          )
        ),
      { once: true }
    )
  })
  options.signal?.addEventListener("abort", abortFromCaller, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timeoutHandle = timers.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const factory =
    options.createNostrConnectSigner ??
    ((key, connectionUri, params, signal) =>
      BunkerSigner.fromURI(key, connectionUri, params, signal))
  foreground?.addEventListener("visibilitychange", onReturn)

  try {
    // The live approval is ephemeral. Renew only the listener, never the pending
    // key/secret/URI or its deadline. "Open again" can request a fresh approval.
    while (!controller.signal.aborted) {
      const pool = new SimplePool()
      const listener = new AbortController()
      const abortListener = () => listener.abort()
      controller.signal.addEventListener("abort", abortListener, { once: true })
      let retryHandle: unknown
      const resume = new Promise<null>((resolve) => {
        resumeListener = () => resolve(null)
      })

      try {
        const pending = factory(
          clientPrivateKey,
          uri,
          { onauth: options.onAuthUrl, skipSwitchRelays: true, pool },
          listener.signal
        ).then(async (signer) => {
          const close = signer.close.bind(signer)
          signer.close = async () => {
            try {
              await close()
            } finally {
              pool.destroy()
            }
          }
          if (listener.signal.aborted) {
            // Never logout a superseded listener: its key may now belong to
            // the winning listener for this same pairing.
            await closeRemoteSigner(signer, { ...options, signal: undefined })
            return null
          }
          return signer
        })
        const signer = await Promise.race([pending, resume, aborted])
        if (!signer) continue
        completed = true
        return signer
      } catch (error) {
        if (
          controller.signal.aborted ||
          !(error instanceof Error) ||
          error.message !==
            "subscription closed before connection was established."
        ) {
          throw error
        }
        // Bound retries by the original deadline and avoid a closed-relay loop.
        // Foreground return can wake this wait immediately.
        retryHandle = timers.setTimeout(() => resumeListener?.(), 1_000)
        await Promise.race([resume, aborted])
      } finally {
        resumeListener = undefined
        if (retryHandle !== undefined) timers.clearTimeout(retryHandle)
        controller.signal.removeEventListener("abort", abortListener)
        if (!completed) {
          listener.abort()
          pool.destroy()
        }
      }
    }
    return await aborted
  } catch (error) {
    throw classifyRemoteSignerError(error, operation)
  } finally {
    timers.clearTimeout(timeoutHandle)
    foreground?.removeEventListener("visibilitychange", onReturn)
    options.signal?.removeEventListener("abort", abortFromCaller)
    if (!completed) controller.abort()
  }
}

export async function pairRemoteSignerFromNostrConnect(
  relayUrls: readonly string[],
  options: PairNostrConnectSignerOptions = {}
): Promise<RemoteSignerConnection> {
  const pairingRelayUrls = [...new Set(relayUrls)]
  if (
    pairingRelayUrls.length < 2 ||
    pairingRelayUrls.length > 3 ||
    !pairingRelayUrls.every(isRelayUrl)
  ) {
    throw new RemoteSignerError(
      "invalid_uri",
      "Nostr Connect pairing requires two to three secure relay URLs."
    )
  }

  await prepareRemoteSignerSessionStorage(options.keyVault)
  if (options.signal?.aborted) {
    throw new RemoteSignerError(
      "rejected",
      "Remote signer pairing was canceled.",
      { operation: "nostrconnect pairing" }
    )
  }
  const clientPrivateKey = (
    options.generateClientPrivateKey ?? generateSecretKey
  )()
  if (clientPrivateKey.length !== 32) {
    throw new RemoteSignerError(
      "unavailable",
      "Unable to generate a valid local NIP-46 client key."
    )
  }
  const secret =
    options.generatePairingSecret?.() ?? bytesToHex(generateSecretKey())
  if (!secret) {
    throw new RemoteSignerError(
      "unavailable",
      "Unable to generate a valid one-use NIP-46 pairing secret."
    )
  }
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientPrivateKey),
    relays: pairingRelayUrls,
    secret,
    perms: [...CONDUIT_NIP46_PERMISSIONS],
    ...options.clientMetadata,
  })
  options.onNostrConnectUri?.(uri)

  let bunkerSigner: RemoteBunkerSigner | null = null
  try {
    bunkerSigner = await listenForNostrConnectSigner(
      clientPrivateKey,
      uri,
      options
    )
    const remoteSignerPubkey = requireRemoteSignerPubkey(
      bunkerSigner.bp.pubkey,
      "nostrconnect pairing"
    )
    const connectedRelayUrls = requireSignerRelayUrls(
      bunkerSigner,
      "nostrconnect pairing"
    )
    bunkerSigner.bp.secret = null
    // The upstream signer is retained only for the one-use nostrconnect
    // handshake. Established requests always move to Conduit's owned lifecycle
    // (or its injected equivalent) so close, timeout, malformed/null response,
    // and relay loss are observable through the same transport as bunker pairs.
    const handshakeSigner = bunkerSigner
    await closeRemoteSigner(handshakeSigner, {
      ...options,
      signal: undefined,
    })
    bunkerSigner = null
    bunkerSigner = createBunkerSigner(
      clientPrivateKey,
      {
        pubkey: remoteSignerPubkey,
        relays: connectedRelayUrls,
        secret: null,
      },
      options
    )
    const userPubkey = requireUserPubkey(
      await withRemoteSignerTimeout(
        "get public key",
        (signal) => bunkerSigner!.getPublicKey({ signal }),
        options
      ),
      "get public key"
    )
    return createRemoteSignerConnection(
      bunkerSigner,
      clientPrivateKey,
      remoteSignerPubkey,
      connectedRelayUrls,
      userPubkey,
      options
    )
  } catch (error) {
    if (bunkerSigner) await logoutRemoteSigner(bunkerSigner, options)
    throw error
  }
}

export async function restoreRemoteSigner(
  session: Nip46AuthSession,
  options: RemoteSignerOptions = {}
): Promise<RemoteSignerConnection> {
  const parsed = parseAuthSession(JSON.stringify(session))
  if (!parsed || parsed.type !== "nip46") {
    throw new RemoteSignerError(
      "credential_unavailable",
      "The saved remote signer session is invalid. Sign in again.",
      { operation: "load saved session" }
    )
  }
  if (
    isAuthSessionRevoked(parsed, options.authStorage ?? getDefaultStorage())
  ) {
    throw new RemoteSignerError(
      "credential_unavailable",
      "The saved remote signer session was revoked. Connect the signer again.",
      { operation: "load saved session" }
    )
  }
  let clientPrivateKey: string | null
  try {
    clientPrivateKey = await (options.keyVault ?? getDefaultKeyVault()).load(
      parsed.clientKeyId
    )
  } catch (cause) {
    throw new RemoteSignerError(
      "credential_unavailable",
      "The saved remote signer key could not be read. Connect the signer again.",
      { cause, operation: "load saved credential" }
    )
  }
  if (!clientPrivateKey || !isHexKey(clientPrivateKey)) {
    throw new RemoteSignerError(
      "credential_unavailable",
      "The saved remote signer key is unavailable. Connect the signer again.",
      { operation: "load saved credential" }
    )
  }
  const bunkerSigner = createBunkerSigner(
    hexToBytes(clientPrivateKey),
    {
      pubkey: parsed.remoteSignerPubkey,
      relays: parsed.relayUrls,
      secret: null,
    },
    options
  )

  try {
    await withRemoteSignerTimeout(
      "restore ping",
      (signal) => bunkerSigner.ping({ signal }),
      options
    )
    const relayUrls = requireSignerRelayUrls(bunkerSigner, "restore session")
    const actualPubkey = requireUserPubkey(
      await withRemoteSignerTimeout(
        "restore identity",
        (signal) => bunkerSigner.getPublicKey({ signal }),
        options
      ),
      "restore identity"
    )
    if (actualPubkey !== parsed.userPubkey) {
      throw new RemoteSignerError(
        "session_identity_mismatch",
        "The remote signer returned a different account. Sign in again.",
        { operation: "restore identity" }
      )
    }
    const restoredSession = {
      ...parsed,
      relayUrls,
      updatedAt: (options.now ?? Date.now)(),
    }
    return createRemoteSignerConnection(
      bunkerSigner,
      hexToBytes(clientPrivateKey),
      parsed.remoteSignerPubkey,
      relayUrls,
      actualPubkey,
      options,
      restoredSession
    )
  } catch (error) {
    await closeRemoteSigner(bunkerSigner, options)
    throw error
  }
}

async function closeRemoteSigner(
  bunkerSigner: Pick<RemoteBunkerSigner, "close">,
  options: RemoteSignerOptions = {}
): Promise<void> {
  await withRemoteSignerTimeout("close", () => bunkerSigner.close(), {
    ...options,
    signal: undefined,
    timeoutMs: Math.min(options.timeoutMs ?? 5_000, 5_000),
  }).catch(() => undefined)
}

export async function logoutRemoteSigner(
  bunkerSigner: Pick<RemoteBunkerSigner, "logout" | "close">,
  options: RemoteSignerOptions = {}
): Promise<void> {
  try {
    await withRemoteSignerTimeout(
      "logout",
      (signal) => bunkerSigner.logout({ signal }),
      options
    )
  } catch {
    // Logout is advisory. The caller can always erase the persisted client key.
  } finally {
    await closeRemoteSigner(bunkerSigner, options)
  }
}

export class NdkBunkerSignerAdapter implements NDKSigner {
  readonly pubkey: string
  private readonly ndkUser: NDKUser
  private removeTransportFailureListener: (() => void) | null = null
  private verificationGeneration = 0
  private activeRequestCount = 0
  private readonly idleWaiters = new Set<() => void>()
  private lifecycle:
    | { state: "active" }
    | { state: "draining" }
    | { state: "verifying" }
    | { state: "disposed" }
    | {
        state: "permanently_unusable"
        transition: RemoteSignerAdapterInvalidation
        closePromise: Promise<void>
      } = { state: "active" }

  constructor(
    private readonly bunkerSigner: RemoteBunkerSigner,
    userPubkey: string,
    private readonly options: RemoteSignerOptions = {}
  ) {
    this.pubkey = requireUserPubkey(userPubkey, "adapter setup")
    this.ndkUser = new NDKUser({ pubkey: this.pubkey })
    this.removeTransportFailureListener =
      this.bunkerSigner.onLifecycleFailure?.((failure) => {
        const error = classifyRemoteSignerError(failure, "transport lifecycle")
        void this.invalidateAfterFailure(error, "transport_unavailable")
      }) ?? null
  }

  get userSync(): NDKUser {
    return this.ndkUser
  }

  async blockUntilReady(): Promise<NDKUser> {
    return this.ndkUser
  }

  async user(): Promise<NDKUser> {
    return this.ndkUser
  }

  invalidate(): void {
    if (
      this.lifecycle.state === "active" ||
      this.lifecycle.state === "draining" ||
      this.lifecycle.state === "verifying"
    ) {
      this.removeTransportFailureListener?.()
      this.removeTransportFailureListener = null
      this.lifecycle = { state: "disposed" }
    }
  }

  beginVerification(): boolean {
    if (
      this.lifecycle.state === "active" ||
      this.lifecycle.state === "draining" ||
      this.lifecycle.state === "verifying"
    ) {
      this.verificationGeneration += 1
      this.lifecycle = { state: "verifying" }
      return true
    }
    return false
  }

  beginDraining(): boolean {
    if (this.lifecycle.state === "active") {
      this.lifecycle = { state: "draining" }
    }
    return this.lifecycle.state === "draining"
  }

  hasPendingRequests(): boolean {
    return this.activeRequestCount > 0
  }

  whenIdle(): Promise<void> {
    if (this.activeRequestCount === 0) return Promise.resolve()
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve)
    })
  }

  completeVerification(): boolean {
    if (this.lifecycle.state !== "verifying") return false
    this.lifecycle = { state: "active" }
    return true
  }

  assertUsable(): void {
    if (
      this.lifecycle.state !== "active" ||
      this.bunkerSigner.isTransportAvailable?.() === false
    ) {
      throw this.unavailableError(
        "session setup",
        "The remote signer session became unavailable before setup completed."
      )
    }
  }

  async failVerification(error: unknown): Promise<void> {
    const remoteError = classifyRemoteSignerError(error, "resume identity")
    await this.invalidateAfterFailure(remoteError, "transport_unavailable")
  }

  private unavailableError(
    operation: string,
    message: string
  ): RemoteSignerError {
    return new RemoteSignerError("unavailable", message, {
      cause:
        this.lifecycle.state === "permanently_unusable"
          ? this.lifecycle.transition.error
          : undefined,
      operation,
    })
  }

  private transitionToPermanentlyUnusable(
    transition:
      | Omit<
          Extract<
            RemoteSignerAdapterInvalidation,
            { reason: "request_timeout" }
          >,
          "source"
        >
      | Omit<
          Extract<
            RemoteSignerAdapterInvalidation,
            { reason: "integrity_failure" }
          >,
          "source"
        >
      | Omit<
          Extract<
            RemoteSignerAdapterInvalidation,
            { reason: "transport_unavailable" }
          >,
          "source"
        >
  ): Promise<void> | null {
    if (
      this.lifecycle.state !== "active" &&
      this.lifecycle.state !== "draining" &&
      this.lifecycle.state !== "verifying"
    ) {
      return null
    }

    this.removeTransportFailureListener?.()
    this.removeTransportFailureListener = null
    const lifecycleTransition = {
      ...transition,
      source: this,
    } as RemoteSignerAdapterInvalidation
    const closePromise = closeRemoteSigner(this.bunkerSigner, this.options)
    this.lifecycle = {
      state: "permanently_unusable",
      transition: lifecycleTransition,
      closePromise,
    }

    try {
      this.options.onAdapterInvalidated?.(lifecycleTransition)
    } catch {
      // Auth/UI callbacks cannot replace the first causal signer failure.
    }

    return closePromise
  }

  private waitForInvalidationClose(): Promise<void> {
    return this.lifecycle.state === "permanently_unusable"
      ? this.lifecycle.closePromise
      : Promise.resolve()
  }

  private async invalidateAfterFailure(
    error: RemoteSignerError,
    recoverableReason: Extract<
      RemoteSignerAdapterInvalidation,
      { sessionDisposition: "retain_for_restore" }
    >["reason"] = error.code === "timeout"
      ? "request_timeout"
      : "transport_unavailable"
  ): Promise<void> {
    const transition =
      error.code === "invalid_response" ||
      error.code === "session_identity_mismatch"
        ? ({
            type: "permanently_unusable",
            reason: "integrity_failure",
            sessionDisposition: "discard",
            error,
          } as const)
        : recoverableReason === "request_timeout"
          ? ({
              type: "permanently_unusable",
              reason: "request_timeout",
              sessionDisposition: "retain_for_restore",
              error,
            } as const)
          : ({
              type: "permanently_unusable",
              reason: "transport_unavailable",
              sessionDisposition: "retain_for_restore",
              error,
            } as const)
    const closePromise = this.transitionToPermanentlyUnusable(transition)
    await (closePromise ?? this.waitForInvalidationClose())
  }

  private canCompleteStartedRequest(): boolean {
    return (
      this.lifecycle.state === "active" || this.lifecycle.state === "draining"
    )
  }

  private async request<T>(
    operation: string,
    task: (signal: AbortSignal, assertRequestCurrent: () => void) => Promise<T>
  ): Promise<T> {
    if (this.lifecycle.state !== "active") {
      throw this.unavailableError(
        operation,
        "The remote signer session is unavailable. Reconnect it and try again."
      )
    }
    const requestVerificationGeneration = this.verificationGeneration
    const assertRequestCurrent = () => {
      if (
        !this.canCompleteStartedRequest() ||
        this.verificationGeneration !== requestVerificationGeneration
      ) {
        throw this.unavailableError(
          operation,
          "The remote signer session changed before the request completed."
        )
      }
    }
    this.activeRequestCount += 1
    try {
      const result = await withRemoteSignerTimeout(
        operation,
        (signal) => task(signal, assertRequestCurrent),
        this.options
      )
      assertRequestCurrent()
      return result
    } catch (error) {
      const remoteError = classifyRemoteSignerError(error, operation)
      // Foreground/online verification deliberately fences an ambiguous
      // in-flight action before proving the route and exact account again.
      // That action must fail, but it must not tear down the verification
      // request that is making the same established transport usable again.
      if (this.verificationGeneration !== requestVerificationGeneration) {
        throw remoteError
      }
      if (
        remoteError.code === "timeout" ||
        remoteError.code === "unavailable" ||
        remoteError.code === "invalid_response" ||
        remoteError.code === "session_identity_mismatch"
      ) {
        await this.invalidateAfterFailure(remoteError)
      }
      throw remoteError
    } finally {
      this.activeRequestCount -= 1
      if (this.activeRequestCount === 0) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  async sign(event: NostrEvent): Promise<string> {
    const { kind, created_at: createdAt } = event
    if (
      kind === undefined ||
      createdAt === undefined ||
      (event.pubkey && event.pubkey !== this.pubkey)
    ) {
      throw new RemoteSignerError(
        "unavailable",
        "The event is missing required fields or uses a different account and cannot be signed.",
        { operation: "sign event" }
      )
    }
    const expectedContent = event.content
    const expectedTags = event.tags.map((tag) => [...tag])
    return this.request("sign event", async (signal, assertRequestCurrent) => {
      const signed = await this.bunkerSigner.signEvent(
        {
          kind,
          content: expectedContent,
          tags: expectedTags.map((tag) => [...tag]),
          created_at: createdAt,
        },
        { signal }
      )
      assertRequestCurrent()
      if (
        signed.pubkey !== this.pubkey ||
        signed.kind !== kind ||
        signed.created_at !== createdAt ||
        signed.content !== expectedContent ||
        JSON.stringify(signed.tags) !== JSON.stringify(expectedTags)
      ) {
        return this.rejectSignerIntegrityFailure(
          new RemoteSignerError(
            signed.pubkey !== this.pubkey
              ? "session_identity_mismatch"
              : "invalid_response",
            signed.pubkey !== this.pubkey
              ? "The remote signer signed with a different account. Sign in again."
              : "The remote signer returned a changed event. The signature was not accepted.",
            { operation: "sign event" }
          )
        )
      }
      if (!isValidSignedPublicNostrEvent(signed as SignedPublicNostrEvent)) {
        return this.rejectSignerIntegrityFailure(
          new RemoteSignerError(
            "invalid_response",
            "The remote signer returned an invalid signature. The event was not accepted.",
            { operation: "sign event" }
          )
        )
      }
      return signed.sig
    })
  }

  private async rejectSignerIntegrityFailure(
    error: RemoteSignerError
  ): Promise<never> {
    await this.invalidateAfterFailure(error)
    throw error
  }

  async encryptionEnabled(
    scheme?: NDKEncryptionScheme
  ): Promise<NDKEncryptionScheme[]> {
    return scheme ? [scheme] : ["nip04", "nip44"]
  }

  async encrypt(
    recipient: NDKUser,
    value: string,
    scheme: NDKEncryptionScheme = "nip04"
  ): Promise<string> {
    return this.request(`${scheme} encrypt`, (signal) =>
      scheme === "nip44"
        ? this.bunkerSigner.nip44Encrypt(recipient.pubkey, value, { signal })
        : this.bunkerSigner.nip04Encrypt(recipient.pubkey, value, { signal })
    )
  }

  async decrypt(
    sender: NDKUser,
    value: string,
    scheme: NDKEncryptionScheme = "nip04"
  ): Promise<string> {
    return this.request(`${scheme} decrypt`, (signal) =>
      scheme === "nip44"
        ? this.bunkerSigner.nip44Decrypt(sender.pubkey, value, { signal })
        : this.bunkerSigner.nip04Decrypt(sender.pubkey, value, { signal })
    )
  }

  toPayload(): string {
    throw new RemoteSignerError(
      "unavailable",
      "Use the versioned Conduit auth session helpers to persist this signer."
    )
  }
}

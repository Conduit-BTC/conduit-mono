import {
  AUTH_SESSION_VERSION,
  AUTH_STORAGE_KEY,
  forgetAuthSession,
  getDefaultAuthStorage,
  isAuthSessionRevoked,
  parseAuthSession,
  writeAuthSession,
  type AuthSession,
  type AuthStorage,
} from "./auth-session"
import type { Nip46AuthSession } from "./nip46-auth-session"
import type {
  AccountSignerCapabilities,
  NostrKeySigner,
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "./nostr-event-signer"
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

export interface RemoteBunkerSigner {
  bp: BunkerPointer
  sendRequest(
    method: string,
    params: string[],
    options?: Nip46RpcRequestOptions
  ): Promise<string | null>
  ping(options?: Nip46RpcRequestOptions): Promise<void>
  getPublicKey(options?: Nip46RpcRequestOptions): Promise<string>
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
      source: RemoteSessionSigner
      sessionDisposition: "retain_for_restore"
      error: RemoteSignerError
    }>
  | Readonly<{
      type: "permanently_unusable"
      reason: "transport_unavailable"
      source: RemoteSessionSigner
      sessionDisposition: "retain_for_restore"
      error: RemoteSignerError
    }>
  | Readonly<{
      type: "permanently_unusable"
      reason: "integrity_failure"
      source: RemoteSessionSigner
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
  signer: RemoteSessionSigner
  clientPrivateKey: string
  clientKeyAlreadyPersisted: boolean
  previousBunkerSigner?: RemoteBunkerSigner
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
  storage: AuthStorage | undefined = getDefaultAuthStorage(),
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
  storage: AuthStorage | undefined = getDefaultAuthStorage(),
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
  const previousBunkerSigner = connection.previousBunkerSigner
  connection.previousBunkerSigner = undefined
  if (previousBunkerSigner) void closeRemoteSigner(previousBunkerSigner)
  if (connection.clientKeyAlreadyPersisted) {
    void closeRemoteSigner(connection.bunkerSigner)
    return
  }
  void logoutRemoteSigner(connection.bunkerSigner)
}

/** Retire the verified previous route only after the replacement is persisted and installed. */
export async function commitRemoteSignerConnection(
  connection: RemoteSignerConnection
): Promise<void> {
  const previousBunkerSigner = connection.previousBunkerSigner
  connection.previousBunkerSigner = undefined
  if (previousBunkerSigner) await closeRemoteSigner(previousBunkerSigner)
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

function signerRelaySetsMatch(
  currentRelayUrls: readonly string[],
  nextRelayUrls: readonly string[]
): boolean {
  const nextRelaySet = new Set(nextRelayUrls)
  return (
    currentRelayUrls.length === nextRelayUrls.length &&
    currentRelayUrls.every((relayUrl) => nextRelaySet.has(relayUrl))
  )
}

function parseSignerRelaySwitchResult(result: string | null): string[] | null {
  if (result === null || result === "null") return null

  let parsed: unknown
  try {
    parsed = JSON.parse(result)
  } catch (cause) {
    throw new RemoteSignerError(
      "invalid_response",
      "The remote signer returned a malformed relay list.",
      { cause, operation: "switch relays" }
    )
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(isRelayUrl)
  ) {
    throw new RemoteSignerError(
      "invalid_response",
      "The remote signer returned an invalid secure relay list.",
      { operation: "switch relays" }
    )
  }
  return [...new Set(parsed)]
}

async function verifySignerRoute(
  bunkerSigner: RemoteBunkerSigner,
  expectedUserPubkey: string,
  operation: string,
  options: RemoteSignerOptions
): Promise<void> {
  await withRemoteSignerTimeout(
    `${operation} ping`,
    (signal) => bunkerSigner.ping({ signal }),
    options
  )
  const actualPubkey = requireUserPubkey(
    await withRemoteSignerTimeout(
      `${operation} identity`,
      (signal) => bunkerSigner.getPublicKey({ signal }),
      options
    ),
    `${operation} identity`
  )
  if (actualPubkey !== expectedUserPubkey) {
    throw new RemoteSignerError(
      "session_identity_mismatch",
      "The remote signer returned a different account. Sign in again.",
      { operation: `${operation} identity` }
    )
  }
}

interface NegotiatedSignerRoute {
  bunkerSigner: RemoteBunkerSigner
  relayUrls: string[]
  previousBunkerSigner?: RemoteBunkerSigner
}

async function negotiateSignerRelays(
  bunkerSigner: RemoteBunkerSigner,
  clientPrivateKey: Uint8Array,
  remoteSignerPubkey: string,
  userPubkey: string,
  options: RemoteSignerOptions
): Promise<NegotiatedSignerRoute> {
  const currentRelayUrls = requireSignerRelayUrls(bunkerSigner, "switch relays")
  let result: string | null
  try {
    result = await withRemoteSignerTimeout(
      "switch relays",
      (signal) => bunkerSigner.sendRequest("switch_relays", [], { signal }),
      options
    )
  } catch (error) {
    const remoteError = classifyRemoteSignerError(error, "switch relays")
    if (remoteError.code === "unsupported" || remoteError.code === "rejected") {
      return { bunkerSigner, relayUrls: currentRelayUrls }
    }
    await verifySignerRoute(
      bunkerSigner,
      userPubkey,
      "retain current relays",
      options
    )
    return { bunkerSigner, relayUrls: currentRelayUrls }
  }

  let nextRelayUrls: string[] | null
  try {
    nextRelayUrls = parseSignerRelaySwitchResult(result)
  } catch {
    await verifySignerRoute(
      bunkerSigner,
      userPubkey,
      "retain current relays",
      options
    )
    return { bunkerSigner, relayUrls: currentRelayUrls }
  }
  if (
    nextRelayUrls === null ||
    signerRelaySetsMatch(currentRelayUrls, nextRelayUrls)
  ) {
    return { bunkerSigner, relayUrls: currentRelayUrls }
  }

  let candidate: RemoteBunkerSigner | null = null
  try {
    candidate = createBunkerSigner(
      clientPrivateKey,
      {
        pubkey: remoteSignerPubkey,
        relays: nextRelayUrls,
        secret: null,
      },
      options
    )
    await verifySignerRoute(candidate, userPubkey, "new relay route", options)
    return {
      bunkerSigner: candidate,
      relayUrls: nextRelayUrls,
      previousBunkerSigner: bunkerSigner,
    }
  } catch (error) {
    if (candidate) await closeRemoteSigner(candidate, options)
    const candidateError = classifyRemoteSignerError(error, "new relay route")
    try {
      await verifySignerRoute(
        bunkerSigner,
        userPubkey,
        "retain current relays",
        options
      )
      return { bunkerSigner, relayUrls: currentRelayUrls }
    } catch (currentRouteError) {
      if (
        candidateError.code === "invalid_response" ||
        candidateError.code === "session_identity_mismatch"
      ) {
        throw candidateError
      }
      throw currentRouteError
    }
  }
}

function createRemoteSignerConnection(
  bunkerSigner: RemoteBunkerSigner,
  clientPrivateKey: Uint8Array,
  remoteSignerPubkey: string,
  relayUrls: string[],
  userPubkey: string,
  options: RemoteSignerOptions,
  existingSession?: Nip46AuthSession,
  previousBunkerSigner?: RemoteBunkerSigner
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
    version: AUTH_SESSION_VERSION,
    type: "nip46",
    clientKeyId: generateId(),
    remoteSignerPubkey,
    relayUrls,
    userPubkey,
    createdAt: now,
    updatedAt: now,
  }
  const signer = new RemoteSessionSigner(bunkerSigner, userPubkey, options)
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
    previousBunkerSigner,
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
  let activeBunkerSigner = bunkerSigner
  let previousBunkerSigner: RemoteBunkerSigner | undefined
  let connected = false

  try {
    const connectParams = [
      pointer.pubkey,
      pointer.secret ?? "",
      CONDUIT_NIP46_PERMISSIONS.join(","),
    ]
    if (options.clientMetadata) {
      connectParams.push(JSON.stringify(options.clientMetadata))
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
    requireSignerRelayUrls(bunkerSigner, "session setup")
    const userPubkey = requireUserPubkey(
      await withRemoteSignerTimeout(
        "get public key",
        (signal) => bunkerSigner.getPublicKey({ signal }),
        options
      ),
      "get public key"
    )
    const negotiated = await negotiateSignerRelays(
      bunkerSigner,
      clientPrivateKey,
      pointer.pubkey,
      userPubkey,
      options
    )
    activeBunkerSigner = negotiated.bunkerSigner
    previousBunkerSigner = negotiated.previousBunkerSigner
    return createRemoteSignerConnection(
      activeBunkerSigner,
      clientPrivateKey,
      pointer.pubkey,
      negotiated.relayUrls,
      userPubkey,
      options,
      undefined,
      previousBunkerSigner
    )
  } catch (error) {
    if (connected) {
      await logoutRemoteSigner(activeBunkerSigner, options)
    } else {
      await closeRemoteSigner(activeBunkerSigner, options)
    }
    if (previousBunkerSigner) {
      await closeRemoteSigner(previousBunkerSigner, options)
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
  let previousBunkerSigner: RemoteBunkerSigner | undefined
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
    const negotiated = await negotiateSignerRelays(
      bunkerSigner,
      clientPrivateKey,
      remoteSignerPubkey,
      userPubkey,
      options
    )
    bunkerSigner = negotiated.bunkerSigner
    previousBunkerSigner = negotiated.previousBunkerSigner
    return createRemoteSignerConnection(
      bunkerSigner,
      clientPrivateKey,
      remoteSignerPubkey,
      negotiated.relayUrls,
      userPubkey,
      options,
      undefined,
      previousBunkerSigner
    )
  } catch (error) {
    if (bunkerSigner) await logoutRemoteSigner(bunkerSigner, options)
    if (previousBunkerSigner) {
      await closeRemoteSigner(previousBunkerSigner, options)
    }
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
    isAuthSessionRevoked(parsed, options.authStorage ?? getDefaultAuthStorage())
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
  let activeBunkerSigner = bunkerSigner
  let previousBunkerSigner: RemoteBunkerSigner | undefined

  try {
    await withRemoteSignerTimeout(
      "restore ping",
      (signal) => bunkerSigner.ping({ signal }),
      options
    )
    requireSignerRelayUrls(bunkerSigner, "restore session")
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
    const negotiated = await negotiateSignerRelays(
      bunkerSigner,
      hexToBytes(clientPrivateKey),
      parsed.remoteSignerPubkey,
      actualPubkey,
      options
    )
    activeBunkerSigner = negotiated.bunkerSigner
    previousBunkerSigner = negotiated.previousBunkerSigner
    const restoredSession = {
      ...parsed,
      relayUrls: negotiated.relayUrls,
      updatedAt: (options.now ?? Date.now)(),
    }
    return createRemoteSignerConnection(
      activeBunkerSigner,
      hexToBytes(clientPrivateKey),
      parsed.remoteSignerPubkey,
      negotiated.relayUrls,
      actualPubkey,
      options,
      restoredSession,
      previousBunkerSigner
    )
  } catch (error) {
    await closeRemoteSigner(activeBunkerSigner, options)
    if (previousBunkerSigner) {
      await closeRemoteSigner(previousBunkerSigner, options)
    }
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

export class RemoteSessionSigner implements NostrKeySigner {
  readonly pubkey: string
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
    this.removeTransportFailureListener =
      this.bunkerSigner.onLifecycleFailure?.((failure) => {
        const error = classifyRemoteSignerError(failure, "transport lifecycle")
        void this.invalidateAfterFailure(error, "transport_unavailable")
      }) ?? null
  }

  get capabilities(): AccountSignerCapabilities {
    const ready = this.lifecycle.state === "active"
    return { signEvent: ready, nip44: ready, nip04Decrypt: ready }
  }

  async getPublicKey(): Promise<string> {
    this.assertUsable()
    return this.pubkey
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

  async signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
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
        signed &&
        typeof signed.pubkey === "string" &&
        signed.pubkey !== this.pubkey
      ) {
        return this.rejectSignerIntegrityFailure(
          new RemoteSignerError(
            "session_identity_mismatch",
            "The remote signer signed with a different account. Sign in again.",
            { operation: "sign event" }
          )
        )
      }
      if (!isValidSignedPublicNostrEvent(signed as SignedPublicNostrEvent)) {
        return this.rejectSignerIntegrityFailure(
          new RemoteSignerError(
            "invalid_response",
            "The remote signer returned invalid event evidence.",
            { operation: "sign event" }
          )
        )
      }
      if (
        signed.kind !== kind ||
        signed.created_at !== createdAt ||
        signed.content !== expectedContent ||
        JSON.stringify(signed.tags) !== JSON.stringify(expectedTags)
      ) {
        return this.rejectSignerIntegrityFailure(
          new RemoteSignerError(
            "invalid_response",
            "The remote signer returned a changed event. The signature was not accepted.",
            { operation: "sign event" }
          )
        )
      }
      return signed
    })
  }

  private async rejectSignerIntegrityFailure(
    error: RemoteSignerError
  ): Promise<never> {
    await this.invalidateAfterFailure(error)
    throw error
  }

  async encryptNip44(peer: string, value: string): Promise<string> {
    return this.request("nip44 encrypt", (signal) =>
      this.bunkerSigner.nip44Encrypt(peer, value, { signal })
    )
  }

  async decryptNip44(peer: string, value: string): Promise<string> {
    return this.request("nip44 decrypt", (signal) =>
      this.bunkerSigner.nip44Decrypt(peer, value, { signal })
    )
  }

  async decryptLegacy(peer: string, value: string): Promise<string> {
    return this.request("nip04 decrypt", (signal) =>
      this.bunkerSigner.nip04Decrypt(peer, value, { signal })
    )
  }
}

/** Keep a same-credential replacement usable; retire only this provider's key. */
export async function retireRemoteSignerCredentials(
  expected: Nip46AuthSession,
  replacement: AuthSession | null,
  keyVault: RemoteSignerKeyVault = getDefaultKeyVault()
): Promise<void> {
  if (
    replacement?.type === "nip46" &&
    replacement.clientKeyId === expected.clientKeyId
  )
    return
  try {
    await forgetRemoteSignerKey(expected, keyVault)
  } catch (cause) {
    throw new RemoteSignerError(
      "unavailable",
      "The browser could not erase the invalidated remote signer connection key.",
      { cause, operation: "retire invalidated signer session" }
    )
  }
}

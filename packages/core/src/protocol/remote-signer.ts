import {
  NDKUser,
  type NDKEncryptionScheme,
  type NDKSigner,
  type NostrEvent,
} from "@nostr-dev-kit/ndk"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { generateSecretKey } from "nostr-tools"
import {
  BunkerSigner,
  type BunkerPointer,
  type BunkerSignerParams,
  type ClientMetadata,
} from "nostr-tools/nip46"
import type { EventTemplate, VerifiedEvent } from "nostr-tools"
import { generateId } from "../utils"
import {
  createBrowserRemoteSignerKeyVault,
  type RemoteSignerKeyVault,
} from "./remote-signer-vault"

export type { RemoteSignerKeyVault } from "./remote-signer-vault"

export const AUTH_STORAGE_KEY = "conduit:auth"
export const AUTH_REVISION_STORAGE_KEY = "conduit:auth:revision"
export const REMOTE_SIGNER_SESSION_VERSION = 1 as const
export const DEFAULT_REMOTE_SIGNER_TIMEOUT_MS = 30_000
export const DEFAULT_REMOTE_SIGNER_PAIR_TIMEOUT_MS = 120_000

const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/

export type RemoteSignerErrorCode =
  | "invalid_uri"
  | "timeout"
  | "rejected"
  | "unavailable"
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
  sendRequest(method: string, params: string[]): Promise<string>
  ping(): Promise<void>
  getPublicKey(): Promise<string>
  switchRelays(): Promise<boolean>
  signEvent(event: EventTemplate): Promise<VerifiedEvent>
  nip04Encrypt(pubkey: string, plaintext: string): Promise<string>
  nip04Decrypt(pubkey: string, ciphertext: string): Promise<string>
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>
  logout(): Promise<void>
  close(): Promise<void>
}

export type BunkerSignerFactory = (
  clientPrivateKey: Uint8Array,
  pointer: BunkerPointer,
  params: BunkerSignerParams
) => RemoteBunkerSigner

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

export interface RemoteSignerOptions extends RemoteSignerDependencies {
  timeoutMs?: number
  onAuthUrl?: (url: string) => void
  keyVault?: RemoteSignerKeyVault
}

export interface PairRemoteSignerOptions extends RemoteSignerOptions {
  clientMetadata?: ClientMetadata
}

export interface RemoteSignerConnection {
  session: Nip46AuthSession
  bunkerSigner: RemoteBunkerSigner
  signer: NdkBunkerSignerAdapter
  clientPrivateKey: string
  clientKeyAlreadyPersisted: boolean
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
  return window.localStorage
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

export function readAuthSession(
  storage: AuthStorage | undefined = getDefaultStorage()
): AuthSession | null {
  if (!storage) return null
  try {
    return parseAuthSession(storage.getItem(AUTH_STORAGE_KEY))
  } catch {
    return null
  }
}

export function writeAuthSession(
  session: AuthSession,
  storage: AuthStorage | undefined = getDefaultStorage()
): boolean {
  if (!storage) return false
  const parsed = parseAuthSession(JSON.stringify(session))
  if (!parsed) return false
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
    const current = readAuthSession(storage)
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
      throw error
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
  const current = readAuthSession(storage)
  if (JSON.stringify(current) === JSON.stringify(connection.session)) {
    if (!forgetAuthSession(storage)) {
      throw new RemoteSignerError(
        "unavailable",
        "The browser could not roll back the stale remote signer session.",
        { operation: "rollback session" }
      )
    }
  }
  await forgetRemoteSignerKey(connection.session, keyVault)
}

export async function forgetRemoteSignerKey(
  session: Nip46AuthSession,
  keyVault: RemoteSignerKeyVault = getDefaultKeyVault()
): Promise<void> {
  await keyVault.remove(session.clientKeyId)
}

export function forgetAuthSession(
  storage: AuthStorage | undefined = getDefaultStorage()
): boolean {
  if (!storage) return false
  try {
    storage.removeItem(AUTH_STORAGE_KEY)
    return true
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
  const message = error instanceof Error ? error.message : String(error)
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
  task: () => Promise<T>,
  options: RemoteSignerOptions
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_SIGNER_TIMEOUT_MS
  const timers = options.timers ?? defaultTimers
  let handle: unknown
  const timeout = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(() => {
      reject(
        new RemoteSignerError(
          "timeout",
          `The remote signer timed out during ${operation}. Try again or check its relay connection.`,
          { operation }
        )
      )
    }, timeoutMs)
  })

  try {
    return await Promise.race([task(), timeout])
  } catch (error) {
    throw classifyRemoteSignerError(error, operation)
  } finally {
    if (handle !== undefined) timers.clearTimeout(handle)
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
      BunkerSigner.fromBunker(key, bunkerPointer, params))
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
      "unavailable",
      `The remote signer returned an invalid user pubkey during ${operation}.`,
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

export async function pairRemoteSigner(
  uri: string,
  options: PairRemoteSignerOptions = {}
): Promise<RemoteSignerConnection> {
  const pointer = parseBunkerUri(uri)
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
      () => bunkerSigner.sendRequest("connect", connectParams),
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
    const userPubkey = requireUserPubkey(
      await withRemoteSignerTimeout(
        "get public key",
        () => bunkerSigner.getPublicKey(),
        options
      ),
      "get public key"
    )
    await withRemoteSignerTimeout(
      "relay migration",
      () => bunkerSigner.switchRelays(),
      options
    )
    const relayUrls = requireSignerRelayUrls(bunkerSigner, "relay migration")
    const now = (options.now ?? Date.now)()
    const clientKeyId = generateId()
    const session: Nip46AuthSession = {
      version: REMOTE_SIGNER_SESSION_VERSION,
      type: "nip46",
      clientKeyId,
      remoteSignerPubkey: pointer.pubkey,
      relayUrls,
      userPubkey,
      createdAt: now,
      updatedAt: now,
    }
    return {
      session,
      bunkerSigner,
      signer: new NdkBunkerSignerAdapter(bunkerSigner, userPubkey, options),
      clientPrivateKey: bytesToHex(clientPrivateKey),
      clientKeyAlreadyPersisted: false,
    }
  } catch (error) {
    if (connected) {
      await logoutRemoteSigner(bunkerSigner, options)
    } else {
      await closeRemoteSigner(bunkerSigner, options)
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
      "unavailable",
      "The saved remote signer session is invalid. Sign in again."
    )
  }
  const clientPrivateKey = await (
    options.keyVault ?? getDefaultKeyVault()
  ).load(parsed.clientKeyId)
  if (!clientPrivateKey || !isHexKey(clientPrivateKey)) {
    throw new RemoteSignerError(
      "unavailable",
      "The saved remote signer key is unavailable. Connect the signer again."
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
      () => bunkerSigner.ping(),
      options
    )
    await withRemoteSignerTimeout(
      "relay migration",
      () => bunkerSigner.switchRelays(),
      options
    )
    const relayUrls = requireSignerRelayUrls(bunkerSigner, "relay migration")
    const actualPubkey = requireUserPubkey(
      await withRemoteSignerTimeout(
        "restore identity",
        () => bunkerSigner.getPublicKey(),
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
    return {
      session: restoredSession,
      bunkerSigner,
      signer: new NdkBunkerSignerAdapter(bunkerSigner, actualPubkey, options),
      clientPrivateKey,
      clientKeyAlreadyPersisted: true,
    }
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
      () => bunkerSigner.logout(),
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
  private invalidated = false

  constructor(
    private readonly bunkerSigner: RemoteBunkerSigner,
    userPubkey: string,
    private readonly options: RemoteSignerOptions = {}
  ) {
    this.pubkey = requireUserPubkey(userPubkey, "adapter setup")
    this.ndkUser = new NDKUser({ pubkey: this.pubkey })
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
    this.invalidated = true
  }

  private async request<T>(
    operation: string,
    task: () => Promise<T>
  ): Promise<T> {
    if (this.invalidated) {
      throw new RemoteSignerError(
        "unavailable",
        "The remote signer session is unavailable. Reconnect it and try again.",
        { operation }
      )
    }
    try {
      const result = await withRemoteSignerTimeout(
        operation,
        task,
        this.options
      )
      if (this.invalidated) {
        throw new RemoteSignerError(
          "unavailable",
          "The remote signer session changed before the request completed.",
          { operation }
        )
      }
      return result
    } catch (error) {
      if (error instanceof RemoteSignerError && error.code === "timeout") {
        this.invalidated = true
        await closeRemoteSigner(this.bunkerSigner, this.options)
      }
      throw error
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
    const signed = await this.request("sign event", () =>
      this.bunkerSigner.signEvent({
        kind,
        content: event.content,
        tags: event.tags,
        created_at: createdAt,
      })
    )
    if (
      signed.pubkey !== this.pubkey ||
      signed.kind !== kind ||
      signed.created_at !== createdAt ||
      signed.content !== event.content ||
      JSON.stringify(signed.tags) !== JSON.stringify(event.tags)
    ) {
      throw new RemoteSignerError(
        signed.pubkey !== this.pubkey
          ? "session_identity_mismatch"
          : "invalid_response",
        signed.pubkey !== this.pubkey
          ? "The remote signer signed with a different account. Sign in again."
          : "The remote signer returned a changed event. The signature was not accepted.",
        { operation: "sign event" }
      )
    }
    return signed.sig
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
    return this.request(`${scheme} encrypt`, () =>
      scheme === "nip44"
        ? this.bunkerSigner.nip44Encrypt(recipient.pubkey, value)
        : this.bunkerSigner.nip04Encrypt(recipient.pubkey, value)
    )
  }

  async decrypt(
    sender: NDKUser,
    value: string,
    scheme: NDKEncryptionScheme = "nip04"
  ): Promise<string> {
    return this.request(`${scheme} decrypt`, () =>
      scheme === "nip44"
        ? this.bunkerSigner.nip44Decrypt(sender.pubkey, value)
        : this.bunkerSigner.nip04Decrypt(sender.pubkey, value)
    )
  }

  toPayload(): string {
    throw new RemoteSignerError(
      "unavailable",
      "Use the versioned Conduit auth session helpers to persist this signer."
    )
  }
}

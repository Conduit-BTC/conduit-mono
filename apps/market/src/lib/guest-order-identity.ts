import { NDKEvent } from "@nostr-dev-kit/ndk"
import { bytesToHex, hexToBytes } from "nostr-tools/utils"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import {
  buildCheckoutSparkRecoveryRumor,
  EVENT_KINDS,
  GUEST_ORDER_LOCAL_RETENTION_MS,
  getCheckoutSparkBuyerTakeoverAt,
  parseCheckoutSparkRecoveryRumor,
  buildCheckoutSparkOrganizerRecoveryRumor,
  parseCheckoutSparkOrganizerRecoveryRumor,
  parseCheckoutSparkOrganizerRecoveryProgressRumor,
  type CheckoutSparkOrganizerRecoveryMessage,
  type NostrKeySigner,
} from "@conduit/core"
import {
  buildEventMarketFreePurchaseRumor,
  parseEventMarketFreePurchaseRumor,
  restoreEventMarketFreePurchase,
  type EventMarketFreePurchasePayload,
} from "@conduit/core/protocol/event-market-free-purchase"

const GUEST_ORDER_SIGNER_STORAGE_KEY = "conduit:guest-order-signers:v1"
export const GUEST_ORDER_SESSION_TTL_MS = GUEST_ORDER_LOCAL_RETENTION_MS

export interface GuestOrderSigningIdentity {
  kind: "guest_ephemeral"
  orderId: string
  merchantPubkey: string
  createdAt: number
  expiresAt: number
  pubkey: string
  signer: NostrKeySigner
}

/** Validate one captured capability; callers separately read the current tab registry. */
export function isCurrentGuestOrderSigningIdentity(
  identity: GuestOrderSigningIdentity | null | undefined,
  scope: { orderId: string; merchantPubkey: string; pubkey?: string },
  now = Date.now()
): identity is GuestOrderSigningIdentity {
  try {
    return Boolean(
      identity &&
      identity.kind === "guest_ephemeral" &&
      /^[0-9a-f]{64}$/.test(identity.pubkey) &&
      /^[0-9a-f]{64}$/.test(identity.merchantPubkey) &&
      identity.orderId.length > 0 &&
      identity.orderId === scope.orderId &&
      identity.merchantPubkey === scope.merchantPubkey &&
      (scope.pubkey === undefined || identity.pubkey === scope.pubkey) &&
      Number.isSafeInteger(now) &&
      Number.isSafeInteger(identity.createdAt) &&
      identity.createdAt > 0 &&
      identity.createdAt <= now &&
      Number.isSafeInteger(identity.expiresAt) &&
      identity.expiresAt === identity.createdAt + GUEST_ORDER_SESSION_TTL_MS &&
      now < identity.expiresAt &&
      identity.signer.pubkey === identity.pubkey
    )
  } catch {
    return false
  }
}

type StoredGuestOrderSigner = {
  pubkey: string
  privateKey: string
  merchantPubkey: string
  createdAt: number
}

type GuestOrderSignerRegistry = Record<string, StoredGuestOrderSigner>

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

let inMemoryGuestOrderSignerRegistry: GuestOrderSignerRegistry = {}

function isStoredGuestOrderSigner(
  value: unknown
): value is StoredGuestOrderSigner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const stored = value as Partial<StoredGuestOrderSigner>
  return (
    typeof stored.pubkey === "string" &&
    stored.pubkey.length > 0 &&
    typeof stored.privateKey === "string" &&
    stored.privateKey.length > 0 &&
    typeof stored.merchantPubkey === "string" &&
    stored.merchantPubkey.length > 0 &&
    Number.isFinite(stored.createdAt) &&
    (stored.createdAt ?? 0) > 0
  )
}

function getSessionStorage(): SessionStorageLike | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function readGuestOrderSignerRegistry(
  storage: SessionStorageLike | null = getSessionStorage()
): GuestOrderSignerRegistry {
  if (!storage) return { ...inMemoryGuestOrderSignerRegistry }
  try {
    const raw = storage.getItem(GUEST_ORDER_SIGNER_STORAGE_KEY)
    if (!raw) return { ...inMemoryGuestOrderSignerRegistry }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      storage.removeItem(GUEST_ORDER_SIGNER_STORAGE_KEY)
      return { ...inMemoryGuestOrderSignerRegistry }
    }
    const entries = Object.entries(parsed)
    const persisted = Object.fromEntries(
      entries.filter(([, value]) => isStoredGuestOrderSigner(value))
    ) as GuestOrderSignerRegistry
    if (Object.keys(persisted).length !== entries.length) {
      if (Object.keys(persisted).length === 0) {
        storage.removeItem(GUEST_ORDER_SIGNER_STORAGE_KEY)
      } else {
        storage.setItem(
          GUEST_ORDER_SIGNER_STORAGE_KEY,
          JSON.stringify(persisted)
        )
      }
    }
    return { ...inMemoryGuestOrderSignerRegistry, ...persisted }
  } catch {
    return { ...inMemoryGuestOrderSignerRegistry }
  }
}

function writeGuestOrderSignerRegistry(
  registry: GuestOrderSignerRegistry,
  storage: SessionStorageLike | null = getSessionStorage()
): void {
  inMemoryGuestOrderSignerRegistry = { ...registry }
  if (!storage) return
  try {
    storage.setItem(GUEST_ORDER_SIGNER_STORAGE_KEY, JSON.stringify(registry))
  } catch {
    // Guest keys stay in memory for the active flow if session storage is unavailable.
  }
}

function pruneExpiredGuestOrderSigners(
  registry: GuestOrderSignerRegistry,
  nowMs: number
): GuestOrderSignerRegistry {
  return Object.fromEntries(
    Object.entries(registry).filter(([, stored]) => {
      return (
        Number.isFinite(stored.createdAt) &&
        stored.createdAt > 0 &&
        stored.createdAt <= nowMs &&
        nowMs - stored.createdAt < GUEST_ORDER_SESSION_TTL_MS
      )
    })
  )
}

export function pruneExpiredSessionGuestOrderSigningIdentities(
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now()
): number {
  const registry = readGuestOrderSignerRegistry(storage)
  const pruned = pruneExpiredGuestOrderSigners(registry, nowMs)
  const removed = Object.keys(registry).length - Object.keys(pruned).length
  if (removed === 0) return 0

  if (Object.keys(pruned).length === 0) {
    inMemoryGuestOrderSignerRegistry = {}
    try {
      storage?.removeItem(GUEST_ORDER_SIGNER_STORAGE_KEY)
    } catch {
      // ignore
    }
  } else {
    writeGuestOrderSignerRegistry(pruned, storage)
  }
  return removed
}

function createEphemeralOrderSigner(
  secret: Uint8Array,
  orderId: string,
  merchantPubkey: string,
  expiresAt: number
): NostrKeySigner {
  const pubkey = getPublicKey(secret)
  const assertActive = () => {
    if (Date.now() >= expiresAt) {
      throw new Error("Guest order session has expired.")
    }
  }
  return {
    get pubkey() {
      return pubkey
    },
    getPublicKey: async () => {
      assertActive()
      return pubkey
    },
    signEvent: async (event) => {
      assertActive()
      if (event.pubkey !== pubkey)
        throw new Error("Guest signer cannot sign outside its order scope.")
      if (event.kind === EVENT_KINDS.ORDER) {
        const eventOrderId = event.tags.find((tag) => tag[0] === "order")?.[1]
        const recipient = event.tags.find((tag) => tag[0] === "p")?.[1]
        const type = event.tags.find((tag) => tag[0] === "type")?.[1]
        if (
          eventOrderId !== orderId ||
          recipient !== merchantPubkey ||
          (type !== "order" && type !== "payment_proof")
        ) {
          throw new Error("Guest signer cannot sign outside its order scope.")
        }
      } else if (event.kind !== EVENT_KINDS.SEAL) {
        throw new Error("Guest signer can only sign private order envelopes.")
      }
      return finalizeEvent(event, secret)
    },
    encryptNip44: async (recipient, value) => {
      assertActive()
      return v2.encrypt(value, v2.utils.getConversationKey(secret, recipient))
    },
    decryptNip44: async () => {
      throw new Error("Guest order signer cannot decrypt inbound messages.")
    },
    decryptLegacy: async () => {
      throw new Error("Guest order signer cannot decrypt inbound messages.")
    },
  }
}

function createGuestOrderSigningIdentityFromPrivateSigner(
  secret: Uint8Array,
  orderId: string,
  merchantPubkey: string,
  createdAt: number
): GuestOrderSigningIdentity {
  const expiresAt = createdAt + GUEST_ORDER_SESSION_TTL_MS
  const signer = createEphemeralOrderSigner(
    secret,
    orderId,
    merchantPubkey,
    expiresAt
  )

  return {
    kind: "guest_ephemeral",
    orderId,
    merchantPubkey,
    createdAt,
    expiresAt,
    pubkey: signer.pubkey,
    signer,
  }
}

/**
 * A separate wrapping capability, not a broader guest account signer. NIP-59
 * rumors are unsigned: constrain the plaintext at encryption and authorize only
 * its resulting seal, rather than adding recovery to the generic sign allowlist.
 */
export function createGuestCheckoutSparkRecoverySigner(
  identity: GuestOrderSigningIdentity,
  options: {
    now?: () => number
    organizerRecovery?: {
      organizerPubkey: string
      checkoutId: string
      planDigest: string
    }
  } = {}
): NostrKeySigner {
  const { signer, pubkey, orderId, merchantPubkey, createdAt, expiresAt } =
    identity
  const now = options.now ?? Date.now
  const organizerScope = options.organizerRecovery
    ? { ...options.organizerRecovery }
    : null
  const recoveryRecipient = organizerScope?.organizerPubkey ?? merchantPubkey
  const pendingSeals = new Map<string, number>()
  const scopeError = () =>
    new Error("Guest recovery signer cannot act outside its checkout scope.")
  const assertActive = (deadline = expiresAt) => {
    const currentTime = now()
    if (
      identity.kind !== "guest_ephemeral" ||
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      !/^[0-9a-f]{64}$/.test(merchantPubkey) ||
      !orderId ||
      !Number.isSafeInteger(createdAt) ||
      createdAt <= 0 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt !== createdAt + GUEST_ORDER_SESSION_TTL_MS ||
      !Number.isSafeInteger(currentTime) ||
      currentTime < createdAt ||
      currentTime >= Math.min(expiresAt, deadline) ||
      signer.pubkey !== pubkey
    ) {
      pendingSeals.clear()
      throw scopeError()
    }
    return currentTime
  }
  const currentPubkey = async () => {
    assertActive()
    const signerPubkey = await signer.getPublicKey()
    assertActive()
    if (signerPubkey !== pubkey) throw scopeError()
    return pubkey
  }
  assertActive()
  return {
    get pubkey() {
      assertActive()
      return pubkey
    },
    getPublicKey: currentPubkey,
    encryptNip44: async (recipient, value) => {
      const currentTime = assertActive()
      if (recipient !== recoveryRecipient) {
        throw scopeError()
      }
      let payload
      let canonicalRumor
      try {
        const raw = JSON.parse(value)
        if (raw.sig) throw scopeError()
        const rumor = new NDKEvent(undefined, raw)
        payload = organizerScope
          ? JSON.parse(rumor.content)?.schemaVersion === 5
            ? parseCheckoutSparkOrganizerRecoveryProgressRumor(rumor)
            : parseCheckoutSparkOrganizerRecoveryRumor(rumor)
          : parseCheckoutSparkRecoveryRumor(rumor)
        canonicalRumor = organizerScope
          ? buildCheckoutSparkOrganizerRecoveryRumor(
              payload as CheckoutSparkOrganizerRecoveryMessage
            )
          : buildCheckoutSparkRecoveryRumor(
              payload as ReturnType<typeof parseCheckoutSparkRecoveryRumor>
            )
        if (
          payload.schemaVersion === 1 ||
          (payload.plan.schemaVersion !== 3 &&
            payload.plan.schemaVersion !== 4 &&
            payload.plan.schemaVersion !== 5 &&
            payload.plan.schemaVersion !== 6) ||
          (organizerScope !== null &&
            ((payload.schemaVersion !== 4 && payload.schemaVersion !== 5) ||
              payload.organizerPubkey !== organizerScope.organizerPubkey ||
              payload.plan.checkoutId !== organizerScope.checkoutId ||
              payload.plan.planDigest !== organizerScope.planDigest)) ||
          payload.senderPubkey !== pubkey ||
          payload.merchantPubkey !== merchantPubkey ||
          payload.plan.orderId !== orderId ||
          payload.preparedAt < createdAt ||
          payload.preparedAt > currentTime ||
          rumor.content !== JSON.stringify(payload) ||
          JSON.stringify(rumor.tags) !== JSON.stringify(canonicalRumor.tags)
        ) {
          throw scopeError()
        }
      } catch {
        throw scopeError()
      }
      const deadline =
        payload.plan.schemaVersion === 6
          ? payload.type === "checkout_spark_recovery" ||
            payload.type === "checkout_spark_organizer_recovery"
            ? payload.plan.funding.expiresAt
            : getCheckoutSparkBuyerTakeoverAt(
                payload.plan,
                payload.state.buyerActivation
              )
          : payload.plan.takeoverAt
      if (deadline === null) throw scopeError()
      assertActive(deadline)
      const ciphertext = await signer.encryptNip44(
        recoveryRecipient,
        JSON.stringify(canonicalRumor)
      )
      assertActive(deadline)
      pendingSeals.set(ciphertext, deadline)
      return ciphertext
    },
    signEvent: async (event) => {
      const deadline = pendingSeals.get(event.content)
      assertActive(deadline)
      if (
        deadline === undefined ||
        event.kind !== EVENT_KINDS.SEAL ||
        event.pubkey !== pubkey ||
        event.tags.length !== 0
      ) {
        throw scopeError()
      }
      // Consume before awaiting; retries reuse persisted wraps, not new seals.
      pendingSeals.delete(event.content)
      const signedEvent = await signer.signEvent({ ...event, tags: [] })
      assertActive(deadline)
      return signedEvent
    },
    decryptNip44: async () => {
      throw new Error("Guest recovery signer cannot decrypt inbound messages.")
    },
    decryptLegacy: async () => {
      throw new Error("Guest recovery signer cannot decrypt inbound messages.")
    },
  }
}

/** One exact contact-free, zero-cost organizer packet; no general signing grant. */
export function createGuestEventMarketFreePurchaseSigner(
  identity: GuestOrderSigningIdentity,
  options: { payload: EventMarketFreePurchasePayload; now?: () => number }
): NostrKeySigner {
  const payload = restoreEventMarketFreePurchase(options.payload)
  const rumor = buildEventMarketFreePurchaseRumor(payload)
  const canonical = JSON.stringify(rumor)
  const { signer, pubkey, orderId, merchantPubkey } = identity
  const now = options.now ?? Date.now
  const pending = new Set<string>()
  const invalid = (): never => {
    pending.clear()
    throw new Error("Guest free-purchase signer is outside its order scope.")
  }
  const check = () => {
    const time = now()
    if (
      identity.signer !== signer ||
      !isCurrentGuestOrderSigningIdentity(
        identity,
        { orderId, merchantPubkey, pubkey },
        time
      ) ||
      payload.senderPubkey !== pubkey ||
      payload.merchantPubkey !== merchantPubkey ||
      payload.orderId !== orderId ||
      payload.createdAt < identity.createdAt ||
      payload.createdAt > time
    )
      invalid()
  }
  check()
  return {
    get pubkey() {
      check()
      return pubkey
    },
    getPublicKey: async () => {
      check()
      const actual = await signer.getPublicKey()
      check()
      if (actual !== pubkey) invalid()
      return pubkey
    },
    encryptNip44: async (recipient, value) => {
      check()
      if (recipient !== payload.organizerPubkey) invalid()
      try {
        const raw = JSON.parse(value)
        if (raw.sig !== undefined) invalid()
        const candidate = new NDKEvent(undefined, raw)
        const parsed = parseEventMarketFreePurchaseRumor(candidate)
        if (
          JSON.stringify(parsed) !== JSON.stringify(payload) ||
          JSON.stringify(buildEventMarketFreePurchaseRumor(parsed)) !==
            canonical
        )
          invalid()
      } catch {
        invalid()
      }
      const ciphertext = await signer.encryptNip44(recipient, canonical)
      check()
      pending.add(ciphertext)
      return ciphertext
    },
    signEvent: async (event) => {
      check()
      if (
        event.kind !== EVENT_KINDS.SEAL ||
        event.pubkey !== pubkey ||
        event.tags.length !== 0 ||
        !pending.has(event.content)
      )
        invalid()
      pending.delete(event.content)
      const signed = await signer.signEvent({ ...event, tags: [] })
      check()
      return signed
    },
    decryptNip44: async () => {
      throw new Error("Guest order signing cannot open an inbox.")
    },
    decryptLegacy: async () => {
      throw new Error("Guest order signing cannot open an inbox.")
    },
  }
}

export function createGuestOrderSigningIdentity(
  orderId: string,
  merchantPubkey: string,
  generateSigner: () => Uint8Array = generateSecretKey
): GuestOrderSigningIdentity {
  return createGuestOrderSigningIdentityFromPrivateSigner(
    generateSigner(),
    orderId,
    merchantPubkey,
    Date.now()
  )
}

export function createSessionGuestOrderSigningIdentity(
  orderId: string,
  merchantPubkey: string,
  options: {
    storage?: SessionStorageLike | null
    nowMs?: number
    generateSigner?: () => Uint8Array
  } = {}
): GuestOrderSigningIdentity {
  const nowMs = options.nowMs ?? Date.now()
  const secret = options.generateSigner?.() ?? generateSecretKey()
  const identity = createGuestOrderSigningIdentityFromPrivateSigner(
    secret,
    orderId,
    merchantPubkey,
    nowMs
  )
  const registry = pruneExpiredGuestOrderSigners(
    readGuestOrderSignerRegistry(options.storage),
    nowMs
  )
  registry[orderId] = {
    pubkey: identity.pubkey,
    privateKey: bytesToHex(secret),
    merchantPubkey,
    createdAt: nowMs,
  }
  writeGuestOrderSignerRegistry(registry, options.storage)
  return identity
}

export function getSessionGuestOrderSigningIdentity(
  orderId: string,
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now()
): GuestOrderSigningIdentity | null {
  pruneExpiredSessionGuestOrderSigningIdentities(storage, nowMs)
  const stored = readGuestOrderSignerRegistry(storage)[orderId]
  if (!stored?.merchantPubkey) return null
  try {
    const secret = hexToBytes(stored.privateKey)
    if (getPublicKey(secret) !== stored.pubkey) {
      clearSessionGuestOrderSigningIdentity(orderId, storage)
      return null
    }
    return createGuestOrderSigningIdentityFromPrivateSigner(
      secret,
      orderId,
      stored.merchantPubkey,
      stored.createdAt
    )
  } catch {
    clearSessionGuestOrderSigningIdentity(orderId, storage)
    return null
  }
}

/** Only opaque order locators leave the same-tab guest signer registry. */
export function listSessionGuestOrderIds(
  storage: SessionStorageLike | null = getSessionStorage(),
  nowMs = Date.now()
): string[] {
  pruneExpiredSessionGuestOrderSigningIdentities(storage, nowMs)
  return Object.keys(readGuestOrderSignerRegistry(storage))
}

export function clearSessionGuestOrderSigningIdentity(
  orderId: string,
  storage: SessionStorageLike | null = getSessionStorage()
): void {
  const registry = readGuestOrderSignerRegistry(storage)
  if (!registry[orderId]) return
  delete registry[orderId]
  inMemoryGuestOrderSignerRegistry = { ...registry }
  if (Object.keys(registry).length === 0) {
    try {
      storage?.removeItem(GUEST_ORDER_SIGNER_STORAGE_KEY)
    } catch {
      // ignore
    }
    return
  }
  writeGuestOrderSignerRegistry(registry, storage)
}

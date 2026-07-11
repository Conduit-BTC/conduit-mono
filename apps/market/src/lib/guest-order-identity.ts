import { NDKPrivateKeySigner, type NDKSigner } from "@nostr-dev-kit/ndk"
import { EVENT_KINDS, GUEST_ORDER_LOCAL_RETENTION_MS } from "@conduit/core"

const GUEST_ORDER_SIGNER_STORAGE_KEY = "conduit:guest-order-signers:v1"
export const GUEST_ORDER_SESSION_TTL_MS = GUEST_ORDER_LOCAL_RETENTION_MS

export interface GuestOrderSigningIdentity {
  kind: "guest_ephemeral"
  orderId: string
  merchantPubkey: string
  createdAt: number
  expiresAt: number
  pubkey: string
  signer: NDKSigner
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
    const parsed = JSON.parse(raw) as GuestOrderSignerRegistry
    const persisted = parsed && typeof parsed === "object" ? parsed : {}
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
  privateSigner: NDKPrivateKeySigner,
  orderId: string,
  merchantPubkey: string,
  expiresAt: number
): NDKSigner {
  const assertActive = () => {
    if (Date.now() >= expiresAt) {
      throw new Error("Guest order session has expired.")
    }
  }
  return {
    get pubkey() {
      return privateSigner.pubkey
    },
    blockUntilReady: () => privateSigner.blockUntilReady(),
    user: () => privateSigner.user(),
    get userSync() {
      return privateSigner.userSync
    },
    sign: (event) => {
      assertActive()
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
      return privateSigner.sign(event)
    },
    encryptionEnabled: (scheme) => privateSigner.encryptionEnabled(scheme),
    encrypt: (recipient, value, scheme) => {
      assertActive()
      return privateSigner.encrypt(recipient, value, scheme)
    },
    decrypt: async () => {
      throw new Error("Guest order signer cannot decrypt inbound messages.")
    },
    toPayload: () => {
      throw new Error(
        "Guest order signer is ephemeral and cannot be serialized."
      )
    },
  }
}

function createGuestOrderSigningIdentityFromPrivateSigner(
  privateSigner: NDKPrivateKeySigner,
  orderId: string,
  merchantPubkey: string,
  createdAt: number
): GuestOrderSigningIdentity {
  const expiresAt = createdAt + GUEST_ORDER_SESSION_TTL_MS
  const signer = createEphemeralOrderSigner(
    privateSigner,
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

export function createGuestOrderSigningIdentity(
  orderId: string,
  merchantPubkey: string,
  generateSigner: () => NDKPrivateKeySigner = () =>
    NDKPrivateKeySigner.generate()
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
    generateSigner?: () => NDKPrivateKeySigner
  } = {}
): GuestOrderSigningIdentity {
  const nowMs = options.nowMs ?? Date.now()
  const privateSigner =
    options.generateSigner?.() ?? NDKPrivateKeySigner.generate()
  const identity = createGuestOrderSigningIdentityFromPrivateSigner(
    privateSigner,
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
    privateKey: privateSigner.privateKey,
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
    const privateSigner = new NDKPrivateKeySigner(stored.privateKey)
    if (privateSigner.pubkey !== stored.pubkey) {
      clearSessionGuestOrderSigningIdentity(orderId, storage)
      return null
    }
    return createGuestOrderSigningIdentityFromPrivateSigner(
      privateSigner,
      orderId,
      stored.merchantPubkey,
      stored.createdAt
    )
  } catch {
    clearSessionGuestOrderSigningIdentity(orderId, storage)
    return null
  }
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

import { NDKPrivateKeySigner, type NDKSigner } from "@nostr-dev-kit/ndk"
import { EVENT_KINDS } from "@conduit/core"
import type { BuyerOrderSigningIdentity } from "./order-publish"

const GUEST_ORDER_SIGNER_STORAGE_KEY = "conduit:guest-order-signers:v1"

export interface GuestOrderSigningIdentity extends BuyerOrderSigningIdentity {
  kind: "guest_ephemeral"
  orderId: string
  merchantPubkey: string
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
  if (!storage) return {}
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

function createEphemeralOrderSigner(
  privateSigner: NDKPrivateKeySigner,
  orderId: string,
  merchantPubkey: string
): NDKSigner {
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
      if (event.kind === EVENT_KINDS.ORDER) {
        const eventOrderId = event.tags.find((tag) => tag[0] === "order")?.[1]
        const recipient = event.tags.find((tag) => tag[0] === "p")?.[1]
        if (eventOrderId !== orderId || recipient !== merchantPubkey) {
          throw new Error("Guest signer cannot sign outside its order scope.")
        }
      } else if (event.kind !== EVENT_KINDS.SEAL) {
        throw new Error("Guest signer can only sign private order envelopes.")
      }
      return privateSigner.sign(event)
    },
    encryptionEnabled: (scheme) => privateSigner.encryptionEnabled(scheme),
    encrypt: (recipient, value, scheme) =>
      privateSigner.encrypt(recipient, value, scheme),
    decrypt: (sender, value, scheme) =>
      privateSigner.decrypt(sender, value, scheme),
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
  merchantPubkey: string
): GuestOrderSigningIdentity {
  const signer = createEphemeralOrderSigner(
    privateSigner,
    orderId,
    merchantPubkey
  )

  return {
    kind: "guest_ephemeral",
    orderId,
    merchantPubkey,
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
    merchantPubkey
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
  const privateSigner =
    options.generateSigner?.() ?? NDKPrivateKeySigner.generate()
  const identity = createGuestOrderSigningIdentityFromPrivateSigner(
    privateSigner,
    orderId,
    merchantPubkey
  )
  const registry = readGuestOrderSignerRegistry(options.storage)
  registry[orderId] = {
    pubkey: identity.pubkey,
    privateKey: privateSigner.privateKey,
    merchantPubkey,
    createdAt: options.nowMs ?? Date.now(),
  }
  writeGuestOrderSignerRegistry(registry, options.storage)
  return identity
}

export function getSessionGuestOrderSigningIdentity(
  orderId: string,
  storage: SessionStorageLike | null = getSessionStorage()
): GuestOrderSigningIdentity | null {
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
      stored.merchantPubkey
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

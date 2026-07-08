import { NDKPrivateKeySigner, type NDKSigner } from "@nostr-dev-kit/ndk"
import type { BuyerOrderSigningIdentity } from "./order-publish"

const GUEST_ORDER_SIGNER_STORAGE_KEY = "conduit:guest-order-signers:v1"

export interface GuestOrderSigningIdentity extends BuyerOrderSigningIdentity {
  kind: "guest_ephemeral"
  signer: NDKSigner
}

type StoredGuestOrderSigner = {
  pubkey: string
  privateKey: string
  createdAt: number
}

type GuestOrderSignerRegistry = Record<string, StoredGuestOrderSigner>

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

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
    if (!raw) return {}
    const parsed = JSON.parse(raw) as GuestOrderSignerRegistry
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeGuestOrderSignerRegistry(
  registry: GuestOrderSignerRegistry,
  storage: SessionStorageLike | null = getSessionStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(GUEST_ORDER_SIGNER_STORAGE_KEY, JSON.stringify(registry))
  } catch {
    // Guest keys stay in memory for the active flow if session storage is unavailable.
  }
}

function createEphemeralOrderSigner(
  privateSigner: NDKPrivateKeySigner
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
    sign: (event) => privateSigner.sign(event),
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
  privateSigner: NDKPrivateKeySigner
): GuestOrderSigningIdentity {
  const signer = createEphemeralOrderSigner(privateSigner)

  return {
    kind: "guest_ephemeral",
    pubkey: signer.pubkey,
    signer,
  }
}

export function createGuestOrderSigningIdentity(
  generateSigner: () => NDKPrivateKeySigner = () =>
    NDKPrivateKeySigner.generate()
): GuestOrderSigningIdentity {
  return createGuestOrderSigningIdentityFromPrivateSigner(generateSigner())
}

export function createSessionGuestOrderSigningIdentity(
  orderId: string,
  options: {
    storage?: SessionStorageLike | null
    nowMs?: number
    generateSigner?: () => NDKPrivateKeySigner
  } = {}
): GuestOrderSigningIdentity {
  const privateSigner =
    options.generateSigner?.() ?? NDKPrivateKeySigner.generate()
  const identity =
    createGuestOrderSigningIdentityFromPrivateSigner(privateSigner)
  const registry = readGuestOrderSignerRegistry(options.storage)
  registry[orderId] = {
    pubkey: identity.pubkey,
    privateKey: privateSigner.privateKey,
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
  if (!stored) return null
  try {
    const privateSigner = new NDKPrivateKeySigner(stored.privateKey)
    if (privateSigner.pubkey !== stored.pubkey) {
      clearSessionGuestOrderSigningIdentity(orderId, storage)
      return null
    }
    return createGuestOrderSigningIdentityFromPrivateSigner(privateSigner)
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

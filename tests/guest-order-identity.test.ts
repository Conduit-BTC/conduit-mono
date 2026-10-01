import { describe, expect, it } from "bun:test"
import { installProtectedReadSigner } from "../packages/core/src/protocol/protected-read-authorization"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import type { NostrKeySigner, UnsignedNostrEvent } from "@conduit/core"

async function signGuestEvent(event: NDKEvent, signer: NostrKeySigner) {
  event.pubkey = signer.pubkey
  event.created_at ??= Math.floor(Date.now() / 1000)
  Object.assign(
    event,
    await signer.signEvent(event.rawEvent() as UnsignedNostrEvent)
  )
}

import {
  GUEST_ORDER_SESSION_TTL_MS,
  clearSessionGuestOrderSigningIdentity,
  createGuestOrderSigningIdentity,
  createSessionGuestOrderSigningIdentity,
  getSessionGuestOrderSigningIdentity,
  pruneExpiredSessionGuestOrderSigningIdentities,
} from "../apps/market/src/lib/guest-order-identity"

function fakeStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe("guest order signing identity", () => {
  it("creates a unique ephemeral buyer identity that can sign order rumors", async () => {
    const merchantPubkey = "a".repeat(64)
    const first = createGuestOrderSigningIdentity("order-1", merchantPubkey)
    const second = createGuestOrderSigningIdentity("order-2", merchantPubkey)

    expect(first.kind).toBe("guest_ephemeral")
    expect(first.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(second.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(first.pubkey).not.toBe(second.pubkey)

    const event = new NDKEvent()
    event.kind = 16
    event.created_at = 1_700_000_000
    event.tags = [
      ["p", merchantPubkey],
      ["type", "order"],
      ["order", "order-1"],
    ]
    event.content = "order payload"

    await signGuestEvent(event, first.signer)

    expect(event.pubkey).toBe(first.pubkey)
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/)
  })

  it("does not expose raw private key serialization on the guest signer", () => {
    const identity = createGuestOrderSigningIdentity(
      "order-serialization",
      "a".repeat(64)
    )

    expect("privateKey" in identity.signer).toBe(false)
    expect("nsec" in identity.signer).toBe(false)
    expect("toPayload" in identity.signer).toBe(false)
    expect(JSON.stringify(identity)).not.toContain("nsec")
    expect(JSON.stringify(identity)).not.toContain("private")
    expect("authMethod" in identity.signer).toBe(false)
    expect("revision" in identity.signer).toBe(false)
    expect(() =>
      installProtectedReadSigner(identity.signer, identity.pubkey, () => true)
    ).toThrow("Protected reads require a NIP-07 or NIP-46 account signer")
  })

  it("rejects public events and messages outside the guest order scope", async () => {
    const merchantPubkey = "a".repeat(64)
    const identity = createGuestOrderSigningIdentity(
      "scoped-order",
      merchantPubkey
    )
    const publicProduct = new NDKEvent()
    publicProduct.kind = 30402
    publicProduct.tags = [["d", "not-allowed"]]

    await expect(
      signGuestEvent(publicProduct, identity.signer)
    ).rejects.toThrow("Guest signer can only sign private order envelopes.")

    const otherOrder = new NDKEvent()
    otherOrder.kind = 16
    otherOrder.tags = [
      ["p", merchantPubkey],
      ["type", "order"],
      ["order", "different-order"],
    ]
    await expect(signGuestEvent(otherOrder, identity.signer)).rejects.toThrow(
      "Guest signer cannot sign outside its order scope."
    )

    const unsupportedMessage = new NDKEvent()
    unsupportedMessage.kind = 16
    unsupportedMessage.tags = [
      ["p", merchantPubkey],
      ["type", "message"],
      ["order", "scoped-order"],
    ]
    await expect(
      signGuestEvent(unsupportedMessage, identity.signer)
    ).rejects.toThrow("Guest signer cannot sign outside its order scope.")

    await expect(
      identity.signer.decryptNip44("merchant", "ciphertext")
    ).rejects.toThrow("Guest order signer cannot decrypt inbound messages.")
  })

  it("rejects recovery rumors while preserving same-order payment reports", async () => {
    const merchantPubkey = "a".repeat(64)
    const identity = createGuestOrderSigningIdentity(
      "recovery-order",
      merchantPubkey
    )
    const recovery = new NDKEvent()
    recovery.kind = 16
    recovery.tags = [
      ["p", merchantPubkey],
      ["type", "checkout_spark_recovery"],
      ["order", "recovery-order"],
    ]
    recovery.content = "encrypted later by the NIP-59 wrapper"

    await expect(signGuestEvent(recovery, identity.signer)).rejects.toThrow(
      "Guest signer cannot sign outside its order scope."
    )

    const payment = new NDKEvent()
    payment.kind = 16
    payment.tags = [
      ["p", merchantPubkey],
      ["type", "payment_proof"],
      ["order", "recovery-order"],
    ]
    await signGuestEvent(payment, identity.signer)
    expect(payment.pubkey).toBe(identity.pubkey)
    expect(payment.sig).toMatch(/^[0-9a-f]{128}$/)

    const otherMerchant = new NDKEvent()
    otherMerchant.kind = 16
    otherMerchant.tags = [
      ["p", "b".repeat(64)],
      ["type", "checkout_spark_recovery"],
      ["order", "recovery-order"],
    ]
    await expect(
      signGuestEvent(otherMerchant, identity.signer)
    ).rejects.toThrow("Guest signer cannot sign outside its order scope.")
  })

  it("restores an order-scoped signer from session storage", async () => {
    const storage = fakeStorage()
    const merchantPubkey = "a".repeat(64)
    const createdAt = Date.now()
    const created = createSessionGuestOrderSigningIdentity(
      "order-1",
      merchantPubkey,
      {
        storage,
        nowMs: createdAt,
      }
    )
    const restored = getSessionGuestOrderSigningIdentity(
      "order-1",
      storage,
      createdAt + 1
    )

    expect(restored?.kind).toBe("guest_ephemeral")
    expect(restored?.pubkey).toBe(created.pubkey)
    expect(created.createdAt).toBe(createdAt)
    expect(restored?.createdAt).toBe(createdAt)
    expect(restored?.expiresAt).toBe(createdAt + GUEST_ORDER_SESSION_TTL_MS)

    const event = new NDKEvent()
    event.kind = 16
    event.created_at = 1_700_000_000
    event.tags = [
      ["p", merchantPubkey],
      ["type", "payment_proof"],
      ["order", "order-1"],
    ]
    event.content = "payment proof"

    await signGuestEvent(event, restored!.signer)

    expect(event.pubkey).toBe(created.pubkey)
    expect(JSON.stringify(restored)).not.toContain("private")
  })

  it("clears an order-scoped signer from session storage", () => {
    const storage = fakeStorage()
    createSessionGuestOrderSigningIdentity("order-clear", "a".repeat(64), {
      storage,
    })
    expect(
      getSessionGuestOrderSigningIdentity("order-clear", storage)
    ).not.toBeNull()

    clearSessionGuestOrderSigningIdentity("order-clear", storage)

    expect(
      getSessionGuestOrderSigningIdentity("order-clear", storage)
    ).toBeNull()
  })

  it("expires session guest signers after the bounded recovery window", () => {
    const storage = fakeStorage()
    const createdAt = 1_700_000_000_000
    createSessionGuestOrderSigningIdentity("order-expired", "a".repeat(64), {
      storage,
      nowMs: createdAt,
    })

    expect(
      getSessionGuestOrderSigningIdentity(
        "order-expired",
        storage,
        createdAt + GUEST_ORDER_SESSION_TTL_MS - 1
      )
    ).not.toBeNull()
    expect(
      getSessionGuestOrderSigningIdentity(
        "order-expired",
        storage,
        createdAt + GUEST_ORDER_SESSION_TTL_MS
      )
    ).toBeNull()
  })

  it("rejects guest signers timestamped in the future", () => {
    const storage = fakeStorage()
    const now = 1_700_000_000_000
    createSessionGuestOrderSigningIdentity("order-future", "a".repeat(64), {
      storage,
      nowMs: now + 1,
    })

    expect(
      getSessionGuestOrderSigningIdentity("order-future", storage, now)
    ).toBeNull()
  })

  it("prunes every expired raw guest key during session maintenance", () => {
    const storage = fakeStorage()
    const createdAt = 1_700_000_000_000
    createSessionGuestOrderSigningIdentity("order-expired-a", "a".repeat(64), {
      storage,
      nowMs: createdAt,
    })
    createSessionGuestOrderSigningIdentity("order-expired-b", "b".repeat(64), {
      storage,
      nowMs: createdAt,
    })

    expect(
      pruneExpiredSessionGuestOrderSigningIdentities(
        storage,
        createdAt + GUEST_ORDER_SESSION_TTL_MS
      )
    ).toBe(2)
    expect(
      getSessionGuestOrderSigningIdentity(
        "order-expired-a",
        storage,
        createdAt + GUEST_ORDER_SESSION_TTL_MS
      )
    ).toBeNull()
    expect(
      getSessionGuestOrderSigningIdentity(
        "order-expired-b",
        storage,
        createdAt + GUEST_ORDER_SESSION_TTL_MS
      )
    ).toBeNull()
  })

  it("removes malformed guest signer registry entries without throwing", () => {
    const storage = fakeStorage()
    storage.setItem(
      "conduit:guest-order-signers:v1",
      JSON.stringify({ broken: null })
    )

    expect(() =>
      pruneExpiredSessionGuestOrderSigningIdentities(storage)
    ).not.toThrow()
    expect(storage.getItem("conduit:guest-order-signers:v1")).toBeNull()
  })

  it("keeps a same-page fallback when session storage rejects writes", () => {
    const storage = fakeStorage()
    storage.setItem = () => {
      throw new Error("storage denied")
    }
    const created = createSessionGuestOrderSigningIdentity(
      "order-memory",
      "a".repeat(64),
      { storage }
    )

    const restored = getSessionGuestOrderSigningIdentity(
      "order-memory",
      storage
    )
    expect(restored?.pubkey).toBe(created.pubkey)

    clearSessionGuestOrderSigningIdentity("order-memory", storage)
  })

  it("keeps a same-page fallback when session storage is unavailable", () => {
    const created = createSessionGuestOrderSigningIdentity(
      "order-no-storage",
      "a".repeat(64),
      { storage: null }
    )

    expect(
      getSessionGuestOrderSigningIdentity("order-no-storage", null)?.pubkey
    ).toBe(created.pubkey)

    clearSessionGuestOrderSigningIdentity("order-no-storage", null)
  })
})

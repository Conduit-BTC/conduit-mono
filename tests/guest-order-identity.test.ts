import { describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"

import {
  clearSessionGuestOrderSigningIdentity,
  createGuestOrderSigningIdentity,
  createSessionGuestOrderSigningIdentity,
  getSessionGuestOrderSigningIdentity,
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
    const first = createGuestOrderSigningIdentity()
    const second = createGuestOrderSigningIdentity()

    expect(first.kind).toBe("guest_ephemeral")
    expect(first.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(second.pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(first.pubkey).not.toBe(second.pubkey)

    const event = new NDKEvent()
    event.kind = 16
    event.created_at = 1_700_000_000
    event.tags = [["p", "a".repeat(64)]]
    event.content = "order payload"

    await event.sign(first.signer)

    expect(event.pubkey).toBe(first.pubkey)
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/)
  })

  it("does not expose raw private key serialization on the guest signer", () => {
    const identity = createGuestOrderSigningIdentity()

    expect("privateKey" in identity.signer).toBe(false)
    expect("nsec" in identity.signer).toBe(false)
    expect(() => identity.signer.toPayload()).toThrow(
      "Guest order signer is ephemeral and cannot be serialized."
    )
    expect(JSON.stringify(identity)).not.toContain("nsec")
    expect(JSON.stringify(identity)).not.toContain("private")
  })

  it("restores an order-scoped signer from session storage", async () => {
    const storage = fakeStorage()
    const created = createSessionGuestOrderSigningIdentity("order-1", {
      storage,
      nowMs: 1_700_000_000_000,
    })
    const restored = getSessionGuestOrderSigningIdentity("order-1", storage)

    expect(restored?.kind).toBe("guest_ephemeral")
    expect(restored?.pubkey).toBe(created.pubkey)

    const event = new NDKEvent()
    event.kind = 16
    event.created_at = 1_700_000_000
    event.tags = [["p", "a".repeat(64)]]
    event.content = "payment proof"

    await event.sign(restored!.signer)

    expect(event.pubkey).toBe(created.pubkey)
    expect(JSON.stringify(restored)).not.toContain("private")
  })

  it("clears an order-scoped signer from session storage", () => {
    const storage = fakeStorage()
    createSessionGuestOrderSigningIdentity("order-1", { storage })
    expect(
      getSessionGuestOrderSigningIdentity("order-1", storage)
    ).not.toBeNull()

    clearSessionGuestOrderSigningIdentity("order-1", storage)

    expect(getSessionGuestOrderSigningIdentity("order-1", storage)).toBeNull()
  })
})

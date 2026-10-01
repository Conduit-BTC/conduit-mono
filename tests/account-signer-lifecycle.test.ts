import {
  setTestAccountSigner as setSigner,
  removeTestAccountSigner as removeSigner,
  clearTestAccountSigner,
} from "./helpers/plain-signer"
import { getAccountSigner } from "../packages/core/src/protocol/session-signer"
import { afterEach, describe, expect, it } from "bun:test"
import { type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  __resetNdkTestState,
  disconnectNdk,
  getNdk,
  refreshNdkRelaySettings,
} from "../packages/core/src/protocol/ndk"

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window"
)

function restoreWindow(): void {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor)
    return
  }

  Reflect.deleteProperty(globalThis, "window")
}

function fakeSigner(pubkey: string): NDKSigner {
  return {
    pubkey,
    user: async () => ({ pubkey }),
  } as NDKSigner
}

describe("account authority independent of relay-client lifecycle", () => {
  afterEach(() => {
    clearTestAccountSigner()
    __resetNdkTestState()
    disconnectNdk()
    restoreWindow()
  })

  it("keeps the connected signer across a relay-client reset", () => {
    const activeSigner = fakeSigner("a".repeat(64))

    const account = setSigner(activeSigner)
    disconnectNdk()

    expect(getAccountSigner()).toBe(account)
    expect(getNdk().signer).toBeUndefined()
  })

  it("keeps the connected signer when relay settings rebuild the client", () => {
    const activeSigner = fakeSigner("a".repeat(64))

    const account = setSigner(activeSigner)
    refreshNdkRelaySettings()

    expect(getAccountSigner()).toBe(account)
    expect(getNdk().signer).toBeUndefined()
  })

  it("constructs an offline compatibility context without ambient relays", () => {
    const ndk = getNdk()

    expect(ndk.explicitRelayUrls).toEqual([])
    expect(ndk.outboxPool).toBeUndefined()
    expect(ndk.autoConnectUserRelays).toBe(false)
    expect(ndk.pool.relays.size).toBe(0)
  })

  it("does not let stale auth cleanup remove a newer connected signer", () => {
    const staleSigner = fakeSigner("a".repeat(64))
    const activeSigner = fakeSigner("b".repeat(64))

    const staleLease = setSigner(staleSigner)
    const account = setSigner(activeSigner)
    removeSigner(staleLease)

    expect(getAccountSigner()).toBe(account)
  })

  it("lets the active auth lifecycle remove its own signer", () => {
    const activeSigner = fakeSigner("a".repeat(64))
    const activeLease = setSigner(activeSigner)

    removeSigner(activeLease)

    expect(getAccountSigner()).toBeUndefined()
  })

  it("does not derive account authority from a divergent client signer", () => {
    const activeSigner = fakeSigner("a".repeat(64))
    const divergentSigner = fakeSigner("b".repeat(64))
    const activeLease = setSigner(activeSigner)
    getNdk().signer = divergentSigner

    removeSigner(activeLease)

    expect(getAccountSigner()).toBeUndefined()
    expect(getNdk().signer).toBe(divergentSigner)
  })

  it("does not read relay settings while installing a signer", () => {
    const activeSigner = fakeSigner("a".repeat(64))

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem() {
            throw new Error("Storage access denied")
          },
        },
      },
    })

    expect(() => setSigner(activeSigner)).not.toThrow()

    restoreWindow()

    expect(getAccountSigner()?.pubkey).toBe(activeSigner.pubkey)
  })

  it("does not ask an installed signer for relays", () => {
    let relayLookups = 0
    const activeSigner = {
      ...fakeSigner("a".repeat(64)),
      relays: async () => {
        relayLookups += 1
        return []
      },
    } as NDKSigner

    setSigner(activeSigner)

    expect(relayLookups).toBe(0)
    expect(getNdk().pool.relays.size).toBe(0)
  })

  it("disconnects explicitly planned relay sockets before dropping the adapter", () => {
    const ndk = getNdk()
    let disconnects = 0
    ndk.pool.relays.set("wss://relay.example/", {
      disconnect() {
        disconnects += 1
      },
    } as never)

    disconnectNdk()

    expect(disconnects).toBe(1)
  })
})

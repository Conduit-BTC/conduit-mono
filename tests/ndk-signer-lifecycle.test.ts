import { afterEach, describe, expect, it } from "bun:test"
import NDK, { type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  __resetNdkTestState,
  disconnectNdk,
  getNdk,
  refreshNdkRelaySettings,
  removeSigner,
  requireNdkConnected,
  setSigner,
} from "../packages/core/src/protocol/ndk"

const originalNdkConnect = NDK.prototype.connect

function fakeSigner(pubkey: string): NDKSigner {
  return {
    pubkey,
    user: async () => ({ pubkey }),
  } as NDKSigner
}

describe("NDK signer lifecycle", () => {
  afterEach(() => {
    NDK.prototype.connect = originalNdkConnect
    __resetNdkTestState()
    disconnectNdk()
  })

  it("keeps the connected signer across a relay-client reset", () => {
    const activeSigner = fakeSigner("a".repeat(64))

    setSigner(activeSigner)
    disconnectNdk()

    expect(getNdk().signer).toBe(activeSigner)
  })

  it("keeps the connected signer when relay settings rebuild the client", () => {
    const activeSigner = fakeSigner("a".repeat(64))

    setSigner(activeSigner)
    refreshNdkRelaySettings()

    expect(getNdk().signer).toBe(activeSigner)
  })

  it("uses the active signer lease when a connection retry rebuilds the client", async () => {
    const staleSigner = fakeSigner("a".repeat(64))
    const activeSigner = fakeSigner("b".repeat(64))

    NDK.prototype.connect = async () => {}
    setSigner(activeSigner)
    getNdk().signer = staleSigner

    await expect(requireNdkConnected(1)).rejects.toThrow(
      "No relays responded within timeout"
    )

    expect(getNdk().signer).toBe(activeSigner)
  })

  it("does not let stale auth cleanup remove a newer connected signer", () => {
    const staleSigner = fakeSigner("a".repeat(64))
    const activeSigner = fakeSigner("b".repeat(64))

    const staleLease = setSigner(staleSigner)
    setSigner(activeSigner)
    removeSigner(staleLease)

    expect(getNdk().signer).toBe(activeSigner)
  })

  it("lets the active auth lifecycle remove its own signer", () => {
    const activeSigner = fakeSigner("a".repeat(64))
    const activeLease = setSigner(activeSigner)

    removeSigner(activeLease)

    expect(getNdk().signer).toBeUndefined()
  })

  it("clears a divergent client signer when the active lifecycle disconnects", () => {
    const activeSigner = fakeSigner("a".repeat(64))
    const divergentSigner = fakeSigner("b".repeat(64))
    const activeLease = setSigner(activeSigner)
    getNdk().signer = divergentSigner

    removeSigner(activeLease)

    expect(getNdk().signer).toBeUndefined()
  })
})

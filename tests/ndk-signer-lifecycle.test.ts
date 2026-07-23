import { afterEach, describe, expect, it } from "bun:test"
import type { NDKSigner } from "@nostr-dev-kit/ndk"
import {
  disconnectNdk,
  getNdk,
  refreshNdkRelaySettings,
  removeSigner,
  setSigner,
} from "@conduit/core"

afterEach(() => {
  removeSigner()
  disconnectNdk()
})

describe("NDK signer lifecycle", () => {
  it("reattaches the active signer whenever relay settings rebuild NDK", () => {
    const signer = {
      user: async () => ({ pubkey: "1".repeat(64) }),
    } as NDKSigner
    setSigner(signer)
    const before = getNdk()

    refreshNdkRelaySettings(null)
    const after = getNdk()

    expect(after).not.toBe(before)
    expect(after.signer).toBe(signer)
  })

  it("does not reattach a signer after removal or disconnect", () => {
    const signer = {
      user: async () => ({ pubkey: "1".repeat(64) }),
    } as NDKSigner
    setSigner(signer)
    removeSigner()
    refreshNdkRelaySettings(null)
    expect(getNdk().signer).toBeUndefined()

    setSigner(signer)
    disconnectNdk()
    expect(getNdk().signer).toBeUndefined()
  })
})

import { describe, expect, it } from "bun:test"
import {
  getAuthSignerReadiness,
  getRetainedAuthAccountPubkey,
  isExactDeliveryRetryScopeCurrent,
} from "../packages/core/src/context/AuthContext"
import type { Nip46AuthSession } from "../packages/core/src/protocol/remote-signer"

const owner = "a".repeat(64)
const other = "b".repeat(64)
const session: Nip46AuthSession = {
  version: 1,
  type: "nip46",
  userPubkey: owner,
  remoteSignerPubkey: other,
  relayUrls: ["wss://relay.example"],
  clientKeyId: "saved-client",
  createdAt: 1,
  updatedAt: 1,
}

function recoverableScope() {
  return {
    owner,
    generation: 7,
    currentGeneration: 7,
    connected: false,
    connecting: false,
    activeSession: null,
    recoverySession: session,
    recoveryAvailable: true,
    retirementBlocked: false,
    retainedRevision: "recovery-revision",
    currentRevision: "recovery-revision",
    storedSession: session,
  }
}

describe("exact signed handoff retry authority", () => {
  it("allows the retained NIP-46 owner to replay saved wraps without a signer", () => {
    expect(getRetainedAuthAccountPubkey(session, true)).toBe(owner)
    expect(
      getAuthSignerReadiness({
        status: "error",
        pubkey: owner,
        signer: null,
        capabilities: {
          signEvent: false,
          nip44: false,
          nip04Decrypt: false,
        },
        remoteSignerState: "recoverable",
      })
    ).toBe("unavailable")
    expect(isExactDeliveryRetryScopeCurrent(recoverableScope())).toBe(true)
  })

  it("synchronously rejects logout, account switch, and session retirement before rerender", () => {
    const scope = recoverableScope()
    expect(
      isExactDeliveryRetryScopeCurrent({
        ...scope,
        currentGeneration: scope.generation + 1,
      })
    ).toBe(false)
    expect(isExactDeliveryRetryScopeCurrent({ ...scope, owner: other })).toBe(
      false
    )
    expect(
      isExactDeliveryRetryScopeCurrent({ ...scope, retirementBlocked: true })
    ).toBe(false)
    expect(
      isExactDeliveryRetryScopeCurrent({
        ...scope,
        currentRevision: "replacement-revision",
      })
    ).toBe(false)
    expect(
      isExactDeliveryRetryScopeCurrent({ ...scope, storedSession: null })
    ).toBe(false)
    expect(
      isExactDeliveryRetryScopeCurrent({
        ...scope,
        storedSession: { ...session, clientKeyId: "replacement-client" },
      })
    ).toBe(false)
  })

  it("rejects retained identity without recovery authority or during reconnect", () => {
    const scope = recoverableScope()
    expect(
      isExactDeliveryRetryScopeCurrent({
        ...scope,
        recoveryAvailable: false,
      })
    ).toBe(false)
    expect(
      isExactDeliveryRetryScopeCurrent({ ...scope, connecting: true })
    ).toBe(false)
  })
})

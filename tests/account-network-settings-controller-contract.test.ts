import { describe, expect, it } from "bun:test"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { createCandidateNetworkRelayRow } from "../packages/core/src/protocol/network-settings-view"

describe("account Network settings controller contract", () => {
  it("accepts an owner-selected ws candidate before relay I/O or storage", () => {
    const localState = emptyAccountNetworkLocalState("a".repeat(64))
    expect(
      createCandidateNetworkRelayRow({
        url: "ws://owner-selected.example",
        localState,
      }).url
    ).toBe("ws://owner-selected.example")
    expect(() =>
      createCandidateNetworkRelayRow({
        url: "ftp://not-a-relay.example",
        localState,
      })
    ).toThrow("ws:// or wss://")
  })
})

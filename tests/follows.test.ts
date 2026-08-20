import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetFollowListTestState,
  __setFollowListTestOverrides,
  buildContactListUpdateTags,
  extractFollowPubkeys,
  publishContactListUpdate,
} from "@conduit/core"

const ALICE_PUBKEY = "1".repeat(64)
const BOB_PUBKEY = "2".repeat(64)

afterEach(() => {
  __resetFollowListTestState()
})

describe("NIP-02 follow helpers", () => {
  it("extracts only valid hex pubkeys from contact-list tags", () => {
    expect(
      extractFollowPubkeys([
        ["p", "alice"],
        ["p", ALICE_PUBKEY],
        ["p", ALICE_PUBKEY.toUpperCase()],
        ["e", BOB_PUBKEY],
      ])
    ).toEqual([ALICE_PUBKEY])
  })

  it("adds follows without duplicating existing p tags", () => {
    expect(
      buildContactListUpdateTags({
        currentTags: [["p", ALICE_PUBKEY]],
        targetPubkey: BOB_PUBKEY,
        shouldFollow: true,
      })
    ).toEqual([
      ["p", ALICE_PUBKEY],
      ["p", BOB_PUBKEY],
    ])

    expect(
      buildContactListUpdateTags({
        currentTags: [["p", ALICE_PUBKEY.toUpperCase()]],
        targetPubkey: ALICE_PUBKEY,
        shouldFollow: true,
      })
    ).toEqual([["p", ALICE_PUBKEY.toUpperCase()]])
  })

  it("removes the requested follow while preserving unrelated tags", () => {
    expect(
      buildContactListUpdateTags({
        currentTags: [
          ["p", ALICE_PUBKEY],
          ["p", BOB_PUBKEY],
          ["client", "Other app"],
        ],
        targetPubkey: BOB_PUBKEY,
        shouldFollow: false,
      })
    ).toEqual([
      ["p", ALICE_PUBKEY],
      ["client", "Other app"],
    ])
  })

  it("rejects invalid target pubkeys", () => {
    expect(() =>
      buildContactListUpdateTags({
        currentTags: [["p", ALICE_PUBKEY]],
        targetPubkey: "not-a-pubkey",
        shouldFollow: true,
      })
    ).toThrow("invalid target pubkey")
  })

  it("stops before signing, publishing, or persisting when the session changes during preflight", async () => {
    let sessionCurrent = true
    let publishCalls = 0
    let persistCalls = 0
    const signer = {
      user: async () => ({ pubkey: ALICE_PUBKEY }),
    }

    __setFollowListTestOverrides({
      getNdk: () => ({ signer }) as never,
      readLatestFollowLists: (async () => {
        sessionCurrent = false
        return {
          events: [],
          authors: [
            {
              pubkey: ALICE_PUBKEY,
              eventSourceRelayUrls: [],
              hintRelayUrls: ["wss://owner.example"],
              plannedRelayUrls: ["wss://owner.example"],
              relays: [
                {
                  relayUrl: "wss://owner.example",
                  status: "success",
                  eventCount: 0,
                  rejectedEventCount: 0,
                },
              ],
              eventsVerified: true,
              coverage: "complete",
              relayListState: "network",
              relayHintTruncated: false,
              snapshotState: "none",
            },
          ],
          plannedRelayUrls: ["wss://owner.example"],
          relays: [],
          eventsVerified: true,
        }
      }) as never,
      putOwnContactListSnapshot: async () => {
        persistCalls += 1
      },
      publishWithPlanner: async () => {
        publishCalls += 1
        return {} as never
      },
    })

    await expect(
      publishContactListUpdate({
        ownerPubkey: ALICE_PUBKEY,
        targetPubkey: BOB_PUBKEY,
        shouldFollow: true,
        appId: "market",
        isSessionCurrent: () => sessionCurrent,
      })
    ).rejects.toThrow("Signer session changed while updating the follow list")
    expect(persistCalls).toBe(0)
    expect(publishCalls).toBe(0)
  })
})

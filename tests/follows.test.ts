import { describe, expect, it } from "bun:test"
import { buildContactListUpdateTags, extractFollowPubkeys } from "@conduit/core"

const ALICE_PUBKEY = "1".repeat(64)
const BOB_PUBKEY = "2".repeat(64)

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
})

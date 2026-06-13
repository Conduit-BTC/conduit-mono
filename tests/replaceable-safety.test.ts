import { describe, expect, it } from "bun:test"
import {
  assertSafeReplaceablePublish,
  countActiveRelayListTags,
  countDistinctContactListPubkeys,
  countMeaningfulProfileFields,
  EVENT_KINDS,
  ReplaceablePublishSafetyError,
} from "@conduit/core"

const ALICE_PUBKEY = "1".repeat(64)
const BOB_PUBKEY = "2".repeat(64)

describe("replaceable publish safety", () => {
  it("counts meaningful NIP-01 profile fields defensively", () => {
    expect(countMeaningfulProfileFields("{}")).toBe(0)
    expect(countMeaningfulProfileFields("{not json")).toBe(0)
    expect(
      countMeaningfulProfileFields(JSON.stringify({ name: "Alice" }))
    ).toBe(1)
    expect(
      countMeaningfulProfileFields(
        JSON.stringify({ display_name: "Alice", displayName: "Alice" })
      )
    ).toBe(1)
    expect(
      countMeaningfulProfileFields(
        JSON.stringify({ display_name: "Alice", about: "Merchant" })
      )
    ).toBe(2)
  })

  it("refuses empty or one-field profile replacements", () => {
    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.PROFILE,
        content: JSON.stringify({ name: "Alice" }),
      })
    ).toThrow(ReplaceablePublishSafetyError)

    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.PROFILE,
        content: JSON.stringify({ name: "Alice", about: "Merchant" }),
      })
    ).not.toThrow()
  })

  it("does not allow callers to relax tiny profile replacements", () => {
    const legacyRelaxedOptions = {
      profile: { enforceMinimumFields: false },
    } as Parameters<typeof assertSafeReplaceablePublish>[1]

    expect(() =>
      assertSafeReplaceablePublish(
        {
          kind: EVENT_KINDS.PROFILE,
          content: JSON.stringify({ name: "Alice" }),
        },
        legacyRelaxedOptions
      )
    ).toThrow(ReplaceablePublishSafetyError)
  })

  it("counts distinct contact-list pubkeys and ignores malformed tags", () => {
    expect(
      countDistinctContactListPubkeys([
        ["p"],
        ["p", ""],
        ["p", "alice"],
        ["p", ALICE_PUBKEY],
        ["p", ALICE_PUBKEY.toUpperCase()],
        ["e", "event"],
      ])
    ).toBe(1)

    expect(
      countDistinctContactListPubkeys([
        ["p", ALICE_PUBKEY],
        ["p", BOB_PUBKEY],
      ])
    ).toBe(2)
  })

  it("does not count malformed contact-list pubkeys as safety evidence", () => {
    expect(
      countDistinctContactListPubkeys([
        ["p", "alice"],
        ["p", "bob"],
      ])
    ).toBe(0)

    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.CONTACT_LIST,
        tags: [
          ["p", "alice"],
          ["p", "bob"],
        ],
      })
    ).toThrow("tiny follow list")
  })

  it("refuses empty, duplicate-only, or one-person contact-list replacements", () => {
    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.CONTACT_LIST,
        tags: [["p", ALICE_PUBKEY]],
      })
    ).toThrow(ReplaceablePublishSafetyError)

    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.CONTACT_LIST,
        tags: [
          ["p", ALICE_PUBKEY],
          ["p", ALICE_PUBKEY],
        ],
      })
    ).toThrow("tiny follow list")

    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.CONTACT_LIST,
        tags: [
          ["p", ALICE_PUBKEY],
          ["p", BOB_PUBKEY],
        ],
      })
    ).not.toThrow()
  })

  it("allows a controlled tiny contact-list update with loaded snapshot context", () => {
    expect(() =>
      assertSafeReplaceablePublish(
        {
          kind: EVENT_KINDS.CONTACT_LIST,
          tags: [["p", ALICE_PUBKEY]],
        },
        { contactList: { enforceMinimumPubkeys: false } }
      )
    ).not.toThrow()
  })

  it("counts active relay-list tags after normalization", () => {
    expect(
      countActiveRelayListTags([
        ["r", "relay.example.com/"],
        ["r", "wss://relay.example.com", "write"],
        ["r", "not a url"],
      ])
    ).toBe(1)

    expect(
      countActiveRelayListTags([
        ["r", "wss://read.example", "read"],
        ["r", "wss://write.example", "write"],
      ])
    ).toBe(2)
  })

  it("refuses empty, malformed, duplicate-only, or one-relay NIP-65 replacements", () => {
    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.RELAY_LIST,
        tags: [["r", "wss://only.example"]],
      })
    ).toThrow(ReplaceablePublishSafetyError)

    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.RELAY_LIST,
        tags: [
          ["r", "wss://only.example"],
          ["r", "only.example", "write"],
        ],
      })
    ).toThrow("tiny NIP-65 relay list")

    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.RELAY_LIST,
        tags: [
          ["r", "wss://read.example", "read"],
          ["r", "wss://write.example", "write"],
        ],
      })
    ).not.toThrow()
  })

  it("does not block non-targeted replaceable or addressable events", () => {
    expect(() =>
      assertSafeReplaceablePublish({
        kind: EVENT_KINDS.PRODUCT,
        tags: [["d", "one-product"]],
        content: "",
      })
    ).not.toThrow()
  })
})

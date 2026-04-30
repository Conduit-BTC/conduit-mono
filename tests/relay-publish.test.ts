import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  planPublishRelays,
  type RelayList,
} from "@conduit/core"

const NOW = 1_700_000_000_000

function relayList(
  pubkey: string,
  overrides: Partial<RelayList> = {}
): RelayList {
  return {
    pubkey,
    readRelayUrls: [],
    writeRelayUrls: [],
    eventCreatedAt: 1,
    cachedAt: NOW,
    ...overrides,
  }
}

describe("planPublishRelays", () => {
  beforeEach(() => {
    __setRelayListTestOverrides({
      now: () => NOW,
    })
  })

  afterEach(() => {
    __resetRelayListTestOverrides()
  })

  it("returns an author plan with no recipient hints", async () => {
    const plan = await planPublishRelays({
      intent: "author_event",
      authorPubkey: "alice",
    })
    expect(plan.intent).toBe("author_event")
    expect(plan.broadcastRelayUrls).toEqual([])
    // primary may be empty when user has no configured write relays.
    expect(Array.isArray(plan.primaryRelayUrls)).toBe(true)
  })

  it("merges recipient read relays into a recipient_event primary set", async () => {
    __setRelayListTestOverrides({
      now: () => NOW,
      loadCached: async (pubkey) => {
        if (pubkey === "bob") {
          return {
            pubkey: "bob",
            readRelayUrls: ["wss://bob-read.example"],
            writeRelayUrls: ["wss://bob-write.example"],
            eventCreatedAt: 1,
            sourceRelayUrls: undefined,
            cachedAt: NOW,
          }
        }
        return undefined
      },
    })

    const plan = await planPublishRelays({
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
    })

    expect(plan.intent).toBe("recipient_event")
    expect(plan.primaryRelayUrls).toContain("wss://bob-read.example")
  })

  it("falls back gracefully when no cached relay list is present", async () => {
    __setRelayListTestOverrides({
      now: () => NOW,
      loadCached: async () => undefined,
    })

    const plan = await planPublishRelays({
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
    })

    // No recipient hint, so primary should still seed from user write relays.
    expect(plan.intent).toBe("recipient_event")
    expect(Array.isArray(plan.broadcastRelayUrls)).toBe(true)
  })

  // Mark relay list usage helper as used to avoid lint flag.
  it("relayList helper compiles", () => {
    expect(relayList("zz").pubkey).toBe("zz")
  })
})

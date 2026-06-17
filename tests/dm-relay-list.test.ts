import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetDmRelayListTestOverrides,
  __setDmRelayListTestOverrides,
  EVENT_KINDS,
  getDmRelayLists,
  parseDmRelayListEvent,
  pickLatestDmRelayListEvent,
} from "@conduit/core"

afterEach(() => {
  __resetDmRelayListTestOverrides()
})

describe("NIP-17 DM relay lists", () => {
  it("parses kind:10050 relay tags without NIP-65 read/write semantics", () => {
    const parsed = parseDmRelayListEvent(
      {
        pubkey: "alice",
        created_at: 10,
        tags: [
          ["relay", "relay.example.com/"],
          ["relay", "wss://Relay.Example.com"],
          ["r", "wss://nip65.example", "read"],
          ["relay"],
        ],
      },
      {
        cachedAt: 25,
        sourceRelayUrls: ["wss://source.example/"],
      }
    )

    expect(parsed).toEqual({
      pubkey: "alice",
      relayUrls: ["wss://relay.example.com"],
      eventCreatedAt: 10,
      sourceRelayUrls: ["wss://source.example"],
      cachedAt: 25,
    })
  })

  it("picks the newest kind:10050 event for a pubkey", () => {
    const latest = pickLatestDmRelayListEvent(
      [
        { pubkey: "alice", created_at: 10 },
        { pubkey: "bob", created_at: 30 },
        { pubkey: "alice", created_at: 20 },
      ],
      "alice"
    )

    expect(latest?.created_at).toBe(20)
  })

  it("fetches missing DM relay lists with kind:10050 filters", async () => {
    const requested: Array<{
      kinds?: number[]
      authors?: string[]
      relayUrls?: string[]
    }> = []

    __setDmRelayListTestOverrides({
      now: () => 100,
      loadCached: async () => undefined,
      putCached: async () => undefined,
      fetchEventsFanout: async (filter, options) => {
        requested.push({
          kinds: filter.kinds,
          authors: filter.authors,
          relayUrls: options?.relayUrls,
        })
        return [
          {
            pubkey: "alice",
            created_at: 50,
            tags: [["relay", "wss://alice-inbox.example"]],
          },
        ] as never
      },
    })

    const lists = await getDmRelayLists(["alice"], {
      relayUrls: ["wss://discovery.example"],
    })

    expect(requested).toEqual([
      {
        kinds: [EVENT_KINDS.DM_RELAY_LIST],
        authors: ["alice"],
        relayUrls: ["wss://discovery.example"],
      },
    ])
    expect(lists.get("alice")?.relayUrls).toEqual(["wss://alice-inbox.example"])
  })
})

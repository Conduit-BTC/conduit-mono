import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetRelayHealth,
  config,
  normalizeRelaySettingsState,
  planRelayReads,
  planRelayWrites,
  recordRelayFailure,
  type RelayList,
  type RelaySettingsEntry,
  type RelaySettingsState,
} from "@conduit/core"

function entry(
  url: string,
  overrides: Partial<RelaySettingsEntry> = {}
): RelaySettingsEntry {
  return {
    url,
    readEnabled: true,
    writeEnabled: false,
    section: "public",
    capabilities: {
      nip11: true,
      search: false,
      dm: false,
      auth: false,
      commerce: false,
    },
    warnings: {
      dmWithoutAuth: false,
      staleRelayInfo: false,
      unreachable: false,
      commercePartialSupport: false,
    },
    ...overrides,
  }
}

function settings(entries: RelaySettingsEntry[]): RelaySettingsState {
  return normalizeRelaySettingsState({
    version: 1,
    entries,
    updatedAt: 1,
  })
}

function relayList(
  pubkey: string,
  reads: string[],
  writes: string[]
): RelayList {
  return {
    pubkey,
    readRelayUrls: reads,
    writeRelayUrls: writes,
    eventCreatedAt: 1,
    cachedAt: 1,
  }
}

describe("planRelayReads", () => {
  beforeEach(() => {
    __resetRelayHealth()
  })
  afterEach(() => {
    __resetRelayHealth()
  })

  it("uses commerce relays for commerce_products intent", () => {
    const state = settings([
      entry("wss://commerce.example.com", {
        section: "commerce",
        readEnabled: true,
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: true,
          dm: false,
          auth: false,
          commerce: true,
        },
      }),
      entry("wss://public.example.com", {
        section: "public",
        readEnabled: true,
      }),
    ])
    const plan = planRelayReads({
      intent: "commerce_products",
      settings: state,
    })
    expect(plan.relayUrls[0]).toBe("wss://commerce.example.com")
    expect(plan.relayUrls).toContain("wss://public.example.com")
  })

  it("prepends author write relays as hints for author_products", () => {
    const state = settings([
      entry("wss://commerce.example.com", { section: "commerce" }),
    ])
    const lists = new Map<string, RelayList>([
      [
        "alice",
        relayList(
          "alice",
          ["wss://alice-read.example.com"],
          ["wss://alice-write.example.com"]
        ),
      ],
    ])
    const plan = planRelayReads({
      intent: "author_products",
      authors: ["alice"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.relayUrls[0]).toBe("wss://alice-write.example.com")
    expect(plan.hintRelayUrls).toEqual(["wss://alice-write.example.com"])
  })

  it("uses recipient read relays as hints for dm_inbox", () => {
    const state = settings([entry("wss://general.example.com")])
    const lists = new Map<string, RelayList>([
      [
        "bob",
        relayList(
          "bob",
          ["wss://bob-read.example.com"],
          ["wss://bob-write.example.com"]
        ),
      ],
    ])
    const plan = planRelayReads({
      intent: "dm_inbox",
      recipients: ["bob"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.relayUrls[0]).toBe("wss://bob-read.example.com")
    expect(plan.relayUrls).toContain("wss://general.example.com")
  })

  it("excludes parked relays and reports them", () => {
    recordRelayFailure("wss://broken.example.com", 1)
    recordRelayFailure("wss://broken.example.com", 1)
    const state = settings([
      entry("wss://broken.example.com"),
      entry("wss://ok.example.com"),
    ])
    const plan = planRelayReads({
      intent: "general",
      settings: state,
      now: 100,
    })
    expect(plan.relayUrls).toEqual(["wss://ok.example.com"])
    expect(plan.parkedRelayUrls).toEqual(["wss://broken.example.com"])
  })

  it("can be forced to skip the health filter", () => {
    recordRelayFailure("wss://broken.example.com", 1)
    recordRelayFailure("wss://broken.example.com", 1)
    const state = settings([entry("wss://broken.example.com")])
    const plan = planRelayReads({
      intent: "general",
      settings: state,
      skipHealthFilter: true,
      now: 100,
    })
    expect(plan.relayUrls).toEqual(["wss://broken.example.com"])
    expect(plan.parkedRelayUrls).toEqual([])
  })

  it("caps fanout to maxRelays", () => {
    const state = settings([
      entry("wss://r1.example.com"),
      entry("wss://r2.example.com"),
      entry("wss://r3.example.com"),
    ])
    const plan = planRelayReads({
      intent: "general",
      settings: state,
      maxRelays: 2,
    })
    expect(plan.relayUrls.length).toBe(2)
  })

  it("dedupes overlapping hint and base relays", () => {
    const state = settings([entry("wss://shared.example.com")])
    const lists = new Map<string, RelayList>([
      ["alice", relayList("alice", [], ["wss://shared.example.com"])],
    ])
    const plan = planRelayReads({
      intent: "author_products",
      authors: ["alice"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.relayUrls).toEqual(["wss://shared.example.com"])
  })
})

describe("planRelayWrites", () => {
  beforeEach(() => {
    __resetRelayHealth()
  })
  afterEach(() => {
    __resetRelayHealth()
  })

  it("author_event uses user-enabled write relays as primary", () => {
    const state = settings([
      entry("wss://commerce.example.com", {
        section: "commerce",
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: true,
        },
      }),
      entry("wss://stale.example.com", {
        writeEnabled: true,
        warnings: {
          dmWithoutAuth: false,
          staleRelayInfo: true,
          unreachable: false,
          commercePartialSupport: false,
        },
      }),
    ])
    const plan = planRelayWrites({
      intent: "author_event",
      authorPubkey: "alice",
      settings: state,
    })
    expect(plan.primaryRelayUrls).toEqual([
      "wss://commerce.example.com",
      "wss://stale.example.com",
    ])
    expect(plan.broadcastRelayUrls).toEqual([])
  })

  it("recipient_event prefers recipient read relays as primary and seeds broadcast on user outbox", () => {
    const state = settings([
      entry("wss://outbox.example.com", {
        section: "commerce",
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: true,
        },
      }),
    ])
    const lists = new Map<string, RelayList>([
      [
        "bob",
        relayList(
          "bob",
          ["wss://bob-inbox.example.com"],
          ["wss://bob-write.example.com"]
        ),
      ],
    ])
    const plan = planRelayWrites({
      intent: "recipient_event",
      recipientPubkeys: ["bob"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.primaryRelayUrls).toEqual(["wss://bob-inbox.example.com"])
    expect(plan.broadcastRelayUrls).toEqual(["wss://outbox.example.com"])
  })

  it("falls back to user write relays as primary when recipient has no cached list", () => {
    const state = settings([
      entry("wss://outbox.example.com", {
        section: "commerce",
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: true,
        },
      }),
    ])
    const plan = planRelayWrites({
      intent: "recipient_event",
      recipientPubkeys: ["unknown"],
      relayLists: new Map(),
      settings: state,
    })
    expect(plan.primaryRelayUrls).toEqual(["wss://outbox.example.com"])
    // Broadcast is empty here because the only outbox relay is already in primary.
    expect(plan.broadcastRelayUrls).toEqual([])
  })

  it("uses default public relays for recipient delivery when the signer has no write relays", () => {
    const plan = planRelayWrites({
      intent: "recipient_event",
      recipientPubkeys: ["unknown"],
      relayLists: new Map(),
      settings: settings([]),
    })

    expect(plan.primaryRelayUrls).toEqual(config.publicRelayUrls.slice(0, 4))
    expect(plan.broadcastRelayUrls).toEqual([])
  })

  it("merges multiple recipients' inboxes and dedupes", () => {
    const state = settings([])
    const lists = new Map<string, RelayList>([
      ["bob", relayList("bob", ["wss://shared.example.com"], [])],
      [
        "carol",
        relayList(
          "carol",
          ["wss://shared.example.com", "wss://carol-only.example.com"],
          []
        ),
      ],
    ])
    const plan = planRelayWrites({
      intent: "recipient_event",
      recipientPubkeys: ["bob", "carol"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.primaryRelayUrls).toEqual([
      "wss://shared.example.com",
      "wss://carol-only.example.com",
    ])
  })

  it("respects fanout caps", () => {
    const state = settings([
      entry("wss://w1.example.com", {
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: false,
        },
      }),
      entry("wss://w2.example.com", {
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: false,
        },
      }),
      entry("wss://w3.example.com", {
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: false,
        },
      }),
    ])
    const plan = planRelayWrites({
      intent: "author_event",
      settings: state,
      maxPrimaryRelays: 2,
    })
    expect(plan.primaryRelayUrls.length).toBe(2)
  })

  it("excludes parked relays from both primary and broadcast", () => {
    recordRelayFailure("wss://parked.example.com", 1)
    recordRelayFailure("wss://parked.example.com", 1)
    const state = settings([
      entry("wss://parked.example.com", {
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: false,
        },
      }),
      entry("wss://ok.example.com", {
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: false,
        },
      }),
    ])
    const plan = planRelayWrites({
      intent: "author_event",
      settings: state,
      now: 100,
    })
    expect(plan.primaryRelayUrls).toEqual(["wss://ok.example.com"])
    expect(plan.parkedRelayUrls).toEqual(["wss://parked.example.com"])
  })
})

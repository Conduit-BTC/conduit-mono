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
  const baseCapabilities: RelaySettingsEntry["capabilities"] = {
    nip11: true,
    search: false,
    dm: false,
    auth: false,
    commerce: false,
    protectedMessages: false,
    listings: false,
    cleanup: false,
  }
  const commerceCapabilities: RelaySettingsEntry["capabilities"] = {
    ...baseCapabilities,
    dm: true,
    auth: true,
    commerce: true,
    protectedMessages: true,
    listings: true,
    cleanup: true,
  }
  const baseWarnings: RelaySettingsEntry["warnings"] = {
    dmWithoutAuth: false,
    staleRelayInfo: false,
    unreachable: false,
    commercePartialSupport: false,
  }
  const capabilities =
    overrides.capabilities ??
    (overrides.section === "commerce" ? commerceCapabilities : baseCapabilities)
  const warnings = {
    ...baseWarnings,
    ...overrides.warnings,
  }

  return {
    url,
    readEnabled: true,
    writeEnabled: false,
    section: "public",
    capabilities,
    warnings,
    ...overrides,
    capabilities,
    warnings,
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
      entry("wss://commerce.conduit.market", {
        section: "commerce",
        readEnabled: true,
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: true,
          dm: true,
          auth: true,
          commerce: true,
          protectedMessages: true,
          listings: true,
          cleanup: true,
        },
      }),
      entry("wss://public.conduit.market", {
        section: "public",
        readEnabled: true,
      }),
    ])
    const plan = planRelayReads({
      intent: "commerce_products",
      settings: state,
    })
    expect(plan.relayUrls[0]).toBe("wss://commerce.conduit.market")
    expect(plan.relayUrls).toContain("wss://public.conduit.market")
  })

  it("uses commerce discovery defaults when local settings are empty", () => {
    const plan = planRelayReads({
      intent: "commerce_products",
      settings: settings([]),
    })

    for (const relayUrl of config.commerceDiscoveryRelayUrls) {
      expect(plan.relayUrls).toContain(relayUrl)
    }
    expect(plan.relayUrls).not.toContain("wss://inbox.azzamo.net")
  })

  it("prepends author write relays as hints for author_products", () => {
    const state = settings([
      entry("wss://commerce.conduit.market", { section: "commerce" }),
    ])
    const lists = new Map<string, RelayList>([
      [
        "alice",
        relayList(
          "alice",
          ["wss://alice-read.conduit.market"],
          ["wss://alice-write.conduit.market"]
        ),
      ],
    ])
    const plan = planRelayReads({
      intent: "author_products",
      authors: ["alice"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.relayUrls[0]).toBe("wss://alice-write.conduit.market")
    expect(plan.hintRelayUrls).toEqual(["wss://alice-write.conduit.market"])
  })

  it("ignores insecure author relays from third-party NIP-65 hints", () => {
    const state = settings([
      entry("wss://commerce.conduit.market", { section: "commerce" }),
    ])
    const lists = new Map<string, RelayList>([
      [
        "alice",
        relayList(
          "alice",
          ["wss://alice-read.conduit.market"],
          ["ws://artshop:4848", "wss://alice-write.conduit.market"]
        ),
      ],
    ])
    const plan = planRelayReads({
      intent: "author_products",
      authors: ["alice"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.hintRelayUrls).toEqual(["wss://alice-write.conduit.market"])
    expect(plan.relayUrls).not.toContain("ws://artshop:4848")
  })

  it("allows insecure author relays from the authenticated user's own NIP-65", () => {
    const state = settings([
      entry("wss://commerce.conduit.market", { section: "commerce" }),
    ])
    const lists = new Map<string, RelayList>([
      [
        "alice",
        relayList(
          "alice",
          ["wss://alice-read.conduit.market"],
          ["ws://artshop:4848", "wss://alice-write.conduit.market"]
        ),
      ],
    ])
    const plan = planRelayReads({
      intent: "author_products",
      authors: ["alice"],
      authenticatedPubkey: "alice",
      relayLists: lists,
      settings: state,
    })
    expect(plan.hintRelayUrls).toEqual([
      "ws://artshop:4848",
      "wss://alice-write.conduit.market",
    ])
  })

  it("uses recipient read relays as hints for dm_inbox", () => {
    const state = settings([entry("wss://general.conduit.market")])
    const lists = new Map<string, RelayList>([
      [
        "bob",
        relayList(
          "bob",
          ["wss://bob-read.conduit.market"],
          ["wss://bob-write.conduit.market"]
        ),
      ],
    ])
    const plan = planRelayReads({
      intent: "dm_inbox",
      recipients: ["bob"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.relayUrls[0]).toBe("wss://bob-read.conduit.market")
    expect(plan.relayUrls).toContain("wss://general.conduit.market")
  })

  it("excludes parked relays and reports them", () => {
    recordRelayFailure("wss://broken.conduit.market", 1)
    recordRelayFailure("wss://broken.conduit.market", 1)
    const state = settings([
      entry("wss://broken.conduit.market"),
      entry("wss://ok.conduit.market"),
    ])
    const plan = planRelayReads({
      intent: "general",
      settings: state,
      now: 100,
    })
    expect(plan.relayUrls).toEqual(["wss://ok.conduit.market"])
    expect(plan.parkedRelayUrls).toEqual(["wss://broken.conduit.market"])
  })

  it("can be forced to skip the health filter", () => {
    recordRelayFailure("wss://broken.conduit.market", 1)
    recordRelayFailure("wss://broken.conduit.market", 1)
    const state = settings([entry("wss://broken.conduit.market")])
    const plan = planRelayReads({
      intent: "general",
      settings: state,
      skipHealthFilter: true,
      now: 100,
    })
    expect(plan.relayUrls).toEqual(["wss://broken.conduit.market"])
    expect(plan.parkedRelayUrls).toEqual([])
  })

  it("caps fanout to maxRelays", () => {
    const state = settings([
      entry("wss://r1.conduit.market"),
      entry("wss://r2.conduit.market"),
      entry("wss://r3.conduit.market"),
    ])
    const plan = planRelayReads({
      intent: "general",
      settings: state,
      maxRelays: 2,
    })
    expect(plan.relayUrls.length).toBe(2)
  })

  it("dedupes overlapping hint and base relays", () => {
    const state = settings([entry("wss://shared.conduit.market")])
    const lists = new Map<string, RelayList>([
      ["alice", relayList("alice", [], ["wss://shared.conduit.market"])],
    ])
    const plan = planRelayReads({
      intent: "author_products",
      authors: ["alice"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.relayUrls).toEqual(["wss://shared.conduit.market"])
  })

  it("plans shopper trust from merchant and shopper NIP-65 hints before public relays", () => {
    const state = settings([entry("wss://public.conduit.market")])
    const lists = new Map<string, RelayList>([
      [
        "merchant",
        relayList("merchant", [], ["wss://merchant-write.conduit.market"]),
      ],
      [
        "shopper",
        relayList(
          "shopper",
          ["wss://shopper-read.conduit.market"],
          ["wss://shopper-write.conduit.market"]
        ),
      ],
    ])

    const plan = planRelayReads({
      intent: "shopper_trust",
      authors: ["merchant", "shopper"],
      recipients: ["shopper"],
      relayLists: lists,
      settings: state,
    })

    expect(plan.relayUrls.slice(0, 3)).toEqual([
      "wss://merchant-write.conduit.market",
      "wss://shopper-write.conduit.market",
      "wss://shopper-read.conduit.market",
    ])
    expect(plan.relayUrls).toContain("wss://public.conduit.market")
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
      entry("wss://commerce.conduit.market", {
        section: "commerce",
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: true,
          auth: true,
          commerce: true,
          protectedMessages: true,
          listings: true,
          cleanup: true,
        },
      }),
      entry("wss://stale.conduit.market", {
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
      "wss://commerce.conduit.market",
      "wss://stale.conduit.market",
    ])
    expect(plan.broadcastRelayUrls).toEqual([])
  })

  it("author_event includes the author's current NIP-65 write relays", () => {
    const state = settings([
      entry("wss://configured.conduit.market", {
        section: "commerce",
        writeEnabled: true,
      }),
    ])
    const lists = new Map<string, RelayList>([
      [
        "alice",
        relayList(
          "alice",
          ["wss://alice-read.conduit.market"],
          ["wss://alice-write.conduit.market"]
        ),
      ],
    ])

    const plan = planRelayWrites({
      intent: "author_event",
      authorPubkey: "alice",
      authenticatedPubkey: "alice",
      relayLists: lists,
      settings: state,
    })

    expect(plan.primaryRelayUrls).toEqual([
      "wss://alice-write.conduit.market",
      "wss://configured.conduit.market",
    ])
  })

  it("recipient_event prefers recipient read relays as primary and seeds broadcast on user outbox", () => {
    const state = settings([
      entry("wss://outbox.conduit.market", {
        section: "commerce",
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: true,
          auth: true,
          commerce: true,
          protectedMessages: true,
          listings: true,
          cleanup: true,
        },
      }),
    ])
    const lists = new Map<string, RelayList>([
      [
        "bob",
        relayList(
          "bob",
          ["wss://bob-inbox.conduit.market"],
          ["wss://bob-write.conduit.market"]
        ),
      ],
    ])
    const plan = planRelayWrites({
      intent: "recipient_event",
      recipientPubkeys: ["bob"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.primaryRelayUrls).toEqual(["wss://bob-inbox.conduit.market"])
    expect(plan.broadcastRelayUrls).toEqual(["wss://outbox.conduit.market"])
  })

  it("treats third-party recipient NIP-65 lists with only insecure relays as missing", () => {
    const state = settings([
      entry("wss://outbox.conduit.market", {
        section: "commerce",
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: true,
          auth: true,
          commerce: true,
          protectedMessages: true,
          listings: true,
          cleanup: true,
        },
      }),
    ])
    const lists = new Map<string, RelayList>([
      ["bob", relayList("bob", ["ws://umbrel.local:4848"], [])],
    ])
    const plan = planRelayWrites({
      intent: "recipient_event",
      recipientPubkeys: ["bob"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.primaryRelayUrls).toEqual(
      config.dmInboxDefaultRelayUrls.slice(0, 4)
    )
    expect(plan.primaryRelayUrls).not.toContain("ws://umbrel.local:4848")
  })

  it("allows insecure recipient relays for authenticated self-copy delivery", () => {
    const state = settings([
      entry("wss://outbox.conduit.market", {
        section: "commerce",
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: true,
          auth: true,
          commerce: true,
          protectedMessages: true,
          listings: true,
          cleanup: true,
        },
      }),
    ])
    const lists = new Map<string, RelayList>([
      ["alice", relayList("alice", ["ws://umbrel.local:4848"], [])],
    ])
    const plan = planRelayWrites({
      intent: "recipient_event",
      authenticatedPubkey: "alice",
      recipientPubkeys: ["alice"],
      relayLists: lists,
      settings: state,
    })
    expect(plan.primaryRelayUrls).toEqual(["ws://umbrel.local:4848"])
    expect(plan.broadcastRelayUrls).toEqual(["wss://outbox.conduit.market"])
  })

  it("uses shared recipient fallback relays when recipient has no cached list", () => {
    const state = settings([
      entry("wss://outbox.conduit.market", {
        section: "commerce",
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: true,
          auth: true,
          commerce: true,
          protectedMessages: true,
          listings: true,
          cleanup: true,
        },
      }),
    ])
    const plan = planRelayWrites({
      intent: "recipient_event",
      recipientPubkeys: ["unknown"],
      relayLists: new Map(),
      settings: state,
    })
    expect(plan.primaryRelayUrls).toEqual(
      config.dmInboxDefaultRelayUrls.slice(0, 4)
    )
    expect(plan.primaryRelayUrls).not.toContain("wss://outbox.conduit.market")
    expect(plan.broadcastRelayUrls).toEqual(["wss://outbox.conduit.market"])
  })

  it("uses default public relays for recipient delivery when the signer has no write relays", () => {
    const plan = planRelayWrites({
      intent: "recipient_event",
      recipientPubkeys: ["unknown"],
      relayLists: new Map(),
      settings: settings([]),
    })

    expect(plan.primaryRelayUrls).toEqual(
      config.dmInboxDefaultRelayUrls.slice(0, 4)
    )
    expect(plan.broadcastRelayUrls).toEqual([])
  })

  it("merges multiple recipients' inboxes and dedupes", () => {
    const state = settings([])
    const lists = new Map<string, RelayList>([
      ["bob", relayList("bob", ["wss://shared.conduit.market"], [])],
      [
        "carol",
        relayList(
          "carol",
          ["wss://shared.conduit.market", "wss://carol-only.conduit.market"],
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
      "wss://shared.conduit.market",
      "wss://carol-only.conduit.market",
    ])
  })

  it("respects fanout caps", () => {
    const state = settings([
      entry("wss://w1.conduit.market", {
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: false,
        },
      }),
      entry("wss://w2.conduit.market", {
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: false,
        },
      }),
      entry("wss://w3.conduit.market", {
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
    recordRelayFailure("wss://parked.conduit.market", 1)
    recordRelayFailure("wss://parked.conduit.market", 1)
    const state = settings([
      entry("wss://parked.conduit.market", {
        writeEnabled: true,
        capabilities: {
          nip11: true,
          search: false,
          dm: false,
          auth: false,
          commerce: false,
        },
      }),
      entry("wss://ok.conduit.market", {
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
    expect(plan.primaryRelayUrls).toEqual(["wss://ok.conduit.market"])
    expect(plan.parkedRelayUrls).toEqual(["wss://parked.conduit.market"])
  })
})

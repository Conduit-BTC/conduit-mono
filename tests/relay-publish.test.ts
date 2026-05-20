import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetRelayListTestOverrides,
  __resetRelayPublishTestOverrides,
  __setRelayListTestOverrides,
  __setRelayPublishTestOverrides,
  deriveRelayOutcomes,
  EVENT_KINDS,
  planPublishRelays,
  publishWithPlanner,
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
    __resetRelayPublishTestOverrides()
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

  it("uses every recipient relay for critical delivery jobs", async () => {
    const relays = Array.from(
      { length: 6 },
      (_, index) => `wss://bob-read-${index}.example`
    )
    __setRelayListTestOverrides({
      now: () => NOW,
      loadCached: async (pubkey) =>
        pubkey === "bob"
          ? {
              pubkey: "bob",
              readRelayUrls: relays,
              writeRelayUrls: [],
              eventCreatedAt: 1,
              sourceRelayUrls: undefined,
              cachedAt: NOW,
            }
          : undefined,
    })

    const standard = await planPublishRelays({
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
    })
    const critical = await planPublishRelays({
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
      deliveryMode: "critical",
    })

    expect(standard.primaryRelayUrls).toEqual(relays.slice(0, 4))
    expect(critical.primaryRelayUrls).toEqual(relays)
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

  it("refuses tiny NIP-65 relay-list publishes before planning relays", async () => {
    await expect(
      publishWithPlanner(
        {
          kind: EVENT_KINDS.RELAY_LIST,
          tags: [["r", "wss://only.example"]],
        } as never,
        {
          intent: "author_event",
          authorPubkey: "alice",
        }
      )
    ).rejects.toThrow("Refusing to publish a tiny NIP-65 relay list")
  })

  it("refuses NIP-65 relay-list publishes without an explicit planner target", async () => {
    const publishAttempts: string[] = []

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(
        {
          kind: EVENT_KINDS.RELAY_LIST,
          tags: [
            ["r", "wss://one.example"],
            ["r", "wss://two.example", "write"],
          ],
          publish: async () => {
            publishAttempts.push("fallback")
            return new Set()
          },
        } as never,
        {
          intent: "author_event",
          authorPubkey: "alice",
        }
      )
    ).rejects.toThrow("without an explicit OUT relay target")

    expect(publishAttempts).toEqual([])
  })

  it("does not let broadcast success mask recipient primary failure", async () => {
    const primaryRelay = "wss://recipient.example"
    const broadcastRelay = "wss://sender.example"
    const attempts: string[][] = []
    const fakeEvent = {
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        if (relayUrls.some((url) => url.startsWith(primaryRelay))) {
          throw new Error("recipient relay failed")
        }
        return new Set(relayUrls.map((url) => ({ url })))
      },
    } as never

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [broadcastRelay],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "recipient_event",
        authorPubkey: "alice",
        recipientPubkeys: ["bob"],
      })
    ).rejects.toThrow("no primary relay accepted")

    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.[0]).toStartWith(primaryRelay)
  })

  it("returns broadcast failures as diagnostics after primary delivery succeeds", async () => {
    const primaryRelay = "wss://recipient.example"
    const broadcastRelay = "wss://sender.example"
    const fakeEvent = {
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        if (relayUrls.some((url) => url.startsWith(broadcastRelay))) {
          throw new Error("broadcast relay failed")
        }
        return new Set(relayUrls.map((url) => ({ url })))
      },
    } as never

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [broadcastRelay],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
    })

    expect(result.successfulRelayUrls).toEqual([primaryRelay])
    expect(result.failedRelayUrls).toEqual([broadcastRelay])
  })

  it("retries non-NIP-65 author events on public fallback relays when configured writes fail", async () => {
    const primaryRelay = "wss://configured-write.example"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: string[][] = []
    const fakeEvent = {
      kind: EVENT_KINDS.PRODUCT,
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        if (relayUrls.includes(normalizedPrimaryRelay)) {
          throw new Error("configured write relay failed")
        }
        return new Set(relayUrls.slice(0, 1).map((url) => ({ url })))
      },
    } as never

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "author_event",
      authorPubkey: "alice",
    })

    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toEqual([normalizedPrimaryRelay])
    expect(attempts[1]?.length).toBeGreaterThan(0)
    expect(attempts[1]).not.toContain(normalizedPrimaryRelay)
    expect(result.successfulRelayUrls.length).toBe(1)
    expect(result.failedRelayUrls).toContain(primaryRelay)
  })

  it("does not fallback NIP-65 relay-list publishes after configured writes fail", async () => {
    const primaryRelay = "wss://configured-write.example"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: string[][] = []
    const fakeEvent = {
      kind: EVENT_KINDS.RELAY_LIST,
      tags: [
        ["r", "wss://one.example"],
        ["r", "wss://two.example", "write"],
      ],
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        throw new Error("configured write relay failed")
      },
    } as never

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "author_event",
        authorPubkey: "alice",
      })
    ).rejects.toThrow("no primary relay accepted")

    expect(attempts).toEqual([[normalizedPrimaryRelay]])
  })

  it("includes relay failure reasons in publish diagnostics", async () => {
    const primaryRelay = "wss://configured-write.example"
    const fakeEvent = {
      kind: EVENT_KINDS.RELAY_LIST,
      tags: [
        ["r", "wss://one.example"],
        ["r", "wss://two.example", "write"],
      ],
      publish: async () => {
        throw new Error("relay rejected the event kind")
      },
    } as never

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "author_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "author_event",
        authorPubkey: "alice",
      })
    ).rejects.toThrow(
      "wss://configured-write.example (relay rejected the event kind)"
    )
  })
})

describe("deriveRelayOutcomes", () => {
  const A = "wss://a.example"
  const B = "wss://b.example"
  const C = "wss://c.example"

  it("marks every attempted relay as successful when all are acked", () => {
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A, B],
      publishedUrls: [A, B],
    })
    expect(result.successfulRelayUrls.sort()).toEqual([A, B].sort())
    expect(result.failedRelayUrls).toEqual([])
  })

  it("marks unacked attempted relays as failed (timeout case)", () => {
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A, B, C],
      publishedUrls: [A],
    })
    expect(result.successfulRelayUrls).toEqual([A])
    expect(result.failedRelayUrls.sort()).toEqual([B, C].sort())
  })

  it("honors partial-failure split from NDKPublishError", () => {
    // NDK acked A; reported explicit error for B; C silently dropped.
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A, B, C],
      publishedUrls: [A],
      failedUrls: [B],
    })
    expect(result.successfulRelayUrls).toEqual([A])
    expect(result.failedRelayUrls.sort()).toEqual([B, C].sort())
  })

  it("does not double-count: success wins over failure for the same URL", () => {
    // Defensive: should the report list a URL in both buckets, treat it as
    // success so we don't punish a relay that actually accepted the event.
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A, B],
      publishedUrls: [A],
      failedUrls: [A, B],
    })
    expect(result.successfulRelayUrls).toEqual([A])
    expect(result.failedRelayUrls).toEqual([B])
  })

  it("ignores URLs not in the attempted set", () => {
    const result = deriveRelayOutcomes({
      attemptedRelayUrls: [A],
      publishedUrls: [B],
      failedUrls: [C],
    })
    expect(result.successfulRelayUrls).toEqual([])
    expect(result.failedRelayUrls).toEqual([A])
  })
})

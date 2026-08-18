import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKPublishError, type NDKRelay } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetRelayListTestOverrides,
  __resetRelayPublishTestOverrides,
  __setRelayListTestOverrides,
  __setRelayPublishTestOverrides,
  CANONICAL_APP_WRITE_RELAYS,
  deriveRelayOutcomes,
  EVENT_KINDS,
  planPublishRelays,
  publishDurableSignedEventToRelay,
  publishSignedEventToRelay,
  publishWithPlanner,
  type RelayList,
} from "@conduit/core"
import {
  __resetNdkTestState,
  getDurableNdk,
} from "../packages/core/src/protocol/ndk"

const NOW = 1_700_000_000_000
const AUTHOR_SECRET = Uint8Array.from([...new Uint8Array(31), 21])
const OTHER_AUTHOR_SECRET = Uint8Array.from([...new Uint8Array(31), 22])
const AUTHOR_PUBKEY = getPublicKey(AUTHOR_SECRET)
const OTHER_AUTHOR_PUBKEY = getPublicKey(OTHER_AUTHOR_SECRET)
const APP_WRITE_ATTEMPT_RELAYS = CANONICAL_APP_WRITE_RELAYS.map(
  (url) => `${url}/`
)

function signedTestEvent(input: {
  kind?: number
  tags?: string[][]
  content?: string
  publish: (relaySet: unknown, timeoutMs?: number) => Promise<unknown>
}): NDKEvent {
  const event = new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: input.kind ?? 1,
        created_at: 1_700_000_000,
        tags: input.tags ?? [],
        content: input.content ?? "test",
      },
      AUTHOR_SECRET
    )
  )
  event.publish = input.publish as never
  return event
}

function installAcknowledgingWebSocket(closeDelayMs = 0): {
  counters: { closed: number; opened: number }
  restore: () => void
} {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocket"
  )
  const counters = { closed: 0, opened: 0 }

  class AcknowledgingWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = AcknowledgingWebSocket.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null

    constructor(readonly url: string) {
      counters.opened += 1
      queueMicrotask(() => {
        if (this.readyState !== AcknowledgingWebSocket.CONNECTING) return
        this.readyState = AcknowledgingWebSocket.OPEN
        this.onopen?.(new Event("open"))
      })
    }

    send(payload: string): void {
      const frame = JSON.parse(payload) as [string, { id?: string } | undefined]
      if (frame[0] !== "EVENT" || !frame[1]?.id) return
      const eventId = frame[1].id
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify(["OK", eventId, true, ""]),
        } as MessageEvent<string>)
      })
    }

    close(): void {
      if (
        this.readyState === AcknowledgingWebSocket.CLOSING ||
        this.readyState === AcknowledgingWebSocket.CLOSED
      ) {
        return
      }
      this.readyState = AcknowledgingWebSocket.CLOSING
      setTimeout(() => {
        this.readyState = AcknowledgingWebSocket.CLOSED
        counters.closed += 1
        this.onclose?.(new Event("close"))
      }, closeDelayMs)
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: AcknowledgingWebSocket,
  })

  return {
    counters,
    restore: () => {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "WebSocket", originalDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, "WebSocket")
      }
    },
  }
}

function ndkPublishFailure(relayUrl: string, reason: string): NDKPublishError {
  const relay = { url: `${relayUrl}/` } as NDKRelay
  return new NDKPublishError(
    "Not enough relays received the event",
    new Map([[relay, new Error(reason)]]),
    new Set()
  )
}

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
    __resetNdkTestState()
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
            readRelayUrls: ["wss://bob-read.conduit.market"],
            writeRelayUrls: ["wss://bob-write.conduit.market"],
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
    expect(plan.primaryRelayUrls).toContain("wss://bob-read.conduit.market")
  })

  it("uses every recipient relay for critical delivery jobs", async () => {
    const relays = Array.from(
      { length: 6 },
      (_, index) => `wss://bob-read-${index}.conduit.market`
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

  it("refuses an invalid signed event before planning any relay", async () => {
    let planned = false
    const rawEvent = finalizeEvent(
      { kind: 1, created_at: 1_700_000_000, tags: [], content: "hello" },
      AUTHOR_SECRET
    )
    const event = new NDKEvent(undefined, {
      ...rawEvent,
      sig: "0".repeat(128),
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => {
        planned = true
        return {
          intent: "author_event",
          primaryRelayUrls: [],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        }
      },
    })

    await expect(
      publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).rejects.toThrow("invalid signed Nostr event")
    expect(planned).toBe(false)
  })

  it("refuses an author event signed by a different account", async () => {
    let planned = false
    const event = new NDKEvent(
      undefined,
      finalizeEvent(
        { kind: 1, created_at: 1_700_000_000, tags: [], content: "hello" },
        AUTHOR_SECRET
      )
    )
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => {
        planned = true
        return {
          intent: "author_event",
          primaryRelayUrls: [],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        }
      },
    })

    await expect(
      publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: OTHER_AUTHOR_PUBKEY,
      })
    ).rejects.toThrow("signed by a different account")
    expect(planned).toBe(false)
  })

  it("refuses tiny NIP-65 relay-list publishes before planning relays", async () => {
    await expect(
      publishWithPlanner(
        {
          kind: EVENT_KINDS.RELAY_LIST,
          tags: [["r", "wss://only.conduit.market"]],
        } as never,
        {
          intent: "author_event",
          authorPubkey: "alice",
        }
      )
    ).rejects.toThrow("Refusing to publish a tiny NIP-65 relay list")
  })

  it("uses the app write relay for NIP-65 publishes without a planner target", async () => {
    const publishAttempts: string[][] = []

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
        signedTestEvent({
          kind: EVENT_KINDS.RELAY_LIST,
          tags: [
            ["r", "wss://one.conduit.market"],
            ["r", "wss://two.conduit.market", "write"],
          ],
          publish: async (relaySet: unknown) => {
            const relayUrls = [
              ...((relaySet as { relayUrls?: Set<string> | string[] })
                .relayUrls ?? []),
            ]
            publishAttempts.push(relayUrls)
            return new Set(relayUrls.map((url) => ({ url })))
          },
        }),
        {
          intent: "author_event",
          authorPubkey: AUTHOR_PUBKEY,
        }
      )
    ).resolves.toMatchObject({
      successfulRelayUrls: CANONICAL_APP_WRITE_RELAYS,
    })

    expect(publishAttempts).toEqual([APP_WRITE_ATTEMPT_RELAYS])
  })

  it("refuses tiny contact-list publishes before planning relays", async () => {
    let planned = false
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => {
        planned = true
        return {
          intent: "author_event",
          primaryRelayUrls: ["wss://relay.conduit.market"],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
        }
      },
    })

    await expect(
      publishWithPlanner(
        {
          kind: EVENT_KINDS.CONTACT_LIST,
          content: "",
          tags: [["p", "alice"]],
        } as never,
        {
          intent: "author_event",
          authorPubkey: "alice",
        }
      )
    ).rejects.toThrow("Refusing to publish a tiny follow list")
    expect(planned).toBe(false)
  })

  it("does not let broadcast success mask recipient primary failure", async () => {
    const primaryRelay = "wss://recipient.conduit.market"
    const broadcastRelay = "wss://sender.conduit.market"
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
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
    })

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
    const primaryRelay = "wss://recipient.conduit.market"
    const broadcastRelay = "wss://sender.conduit.market"
    const fakeEvent = signedTestEvent({
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
    })

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

  it("drops private extra relay hints that the authenticated planner did not select", async () => {
    const primaryRelay = "wss://recipient.conduit.market"
    const publicExtraRelay = "wss://public-extra.conduit.market"
    const privateExtraRelay = "wss://127.0.0.1:7447"
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      authenticatedPubkey: "alice",
      recipientPubkeys: ["bob"],
      extraRelayUrls: [privateExtraRelay, publicExtraRelay],
    })

    expect(result.plan.primaryRelayUrls).toEqual([
      primaryRelay,
      publicExtraRelay,
    ])
    expect(result.attemptedRelayUrls).not.toContain(privateExtraRelay)
  })

  it("preserves a private extra hint already selected for the authenticated user", async () => {
    const recipientRelay = "wss://recipient.conduit.market"
    const authenticatedLocalRelay = "wss://127.0.0.1:7447"
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [recipientRelay],
        broadcastRelayUrls: [authenticatedLocalRelay],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      authenticatedPubkey: "alice",
      recipientPubkeys: ["bob"],
      extraRelayUrls: [authenticatedLocalRelay],
    })

    expect(result.plan.primaryRelayUrls).toEqual([
      recipientRelay,
      authenticatedLocalRelay,
    ])
    expect(result.attemptedRelayUrls).toContain(authenticatedLocalRelay)
  })

  it("refuses to publish a gift wrap without an exclusive private-message plan", async () => {
    let attempted = false
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.GIFT_WRAP,
      publish: async () => {
        attempted = true
        return new Set()
      },
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "recipient_event",
        authorPubkey: "alice",
        recipientPubkeys: ["bob"],
        extraRelayUrls: ["wss://inbox-10050.conduit.market"],
      })
    ).rejects.toThrow(
      "Gift wraps require an exclusive private-message relay plan"
    )
    expect(attempted).toBe(false)
  })

  it("never leaves the exclusive relay set after every declared relay rejects", async () => {
    const exclusiveRelay = "wss://declared-inbox.conduit.market"
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.GIFT_WRAP,
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        throw new Error("declared inbox rejected the wrap")
      },
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "recipient_event",
        authorPubkey: "alice",
        recipientPubkeys: ["bob"],
        deliveryMode: "critical",
        exclusiveRelayUrls: [exclusiveRelay],
        extraRelayUrls: ["wss://must-not-be-used.conduit.market"],
      })
    ).rejects.toThrow("required exclusive relay set")

    expect(attempts).toEqual([[`${exclusiveRelay}/`], [`${exclusiveRelay}/`]])
  })

  it("returns a structured ACK for one exact durable relay target", async () => {
    const relayUrl = "wss://durable-delete.conduit.market"
    const event = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => new Set([{ url: `${relayUrl}/` }]),
    })

    await expect(
      publishSignedEventToRelay({
        event,
        relayUrl,
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).resolves.toBe("acked")
  })

  it("uses one persistent durable relay instead of the ambient event client", async () => {
    const fakeWebSocket = installAcknowledgingWebSocket()
    const relayUrl = "wss://durable-isolated.conduit.market"
    const usedRelays: NDKRelay[] = []
    const inputEvent = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => {
        throw new Error("must publish the isolated event")
      },
    })
    const isolatedEvent = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async (relaySet) => {
        const relay = Array.from(
          (relaySet as { relays: Set<NDKRelay> }).relays
        )[0]
        if (!relay) throw new Error("Expected one durable relay")
        usedRelays.push(relay)
        return new Set([relay])
      },
    })
    __setRelayPublishTestOverrides({
      createDurableEvent: () => isolatedEvent,
    })

    try {
      await expect(
        publishDurableSignedEventToRelay({
          event: inputEvent,
          relayUrl,
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).resolves.toBe("acked")

      const durableRelay = usedRelays[0]
      expect(durableRelay?.url).toBe(`${relayUrl}/`)
      expect(getDurableNdk().pool.relays.size).toBe(0)

      await expect(
        publishDurableSignedEventToRelay({
          event: inputEvent,
          relayUrl,
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).resolves.toBe("acked")
      expect(usedRelays[1]).toBe(durableRelay)
      expect(getDurableNdk().pool.relays.size).toBe(0)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("disconnects the durable relay after a failed attempt", async () => {
    const fakeWebSocket = installAcknowledgingWebSocket()
    const relayUrl = "wss://durable-timeout.conduit.market"
    const inputEvent = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => {
        throw new Error("must publish the isolated event")
      },
    })
    const isolatedEvent = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => {
        throw ndkPublishFailure(relayUrl, "Timeout: 8000ms")
      },
    })
    __setRelayPublishTestOverrides({
      createDurableEvent: () => isolatedEvent,
    })

    try {
      await expect(
        publishDurableSignedEventToRelay({
          event: inputEvent,
          relayUrl,
          authorPubkey: AUTHOR_PUBKEY,
        })
      ).resolves.toBe("timed_out")
      expect(getDurableNdk().pool.relays.size).toBe(0)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("waits for relay close before immediate sequential reuse", async () => {
    const fakeWebSocket = installAcknowledgingWebSocket(20)

    try {
      const relayUrl = "wss://sequential-durable.conduit.market"
      const event = new NDKEvent(
        undefined,
        finalizeEvent(
          {
            kind: EVENT_KINDS.DELETION,
            created_at: NOW,
            tags: [["e", "a".repeat(64)]],
            content: "",
          },
          AUTHOR_SECRET
        )
      )

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          publishDurableSignedEventToRelay({
            event,
            relayUrl,
            authorPubkey: AUTHOR_PUBKEY,
          })
        ).resolves.toBe("acked")
      }

      expect(fakeWebSocket.counters.opened).toBe(2)
      expect(fakeWebSocket.counters.closed).toBe(2)
      expect(getDurableNdk().pool.relays.size).toBe(0)
    } finally {
      fakeWebSocket.restore()
    }
  })

  it("preserves an authenticated author's exact local relay target", async () => {
    const relayUrl = "ws://127.0.0.1:7777"
    const attempts: string[][] = []
    const event = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        return new Set([{ url: relayUrl }])
      },
    })

    await expect(
      publishSignedEventToRelay({
        event,
        relayUrl,
        authorPubkey: AUTHOR_PUBKEY,
        authenticatedPubkey: AUTHOR_PUBKEY,
      })
    ).resolves.toBe("acked")
    expect(attempts).toEqual([[`${relayUrl}/`]])
  })

  it("rejects an exact insecure relay outside the authenticated author context", async () => {
    const event = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => {
        throw new Error("must not publish")
      },
    })

    await expect(
      publishSignedEventToRelay({
        event,
        relayUrl: "ws://127.0.0.1:7777",
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).rejects.toThrow("public or authenticated relay target")
  })

  it("rejects an exact private WSS relay outside the authenticated author context", async () => {
    const event = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => {
        throw new Error("must not publish")
      },
    })

    await expect(
      publishSignedEventToRelay({
        event,
        relayUrl: "wss://127.0.0.1:7447",
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).rejects.toThrow("public or authenticated relay target")
  })

  it("preserves an authenticated author's exact private WSS target", async () => {
    const relayUrl = "wss://127.0.0.1:7447"
    const event = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => new Set([{ url: `${relayUrl}/` }]),
    })

    await expect(
      publishSignedEventToRelay({
        event,
        relayUrl,
        authorPubkey: AUTHOR_PUBKEY,
        authenticatedPubkey: AUTHOR_PUBKEY,
      })
    ).resolves.toBe("acked")
  })

  it("returns a structured timeout without fallback fanout", async () => {
    const relayUrl = "wss://durable-timeout.conduit.market"
    let attempts = 0
    const event = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => {
        attempts += 1
        throw new Error("connection closed")
      },
    })

    await expect(
      publishSignedEventToRelay({
        event,
        relayUrl,
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).resolves.toBe("timed_out")
    expect(attempts).toBe(1)
  })

  it("classifies an NDK relay-set timeout as retryable, not rejected", async () => {
    const relayUrl = "wss://durable-ndk-timeout.conduit.market"
    const event = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => {
        throw ndkPublishFailure(relayUrl, "Publish timeout after 10000ms")
      },
    })

    await expect(
      publishSignedEventToRelay({
        event,
        relayUrl,
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).resolves.toBe("timed_out")
  })

  it("classifies a NIP-01 OK-false reason as an explicit rejection", async () => {
    const relayUrl = "wss://durable-reject.conduit.market"
    const event = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => {
        throw ndkPublishFailure(relayUrl, "blocked: deletion denied")
      },
    })

    await expect(
      publishSignedEventToRelay({
        event,
        relayUrl,
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).resolves.toBe("rejected")
  })

  it("treats a NIP-01 duplicate response as an idempotent acknowledgement", async () => {
    const relayUrl = "wss://durable-duplicate.conduit.market"
    const event = signedTestEvent({
      kind: EVENT_KINDS.DELETION,
      tags: [["e", "a".repeat(64)]],
      content: "",
      publish: async () => {
        throw ndkPublishFailure(relayUrl, "duplicate: already have this event")
      },
    })

    await expect(
      publishSignedEventToRelay({
        event,
        relayUrl,
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).resolves.toBe("acked")
  })

  it("retries non-NIP-65 author events on public fallback relays when configured writes fail", async () => {
    const primaryRelay = "wss://configured-write.conduit.market"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
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
    })

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
      authorPubkey: AUTHOR_PUBKEY,
    })

    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toEqual([normalizedPrimaryRelay])
    expect(attempts[1]?.length).toBeGreaterThan(0)
    expect(attempts[1]).not.toContain(normalizedPrimaryRelay)
    expect(result.successfulRelayUrls.length).toBe(1)
    expect(result.failedRelayUrls).toContain(primaryRelay)
  })

  it("falls back to the app write relay for NIP-65 after configured writes fail", async () => {
    const primaryRelay = "wss://configured-write.conduit.market"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.RELAY_LIST,
      tags: [
        ["r", "wss://one.conduit.market"],
        ["r", "wss://two.conduit.market", "write"],
      ],
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        if (relayUrls.includes(normalizedPrimaryRelay)) {
          throw new Error("configured write relay failed")
        }
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

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
      authorPubkey: AUTHOR_PUBKEY,
    })

    expect(result.successfulRelayUrls).toEqual(CANONICAL_APP_WRITE_RELAYS)
    expect(attempts).toEqual([
      [normalizedPrimaryRelay],
      APP_WRITE_ATTEMPT_RELAYS,
    ])
  })

  it("includes relay failure reasons in publish diagnostics", async () => {
    const primaryRelay = "wss://configured-write.conduit.market"
    const fakeEvent = signedTestEvent({
      kind: EVENT_KINDS.RELAY_LIST,
      tags: [
        ["r", "wss://one.conduit.market"],
        ["r", "wss://two.conduit.market", "write"],
      ],
      publish: async () => {
        throw new Error("relay rejected the event kind")
      },
    })

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
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).rejects.toThrow(
      "wss://configured-write.conduit.market (relay rejected the event kind)"
    )
  })

  it("retries critical recipient primary relays with a longer timeout", async () => {
    const primaryRelay = "wss://recipient.conduit.market"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: { relayUrls: string[]; timeoutMs: number | undefined }[] =
      []
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown, timeoutMs?: number) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push({ relayUrls, timeoutMs })
        if (attempts.length === 1) {
          throw new Error("recipient relay was slow")
        }
        return new Set(relayUrls.map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
      deliveryMode: "critical",
    })

    expect(attempts).toEqual([
      { relayUrls: [normalizedPrimaryRelay], timeoutMs: 10_000 },
      { relayUrls: [normalizedPrimaryRelay], timeoutMs: 15_000 },
    ])
    expect(result.successfulRelayUrls).toEqual([primaryRelay])
    expect(result.failedRelayUrls).toEqual([])
  })

  it("broadens critical recipient delivery to fallback relays after primary retry fails", async () => {
    const primaryRelay = "wss://recipient.conduit.market"
    const normalizedPrimaryRelay = `${primaryRelay}/`
    const attempts: string[][] = []
    const fakeEvent = signedTestEvent({
      publish: async (relaySet: unknown) => {
        const relayUrls = [
          ...((relaySet as { relayUrls?: Set<string> | string[] }).relayUrls ??
            []),
        ]
        attempts.push(relayUrls)
        if (relayUrls.includes(normalizedPrimaryRelay)) {
          throw new Error("recipient relay failed")
        }
        return new Set(relayUrls.slice(0, 1).map((url) => ({ url })))
      },
    })

    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [primaryRelay],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    const result = await publishWithPlanner(fakeEvent, {
      intent: "recipient_event",
      authorPubkey: "alice",
      recipientPubkeys: ["bob"],
      deliveryMode: "critical",
    })

    expect(attempts).toHaveLength(3)
    expect(attempts[0]).toEqual([normalizedPrimaryRelay])
    expect(attempts[1]).toEqual([normalizedPrimaryRelay])
    expect(attempts[2]?.length).toBeGreaterThan(0)
    expect(attempts[2]).toContain(APP_WRITE_ATTEMPT_RELAYS[0])
    expect(result.successfulRelayUrls).toEqual(CANONICAL_APP_WRITE_RELAYS)
    expect(result.failedRelayUrls).toContain(primaryRelay)
  })

  it("does not fall through to NDK default publishing without an approved target", async () => {
    let publishCalls = 0
    const fakeEvent = signedTestEvent({
      publish: async () => {
        publishCalls += 1
        return new Set()
      },
    })
    __setRelayPublishTestOverrides({
      planPublishRelays: async () => ({
        intent: "recipient_event",
        primaryRelayUrls: [],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      }),
    })

    await expect(
      publishWithPlanner(fakeEvent, {
        intent: "recipient_event",
        authorPubkey: AUTHOR_PUBKEY,
      })
    ).rejects.toThrow("without an approved relay target")
    expect(publishCalls).toBe(0)
  })
})

describe("deriveRelayOutcomes", () => {
  const A = "wss://a.conduit.market"
  const B = "wss://b.conduit.market"
  const C = "wss://c.conduit.market"

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

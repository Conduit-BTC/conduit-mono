import { afterEach, describe, expect, it } from "bun:test"
import { matchFilter, nip19, type Filter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { config } from "@conduit/core/config"
import {
  emptyAccountNetworkLocalState,
  orderEquivalentAccountRelayOperations,
} from "@conduit/core/protocol/account-network-local-state"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  getEventMarketReadPlan,
} from "@conduit/core/protocol/event-market"
import { buildEventMarketRosterDraft } from "@conduit/core/protocol/event-market-roster"
import { readEventMarketRoster } from "@conduit/core/protocol/event-market-roster-read"
import { relayTargetsFromUrls } from "@conduit/core/protocol/relay-authority"
import {
  recordRelayRateLimit,
  __resetRelayHealth,
} from "@conduit/core/protocol/relay-health"
import {
  __resetPublicReaderTestState,
  fetchSignedEventsFanoutDetailed,
  type PublicRelayReadOptions,
} from "@conduit/core/protocol/relay-reader"
import {
  __resetRelayPublishTestOverrides,
  publishSignedEventPlan,
} from "@conduit/core/protocol/relay-publish"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const secret = generateSecretKey()
const owner = getPublicKey(secret)
const source = "wss://priority-source.example"
const fallback = "wss://fallback.example"
const event = finalizeEvent(
  { kind: 0, created_at: 100, tags: [], content: "{}" },
  secret
)
const originalConfig = structuredClone(config)
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
const opened: string[] = []
const frames: Array<{ url: string; frame: unknown[] }> = []
let eventsByUrl = new Map<string, SignedPublicNostrEvent[]>()

class Socket {
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  constructor(readonly url: string) {
    opened.push(url)
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event("open"))
    })
  }
  send(payload: string) {
    const frame = JSON.parse(payload) as unknown[]
    frames.push({ url: this.url, frame })
    queueMicrotask(() => {
      if (frame[0] === "REQ") {
        const filters = frame.slice(2) as Filter[]
        for (const event of eventsByUrl.get(this.url) ?? []) {
          if (filters.some((filter) => matchFilter(filter, event))) {
            this.emit(["EVENT", frame[1], event])
          }
        }
        this.emit(["EOSE", frame[1]])
      } else if (frame[0] === "EVENT") {
        this.emit(["OK", (frame[1] as SignedPublicNostrEvent).id, true, ""])
      }
    })
  }
  emit(frame: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent<string>)
  }
  close() {
    this.readyState = 3
  }
}

function readOptions(
  relayUrls: string[],
  accountPubkey?: string
): PublicRelayReadOptions {
  const state = emptyAccountNetworkLocalState(owner)
  state.preferredRelayOrder = [fallback, source]
  return {
    relayUrls,
    relayTargets: relayTargetsFromUrls([fallback, source], {
      kind: "public_hint",
      operation: "read",
    }),
    accountPubkey,
    authenticatedPubkey: accountPubkey,
    accountNetworkLocalStateRepository: { get: async () => state },
    maxRelayAttempts: 1,
    skipHealthFilter: true,
    reuseRelayConnections: false,
    socketScope: { createWebSocket: (url) => new Socket(url) },
    connectTimeoutMs: 100,
    fetchTimeoutMs: 100,
  }
}

afterEach(() => {
  __resetPublicReaderTestState()
  __resetRelayPublishTestOverrides()
  __resetEventMarketTestOverrides()
  __resetRelayHealth()
  Object.assign(config, structuredClone(originalConfig))
  if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor)
  else Reflect.deleteProperty(globalThis, "WebSocket")
  opened.length = 0
  frames.length = 0
  eventsByUrl = new Map()
})

describe("ordered plans through final Account Network I/O", () => {
  for (const accountPubkey of [undefined, owner]) {
    it(`preserves capped source priority and coverage for ${accountPubkey ? "account" : "anonymous"} reads`, async () => {
      eventsByUrl.set(source, [event])
      const result = await fetchSignedEventsFanoutDetailed(
        { kinds: [0] },
        readOptions([source, fallback], accountPubkey)
      )
      expect(opened).toEqual([source])
      expect(result.events.map((event) => event.id)).toEqual([event.id])
      expect(result.admittedRelayUrls).toEqual([source])
      expect(result.attemptedRelayUrls).toEqual([source])
      expect(result.relays.map((relay) => relay.relayUrl)).toEqual([source])
      expect(result.eventSourceRelayUrls[event.id]).toEqual([source])
      expect(result.readCoverage).toBe("complete")
      expect(result.globalAbsence).toBe(false)
    })
  }

  it("normalizes requested order, intersects authority and retains overlapping grants once", async () => {
    const options = readOptions(
      [
        "wss://ungranted.example",
        " WSS://PRIORITY-SOURCE.EXAMPLE/ ",
        source,
        fallback,
      ],
      owner
    )
    options.relayTargets = [
      ...relayTargetsFromUrls([fallback], {
        kind: "public_hint",
        operation: "read",
      }),
      ...relayTargetsFromUrls([source], {
        kind: "app",
        operation: "read",
        bucket: "general_read",
      }),
      ...relayTargetsFromUrls([`${source}/`], {
        kind: "public_hint",
        operation: "read",
      }),
    ]
    const state = emptyAccountNetworkLocalState(owner)
    state.routingPolicy.appRelaysEnabled = false
    options.accountNetworkLocalStateRepository = { get: async () => state }
    const result = await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      options
    )
    expect(opened).toEqual([source])
    expect(result.attemptedRelayUrls).toEqual([source])
  })

  it("uses target order when URLs are omitted and honors an explicitly empty request", async () => {
    const options = readOptions([], owner)
    options.relayTargets = relayTargetsFromUrls([source, fallback], {
      kind: "public_hint",
      operation: "read",
    })
    const empty = await fetchSignedEventsFanoutDetailed({ kinds: [0] }, options)
    expect(empty.readCoverage).toBe("unavailable")
    expect(opened).toEqual([])
    delete options.relayUrls
    const implicit = await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      options
    )
    expect(opened).toEqual([source])
    expect(implicit.admittedRelayUrls).toEqual([source])
  })

  it("deduplicates anonymous URL aliases before spending a bounded attempt", async () => {
    const options = readOptions([
      " WSS://PRIORITY-SOURCE.EXAMPLE/ ",
      source,
      fallback,
    ])
    options.maxRelayAttempts = 2
    const result = await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      options
    )
    expect(opened).toEqual([source, fallback])
    expect(result.attemptedRelayUrls).toEqual([source, fallback])
    expect(result.readCoverage).toBe("complete")
  })

  it("honors local preference within an explicitly equivalent source group before execution", async () => {
    const secondSource = "wss://second-source.example"
    const state = emptyAccountNetworkLocalState(owner)
    state.preferredRelayOrder = [fallback, secondSource, source]
    const repository = { get: async () => state }
    const ordered = await orderEquivalentAccountRelayOperations({
      accountPubkey: owner,
      operations: [
        { relayUrl: source, equivalenceKey: "observed-sources", value: source },
        {
          relayUrl: secondSource,
          equivalenceKey: "observed-sources",
          value: secondSource,
        },
        { relayUrl: fallback, equivalenceKey: "fallback", value: fallback },
      ],
      repository,
    })
    const options = readOptions(
      ordered.map((operation) => operation.value),
      owner
    )
    options.relayTargets = relayTargetsFromUrls(
      [fallback, source, secondSource],
      { kind: "public_hint", operation: "read" }
    )
    options.accountNetworkLocalStateRepository = repository
    await fetchSignedEventsFanoutDetailed({ kinds: [0] }, options)
    expect(opened).toEqual([secondSource])
  })

  it("backfills excluded and throttled prefixes without counting them as attempts or absence", async () => {
    const excluded = "wss://excluded-prefix.example"
    const throttled = "wss://throttled-prefix.example"
    const options = readOptions([excluded, throttled, source, fallback], owner)
    options.relayTargets = relayTargetsFromUrls(options.relayUrls!, {
      kind: "public_hint",
      operation: "read",
    })
    const state = emptyAccountNetworkLocalState(owner)
    state.exclusions = [
      {
        relayUrl: excluded,
        committedAt: Date.now(),
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
      },
    ]
    options.accountNetworkLocalStateRepository = { get: async () => state }
    recordRelayRateLimit(throttled)
    const result = await fetchSignedEventsFanoutDetailed(
      { kinds: [0] },
      options
    )
    expect(opened).toEqual([source])
    expect(result.attemptedRelayUrls).toEqual([source])
    expect(result.relays.some((relay) => relay.relayUrl === excluded)).toBe(
      false
    )
    expect(
      result.relays.find((relay) => relay.relayUrl === throttled)?.outcome
    ).toBe("rate_limited")
    expect(result.readCoverage).toBe("partial")
    expect(result.globalAbsence).toBe(false)
  })

  it("preserves capped write priority through target intersection and the real writer", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: Socket,
    })
    const state = emptyAccountNetworkLocalState(owner)
    state.preferredRelayOrder = [fallback, source]
    const result = await publishSignedEventPlan({
      event,
      relayUrls: [source, fallback],
      relayTargets: relayTargetsFromUrls([fallback, source], {
        kind: "source_delivery",
        operation: "write",
      }),
      accountPubkey: owner,
      authenticatedPubkey: owner,
      accountNetworkLocalStateRepository: { get: async () => state },
      maxRelayAttempts: 1,
      requiredRelayCount: 1,
      timeoutMs: 100,
    })
    expect(opened).toEqual([source])
    expect(result.attemptedRelayUrls).toEqual([source])
    expect(result.successfulRelayUrls).toEqual([source])
    expect(
      frames
        .filter(({ frame }) => frame[0] === "EVENT")
        .map(({ frame }) => frame[1])
    ).toEqual([JSON.parse(JSON.stringify(event))])
  })

  it("backfills a capped write when live policy removes the first candidate before socket admission", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: Socket,
    })
    const state = emptyAccountNetworkLocalState(owner)
    const excluded = {
      ...state,
      exclusions: [
        {
          relayUrl: source,
          committedAt: Date.now(),
          relayListFrontier: { eventId: null, createdAt: null },
          inboxDeclarationFrontier: { eventId: null, createdAt: null },
        },
      ],
    }
    let policyReads = 0
    const result = await publishSignedEventPlan({
      event,
      relayUrls: [source, fallback],
      relayTargets: relayTargetsFromUrls([source, fallback], {
        kind: "source_delivery",
        operation: "write",
      }),
      accountPubkey: owner,
      authenticatedPubkey: owner,
      accountNetworkLocalStateRepository: {
        get: async () => (++policyReads === 1 ? state : excluded),
      },
      maxRelayAttempts: 1,
      requiredRelayCount: 1,
      timeoutMs: 100,
    })
    expect(opened).toEqual([fallback])
    expect(result.attemptedRelayUrls).toEqual([fallback])
    expect(result.admittedRelayUrls).toEqual([fallback])
    expect(result.successfulRelayUrls).toEqual([fallback])
    expect(
      result.relayAttempts.find((attempt) => attempt.relayUrl === source)
        ?.status
    ).toBe("policy_blocked")
  })

  for (const accountPubkey of [undefined, owner]) {
    it(`reads portable Event Market source hints through the real capped ${accountPubkey ? "account" : "anonymous"} consumer`, async () => {
      const organizerSecret = generateSecretKey()
      const organizer = getPublicKey(organizerSecret)
      const hints = Array.from(
        { length: 7 },
        (_, i) => `wss://portable-${i}.fixture.conduit.market`
      )
      const fallbacks = Array.from(
        { length: 8 },
        (_, i) => `wss://commerce-fallback-${i}.example`
      )
      config.appCommerceRelayUrls = fallbacks
      config.commerceDiscoveryRelayUrls = []
      __setEventMarketTestOverrides({
        readAccountRelaySettingsPlanningSnapshot: async () => ({
          settings: { version: 1, updatedAt: 1, entries: [] },
          signedRelayListAuthoritative: true,
        }),
        getRelayListsDetailed: async () => ({
          relayLists: new Map(),
          resolutionStates: new Map([[organizer, "missing"]]),
        }),
      })
      const draft = buildEventMarketRosterDraft({
        dTag: "fair",
        organizerPubkey: organizer,
        calendarCoordinate: `31923:${organizer}:calendar`,
        state: "open",
        merchants: [],
      })
      const roster = finalizeEvent(
        { ...draft, created_at: 100 },
        organizerSecret
      )
      eventsByUrl.set(hints[6]!, [roster])
      const state = emptyAccountNetworkLocalState(owner)
      state.preferredRelayOrder = [...fallbacks, ...hints]
      const reads: Awaited<
        ReturnType<typeof fetchSignedEventsFanoutDetailed>
      >[] = []
      const result = await readEventMarketRoster(
        {
          reference: nip19.naddrEncode({
            kind: 30409,
            pubkey: organizer,
            identifier: "fair",
            relays: hints,
          }),
          authenticatedPubkey: accountPubkey,
        },
        {
          plan: getEventMarketReadPlan,
          fetch: async (filter, options) => {
            const read = await fetchSignedEventsFanoutDetailed(filter, {
              ...options,
              accountNetworkLocalStateRepository: { get: async () => state },
              socketScope: { createWebSocket: (url) => new Socket(url) },
              reuseRelayConnections: false,
              skipHealthFilter: true,
              fetchTimeoutMs: 100,
              connectTimeoutMs: 100,
            })
            reads.push(read)
            return read
          },
          load: async () => [],
          retain: async () => {},
        }
      )
      expect(result.resolution.state).toBe("current")
      expect(
        reads.some((read) =>
          read.events.some((event) => event.id === roster.id)
        )
      ).toBe(true)
      for (const read of reads) {
        expect(read.attemptedRelayUrls).toHaveLength(8)
        expect(read.attemptedRelayUrls).toContain(hints[6]!)
        expect(read.admittedRelayUrls).toEqual(read.attemptedRelayUrls)
        expect(read.readCoverage).toBe("complete")
      }
    })
  }
})

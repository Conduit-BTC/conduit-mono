import { finalizeEvent, getPublicKey } from "nostr-tools"
import { config } from "../../packages/core/src/config"
import { getProfiles } from "../../packages/core/src/protocol/commerce"
import {
  buildEventMarketCalendarDraft,
  encodeEventMarketNaddr,
} from "../../packages/core/src/protocol/event-market"
import { buildEventMarketRosterDraft } from "../../packages/core/src/protocol/event-market-roster"
import { buildEventMarketSeriesDraft } from "../../packages/core/src/protocol/event-market-schedule"
import { buildEventMarketAssignmentDraft } from "../../packages/core/src/protocol/event-market-assignment"
import { buildEventMarketAuthorizationDraft } from "../../packages/core/src/protocol/event-market-authorization"
import { readEventMarketAuthorization } from "../../packages/core/src/protocol/event-market-authorization-read"
import {
  discoverFutureEventMarkets,
  readEventMarketAssignment,
  readEventMarketCatalog,
  readEventMarketRoster,
  type FutureEventMarketDiscoveryResult,
} from "../../packages/core/src/protocol/event-market-roster-read"
import { eventMarketEvidenceStore } from "../../packages/core/src/protocol/event-market-evidence-store"
import {
  isEventMarketAuthorizationWriteReady,
  isEventMarketRosterWriteReady,
} from "../../packages/core/src/protocol/event-market-write-readiness"
import { ingestRelayListEvent } from "../../packages/core/src/protocol/relay-list"
import { closePublicRelayConnections } from "../../packages/core/src/protocol/relay-reader"
import { __resetRelayHealth } from "../../packages/core/src/protocol/relay-health"

// Disposable fixtures; this app mounts bounded read journeys, not production routes.
const organizerKey = new Uint8Array(32).fill(41)
const merchantKey = new Uint8Array(32).fill(42)
const organizer = getPublicKey(organizerKey)
const merchant = getPublicKey(merchantKey)
const configured = [
  "wss://event-a.feed-fixture.net",
  "wss://event-b.feed-fixture.net",
]
const hints = Array.from(
  { length: 120 },
  (_, index) => `wss://event-advertised-${index}.feed-fixture.net`
)
const outsideFallback = "wss://event-fallback.feed-fixture.net"
Object.assign(config, {
  e2eRelayIsolationEnabled: false,
  appCommerceRelayUrls: configured,
  commerceDiscoveryRelayUrls: configured,
  appReadRelayUrls: configured,
  appBackplaneRelayUrls: configured.slice(0, 1),
  defaultRelays: [outsideFallback],
  corePublicFallbackRelayUrls: [outsideFallback],
})
const coordinate = (name: string) => `30409:${organizer}:${name}`
const market = coordinate("active")
const removed = coordinate("removed")
const occurrence = `31922:${organizer}:date`
const seriesCoordinate = `31924:${organizer}:series`
const productCoordinate = `30402:${merchant}:product`
const merchants = [
  {
    pubkey: merchant,
    mode: "merchant_present" as const,
    assignment: "Fixture booth",
  },
]
const signRoster = (
  name: string,
  created_at: number,
  state: "open" | "closed" = "open"
) =>
  finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag: name,
        organizerPubkey: organizer,
        calendarCoordinate: seriesCoordinate,
        state,
        merchants,
      }),
      created_at,
    },
    organizerKey
  )
const oldRoster = signRoster("active", 100)
const newerRoster = signRoster("active", 200, "closed")
const removedRoster = signRoster("removed", 101)
const tombstone = finalizeEvent(
  {
    kind: 5,
    created_at: 300,
    content: "",
    tags: [
      ["a", removed],
      ["k", "30409"],
    ],
  },
  organizerKey
)
const calendar = finalizeEvent(
  {
    ...buildEventMarketCalendarDraft({
      kind: 31922,
      dTag: "date",
      title: "Fixture date",
      start: "2035-01-01",
      end: "2035-01-02",
    }),
    created_at: 100,
  },
  organizerKey
)
const series = finalizeEvent(
  {
    ...buildEventMarketSeriesDraft({
      dTag: "series",
      organizerPubkey: organizer,
      title: "Fixture series",
      memberCoordinates: [occurrence],
    }),
    created_at: 100,
  },
  organizerKey
)
const grant = finalizeEvent(
  {
    ...buildEventMarketAuthorizationDraft({
      marketCoordinate: market,
      merchantPubkey: merchant,
      state: "active",
      sequence: 0,
      parentIds: [],
    }),
    created_at: 100,
  },
  organizerKey
)
const revoke = finalizeEvent(
  {
    ...buildEventMarketAuthorizationDraft({
      marketCoordinate: market,
      merchantPubkey: merchant,
      state: "revoked",
      sequence: 1,
      parentIds: [grant.id],
    }),
    created_at: 200,
  },
  organizerKey
)
const product = finalizeEvent(
  {
    kind: 30402,
    created_at: 100,
    content: "Fixture physical item",
    tags: [
      ["d", "product"],
      ["title", "Fixture item"],
      ["price", "10", "SATS"],
      ["type", "simple", "physical"],
      ["image", "https://event-image.synthetic.invalid/item.png"],
    ],
  },
  merchantKey
)
const assignment = finalizeEvent(
  {
    ...buildEventMarketAssignmentDraft({
      marketCoordinate: market,
      occurrenceCoordinate: occurrence,
      productCoordinate,
      merchantPubkey: merchant,
      state: "active",
      inventory: { mode: "untracked" },
      fulfillmentMethods: ["pickup"],
      relayHints: { market: hints[0], occurrence: hints[1], product: hints[2] },
    }),
    created_at: 100,
  },
  merchantKey
)
// 130 distinct coordinates exceed the production exact-hydration budget of 128.
const filler = Array.from({ length: 128 }, (_, index) =>
  signRoster(`page-${index}`, 10 + index)
)
const fillerDeletion = finalizeEvent(
  {
    kind: 5,
    created_at: 400,
    content: "",
    tags: filler.map((event) => [
      "a",
      coordinate(event.tags.find((tag) => tag[0] === "d")![1]!),
    ]),
  },
  organizerKey
)
const relayList = finalizeEvent(
  {
    kind: 10002,
    created_at: 100,
    content: "",
    tags: hints.map((url) => ["r", url, "write"]),
  },
  organizerKey
)
const merchantRelayList = finalizeEvent(
  {
    kind: 10002,
    created_at: 100,
    content: "",
    tags: hints.map((url) => ["r", url, "write"]),
  },
  merchantKey
)
const profile = finalizeEvent(
  {
    kind: 0,
    created_at: 100,
    content: JSON.stringify({ name: "Fixture organizer" }),
    tags: [],
  },
  organizerKey
)
// Production link encoding keeps its existing eight-hint bound; NIP-65/cache
// still advertises all 120 sources, and none may expand feed destinations.
const link = encodeEventMarketNaddr(market, hints)
const publicEvents = [
  oldRoster,
  removedRoster,
  ...filler,
  fillerDeletion,
  calendar,
  series,
  grant,
  product,
  assignment,
  relayList,
  merchantRelayList,
  profile,
]
const fixtures = {
  configured,
  hints,
  outsideFallback,
  publicEvents,
  authorityEvents: [...publicEvents, newerRoster, revoke],
  market,
  removed,
  occurrence,
}
export type PublicEventFeedFixtures = typeof fixtures

let continuation: FutureEventMarketDiscoveryResult["continuation"]
const actions = [
  "browse",
  "refresh",
  "continue",
  "catalog",
  "support",
  "organizer action",
] as const
type Action = (typeof actions)[number]
const summary = (result: FutureEventMarketDiscoveryResult) => ({
  count: result.markets.length,
  names: result.markets.map((read) => read.coordinate.split(":").at(-1)),
  coverage: result.coverage,
  hasMore: !!result.continuation,
  pending: result.continuation?.pendingCoordinates.length ?? 0,
  pendingNames:
    result.continuation?.pendingCoordinates.map((entry) =>
      entry.coordinate.split(":").at(-1)
    ) ?? [],
  removedState: result.markets.find((read) => read.coordinate === removed)
    ?.resolution.state,
  activeState: (() => {
    const resolution = result.markets.find(
      (read) => read.coordinate === market
    )?.resolution
    return resolution?.state === "current"
      ? resolution.market.state
      : resolution?.state
  })(),
  displayOnly: result.markets.every(
    (read) =>
      read.readScope === "public_feed" && !isEventMarketRosterWriteReady(read)
  ),
})
async function run(action: Action): Promise<Record<string, unknown>> {
  closePublicRelayConnections()
  if (action === "browse" || action === "refresh" || action === "continue") {
    if (action === "continue" && !continuation)
      throw new Error("No real continuation available")
    let snapshots = 0
    const result = await discoverFutureEventMarkets({
      organizerPubkeys: [organizer],
      continuation: action === "continue" ? continuation : undefined,
      onProgress: () => {
        snapshots++
      },
    })
    continuation = result.continuation
    return { ...summary(result), snapshots }
  }
  if (action === "catalog") {
    const result = await readEventMarketCatalog({
      reference: link,
      selectedOccurrenceCoordinate: occurrence,
    })
    return {
      coverage: result.coverage,
      marketState:
        result.marketRead.resolution.state === "current"
          ? result.marketRead.resolution.market.state
          : result.marketRead.resolution.state,
      schedule: result.marketRead.schedule?.kind,
      calendar: result.marketRead.calendar?.coordinate,
      productCount: result.products.length,
      displayOnly:
        result.marketRead.readScope === "public_feed" &&
        !isEventMarketRosterWriteReady(result.marketRead),
    }
  }
  if (action === "support") {
    const [authorization, assigned, profiles, roster] = await Promise.all([
      readEventMarketAuthorization({
        marketCoordinate: market,
        merchantPubkey: merchant,
        readScope: "public_feed",
      }),
      readEventMarketAssignment({
        marketCoordinate: market,
        occurrenceCoordinate: occurrence,
        productCoordinate,
        readScope: "public_feed",
      }),
      getProfiles({
        pubkeys: [organizer],
        readScope: "public_feed",
        skipCache: true,
        relayHintsByPubkey: { [organizer]: hints },
      }),
      readEventMarketRoster({ reference: link, readScope: "public_feed" }),
    ])
    return {
      authorizationState: authorization.resolution.state,
      authorizationCoverage: authorization.coverage,
      actionable: authorization.actionable,
      writeReady: isEventMarketAuthorizationWriteReady(authorization),
      assignmentState: assigned.state,
      profileComplete: profiles.profileContexts[organizer]?.readComplete,
      schedule: roster.schedule?.kind,
    }
  }
  const result = await readEventMarketAuthorization({
    marketCoordinate: market,
    merchantPubkey: merchant,
  })
  return {
    state: result.resolution.state,
    coverage: result.coverage,
    scope: result.readScope ?? "authority",
    actionable: result.actionable,
    writeReady: isEventMarketAuthorizationWriteReady(result),
  }
}
declare global {
  interface Window {
    publicEventFeedHarness: {
      fixtures: PublicEventFeedFixtures
      resetHealth: () => void
    }
  }
}
window.publicEventFeedHarness = {
  fixtures,
  resetHealth: () => {
    closePublicRelayConnections()
    __resetRelayHealth()
  },
}
async function prepare() {
  await ingestRelayListEvent(relayList, hints)
  await ingestRelayListEvent(merchantRelayList, hints)
  await eventMarketEvidenceStore.retain(market, [
    newerRoster,
    calendar,
    series,
    grant,
    revoke,
    assignment,
    product,
  ])
  await eventMarketEvidenceStore.retain(removed, [removedRoster, tombstone])
  const output = document.querySelector<HTMLPreElement>("#result")!
  const status = document.querySelector<HTMLOutputElement>("#status")!
  for (const action of actions) {
    const button = document.createElement("button")
    button.textContent = action
    button.addEventListener("click", async () => {
      status.textContent = `Running ${action}`
      output.textContent = ""
      try {
        output.textContent = JSON.stringify({ action, ...(await run(action)) })
      } catch (error) {
        output.textContent = JSON.stringify({
          action,
          error: error instanceof Error ? error.name : "unknown",
        })
      }
      status.textContent = "Ready"
    })
    document.querySelector("#controls")!.append(button)
  }
  status.textContent = "Ready"
}
void prepare().catch(() => {
  document.querySelector("#status")!.textContent = "Synthetic setup failed"
})

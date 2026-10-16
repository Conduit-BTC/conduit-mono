import { afterEach, expect, it, spyOn } from "bun:test"
import { matchFilter, type Filter } from "nostr-tools"
import { finalizeEvent } from "nostr-tools/pure"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  getEventMarketDiscoveryReadPlan,
  getEventMarketReadPlan,
} from "../packages/core/src/protocol/event-market"
import {
  __resetOwnerRelayListEvidenceForTests,
  createInMemoryOwnerRelayListEvidenceRepository,
  dexieOwnerRelayListEvidenceRepository,
  reconcileOwnerRelayListEvidence,
} from "../packages/core/src/protocol/owner-relay-list-evidence"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { discoverFutureEventMarkets } from "../packages/core/src/protocol/event-market-roster-read"
import {
  __resetPublicReaderTestState,
  fetchSignedEventsFanoutDetailed,
  verifySignedEventBatches,
  type PublicRelayReadSocket,
} from "../packages/core/src/protocol/relay-reader"
import { fixture } from "./helpers/future-market-discovery-fixture"

afterEach(() => {
  __resetEventMarketTestOverrides()
  __resetOwnerRelayListEvidenceForTests()
  __resetPublicReaderTestState()
})

it.each([
  { scope: "own", authority: "owner", discovers: true },
  { scope: "combined", authority: "owner", discovers: true },
  { scope: "own", authority: "recovering", discovers: false },
  { scope: "other", authority: "owner", discovers: false },
  { scope: "own", authority: "mismatched", discovers: false },
])(
  "cold $scope discovery with $authority authority respects the owner's write-only transport",
  async ({ scope, authority, discovers }) => {
    const state = fixture(2)
    const record = state.records[0]!
    const owner = record.author
    const other = state.records[1]!.author
    const ownerRelay = "ws://owner-write.example:4848"
    const evidence = createInMemoryOwnerRelayListEvidenceRepository()
    const selection = finalizeEvent(
      {
        kind: 10002,
        created_at: 100,
        tags: [["r", ownerRelay, "write"]],
        content: "",
      },
      record.secret
    )
    await reconcileOwnerRelayListEvidence(
      {
        pubkey: owner,
        observations: [
          { signedEvent: (await verifySignedEventBatches([selection]))[0]! },
        ],
        lookup: {
          observedAt: Date.now(),
          coverage: "complete",
          hadEvent: true,
          eventId: selection.id,
        },
      },
      evidence
    )
    // Substitute persistence only. Both planners read the validated signed
    // selection through the production durable-snapshot adapter.
    const retained = spyOn(
      dexieOwnerRelayListEvidenceRepository,
      "get"
    ).mockImplementation((pubkey) => evidence.get(pubkey))
    __setEventMarketTestOverrides({
      getRelayListsDetailed: async (authors) => ({
        relayLists: new Map(),
        resolutionStates: new Map(authors.map((author) => [author, "missing"])),
      }),
    })
    const contacted: string[] = []
    try {
      const result = await discoverFutureEventMarkets(
        {
          organizerPubkeys:
            scope === "combined"
              ? [other, owner]
              : [scope === "own" ? owner : other],
          accountPubkey: owner,
          authenticatedPubkey:
            authority === "recovering"
              ? null
              : authority === "mismatched"
                ? other
                : owner,
        },
        {
          ...state.dependencies,
          planDiscovery: getEventMarketDiscoveryReadPlan,
          plan: getEventMarketReadPlan,
          fetch: async (filter, options) =>
            fetchSignedEventsFanoutDetailed(filter, {
              ...options,
              ownerRelayListEvidenceRepository: evidence,
              accountNetworkLocalStateRepository: {
                get: async () => emptyAccountNetworkLocalState(owner),
              },
              reuseRelayConnections: false,
              skipHealthFilter: true,
              connectTimeoutMs: 100,
              fetchTimeoutMs: 100,
              socketScope: {
                createWebSocket: (url) => {
                  contacted.push(url)
                  const socket: PublicRelayReadSocket = {
                    readyState: 0,
                    onopen: null,
                    onmessage: null,
                    onerror: null,
                    onclose: null,
                    send: (payload) => {
                      const [type, id] = JSON.parse(payload)
                      if (type !== "REQ") return
                      queueMicrotask(() => {
                        if (url === ownerRelay)
                          for (const event of [record.roster, record.calendar])
                            if (matchFilter(filter as Filter, event))
                              socket.onmessage?.({
                                data: JSON.stringify(["EVENT", id, event]),
                              } as MessageEvent<string>)
                        socket.onmessage?.({
                          data: JSON.stringify(["EOSE", id]),
                        } as MessageEvent<string>)
                      })
                    },
                    close: () => {
                      socket.readyState = 3
                    },
                  }
                  queueMicrotask(() => {
                    socket.readyState = 1
                    socket.onopen?.(new Event("open"))
                  })
                  return socket
                },
              },
            }),
        }
      )
      expect(contacted.includes(ownerRelay)).toBe(discovers)
      expect(new Set(contacted).size).toBeLessThanOrEqual(8)
      expect(result.markets).toHaveLength(discovers ? 1 : 0)
      if (discovers) {
        expect(result.markets[0]?.resolution.state).toBe("current")
        expect(result.markets[0]?.calendar?.eventId).toBe(record.calendar.id)
        expect(result.markets[0]?.observedRelayUrls).toContain(ownerRelay)
      }
    } finally {
      retained.mockRestore()
    }
  }
)

import { expect, it } from "bun:test"
import { finalizeEvent } from "nostr-tools/pure"
import {
  createInMemoryOwnerRelayListEvidenceRepository,
  reconcileOwnerRelayListEvidence,
} from "../packages/core/src/protocol/owner-relay-list-evidence"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { discoverFutureEventMarkets } from "../packages/core/src/protocol/event-market-roster-read"
import { relayTargetsFromUrls } from "../packages/core/src/protocol/relay-authority"
import {
  __resetPublicReaderTestState,
  fetchSignedEventsFanoutDetailed,
  verifySignedEventBatches,
  type PublicRelayReadSocket,
} from "../packages/core/src/protocol/relay-reader"
import { fixture } from "./helpers/future-market-discovery-fixture"

it("contacts owner-only discovery relays only while signer authority is present, including recovery and reconnection", async () => {
  const state = fixture(1)
  const owner = state.records[0]!.author
  const ownerRelay = "wss://owner-only.example"
  const publicRelay = "wss://public.example"
  const relayUrls = [ownerRelay, publicRelay]
  const evidence = createInMemoryOwnerRelayListEvidenceRepository()
  const selection = finalizeEvent(
    {
      kind: 10002,
      created_at: 100,
      tags: [["r", ownerRelay, "read"]],
      content: "",
    },
    state.records[0]!.secret
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
  const relayTargets = [
    ...relayTargetsFromUrls([ownerRelay], {
      kind: "owner_nip65",
      operation: "read",
      ownerPubkey: owner,
      selection: "read",
    }),
    ...relayTargetsFromUrls([publicRelay], {
      kind: "public_hint",
      operation: "read",
    }),
  ]
  try {
    for (const authenticatedPubkey of [owner, null, owner]) {
      const contacted: string[] = []
      const accountScopes: boolean[] = []
      await discoverFutureEventMarkets(
        {
          organizerPubkeys: [owner],
          accountPubkey: owner,
          authenticatedPubkey,
        },
        {
          ...state.dependencies,
          planDiscovery: async () => ({
            ...(await state.dependencies.planDiscovery!({})),
            relayUrls,
            candidateRelayUrls: relayUrls,
            relayTargets,
          }),
          fetch: async (filter, options) => {
            accountScopes.push(options.accountPubkey === owner)
            return fetchSignedEventsFanoutDetailed(filter, {
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
                      if (type === "REQ")
                        queueMicrotask(() =>
                          socket.onmessage?.({
                            data: JSON.stringify(["EOSE", id]),
                          } as MessageEvent<string>)
                        )
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
            })
          },
        }
      )
      expect(accountScopes.length).toBeGreaterThan(0)
      expect(accountScopes.every(Boolean)).toBe(true)
      expect(contacted.includes(ownerRelay)).toBe(authenticatedPubkey !== null)
      expect(contacted.includes(publicRelay)).toBe(true)
    }
  } finally {
    __resetPublicReaderTestState()
  }
})

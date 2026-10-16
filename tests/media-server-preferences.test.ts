import { beforeEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  kinds,
} from "nostr-tools"
import { config } from "../packages/core/src/config"
import {
  __resetMediaServerPreferencesForTests,
  addMediaServerPreference,
  BLOSSOM_SERVER_LIST_KIND,
  moveMediaServerPreference,
  normalizeBlossomServerRoot,
  normalizeMediaServerPreferenceOwner,
  parseBlossomServerListTags,
  readMediaServerPreferences,
  loadMediaServerPreferenceRecord,
  selectMediaServerPreferenceUse,
  removeMediaServerPreference,
  selectLatestValidBlossomServerListEvent,
  serializeBlossomServerListTags,
  type MediaServerPreferencesStorage,
} from "../packages/core/src/protocol/media-server-preferences"
import { planRelayReads } from "../packages/core/src/protocol/relay-planner"
import { createRelaySettingsFromPreferences } from "../packages/core/src/protocol/relay-settings"
import { NostrSignerError } from "../packages/core/src/protocol/nostr-event-signer"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { createInMemoryOwnerRelayListEvidenceRepository } from "../packages/core/src/protocol/owner-relay-list-evidence"
import { fetchSignedEventsFanoutDetailed } from "../packages/core/src/protocol/relay-reader"
import type { SignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"
import { admitFixture } from "./helpers/public-event"

const OWNER_KEY = generateSecretKey()
const OTHER_KEY = generateSecretKey()
const OWNER = getPublicKey(OWNER_KEY)
const OTHER_OWNER = getPublicKey(OTHER_KEY)

class MemoryStorage implements MediaServerPreferencesStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function event(
  tags: string[][],
  options: {
    createdAt?: number
    secretKey?: Uint8Array
    kind?: number
  } = {}
): SignedPublicNostrEvent {
  const secretKey = options.secretKey ?? OWNER_KEY
  return finalizeEvent(
    {
      kind: options.kind ?? BLOSSOM_SERVER_LIST_KIND,
      created_at: options.createdAt ?? 100,
      tags,
      content: "",
    },
    secretKey
  )
}

async function relayRead(
  events: SignedPublicNostrEvent[],
  relays: Array<{
    relayUrl: string
    status: "success" | "partial" | "failed"
    rejectedEventCount?: number
  }>,
  sources: Record<string, string[]> = {},
  admittedRelayUrls?: string[]
) {
  return {
    events: await Promise.all(events.map(admitFixture)),
    eventSourceRelayUrls: sources,
    ...(admittedRelayUrls ? { admittedRelayUrls } : {}),
    relays: relays.map((relay) => ({
      ...relay,
      eventCount: events.length,
    })),
  }
}

beforeEach(() => {
  __resetMediaServerPreferencesForTests()
})

describe("BUD-03 media server preference parsing", () => {
  it("uses the installed nostr-tools kind constant", () => {
    expect(BLOSSOM_SERVER_LIST_KIND).toBe(kinds.BlossomServerList)
    expect(BLOSSOM_SERVER_LIST_KIND).toBe(10063)
  })

  it("canonicalizes only public HTTPS origins", () => {
    const credentialUrl = new URL("https://media.conduit.market")
    credentialUrl.username = ["us", "er"].join("")
    credentialUrl.password = ["sec", "ret"].join("")
    expect(normalizeBlossomServerRoot("https://CONDUIT.MARKET:443/")).toBe(
      "https://conduit.market"
    )
    expect(
      normalizeBlossomServerRoot("https://media.conduit.market:8443")
    ).toBe("https://media.conduit.market:8443")

    for (const unsafe of [
      "http://media.conduit.market",
      credentialUrl.toString(),
      "https://media.conduit.market/path",
      "https://media.conduit.market/?token=secret",
      "https://media.conduit.market/#fragment",
      "https://localhost",
      "https://127.0.0.1",
      "https://10.0.0.1",
      "https://169.254.1.1",
      "https://media.local",
      "not a URL",
    ]) {
      expect(normalizeBlossomServerRoot(unsafe)).toBeNull()
    }
    expect(() => normalizeMediaServerPreferenceOwner("not-a-pubkey")).toThrow(
      "valid connected account"
    )
  })

  it("preserves signed order and serializes the displayed list exactly", () => {
    const tags = [
      ["client", "another-app"],
      ["server", "https://two.conduit.market"],
      ["server", "https://one.conduit.market/"],
    ]
    expect(parseBlossomServerListTags(tags)).toEqual({
      state: "valid",
      serverUrls: ["https://two.conduit.market", "https://one.conduit.market"],
      serverTagCount: 2,
      malformedTagCount: 0,
      duplicateTagCount: 0,
    })
    expect(
      serializeBlossomServerListTags([
        "https://two.conduit.market",
        "https://one.conduit.market",
      ])
    ).toEqual([
      ["server", "https://two.conduit.market"],
      ["server", "https://one.conduit.market"],
    ])
    expect(
      serializeBlossomServerListTags(
        Array.from(
          { length: 13 },
          (_, index) => `https://server-${index}.conduit.market`
        )
      )
    ).toHaveLength(13)
  })

  it("rejects unsafe tags and deduplicates valid tags in signed order", () => {
    expect(parseBlossomServerListTags([]).state).toBe("empty")
    expect(
      parseBlossomServerListTags([
        ["server", "https://safe.conduit.market"],
        ["server", "http://unsafe.conduit.market"],
      ])
    ).toMatchObject({
      state: "malformed",
      serverUrls: ["https://safe.conduit.market"],
      malformedTagCount: 1,
    })
    expect(
      parseBlossomServerListTags([
        ["server", "https://same.conduit.market", "client-extension"],
        ["server", "https://same.conduit.market/"],
      ])
    ).toMatchObject({
      state: "valid",
      serverUrls: ["https://same.conduit.market"],
      duplicateTagCount: 1,
    })
    expect(() =>
      serializeBlossomServerListTags([
        "https://same.conduit.market",
        "https://same.conduit.market/",
      ])
    ).toThrow("already in the ordered list")
  })

  it("supports add, remove, and order-sensitive movement without publishing", () => {
    const added = addMediaServerPreference(
      ["https://one.conduit.market"],
      "https://two.conduit.market/"
    )
    expect(added).toEqual([
      "https://one.conduit.market",
      "https://two.conduit.market",
    ])
    expect(moveMediaServerPreference(added, 1, 0)).toEqual([
      "https://two.conduit.market",
      "https://one.conduit.market",
    ])
    expect(
      removeMediaServerPreference(added, "https://one.conduit.market")
    ).toEqual(["https://two.conduit.market"])
    expect(() =>
      addMediaServerPreference(added, "https://two.conduit.market")
    ).toThrow("already in the ordered list")
  })
})

describe("kind 10063 replacement selection and evidence", () => {
  it("selects the latest valid owner event with the NIP-01 lowest-id tie break", async () => {
    const older = event([["server", "https://older.conduit.market"]], {
      createdAt: 10,
    })
    const tiedA = event([["server", "https://a.conduit.market"]], {
      createdAt: 11,
    })
    const tiedB = event([["server", "https://b.conduit.market"]], {
      createdAt: 11,
    })
    const malformedNewer = event([["server", "http://unsafe.conduit.market"]], {
      createdAt: 12,
    })
    const otherOwner = event([["server", "https://other.conduit.market"]], {
      createdAt: 99,
      secretKey: OTHER_KEY,
    })
    const wrongKind = event([["server", "https://wrong-kind.conduit.market"]], {
      createdAt: 100,
      kind: 10002,
    })
    const expectedTie = [tiedA, tiedB].sort((left, right) =>
      left.id.localeCompare(right.id)
    )[0]!

    const selected = selectLatestValidBlossomServerListEvent(
      await Promise.all(
        [older, tiedA, tiedB, malformedNewer, otherOwner, wrongKind].map(
          admitFixture
        )
      ),
      OWNER
    )
    expect(selected?.event.id).toBe(expectedTie.id)
    expect(selected?.parsed.serverUrls).toEqual(
      parseBlossomServerListTags(expectedTie.tags).serverUrls
    )
    expect(selected?.event.pubkey).not.toBe(OTHER_OWNER)
  })

  it("carries an exact authenticated owner ws selection through lookup, planning, and final I/O", async () => {
    const ownerWsRelay = "ws://owner-selected.example"
    const ownerWssRelay = "wss://owner-selected.example"
    const remoteWsRelay = "ws://remote-source.example"
    const lookupCalls: Array<{
      relayUrls: readonly string[] | undefined
      accountPubkey: string | null | undefined
      authenticatedPubkey: string | null | undefined
      ownerSelectedRelayUrls: readonly string[] | undefined
      appRelayUrls: readonly string[] | undefined
      personalRelayUrls: readonly string[] | undefined
      maxRelayAttempts: number | undefined
      allowInsecureRelayUrlsForPubkey: string | null | undefined
    }> = []
    const plannerCalls: Array<{
      intent: string
      authenticatedPubkey: string | null | undefined
      ownerSelectedRelayUrls: readonly string[] | undefined
      signedRelayListAuthoritative: boolean | undefined
    }> = []
    const finalReadCalls: Array<{
      relayUrls: readonly string[]
      relayTargets:
        | readonly import("../packages/core/src/protocol/relay-authority").RelayTarget[]
        | undefined
      accountPubkey: string | null | undefined
      authenticatedPubkey: string | null | undefined
    }> = []

    await readMediaServerPreferences(OWNER, {
      authenticatedPubkey: OWNER,
      storage: null,
      readAccountRelaySettingsPlanningSnapshot: async (pubkey) => {
        expect(pubkey).toBe(OWNER)
        return {
          settings: createRelaySettingsFromPreferences([
            {
              url: ownerWsRelay,
              readEnabled: true,
              writeEnabled: true,
            },
            {
              url: ownerWssRelay,
              readEnabled: true,
              writeEnabled: false,
            },
          ]),
          signedRelayListAuthoritative: true,
        }
      },
      getRelayLists: async (_pubkeys, options = {}) => {
        lookupCalls.push({
          relayUrls: options.relayUrls,
          accountPubkey: options.accountPubkey,
          authenticatedPubkey: options.authenticatedPubkey,
          ownerSelectedRelayUrls: options.ownerSelectedRelayUrls,
          appRelayUrls: options.appRelayUrls,
          personalRelayUrls: options.personalRelayUrls,
          maxRelayAttempts: options.maxRelayAttempts,
          allowInsecureRelayUrlsForPubkey:
            options.allowInsecureRelayUrlsForPubkey,
        })
        return new Map([
          [
            OWNER,
            {
              pubkey: OWNER,
              readRelayUrls: [remoteWsRelay],
              writeRelayUrls: [remoteWsRelay],
              eventCreatedAt: 100,
              cachedAt: 100,
            },
          ],
        ])
      },
      planReads: (input) => {
        plannerCalls.push({
          intent: input.intent,
          authenticatedPubkey: input.authenticatedPubkey,
          ownerSelectedRelayUrls: input.ownerSelectedRelayUrls,
          signedRelayListAuthoritative: input.signedRelayListAuthoritative,
        })
        return planRelayReads(input)
      },
      fetchEvents: async (_filter, options) => {
        finalReadCalls.push({
          relayUrls: options.relayUrls,
          relayTargets: options.relayTargets,
          accountPubkey: options.accountPubkey,
          authenticatedPubkey: options.authenticatedPubkey,
        })
        return relayRead(
          [],
          options.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
          }))
        )
      },
    })

    const generalAppRelayUrls = Array.from(
      new Set([
        ...config.appReadRelayUrls,
        ...config.corePublicFallbackRelayUrls,
      ])
    )
    expect(lookupCalls).toEqual([
      {
        relayUrls: [ownerWsRelay, ownerWssRelay, ...generalAppRelayUrls],
        accountPubkey: OWNER,
        authenticatedPubkey: OWNER,
        ownerSelectedRelayUrls: [ownerWsRelay, ownerWssRelay],
        appRelayUrls: generalAppRelayUrls,
        personalRelayUrls: [ownerWsRelay, ownerWssRelay],
        maxRelayAttempts: 6,
        allowInsecureRelayUrlsForPubkey: OWNER,
      },
    ])
    expect(plannerCalls).toEqual([
      {
        intent: "relay_lists",
        authenticatedPubkey: OWNER,
        ownerSelectedRelayUrls: [ownerWsRelay, ownerWssRelay],
        signedRelayListAuthoritative: true,
      },
      {
        intent: "general",
        authenticatedPubkey: OWNER,
        ownerSelectedRelayUrls: [ownerWsRelay, ownerWssRelay],
        signedRelayListAuthoritative: true,
      },
    ])
    expect(finalReadCalls).toHaveLength(1)
    expect(finalReadCalls[0]?.relayUrls).toEqual([
      ownerWsRelay,
      ownerWssRelay,
      ...generalAppRelayUrls,
    ])
    expect(finalReadCalls[0]?.accountPubkey).toBe(OWNER)
    expect(finalReadCalls[0]?.authenticatedPubkey).toBe(OWNER)
    for (const relayUrl of [ownerWsRelay, ownerWssRelay]) {
      expect(
        finalReadCalls[0]?.relayTargets?.find(
          (target) => target.url === relayUrl
        )?.grants
      ).toContainEqual({
        kind: "owner_nip65",
        operation: "read",
        ownerPubkey: OWNER,
        selection: "read",
      })
    }
  })

  it("does not grant remote ws authority without the matching authenticated owner", async () => {
    const remoteWsRelay = "ws://remote-source.com"
    const remoteWssRelay = "wss://remote-source.com"

    for (const authenticatedPubkey of [undefined, OTHER_OWNER]) {
      let authorityReads = 0
      const lookupCalls: Array<{
        accountPubkey: string | null | undefined
        authenticatedPubkey: string | null | undefined
        ownerSelectedRelayUrls: readonly string[] | undefined
        allowInsecureRelayUrlsForPubkey: string | null | undefined
      }> = []
      const finalReadCalls: Array<{
        relayUrls: readonly string[]
        relayTargets:
          | readonly import("../packages/core/src/protocol/relay-authority").RelayTarget[]
          | undefined
        accountPubkey: string | null | undefined
        authenticatedPubkey: string | null | undefined
      }> = []

      await readMediaServerPreferences(OWNER, {
        authenticatedPubkey,
        storage: null,
        readAccountRelaySettingsPlanningSnapshot: async () => {
          authorityReads += 1
          return {
            settings: createRelaySettingsFromPreferences([
              {
                url: remoteWsRelay,
                readEnabled: true,
                writeEnabled: true,
              },
            ]),
            signedRelayListAuthoritative: true,
          }
        },
        getRelayLists: async (_pubkeys, options = {}) => {
          lookupCalls.push({
            accountPubkey: options.accountPubkey,
            authenticatedPubkey: options.authenticatedPubkey,
            ownerSelectedRelayUrls: options.ownerSelectedRelayUrls,
            allowInsecureRelayUrlsForPubkey:
              options.allowInsecureRelayUrlsForPubkey,
          })
          return new Map([
            [
              OWNER,
              {
                pubkey: OWNER,
                readRelayUrls: [remoteWsRelay],
                writeRelayUrls: [remoteWsRelay, remoteWssRelay],
                eventCreatedAt: 100,
                cachedAt: 100,
              },
            ],
          ])
        },
        fetchEvents: async (_filter, options) => {
          finalReadCalls.push({
            relayUrls: options.relayUrls,
            relayTargets: options.relayTargets,
            accountPubkey: options.accountPubkey,
            authenticatedPubkey: options.authenticatedPubkey,
          })
          return relayRead(
            [],
            options.relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
            }))
          )
        },
      })

      expect(authorityReads).toBe(0)
      expect(lookupCalls).toEqual([
        {
          accountPubkey: authenticatedPubkey ?? null,
          authenticatedPubkey: authenticatedPubkey ?? null,
          ownerSelectedRelayUrls: [],
          allowInsecureRelayUrlsForPubkey: undefined,
        },
      ])
      expect(finalReadCalls).toHaveLength(1)
      expect(finalReadCalls[0]?.accountPubkey).toBe(authenticatedPubkey ?? null)
      expect(finalReadCalls[0]?.authenticatedPubkey).toBe(
        authenticatedPubkey ?? null
      )
      expect(
        finalReadCalls[0]?.relayTargets?.find(
          (target) => target.url === remoteWssRelay
        )?.grants
      ).not.toContainEqual(expect.objectContaining({ kind: "owner_nip65" }))
      expect(finalReadCalls[0]?.relayUrls).toContain(remoteWssRelay)
      expect(finalReadCalls[0]?.relayUrls).not.toContain(remoteWsRelay)
    }
  })

  it("does not downgrade a final-read authority change to unavailable evidence", async () => {
    await expect(
      readMediaServerPreferences(OWNER, {
        authenticatedPubkey: OWNER,
        storage: null,
        readRelayUrls: ["wss://authority-change.example"],
        fetchEvents: async () => {
          throw new NostrSignerError("authority_changed")
        },
      })
    ).rejects.toMatchObject({ code: "authority_changed" })
  })

  it("projects complete source and freshness evidence", async () => {
    const storage = new MemoryStorage()
    const signed = event([
      ["server", "https://first.conduit.market"],
      ["server", "https://second.conduit.market"],
    ])
    const now = 1_700_000_000_000
    const result = await readMediaServerPreferences(OWNER, {
      storage,
      now: () => now,
      readRelayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
      fetchEvents: async () =>
        relayRead(
          [signed],
          [
            { relayUrl: "wss://one.conduit.market", status: "success" },
            { relayUrl: "wss://two.conduit.market", status: "success" },
          ],
          {
            [signed.id]: [
              "wss://one.conduit.market",
              "wss://two.conduit.market",
            ],
          }
        ),
    })

    expect(result).toMatchObject({
      status: "published",
      coverage: "complete",
      publishedServerUrls: [
        "https://first.conduit.market",
        "https://second.conduit.market",
      ],
      stale: false,
      retained: false,
      completeObservedAt: now,
    })
    expect(result.publishedRevision).toEqual({
      eventId: signed.id,
      createdAt: signed.created_at,
    })
    expect(result.sourceRelayUrls).toEqual([
      "wss://one.conduit.market",
      "wss://two.conduit.market",
    ])
  })

  it("uses the admitted bounded plan for complete source-filtered reads", async () => {
    const storage = new MemoryStorage()
    const suppressedRelay = "wss://personal-disabled.conduit.market"
    const admittedRelay = "wss://app-admitted.conduit.market"
    const cappedRelay = "wss://app-beyond-cap.conduit.market"
    const signed = event([["server", "https://media.conduit.market"]])
    const result = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: [suppressedRelay, admittedRelay, cappedRelay],
      fetchEvents: async () =>
        relayRead(
          [signed],
          [{ relayUrl: admittedRelay, status: "success" }],
          { [signed.id]: [admittedRelay] },
          [admittedRelay]
        ),
    })

    expect(result).toMatchObject({
      status: "published",
      coverage: "complete",
      stale: false,
      retained: false,
      lookup: {
        plannedRelayCount: 1,
        successfulRelayCount: 1,
        failedRelayCount: 0,
      },
    })
    expect(result.sourceRelayUrls).toEqual([admittedRelay])
  })

  for (const outcome of ["empty", "signed", "partial"] as const) {
    it(`includes admitted App replacements beyond the capped owner prefix for ${outcome} reads`, async () => {
      const blocked = Array.from(
        { length: 6 },
        (_, index) => `wss://owner-${index}.synthetic.example`
      )
      const state = emptyAccountNetworkLocalState(OWNER)
      state.routingPolicy.personalRelaysEnabled = false
      state.routingPolicy.personalRelaysTouched = true
      const ownerRelayListEvidenceRepository =
        createInMemoryOwnerRelayListEvidenceRepository()
      const ownerRelayList = await admitFixture(
        event(
          blocked.map((url) => ["r", url, "read"]),
          { kind: 10002 }
        )
      )
      await ownerRelayListEvidenceRepository.reconcile({
        pubkey: OWNER,
        observations: [
          {
            signedEvent: ownerRelayList,
            sourceRelayUrls: ["wss://discovery.synthetic.example"],
            observedAt: 100_000,
            completeObservedAt: 100_000,
          },
        ],
        lookup: {
          observedAt: 100_000,
          coverage: "complete",
          hadEvent: true,
          eventId: ownerRelayList.id,
        },
      })
      const signed = event([["server", "https://media.conduit.market"]])
      const opened: string[] = []
      class Socket {
        readyState = 0
        onopen: ((event: Event) => void) | null = null
        onmessage: ((event: MessageEvent<string>) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        onclose: ((event: CloseEvent | Event) => void) | null = null
        constructor(readonly url: string) {
          opened.push(url)
          queueMicrotask(() => {
            this.readyState = 1
            this.onopen?.(new Event("open"))
          })
        }
        send(payload: string) {
          const [verb, id] = JSON.parse(payload)
          if (verb !== "REQ") return
          queueMicrotask(() => {
            const emit = (frame: unknown[]) =>
              this.onmessage?.({
                data: JSON.stringify(frame),
              } as MessageEvent<string>)
            if (outcome === "partial" && this.url === opened[0]) {
              emit(["CLOSED", id, "error: synthetic read failure"])
              return
            }
            if (outcome === "signed") emit(["EVENT", id, signed])
            emit(["EOSE", id])
          })
        }
        close() {
          this.readyState = 3
        }
      }

      const resolution = await readMediaServerPreferences(OWNER, {
        authenticatedPubkey: OWNER,
        storage: new MemoryStorage(),
        accountNetworkLocalStateRepository: { get: async () => state },
        ownerRelayListEvidenceRepository,
        getRelayLists: async () => new Map(),
        planReads: (input) => {
          const plan = planRelayReads(input)
          expect(plan.relayUrls).toEqual(blocked)
          expect(plan.candidateRelayUrls.length).toBeGreaterThan(blocked.length)
          return plan
        },
        fetchEvents: (filter, options) =>
          fetchSignedEventsFanoutDetailed(filter, {
            ...options,
            reuseRelayConnections: false,
            socketScope: { createWebSocket: (url) => new Socket(url) },
          }),
      })

      expect(opened.length).toBeGreaterThan(1)
      expect(opened.some((url) => blocked.includes(url))).toBe(false)
      expect(resolution.coverage).toBe(
        outcome === "partial" ? "partial" : "complete"
      )
      expect(resolution.lookup.plannedRelayCount).toBe(opened.length)
      expect(resolution.lookup.successfulRelayCount).toBe(
        opened.length - (outcome === "partial" ? 1 : 0)
      )
      expect(resolution.lookup.failedRelayCount).toBe(
        outcome === "partial" ? 1 : 0
      )
      expect(selectMediaServerPreferenceUse(resolution)).toEqual(
        outcome === "signed"
          ? { kind: "configured", serverUrls: ["https://media.conduit.market"] }
          : { kind: outcome === "empty" ? "fallback" : "incomplete" }
      )
      if (outcome === "signed")
        expect(resolution.sourceRelayUrls.sort()).toEqual([...opened].sort())
    })
  }

  it("retains stronger published evidence when a later lookup is partial", async () => {
    const storage = new MemoryStorage()
    const signed = event([["server", "https://retained.conduit.market"]])
    let complete = true
    const fetchEvents = async () =>
      complete
        ? relayRead(
            [signed],
            [
              { relayUrl: "wss://one.conduit.market", status: "success" },
              { relayUrl: "wss://two.conduit.market", status: "success" },
            ],
            { [signed.id]: ["wss://one.conduit.market"] }
          )
        : relayRead(
            [],
            [
              { relayUrl: "wss://one.conduit.market", status: "success" },
              { relayUrl: "wss://two.conduit.market", status: "failed" },
            ]
          )
    await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
      fetchEvents,
    })
    complete = false
    const degraded = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market", "wss://two.conduit.market"],
      fetchEvents,
    })

    expect(degraded).toMatchObject({
      status: "lookup_partial",
      coverage: "partial",
      publishedServerUrls: ["https://retained.conduit.market"],
      stale: true,
      retained: true,
    })
  })

  it("preserves the last valid list while exposing a newer malformed frontier", async () => {
    const storage = new MemoryStorage()
    const valid = event([["server", "https://valid.conduit.market"]], {
      createdAt: 100,
    })
    const malformed = event([["server", "http://unsafe.conduit.market"]], {
      createdAt: 101,
    })
    const result = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market"],
      fetchEvents: async () =>
        relayRead(
          [valid, malformed],
          [{ relayUrl: "wss://one.conduit.market", status: "success" }],
          {
            [valid.id]: ["wss://one.conduit.market"],
            [malformed.id]: ["wss://one.conduit.market"],
          }
        ),
    })

    expect(result).toMatchObject({
      status: "malformed",
      coverage: "complete",
      publishedServerUrls: ["https://valid.conduit.market"],
      stale: true,
      frontier: {
        eventId: malformed.id,
        createdAt: malformed.created_at,
        state: "malformed",
      },
    })
  })

  it("retains media authority and distinguishable auth evidence across refresh and restart", async () => {
    const storage = new MemoryStorage()
    const relayUrl = "wss://media-preferences.synthetic.example"
    const signed = event([["server", "https://retained.conduit.market"]])
    await readMediaServerPreferences(OWNER, {
      storage,
      now: () => 100_000,
      readRelayUrls: [relayUrl],
      fetchEvents: async () =>
        relayRead([signed], [{ relayUrl, status: "success" }], {
          [signed.id]: [relayUrl],
        }),
    })
    const unavailableRead = async () => ({
      events: [],
      eventSourceRelayUrls: {},
      admittedRelayUrls: [relayUrl],
      relays: [
        {
          relayUrl,
          status: "failed" as const,
          outcome: "auth_required" as const,
          eventCount: 0,
        },
      ],
    })
    const degraded = await readMediaServerPreferences(OWNER, {
      storage,
      now: () => 101_000,
      readRelayUrls: [relayUrl],
      fetchEvents: unavailableRead,
    })
    expect(selectMediaServerPreferenceUse(degraded)).toEqual({
      kind: "configured",
      serverUrls: ["https://retained.conduit.market"],
    })
    expect(degraded.lookup.sources).toEqual([
      { relayUrl, availability: "auth_required" },
    ])
    expect(
      loadMediaServerPreferenceRecord(OWNER, storage).latestLookup?.sources
    ).toEqual(degraded.lookup.sources)
    __resetMediaServerPreferencesForTests()
    const restored = await readMediaServerPreferences(OWNER, {
      storage,
      now: () => 102_000,
      readRelayUrls: [relayUrl],
      fetchEvents: unavailableRead,
    })
    expect(restored.publishedRevision).toEqual(degraded.publishedRevision)
    expect(selectMediaServerPreferenceUse(restored)).toEqual(
      selectMediaServerPreferenceUse(degraded)
    )
  })

  it("keeps a signed-empty replacement ahead of an older server after restart and outage", async () => {
    const storage = new MemoryStorage()
    const relayUrl = "wss://media-frontier.synthetic.example"
    const published = event([["server", "https://old.conduit.market"]], {
      createdAt: 100,
    })
    const empty = event([], { createdAt: 101 })
    await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: [relayUrl],
      fetchEvents: async () =>
        relayRead([published], [{ relayUrl, status: "success" }]),
    })
    const replacement = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: [relayUrl],
      fetchEvents: async () =>
        relayRead([empty], [{ relayUrl, status: "success" }]),
    })
    expect(replacement.status).toBe("empty")
    expect(selectMediaServerPreferenceUse(replacement).kind).toBe("fallback")
    expect(
      loadMediaServerPreferenceRecord(OWNER, storage).frontierEvent?.id
    ).toBe(empty.id)

    __resetMediaServerPreferencesForTests()
    const unavailable = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: [relayUrl],
      fetchEvents: async () => relayRead([], [{ relayUrl, status: "failed" }]),
    })
    expect(unavailable.frontier?.eventId).toBe(empty.id)
    expect(unavailable.coverage).toBe("unavailable")
    expect(selectMediaServerPreferenceUse(unavailable)).toEqual({
      kind: "incomplete",
    })
  })

  it("does not collapse rejected signatures or unavailable reads into absence", async () => {
    const storage = new MemoryStorage()
    const rejected = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market"],
      fetchEvents: async () =>
        relayRead(
          [],
          [
            {
              relayUrl: "wss://one.conduit.market",
              status: "success",
              rejectedEventCount: 1,
            },
          ]
        ),
    })
    expect(rejected.status).toBe("lookup_partial")
    expect(rejected.lookup.rejectedEventCount).toBe(1)

    const unavailable = await readMediaServerPreferences(OWNER, {
      storage,
      readRelayUrls: ["wss://one.conduit.market"],
      fetchEvents: async () => {
        throw new Error("offline")
      },
    })
    expect(unavailable.status).toBe("lookup_unavailable")
    expect(unavailable.coverage).toBe("unavailable")
  })
})

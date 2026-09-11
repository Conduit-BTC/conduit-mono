import { beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetInboxDeclarationCache,
  applyInboxDeclarationCutoverExclusions,
  applyInboxDeclarationCutoverRecoveryReadback,
  applyInboxDeclarationDistributionStage,
  applyInboxDeclarationEvidenceMerge,
  createInMemoryInboxDeclarationEvidenceRepository,
  createInMemoryOwnerRelayListEvidenceRepository,
  deriveInboxReadCoverage,
  EVENT_KINDS,
  getInboxDeclarationEvidence,
  getCachedInboxDeclaration,
  inboxDeclarationPublishRelayUrls,
  INBOX_DECLARATION_CUTOVER_GRACE_MS,
  INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
  sharedInboxDiscoveryRelayUrls,
  invalidateInboxDeclaration,
  mergeInboxDeclarationEvidence,
  planCompatibilityOrderRelays,
  planInboxReadRelays,
  primeInboxDeclarationCache,
  readRetainedInboxDeclaration,
  reconcileOwnerRelayListEvidence,
  resolveInboxDeclaration,
  selectPrivateMessageDeliveryRoute,
  type InboxDeclarationResolution,
  type InboxDeclarationEvidenceRepository,
  type ResolveInboxDeclarationOptions,
} from "@conduit/core"
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/ndk"

const OWNER_SECRET = new Uint8Array(32).fill(1)
const OTHER_SECRET = new Uint8Array(32).fill(2)
const OWNER = getPublicKey(OWNER_SECRET)
const OTHER = getPublicKey(OTHER_SECRET)

function declarationEvent(params: {
  secretKey?: Uint8Array
  createdAt: number
  relays: string[]
}) {
  return finalizeEvent(
    {
      kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
      created_at: params.createdAt,
      tags: params.relays.map((url) => ["relay", url]),
      content: "",
    },
    params.secretKey ?? OWNER_SECRET
  )
}

function diagnostics(params: {
  events?: unknown[]
  successful: string[]
  failed?: string[]
}) {
  return async () => ({
    events: (params.events ?? []) as never,
    attemptedRelayUrls: [...params.successful, ...(params.failed ?? [])],
    successfulRelayUrls: params.successful,
    failedRelayUrls: params.failed ?? [],
  })
}

function resolution(
  overrides: Partial<InboxDeclarationResolution>
): InboxDeclarationResolution {
  return {
    pubkey: OWNER,
    state: "declared",
    relayUrls: ["wss://inbox.conduit.market"],
    stale: false,
    fetchedAt: 0,
    ...overrides,
  }
}

let evidenceRepository: InboxDeclarationEvidenceRepository

beforeEach(() => {
  __resetInboxDeclarationCache()
  evidenceRepository = createInMemoryInboxDeclarationEvidenceRepository()
})

function resolveForTest(options: ResolveInboxDeclarationOptions) {
  return resolveInboxDeclaration(OWNER, { ...options, evidenceRepository })
}

describe("resolveInboxDeclaration", () => {
  it("resolves a declared inbox with secure relays only", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            createdAt: 100,
            relays: [
              "wss://inbox.conduit.market",
              "https://inbox-two.conduit.market/path?ignored=true",
              "wss://inbox-two.conduit.market/path",
              "ws://insecure.conduit.market",
              "wss://127.0.0.1:8080",
              "wss://10.0.0.5/inbox",
              "wss://service.test",
            ],
          }),
        ],
        successful: ["wss://read.conduit.market"],
      }),
    })

    expect(result.state).toBe("declared")
    expect(result.relayUrls).toEqual([
      "wss://inbox.conduit.market",
      "wss://inbox-two.conduit.market/path",
    ])
    expect(result.stale).toBe(false)
  })

  it("preserves an authenticated owner's intentional ws inbox relay", async () => {
    const result = await resolveForTest({
      allowLocalRelayUrlsForPubkey: OWNER,
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            createdAt: 100,
            relays: [
              "ws://owner-inbox.example",
              "wss://127.0.0.1:8080",
              "wss://inbox.conduit.market",
            ],
          }),
        ],
        successful: ["wss://read.conduit.market"],
      }),
    })

    expect(result.state).toBe("declared")
    expect(result.relayUrls).toEqual([
      "ws://owner-inbox.example",
      "wss://127.0.0.1:8080",
      "wss://inbox.conduit.market",
    ])
  })

  it("adds owner discovery reads only from durable signed evidence for the active account", async () => {
    const signedReadRelay = "ws://owner-read.example"
    const signedRelayList = finalizeEvent(
      {
        kind: EVENT_KINDS.RELAY_LIST,
        created_at: 100,
        tags: [["r", signedReadRelay, "read"]],
        content: "",
      },
      OWNER_SECRET
    )
    const ownerRepository = createInMemoryOwnerRelayListEvidenceRepository()
    await reconcileOwnerRelayListEvidence(
      {
        pubkey: OWNER,
        observations: [
          {
            signedEvent: signedRelayList,
            sourceRelayUrls: ["wss://relay.damus.io"],
            observedAt: 1_000,
            completeObservedAt: 1_000,
          },
        ],
        lookup: {
          observedAt: 1_000,
          coverage: "complete",
          hadEvent: true,
          eventId: signedRelayList.id,
        },
      },
      ownerRepository
    )
    const relayPlans: Array<{
      relayUrls: string[]
      ownerSelectedRelayUrls: string[]
    }> = []
    const fetch = async (
      _filter: unknown,
      options: { relayUrls: string[]; ownerSelectedRelayUrls?: string[] }
    ) => {
      relayPlans.push({
        relayUrls: [...options.relayUrls],
        ownerSelectedRelayUrls: [...(options.ownerSelectedRelayUrls ?? [])],
      })
      return {
        events: [] as never,
        attemptedRelayUrls: [...options.relayUrls],
        successfulRelayUrls: [...options.relayUrls],
        failedRelayUrls: [],
      }
    }

    await resolveForTest({
      ownerRelayListEvidenceRepository: ownerRepository,
      fetchEventsWithDiagnostics: fetch as never,
    })
    expect(relayPlans[0]!.relayUrls).not.toContain(signedReadRelay)
    expect(relayPlans[0]!.ownerSelectedRelayUrls).toEqual([])

    __resetInboxDeclarationCache()
    evidenceRepository = createInMemoryInboxDeclarationEvidenceRepository()
    await resolveForTest({
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OTHER,
      ownerRelayListEvidenceRepository: ownerRepository,
      fetchEventsWithDiagnostics: fetch as never,
    })
    expect(relayPlans[1]!.relayUrls).not.toContain(signedReadRelay)
    expect(relayPlans[1]!.ownerSelectedRelayUrls).toEqual([])

    __resetInboxDeclarationCache()
    evidenceRepository = createInMemoryInboxDeclarationEvidenceRepository()
    await resolveForTest({
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      ownerRelayListEvidenceRepository: ownerRepository,
      fetchEventsWithDiagnostics: fetch as never,
    })
    expect(relayPlans[2]!.relayUrls).toContain(signedReadRelay)
    expect(relayPlans[2]!.ownerSelectedRelayUrls).toContain(signedReadRelay)
  })

  it("does not treat a remotely supplied ws discovery target as owner-selected", async () => {
    const plans: Array<{
      relayUrls: string[]
      ownerSelectedRelayUrls: string[]
    }> = []
    const fetch = async (
      _filter: unknown,
      options: { relayUrls: string[]; ownerSelectedRelayUrls?: string[] }
    ) => {
      plans.push({
        relayUrls: [...options.relayUrls],
        ownerSelectedRelayUrls: [...(options.ownerSelectedRelayUrls ?? [])],
      })
      return {
        events: [] as never,
        attemptedRelayUrls: [...options.relayUrls],
        successfulRelayUrls: [...options.relayUrls],
        failedRelayUrls: [],
      }
    }

    await resolveForTest({
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      relayUrls: ["ws://remote-hint.example", "wss://relay.damus.io"],
      fetchEventsWithDiagnostics: fetch as never,
    })

    expect(plans).toEqual([
      {
        relayUrls: ["wss://relay.damus.io"],
        ownerSelectedRelayUrls: [],
      },
    ])
  })

  it("carries only an exact owner-selected ws subset to discovery I/O", async () => {
    const ownerRelay = "ws://owner-selected.example"
    const remoteRelay = "ws://remote-hint.example"
    let observed:
      { relayUrls: string[]; ownerSelectedRelayUrls: string[] } | undefined
    await resolveForTest({
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      relayUrls: [remoteRelay, ownerRelay, "wss://relay.damus.io"],
      ownerSelectedRelayUrls: [ownerRelay],
      fetchEventsWithDiagnostics: (async (
        _filter: unknown,
        options: {
          relayUrls: string[]
          ownerSelectedRelayUrls?: readonly string[]
        }
      ) => {
        observed = {
          relayUrls: [...options.relayUrls],
          ownerSelectedRelayUrls: [...(options.ownerSelectedRelayUrls ?? [])],
        }
        return {
          events: [],
          attemptedRelayUrls: [...options.relayUrls],
          successfulRelayUrls: [...options.relayUrls],
          failedRelayUrls: [],
        }
      }) as never,
    })

    expect(observed).toEqual({
      relayUrls: [ownerRelay, "wss://relay.damus.io"],
      ownerSelectedRelayUrls: [ownerRelay],
    })
  })

  it("drops owner-selected ws at final discovery I/O after an account mismatch", async () => {
    const ownerRelay = "ws://owner-selected.example"
    const secureRelay = "wss://relay.damus.io"
    let observed:
      | {
          relayUrls: string[]
          accountPubkey?: string | null
          authenticatedPubkey?: string | null
          ownerSelectedRelayUrls: string[]
        }
      | undefined

    await resolveForTest({
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OTHER,
      relayUrls: [ownerRelay, secureRelay],
      ownerSelectedRelayUrls: [ownerRelay],
      fetchEventsWithDiagnostics: (async (
        _filter: unknown,
        options: {
          relayUrls: string[]
          accountPubkey?: string | null
          authenticatedPubkey?: string | null
          ownerSelectedRelayUrls?: readonly string[]
        }
      ) => {
        observed = {
          relayUrls: [...options.relayUrls],
          accountPubkey: options.accountPubkey,
          authenticatedPubkey: options.authenticatedPubkey,
          ownerSelectedRelayUrls: [...(options.ownerSelectedRelayUrls ?? [])],
        }
        return {
          events: [],
          attemptedRelayUrls: [...options.relayUrls],
          successfulRelayUrls: [...options.relayUrls],
          failedRelayUrls: [],
        }
      }) as never,
    })

    expect(observed).toEqual({
      relayUrls: [secureRelay],
      accountPubkey: OWNER,
      authenticatedPubkey: OTHER,
      ownerSelectedRelayUrls: [],
    })
  })

  it("does not leak an owner's local-relay cache allowance into remote use", async () => {
    const ownerResult = await resolveForTest({
      allowLocalRelayUrlsForPubkey: OWNER,
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            createdAt: 100,
            relays: ["wss://127.0.0.1:8080", "wss://inbox.conduit.market"],
          }),
        ],
        successful: ["wss://read.conduit.market"],
      }),
    })

    const remoteResult = await resolveForTest({
      fetchEventsWithDiagnostics: async () => {
        throw new Error("fresh cache should avoid a second lookup")
      },
    })

    expect(ownerResult.relayUrls).toEqual([
      "wss://127.0.0.1:8080",
      "wss://inbox.conduit.market",
    ])
    expect(remoteResult.state).toBe("declared")
    expect(remoteResult.relayUrls).toEqual(["wss://inbox.conduit.market"])
  })

  it("never reports not_observed when every discovery relay failed", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        successful: [],
        failed: ["wss://read.conduit.market"],
      }),
    })

    expect(result.state).toBe("lookup_unavailable")
  })

  it("keeps an empty partial lookup partial", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://a.conduit.market", "wss://b.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        successful: ["wss://a.conduit.market"],
        failed: ["wss://b.conduit.market"],
      }),
    })

    expect(result.state).toBe("lookup_partial")
  })

  it("reports not_observed only with complete empty coverage", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        successful: ["wss://read.conduit.market"],
      }),
    })

    expect(result.state).toBe("not_observed")
  })

  it("selects the newest declaration deterministically", async () => {
    const older = declarationEvent({
      createdAt: 100,
      relays: ["wss://old.conduit.market"],
    })
    const tieA = declarationEvent({
      createdAt: 200,
      relays: ["wss://tie-a.conduit.market"],
    })
    const tieB = declarationEvent({
      createdAt: 200,
      relays: ["wss://tie-b.conduit.market"],
    })
    const result = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [older, tieA, tieB],
        successful: ["wss://read.conduit.market"],
      }),
    })

    expect(result.relayUrls).toEqual([
      tieA.id < tieB.id
        ? "wss://tie-a.conduit.market"
        : "wss://tie-b.conduit.market",
    ])
  })

  it("ignores declarations signed by other authors", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            secretKey: OTHER_SECRET,
            createdAt: 100,
            relays: ["wss://attacker.conduit.market"],
          }),
        ],
        successful: ["wss://read.conduit.market"],
      }),
    })

    expect(result.state).toBe("not_observed")
  })

  it("distinguishes a signed empty declaration from malformed relay tags", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [declarationEvent({ createdAt: 100, relays: [] })],
        successful: ["wss://read.conduit.market"],
      }),
    })

    expect(result.state).toBe("signed_empty")

    __resetInboxDeclarationCache()
    evidenceRepository = createInMemoryInboxDeclarationEvidenceRepository()
    const malformed = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [declarationEvent({ createdAt: 100, relays: ["ws://bad"] })],
        successful: ["wss://read.conduit.market"],
      }),
    })
    expect(malformed.state).toBe("malformed")
  })

  it("keeps the last usable declaration for reads behind a newer malformed event", async () => {
    await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      now: () => 0,
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            createdAt: 100,
            relays: ["wss://inbox.conduit.market"],
          }),
        ],
        successful: ["wss://read.conduit.market"],
      }),
    })
    const result = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      freshnessMs: 1,
      now: () => 1_000,
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            createdAt: 200,
            relays: ["ftp://not-a-relay.example"],
          }),
        ],
        successful: ["wss://read.conduit.market"],
      }),
    })

    expect(result.state).toBe("malformed")
    expect(result.retainedReadRelayUrls).toEqual(["wss://inbox.conduit.market"])
  })

  it("converges non-overlapping relay views when the blocker is observed first", async () => {
    const signedEmpty = declarationEvent({ createdAt: 200, relays: [] })
    const olderDeclared = declarationEvent({
      createdAt: 100,
      relays: ["wss://older-inbox.conduit.market"],
    })

    const blocker = await resolveForTest({
      relayUrls: ["wss://shared-a.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [signedEmpty],
        successful: ["wss://shared-a.conduit.market"],
      }),
    })
    expect(blocker.state).toBe("signed_empty")

    __resetInboxDeclarationCache()
    const recovered = await resolveForTest({
      relayUrls: ["wss://shared-b.conduit.market"],
      freshnessMs: 0,
      fetchEventsWithDiagnostics: diagnostics({
        events: [olderDeclared],
        successful: ["wss://shared-b.conduit.market"],
      }),
    })

    expect(recovered.state).toBe("signed_empty")
    expect(recovered.eventId).toBe(signedEmpty.id)
    expect(recovered.stale).toBe(true)
    expect(recovered.retainedReadRelayUrls).toEqual([
      "wss://older-inbox.conduit.market",
    ])
  })

  it("retains an older usable declaration returned with a newer blocker in one fanout", async () => {
    const signedEmpty = declarationEvent({ createdAt: 200, relays: [] })
    const olderDeclared = declarationEvent({
      createdAt: 100,
      relays: ["wss://older-inbox.conduit.market"],
    })

    const result = await resolveForTest({
      relayUrls: ["wss://shared.conduit.market"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [signedEmpty, olderDeclared],
        successful: ["wss://shared.conduit.market"],
      }),
    })

    expect(result.state).toBe("signed_empty")
    expect(result.eventId).toBe(signedEmpty.id)
    expect(result.retainedReadRelayUrls).toEqual([
      "wss://older-inbox.conduit.market",
    ])
  })

  it("keeps omitted requested relays partial and bypasses the health filter", async () => {
    let skipHealthFilter: boolean | undefined
    const result = await resolveForTest({
      relayUrls: [
        "wss://healthy.conduit.market",
        "wss://parked.conduit.market",
      ],
      fetchEventsWithDiagnostics: async (_filter, options) => {
        skipHealthFilter = options?.skipHealthFilter
        return {
          events: [],
          attemptedRelayUrls: ["wss://healthy.conduit.market"],
          successfulRelayUrls: ["wss://healthy.conduit.market"],
          failedRelayUrls: [],
        }
      },
    })

    expect(skipHealthFilter).toBe(true)
    expect(result.state).toBe("lookup_partial")
    expect(result.observation?.failedRelayUrls).toEqual([
      "wss://parked.conduit.market",
    ])
  })

  it("does not hydrate a partial exact-event observation as fresh", async () => {
    const event = declarationEvent({
      createdAt: 100,
      relays: ["wss://inbox.conduit.market"],
    })
    let fetches = 0
    const fetch = async () => {
      fetches += 1
      return fetches === 1
        ? {
            events: [event] as never,
            attemptedRelayUrls: [
              "wss://shared-a.conduit.market",
              "wss://shared-b.conduit.market",
            ],
            successfulRelayUrls: ["wss://shared-a.conduit.market"],
            failedRelayUrls: ["wss://shared-b.conduit.market"],
          }
        : {
            events: [] as never,
            attemptedRelayUrls: [
              "wss://shared-a.conduit.market",
              "wss://shared-b.conduit.market",
            ],
            successfulRelayUrls: [],
            failedRelayUrls: [
              "wss://shared-a.conduit.market",
              "wss://shared-b.conduit.market",
            ],
          }
    }

    const first = await resolveForTest({
      relayUrls: [
        "wss://shared-a.conduit.market",
        "wss://shared-b.conduit.market",
      ],
      fetchEventsWithDiagnostics: fetch,
      now: () => 1_000,
    })
    expect(first.stale).toBe(true)

    __resetInboxDeclarationCache()
    const second = await resolveForTest({
      relayUrls: [
        "wss://shared-a.conduit.market",
        "wss://shared-b.conduit.market",
      ],
      fetchEventsWithDiagnostics: fetch,
      now: () => 1_001,
    })
    expect(fetches).toBe(2)
    expect(second.state).toBe("declared")
    expect(second.stale).toBe(true)
  })

  it("keeps later degraded observations stale across cache reset", async () => {
    const event = declarationEvent({
      createdAt: 100,
      relays: ["wss://inbox.conduit.market"],
    })
    const relayUrls = [
      "wss://shared-a.conduit.market",
      "wss://shared-b.conduit.market",
    ]
    const degradedResults = [
      {
        name: "partial exact",
        result: {
          events: [event] as never,
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: [relayUrls[0]!],
          failedRelayUrls: [relayUrls[1]!],
        },
      },
      {
        name: "unavailable",
        result: {
          events: [] as never,
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: [],
          failedRelayUrls: relayUrls,
        },
      },
      {
        name: "complete empty",
        result: {
          events: [] as never,
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: relayUrls,
          failedRelayUrls: [],
        },
      },
    ]

    for (const scenario of degradedResults) {
      __resetInboxDeclarationCache()
      evidenceRepository = createInMemoryInboxDeclarationEvidenceRepository()
      await resolveForTest({
        relayUrls,
        fetchEventsWithDiagnostics: diagnostics({
          events: [event],
          successful: relayUrls,
        }),
        now: () => 1_000,
      })
      const degraded = await resolveForTest({
        relayUrls,
        freshnessMs: 0,
        fetchEventsWithDiagnostics: async () => scenario.result,
        now: () => 2_000,
      })
      expect(degraded.stale, scenario.name).toBe(true)

      __resetInboxDeclarationCache()
      let restartFetches = 0
      const afterRestart = await resolveForTest({
        relayUrls,
        freshnessMs: 60_000,
        fetchEventsWithDiagnostics: async () => {
          restartFetches += 1
          return scenario.result
        },
        now: () => 2_001,
      })
      expect(restartFetches, scenario.name).toBe(1)
      expect(afterRestart.stale, scenario.name).toBe(true)
    }
  })

  it("hydrates a complete source-ambiguous observation consistently", async () => {
    const event = declarationEvent({
      createdAt: 100,
      relays: ["wss://inbox.conduit.market"],
    })
    let fetches = 0
    const fetch = async () => {
      fetches += 1
      return {
        events: [event] as never,
        attemptedRelayUrls: [
          "wss://shared-a.conduit.market",
          "wss://shared-b.conduit.market",
        ],
        successfulRelayUrls: [
          "wss://shared-a.conduit.market",
          "wss://shared-b.conduit.market",
        ],
        failedRelayUrls: [],
      }
    }

    const first = await resolveForTest({
      relayUrls: [
        "wss://shared-a.conduit.market",
        "wss://shared-b.conduit.market",
      ],
      fetchEventsWithDiagnostics: fetch,
      now: () => 1_000,
    })
    expect(first.stale).toBe(false)
    expect(first.sourceRelayUrls).toEqual([])

    __resetInboxDeclarationCache()
    const second = await resolveForTest({
      relayUrls: [
        "wss://shared-a.conduit.market",
        "wss://shared-b.conduit.market",
      ],
      fetchEventsWithDiagnostics: fetch,
      freshnessMs: 60_000,
      now: () => 1_001,
    })
    expect(second.stale).toBe(false)
    expect(fetches).toBe(1)
  })

  it("serializes repository-failure fallback so an older request cannot win", async () => {
    let enterFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve
    })
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let mergeCalls = 0
    const failMerge = async () => {
      mergeCalls += 1
      if (mergeCalls === 1) {
        enterFirst()
        await firstRelease
      }
      throw new Error("IndexedDB unavailable")
    }
    const throwingRepository: InboxDeclarationEvidenceRepository = {
      get: async () => undefined,
      merge: failMerge,
      mergeBatch: failMerge,
      recordCutoverRecoveryReadback: failMerge,
    }
    const newer = declarationEvent({ createdAt: 200, relays: [] })
    const older = declarationEvent({
      createdAt: 100,
      relays: ["wss://older.conduit.market"],
    })

    const newerResult = resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.conduit.market"],
      freshnessMs: 0,
      evidenceRepository: throwingRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [newer],
        successful: ["wss://shared.conduit.market"],
      }),
    })
    await firstEntered
    const olderResult = resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.conduit.market"],
      freshnessMs: 0,
      evidenceRepository: throwingRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [older],
        successful: ["wss://shared.conduit.market"],
      }),
    })
    releaseFirst()

    expect((await newerResult).eventCreatedAt).toBe(200)
    expect((await olderResult).eventCreatedAt).toBe(200)
    expect(getCachedInboxDeclaration(OWNER)?.eventCreatedAt).toBe(200)
  })

  it("projects the newest same-event lookup across concurrent resolvers", async () => {
    for (const testCase of [
      { firstCoverage: "complete", secondCoverage: "partial", stale: true },
      { firstCoverage: "partial", secondCoverage: "complete", stale: false },
    ] as const) {
      __resetInboxDeclarationCache()
      const backing = createInMemoryInboxDeclarationEvidenceRepository()
      let firstMerge = true
      let enteredFirst!: () => void
      const firstEntered = new Promise<void>((resolve) => {
        enteredFirst = resolve
      })
      let releaseFirst!: () => void
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const repository: InboxDeclarationEvidenceRepository = {
        get: (pubkey) => backing.get(pubkey),
        merge: (input) => backing.merge(input),
        mergeBatch: async (inputs) => {
          if (firstMerge) {
            firstMerge = false
            enteredFirst()
            await firstReleased
          }
          return backing.mergeBatch(inputs)
        },
        recordCutoverRecoveryReadback: (input) =>
          backing.recordCutoverRecoveryReadback(input),
      }
      const event = declarationEvent({
        createdAt: 100,
        relays: ["wss://inbox.example"],
      })
      attachEventSourceRelayUrl(event as never, "wss://read-a.conduit.market")
      const fetchFor = (coverage: "complete" | "partial") => async () => ({
        events: [event] as never,
        attemptedRelayUrls: [
          "wss://read-a.conduit.market",
          "wss://read-b.conduit.market",
        ],
        successfulRelayUrls:
          coverage === "complete"
            ? ["wss://read-a.conduit.market", "wss://read-b.conduit.market"]
            : ["wss://read-a.conduit.market"],
        failedRelayUrls:
          coverage === "complete" ? [] : ["wss://read-b.conduit.market"],
      })

      const first = resolveInboxDeclaration(OWNER, {
        relayUrls: [
          "wss://read-a.conduit.market",
          "wss://read-b.conduit.market",
        ],
        freshnessMs: 0,
        evidenceRepository: repository,
        fetchEventsWithDiagnostics: fetchFor(testCase.firstCoverage),
        now: () => 100,
      })
      await firstEntered
      const second = resolveInboxDeclaration(OWNER, {
        relayUrls: [
          "wss://read-a.conduit.market",
          "wss://read-b.conduit.market",
        ],
        freshnessMs: 0,
        evidenceRepository: repository,
        fetchEventsWithDiagnostics: fetchFor(testCase.secondCoverage),
        now: () => 200,
      })
      releaseFirst()

      const [firstResult, secondResult] = await Promise.all([first, second])
      expect(firstResult.stale).toBe(testCase.stale)
      expect(secondResult.stale).toBe(testCase.stale)
      expect(getCachedInboxDeclaration(OWNER)?.stale).toBe(testCase.stale)
    }
  })

  it("reconciles a recovered repository with a stronger in-memory frontier", async () => {
    const unavailableRepository: InboxDeclarationEvidenceRepository = {
      get: async () => {
        throw new Error("IndexedDB unavailable")
      },
      merge: async () => {
        throw new Error("IndexedDB unavailable")
      },
      mergeBatch: async () => {
        throw new Error("IndexedDB unavailable")
      },
      recordCutoverRecoveryReadback: async () => {
        throw new Error("IndexedDB unavailable")
      },
    }
    const blocker = declarationEvent({ createdAt: 200, relays: [] })
    const older = declarationEvent({
      createdAt: 100,
      relays: ["wss://older.conduit.market"],
    })
    await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.conduit.market"],
      freshnessMs: 0,
      evidenceRepository: unavailableRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [blocker],
        successful: ["wss://shared.conduit.market"],
      }),
    })

    const recoveredRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.conduit.market"],
      freshnessMs: 0,
      evidenceRepository: recoveredRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [older],
        successful: ["wss://shared.conduit.market"],
      }),
    })

    expect(result.state).toBe("signed_empty")
    expect(result.eventId).toBe(blocker.id)
    expect(
      (await getInboxDeclarationEvidence(OWNER, recoveredRepository))?.current
        .signedEvent.id
    ).toBe(blocker.id)
  })

  it("targets only eligible members of a superseded local recovery plan", async () => {
    const replacement = declarationEvent({
      createdAt: 100,
      relays: ["wss://replacement-inbox.example"],
    })
    const stronger = declarationEvent({
      createdAt: 200,
      relays: ["wss://stronger-inbox.example"],
    })
    const sharedPlan = [
      "wss://nos.lol",
      "wss://relay.damus.io",
      "wss://relay.ditto.pub",
    ]
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: OWNER,
      signedEvent: replacement,
      publishRelayUrls: sharedPlan,
      relayOutcomes: sharedPlan.map((relayUrl) => ({
        relayUrl,
        publishStatus: "pending" as const,
        publishAttemptCount: 0,
        readbackStatus: "pending" as const,
        readbackAttemptCount: 0,
      })),
      previousRelayUrls: ["wss://previous-inbox.example"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const superseded = applyInboxDeclarationEvidenceMerge(staged, {
      pubkey: OWNER,
      signedEvent: stronger,
      sourceRelayUrls: ["wss://relay.primal.net"],
      sharedSourceRelayUrls: ["wss://relay.primal.net"],
      observedAt: 2_000,
    })
    const partiallyReadBack = applyInboxDeclarationCutoverRecoveryReadback(
      superseded,
      {
        replacementEventId: replacement.id,
        replacementEventSig: replacement.sig,
        readback: [{ relayUrl: sharedPlan[0]!, status: "observed" }],
        observedAt: 2_250,
      }
    )
    const excluded = applyInboxDeclarationCutoverExclusions(
      partiallyReadBack,
      [sharedPlan[1]!],
      2_500
    )
    expect(excluded.cutoverRecoveries?.[0]?.readbackObservedAt).toBeUndefined()
    const repository = createInMemoryInboxDeclarationEvidenceRepository([
      excluded,
    ])
    attachEventSourceRelayUrl(replacement as never, sharedPlan[2]!)
    attachEventSourceRelayUrl(stronger as never, "wss://relay.primal.net")
    const calls: Array<{
      ids?: string[]
      relayUrls: string[]
      accountPubkey?: string | null
      authenticatedPubkey?: string | null
      ownerSelectedRelayUrls: string[]
    }> = []
    const fetch = async (
      filter: { ids?: string[] },
      options: {
        relayUrls: string[]
        accountPubkey?: string | null
        authenticatedPubkey?: string | null
        ownerSelectedRelayUrls?: readonly string[]
      }
    ) => {
      calls.push({
        ...(filter.ids ? { ids: [...filter.ids] } : {}),
        relayUrls: [...options.relayUrls],
        accountPubkey: options.accountPubkey,
        authenticatedPubkey: options.authenticatedPubkey,
        ownerSelectedRelayUrls: [...(options.ownerSelectedRelayUrls ?? [])],
      })
      if (filter.ids) {
        return {
          events: [replacement] as never,
          attemptedRelayUrls: [sharedPlan[2]!],
          successfulRelayUrls: [sharedPlan[2]!],
          failedRelayUrls: [],
        }
      }
      return {
        events: [stronger] as never,
        attemptedRelayUrls: ["wss://relay.primal.net"],
        successfulRelayUrls: ["wss://relay.primal.net"],
        failedRelayUrls: [],
      }
    }

    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://relay.primal.net"],
      freshnessMs: 0,
      evidenceRepository: repository,
      fetchEventsWithDiagnostics: fetch as never,
      requestingAccountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      ownerSelectedRelayUrls: [sharedPlan[2]!],
      now: () => 3_000,
    })
    const persisted = await getInboxDeclarationEvidence(OWNER, repository)

    expect(calls[0]).toEqual({
      ids: [replacement.id],
      relayUrls: [sharedPlan[2]!],
      accountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      ownerSelectedRelayUrls: [sharedPlan[2]!],
    })
    expect(calls[1]).toEqual({
      relayUrls: ["wss://relay.primal.net"],
      accountPubkey: OWNER,
      authenticatedPubkey: OWNER,
      ownerSelectedRelayUrls: [sharedPlan[2]!],
    })
    expect(result.eventId).toBe(stronger.id)
    expect(persisted?.cutoverRecoveries?.[0]).toMatchObject({
      replacementEventId: replacement.id,
      confirmationAttempts: [
        {
          relayUrls: sharedPlan,
          completedRelayUrls: [sharedPlan[0], sharedPlan[2]],
          observedRelayUrls: [sharedPlan[0], sharedPlan[2]],
        },
      ],
      policyBlockedRelayUrls: [sharedPlan[1]],
    })
    expect(
      persisted?.cutoverRecoveries?.[0]?.readbackObservedAt
    ).toBeUndefined()
    expect(persisted?.cutoverRecoveries?.[0]?.expiresAt).toBeUndefined()
  })

  it("projects signer-free redistribution when whole removal blocks the current recovery attempt", async () => {
    const replacement = declarationEvent({
      createdAt: 100,
      relays: ["wss://replacement-inbox.example"],
    })
    const sharedPlan = [
      "wss://nos.lol",
      "wss://relay.damus.io",
      "wss://relay.ditto.pub",
    ]
    const staged = applyInboxDeclarationDistributionStage(undefined, {
      pubkey: OWNER,
      signedEvent: replacement,
      publishRelayUrls: sharedPlan,
      confirmationRelayUrls: sharedPlan,
      relayOutcomes: sharedPlan.map((relayUrl) => ({
        relayUrl,
        publishStatus: "acked" as const,
        publishAttemptCount: 1,
        readbackStatus: "absent" as const,
        readbackAttemptCount: 1,
      })),
      previousRelayUrls: ["wss://previous-inbox.example"],
      cutoverPolicyVersion: INBOX_DECLARATION_CUTOVER_POLICY_VERSION,
      cutoverGraceMs: INBOX_DECLARATION_CUTOVER_GRACE_MS,
      expectedCurrentEventId: null,
      stagedAt: 1_000,
    })
    const excluded = applyInboxDeclarationCutoverExclusions(
      staged,
      [sharedPlan[1]!],
      2_000
    )
    delete excluded.pendingDistribution
    const repository = createInMemoryInboxDeclarationEvidenceRepository([
      excluded,
    ])

    const result = await readRetainedInboxDeclaration(OWNER, {
      evidenceRepository: repository,
      now: () => 3_000,
    })

    expect(result).toMatchObject({
      eventId: replacement.id,
      state: "declared",
      cutoverRecoveryNeedsRedistribution: true,
    })
  })

  it("seeds recovered storage atomically with the usable predecessor", async () => {
    const unavailableRepository: InboxDeclarationEvidenceRepository = {
      get: async () => undefined,
      merge: async () => {
        throw new Error("IndexedDB unavailable")
      },
      mergeBatch: async () => {
        throw new Error("IndexedDB unavailable")
      },
      recordCutoverRecoveryReadback: async () => {
        throw new Error("IndexedDB unavailable")
      },
    }
    const declared = declarationEvent({
      createdAt: 100,
      relays: ["wss://usable.conduit.market"],
    })
    const blocker = declarationEvent({ createdAt: 200, relays: [] })
    await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.conduit.market"],
      freshnessMs: 0,
      evidenceRepository: unavailableRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [blocker, declared],
        successful: ["wss://shared.conduit.market"],
      }),
    })

    const durable = createInMemoryInboxDeclarationEvidenceRepository()
    let singleMerges = 0
    let batchMerges = 0
    const recoveredRepository: InboxDeclarationEvidenceRepository = {
      get: (pubkey) => durable.get(pubkey),
      merge: async () => {
        singleMerges += 1
        throw new Error("single merge must not be used")
      },
      mergeBatch: (inputs) => {
        batchMerges += 1
        return durable.mergeBatch(inputs)
      },
      recordCutoverRecoveryReadback: (input) =>
        durable.recordCutoverRecoveryReadback(input),
    }
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.conduit.market"],
      freshnessMs: 0,
      evidenceRepository: recoveredRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [declared],
        successful: ["wss://shared.conduit.market"],
      }),
    })
    const persisted = await getInboxDeclarationEvidence(
      OWNER,
      recoveredRepository
    )

    expect(singleMerges).toBe(0)
    expect(batchMerges).toBe(1)
    expect(result.state).toBe("signed_empty")
    expect(persisted?.current.signedEvent.id).toBe(blocker.id)
    expect(persisted?.lastUsable?.signedEvent.id).toBe(declared.id)
  })

  it("keeps persisted last-usable evidence when get fails but merge recovers", async () => {
    const durable = createInMemoryInboxDeclarationEvidenceRepository()
    const declared = declarationEvent({
      createdAt: 100,
      relays: ["wss://usable.conduit.market"],
    })
    const blocker = declarationEvent({ createdAt: 200, relays: [] })
    await mergeInboxDeclarationEvidence(
      { pubkey: OWNER, signedEvent: declared },
      durable
    )
    await mergeInboxDeclarationEvidence(
      { pubkey: OWNER, signedEvent: blocker },
      durable
    )
    const recoveringRepository: InboxDeclarationEvidenceRepository = {
      get: async () => {
        throw new Error("transient read failure")
      },
      merge: (input) => durable.merge(input),
      mergeBatch: (inputs) => durable.mergeBatch(inputs),
      recordCutoverRecoveryReadback: (input) =>
        durable.recordCutoverRecoveryReadback(input),
    }

    __resetInboxDeclarationCache()
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.conduit.market"],
      freshnessMs: 0,
      evidenceRepository: recoveringRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [blocker],
        successful: ["wss://shared.conduit.market"],
      }),
    })

    expect(result.state).toBe("signed_empty")
    expect(result.retainedReadRelayUrls).toEqual([
      "wss://usable.conduit.market",
    ])
  })

  it("serves a fresh cached declaration without refetching", async () => {
    let fetches = 0
    const fetch = diagnostics({
      events: [
        declarationEvent({
          createdAt: 100,
          relays: ["wss://a.conduit.market"],
        }),
      ],
      successful: ["wss://read.conduit.market"],
    })
    const counting: typeof fetch = async () => {
      fetches += 1
      return await fetch()
    }

    const first = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: counting,
      now: () => 0,
    })
    const second = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: counting,
      now: () => 1_000,
    })

    expect(first.state).toBe("declared")
    expect(second.state).toBe("declared")
    expect(fetches).toBe(1)
  })

  it("reconciles a newer cross-tab durable frontier before the TTL fast path", async () => {
    const cases = [
      {
        name: "changed declaration",
        event: declarationEvent({
          createdAt: 200,
          relays: ["wss://new-inbox.conduit.market"],
        }),
        state: "declared" as const,
      },
      {
        name: "signed empty",
        event: declarationEvent({ createdAt: 200, relays: [] }),
        state: "signed_empty" as const,
      },
      {
        name: "malformed",
        event: declarationEvent({
          createdAt: 200,
          relays: ["ws://insecure.example"],
        }),
        state: "malformed" as const,
      },
    ]

    for (const candidate of cases) {
      __resetInboxDeclarationCache()
      const durable = createInMemoryInboxDeclarationEvidenceRepository()
      let durableReads = 0
      const repository: InboxDeclarationEvidenceRepository = {
        ...durable,
        get: async (pubkey) => {
          durableReads += 1
          return durable.get(pubkey)
        },
      }
      let networkReads = 0
      const oldEvent = declarationEvent({
        createdAt: 100,
        relays: ["wss://old-inbox.conduit.market"],
      })
      const fetch = async () => {
        networkReads += 1
        return {
          events: [oldEvent] as never,
          attemptedRelayUrls: ["wss://read.conduit.market"],
          successfulRelayUrls: ["wss://read.conduit.market"],
          failedRelayUrls: [],
        }
      }

      const first = await resolveInboxDeclaration(OWNER, {
        relayUrls: ["wss://read.conduit.market"],
        evidenceRepository: repository,
        fetchEventsWithDiagnostics: fetch,
        now: () => 1_000,
      })
      await durable.merge({
        pubkey: OWNER,
        signedEvent: candidate.event,
        sourceRelayUrls: ["wss://other-tab.conduit.market"],
        observedAt: 1_001,
        completeObservedAt: 1_001,
        cachedAt: 1_001,
        lookup: {
          observedAt: 1_001,
          coverage: "complete",
          hadEvent: true,
          eventId: candidate.event.id,
        },
      })

      const second = await resolveInboxDeclaration(OWNER, {
        relayUrls: ["wss://read.conduit.market"],
        evidenceRepository: repository,
        fetchEventsWithDiagnostics: fetch,
        now: () => 1_002,
      })

      expect(first.eventId).toBe(oldEvent.id)
      expect(second.state).toBe(candidate.state)
      expect(second.eventId).toBe(candidate.event.id)
      expect(durableReads).toBe(2)
      expect(networkReads).toBe(1)
    }
  })

  it("refetches after the freshness window and after invalidation", async () => {
    let fetches = 0
    const counting = async () => {
      fetches += 1
      return {
        events: [
          declarationEvent({
            createdAt: 100,
            relays: ["wss://a.conduit.market"],
          }),
        ] as never,
        attemptedRelayUrls: ["wss://read.conduit.market"],
        successfulRelayUrls: ["wss://read.conduit.market"],
        failedRelayUrls: [],
      }
    }

    await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: counting,
      freshnessMs: 100,
      now: () => 0,
    })
    await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: counting,
      freshnessMs: 100,
      now: () => 200,
    })
    expect(fetches).toBe(2)

    invalidateInboxDeclaration(OWNER)
    expect(getCachedInboxDeclaration(OWNER)?.stale).toBe(true)

    await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      fetchEventsWithDiagnostics: counting,
      freshnessMs: 100,
      now: () => 201,
    })
    expect(fetches).toBe(3)
  })

  it("preserves stronger cached evidence after a complete empty observation", async () => {
    primeInboxDeclarationCache(OWNER, ["wss://inbox.conduit.market"], () => 0)

    const absent = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      freshnessMs: 1,
      now: () => 1_000,
      fetchEventsWithDiagnostics: diagnostics({
        events: [],
        successful: ["wss://read.conduit.market"],
      }),
    })
    expect(absent.state).toBe("declared")
    expect(absent.stale).toBe(true)
    expect(getCachedInboxDeclaration(OWNER)?.relayUrls).toEqual([
      "wss://inbox.conduit.market",
    ])

    // A later transient failure continues to use the retained evidence.
    const failed = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      freshnessMs: 1,
      now: () => 2_000,
      fetchEventsWithDiagnostics: diagnostics({
        successful: [],
        failed: ["wss://read.conduit.market"],
      }),
    })
    expect(failed.state).toBe("declared")
    expect(failed.stale).toBe(true)
    expect(failed.relayUrls).toEqual(["wss://inbox.conduit.market"])
  })

  it("falls back to the stale cached declaration when discovery is unavailable", async () => {
    primeInboxDeclarationCache(OWNER, ["wss://inbox.conduit.market"], () => 0)
    const result = await resolveForTest({
      relayUrls: ["wss://read.conduit.market"],
      freshnessMs: 1,
      now: () => 1_000,
      fetchEventsWithDiagnostics: diagnostics({
        successful: [],
        failed: ["wss://read.conduit.market"],
      }),
    })

    expect(result.state).toBe("declared")
    expect(result.stale).toBe(true)
    expect(result.relayUrls).toEqual(["wss://inbox.conduit.market"])
  })
})

describe("inbox declaration discovery planning", () => {
  it("reserves shared discovery before owner-local relays under the cap", () => {
    const owner = [
      "wss://owner-one.conduit.market",
      "wss://owner-two.conduit.market",
      "wss://owner-three.conduit.market",
      "wss://owner-four.conduit.market",
    ]

    expect(inboxDeclarationPublishRelayUrls(owner)).toEqual([
      // Production shared relays remain reserved regardless of owner list size.
      ...sharedInboxDiscoveryRelayUrls(),
      ...owner,
    ])
  })
})

describe("planInboxReadRelays", () => {
  it("limits canonical compatibility reads to the protected inbox defaults", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
    })

    expect(plan.relayUrls).toEqual([
      "wss://relay.conduit.market",
      "wss://relay.ditto.pub",
    ])
  })

  it("unions declared and compatibility reads with sources", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ relayUrls: ["wss://inbox.conduit.market"] }),
      compatibilityRelayUrls: [
        "wss://compat.conduit.market",
        "wss://inbox.conduit.market",
      ],
    })

    expect(plan.relayUrls).toEqual([
      "wss://inbox.conduit.market",
      "wss://compat.conduit.market",
    ])
    expect(plan.relaySources["wss://inbox.conduit.market"]).toBe("declared")
    expect(plan.relaySources["wss://compat.conduit.market"]).toBe(
      "compatibility"
    )
    expect(plan.source).toBe("mixed")
  })

  it("reserves approved compatibility write targets inside a capped read plan", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      compatibilityRelayUrls: [
        "wss://commerce.conduit.market",
        "wss://inbox.conduit.market",
        "wss://interop.conduit.market",
        "wss://public.conduit.market",
      ],
      requiredCompatibilityRelayUrls: [
        "wss://commerce.conduit.market",
        "wss://inbox.conduit.market",
        "wss://interop.conduit.market",
        "wss://not-in-read-set.conduit.market",
      ],
      maxRelays: 4,
    })

    expect(plan.relayUrls).toEqual([
      "wss://commerce.conduit.market",
      "wss://inbox.conduit.market",
      "wss://interop.conduit.market",
      "wss://public.conduit.market",
    ])
  })

  it("uses the cached declared relays when discovery degraded", () => {
    primeInboxDeclarationCache(
      OWNER,
      ["wss://cached-inbox.conduit.market"],
      () => 0
    )
    const plan = planInboxReadRelays({
      declaration: resolution({
        state: "lookup_unavailable",
        relayUrls: [],
      }),
      compatibilityRelayUrls: ["wss://compat.conduit.market"],
    })

    expect(plan.relayUrls).toEqual([
      "wss://cached-inbox.conduit.market",
      "wss://compat.conduit.market",
    ])
    expect(plan.relaySources["wss://cached-inbox.conduit.market"]).toBe("cache")
  })

  it("does not restore a private cached declaration outside the exact owner context", () => {
    const localRelay = "wss://127.0.0.1:7447"
    const publicRelay = "wss://cached-inbox.conduit.market"
    primeInboxDeclarationCache(OWNER, [localRelay, publicRelay], () => 0)
    const declaration = resolution({
      state: "lookup_unavailable",
      relayUrls: [],
    })

    const thirdPartyPlan = planInboxReadRelays({
      declaration,
      authenticatedPubkey: "different-owner",
      compatibilityRelayUrls: [],
    })
    const ownerPlan = planInboxReadRelays({
      declaration,
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [],
    })

    expect(thirdPartyPlan.relayUrls).toEqual([publicRelay])
    expect(ownerPlan.relayUrls).toEqual([localRelay, publicRelay])
  })

  it("caps the plan at maxRelays preserving priority order", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ relayUrls: ["wss://inbox.conduit.market"] }),
      compatibilityRelayUrls: [
        "wss://compat.conduit.market",
        "wss://extra.conduit.market",
      ],
      maxRelays: 2,
    })

    expect(plan.relayUrls).toEqual([
      "wss://inbox.conduit.market",
      "wss://compat.conduit.market",
    ])
  })

  it("never truncates overlapping active recovery batches at the fanout target", () => {
    const recoveryRelayUrls = Array.from(
      { length: 27 },
      (_, index) =>
        `wss://cutover-recovery-${String(index).padStart(2, "0")}.example`
    )
    const plan = planInboxReadRelays({
      declaration: resolution({
        relayUrls: ["wss://current-inbox.example"],
        retainedReadRelayUrls: ["wss://retained-inbox.example"],
        cutoverRecoveryRelayUrls: recoveryRelayUrls,
      }),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: ["wss://optional-compatibility.example"],
      maxRelays: 24,
    })

    expect(plan.relayUrls).toEqual([
      "wss://current-inbox.example",
      ...recoveryRelayUrls,
      "wss://retained-inbox.example",
    ])
    expect(plan.relayUrls).not.toContain("wss://optional-compatibility.example")
    expect(
      recoveryRelayUrls.every(
        (relayUrl) => plan.relaySources[relayUrl] === "cutover_recovery"
      )
    ).toBe(true)
  })

  it("admits ws only from an exact authenticated-owner read source", () => {
    const remotePlan = planInboxReadRelays({
      declaration: resolution({
        relayUrls: ["ws://inbox.conduit.market"],
        cutoverRecoveryRelayUrls: ["ws://local.conduit.market"],
      }),
      compatibilityRelayUrls: ["wss://compat.conduit.market"],
    })
    const ownerPlan = planInboxReadRelays({
      declaration: resolution({
        relayUrls: ["ws://inbox.conduit.market"],
        cutoverRecoveryRelayUrls: ["ws://local.conduit.market"],
      }),
      authenticatedPubkey: OWNER,
      compatibilityRelayUrls: [
        "ws://remote-compatibility.conduit.market",
        "wss://compat.conduit.market",
      ],
    })

    expect(remotePlan.relayUrls).toEqual(["wss://compat.conduit.market"])
    expect(remotePlan.ownerSelectedRelayUrls).toEqual([])
    expect(ownerPlan.relayUrls).toEqual([
      "ws://inbox.conduit.market",
      "ws://local.conduit.market",
      "wss://compat.conduit.market",
    ])
    expect(ownerPlan.ownerSelectedRelayUrls).toEqual([
      "ws://inbox.conduit.market",
      "ws://local.conduit.market",
    ])
  })
})

describe("deriveInboxReadCoverage", () => {
  it("maps diagnostics to coverage states", () => {
    expect(
      deriveInboxReadCoverage({
        successfulRelayUrls: ["wss://a"],
        failedRelayUrls: [],
      })
    ).toBe("complete")
    expect(
      deriveInboxReadCoverage({
        successfulRelayUrls: ["wss://a"],
        failedRelayUrls: ["wss://b"],
      })
    ).toBe("partial")
    expect(
      deriveInboxReadCoverage({
        successfulRelayUrls: ["wss://a"],
        failedRelayUrls: [],
        cappedRelayUrls: ["wss://a"],
      })
    ).toBe("partial")
    expect(
      deriveInboxReadCoverage({
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://a"],
      })
    ).toBe("unavailable")
  })
})

describe("selectPrivateMessageDeliveryRoute", () => {
  it("limits canonical compatibility writes to the protected inbox defaults", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: true,
    })

    expect(selection.route).toBe("compatibility_order")
    expect(selection.relayUrls).toEqual([
      "wss://relay.conduit.market",
      "wss://relay.ditto.pub",
    ])
  })

  it("always prefers a valid declaration over compatibility", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ relayUrls: ["wss://inbox.conduit.market"] }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.conduit.market"],
    })

    expect(selection.route).toBe("declared_inbox")
    expect(selection.relayUrls).toEqual(["wss://inbox.conduit.market"])
  })

  it("never auto-routes to a ws target from a recipient declaration", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      declaration: resolution({
        pubkey: getPublicKey(OTHER_SECRET),
        relayUrls: [
          "ws://recipient-inbox.example",
          "wss://recipient-inbox.example",
        ],
      }),
      validatedOrder: false,
      authenticatedOwnerPubkey: OWNER,
      ownerSelectedRelayUrls: ["ws://recipient-inbox.example"],
    })

    expect(selection.route).toBe("declared_inbox")
    expect(selection.relayUrls).toEqual(["wss://recipient-inbox.example"])
    expect(selection.ownerSelectedRelayUrls).toEqual([])
  })

  it("allows only the exact selected ws subset for an authenticated owner self-route", () => {
    const selectedOwnerRelay = "ws://owner-inbox.example"
    const unselectedRelay = "ws://unselected-owner-inbox.example"
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      declaration: resolution({
        relayUrls: [
          selectedOwnerRelay,
          unselectedRelay,
          "wss://owner-secure.example",
        ],
      }),
      validatedOrder: false,
      authenticatedOwnerPubkey: OWNER,
      ownerSelectedRelayUrls: [selectedOwnerRelay],
    })

    expect(selection.route).toBe("declared_inbox")
    expect(selection.relayUrls).toEqual([
      selectedOwnerRelay,
      "wss://owner-secure.example",
    ])
    expect(selection.ownerSelectedRelayUrls).toEqual([selectedOwnerRelay])
  })

  it("routes a validated order to a bounded compatibility plan when enabled", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: [
        "wss://one.conduit.market",
        "wss://two.conduit.market",
        "wss://three.conduit.market",
        "wss://four.conduit.market",
      ],
    })

    expect(selection.route).toBe("compatibility_order")
    expect(selection.relayUrls).toEqual([
      "wss://one.conduit.market",
      "wss://two.conduit.market",
      "wss://three.conduit.market",
    ])
  })

  it("caps an oversized declared inbox without adding compatibility targets", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({
        relayUrls: [
          "wss://declared-one.conduit.market",
          "wss://declared-two.conduit.market",
          "wss://declared-three.conduit.market",
          "wss://declared-four.conduit.market",
        ],
      }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.conduit.market"],
    })

    expect(selection.relayUrls).toEqual([
      "wss://declared-one.conduit.market",
      "wss://declared-two.conduit.market",
      "wss://declared-three.conduit.market",
    ])
    expect(selection.truncated).toBe(true)
  })

  it("blocks compatibility when the deployment-profile flag is off", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: false,
      compatibilityRelayUrls: ["wss://compatibility.conduit.market"],
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("recipient_not_ready")
  })

  it("never routes kind-14 general DMs through compatibility", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      validatedOrder: false,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.conduit.market"],
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("recipient_not_ready")
  })

  it("blocks unvalidated kind-16 orders from the compatibility lane", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      validatedOrder: false,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.conduit.market"],
    })

    expect(selection.route).toBe("blocked")
  })

  it("blocks writes on a signed malformed declaration", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "malformed", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.conduit.market"],
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("declaration_malformed")
  })

  it("keeps a signed empty declaration distinct while blocking writes", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "signed_empty", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.conduit.market"],
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("declaration_signed_empty")
  })

  it("never lets a locally staged declaration authorize writes or compatibility", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({
        state: "distribution_pending",
        relayUrls: [],
        pendingRelayUrls: ["wss://pending-inbox.example"],
      }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.example"],
    })

    expect(selection.route).toBe("blocked")
    expect(selection.relayUrls).toEqual([])
    expect(selection.blockedReason).toBe("declaration_distribution_pending")
  })

  it("maps lookup failure to recipient_lookup_failed when compatibility is off", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "lookup_unavailable", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: false,
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("recipient_lookup_failed")
  })

  it("drops insecure compatibility relay urls", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["ws://insecure.conduit.market"],
    })

    expect(selection.route).toBe("blocked")
  })
})

describe("planCompatibilityOrderRelays", () => {
  it("normalizes, deduplicates, and caps the approved pool", () => {
    const plan = planCompatibilityOrderRelays({
      approvedRelayUrls: [
        "WSS://One.Conduit.Market/",
        "wss://one.conduit.market",
        "wss://two.conduit.market",
        "ws://insecure.conduit.market",
        "wss://three.conduit.market",
        "wss://four.conduit.market",
      ],
      recipientReadRelayUrls: [],
      maxRelays: 3,
    })

    expect(plan.relayUrls).toEqual([
      "wss://one.conduit.market",
      "wss://two.conduit.market",
      "wss://three.conduit.market",
    ])
  })

  it("lets signed recipient read evidence reorder but never widen the approved pool", () => {
    const plan = planCompatibilityOrderRelays({
      approvedRelayUrls: [
        "wss://one.conduit.market",
        "wss://two.conduit.market",
        "wss://three.conduit.market",
      ],
      recipientReadRelayUrls: [
        "wss://arbitrary.conduit.market",
        "wss://three.conduit.market/",
        "wss://one.conduit.market",
      ],
      maxRelays: 3,
    })

    expect(plan.relayUrls).toEqual([
      "wss://three.conduit.market",
      "wss://one.conduit.market",
      "wss://two.conduit.market",
    ])
    expect(plan.relayUrls).not.toContain("wss://arbitrary.conduit.market")
    expect(plan.relaySources).toEqual({
      "wss://three.conduit.market": "recipient_nip65",
      "wss://one.conduit.market": "recipient_nip65",
      "wss://two.conduit.market": "compatibility_registry",
    })
  })
})

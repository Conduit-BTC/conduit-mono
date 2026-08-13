import { beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetInboxDeclarationCache,
  createInMemoryInboxDeclarationEvidenceRepository,
  deriveInboxReadCoverage,
  EVENT_KINDS,
  getInboxDeclarationEvidence,
  getCachedInboxDeclaration,
  inboxDeclarationPublishRelayUrls,
  sharedInboxDiscoveryRelayUrls,
  invalidateInboxDeclaration,
  mergeInboxDeclarationEvidence,
  planCompatibilityOrderRelays,
  planInboxReadRelays,
  primeInboxDeclarationCache,
  resolveInboxDeclaration,
  selectPrivateMessageDeliveryRoute,
  type InboxDeclarationResolution,
  type InboxDeclarationEvidenceRepository,
  type ResolveInboxDeclarationOptions,
} from "@conduit/core"

const OWNER_SECRET = new Uint8Array(32).fill(1)
const OTHER_SECRET = new Uint8Array(32).fill(2)
const OWNER = getPublicKey(OWNER_SECRET)

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
    relayUrls: ["wss://inbox.example"],
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
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            createdAt: 100,
            relays: ["wss://inbox.example", "ws://insecure.example"],
          }),
        ],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("declared")
    expect(result.relayUrls).toEqual(["wss://inbox.example"])
    expect(result.stale).toBe(false)
  })

  it("never reports not_observed when every discovery relay failed", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        successful: [],
        failed: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("lookup_unavailable")
  })

  it("keeps an empty partial lookup partial", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://a.example", "wss://b.example"],
      fetchEventsWithDiagnostics: diagnostics({
        successful: ["wss://a.example"],
        failed: ["wss://b.example"],
      }),
    })

    expect(result.state).toBe("lookup_partial")
  })

  it("reports not_observed only with complete empty coverage", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("not_observed")
  })

  it("selects the newest declaration deterministically", async () => {
    const older = declarationEvent({
      createdAt: 100,
      relays: ["wss://old.example"],
    })
    const tieA = declarationEvent({
      createdAt: 200,
      relays: ["wss://tie-a.example"],
    })
    const tieB = declarationEvent({
      createdAt: 200,
      relays: ["wss://tie-b.example"],
    })
    const result = await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [older, tieA, tieB],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.relayUrls).toEqual([
      tieA.id < tieB.id ? "wss://tie-a.example" : "wss://tie-b.example",
    ])
  })

  it("ignores declarations signed by other authors", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            secretKey: OTHER_SECRET,
            createdAt: 100,
            relays: ["wss://attacker.example"],
          }),
        ],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("not_observed")
  })

  it("distinguishes a signed empty declaration from malformed relay tags", async () => {
    const result = await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [declarationEvent({ createdAt: 100, relays: [] })],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("signed_empty")

    __resetInboxDeclarationCache()
    evidenceRepository = createInMemoryInboxDeclarationEvidenceRepository()
    const malformed = await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [declarationEvent({ createdAt: 100, relays: ["ws://bad"] })],
        successful: ["wss://read.example"],
      }),
    })
    expect(malformed.state).toBe("malformed")
  })

  it("keeps the last usable declaration for reads behind a newer malformed event", async () => {
    await resolveForTest({
      relayUrls: ["wss://read.example"],
      now: () => 0,
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            createdAt: 100,
            relays: ["wss://inbox.example"],
          }),
        ],
        successful: ["wss://read.example"],
      }),
    })
    const result = await resolveForTest({
      relayUrls: ["wss://read.example"],
      freshnessMs: 1,
      now: () => 1_000,
      fetchEventsWithDiagnostics: diagnostics({
        events: [declarationEvent({ createdAt: 200, relays: ["ws://bad"] })],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("malformed")
    expect(result.retainedReadRelayUrls).toEqual(["wss://inbox.example"])
  })

  it("converges non-overlapping relay views when the blocker is observed first", async () => {
    const signedEmpty = declarationEvent({ createdAt: 200, relays: [] })
    const olderDeclared = declarationEvent({
      createdAt: 100,
      relays: ["wss://older-inbox.example"],
    })

    const blocker = await resolveForTest({
      relayUrls: ["wss://shared-a.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [signedEmpty],
        successful: ["wss://shared-a.example"],
      }),
    })
    expect(blocker.state).toBe("signed_empty")

    __resetInboxDeclarationCache()
    const recovered = await resolveForTest({
      relayUrls: ["wss://shared-b.example"],
      freshnessMs: 0,
      fetchEventsWithDiagnostics: diagnostics({
        events: [olderDeclared],
        successful: ["wss://shared-b.example"],
      }),
    })

    expect(recovered.state).toBe("signed_empty")
    expect(recovered.eventId).toBe(signedEmpty.id)
    expect(recovered.stale).toBe(true)
    expect(recovered.retainedReadRelayUrls).toEqual([
      "wss://older-inbox.example",
    ])
  })

  it("retains an older usable declaration returned with a newer blocker in one fanout", async () => {
    const signedEmpty = declarationEvent({ createdAt: 200, relays: [] })
    const olderDeclared = declarationEvent({
      createdAt: 100,
      relays: ["wss://older-inbox.example"],
    })

    const result = await resolveForTest({
      relayUrls: ["wss://shared.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [signedEmpty, olderDeclared],
        successful: ["wss://shared.example"],
      }),
    })

    expect(result.state).toBe("signed_empty")
    expect(result.eventId).toBe(signedEmpty.id)
    expect(result.retainedReadRelayUrls).toEqual(["wss://older-inbox.example"])
  })

  it("keeps omitted requested relays partial and bypasses the health filter", async () => {
    let skipHealthFilter: boolean | undefined
    const result = await resolveForTest({
      relayUrls: ["wss://healthy.example", "wss://parked.example"],
      fetchEventsWithDiagnostics: async (_filter, options) => {
        skipHealthFilter = options?.skipHealthFilter
        return {
          events: [],
          attemptedRelayUrls: ["wss://healthy.example"],
          successfulRelayUrls: ["wss://healthy.example"],
          failedRelayUrls: [],
        }
      },
    })

    expect(skipHealthFilter).toBe(true)
    expect(result.state).toBe("lookup_partial")
    expect(result.observation?.failedRelayUrls).toEqual([
      "wss://parked.example",
    ])
  })

  it("does not hydrate a partial exact-event observation as fresh", async () => {
    const event = declarationEvent({
      createdAt: 100,
      relays: ["wss://inbox.example"],
    })
    let fetches = 0
    const fetch = async () => {
      fetches += 1
      return fetches === 1
        ? {
            events: [event] as never,
            attemptedRelayUrls: [
              "wss://shared-a.example",
              "wss://shared-b.example",
            ],
            successfulRelayUrls: ["wss://shared-a.example"],
            failedRelayUrls: ["wss://shared-b.example"],
          }
        : {
            events: [] as never,
            attemptedRelayUrls: [
              "wss://shared-a.example",
              "wss://shared-b.example",
            ],
            successfulRelayUrls: [],
            failedRelayUrls: [
              "wss://shared-a.example",
              "wss://shared-b.example",
            ],
          }
    }

    const first = await resolveForTest({
      relayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
      fetchEventsWithDiagnostics: fetch,
      now: () => 1_000,
    })
    expect(first.stale).toBe(true)

    __resetInboxDeclarationCache()
    const second = await resolveForTest({
      relayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
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
      relays: ["wss://inbox.example"],
    })
    const relayUrls = ["wss://shared-a.example", "wss://shared-b.example"]
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
      relays: ["wss://inbox.example"],
    })
    let fetches = 0
    const fetch = async () => {
      fetches += 1
      return {
        events: [event] as never,
        attemptedRelayUrls: [
          "wss://shared-a.example",
          "wss://shared-b.example",
        ],
        successfulRelayUrls: [
          "wss://shared-a.example",
          "wss://shared-b.example",
        ],
        failedRelayUrls: [],
      }
    }

    const first = await resolveForTest({
      relayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
      fetchEventsWithDiagnostics: fetch,
      now: () => 1_000,
    })
    expect(first.stale).toBe(false)
    expect(first.sourceRelayUrls).toEqual([])

    __resetInboxDeclarationCache()
    const second = await resolveForTest({
      relayUrls: ["wss://shared-a.example", "wss://shared-b.example"],
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
    }
    const newer = declarationEvent({ createdAt: 200, relays: [] })
    const older = declarationEvent({
      createdAt: 100,
      relays: ["wss://older.example"],
    })

    const newerResult = resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.example"],
      freshnessMs: 0,
      evidenceRepository: throwingRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [newer],
        successful: ["wss://shared.example"],
      }),
    })
    await firstEntered
    const olderResult = resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.example"],
      freshnessMs: 0,
      evidenceRepository: throwingRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [older],
        successful: ["wss://shared.example"],
      }),
    })
    releaseFirst()

    expect((await newerResult).eventCreatedAt).toBe(200)
    expect((await olderResult).eventCreatedAt).toBe(200)
    expect(getCachedInboxDeclaration(OWNER)?.eventCreatedAt).toBe(200)
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
    }
    const blocker = declarationEvent({ createdAt: 200, relays: [] })
    const older = declarationEvent({
      createdAt: 100,
      relays: ["wss://older.example"],
    })
    await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.example"],
      freshnessMs: 0,
      evidenceRepository: unavailableRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [blocker],
        successful: ["wss://shared.example"],
      }),
    })

    const recoveredRepository =
      createInMemoryInboxDeclarationEvidenceRepository()
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.example"],
      freshnessMs: 0,
      evidenceRepository: recoveredRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [older],
        successful: ["wss://shared.example"],
      }),
    })

    expect(result.state).toBe("signed_empty")
    expect(result.eventId).toBe(blocker.id)
    expect(
      (await getInboxDeclarationEvidence(OWNER, recoveredRepository))?.current
        .signedEvent.id
    ).toBe(blocker.id)
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
    }
    const declared = declarationEvent({
      createdAt: 100,
      relays: ["wss://usable.example"],
    })
    const blocker = declarationEvent({ createdAt: 200, relays: [] })
    await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.example"],
      freshnessMs: 0,
      evidenceRepository: unavailableRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [blocker, declared],
        successful: ["wss://shared.example"],
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
    }
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.example"],
      freshnessMs: 0,
      evidenceRepository: recoveredRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [declared],
        successful: ["wss://shared.example"],
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
      relays: ["wss://usable.example"],
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
    }

    __resetInboxDeclarationCache()
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://shared.example"],
      freshnessMs: 0,
      evidenceRepository: recoveringRepository,
      fetchEventsWithDiagnostics: diagnostics({
        events: [blocker],
        successful: ["wss://shared.example"],
      }),
    })

    expect(result.state).toBe("signed_empty")
    expect(result.retainedReadRelayUrls).toEqual(["wss://usable.example"])
  })

  it("serves a fresh cached declaration without refetching", async () => {
    let fetches = 0
    const fetch = diagnostics({
      events: [declarationEvent({ createdAt: 100, relays: ["wss://a"] })],
      successful: ["wss://read.example"],
    })
    const counting: typeof fetch = async () => {
      fetches += 1
      return await fetch()
    }

    const first = await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: counting,
      now: () => 0,
    })
    const second = await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: counting,
      now: () => 1_000,
    })

    expect(first.state).toBe("declared")
    expect(second.state).toBe("declared")
    expect(fetches).toBe(1)
  })

  it("refetches after the freshness window and after invalidation", async () => {
    let fetches = 0
    const counting = async () => {
      fetches += 1
      return {
        events: [
          declarationEvent({ createdAt: 100, relays: ["wss://a"] }),
        ] as never,
        attemptedRelayUrls: ["wss://read.example"],
        successfulRelayUrls: ["wss://read.example"],
        failedRelayUrls: [],
      }
    }

    await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: counting,
      freshnessMs: 100,
      now: () => 0,
    })
    await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: counting,
      freshnessMs: 100,
      now: () => 200,
    })
    expect(fetches).toBe(2)

    invalidateInboxDeclaration(OWNER)
    expect(getCachedInboxDeclaration(OWNER)?.stale).toBe(true)

    await resolveForTest({
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: counting,
      freshnessMs: 100,
      now: () => 201,
    })
    expect(fetches).toBe(3)
  })

  it("preserves stronger cached evidence after a complete empty observation", async () => {
    primeInboxDeclarationCache(OWNER, ["wss://inbox.example"], () => 0)

    const absent = await resolveForTest({
      relayUrls: ["wss://read.example"],
      freshnessMs: 1,
      now: () => 1_000,
      fetchEventsWithDiagnostics: diagnostics({
        events: [],
        successful: ["wss://read.example"],
      }),
    })
    expect(absent.state).toBe("declared")
    expect(absent.stale).toBe(true)
    expect(getCachedInboxDeclaration(OWNER)?.relayUrls).toEqual([
      "wss://inbox.example",
    ])

    // A later transient failure continues to use the retained evidence.
    const failed = await resolveForTest({
      relayUrls: ["wss://read.example"],
      freshnessMs: 1,
      now: () => 2_000,
      fetchEventsWithDiagnostics: diagnostics({
        successful: [],
        failed: ["wss://read.example"],
      }),
    })
    expect(failed.state).toBe("declared")
    expect(failed.stale).toBe(true)
    expect(failed.relayUrls).toEqual(["wss://inbox.example"])
  })

  it("falls back to the stale cached declaration when discovery is unavailable", async () => {
    primeInboxDeclarationCache(OWNER, ["wss://inbox.example"], () => 0)
    const result = await resolveForTest({
      relayUrls: ["wss://read.example"],
      freshnessMs: 1,
      now: () => 1_000,
      fetchEventsWithDiagnostics: diagnostics({
        successful: [],
        failed: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("declared")
    expect(result.stale).toBe(true)
    expect(result.relayUrls).toEqual(["wss://inbox.example"])
  })
})

describe("inbox declaration discovery planning", () => {
  it("reserves shared discovery before owner-local relays under the cap", () => {
    const owner = [
      "wss://owner-one.example",
      "wss://owner-two.example",
      "wss://owner-three.example",
      "wss://owner-four.example",
    ]

    expect(inboxDeclarationPublishRelayUrls(owner)).toEqual([
      // Production shared relays remain reserved regardless of owner list size.
      ...sharedInboxDiscoveryRelayUrls(),
      ...owner.slice(0, 3),
    ])
  })
})

describe("planInboxReadRelays", () => {
  it("unions declared, local IN, and compatibility reads with sources", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ relayUrls: ["wss://inbox.example"] }),
      localReadRelayUrls: ["wss://local.example"],
      compatibilityRelayUrls: ["wss://compat.example", "wss://inbox.example"],
    })

    expect(plan.relayUrls).toEqual([
      "wss://inbox.example",
      "wss://local.example",
      "wss://compat.example",
    ])
    expect(plan.relaySources["wss://inbox.example"]).toBe("declared")
    expect(plan.relaySources["wss://local.example"]).toBe("local_in")
    expect(plan.relaySources["wss://compat.example"]).toBe("compatibility")
    expect(plan.source).toBe("mixed")
  })

  it("keeps compatibility reads when local settings are nonempty", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      localReadRelayUrls: ["wss://local.example"],
      compatibilityRelayUrls: ["wss://compat.example"],
    })

    expect(plan.relayUrls).toContain("wss://compat.example")
    expect(plan.relayUrls).toContain("wss://local.example")
  })

  it("reserves approved compatibility write targets inside a capped read plan", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      localReadRelayUrls: [
        "wss://local-one.example",
        "wss://local-two.example",
        "wss://local-three.example",
      ],
      compatibilityRelayUrls: [
        "wss://conduit.example",
        "wss://inbox.example",
        "wss://interop.example",
        "wss://public.example",
      ],
      requiredCompatibilityRelayUrls: [
        "wss://conduit.example",
        "wss://inbox.example",
        "wss://interop.example",
        "wss://not-in-read-set.example",
      ],
      maxRelays: 4,
    })

    expect(plan.relayUrls).toEqual([
      "wss://conduit.example",
      "wss://inbox.example",
      "wss://interop.example",
      "wss://local-one.example",
    ])
  })

  it("uses the cached declared relays when discovery degraded", () => {
    primeInboxDeclarationCache(OWNER, ["wss://cached-inbox.example"], () => 0)
    const plan = planInboxReadRelays({
      declaration: resolution({
        state: "lookup_unavailable",
        relayUrls: [],
      }),
      localReadRelayUrls: [],
      compatibilityRelayUrls: ["wss://compat.example"],
    })

    expect(plan.relayUrls).toEqual([
      "wss://cached-inbox.example",
      "wss://compat.example",
    ])
    expect(plan.relaySources["wss://cached-inbox.example"]).toBe("cache")
  })

  it("caps the plan at maxRelays preserving priority order", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ relayUrls: ["wss://inbox.example"] }),
      localReadRelayUrls: ["wss://local.example"],
      compatibilityRelayUrls: ["wss://compat.example"],
      maxRelays: 2,
    })

    expect(plan.relayUrls).toEqual([
      "wss://inbox.example",
      "wss://local.example",
    ])
  })

  it("drops insecure relay urls from every source", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ relayUrls: ["ws://inbox.example"] }),
      localReadRelayUrls: ["ws://local.example"],
      compatibilityRelayUrls: ["wss://compat.example"],
    })

    expect(plan.relayUrls).toEqual(["wss://compat.example"])
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
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://a"],
      })
    ).toBe("unavailable")
  })
})

describe("selectPrivateMessageDeliveryRoute", () => {
  it("always prefers a valid declaration over compatibility", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ relayUrls: ["wss://inbox.example"] }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.example"],
    })

    expect(selection.route).toBe("declared_inbox")
    expect(selection.relayUrls).toEqual(["wss://inbox.example"])
  })

  it("routes a validated order to a bounded compatibility plan when enabled", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: [
        "wss://one.example",
        "wss://two.example",
        "wss://three.example",
        "wss://four.example",
      ],
    })

    expect(selection.route).toBe("compatibility_order")
    expect(selection.relayUrls).toEqual([
      "wss://one.example",
      "wss://two.example",
      "wss://three.example",
    ])
  })

  it("caps an oversized declared inbox without adding compatibility targets", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({
        relayUrls: [
          "wss://declared-one.example",
          "wss://declared-two.example",
          "wss://declared-three.example",
          "wss://declared-four.example",
        ],
      }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.example"],
    })

    expect(selection.relayUrls).toEqual([
      "wss://declared-one.example",
      "wss://declared-two.example",
      "wss://declared-three.example",
    ])
    expect(selection.truncated).toBe(true)
  })

  it("blocks compatibility when the deployment-profile flag is off", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_observed", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: false,
      compatibilityRelayUrls: ["wss://compatibility.example"],
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
      compatibilityRelayUrls: ["wss://compatibility.example"],
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
      compatibilityRelayUrls: ["wss://compatibility.example"],
    })

    expect(selection.route).toBe("blocked")
  })

  it("blocks writes on a signed malformed declaration", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "malformed", relayUrls: [] }),
      validatedOrder: true,
      compatibilityEnabled: true,
      compatibilityRelayUrls: ["wss://compatibility.example"],
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
      compatibilityRelayUrls: ["wss://compatibility.example"],
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("declaration_signed_empty")
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
      compatibilityRelayUrls: ["ws://insecure.example"],
    })

    expect(selection.route).toBe("blocked")
  })
})

describe("planCompatibilityOrderRelays", () => {
  it("normalizes, deduplicates, and caps the approved pool", () => {
    const plan = planCompatibilityOrderRelays({
      approvedRelayUrls: [
        "WSS://One.Example/",
        "wss://one.example",
        "wss://two.example",
        "ws://insecure.example",
        "wss://three.example",
        "wss://four.example",
      ],
      recipientReadRelayUrls: [],
      maxRelays: 3,
    })

    expect(plan.relayUrls).toEqual([
      "wss://one.example",
      "wss://two.example",
      "wss://three.example",
    ])
  })

  it("lets signed recipient read evidence reorder but never widen the approved pool", () => {
    const plan = planCompatibilityOrderRelays({
      approvedRelayUrls: [
        "wss://one.example",
        "wss://two.example",
        "wss://three.example",
      ],
      recipientReadRelayUrls: [
        "wss://arbitrary.example",
        "wss://three.example/",
        "wss://one.example",
      ],
      maxRelays: 3,
    })

    expect(plan.relayUrls).toEqual([
      "wss://three.example",
      "wss://one.example",
      "wss://two.example",
    ])
    expect(plan.relayUrls).not.toContain("wss://arbitrary.example")
    expect(plan.relaySources).toEqual({
      "wss://three.example": "recipient_nip65",
      "wss://one.example": "recipient_nip65",
      "wss://two.example": "compatibility_registry",
    })
  })
})

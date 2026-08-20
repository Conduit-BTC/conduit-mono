import { describe, expect, it } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS,
  DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT,
  DEFAULT_MARKET_PERSPECTIVE_MIN_REFRESH_FOLLOWS,
  DEFAULT_MARKET_PERSPECTIVE_PUBKEY,
  DEFAULT_MARKET_PERSPECTIVE_FOLLOW_STORAGE_KEY,
  getDefaultMarketPerspectiveCatalogAuthorKey,
  getDefaultMarketPerspectiveFollowReconciliation,
  getDefaultMarketPerspectiveFollowSnapshot,
  getDefaultMarketPerspectiveFollowStorageSnapshot,
  getDefaultMarketPerspectiveRefreshThreshold,
  isDefaultMarketPerspectiveFollowDiscoveryStale,
  parseVerifiedFollowListEventSnapshot,
  resolveSafeDefaultMarketPerspectiveFollowRefresh,
  resolveDefaultMarketPerspectiveFollowRefresh,
  selectDefaultMarketPerspectiveFollowSnapshot,
  storeDefaultMarketPerspectiveFollowSnapshot,
  subscribeDefaultMarketPerspectiveFollowStorage,
} from "../apps/market/src/lib/defaultMarketPerspective"
import {
  isSameFollowListSnapshot,
  type FollowListSnapshot,
} from "../apps/market/src/lib/productCatalogRead"

const TEST_FOLLOW_SECRET = Uint8Array.from([...new Uint8Array(31), 9])
const TEST_FOLLOW_PUBKEY = getPublicKey(TEST_FOLLOW_SECRET)

function createVerifiedFollowSnapshot(
  pubkeys: readonly string[],
  eventCreatedAt: number
): FollowListSnapshot {
  const event = finalizeEvent(
    {
      kind: 3,
      created_at: eventCreatedAt,
      tags: pubkeys.map((pubkey) => ["p", pubkey]),
      content: "",
    },
    TEST_FOLLOW_SECRET
  )
  const snapshot = parseVerifiedFollowListEventSnapshot(event, {
    expectedPubkey: TEST_FOLLOW_PUBKEY,
    now: eventCreatedAt,
  })
  if (!snapshot) throw new Error("Expected a valid signed follow snapshot")
  return snapshot
}

function withMockWindow(value: unknown, run: () => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  })

  try {
    run()
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
}

describe("default Market perspective follow-list safety", () => {
  it("rejects empty and tiny refreshed follow lists", () => {
    expect(
      resolveSafeDefaultMarketPerspectiveFollowRefresh(
        [],
        [...DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS]
      )
    ).toBeNull()
    expect(
      resolveSafeDefaultMarketPerspectiveFollowRefresh(
        DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 2),
        DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
      )
    ).toBeNull()
  })

  it("accepts plausibly complete external curation updates", () => {
    const threshold = getDefaultMarketPerspectiveRefreshThreshold(
      DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
    )
    const refreshed = DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(
      0,
      threshold
    )

    expect(threshold).toBeGreaterThanOrEqual(
      DEFAULT_MARKET_PERSPECTIVE_MIN_REFRESH_FOLLOWS
    )
    expect(
      resolveSafeDefaultMarketPerspectiveFollowRefresh(
        refreshed,
        DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
      )
    ).toEqual([...refreshed].sort())
  })

  it("keeps guest catalog identity stable for order and self-only changes", () => {
    const merchantA = "a".repeat(64)
    const merchantB = "b".repeat(64)

    expect(
      getDefaultMarketPerspectiveCatalogAuthorKey([
        merchantB,
        DEFAULT_MARKET_PERSPECTIVE_PUBKEY,
        merchantA,
      ])
    ).toBe(
      getDefaultMarketPerspectiveCatalogAuthorKey([
        merchantA,
        merchantB,
        merchantA,
      ])
    )
  })

  it("normalizes and dedupes safe refreshes before storing", () => {
    const threshold = getDefaultMarketPerspectiveRefreshThreshold(
      DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
    )
    const refreshed = DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(
      0,
      threshold
    )
    const noisyRefresh = [
      refreshed[0]?.toUpperCase() ?? "",
      "not-a-pubkey",
      ...refreshed,
    ]

    expect(
      resolveSafeDefaultMarketPerspectiveFollowRefresh(
        noisyRefresh,
        DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
      )
    ).toEqual([...refreshed].sort())
    expect(
      storeDefaultMarketPerspectiveFollowSnapshot(
        { pubkeys: noisyRefresh, eventCreatedAt: 1 },
        {
          previousPubkeys: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS,
        }
      )?.pubkeys
    ).toEqual([...refreshed].sort())
  })

  it("keeps the newest cached curation snapshot across reloads", () => {
    const storage = new Map<string, string>()
    withMockWindow(
      {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
      () => {
        const threshold = getDefaultMarketPerspectiveRefreshThreshold()
        const firstPubkeys = DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(
          0,
          threshold
        )
        const newestPubkeys = DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(
          -DEFAULT_MARKET_PERSPECTIVE_MIN_REFRESH_FOLLOWS
        )
        const olderPubkeys =
          DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(-threshold)
        const firstSnapshot = createVerifiedFollowSnapshot(
          firstPubkeys,
          DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT
        )
        const first = storeDefaultMarketPerspectiveFollowSnapshot(
          firstSnapshot,
          {
            previousPubkeys: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS,
            expectedPubkey: TEST_FOLLOW_PUBKEY,
          }
        )
        expect(first?.pubkeys).toEqual([...firstPubkeys].sort())

        const newestSnapshot = createVerifiedFollowSnapshot(
          newestPubkeys,
          DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 2
        )
        const newest = storeDefaultMarketPerspectiveFollowSnapshot(
          newestSnapshot,
          {
            previousSnapshot: first ?? undefined,
            expectedPubkey: TEST_FOLLOW_PUBKEY,
          }
        )
        expect(newest?.pubkeys).toEqual([...newestPubkeys].sort())

        storeDefaultMarketPerspectiveFollowSnapshot(
          createVerifiedFollowSnapshot(
            olderPubkeys,
            DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT
          ),
          {
            previousSnapshot: newest ?? undefined,
            expectedPubkey: TEST_FOLLOW_PUBKEY,
          }
        )

        expect(
          isSameFollowListSnapshot(
            getDefaultMarketPerspectiveFollowSnapshot({
              expectedPubkey: TEST_FOLLOW_PUBKEY,
            }),
            newest ?? undefined
          )
        ).toBe(true)
      }
    )
  })

  it("checks refresh retention against storage that advanced beyond stale caller state", () => {
    const storage = new Map<string, string>()
    withMockWindow(
      {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
      () => {
        const advancedPubkeys = DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS
        const staleCallerPubkeys = advancedPubkeys.slice(
          0,
          DEFAULT_MARKET_PERSPECTIVE_MIN_REFRESH_FOLLOWS
        )
        const advancedSnapshot = createVerifiedFollowSnapshot(
          advancedPubkeys,
          DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 1
        )
        const advanced = storeDefaultMarketPerspectiveFollowSnapshot(
          advancedSnapshot,
          {
            previousPubkeys: advancedPubkeys,
            expectedPubkey: TEST_FOLLOW_PUBKEY,
          }
        )
        expect(advanced?.pubkeys).toHaveLength(advancedPubkeys.length)

        const retained = storeDefaultMarketPerspectiveFollowSnapshot(
          createVerifiedFollowSnapshot(
            staleCallerPubkeys,
            DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 2
          ),
          {
            previousPubkeys: staleCallerPubkeys,
            expectedPubkey: TEST_FOLLOW_PUBKEY,
          }
        )
        expect(
          isSameFollowListSnapshot(retained ?? undefined, advanced ?? undefined)
        ).toBe(true)
        expect(
          isSameFollowListSnapshot(
            getDefaultMarketPerspectiveFollowSnapshot({
              expectedPubkey: TEST_FOLLOW_PUBKEY,
            }),
            advanced ?? undefined
          )
        ).toBe(true)
      }
    )
  })

  it("reconciles a stale tab to stronger storage before selecting an older relay result", () => {
    const stale = {
      pubkeys: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 26),
      eventCreatedAt: DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 1,
      eventId: "3".repeat(64),
      evidence: "verified" as const,
    }
    const advanced = {
      pubkeys: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS,
      eventCreatedAt: DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 3,
      eventId: "1".repeat(64),
      evidence: "verified" as const,
    }
    const olderRelayResult = {
      ...stale,
      pubkeys: stale.pubkeys.slice(
        0,
        DEFAULT_MARKET_PERSPECTIVE_MIN_REFRESH_FOLLOWS
      ),
      eventCreatedAt: DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 2,
      eventId: "2".repeat(64),
      evidence: "verified" as const,
    }

    const retained = selectDefaultMarketPerspectiveFollowSnapshot(
      stale,
      advanced
    )
    const superseded = resolveDefaultMarketPerspectiveFollowRefresh({
      readAvailable: true,
      retainedSnapshot: retained,
      observedCandidate: olderRelayResult,
    })

    expect(superseded.selectedSnapshot).toEqual(advanced)
    expect(superseded.disposition).toBe("superseded")
    expect(
      isDefaultMarketPerspectiveFollowDiscoveryStale({
        enabled: true,
        queryError: false,
        queryPaused: false,
        readIncomplete: false,
        selectedSnapshot: superseded.selectedSnapshot,
        refreshDisposition: superseded.disposition,
      })
    ).toBe(false)
    expect(
      resolveDefaultMarketPerspectiveFollowRefresh({
        readAvailable: true,
        retainedSnapshot: retained,
        observedCandidate: retained,
      }).disposition
    ).toBe("accepted")
    expect(
      resolveDefaultMarketPerspectiveFollowRefresh({
        readAvailable: true,
        retainedSnapshot: retained,
        observedCandidate: {
          ...olderRelayResult,
          eventCreatedAt: DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 4,
          eventId: "0".repeat(64),
        },
      }).disposition
    ).toBe("rejected")
    expect(
      resolveDefaultMarketPerspectiveFollowRefresh({
        readAvailable: false,
        retainedSnapshot: retained,
        observedCandidate: null,
      }).disposition
    ).toBe("unavailable")
    expect(
      resolveSafeDefaultMarketPerspectiveFollowRefresh(
        stale.pubkeys.slice(0, DEFAULT_MARKET_PERSPECTIVE_MIN_REFRESH_FOLLOWS),
        advanced.pubkeys
      )
    ).toBeNull()
  })

  it("keeps unsafe, incomplete, and unverified guest discovery stale", () => {
    const verified = createVerifiedFollowSnapshot(
      DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 26),
      DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 1
    )
    const current = {
      enabled: true,
      queryError: false,
      queryPaused: false,
      readIncomplete: false,
      selectedSnapshot: verified,
      refreshDisposition: "accepted" as const,
    }

    expect(isDefaultMarketPerspectiveFollowDiscoveryStale(current)).toBe(false)
    expect(
      isDefaultMarketPerspectiveFollowDiscoveryStale({
        ...current,
        refreshDisposition: "rejected",
      })
    ).toBe(true)
    expect(
      isDefaultMarketPerspectiveFollowDiscoveryStale({
        ...current,
        queryPaused: true,
      })
    ).toBe(true)
    expect(
      isDefaultMarketPerspectiveFollowDiscoveryStale({
        ...current,
        queryError: true,
      })
    ).toBe(true)
    expect(
      isDefaultMarketPerspectiveFollowDiscoveryStale({
        ...current,
        readIncomplete: true,
      })
    ).toBe(true)
    expect(
      isDefaultMarketPerspectiveFollowDiscoveryStale({
        ...current,
        selectedSnapshot: getDefaultMarketPerspectiveFollowSnapshot(),
      })
    ).toBe(true)
    expect(
      isDefaultMarketPerspectiveFollowDiscoveryStale({
        ...current,
        enabled: false,
      })
    ).toBe(false)
  })

  it("does not let corrupt same-event storage undo a verified in-memory repair", () => {
    const eventId = "4".repeat(64)
    const inMemory = {
      pubkeys: ["a".repeat(64)],
      eventCreatedAt: 200,
      eventId,
      evidence: "verified" as const,
    }
    const corruptPersisted = {
      pubkeys: ["b".repeat(64)],
      eventCreatedAt: 300,
      eventId,
    }
    const verifiedCandidate = {
      pubkeys: ["c".repeat(64)],
      eventCreatedAt: 200,
      eventId,
      evidence: "verified" as const,
    }

    expect(
      selectDefaultMarketPerspectiveFollowSnapshot(inMemory, corruptPersisted)
    ).toEqual(inMemory)
    expect(
      selectDefaultMarketPerspectiveFollowSnapshot(
        inMemory,
        corruptPersisted,
        verifiedCandidate
      )
    ).toEqual(verifiedCandidate)
  })

  it("lets verified relay evidence supersede a plausible unverified cache projection", () => {
    const now = Math.floor(Date.now() / 1000)
    const cachedProjection = {
      pubkeys: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 25),
      eventCreatedAt: now + 60,
      eventId: "f".repeat(64),
    }
    const verifiedLive = {
      pubkeys: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 26),
      eventCreatedAt: now,
      eventId: "e".repeat(64),
      evidence: "verified" as const,
    }

    expect(
      selectDefaultMarketPerspectiveFollowSnapshot(
        cachedProjection,
        undefined,
        verifiedLive
      )
    ).toEqual(verifiedLive)
  })

  it("does not let an older verified relay view replace the bundled frontier", () => {
    const bundled = getDefaultMarketPerspectiveFollowSnapshot()
    const olderVerified = {
      pubkeys: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 26),
      eventCreatedAt: DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT - 1,
      eventId: "1".repeat(64),
      evidence: "verified" as const,
    }

    expect(
      selectDefaultMarketPerspectiveFollowSnapshot(
        bundled,
        undefined,
        olderVerified
      )
    ).toEqual(bundled)
  })

  it("does not let a projection-only cache evict or veto the bundled frontier", () => {
    const storage = new Map<string, string>()
    const projectedPubkeys = Array.from({ length: 1_000 }, (_, index) =>
      index.toString(16).padStart(64, "0")
    )
    storage.set(
      DEFAULT_MARKET_PERSPECTIVE_FOLLOW_STORAGE_KEY,
      JSON.stringify({
        pubkeys: projectedPubkeys,
        eventCreatedAt: DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 60,
        eventId: "f".repeat(64),
      })
    )
    withMockWindow(
      {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
      },
      () => {
        const retained = getDefaultMarketPerspectiveFollowSnapshot()
        const olderVerified = {
          ...createVerifiedFollowSnapshot(
            DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 26),
            DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT - 1
          ),
          signedEvent: undefined,
        }

        expect(retained.evidence).toBe("bundled")
        expect(storage.has(DEFAULT_MARKET_PERSPECTIVE_FOLLOW_STORAGE_KEY)).toBe(
          false
        )
        expect(
          resolveSafeDefaultMarketPerspectiveFollowRefresh(
            DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 26),
            retained.pubkeys
          )
        ).not.toBeNull()
        expect(
          selectDefaultMarketPerspectiveFollowSnapshot(
            retained,
            undefined,
            olderVerified
          )
        ).toEqual(retained)
      }
    )
  })

  it("derives persisted projections only from valid signed contact-list events", () => {
    const secret = Uint8Array.from([...new Uint8Array(31), 7])
    const pubkey = getPublicKey(secret)
    const now = 1_800_000_000
    const follows = DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 25)
    const event = finalizeEvent(
      {
        kind: 3,
        created_at: now,
        tags: follows.map((follow) => ["p", follow]),
        content: "",
      },
      secret
    )

    expect(
      parseVerifiedFollowListEventSnapshot(event, {
        expectedPubkey: pubkey,
        now,
      })
    ).toMatchObject({
      pubkeys: [...follows].sort(),
      eventCreatedAt: now,
      eventId: event.id,
      evidence: "verified",
      signedEvent: event,
    })
    expect(
      parseVerifiedFollowListEventSnapshot(
        { ...event, content: "tampered" },
        { expectedPubkey: pubkey, now }
      )
    ).toBeUndefined()
    expect(
      parseVerifiedFollowListEventSnapshot(event, {
        expectedPubkey: "f".repeat(64),
        now,
      })
    ).toBeUndefined()
  })

  it("keeps a newer in-memory frontier when browser persistence is unavailable", () => {
    withMockWindow(
      {
        localStorage: {
          getItem: () => null,
          setItem: () => {
            throw new Error("storage unavailable")
          },
        },
      },
      () => {
        const bundled = getDefaultMarketPerspectiveFollowSnapshot()
        const first = storeDefaultMarketPerspectiveFollowSnapshot(
          createVerifiedFollowSnapshot(
            DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 26),
            DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 1
          ),
          {
            previousSnapshot: bundled,
            expectedPubkey: TEST_FOLLOW_PUBKEY,
          }
        )
        const second = storeDefaultMarketPerspectiveFollowSnapshot(
          createVerifiedFollowSnapshot(
            DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 25),
            DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 2
          ),
          {
            previousSnapshot: first ?? undefined,
            expectedPubkey: TEST_FOLLOW_PUBKEY,
          }
        )

        expect(first?.pubkeys).toHaveLength(26)
        expect(second?.pubkeys).toHaveLength(25)
        expect(second?.eventCreatedAt).toBe(
          DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 2
        )
      }
    )
  })

  it("discards an impossible future cached frontier", () => {
    const storage = new Map<string, string>()
    let now = 1_800_000_000
    storage.set(
      DEFAULT_MARKET_PERSPECTIVE_FOLLOW_STORAGE_KEY,
      JSON.stringify({
        pubkeys: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(
          0,
          DEFAULT_MARKET_PERSPECTIVE_MIN_REFRESH_FOLLOWS
        ),
        eventCreatedAt: now + 301,
        eventId: "f".repeat(64),
      })
    )
    withMockWindow(
      {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
      },
      () => {
        const bundled = {
          pubkeys: [...DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS].sort(),
          eventCreatedAt: DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT,
          evidence: "bundled",
        }
        expect(
          getDefaultMarketPerspectiveFollowSnapshot({ now: () => now })
        ).toEqual(bundled)
        expect(storage.has(DEFAULT_MARKET_PERSPECTIVE_FOLLOW_STORAGE_KEY)).toBe(
          false
        )

        now += 2
        expect(
          getDefaultMarketPerspectiveFollowSnapshot({ now: () => now })
        ).toEqual(bundled)
      }
    )
  })

  it("retries an in-memory frontier after browser persistence recovers", () => {
    const storage = new Map<string, string>()
    let storageAvailable = false
    let writeAttempts = 0
    withMockWindow(
      {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => {
            writeAttempts += 1
            if (!storageAvailable) throw new Error("storage unavailable")
            storage.set(key, value)
          },
        },
      },
      () => {
        const bundled = getDefaultMarketPerspectiveFollowSnapshot()
        const snapshot = createVerifiedFollowSnapshot(
          DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 26),
          DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 1
        )
        const first = storeDefaultMarketPerspectiveFollowSnapshot(snapshot, {
          previousSnapshot: bundled,
          expectedPubkey: TEST_FOLLOW_PUBKEY,
        })
        expect(writeAttempts).toBe(1)

        storageAvailable = true
        const retried = storeDefaultMarketPerspectiveFollowSnapshot(snapshot, {
          previousSnapshot: first ?? undefined,
          expectedPubkey: TEST_FOLLOW_PUBKEY,
        })

        expect(writeAttempts).toBe(2)
        expect(retried).toEqual(first)
        expect(
          isSameFollowListSnapshot(
            getDefaultMarketPerspectiveFollowSnapshot({
              expectedPubkey: TEST_FOLLOW_PUBKEY,
            }),
            first ?? undefined
          )
        ).toBe(true)
      }
    )
  })

  it("repairs a weaker cross-tab write from the stronger signed in-memory frontier", () => {
    const storage = new Map<string, string>()
    withMockWindow(
      {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          removeItem: (key: string) => storage.delete(key),
        },
      },
      () => {
        const weaker = createVerifiedFollowSnapshot(
          DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 26),
          DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 1
        )
        const stronger = createVerifiedFollowSnapshot(
          DEFAULT_MARKET_PERSPECTIVE_FOLLOW_PUBKEYS.slice(0, 25),
          DEFAULT_MARKET_PERSPECTIVE_FOLLOWS_CREATED_AT + 2
        )
        storage.set(
          DEFAULT_MARKET_PERSPECTIVE_FOLLOW_STORAGE_KEY,
          JSON.stringify({
            pubkeys: weaker.pubkeys,
            eventCreatedAt: weaker.eventCreatedAt,
            eventId: weaker.eventId,
            signedEvent: weaker.signedEvent,
          })
        )
        const persistedWeaker = getDefaultMarketPerspectiveFollowSnapshot({
          expectedPubkey: TEST_FOLLOW_PUBKEY,
        })
        const selected = selectDefaultMarketPerspectiveFollowSnapshot(
          stronger,
          persistedWeaker
        )
        const reconciliation = getDefaultMarketPerspectiveFollowReconciliation({
          enabled: true,
          inMemory: stronger,
          persisted: persistedWeaker,
          selected,
        })

        expect(reconciliation).toEqual({
          needsStateUpdate: false,
          needsStorageRepair: true,
        })
        expect(
          storeDefaultMarketPerspectiveFollowSnapshot(selected, {
            previousSnapshot: stronger,
            expectedPubkey: TEST_FOLLOW_PUBKEY,
          })
        ).toEqual(stronger)

        const repaired = getDefaultMarketPerspectiveFollowSnapshot({
          expectedPubkey: TEST_FOLLOW_PUBKEY,
        })
        expect(isSameFollowListSnapshot(repaired, stronger)).toBe(true)
        expect(
          isSameFollowListSnapshot(
            selectDefaultMarketPerspectiveFollowSnapshot(weaker, repaired),
            stronger
          )
        ).toBe(true)
      }
    )
  })

  it("notifies subscribers when another tab changes the cached frontier", () => {
    const storage = new Map<string, string>()
    const listeners = new Map<string, Set<(event: Event) => void>>()
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    }
    withMockWindow(
      {
        localStorage,
        addEventListener: (type: string, listener: (event: Event) => void) => {
          const current = listeners.get(type) ?? new Set()
          current.add(listener)
          listeners.set(type, current)
        },
        removeEventListener: (type: string, listener: (event: Event) => void) =>
          listeners.get(type)?.delete(listener),
        dispatchEvent: (event: Event) => {
          listeners.get(event.type)?.forEach((listener) => listener(event))
          return true
        },
      },
      () => {
        let notifications = 0
        const unsubscribe = subscribeDefaultMarketPerspectiveFollowStorage(
          () => {
            notifications += 1
          }
        )
        const raw = JSON.stringify({ eventId: "1".repeat(64) })
        storage.set(DEFAULT_MARKET_PERSPECTIVE_FOLLOW_STORAGE_KEY, raw)
        listeners.get("storage")?.forEach((listener) =>
          listener({
            type: "storage",
            key: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_STORAGE_KEY,
            storageArea: localStorage,
          } as unknown as StorageEvent)
        )

        expect(notifications).toBe(1)
        expect(getDefaultMarketPerspectiveFollowStorageSnapshot()).toBe(raw)
        unsubscribe()
        listeners.get("storage")?.forEach((listener) =>
          listener({
            type: "storage",
            key: DEFAULT_MARKET_PERSPECTIVE_FOLLOW_STORAGE_KEY,
            storageArea: localStorage,
          } as unknown as StorageEvent)
        )
        expect(notifications).toBe(1)
      }
    )
  })
})

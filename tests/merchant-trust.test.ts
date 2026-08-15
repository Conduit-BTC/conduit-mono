import { afterEach, describe, expect, it } from "bun:test"
import NDK, { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { nip19 } from "nostr-tools"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  CONTACT_LIST_WRITES_AVAILABLE,
  CONTACT_LIST_WRITE_UNAVAILABLE_MESSAGE,
  ContactListWriteUnavailableError,
  __resetFollowListTestState,
  __resetRelayHealth,
  __setFollowListTestOverrides,
  buildMerchantTrustSocialSummary,
  disconnectNdk,
  extractFollowPubkeys,
  fetchMerchantTrustSocialSummary,
  getNdkState,
  publishContactListUpdate,
  readLatestFollowLists,
  recordRelayFailure,
  requirePublishableContactListSnapshot,
  selectLatestFollowListEvent,
  subscribeNdkState,
  type CachedOwnContactListSnapshot,
  type FollowListReadOptions,
  type RelayList,
  type SignedPublicNostrEvent,
} from "@conduit/core"

const merchantSecret = Uint8Array.from([...new Uint8Array(31), 31])
const viewerSecret = Uint8Array.from([...new Uint8Array(31), 32])
const merchantPubkey = getPublicKey(merchantSecret)
const viewerPubkey = getPublicKey(viewerSecret)
const mutualPubkey = "c".repeat(64)

afterEach(() => {
  __resetFollowListTestState()
  __resetRelayHealth()
})

function followListEvent(input: {
  secret: Uint8Array
  createdAt: number
  follows: string[]
}): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      created_at: input.createdAt,
      kind: 3,
      tags: input.follows.map((pubkey) => ["p", pubkey]),
      content: "",
    },
    input.secret
  )
}

function relayList(
  pubkey: string,
  readRelayUrls: string[],
  writeRelayUrls: string[]
): RelayList {
  return {
    pubkey,
    readRelayUrls,
    writeRelayUrls,
    eventCreatedAt: 1,
    lookupState: "network",
    cachedAt: 1,
  }
}

function createOwnContactListSnapshotCache() {
  let stored: CachedOwnContactListSnapshot | undefined

  return {
    overrides: {
      loadOwnContactListSnapshot: async () =>
        stored ? structuredClone(stored) : undefined,
      putOwnContactListSnapshot: async (
        snapshot: CachedOwnContactListSnapshot
      ) => {
        stored = structuredClone(snapshot)
      },
    },
    get: () => (stored ? structuredClone(stored) : undefined),
  }
}

describe("NIP-02 merchant trust helpers", () => {
  it("blocks contact-list writes before relay connection side effects", async () => {
    disconnectNdk()
    const initialNdkState = getNdkState()
    let stateChangeCount = 0
    const unsubscribe = subscribeNdkState(() => {
      stateChangeCount += 1
    })

    try {
      const error = await publishContactListUpdate({
        ownerPubkey: viewerPubkey,
        targetPubkey: merchantPubkey,
        shouldFollow: true,
        appId: "market",
      }).then(
        () => null,
        (failure: unknown) => failure
      )

      expect(CONTACT_LIST_WRITES_AVAILABLE).toBe(false)
      expect(error).toBeInstanceOf(ContactListWriteUnavailableError)
      expect(error).toMatchObject({
        name: "ContactListWriteUnavailableError",
        code: "contact_list_writes_unavailable",
        message: CONTACT_LIST_WRITE_UNAVAILABLE_MESSAGE,
      })
      expect(stateChangeCount).toBe(0)
      expect(getNdkState()).toEqual(initialNdkState)
    } finally {
      unsubscribe()
      disconnectNdk()
    }
  })

  it("extracts unique p-tag pubkeys and ignores malformed tags", () => {
    expect(
      extractFollowPubkeys([
        ["p", merchantPubkey],
        ["p", merchantPubkey],
        ["p", "not-a-pubkey"],
        ["e", "d".repeat(64)],
      ])
    ).toEqual([merchantPubkey])
  })

  it("selects the latest contact-list event by created_at", () => {
    const latest = selectLatestFollowListEvent([
      { created_at: 10, tags: [["p", merchantPubkey]] },
      { created_at: 25, tags: [["p", viewerPubkey]] },
      { created_at: 15, tags: [["p", mutualPubkey]] },
    ])

    expect(latest?.created_at).toBe(25)
  })

  it("uses the NIP-01 lowest-id tie break for contact-list replacements", () => {
    const latest = selectLatestFollowListEvent([
      { id: "b".repeat(64), created_at: 25, tags: [] },
      { id: "a".repeat(64), created_at: 25, tags: [] },
    ])

    expect(latest?.id).toBe("a".repeat(64))
  })

  it("derives bounded merchant social context without follower crawling", () => {
    const summary = buildMerchantTrustSocialSummary({
      merchantPubkey,
      viewerPubkey,
      viewerFollowPubkeys: [merchantPubkey, mutualPubkey],
      merchantFollowPubkeys: [viewerPubkey, mutualPubkey],
    })

    expect(summary).toEqual({
      merchantFollowingCount: 2,
      viewerFollowsMerchant: true,
      merchantFollowsViewer: true,
      mutualFollowCount: 1,
    })
  })

  it("plans merchant trust reads without accepting the merchant's local relay", async () => {
    const viewerLocalRelay = "ws://127.0.0.1:7777"
    const merchantPrivateRelay = "wss://127.0.0.1:7447"
    const merchantPublicRelay = "wss://merchant.example"
    const attemptedByAuthor = new Map<string, string[]>()
    const viewerEvent = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [merchantPubkey, mutualPubkey],
    })
    const merchantEvent = followListEvent({
      secret: merchantSecret,
      createdAt: 100,
      follows: [viewerPubkey, mutualPubkey],
    })

    const summary = await fetchMerchantTrustSocialSummary(
      { merchantPubkey, viewerPubkey },
      {
        now: () => 100_000,
        resolveRelayLists: async () =>
          new Map([
            [
              viewerPubkey,
              relayList(viewerPubkey, [viewerLocalRelay], [viewerLocalRelay]),
            ],
            [
              merchantPubkey,
              relayList(
                merchantPubkey,
                [],
                [merchantPrivateRelay, merchantPublicRelay]
              ),
            ],
          ]),
        fetchEvents: async (filter, options) => {
          const author = filter.authors?.[0] ?? ""
          attemptedByAuthor.set(author, options?.relayUrls ?? [])
          const event = author === viewerPubkey ? viewerEvent : merchantEvent
          return {
            events: [event],
            eventSourceRelayUrls: {
              [event.id]: [options?.relayUrls?.[0] ?? ""],
            },
            relays: (options?.relayUrls ?? []).map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
              eventCount: 1,
            })),
            // Injectable readers cannot self-attest; the helper re-verifies.
            eventsVerified: false,
          }
        },
      }
    )

    expect(attemptedByAuthor.get(viewerPubkey)).toContain(viewerLocalRelay)
    expect(attemptedByAuthor.get(merchantPubkey)).toContain(merchantPublicRelay)
    expect(attemptedByAuthor.get(merchantPubkey)).not.toContain(
      merchantPrivateRelay
    )
    expect(attemptedByAuthor.get(viewerPubkey)?.length).toBeGreaterThan(1)
    expect(attemptedByAuthor.get(merchantPubkey)?.length).toBeGreaterThan(1)
    expect(summary).toMatchObject({
      merchantFollowingCount: 2,
      viewerFollowsMerchant: true,
      merchantFollowsViewer: true,
      mutualFollowCount: 1,
      readState: "available",
    })
  })

  it("keeps a parked author relay in replacement-sensitive coverage", async () => {
    const parkedRelay = "wss://parked-contact.example"
    recordRelayFailure(parkedRelay)
    recordRelayFailure(parkedRelay)
    const event = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [merchantPubkey],
    })
    let attemptedRelayUrls: string[] = []

    const read = await readLatestFollowLists(
      {
        pubkeys: [viewerPubkey],
        authenticatedPubkey: viewerPubkey,
      },
      {
        refreshRelayLists: true,
        resolveRelayLists: async () =>
          new Map([[viewerPubkey, relayList(viewerPubkey, [], [parkedRelay])]]),
        fetchEvents: async (_filter, options) => {
          attemptedRelayUrls = [...options.relayUrls]
          const completedRelay =
            options.relayUrls.find((relayUrl) => relayUrl !== parkedRelay) ??
            options.relayUrls[0]!
          return {
            events: [event],
            eventSourceRelayUrls: { [event.id]: [completedRelay] },
            relays: options.relayUrls.map((relayUrl) => ({
              relayUrl,
              status:
                relayUrl === parkedRelay
                  ? ("failed" as const)
                  : ("success" as const),
              eventCount: relayUrl === completedRelay ? 1 : 0,
            })),
            eventsVerified: false,
          }
        },
      }
    )

    expect(attemptedRelayUrls).toContain(parkedRelay)
    expect(read.authors[0]?.coverage).toBe("limited")
  })

  it("marks a bounded author-hint overflow non-publishable", async () => {
    const hints = [
      "wss://hint-one.example",
      "wss://hint-two.example",
      "wss://hint-three.example",
    ]
    const event = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [merchantPubkey],
    })

    const read = await readLatestFollowLists(
      {
        pubkeys: [viewerPubkey],
        authenticatedPubkey: viewerPubkey,
      },
      {
        maxRelays: 2,
        refreshRelayLists: true,
        resolveRelayLists: async () =>
          new Map([[viewerPubkey, relayList(viewerPubkey, [], hints)]]),
        fetchEvents: async (_filter, options) => ({
          events: [event],
          eventSourceRelayUrls: { [event.id]: [options.relayUrls[0]!] },
          relays: options.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 1,
          })),
          eventsVerified: false,
        }),
      }
    )

    expect(read.authors[0]?.relayHintTruncated).toBe(true)
    expect(read.authors[0]?.coverage).toBe("limited")
    expect(() =>
      requirePublishableContactListSnapshot(read, viewerPubkey)
    ).toThrow("completed the read")
  })

  it("ignores far-future and forged contact-list snapshots", async () => {
    const publicRelay = "wss://relay.example/"
    const future = followListEvent({
      secret: merchantSecret,
      createdAt: 10_000,
      follows: [viewerPubkey],
    })
    const forged = { ...future, created_at: 100 }

    const futureRead = await readLatestFollowLists(
      { pubkeys: [merchantPubkey] },
      {
        now: () => 1_000_000,
        resolveRelayLists: async () =>
          new Map([
            [merchantPubkey, relayList(merchantPubkey, [], [publicRelay])],
          ]),
        fetchEvents: async () => ({
          events: [future],
          eventSourceRelayUrls: {},
          relays: [{ relayUrl: publicRelay, status: "success", eventCount: 1 }],
          eventsVerified: false,
        }),
      }
    )
    const forgedRead = await readLatestFollowLists(
      { pubkeys: [merchantPubkey] },
      {
        now: () => 20_000_000,
        resolveRelayLists: async () =>
          new Map([
            [merchantPubkey, relayList(merchantPubkey, [], [publicRelay])],
          ]),
        fetchEvents: async () => ({
          events: [forged],
          eventSourceRelayUrls: {},
          relays: [{ relayUrl: publicRelay, status: "success", eventCount: 1 }],
          eventsVerified: true,
        }),
      }
    )

    expect(futureRead.events).toEqual([])
    expect(forgedRead.events).toEqual([])
  })

  it("selects the NIP-01 winner across more than ten merged relay events", async () => {
    const publicRelay = "wss://many-events.example"
    const events = Array.from({ length: 11 }, (_, index) =>
      followListEvent({
        secret: viewerSecret,
        createdAt: index + 1,
        follows: [merchantPubkey],
      })
    )
    const read = await readLatestFollowLists(
      {
        pubkeys: [viewerPubkey],
        authenticatedPubkey: viewerPubkey,
      },
      {
        resolveRelayLists: async () =>
          new Map([[viewerPubkey, relayList(viewerPubkey, [], [publicRelay])]]),
        fetchEvents: async (_filter, options) => ({
          events,
          eventSourceRelayUrls: Object.fromEntries(
            events.map((event) => [event.id, [publicRelay]])
          ),
          relays: (options?.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: false,
        }),
      }
    )

    expect(read.authors[0]?.event?.created_at).toBe(11)
    expect(read.authors[0]?.eventsVerified).toBe(true)
  })

  it("does not regress an authenticated owner after a reload", async () => {
    const publicRelay = "wss://high-water.example"
    const newer = followListEvent({
      secret: viewerSecret,
      createdAt: 200,
      follows: [merchantPubkey, mutualPubkey],
    })
    const older = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [merchantPubkey],
    })
    let current = newer
    const fetchEvents: NonNullable<
      FollowListReadOptions["fetchEvents"]
    > = async (_filter, fetchOptions) => ({
      events: [current],
      eventSourceRelayUrls: { [current.id]: [publicRelay] },
      relays: fetchOptions.relayUrls.map((relayUrl) => ({
        relayUrl,
        status: "success" as const,
        eventCount: 1,
      })),
      eventsVerified: false,
    })
    const options = {
      resolveRelayLists: async () =>
        new Map([[viewerPubkey, relayList(viewerPubkey, [], [publicRelay])]]),
      fetchEvents,
    }
    const snapshotCache = createOwnContactListSnapshotCache()
    __setFollowListTestOverrides(snapshotCache.overrides)

    await readLatestFollowLists(
      {
        pubkeys: [viewerPubkey],
        authenticatedPubkey: viewerPubkey,
      },
      options
    )
    expect(snapshotCache.get()?.event.id).toBe(newer.id)

    __resetFollowListTestState()
    __setFollowListTestOverrides(snapshotCache.overrides)
    current = older
    const regressed = await readLatestFollowLists(
      {
        pubkeys: [viewerPubkey],
        authenticatedPubkey: viewerPubkey,
      },
      options
    )

    expect(regressed.authors[0]?.event?.id).toBe(newer.id)
    expect(regressed.authors[0]?.coverage).toBe("limited")
    expect(regressed.authors[0]?.snapshotState).toBe("observed")
  })

  it("returns the transactional owner winner when another tab writes during persistence", async () => {
    const publicRelay = "wss://concurrent-observation.example"
    const networkSnapshot = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [],
    })
    const concurrentSnapshot = followListEvent({
      secret: viewerSecret,
      createdAt: 200,
      follows: [merchantPubkey],
    })
    let loadCount = 0
    let stored: CachedOwnContactListSnapshot = {
      pubkey: viewerPubkey,
      event: concurrentSnapshot,
      sourceRelayUrls: [publicRelay],
      state: "observed",
      cachedAt: Date.now(),
    }
    __setFollowListTestOverrides({
      loadOwnContactListSnapshot: async () => {
        loadCount += 1
        return loadCount === 1 ? undefined : structuredClone(stored)
      },
      putOwnContactListSnapshot: async (snapshot) => {
        stored = structuredClone(snapshot)
      },
    })

    const read = await readLatestFollowLists(
      {
        pubkeys: [viewerPubkey],
        authenticatedPubkey: viewerPubkey,
      },
      {
        resolveRelayLists: async () =>
          new Map([[viewerPubkey, relayList(viewerPubkey, [], [publicRelay])]]),
        fetchEvents: async (_filter, options) => ({
          events: [networkSnapshot],
          eventSourceRelayUrls: {
            [networkSnapshot.id]: [publicRelay],
          },
          relays: options.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 1,
          })),
          eventsVerified: false,
        }),
      }
    )

    expect(read.authors[0]?.event?.id).toBe(concurrentSnapshot.id)
    expect(read.authors[0]?.coverage).toBe("limited")
    expect(read.authors[0]?.snapshotState).toBe("observed")
    expect(stored.event.id).toBe(concurrentSnapshot.id)
  })

  it("does not delete a valid pending snapshot that replaces a corrupt row", async () => {
    const publicRelay = "wss://corrupt-cache-race.example"
    const pendingEvent = followListEvent({
      secret: viewerSecret,
      createdAt: 200,
      follows: [merchantPubkey],
    })
    const validPending: CachedOwnContactListSnapshot = {
      pubkey: viewerPubkey,
      event: pendingEvent,
      sourceRelayUrls: [],
      state: "pending",
      cachedAt: Date.now(),
    }
    let stored: CachedOwnContactListSnapshot = {
      ...validPending,
      event: { ...pendingEvent, sig: "0".repeat(128) },
    }
    let loadCount = 0
    __setFollowListTestOverrides({
      loadOwnContactListSnapshot: async () => {
        loadCount += 1
        const observed = structuredClone(stored)
        if (loadCount === 1) stored = structuredClone(validPending)
        return observed
      },
      putOwnContactListSnapshot: async (snapshot) => {
        stored = structuredClone(snapshot)
      },
    })
    const options: FollowListReadOptions = {
      resolveRelayLists: async () =>
        new Map([[viewerPubkey, relayList(viewerPubkey, [], [publicRelay])]]),
      fetchEvents: async () => {
        throw new Error("relay read unavailable")
      },
    }

    const first = await readLatestFollowLists(
      {
        pubkeys: [viewerPubkey],
        authenticatedPubkey: viewerPubkey,
      },
      options
    )
    const recovered = await readLatestFollowLists(
      {
        pubkeys: [viewerPubkey],
        authenticatedPubkey: viewerPubkey,
      },
      options
    )

    expect(first.authors[0]?.event).toBeUndefined()
    expect(stored.event.id).toBe(pendingEvent.id)
    expect(recovered.authors[0]?.event?.id).toBe(pendingEvent.id)
    expect(recovered.authors[0]?.snapshotState).toBe("pending")
  })

  it("does not overwrite a just-signed update before relay readback catches up", async () => {
    const publicRelay = "wss://readback-lag.example"
    const networkSnapshot = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [],
    })
    const ndk = new NDK({
      explicitRelayUrls: [],
      enableOutboxModel: false,
      autoConnectUserRelays: false,
    })
    ndk.signer = new NDKPrivateKeySigner(nip19.nsecEncode(viewerSecret))
    const published: SignedPublicNostrEvent[] = []
    const snapshotCache = createOwnContactListSnapshotCache()
    const readWithLag: typeof readLatestFollowLists = async (
      input,
      options
    ) => {
      expect(options.refreshRelayLists).toBe(true)
      return await readLatestFollowLists(input, {
        ...options,
        resolveRelayLists: async () =>
          new Map([[viewerPubkey, relayList(viewerPubkey, [], [publicRelay])]]),
        fetchEvents: async (_filter, fetchOptions) => ({
          events: [networkSnapshot],
          eventSourceRelayUrls: {
            [networkSnapshot.id]: [publicRelay],
          },
          relays: fetchOptions.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 1,
          })),
          eventsVerified: false,
        }),
      })
    }

    __setFollowListTestOverrides({
      ...snapshotCache.overrides,
      getNdk: () => ndk,
      readLatestFollowLists: readWithLag,
      publishWithPlanner: async (event, input) => {
        published.push(event.rawEvent() as SignedPublicNostrEvent)
        return {
          plan: {
            intent: input.intent,
            primaryRelayUrls: [publicRelay],
            broadcastRelayUrls: [],
            parkedRelayUrls: [],
          },
          attemptedRelayUrls: [publicRelay],
          successfulRelayUrls: [publicRelay],
          failedRelayUrls: [],
          relayFailureMessages: {},
        }
      },
    })

    await publishContactListUpdate({
      ownerPubkey: viewerPubkey,
      targetPubkey: merchantPubkey,
      shouldFollow: true,
      appId: "market",
    })

    await expect(
      publishContactListUpdate({
        ownerPubkey: viewerPubkey,
        targetPubkey: mutualPubkey,
        shouldFollow: true,
        appId: "market",
      })
    ).rejects.toThrow("completed the read")
    expect(published).toHaveLength(1)
    expect(extractFollowPubkeys(published[0]?.tags)).toContain(merchantPubkey)
  })

  it("aborts when another tab stores a stronger snapshot after the read", async () => {
    const publicRelay = "wss://concurrent-follow.example"
    const networkSnapshot = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [],
    })
    const concurrentSnapshot = followListEvent({
      secret: viewerSecret,
      createdAt: 200,
      follows: [mutualPubkey],
    })
    const ndk = new NDK({
      explicitRelayUrls: [],
      enableOutboxModel: false,
      autoConnectUserRelays: false,
    })
    ndk.signer = new NDKPrivateKeySigner(nip19.nsecEncode(viewerSecret))
    let stored: CachedOwnContactListSnapshot | undefined
    let concurrentWriteInjected = false
    let publishAttempts = 0

    __setFollowListTestOverrides({
      getNdk: () => ndk,
      readLatestFollowLists: async (input, options) => {
        expect(options.refreshRelayLists).toBe(true)
        return await readLatestFollowLists(input, {
          ...options,
          resolveRelayLists: async () =>
            new Map([
              [viewerPubkey, relayList(viewerPubkey, [], [publicRelay])],
            ]),
          fetchEvents: async (_filter, fetchOptions) => ({
            events: [networkSnapshot],
            eventSourceRelayUrls: {
              [networkSnapshot.id]: [publicRelay],
            },
            relays: fetchOptions.relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
              eventCount: 1,
            })),
            eventsVerified: false,
          }),
        })
      },
      loadOwnContactListSnapshot: async () =>
        stored ? structuredClone(stored) : undefined,
      putOwnContactListSnapshot: async (snapshot) => {
        if (
          !concurrentWriteInjected &&
          snapshot.event.id === networkSnapshot.id &&
          snapshot.state === "observed"
        ) {
          concurrentWriteInjected = true
          stored = {
            pubkey: viewerPubkey,
            event: concurrentSnapshot,
            sourceRelayUrls: [publicRelay],
            state: "observed",
            cachedAt: Date.now(),
          }
          return
        }
        stored = structuredClone(snapshot)
      },
      publishWithPlanner: async (_event, input) => {
        publishAttempts += 1
        return {
          plan: {
            intent: input.intent,
            primaryRelayUrls: [publicRelay],
            broadcastRelayUrls: [],
            parkedRelayUrls: [],
          },
          attemptedRelayUrls: [publicRelay],
          successfulRelayUrls: [publicRelay],
          failedRelayUrls: [],
          relayFailureMessages: {},
        }
      },
    })

    await expect(
      publishContactListUpdate({
        ownerPubkey: viewerPubkey,
        targetPubkey: merchantPubkey,
        shouldFollow: true,
        appId: "market",
      })
    ).rejects.toThrow("durable owner snapshot changed")
    expect(publishAttempts).toBe(0)
    expect(stored?.event.id).toBe(concurrentSnapshot.id)
  })

  it("retries the exact pending update after an ambiguous failure", async () => {
    const publicRelay = "wss://failed-readback.example"
    const networkSnapshot = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [],
    })
    const ndk = new NDK({
      explicitRelayUrls: [],
      enableOutboxModel: false,
      autoConnectUserRelays: false,
    })
    ndk.signer = new NDKPrivateKeySigner(nip19.nsecEncode(viewerSecret))
    let publishAttempts = 0
    let failReads = false
    const publishedIds: string[] = []
    const snapshotCache = createOwnContactListSnapshotCache()
    const readWithLag: typeof readLatestFollowLists = async (
      input,
      options
    ) => {
      expect(options.refreshRelayLists).toBe(true)
      return await readLatestFollowLists(input, {
        ...options,
        resolveRelayLists: async () =>
          new Map([[viewerPubkey, relayList(viewerPubkey, [], [publicRelay])]]),
        fetchEvents: async (_filter, fetchOptions) => {
          if (failReads) throw new Error("relay read unavailable")
          return {
            events: [networkSnapshot],
            eventSourceRelayUrls: {
              [networkSnapshot.id]: [publicRelay],
            },
            relays: fetchOptions.relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
              eventCount: 1,
            })),
            eventsVerified: false,
          }
        },
      })
    }

    const installOverrides = () =>
      __setFollowListTestOverrides({
        ...snapshotCache.overrides,
        getNdk: () => ndk,
        readLatestFollowLists: readWithLag,
        publishWithPlanner: async (event, input) => {
          publishedIds.push(event.id)
          publishAttempts += 1
          if (publishAttempts === 1) {
            throw new Error("No relay acknowledged the update")
          }
          return {
            plan: {
              intent: input.intent,
              primaryRelayUrls: [publicRelay],
              broadcastRelayUrls: [],
              parkedRelayUrls: [],
            },
            attemptedRelayUrls: [publicRelay],
            successfulRelayUrls: [publicRelay],
            failedRelayUrls: [],
            relayFailureMessages: {},
          }
        },
      })

    installOverrides()

    const update = () =>
      publishContactListUpdate({
        ownerPubkey: viewerPubkey,
        targetPubkey: merchantPubkey,
        shouldFollow: true,
        appId: "market",
      })

    await expect(update()).rejects.toThrow("No relay acknowledged")
    expect(snapshotCache.get()?.state).toBe("pending")

    failReads = true
    __resetFollowListTestState()
    installOverrides()
    await expect(update()).resolves.toBeUndefined()

    expect(publishAttempts).toBe(2)
    expect(publishedIds[1]).toBe(publishedIds[0])
    expect(snapshotCache.get()?.state).toBe("observed")
  })

  it("degrades a successful contact read when relay discovery failed", async () => {
    const publicRelay = "wss://fallback-contact.example/"
    const event = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [merchantPubkey],
    })

    const read = await readLatestFollowLists(
      {
        pubkeys: [viewerPubkey],
        authenticatedPubkey: viewerPubkey,
      },
      {
        resolveRelayListsDetailed: async () => ({
          relayLists: new Map(),
          resolutionStates: new Map([
            [viewerPubkey, "lookup-unavailable" as const],
          ]),
        }),
        fetchEvents: async (_filter, options) => ({
          events: [event],
          eventSourceRelayUrls: {
            [event.id]: [options.relayUrls[0] ?? publicRelay],
          },
          relays: options.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 1,
          })),
          eventsVerified: false,
        }),
      }
    )

    expect(read.authors[0]?.relayListState).toBe("lookup-unavailable")
    expect(read.authors[0]?.coverage).toBe("limited")
    expect(() =>
      requirePublishableContactListSnapshot(read, viewerPubkey)
    ).toThrow("completed the read")
  })

  it("reports failed and partial relay observations truthfully", async () => {
    const publicRelay = "wss://relay.example/"
    const resolveRelayLists = async () =>
      new Map([
        [merchantPubkey, relayList(merchantPubkey, [], [publicRelay])],
        [viewerPubkey, relayList(viewerPubkey, [], [publicRelay])],
      ])

    const unavailable = await fetchMerchantTrustSocialSummary(
      { merchantPubkey, viewerPubkey },
      {
        resolveRelayLists,
        fetchEvents: async (_filter, options) => ({
          events: [],
          eventSourceRelayUrls: {},
          relays: (options?.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "failed" as const,
            eventCount: 0,
          })),
          eventsVerified: true,
        }),
      }
    )
    const limited = await fetchMerchantTrustSocialSummary(
      { merchantPubkey, viewerPubkey },
      {
        resolveRelayLists,
        fetchEvents: async (_filter, options) => ({
          events: [],
          eventSourceRelayUrls: {},
          relays: (options?.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "partial" as const,
            eventCount: 0,
          })),
          eventsVerified: true,
        }),
      }
    )

    expect(unavailable.readState).toBe("unavailable")
    expect(limited.readState).toBe("limited")
  })

  it("requires a verified snapshot from at least one completed relay", () => {
    const event = followListEvent({
      secret: viewerSecret,
      createdAt: 100,
      follows: [merchantPubkey],
    })
    const partialRead = {
      events: [event],
      authors: [
        {
          pubkey: viewerPubkey,
          event,
          eventSourceRelayUrls: ["wss://relay.example/"],
          plannedRelayUrls: ["wss://relay.example/"],
          relays: [
            {
              relayUrl: "wss://relay.example/",
              status: "partial" as const,
              eventCount: 1,
            },
          ],
          eventsVerified: true,
          coverage: "limited" as const,
          relayListState: "network" as const,
          relayHintTruncated: false,
          snapshotState: "network" as const,
        },
      ],
      plannedRelayUrls: ["wss://relay.example/"],
      relays: [],
      eventsVerified: true,
    }

    expect(() =>
      requirePublishableContactListSnapshot(partialRead, viewerPubkey)
    ).toThrow("completed the read")

    const unrelatedCompletion = {
      ...partialRead,
      authors: [
        {
          ...partialRead.authors[0]!,
          coverage: "complete" as const,
          relays: [
            ...partialRead.authors[0]!.relays,
            {
              relayUrl: "wss://unrelated.example/",
              status: "success" as const,
              eventCount: 0,
            },
          ],
        },
      ],
    }
    expect(() =>
      requirePublishableContactListSnapshot(unrelatedCompletion, viewerPubkey)
    ).toThrow("completed the read")

    const completedRead = {
      ...partialRead,
      authors: [
        {
          ...partialRead.authors[0]!,
          coverage: "complete" as const,
          relays: [
            {
              ...partialRead.authors[0]!.relays[0]!,
              status: "success" as const,
            },
          ],
        },
      ],
    }
    expect(
      requirePublishableContactListSnapshot(completedRead, viewerPubkey)
    ).toBe(event)
  })

  it("passes cancellation to each author-isolated relay read", async () => {
    const controller = new AbortController()
    const publicRelay = "wss://abort-test.example"

    await expect(
      readLatestFollowLists(
        { pubkeys: [viewerPubkey] },
        {
          signal: controller.signal,
          resolveRelayLists: async () =>
            new Map([
              [viewerPubkey, relayList(viewerPubkey, [], [publicRelay])],
            ]),
          fetchEvents: async (_filter, options) => {
            expect(options?.signal).toBe(controller.signal)
            controller.abort()
            throw new DOMException("Aborted", "AbortError")
          },
        }
      )
    ).rejects.toThrow()
  })
})

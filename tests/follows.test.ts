import { afterEach, describe, expect, it } from "bun:test"
import NDK, { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  __resetFollowTestOverrides,
  __setFollowTestOverrides,
  buildContactListUpdateTags,
  classifyContactListSnapshot,
  extractFollowPubkeys,
  publishContactListUpdate,
  selectLatestFollowListEvent,
} from "@conduit/core"

const ALICE_PUBKEY = "1".repeat(64)
const BOB_PUBKEY = "2".repeat(64)
const CAROL_PUBKEY = "3".repeat(64)

afterEach(() => {
  __resetFollowTestOverrides()
})

function contactListEvent(
  input: {
    id?: string
    createdAt?: number
    pubkey?: string
    tags?: string[][]
    content?: string
  } = {}
): NDKEvent {
  const event = new NDKEvent()
  event.id = input.id ?? "a".repeat(64)
  event.kind = 3
  event.pubkey = input.pubkey ?? ALICE_PUBKEY
  event.created_at = input.createdAt ?? 100
  event.tags = input.tags ?? []
  event.content = input.content ?? ""
  return event
}

function successfulRelays(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    relayUrl: `wss://relay-${index}.example`,
    status: "success" as const,
    eventCount: 0,
  }))
}

function configurePublisher(result: {
  events: NDKEvent[]
  relays: ReturnType<typeof successfulRelays>
}) {
  const signer = {
    user: async () => ({ pubkey: ALICE_PUBKEY }),
  } as unknown as NDKSigner
  let published: NDKEvent | null = null
  let signed = 0
  let reads = 0

  __setFollowTestOverrides({
    requireNdkConnected: async () => ({ signer }) as unknown as NDK,
    getRelayLists: async () => new Map(),
    fetchEventsFanoutDetailed: (async (_filter, options) => {
      reads += 1
      const relayUrls = options.relayUrls ?? []
      return {
        events: result.events,
        relays: result.relays.map((relay, index) => ({
          ...relay,
          relayUrl: relayUrls[index] ?? relay.relayUrl,
        })),
      }
    }) as never,
    createEvent: () => new NDKEvent(),
    signEvent: async () => {
      signed += 1
    },
    publishWithPlanner: (async (event: NDKEvent) => {
      published = event
      return {} as never
    }) as never,
    now: () => 200_000,
  })

  return {
    get published() {
      return published
    },
    get reads() {
      return reads
    },
    get signed() {
      return signed
    },
  }
}

describe("NIP-02 follow helpers", () => {
  it("extracts only valid hex pubkeys from contact-list tags", () => {
    expect(
      extractFollowPubkeys([
        ["p", "alice"],
        ["p", ALICE_PUBKEY],
        ["p", ALICE_PUBKEY.toUpperCase()],
        ["e", BOB_PUBKEY],
      ])
    ).toEqual([ALICE_PUBKEY])
  })

  it("adds follows without duplicating existing p tags", () => {
    expect(
      buildContactListUpdateTags({
        currentTags: [["p", ALICE_PUBKEY]],
        targetPubkey: BOB_PUBKEY,
        shouldFollow: true,
      })
    ).toEqual([
      ["p", ALICE_PUBKEY],
      ["p", BOB_PUBKEY, ""],
    ])

    expect(
      buildContactListUpdateTags({
        currentTags: [["p", ALICE_PUBKEY.toUpperCase()]],
        targetPubkey: ALICE_PUBKEY,
        shouldFollow: true,
      })
    ).toEqual([["p", ALICE_PUBKEY.toUpperCase()]])
  })

  it("removes the requested follow while preserving unrelated tags", () => {
    expect(
      buildContactListUpdateTags({
        currentTags: [
          ["p", ALICE_PUBKEY],
          ["p", BOB_PUBKEY],
          ["client", "Other app"],
        ],
        targetPubkey: BOB_PUBKEY,
        shouldFollow: false,
      })
    ).toEqual([
      ["p", ALICE_PUBKEY],
      ["client", "Other app"],
    ])
  })

  it("rejects invalid target pubkeys", () => {
    expect(() =>
      buildContactListUpdateTags({
        currentTags: [["p", ALICE_PUBKEY]],
        targetPubkey: "not-a-pubkey",
        shouldFollow: true,
      })
    ).toThrow("invalid target pubkey")
  })

  it("uses the NIP-01 event id tie-breaker for equal timestamps", () => {
    const selected = selectLatestFollowListEvent([
      { id: "b".repeat(64), created_at: 20 },
      { id: "a".repeat(64), created_at: 20 },
      { id: "c".repeat(64), created_at: 19 },
    ])

    expect(selected?.id).toBe("a".repeat(64))
  })

  it("requires every planned relay to complete before trusting a snapshot", () => {
    const event = contactListEvent()
    expect(
      classifyContactListSnapshot(
        { events: [event], relays: successfulRelays() },
        ALICE_PUBKEY
      )
    ).toEqual({ state: "found", event })
    expect(
      classifyContactListSnapshot(
        { events: [], relays: successfulRelays() },
        ALICE_PUBKEY
      )
    ).toEqual({ state: "confirmed_absent" })
    expect(
      classifyContactListSnapshot(
        {
          events: [event],
          relays: [
            ...successfulRelays(1),
            {
              relayUrl: "wss://partial.example",
              status: "partial",
              eventCount: 1,
            },
          ],
        },
        ALICE_PUBKEY
      )
    ).toMatchObject({ state: "unavailable" })
  })

  it("accepts a healthy quorum while still requiring declared author relays", () => {
    const event = contactListEvent()
    const result = {
      events: [event],
      relays: [
        ...successfulRelays(),
        {
          relayUrl: "wss://offline.example",
          status: "failed" as const,
          eventCount: 0,
        },
      ],
    }

    expect(
      classifyContactListSnapshot(result, ALICE_PUBKEY, {
        minimumSuccessfulRelays: 2,
      })
    ).toEqual({ state: "found", event })
    expect(
      classifyContactListSnapshot(result, ALICE_PUBKEY, {
        minimumSuccessfulRelays: 1,
        requiredRelayUrls: ["wss://offline.example"],
      })
    ).toMatchObject({ state: "unavailable" })

    expect(
      classifyContactListSnapshot(result, ALICE_PUBKEY, {
        minimumSuccessfulRelays: 2,
        requiredRelayUrls: [
          "wss://relay-0.example",
          "wss://relay-1.example",
          "wss://offline.example",
        ],
        minimumSuccessfulRequiredRelays: 2,
      })
    ).toEqual({ state: "found", event })
  })

  it("publishes a first follow after an identity write relay confirms no prior list", async () => {
    const publisher = configurePublisher({
      events: [],
      relays: successfulRelays(),
    })

    await publishContactListUpdate({
      ownerPubkey: ALICE_PUBKEY,
      targetPubkey: BOB_PUBKEY,
      shouldFollow: true,
      appId: "market",
    })

    expect(publisher.reads).toBe(2)
    expect(publisher.signed).toBe(1)
    expect(publisher.published?.content).toBe("")
    expect(publisher.published?.tags).toContainEqual(["p", BOB_PUBKEY, ""])
  })

  it("publishes a first follow with a two-relay EOSE quorum", async () => {
    const publisher = configurePublisher({
      events: [],
      relays: [
        ...successfulRelays(),
        {
          relayUrl: "wss://offline.example",
          status: "failed",
          eventCount: 0,
        },
      ],
    })

    await publishContactListUpdate({
      ownerPubkey: ALICE_PUBKEY,
      targetPubkey: BOB_PUBKEY,
      shouldFollow: true,
      appId: "market",
    })

    expect(publisher.signed).toBe(1)
    expect(publisher.published?.tags).toContainEqual(["p", BOB_PUBKEY, ""])
  })

  it("publishes after one relay completes EOSE when the remaining fanout is unavailable", async () => {
    const publisher = configurePublisher({
      events: [],
      relays: [
        ...successfulRelays(1),
        {
          relayUrl: "wss://offline.example",
          status: "failed",
          eventCount: 0,
        },
      ],
    })

    await publishContactListUpdate({
      ownerPubkey: ALICE_PUBKEY,
      targetPubkey: BOB_PUBKEY,
      shouldFollow: true,
      appId: "market",
    })

    expect(publisher.signed).toBe(1)
    expect(publisher.published?.tags).toContainEqual(["p", BOB_PUBKEY, ""])
  })

  it("does not trust an arbitrary read relay when every identity write relay fails", async () => {
    const signer = {
      user: async () => ({ pubkey: ALICE_PUBKEY }),
    } as unknown as NDKSigner
    let call = 0
    let signed = 0
    __setFollowTestOverrides({
      requireNdkConnected: async () => ({ signer }) as unknown as NDK,
      getRelayLists: async () => new Map(),
      fetchEventsFanoutDetailed: (async (_filter, options) => {
        call += 1
        const relayUrls = options.relayUrls ?? []
        if (call === 1) {
          return {
            events: [
              contactListEvent({
                id: "e".repeat(64),
                tags: [["r", "wss://identity-write.example", "write"]],
              }),
            ].map((event) => {
              event.kind = 10_002
              return event
            }),
            relays: relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
              eventCount: 0,
            })),
          }
        }
        return {
          events: [],
          relays: relayUrls.map((relayUrl) => ({
            relayUrl,
            status:
              relayUrl === "wss://identity-write.example"
                ? ("failed" as const)
                : ("success" as const),
            eventCount: 0,
          })),
        }
      }) as never,
      createEvent: () => new NDKEvent(),
      signEvent: async () => {
        signed += 1
      },
      publishWithPlanner: (async () => ({})) as never,
      now: () => 200_000,
    })

    await expect(
      publishContactListUpdate({
        ownerPubkey: ALICE_PUBKEY,
        targetPubkey: BOB_PUBKEY,
        shouldFollow: true,
        appId: "market",
      })
    ).rejects.toThrow("Could not load the complete follow list")
    expect(signed).toBe(0)
  })

  it("requires a quorum when an identity declares multiple write relays", async () => {
    const signer = {
      user: async () => ({ pubkey: ALICE_PUBKEY }),
    } as unknown as NDKSigner
    let call = 0
    let signed = 0
    __setFollowTestOverrides({
      requireNdkConnected: async () => ({ signer }) as unknown as NDK,
      getRelayLists: async () => new Map(),
      fetchEventsFanoutDetailed: (async (_filter, options) => {
        call += 1
        const relayUrls = options.relayUrls ?? []
        if (call === 1) {
          const relayList = contactListEvent({
            id: "e".repeat(64),
            tags: [
              ["r", "wss://identity-write-one.example", "write"],
              ["r", "wss://identity-write-two.example", "write"],
            ],
          })
          relayList.kind = 10_002
          return {
            events: [relayList],
            relays: relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
              eventCount: 1,
            })),
          }
        }
        return {
          events: [],
          relays: relayUrls.map((relayUrl) => ({
            relayUrl,
            status:
              relayUrl === "wss://identity-write-two.example"
                ? ("failed" as const)
                : ("success" as const),
            eventCount: 0,
          })),
        }
      }) as never,
      signEvent: async () => {
        signed += 1
      },
    })

    await expect(
      publishContactListUpdate({
        ownerPubkey: ALICE_PUBKEY,
        targetPubkey: BOB_PUBKEY,
        shouldFollow: true,
        appId: "market",
      })
    ).rejects.toThrow("Could not load the complete follow list")
    expect(signed).toBe(0)
  })

  it("fails closed when an existing NIP-65 declaration has no write relays", async () => {
    const signer = {
      user: async () => ({ pubkey: ALICE_PUBKEY }),
    } as unknown as NDKSigner
    let reads = 0
    let signed = 0
    __setFollowTestOverrides({
      requireNdkConnected: async () => ({ signer }) as unknown as NDK,
      getRelayLists: async () =>
        new Map([
          [
            ALICE_PUBKEY,
            {
              pubkey: ALICE_PUBKEY,
              readRelayUrls: ["wss://read-only.example"],
              writeRelayUrls: [],
              eventCreatedAt: 200,
              cachedAt: 200_000,
            },
          ],
        ]),
      fetchEventsFanoutDetailed: (async (_filter, options) => {
        reads += 1
        return {
          events: [],
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
          })),
        }
      }) as never,
      signEvent: async () => {
        signed += 1
      },
    })

    await expect(
      publishContactListUpdate({
        ownerPubkey: ALICE_PUBKEY,
        targetPubkey: BOB_PUBKEY,
        shouldFollow: true,
        appId: "market",
      })
    ).rejects.toThrow("Could not load the complete follow list")
    expect(reads).toBe(1)
    expect(signed).toBe(0)
  })

  it("does not replace a newer cached NIP-65 list with an older network copy", async () => {
    const signer = {
      user: async () => ({ pubkey: ALICE_PUBKEY }),
    } as unknown as NDKSigner
    let call = 0
    let contactRelayUrls: readonly string[] = []
    let publishRelayUrls: readonly string[] = []
    __setFollowTestOverrides({
      requireNdkConnected: async () => ({ signer }) as unknown as NDK,
      getRelayLists: async () =>
        new Map([
          [
            ALICE_PUBKEY,
            {
              pubkey: ALICE_PUBKEY,
              readRelayUrls: [],
              writeRelayUrls: ["wss://new-write.example"],
              eventCreatedAt: 200,
              cachedAt: 200_000,
            },
          ],
        ]),
      fetchEventsFanoutDetailed: (async (_filter, options) => {
        call += 1
        const relayUrls = options.relayUrls ?? []
        if (call === 1) {
          const older = contactListEvent({
            id: "f".repeat(64),
            createdAt: 100,
            tags: [["r", "wss://old-write.example", "write"]],
          })
          older.kind = 10_002
          return {
            events: [older],
            relays: relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
              eventCount: 1,
            })),
          }
        }
        contactRelayUrls = relayUrls
        return {
          events: [],
          relays: relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
          })),
        }
      }) as never,
      createEvent: () => new NDKEvent(),
      signEvent: async () => {},
      publishWithPlanner: (async (_event, input) => {
        publishRelayUrls = input.extraRelayUrls ?? []
        return {}
      }) as never,
      now: () => 200_000,
    })

    await publishContactListUpdate({
      ownerPubkey: ALICE_PUBKEY,
      targetPubkey: BOB_PUBKEY,
      shouldFollow: true,
      appId: "market",
    })

    expect(contactRelayUrls).toContain("wss://new-write.example")
    expect(contactRelayUrls).not.toContain("wss://old-write.example")
    expect(publishRelayUrls).toContain("wss://new-write.example")
    expect(publishRelayUrls).not.toContain("wss://old-write.example")
  })

  it("fails closed for conflicting equal-timestamp NIP-65 snapshots", async () => {
    const signer = {
      user: async () => ({ pubkey: ALICE_PUBKEY }),
    } as unknown as NDKSigner
    let reads = 0
    let signed = 0
    __setFollowTestOverrides({
      requireNdkConnected: async () => ({ signer }) as unknown as NDK,
      getRelayLists: async () =>
        new Map([
          [
            ALICE_PUBKEY,
            {
              pubkey: ALICE_PUBKEY,
              readRelayUrls: [],
              writeRelayUrls: ["wss://cached-write.example"],
              eventCreatedAt: 200,
              cachedAt: 200_000,
            },
          ],
        ]),
      fetchEventsFanoutDetailed: (async (_filter, options) => {
        reads += 1
        const conflict = contactListEvent({
          id: "0".repeat(64),
          createdAt: 200,
          tags: [["r", "wss://network-write.example", "write"]],
        })
        conflict.kind = 10_002
        return {
          events: [conflict],
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 1,
          })),
        }
      }) as never,
      signEvent: async () => {
        signed += 1
      },
    })

    await expect(
      publishContactListUpdate({
        ownerPubkey: ALICE_PUBKEY,
        targetPubkey: BOB_PUBKEY,
        shouldFollow: true,
        appId: "market",
      })
    ).rejects.toThrow("Could not load the complete follow list")
    expect(reads).toBe(1)
    expect(signed).toBe(0)
  })

  it("treats first-ever unfollow as an idempotent no-op", async () => {
    const publisher = configurePublisher({
      events: [],
      relays: successfulRelays(),
    })

    await publishContactListUpdate({
      ownerPubkey: ALICE_PUBKEY,
      targetPubkey: BOB_PUBKEY,
      shouldFollow: false,
      appId: "market",
    })

    expect(publisher.signed).toBe(0)
    expect(publisher.published).toBeNull()
  })

  it("preserves the loaded list while appending a follow", async () => {
    const existing = contactListEvent({
      createdAt: 250,
      tags: [
        ["p", CAROL_PUBKEY, "wss://carol.example", "friend"],
        ["client", "Other app", "31990:other:app", "wss://other.example"],
        ["x", "extension"],
      ],
      content: '{"legacy":"content"}',
    })
    const publisher = configurePublisher({
      events: [existing],
      relays: successfulRelays(),
    })

    await publishContactListUpdate({
      ownerPubkey: ALICE_PUBKEY,
      targetPubkey: BOB_PUBKEY,
      shouldFollow: true,
      appId: "market",
    })

    expect(publisher.published?.created_at).toBe(251)
    expect(publisher.published?.content).toBe(existing.content)
    expect(publisher.published?.tags).toContainEqual(existing.tags[0])
    expect(publisher.published?.tags).toContainEqual(existing.tags[1])
    expect(publisher.published?.tags).toContainEqual(existing.tags[2])
    expect(publisher.published?.tags).toContainEqual(["p", BOB_PUBKEY, ""])
  })

  it("retries incomplete reads without treating them as a first list", async () => {
    const partial = {
      events: [contactListEvent()],
      relays: [
        {
          relayUrl: "wss://partial.example",
          status: "partial" as const,
          eventCount: 1,
        },
      ],
    }
    const publisher = configurePublisher(partial as never)

    await expect(
      publishContactListUpdate({
        ownerPubkey: ALICE_PUBKEY,
        targetPubkey: BOB_PUBKEY,
        shouldFollow: true,
        appId: "market",
      })
    ).rejects.toThrow("Could not load the complete follow list")
    expect(publisher.reads).toBe(2)
    expect(publisher.signed).toBe(0)
  })

  it("includes a discovered NIP-65 author write relay in the contact read", async () => {
    const signer = {
      user: async () => ({ pubkey: ALICE_PUBKEY }),
    } as unknown as NDKSigner
    const seenRelayUrls: string[][] = []
    let publishRelayUrls: readonly string[] = []
    let call = 0
    __setFollowTestOverrides({
      requireNdkConnected: async () => ({ signer }) as unknown as NDK,
      getRelayLists: async () => new Map(),
      fetchEventsFanoutDetailed: (async (_filter, options) => {
        seenRelayUrls.push([...(options.relayUrls ?? [])])
        call += 1
        const relays = (options.relayUrls ?? []).map((relayUrl) => ({
          relayUrl,
          status: "success" as const,
          eventCount: 0,
        }))
        return call === 1
          ? {
              events: [
                contactListEvent({
                  id: "d".repeat(64),
                  tags: [["r", "wss://author-write.example", "write"]],
                }),
              ].map((event) => {
                event.kind = 10_002
                return event
              }),
              relays,
            }
          : { events: [], relays }
      }) as never,
      createEvent: () => new NDKEvent(),
      signEvent: async () => {},
      publishWithPlanner: (async (_event, input) => {
        publishRelayUrls = input.extraRelayUrls ?? []
        return {}
      }) as never,
      now: () => 200_000,
    })

    await publishContactListUpdate({
      ownerPubkey: ALICE_PUBKEY,
      targetPubkey: BOB_PUBKEY,
      shouldFollow: true,
      appId: "market",
    })

    expect(seenRelayUrls[1]).toContain("wss://author-write.example")
    expect(publishRelayUrls).toContain("wss://author-write.example")
  })

  it("never signs with a signer that replaced the verified session", async () => {
    const originalSigner = {
      user: async () => ({ pubkey: ALICE_PUBKEY }),
    } as unknown as NDKSigner
    const replacementSigner = {
      user: async () => ({ pubkey: BOB_PUBKEY }),
    } as unknown as NDKSigner
    const ndk = { signer: originalSigner } as unknown as NDK
    let reads = 0
    let signed = 0
    let published = 0
    __setFollowTestOverrides({
      requireNdkConnected: async () => ndk,
      getRelayLists: async () => new Map(),
      fetchEventsFanoutDetailed: (async (_filter, options) => {
        reads += 1
        if (reads === 2) ndk.signer = replacementSigner
        return {
          events: [],
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
          })),
        }
      }) as never,
      createEvent: () => new NDKEvent(),
      signEvent: async () => {
        signed += 1
      },
      publishWithPlanner: (async () => {
        published += 1
        return {} as never
      }) as never,
      now: () => 200_000,
    })

    await expect(
      publishContactListUpdate({
        ownerPubkey: ALICE_PUBKEY,
        targetPubkey: CAROL_PUBKEY,
        shouldFollow: true,
        appId: "market",
      })
    ).rejects.toThrow("Signer session changed")
    expect(signed).toBe(0)
    expect(published).toBe(0)
  })
})

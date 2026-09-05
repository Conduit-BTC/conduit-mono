import { afterEach, describe, expect, it } from "bun:test"
import NDK from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  decodeEventMarketReference,
  encodeEventMarketNaddr,
  EVENT_KINDS,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  loadOrganizerEventMarketDeliveryOutbox,
  mergeOrganizerEventMarketDeliveryState,
  publishMerchantOrganizerEventMarket,
  retryMerchantOrganizerRecord,
  saveOrganizerEventMarketDelivery,
  type MerchantOrganizerRecordDelivery,
} from "../apps/merchant/src/lib/event-market"
import { createEmptyOrganizerEventMarketForm } from "../apps/merchant/src/lib/event-market-form"

const SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(SECRET)
const OTHER_ORGANIZER = "f".repeat(64)
const REFERENCE = `30405:${ORGANIZER}:public-market`
const PUBLISH_RELAY = "wss://publish.example/events"
const CALENDAR_RELAY = "wss://calendar-only.example/events"
const PICKUP_RELAY = "wss://pickup-only.example/events"

class MemoryStorage {
  constructor(private readonly values = new Map<string, string>()) {}

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

afterEach(() => __resetEventMarketTestOverrides())

function signedCollection(dTag = "public-market") {
  return finalizeEvent(
    {
      kind: 30405,
      created_at: 1_800_000_000,
      content: "",
      tags: [["d", dTag]],
    },
    SECRET
  )
}

function expectExactSignedEvent(
  received: SignedPublicNostrEvent | null,
  expected: SignedPublicNostrEvent
): void {
  expect(received).toMatchObject({
    id: expected.id,
    pubkey: expected.pubkey,
    created_at: expected.created_at,
    kind: expected.kind,
    content: expected.content,
    sig: expected.sig,
  })
  expect(received?.tags).toEqual(expected.tags)
}

describe("merchant organizer delivery outbox", () => {
  it("includes only collection acknowledgements in the organizer share link", async () => {
    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 16)
    const end = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1_000 + 5 * 60 * 60 * 1_000
    )
      .toISOString()
      .slice(0, 16)
    __setEventMarketTestOverrides({
      getNdk: async () => new NDK(),
      signDraft: async ({ draft, createdAt }) =>
        finalizeEvent(
          {
            kind: draft.kind,
            created_at: createdAt,
            content: draft.content,
            tags: draft.tags,
          },
          SECRET
        ),
      publishWithPlanner: async (event) => {
        const relayUrl =
          event.kind === EVENT_KINDS.PRODUCT_COLLECTION
            ? PUBLISH_RELAY
            : event.kind === EVENT_KINDS.CALENDAR_TIME
              ? CALENDAR_RELAY
              : PICKUP_RELAY
        return {
          plan: {
            intent: "author_event",
            primaryRelayUrls: [relayUrl],
            broadcastRelayUrls: [],
            parkedRelayUrls: [],
          },
          attemptedRelayUrls: [relayUrl],
          successfulRelayUrls: [relayUrl],
          failedRelayUrls: [],
          relayFailureMessages: {},
        }
      },
    })

    const result = await publishMerchantOrganizerEventMarket({
      organizerPubkey: ORGANIZER,
      form: {
        ...createEmptyOrganizerEventMarketForm(),
        title: "Public market",
        summary: "Public organizer event",
        imageUrl: "https://images.example/public-market.jpg",
        eventLocation: "Public Hall",
        start,
        end,
        timezone: "America/New_York",
        pickupLocation: "Public Hall",
      },
    })

    expect(
      decodeEventMarketReference(result.naddr, [30405])?.relayHints
    ).toEqual([PUBLISH_RELAY])
  })

  it("retains an exact signed event before relay acknowledgement", () => {
    const storage = new MemoryStorage()
    const signedEvent = signedCollection()

    saveOrganizerEventMarketDelivery(
      ORGANIZER,
      REFERENCE,
      {
        record: "collection",
        acknowledgedCount: 0,
        rejectedCount: 0,
        timedOutCount: 0,
        signedEvent,
      },
      storage
    )

    expect(loadOrganizerEventMarketDeliveryOutbox(ORGANIZER, storage)).toEqual({
      [REFERENCE]: [
        expect.objectContaining({
          record: "collection",
          acknowledgedCount: 0,
          signedEvent: expect.objectContaining({ id: signedEvent.id }),
        }),
      ],
    })
    expect(
      loadOrganizerEventMarketDeliveryOutbox(OTHER_ORGANIZER, storage)
    ).toEqual({})
  })

  it("drops tampered signed events when reloading browser storage", () => {
    const storage = new MemoryStorage()
    const signedEvent = signedCollection()
    saveOrganizerEventMarketDelivery(
      ORGANIZER,
      REFERENCE,
      {
        record: "collection",
        acknowledgedCount: 0,
        rejectedCount: 1,
        timedOutCount: 0,
        signedEvent,
      },
      storage
    )

    const loaded = loadOrganizerEventMarketDeliveryOutbox(ORGANIZER, storage)
    loaded[REFERENCE]![0]!.signedEvent!.content = "tampered"
    expect(() =>
      saveOrganizerEventMarketDelivery(
        ORGANIZER,
        REFERENCE,
        loaded[REFERENCE]![0]!,
        storage
      )
    ).toThrow("Signed organizer delivery record is invalid")

    expect(
      loadOrganizerEventMarketDeliveryOutbox(ORGANIZER, storage)[REFERENCE]?.[0]
        ?.signedEvent
    ).toMatchObject({ id: signedEvent.id, content: "" })
  })

  it("rejects a signed collection stored under a different collection coordinate", () => {
    const storage = new MemoryStorage()
    const signedEvent = signedCollection()
    const mismatchedReference = `30405:${ORGANIZER}:different-market`

    expect(() =>
      saveOrganizerEventMarketDelivery(
        ORGANIZER,
        mismatchedReference,
        {
          record: "collection",
          acknowledgedCount: 0,
          rejectedCount: 0,
          timedOutCount: 1,
          signedEvent,
        },
        storage
      )
    ).toThrow("Signed organizer delivery record is invalid")
    expect(loadOrganizerEventMarketDeliveryOutbox(ORGANIZER, storage)).toEqual(
      {}
    )
  })

  it("indexes hinted delivery updates by their exact collection coordinate", () => {
    const signedEvent = signedCollection()
    const hintedReference = encodeEventMarketNaddr(REFERENCE, [
      "wss://hint.example/events",
    ])
    const pending: MerchantOrganizerRecordDelivery = {
      record: "collection",
      acknowledgedCount: 0,
      rejectedCount: 0,
      timedOutCount: 1,
      signedEvent,
    }
    const delivered: MerchantOrganizerRecordDelivery = {
      ...pending,
      acknowledgedCount: 1,
      timedOutCount: 0,
    }

    const initial = mergeOrganizerEventMarketDeliveryState(
      {},
      REFERENCE,
      pending
    )
    const updated = mergeOrganizerEventMarketDeliveryState(
      initial,
      hintedReference,
      delivered
    )

    expect(Object.keys(updated)).toEqual([REFERENCE])
    expect(updated[REFERENCE]).toEqual([delivered])
  })

  it("stops before relay I/O when the signed event cannot be stored durably", async () => {
    let publishCount = 0
    const start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 16)
    const end = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1_000 + 5 * 60 * 60 * 1_000
    )
      .toISOString()
      .slice(0, 16)
    __setEventMarketTestOverrides({
      signDraft: async ({ draft, createdAt }) =>
        finalizeEvent(
          {
            kind: draft.kind,
            created_at: createdAt,
            content: draft.content,
            tags: draft.tags,
          },
          SECRET
        ),
      publishWithPlanner: async () => {
        publishCount += 1
        throw new Error("relay publishing should not start")
      },
    })
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota unavailable")
      },
    }

    await expect(
      publishMerchantOrganizerEventMarket({
        organizerPubkey: ORGANIZER,
        form: {
          ...createEmptyOrganizerEventMarketForm(),
          title: "Public market",
          summary: "Public organizer event",
          imageUrl: "https://images.example/public-market.jpg",
          eventLocation: "Public Hall",
          start,
          end,
          timezone: "America/New_York",
          pickupLocation: "Public Hall",
        },
        onSignedEvent: (record, reference) =>
          saveOrganizerEventMarketDelivery(
            ORGANIZER,
            reference,
            record,
            storage
          ),
      })
    ).rejects.toThrow("Relay publishing was stopped")
    expect(publishCount).toBe(0)
  })

  it("rejects a new pending record at capacity without evicting retryable records", () => {
    for (const retryState of [
      { acknowledgedCount: 0, rejectedCount: 0, timedOutCount: 1 },
      { acknowledgedCount: 1, rejectedCount: 1, timedOutCount: 0 },
    ]) {
      const storage = new MemoryStorage()
      const storageKey = `conduit:merchant:event-market-delivery:v1:${ORGANIZER}`
      storage.setItem(
        storageKey,
        JSON.stringify(
          Array.from({ length: 60 }, (_, index) => ({
            reference: `30405:${ORGANIZER}:public-market-${index}`,
            delivery: {
              record: "collection",
              ...retryState,
              signedEvent: signedCollection(`public-market-${index}`),
            },
            savedAt: index,
          }))
        )
      )
      const before = storage.getItem(storageKey)
      expect(() =>
        saveOrganizerEventMarketDelivery(
          ORGANIZER,
          `30405:${ORGANIZER}:public-market-60`,
          {
            record: "collection",
            acknowledgedCount: 0,
            rejectedCount: 0,
            timedOutCount: 1,
            signedEvent: signedCollection("public-market-60"),
          },
          storage
        )
      ).toThrow("Relay publishing was stopped")

      expect(storage.getItem(storageKey)).toBe(before)
      expect(
        Object.values(
          loadOrganizerEventMarketDeliveryOutbox(ORGANIZER, storage)
        ).flat()
      ).toHaveLength(60)
      expect(
        loadOrganizerEventMarketDeliveryOutbox(ORGANIZER, storage)[
          `30405:${ORGANIZER}:public-market-60`
        ]
      ).toBeUndefined()
    }
  })

  it("retains a partially delivered exact event while trimming acknowledged history", () => {
    const storage = new MemoryStorage()
    const signedEvent = signedCollection("partial-market")
    const partialReference = `30405:${ORGANIZER}:partial-market`
    const storageKey = `conduit:merchant:event-market-delivery:v1:${ORGANIZER}`
    storage.setItem(
      storageKey,
      JSON.stringify([
        {
          reference: partialReference,
          delivery: {
            record: "collection",
            acknowledgedCount: 1,
            rejectedCount: 1,
            timedOutCount: 0,
            signedEvent,
          },
          savedAt: 0,
        },
        ...Array.from({ length: 59 }, (_, index) => ({
          reference: `30405:${ORGANIZER}:delivered-market-${index}`,
          delivery: {
            record: "collection",
            acknowledgedCount: 1,
            rejectedCount: 0,
            timedOutCount: 0,
            signedEvent: signedCollection(`delivered-market-${index}`),
          },
          savedAt: index + 1,
        })),
      ])
    )

    saveOrganizerEventMarketDelivery(
      ORGANIZER,
      `30405:${ORGANIZER}:newly-delivered-market`,
      {
        record: "collection",
        acknowledgedCount: 1,
        rejectedCount: 0,
        timedOutCount: 0,
        signedEvent: signedCollection("newly-delivered-market"),
      },
      storage
    )

    const reloaded = loadOrganizerEventMarketDeliveryOutbox(ORGANIZER, storage)
    expect(Object.values(reloaded).flat()).toHaveLength(60)
    expect(reloaded[partialReference]?.[0]).toMatchObject({
      acknowledgedCount: 1,
      rejectedCount: 1,
      timedOutCount: 0,
    })
    expectExactSignedEvent(
      reloaded[partialReference]?.[0]?.signedEvent ?? null,
      signedEvent
    )
  })

  it("reloads and retries the exact signed event without rebuilding it", async () => {
    const values = new Map<string, string>()
    const signedEvent = signedCollection()
    saveOrganizerEventMarketDelivery(
      ORGANIZER,
      REFERENCE,
      {
        record: "collection",
        acknowledgedCount: 0,
        rejectedCount: 0,
        timedOutCount: 1,
        signedEvent,
      },
      new MemoryStorage(values)
    )
    const reloaded = loadOrganizerEventMarketDeliveryOutbox(
      ORGANIZER,
      new MemoryStorage(values)
    )[REFERENCE]![0]!
    const published: SignedPublicNostrEvent[] = []
    __setEventMarketTestOverrides({
      getNdk: async () => new NDK(),
      publishWithPlanner: async (event) => {
        published.push(event.rawEvent() as SignedPublicNostrEvent)
        return {
          plan: {
            intent: "author_event",
            primaryRelayUrls: ["wss://relay.example"],
            broadcastRelayUrls: [],
            parkedRelayUrls: [],
          },
          attemptedRelayUrls: ["wss://relay.example"],
          successfulRelayUrls: ["wss://relay.example"],
          failedRelayUrls: [],
          relayFailureMessages: {},
        }
      },
      signDraft: async () => {
        throw new Error("exact retry must not resign")
      },
    })

    const retried = await retryMerchantOrganizerRecord({
      organizerPubkey: ORGANIZER,
      record: reloaded,
    })

    expectExactSignedEvent(reloaded.signedEvent, signedEvent)
    expectExactSignedEvent(retried.signedEvent, signedEvent)
    expect(published).toHaveLength(1)
    expectExactSignedEvent(published[0] ?? null, signedEvent)
  })
})

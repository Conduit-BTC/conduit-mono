import { afterEach, describe, expect, it } from "bun:test"
import NDK, { type NDKEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"

import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  EVENT_KINDS,
  publishEventMarketPickupOption,
  publishOrganizerEventMarket,
  retryEventMarketPickupOption,
  retryOrganizerEventMarketRecord,
  type EventMarketEventDraft,
  type PublishOrganizerEventMarketInput,
  type PublishWithPlannerResult,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const ORGANIZER_SECRET = new Uint8Array(32).fill(21)
const ORGANIZER_PUBKEY = getPublicKey(ORGANIZER_SECRET)
const OTHER_SECRET = new Uint8Array(32).fill(22)
const OTHER_PUBKEY = getPublicKey(OTHER_SECRET)
const START_SECONDS = 2_100_000_000
const RELAY_URL = "wss://relay.example"

function input(): PublishOrganizerEventMarketInput {
  return {
    organizerPubkey: ORGANIZER_PUBKEY,
    calendar: {
      kind: EVENT_KINDS.CALENDAR_TIME,
      dTag: "calendar",
      title: "Organizer Market",
      start: START_SECONDS,
      end: START_SECONDS + 3_600,
      location: "Public Square",
    },
    pickup: {
      dTag: "pickup",
      title: "Main entrance pickup",
      price: 0,
      currency: "USD",
      countries: ["US"],
      location: "Public Square, main entrance",
    },
    collection: {
      dTag: "market",
      title: "Organizer Market",
      eventCoordinate: `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER_PUBKEY}:calendar`,
      pickupCoordinate: `${EVENT_KINDS.SHIPPING_OPTION}:${ORGANIZER_PUBKEY}:pickup`,
      productCoordinates: [],
    },
    now: () => 1_900_000_000_000,
  }
}

function signDraft(input: {
  draft: EventMarketEventDraft
  createdAt: number
  organizerPubkey: string
}): Promise<SignedPublicNostrEvent> {
  return Promise.resolve(
    finalizeEvent(
      {
        kind: input.draft.kind,
        created_at: input.createdAt,
        tags: input.draft.tags,
        content: input.draft.content,
      },
      ORGANIZER_SECRET
    )
  )
}

function publishResult(acknowledged: boolean): PublishWithPlannerResult {
  return {
    plan: {
      intent: "author_event",
      primaryRelayUrls: [RELAY_URL],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    },
    attemptedRelayUrls: [RELAY_URL],
    successfulRelayUrls: acknowledged ? [RELAY_URL] : [],
    failedRelayUrls: acknowledged ? [] : [RELAY_URL],
    relayFailureMessages: acknowledged
      ? {}
      : { [RELAY_URL]: "relay rejected event" },
  }
}

function connectedNdk(): Promise<NDK> {
  return Promise.resolve(new NDK())
}

afterEach(() => {
  __resetEventMarketTestOverrides()
})

describe("organizer event-market publishing", () => {
  it("persists a merchant booth pickup before I/O and retries the exact event", async () => {
    const sequence: string[] = []
    let durable: SignedPublicNostrEvent | null = null
    const published: SignedPublicNostrEvent[] = []
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      signDraft: async ({ draft, createdAt, organizerPubkey }) => {
        expect(organizerPubkey).toBe(OTHER_PUBKEY)
        return finalizeEvent(
          {
            kind: draft.kind,
            created_at: createdAt,
            tags: draft.tags,
            content: draft.content,
          },
          OTHER_SECRET
        )
      },
      publishWithPlanner: async (event: NDKEvent) => {
        sequence.push("publish")
        published.push(event.rawEvent() as SignedPublicNostrEvent)
        return publishResult(true)
      },
    })

    await publishEventMarketPickupOption({
      authorPubkey: OTHER_PUBKEY,
      pickup: input().pickup!,
      onSignedEvent: async ({ signedEvent }) => {
        await Promise.resolve()
        durable = signedEvent
        sequence.push("persist")
      },
      now: () => 1_900_000_000_000,
    })
    expect(sequence).toEqual(["persist", "publish"])

    await retryEventMarketPickupOption({
      authorPubkey: OTHER_PUBKEY,
      signedEvent: durable!,
    })
    expect(published.map((event) => event.id)).toEqual([
      durable!.id,
      durable!.id,
    ])
  })

  it("publishes an organizer event without forcing an organizer pickup", async () => {
    const publishedKinds: number[] = []
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      signDraft,
      publishWithPlanner: async (event: NDKEvent) => {
        publishedKinds.push(event.kind!)
        return publishResult(true)
      },
    })
    const withoutPickup = input()
    delete withoutPickup.pickup
    delete withoutPickup.collection.pickupCoordinate

    const result = await publishOrganizerEventMarket(withoutPickup)
    expect(publishedKinds).toEqual([
      EVENT_KINDS.CALENDAR_TIME,
      EVENT_KINDS.PRODUCT_COLLECTION,
    ])
    expect(result.pickup).toBeUndefined()
  })

  it("rejects an empty pickup price before relay I/O", async () => {
    let signCalls = 0
    let publishCalls = 0
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      signDraft: async (draftInput) => {
        signCalls += 1
        return signDraft(draftInput)
      },
      publishWithPlanner: async () => {
        publishCalls += 1
        return publishResult(true)
      },
    })
    const malformed = input()
    malformed.pickup.price = "   "

    await expect(publishOrganizerEventMarket(malformed)).rejects.toThrow(
      "Pickup price is invalid"
    )
    expect(signCalls).toBe(0)
    expect(publishCalls).toBe(0)
  })

  it("rejects an active external signer whose identity does not match the organizer", async () => {
    const ndk = new NDK()
    ndk.signer = {
      user: async () => ({ pubkey: OTHER_PUBKEY }),
    } as never
    __setEventMarketTestOverrides({
      getNdk: async () => ndk,
    })

    await expect(publishOrganizerEventMarket(input())).rejects.toThrow(
      "Active signer does not match this organizer"
    )
  })

  it("rejects a signer result with an invalid signature before relay I/O", async () => {
    let publishCalls = 0
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      signDraft: async (draftInput) => {
        const signed = await signDraft(draftInput)
        return { ...signed, content: `${signed.content}tampered` }
      },
      publishWithPlanner: async () => {
        publishCalls += 1
        return publishResult(true)
      },
    })

    await expect(publishOrganizerEventMarket(input())).rejects.toThrow(
      "invalid organizer event evidence"
    )
    expect(publishCalls).toBe(0)
  })

  it("binds collection references to the organizer drafts being published", async () => {
    let publishCalls = 0
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      signDraft,
      publishWithPlanner: async () => {
        publishCalls += 1
        return publishResult(true)
      },
    })

    const mismatchedCalendar = input()
    mismatchedCalendar.collection.eventCoordinate = `${EVENT_KINDS.CALENDAR_TIME}:${ORGANIZER_PUBKEY}:unacknowledged-calendar`
    await expect(
      publishOrganizerEventMarket(mismatchedCalendar)
    ).rejects.toThrow()

    const forgedPickup = input()
    forgedPickup.collection.pickupCoordinate = `${EVENT_KINDS.SHIPPING_OPTION}:${OTHER_PUBKEY}:pickup`
    await expect(publishOrganizerEventMarket(forgedPickup)).rejects.toThrow()

    expect(publishCalls).toBe(0)
  })

  it("advances each replaceable record beyond its own observed frontier", async () => {
    const createdAtByKind = new Map<number, number>()
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      signDraft: async (draftInput) => {
        createdAtByKind.set(draftInput.draft.kind, draftInput.createdAt)
        return signDraft(draftInput)
      },
      publishWithPlanner: async () => publishResult(true),
    })

    await publishOrganizerEventMarket({
      ...input(),
      previousCreatedAtByRecord: {
        calendar: 1_900_000_100,
        pickup: 1_900_000_200,
        collection: 1_900_000_300,
      },
    })

    expect(createdAtByKind.get(EVENT_KINDS.CALENDAR_TIME)).toBe(1_900_000_101)
    expect(createdAtByKind.get(EVENT_KINDS.SHIPPING_OPTION)).toBe(1_900_000_201)
    expect(createdAtByKind.get(EVENT_KINDS.PRODUCT_COLLECTION)).toBe(
      1_900_000_301
    )
  })

  it("publishes calendar and pickup ACKs before publishing the collection", async () => {
    const publishedKinds: number[] = []
    const deliveredRecords: string[] = []
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      signDraft,
      publishWithPlanner: async (event: NDKEvent) => {
        publishedKinds.push(event.kind!)
        return publishResult(true)
      },
    })

    const result = await publishOrganizerEventMarket({
      ...input(),
      onSignedRecord: (record) => deliveredRecords.push(record.record),
    })

    expect(publishedKinds).toEqual([
      EVENT_KINDS.CALENDAR_TIME,
      EVENT_KINDS.SHIPPING_OPTION,
      EVENT_KINDS.PRODUCT_COLLECTION,
    ])
    expect(deliveredRecords).toEqual(["calendar", "pickup", "collection"])
    expect(result.calendar.delivery.acknowledgedRelayUrls).toEqual([RELAY_URL])
    expect(result.pickup.delivery.acknowledgedRelayUrls).toEqual([RELAY_URL])
    expect(result.collection.delivery.acknowledgedRelayUrls).toEqual([
      RELAY_URL,
    ])
  })

  it("aborts before collection publication when a prerequisite gets zero ACKs", async () => {
    const publishedKinds: number[] = []
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      signDraft,
      publishWithPlanner: async (event: NDKEvent) => {
        publishedKinds.push(event.kind!)
        return publishResult(event.kind === EVENT_KINDS.CALENDAR_TIME)
      },
    })

    await expect(publishOrganizerEventMarket(input())).rejects.toThrow(
      "No relay acknowledged the signed pickup event record"
    )
    expect(publishedKinds).toEqual([
      EVENT_KINDS.CALENDAR_TIME,
      EVENT_KINDS.SHIPPING_OPTION,
    ])
    expect(publishedKinds).not.toContain(EVENT_KINDS.PRODUCT_COLLECTION)
  })

  it("exposes and awaits signed intent before a generic publish failure", async () => {
    const sequence: string[] = []
    const signedRecords: Array<{
      record: "calendar" | "pickup" | "collection"
      signedEvent: SignedPublicNostrEvent
    }> = []
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      signDraft,
      publishWithPlanner: async (event: NDKEvent) => {
        sequence.push(`publish:${event.kind}`)
        throw new Error("generic transport failure")
      },
    })

    await expect(
      publishOrganizerEventMarket({
        ...input(),
        onSignedEvent: async (record) => {
          await Promise.resolve()
          signedRecords.push(record)
          sequence.push(`signed:${record.record}`)
        },
      })
    ).rejects.toThrow("generic transport failure")

    const calendar = signedRecords.find(
      (record) => record.record === "calendar"
    )
    expect(calendar).toBeDefined()
    expect(sequence.indexOf("signed:calendar")).toBeLessThan(
      sequence.indexOf(`publish:${EVENT_KINDS.CALENDAR_TIME}`)
    )

    const retried: SignedPublicNostrEvent[] = []
    __setEventMarketTestOverrides({
      publishWithPlanner: async (event: NDKEvent) => {
        retried.push(event.rawEvent() as SignedPublicNostrEvent)
        return publishResult(true)
      },
      signDraft: async () => {
        throw new Error("exact retry must not resign")
      },
    })

    await retryOrganizerEventMarketRecord({
      organizerPubkey: ORGANIZER_PUBKEY,
      signedEvent: calendar!.signedEvent,
    })
    expect(retried).toHaveLength(1)
    expect(retried[0]).toMatchObject({
      id: calendar!.signedEvent.id,
      pubkey: calendar!.signedEvent.pubkey,
      created_at: calendar!.signedEvent.created_at,
      kind: calendar!.signedEvent.kind,
      content: calendar!.signedEvent.content,
      sig: calendar!.signedEvent.sig,
    })
    expect(retried[0]?.tags).toEqual(calendar!.signedEvent.tags)
  })

  it("retries the exact signed record without rebuilding or resigning it", async () => {
    const signed = finalizeEvent(
      {
        kind: EVENT_KINDS.SHIPPING_OPTION,
        created_at: 1_900_000_000,
        tags: [
          ["d", "pickup"],
          ["title", "Main entrance pickup"],
          ["price", "0", "USD"],
          ["country", "US"],
          ["service", "pickup"],
          ["location", "Public Square, main entrance"],
        ],
        content: "",
      },
      ORGANIZER_SECRET
    )
    const published: SignedPublicNostrEvent[] = []
    __setEventMarketTestOverrides({
      getNdk: connectedNdk,
      publishWithPlanner: async (event: NDKEvent) => {
        published.push(event.rawEvent() as SignedPublicNostrEvent)
        return publishResult(true)
      },
      signDraft: async () => {
        throw new Error("retry must not resign")
      },
    })

    const result = await retryOrganizerEventMarketRecord({
      organizerPubkey: ORGANIZER_PUBKEY,
      signedEvent: signed,
    })

    expect(result.record).toBe("pickup")
    expect(result.signedEvent).toEqual(signed)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      content: signed.content,
      sig: signed.sig,
    })
    expect(published[0]?.tags).toEqual(signed.tags)
  })
})

import { describe, expect, it } from "bun:test"
import {
  buildProductListingEventDraft,
  type ProductSchema,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import type { MerchantOrganizerEventMarket } from "../apps/merchant/src/lib/event-market"
import {
  executeMerchantEventHandoffChange,
  finalizeMerchantEventHandoffChange,
  loadMerchantEventHandoffChange,
  retryMerchantEventHandoffChange,
  type MerchantEventHandoffChangeSourceRead,
} from "../apps/merchant/src/lib/merchant-event-handoff-change"
import {
  loadMerchantEventHandoffPreference,
  type MerchantEventHandoffStorage,
} from "../apps/merchant/src/lib/merchant-event-handoff-arrangement"
import { loadMerchantEventHandoffTransition } from "../apps/merchant/src/lib/merchant-event-handoff-transition"
import { applyProductFulfillmentIntentForPublication } from "../apps/merchant/src/lib/product-publishing"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const ORGANIZER = "b".repeat(64)
const COLLECTION = `30405:${ORGANIZER}:community-market`
const CALENDAR = `31923:${ORGANIZER}:calendar`
const PICKUP = `30406:${ORGANIZER}:organizer-desk`
const FIRST_PRODUCT = `30402:${MERCHANT}:coffee`
const SECOND_PRODUCT = `30402:${MERCHANT}:tea`

class MemoryStorage implements MerchantEventHandoffStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function delivery(input: {
  attempted: string[]
  successful: string[]
  failed: string[]
}): PublishWithPlannerResult {
  return {
    plan: {} as PublishWithPlannerResult["plan"],
    attemptedRelayUrls: input.attempted,
    successfulRelayUrls: input.successful,
    failedRelayUrls: input.failed,
    relayFailureMessages: {},
  }
}

function originalEvent(
  dTag: string,
  createdAt: number,
  pickup = `30406:${MERCHANT}:legacy-${dTag}`
): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: 30402,
      content: "",
      tags: [
        ["d", dTag],
        ["title", dTag],
        ["price", "1000", "SAT"],
        ["a", COLLECTION],
        ["shipping_option", pickup],
      ],
      created_at: createdAt,
    },
    MERCHANT_SECRET
  )
}

function product(
  dTag: string,
  pickup = `30406:${MERCHANT}:legacy-${dTag}`
): ProductSchema {
  return {
    id: `30402:${MERCHANT}:${dTag}`,
    pubkey: MERCHANT,
    title: dTag === "coffee" ? "Coffee" : "Tea",
    price: 1000,
    currency: "SAT",
    type: "simple",
    specifications: [],
    format: "physical",
    shippingOptionId: pickup,
    shippingOptionRefs: [{ coordinate: pickup }],
    collectionRefs: [COLLECTION],
    canonicalShippingResolved: false,
    visibility: "public",
    stock: 5,
    images: [{ url: "https://example.com/product.jpg" }],
    tags: [],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

const FIRST_SOURCE = originalEvent("coffee", 10)
const SECOND_SOURCE = originalEvent("tea", 20)

function sourceRead(input?: {
  secondEvent?: SignedPublicNostrEvent
}): MerchantEventHandoffChangeSourceRead {
  const second = input?.secondEvent ?? SECOND_SOURCE
  return {
    market: {
      state: "active",
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
      calendarCoordinate: CALENDAR,
      pickupCoordinate: PICKUP,
      pickupCoordinates: [PICKUP],
      naddr: "naddr1test",
      title: "Community market",
      calendarKind: 31923,
      start: 1_800_000_000,
      calendarCreatedAt: 1,
      calendarEventId: "a".repeat(64),
      pickupCreatedAt: 2,
      pickupEventId: "d".repeat(64),
      collectionCreatedAt: 3,
      collectionEventId: "c".repeat(64),
      productCoordinates: [FIRST_PRODUCT],
      participation: [
        {
          productCoordinate: FIRST_PRODUCT,
          eventId: FIRST_SOURCE.id,
          createdAt: FIRST_SOURCE.created_at,
          title: "Coffee",
          merchantPubkey: MERCHANT,
          fulfillmentStatus: "resolved",
          pickupCoordinate: `30406:${MERCHANT}:legacy-coffee`,
          pickupAuthorPubkey: MERCHANT,
          handoffMode: "merchant_handoff",
          handlerPubkey: MERCHANT,
          status: "accepted",
        },
        {
          productCoordinate: SECOND_PRODUCT,
          eventId: second.id,
          createdAt: second.created_at,
          title: "Tea",
          merchantPubkey: MERCHANT,
          fulfillmentStatus: "resolved",
          pickupCoordinate: `30406:${MERCHANT}:legacy-tea`,
          pickupAuthorPubkey: MERCHANT,
          handoffMode: "merchant_handoff",
          handlerPubkey: MERCHANT,
          status: "pending",
        },
      ],
      source: {},
    } as unknown as MerchantOrganizerEventMarket,
    listings: [
      {
        eventId: FIRST_SOURCE.id,
        createdAt: FIRST_SOURCE.created_at,
        product: product("coffee"),
      },
      {
        eventId: second.id,
        createdAt: second.created_at,
        product: product("tea"),
      },
    ],
  }
}

const TARGET = {
  mode: "organizer_handoff" as const,
  handlerPubkey: ORGANIZER,
  pickupCoordinate: PICKUP,
}

function signRevision(input: {
  product: ProductSchema
  dTag: string
  previousEventCreatedAt: number
  additionalProductTags: readonly (readonly string[])[]
}): SignedPublicNostrEvent {
  const canonicalProduct = applyProductFulfillmentIntentForPublication({
    product: input.product,
    merchantPubkey: MERCHANT,
    productDTag: input.dTag,
    intent: { kind: "coordinate_after_order" },
  })
  const draft = buildProductListingEventDraft({
    product: canonicalProduct,
    dTag: input.dTag,
    clientAppId: "merchant",
  })
  draft.tags.push(...input.additionalProductTags.map((tag) => [...tag]))
  return finalizeEvent(
    {
      ...draft,
      created_at: input.previousEventCreatedAt + 1,
    },
    MERCHANT_SECRET
  )
}

function sourceAfterChange(
  signedEvents: readonly SignedPublicNostrEvent[],
  accepted: boolean
): MerchantEventHandoffChangeSourceRead {
  const original = sourceRead()
  return {
    market: {
      ...original.market,
      collectionCreatedAt: 50_000,
      collectionEventId: "e".repeat(64),
      participation: original.market.participation.map((listing, index) => ({
        ...listing,
        eventId: signedEvents[index]!.id,
        createdAt: signedEvents[index]!.created_at,
        pickupCoordinate: PICKUP,
        pickupAuthorPubkey: ORGANIZER,
        handoffMode: "organizer_handoff" as const,
        handlerPubkey: ORGANIZER,
        status:
          listing.status === "accepted"
            ? accepted
              ? ("accepted" as const)
              : ("pending" as const)
            : listing.status,
      })),
    },
    listings: [
      {
        eventId: signedEvents[0]!.id,
        createdAt: signedEvents[0]!.created_at,
        product: product("coffee", PICKUP),
      },
      {
        eventId: signedEvents[1]!.id,
        createdAt: signedEvents[1]!.created_at,
        product: product("tea", PICKUP),
      },
    ],
  }
}

describe("merchant event handoff change", () => {
  it("persists two exact signatures, reports a mid-batch failure, and retries without re-signing", async () => {
    const storage = new MemoryStorage()
    const signedIds: string[] = []
    const retryIds: string[] = []
    let checkpointCalls = 0
    let organizerRequests = 0

    const result = await executeMerchantEventHandoffChange({
      merchantPubkey: MERCHANT,
      authenticatedPubkey: MERCHANT,
      source: sourceRead(),
      target: TARGET,
      storage,
      checkpointExistingOrders: async ({ affectedListings }) => {
        checkpointCalls += 1
        expect(affectedListings.map((listing) => listing.status)).toEqual([
          "accepted",
          "pending",
        ])
      },
      readCurrentSource: async () => sourceRead(),
      dependencies: {
        signAndDeliverListing: async (input) => {
          expect(input.product.collectionRefs).toEqual([COLLECTION])
          expect(input.product.shippingOptionId).toBe(PICKUP)
          const signedEvent = signRevision(input)
          signedIds.push(signedEvent.id)
          await input.persistSignedEvent(signedEvent)
          const persisted = loadMerchantEventHandoffTransition(
            MERCHANT,
            COLLECTION,
            storage
          )
          expect(
            persisted?.listings.find((listing) =>
              listing.productCoordinate.endsWith(input.dTag)
            )?.signedEvent?.id
          ).toBe(signedEvent.id)
          if (input.dTag === "tea") throw new Error("relay unavailable")
          return delivery({
            attempted: ["wss://one.example"],
            successful: ["wss://one.example"],
            failed: [],
          })
        },
      },
    })

    expect(checkpointCalls).toBe(1)
    expect(signedIds).toHaveLength(2)
    expect(result.summary).toMatchObject({
      state: "partial",
      total: 2,
      delivered: 1,
      retryNeeded: 1,
    })
    expect(result.organizerReacceptance).toEqual({
      productCoordinates: [FIRST_PRODUCT],
      state: "blocked_by_delivery",
    })
    const retainedSecondId = result.journal.listings[1]!.signedEvent!.id

    const reloaded = loadMerchantEventHandoffChange(
      MERCHANT,
      COLLECTION,
      storage
    )
    expect(reloaded?.listings[1]!.signedEvent!.id).toBe(retainedSecondId)
    const retried = await retryMerchantEventHandoffChange({
      journal: reloaded!,
      storage,
      readCurrentSource: async () => sourceRead(),
      requestOrganizerReacceptance: async ({ listings }) => {
        organizerRequests += 1
        expect(listings.map((listing) => listing.productCoordinate)).toEqual([
          FIRST_PRODUCT,
        ])
      },
      dependencies: {
        deliverSignedEvent: async (event) => {
          retryIds.push(event.id)
          return delivery({
            attempted: ["wss://two.example"],
            successful: ["wss://two.example"],
            failed: [],
          })
        },
      },
    })

    expect(retryIds).toEqual([retainedSecondId])
    expect(signedIds).toHaveLength(2)
    expect(retried.summary).toMatchObject({
      state: "complete",
      delivered: 2,
    })
    expect(retried.journal.listings[1]!.signedEvent!.id).toBe(retainedSecondId)
    expect(retried.organizerReacceptance).toEqual({
      productCoordinates: [FIRST_PRODUCT],
      state: "requested",
    })
    expect(organizerRequests).toBe(1)
  })

  it("stops before signing the next listing when an exact source revision drifts", async () => {
    const storage = new MemoryStorage()
    const changedSecond = originalEvent("tea", 21)
    let reads = 0
    let signs = 0

    const result = await executeMerchantEventHandoffChange({
      merchantPubkey: MERCHANT,
      source: sourceRead(),
      target: TARGET,
      storage,
      checkpointExistingOrders: async () => {},
      readCurrentSource: async () => {
        reads += 1
        return reads >= 4
          ? sourceRead({ secondEvent: changedSecond })
          : sourceRead()
      },
      dependencies: {
        signAndDeliverListing: async (input) => {
          signs += 1
          await input.persistSignedEvent(signRevision(input))
          return delivery({
            attempted: ["wss://one.example"],
            successful: ["wss://one.example"],
            failed: [],
          })
        },
      },
    })

    expect(signs).toBe(1)
    expect(result.stoppedReason).toBe("source_changed")
    expect(result.journal.listings.map((listing) => listing.status)).toEqual([
      "delivered",
      "awaiting_signature",
    ])
    expect(result.summary.delivered).toBe(1)
  })

  it("requires existing-order checkpoint completion before any product signing", async () => {
    const storage = new MemoryStorage()
    let signs = 0
    let reads = 0

    await expect(
      executeMerchantEventHandoffChange({
        merchantPubkey: MERCHANT,
        source: sourceRead(),
        target: TARGET,
        storage,
        checkpointExistingOrders: async () => {
          throw new Error("order checkpoint unavailable")
        },
        readCurrentSource: async () => {
          reads += 1
          return sourceRead()
        },
        dependencies: {
          signAndDeliverListing: async () => {
            signs += 1
            throw new Error("must not sign")
          },
        },
      })
    ).rejects.toThrow("order checkpoint unavailable")

    expect(signs).toBe(0)
    expect(reads).toBe(0)
    expect(
      loadMerchantEventHandoffTransition(MERCHANT, COLLECTION, storage)
    ).toBeNull()
  })

  it("keeps the journal until a fresh organizer collection accepts changed listings", async () => {
    const storage = new MemoryStorage()
    const result = await executeMerchantEventHandoffChange({
      merchantPubkey: MERCHANT,
      source: sourceRead(),
      target: TARGET,
      storage,
      checkpointExistingOrders: async () => {},
      readCurrentSource: async () => sourceRead(),
      dependencies: {
        signAndDeliverListing: async (input) => {
          const signedEvent = signRevision(input)
          await input.persistSignedEvent(signedEvent)
          return delivery({
            attempted: ["wss://one.example"],
            successful: ["wss://one.example"],
            failed: [],
          })
        },
      },
    })
    const signedEvents = result.journal.listings.map(
      (listing) => listing.signedEvent!
    )

    expect(() =>
      finalizeMerchantEventHandoffChange({
        journal: result.journal,
        current: sourceAfterChange(signedEvents, false),
        storage,
      })
    ).toThrow("Organizer acceptance is still required")
    expect(
      loadMerchantEventHandoffTransition(MERCHANT, COLLECTION, storage)
    ).not.toBeNull()

    finalizeMerchantEventHandoffChange({
      journal: result.journal,
      current: sourceAfterChange(signedEvents, true),
      storage,
      now: () => 60_000,
    })

    expect(
      loadMerchantEventHandoffTransition(MERCHANT, COLLECTION, storage)
    ).toBeNull()
    expect(
      loadMerchantEventHandoffPreference(MERCHANT, COLLECTION, storage)
    ).toMatchObject({
      mode: "organizer_handoff",
      pickupCoordinate: PICKUP,
      savedAt: 60_000,
    })
  })
})

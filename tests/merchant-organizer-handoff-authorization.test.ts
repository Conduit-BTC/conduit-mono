import { describe, expect, it } from "bun:test"
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  buildEventMarketReadyReceiptRumor,
  EVENT_KINDS,
  eventMarketReadyReceiptSchema,
  getEventMarketPickupClaimRef,
  RelayPublishDiagnosticsError,
  resolveEventMarketReceiptMerchandiseEvidence,
  type EventMarketOrganizerClaim,
  type EventMarketPrivateReadResult,
  type EventMarketResolution,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  acknowledgeOrganizerHandoff,
  eventMarketHandoffDeliveryNeedsRetry,
  loadEventMarketHandoffDeliveries,
  resolveOrganizerHandoffAckReadiness,
} from "../apps/merchant/src/lib/event-market-handoff"
import { safePickupClaimCode } from "../apps/merchant/src/components/OrganizerHandoffReceiptQueue"

const MERCHANT_SECRET = new Uint8Array(32).fill(81)
const ORGANIZER_SECRET = new Uint8Array(32).fill(82)
const WRAP_SECRET = new Uint8Array(32).fill(83)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const COLLECTION = `30405:${ORGANIZER}:market`
const CALENDAR = `31923:${ORGANIZER}:market-day`
const PICKUP = `30406:${ORGANIZER}:organizer-pickup`
const CREATED_AT = 1_700_000_000

const PRODUCT_EVENT = finalizeEvent(
  {
    kind: EVENT_KINDS.PRODUCT,
    created_at: CREATED_AT,
    tags: [
      ["d", "coffee"],
      ["title", "Fresh coffee"],
      ["price", "0", "SATS"],
      ["a", COLLECTION],
      ["shipping_option", PICKUP],
    ],
    content: "Fresh coffee",
  },
  MERCHANT_SECRET
) as SignedPublicNostrEvent
const PRODUCT = `${EVENT_KINDS.PRODUCT}:${MERCHANT}:coffee`

const RECEIPT = eventMarketReadyReceiptSchema.parse({
  version: 1,
  type: "organizer_fulfillment_receipt",
  state: "ready_for_pickup",
  claimRef: getEventMarketPickupClaimRef({
    orderId: "private-zero-cost-order",
    merchantPubkey: MERCHANT,
    organizerPubkey: ORGANIZER,
    collectionCoordinate: COLLECTION,
  }),
  merchantPubkey: MERCHANT,
  organizerPubkey: ORGANIZER,
  calendar: {
    coordinate: CALENDAR,
    eventId: "a".repeat(64),
    createdAt: CREATED_AT * 1_000,
  },
  collection: {
    coordinate: COLLECTION,
    eventId: "b".repeat(64),
    createdAt: CREATED_AT * 1_000,
  },
  option: {
    coordinate: PICKUP,
    eventId: "c".repeat(64),
    createdAt: CREATED_AT * 1_000,
  },
  items: [
    {
      product: {
        coordinate: PRODUCT,
        eventId: PRODUCT_EVENT.id,
        createdAt: PRODUCT_EVENT.created_at * 1_000,
      },
      quantity: 2,
      variants: [],
    },
  ],
  issuedAt: CREATED_AT + 10,
})

const READY_RUMOR = buildEventMarketReadyReceiptRumor(RECEIPT)
const CLAIM: EventMarketOrganizerClaim = {
  state: "ready_for_pickup",
  receipt: {
    id: READY_RUMOR.id,
    orderId: RECEIPT.claimRef,
    type: "organizer_fulfillment_receipt",
    createdAt: CREATED_AT * 1_000,
    senderPubkey: MERCHANT,
    recipientPubkey: ORGANIZER,
    rawContent: READY_RUMOR.content,
    payload: RECEIPT,
  },
}

const READ: EventMarketPrivateReadResult<EventMarketOrganizerClaim[]> = {
  data: [CLAIM],
  stale: false,
  decryptFailureCount: 0,
  inbox: {
    declarationState: "declared",
    coverage: "complete",
    readSource: "declared",
  },
}

function market(): EventMarketResolution {
  const calendar = {
    coordinate: CALENDAR,
    eventId: RECEIPT.calendar.eventId,
    authorPubkey: ORGANIZER,
    dTag: "market-day",
    kind: EVENT_KINDS.CALENDAR_TIME,
    title: "Market day",
    content: "",
    locations: ["Public hall"],
    start: CREATED_AT * 1_000,
    createdAt: RECEIPT.calendar.createdAt,
  }
  const pickup = {
    coordinate: PICKUP,
    eventId: RECEIPT.option.eventId,
    authorPubkey: ORGANIZER,
    dTag: "organizer-pickup",
    title: "Organizer pickup",
    content: "",
    price: 0,
    currency: "SATS",
    countries: ["US"],
    location: "Public hall",
    createdAt: RECEIPT.option.createdAt,
  }
  const collection = {
    coordinate: COLLECTION,
    eventId: RECEIPT.collection.eventId,
    authorPubkey: ORGANIZER,
    dTag: "market",
    title: "Market",
    content: "",
    eventCoordinates: [CALENDAR],
    pickupCoordinates: [PICKUP],
    productCoordinates: [PRODUCT],
    unsupportedReferences: [],
    createdAt: RECEIPT.collection.createdAt,
  }
  return {
    state: "active",
    reference: COLLECTION,
    organizerPubkey: ORGANIZER,
    collectionCoordinate: COLLECTION,
    calendarCoordinate: CALENDAR,
    pickupCoordinate: PICKUP,
    calendar,
    pickup,
    pickups: [pickup],
    collection,
    organizerProductCoordinates: [PRODUCT],
    acceptedProductCoordinates: [PRODUCT],
    acceptedProductEvidence: [
      {
        productCoordinate: PRODUCT,
        merchantPubkey: MERCHANT,
        eventId: PRODUCT_EVENT.id,
        createdAt: PRODUCT_EVENT.created_at * 1_000,
        shippingOptionCoordinates: [PICKUP],
        fulfillmentStatus: "resolved",
        pickupCoordinate: PICKUP,
        pickupAuthorPubkey: ORGANIZER,
        handoffMode: "organizer_handoff",
        handoffPubkey: ORGANIZER,
      },
    ],
    organizerOnlyProductCoordinates: [],
    participationRequests: [],
    participationBudget: {
      state: "within_budget",
      targetCount: 1,
      targetLimit: 64,
    },
    pickupBudget: {
      state: "within_budget",
      targetCount: 1,
      targetLimit: 64,
    },
    coverage: {
      attemptedRelayCount: 2,
      completeRelayCount: 2,
      partialRelayCount: 0,
      failedRelayCount: 0,
    },
  }
}

function coverage(overrides: Partial<EventMarketResolution["coverage"]> = {}) {
  return {
    attemptedRelayCount: 1,
    completeRelayCount: 1,
    partialRelayCount: 0,
    failedRelayCount: 0,
    ...overrides,
  }
}

function signedWrap(recipientPubkey: string): NDKEvent {
  return new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: EVENT_KINDS.GIFT_WRAP,
        created_at: CREATED_AT,
        tags: [["p", recipientPubkey]],
        content: "ciphertext",
      },
      WRAP_SECRET
    )
  )
}

function plannerResult(relays: readonly string[]): PublishWithPlannerResult {
  return {
    plan: {
      intent: "recipient_event",
      primaryRelayUrls: [...relays],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    },
    attemptedRelayUrls: [...relays],
    successfulRelayUrls: [...relays],
    failedRelayUrls: [],
    relayFailureMessages: {},
  }
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const organizerSigner = {
  user: async () => ({ pubkey: ORGANIZER }),
} as unknown as NDKSigner

describe("merchant organizer handoff authorization", () => {
  it("contains malformed pickup claim codes instead of throwing in the queue", () => {
    expect(safePickupClaimCode(RECEIPT.claimRef)).toMatch(
      /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/
    )
    expect(safePickupClaimCode("not-a-claim")).toBe("Unavailable")
    expect(safePickupClaimCode(undefined)).toBe("Unavailable")
  })

  it("uses Core-verified exact product titles and permits positive partial coverage", () => {
    const merchandise = resolveEventMarketReceiptMerchandiseEvidence({
      receipt: RECEIPT,
      events: [PRODUCT_EVENT],
      coverage: coverage({
        attemptedRelayCount: 2,
        completeRelayCount: 0,
        partialRelayCount: 1,
        failedRelayCount: 1,
      }),
    })

    expect(merchandise.items[0]?.title).toBe("Fresh coffee")
    expect(
      resolveOrganizerHandoffAckReadiness({
        claim: CLAIM,
        read: READ,
        market: market(),
        merchandise,
      })
    ).toEqual({ state: "ready" })
  })

  it("blocks malformed, missing, deleted, and stale public evidence", () => {
    const deletion = finalizeEvent(
      {
        kind: EVENT_KINDS.DELETION,
        created_at: PRODUCT_EVENT.created_at + 1,
        tags: [
          ["e", PRODUCT_EVENT.id],
          ["k", String(EVENT_KINDS.PRODUCT)],
        ],
        content: "",
      },
      MERCHANT_SECRET
    ) as SignedPublicNostrEvent
    const resolutions = [
      resolveEventMarketReceiptMerchandiseEvidence({
        receipt: RECEIPT,
        events: [{ ...PRODUCT_EVENT, sig: "0".repeat(128) }],
        coverage: coverage(),
      }),
      resolveEventMarketReceiptMerchandiseEvidence({
        receipt: RECEIPT,
        events: [],
        coverage: coverage(),
      }),
      resolveEventMarketReceiptMerchandiseEvidence({
        receipt: RECEIPT,
        events: [PRODUCT_EVENT, deletion],
        coverage: coverage(),
      }),
    ]

    expect(resolutions.map((resolution) => resolution.state)).toEqual([
      "malformed",
      "missing",
      "deleted",
    ])
    for (const merchandise of resolutions) {
      expect(
        resolveOrganizerHandoffAckReadiness({
          claim: CLAIM,
          read: READ,
          market: market(),
          merchandise,
        })
      ).toEqual({ state: "blocked", reason: "merchandise_not_verified" })
    }

    const stale = { ...market(), state: "stale" as const }
    const verified = resolveEventMarketReceiptMerchandiseEvidence({
      receipt: RECEIPT,
      events: [PRODUCT_EVENT],
      coverage: coverage(),
    })
    expect(
      resolveOrganizerHandoffAckReadiness({
        claim: CLAIM,
        read: READ,
        market: stale,
        merchandise: verified,
      })
    ).toEqual({ state: "blocked", reason: "public_graph_not_current" })

    const changedPickup = market()
    const replacementPickup = {
      ...changedPickup.pickups[0]!,
      eventId: "d".repeat(64),
      createdAt: changedPickup.pickups[0]!.createdAt + 1_000,
    }
    changedPickup.pickup = replacementPickup
    changedPickup.pickups = [replacementPickup]
    expect(
      resolveOrganizerHandoffAckReadiness({
        claim: CLAIM,
        read: READ,
        market: changedPickup,
        merchandise: verified,
      })
    ).toEqual({ state: "blocked", reason: "handoff_changed" })
  })

  it("persists a zero-ACK organizer update and retries its exact wraps", async () => {
    const storage = new MemoryStorage()
    const merchandise = resolveEventMarketReceiptMerchandiseEvidence({
      receipt: RECEIPT,
      events: [PRODUCT_EVENT],
      coverage: coverage(),
    })
    const recipientRelays = [
      "wss://merchant-primary.relay.dev",
      "wss://merchant-backup.relay.dev",
    ]
    const failed = {
      ...plannerResult(recipientRelays),
      successfulRelayUrls: [],
      failedRelayUrls: recipientRelays,
    }

    await expect(
      acknowledgeOrganizerHandoff({
        organizerPubkey: ORGANIZER,
        claim: CLAIM,
        read: READ,
        market: market(),
        merchandise,
        signer: organizerSigner,
        storage,
        transport: {
          recipientInboxRelays: recipientRelays,
          senderInboxRelays: ["wss://organizer-inbox.relay.dev"],
          giftWrapFn: (async (_rumor, recipient) =>
            signedWrap(recipient.pubkey)) as never,
          publishFn: (async () => {
            throw new RelayPublishDiagnosticsError(
              "No merchant relay acknowledged",
              failed,
              new Error("relay delivery failed")
            )
          }) as never,
        },
      })
    ).rejects.toThrow("No merchant relay acknowledged")

    const stored = loadEventMarketHandoffDeliveries(ORGANIZER, storage)[0]!
    expect(stored.record.messageType).toBe("organizer_handoff_ack")
    expect(stored.recipient).toEqual({
      status: "zero_ack",
      acknowledgedCount: 0,
      failedCount: 2,
    })
    expect(eventMarketHandoffDeliveryNeedsRetry(stored)).toBe(true)

    const publishedIds: string[] = []
    const retried = await acknowledgeOrganizerHandoff({
      organizerPubkey: ORGANIZER,
      claim: CLAIM,
      read: READ,
      market: market(),
      merchandise,
      signer: {} as never,
      storage,
      transport: {
        recipientInboxRelays: recipientRelays,
        senderInboxRelays: ["wss://organizer-inbox.relay.dev"],
        publishFn: (async (event, options) => {
          publishedIds.push(event.id)
          return plannerResult(options.exclusiveRelayUrls ?? [])
        }) as never,
      },
    })

    expect(publishedIds).toEqual([
      stored.record.signedRecipientWrap.id,
      stored.record.signedSelfWrap?.id,
    ])
    expect(retried.record).toEqual(stored.record)
    expect(eventMarketHandoffDeliveryNeedsRetry(retried)).toBe(false)
  })

  it("persists initial ACK self-copy zero and partial diagnostics", async () => {
    const merchandise = resolveEventMarketReceiptMerchandiseEvidence({
      receipt: RECEIPT,
      events: [PRODUCT_EVENT],
      coverage: coverage(),
    })
    for (const testCase of [
      {
        successfulCount: 0,
        expected: {
          status: "zero_ack" as const,
          acknowledgedCount: 0,
          failedCount: 2,
        },
      },
      {
        successfulCount: 1,
        expected: {
          status: "partial_success" as const,
          acknowledgedCount: 1,
          failedCount: 1,
        },
      },
    ]) {
      const storage = new MemoryStorage()
      const initialPublishedIds: string[] = []
      const senderRelays = [
        "wss://organizer-primary.relay.dev",
        "wss://organizer-backup.relay.dev",
      ]
      const result = await acknowledgeOrganizerHandoff({
        organizerPubkey: ORGANIZER,
        claim: CLAIM,
        read: READ,
        market: market(),
        merchandise,
        signer: organizerSigner,
        storage,
        transport: {
          recipientInboxRelays: ["wss://merchant-inbox.relay.dev"],
          senderInboxRelays: senderRelays,
          giftWrapFn: (async (_rumor, recipient) =>
            signedWrap(recipient.pubkey)) as never,
          publishFn: (async (event, options) => {
            initialPublishedIds.push(event.id)
            const relays = options.exclusiveRelayUrls ?? []
            if (options.recipientPubkeys?.[0] !== ORGANIZER) {
              return plannerResult(relays)
            }
            return {
              ...plannerResult(relays),
              successfulRelayUrls: relays.slice(0, testCase.successfulCount),
              failedRelayUrls: relays.slice(testCase.successfulCount),
            }
          }) as never,
        },
      })

      expect(result.selfCopy).toEqual(testCase.expected)
      expect(eventMarketHandoffDeliveryNeedsRetry(result)).toBe(true)
      expect(
        loadEventMarketHandoffDeliveries(ORGANIZER, storage)[0]?.selfCopy
      ).toEqual(testCase.expected)

      const retriedIds: string[] = []
      const retried = await acknowledgeOrganizerHandoff({
        organizerPubkey: ORGANIZER,
        claim: CLAIM,
        read: READ,
        market: market(),
        merchandise,
        signer: {} as never,
        storage,
        transport: {
          recipientInboxRelays: ["wss://merchant-inbox.relay.dev"],
          senderInboxRelays: senderRelays,
          publishFn: (async (event, options) => {
            retriedIds.push(event.id)
            return plannerResult(options.exclusiveRelayUrls ?? [])
          }) as never,
        },
      })
      expect(initialPublishedIds).toEqual([
        result.record.signedRecipientWrap.id,
        result.record.signedSelfWrap?.id,
      ])
      expect(retriedIds).toEqual([result.record.signedSelfWrap.id])
      expect(retried.record).toEqual(result.record)
      expect(eventMarketHandoffDeliveryNeedsRetry(retried)).toBe(false)
    }
  })
})

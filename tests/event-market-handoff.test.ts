import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"

import {
  __resetInboxRelayCache,
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  authorizeEventMarketFulfillmentRevocation,
  authorizeEventMarketHandoffAck,
  buildEventMarketFulfillmentRevocationPayload,
  buildEventMarketFulfillmentRevocationRumor,
  buildEventMarketHandoffAckPayload,
  buildEventMarketHandoffAckRumor,
  buildEventMarketReadyReceiptPayload,
  buildEventMarketReadyReceiptRumor,
  EVENT_KINDS,
  eventMarketFulfillmentRevocationSchema,
  eventMarketHandoffAckSchema,
  eventMarketReadyReceiptSchema,
  formatEventMarketPickupClaimCode,
  getEventMarketOrderCorrelationRef,
  getEventMarketPickupClaimRef,
  getEventMarketPrivateMessageList,
  resolveEventMarketReceiptMerchandiseEvidence,
  parseEventMarketFulfillmentRevocationRumor,
  parseEventMarketHandoffAckRumor,
  parseEventMarketPrivateDeliveryProgress,
  parseEventMarketPrivateDeliveryRecord,
  parseEventMarketReadyReceiptRumor,
  publishEventMarketFulfillmentRevocation,
  publishEventMarketHandoffAck,
  publishEventMarketReadyReceipt,
  readEventMarketReadyReceipts,
  RelayPublishDiagnosticsError,
  reduceEventMarketOrganizerClaims,
  resolveEventMarketHandoffAckGate,
  resolveEventMarketOrganizerInbox,
  retryEventMarketPrivateDelivery,
  validateEventMarketReadyReceipt,
  type EventMarketPrivateDeliveryRecord,
  type EventMarketReadyReceiptSchema,
  type EventMarketResolution,
  type OrderSchema,
  type ParsedEventMarketPrivateMessage,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const ORGANIZER_SECRET = new Uint8Array(32).fill(21)
const MERCHANT_SECRET = new Uint8Array(32).fill(22)
const SECOND_MERCHANT_SECRET = new Uint8Array(32).fill(24)
const WRAP_SECRET = new Uint8Array(32).fill(23)
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const SECOND_MERCHANT = getPublicKey(SECOND_MERCHANT_SECRET)
const BUYER = "3".repeat(64)
const PRODUCT = `30402:${MERCHANT}:coffee`
const CALENDAR = `31923:${ORGANIZER}:market-day`
const COLLECTION = `30405:${ORGANIZER}:market-catalog`
const PICKUP = `30406:${ORGANIZER}:market-pickup`
const CALENDAR_EVENT_ID = "b".repeat(64)
const COLLECTION_EVENT_ID = "c".repeat(64)
const PICKUP_EVENT_ID = "d".repeat(64)
const EVIDENCE_CREATED_AT = 1_700_000_000_000
const ISSUED_AT = 1_700_000_100
const PRODUCT_EVENT = finalizeEvent(
  {
    kind: EVENT_KINDS.PRODUCT,
    created_at: EVIDENCE_CREATED_AT / 1_000 + 3,
    tags: [
      ["d", "coffee"],
      ["title", "Coffee"],
      ["price", "1000", "SATS"],
      ["a", COLLECTION],
      ["shipping_option", PICKUP],
    ],
    content: "Fresh coffee",
  },
  MERCHANT_SECRET
) as SignedPublicNostrEvent
const PRODUCT_EVENT_ID = PRODUCT_EVENT.id

afterEach(() => {
  __resetCommerceTestOverrides()
})

function readyPayload(
  overrides: Partial<EventMarketReadyReceiptSchema> = {}
): EventMarketReadyReceiptSchema {
  return {
    version: 1,
    type: "organizer_fulfillment_receipt",
    state: "ready_for_pickup",
    claimRef: getEventMarketPickupClaimRef({
      orderId: "merchant-private-order",
      merchantPubkey: MERCHANT,
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    }),
    merchantPubkey: MERCHANT,
    organizerPubkey: ORGANIZER,
    calendar: {
      coordinate: CALENDAR,
      eventId: CALENDAR_EVENT_ID,
      createdAt: EVIDENCE_CREATED_AT,
    },
    collection: {
      coordinate: COLLECTION,
      eventId: COLLECTION_EVENT_ID,
      createdAt: EVIDENCE_CREATED_AT + 1_000,
    },
    option: {
      coordinate: PICKUP,
      eventId: PICKUP_EVENT_ID,
      createdAt: EVIDENCE_CREATED_AT + 2_000,
    },
    items: [
      {
        product: {
          coordinate: PRODUCT,
          eventId: PRODUCT_EVENT_ID,
          createdAt: EVIDENCE_CREATED_AT + 3_000,
        },
        quantity: 2,
        variants: [],
      },
    ],
    issuedAt: ISSUED_AT,
    ...overrides,
  }
}

function pickupOrder(): OrderSchema {
  return {
    id: "merchant-private-order",
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    items: [
      {
        productId: PRODUCT,
        format: "physical",
        fulfillment: {
          type: "pickup",
          organizerPubkey: ORGANIZER,
          product: {
            coordinate: PRODUCT,
            eventId: PRODUCT_EVENT_ID,
            createdAt: EVIDENCE_CREATED_AT + 3_000,
            merchantPubkey: MERCHANT,
          },
          calendar: readyPayload().calendar,
          collection: readyPayload().collection,
          option: {
            ...readyPayload().option,
            title: "Market pickup",
            location: "Public market hall",
          },
          handoffMode: "organizer_handoff",
          handlerPubkey: ORGANIZER,
          costSats: 0,
          sourceCost: {
            amount: 0,
            currency: "SATS",
            normalizedCurrency: "SATS",
          },
        },
        quantity: 2,
        priceAtPurchase: 1_000,
        currency: "SATS",
        shippingCostSats: 0,
        sourceShippingCost: {
          amount: 0,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
        shippingOptionId: PICKUP,
        shippingOptionDTag: "market-pickup",
      },
    ],
    subtotal: 2_000,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "included",
    createdAt: EVIDENCE_CREATED_AT + 4_000,
  }
}

function activeMarket(): EventMarketResolution {
  return {
    state: "active",
    reference: COLLECTION,
    organizerPubkey: ORGANIZER,
    collectionCoordinate: COLLECTION,
    calendarCoordinate: CALENDAR,
    pickupCoordinate: PICKUP,
    collection: {
      coordinate: COLLECTION,
      eventId: COLLECTION_EVENT_ID,
      authorPubkey: ORGANIZER,
      dTag: "market-catalog",
      title: "Market catalog",
      content: "",
      eventCoordinates: [CALENDAR],
      pickupCoordinates: [PICKUP],
      productCoordinates: [PRODUCT],
      unsupportedReferences: [],
      createdAt: EVIDENCE_CREATED_AT + 1_000,
    },
    calendar: {
      coordinate: CALENDAR,
      eventId: CALENDAR_EVENT_ID,
      authorPubkey: ORGANIZER,
      dTag: "market-day",
      kind: EVENT_KINDS.CALENDAR_TIME,
      title: "Market day",
      content: "",
      locations: ["Public market hall"],
      start: EVIDENCE_CREATED_AT - 60_000,
      end: EVIDENCE_CREATED_AT + 3_600_000,
      createdAt: EVIDENCE_CREATED_AT,
    },
    pickup: {
      coordinate: PICKUP,
      eventId: PICKUP_EVENT_ID,
      authorPubkey: ORGANIZER,
      dTag: "market-pickup",
      title: "Market pickup",
      content: "",
      price: 0,
      currency: "SATS",
      countries: ["US"],
      location: "Public market hall",
      createdAt: EVIDENCE_CREATED_AT + 2_000,
    },
    pickups: [
      {
        coordinate: PICKUP,
        eventId: PICKUP_EVENT_ID,
        authorPubkey: ORGANIZER,
        dTag: "market-pickup",
        title: "Market pickup",
        content: "",
        price: 0,
        currency: "SATS",
        countries: ["US"],
        location: "Public market hall",
        createdAt: EVIDENCE_CREATED_AT + 2_000,
      },
    ],
    organizerProductCoordinates: [PRODUCT],
    acceptedProductCoordinates: [PRODUCT],
    acceptedProductEvidence: [
      {
        productCoordinate: PRODUCT,
        eventId: PRODUCT_EVENT_ID,
        createdAt: EVIDENCE_CREATED_AT + 3_000,
        shippingOptionCoordinates: [PICKUP],
        merchantPubkey: MERCHANT,
        title: "Coffee",
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
      attemptedRelayCount: 1,
      completeRelayCount: 1,
      partialRelayCount: 0,
      failedRelayCount: 0,
    },
  }
}

function verifiedMerchandise() {
  return resolveEventMarketReceiptMerchandiseEvidence({
    receipt: readyPayload(),
    events: [PRODUCT_EVENT],
    coverage: {
      attemptedRelayCount: 1,
      completeRelayCount: 1,
      partialRelayCount: 0,
      failedRelayCount: 0,
    },
  })
}

function revocationPayload(receiptId: string) {
  const receipt = readyPayload()
  return eventMarketFulfillmentRevocationSchema.parse({
    version: 1,
    type: "organizer_fulfillment_revocation",
    state: "revoked",
    claimRef: receipt.claimRef,
    merchantPubkey: MERCHANT,
    organizerPubkey: ORGANIZER,
    calendar: receipt.calendar,
    collection: receipt.collection,
    option: receipt.option,
    readyReceiptId: receiptId,
    issuedAt: ISSUED_AT + 1,
  })
}

function ackPayload(receiptId: string) {
  const receipt = readyPayload()
  return eventMarketHandoffAckSchema.parse({
    version: 1,
    type: "organizer_handoff_ack",
    state: "handed_out",
    claimRef: receipt.claimRef,
    merchantPubkey: MERCHANT,
    organizerPubkey: ORGANIZER,
    calendar: receipt.calendar,
    collection: receipt.collection,
    option: receipt.option,
    readyReceiptId: receiptId,
    handedOutAt: ISSUED_AT + 2,
  })
}

function parsedMessage(
  rumor: NDKEvent,
  payload: ParsedEventMarketPrivateMessage["payload"]
): ParsedEventMarketPrivateMessage {
  return {
    id: rumor.id,
    orderId: payload.claimRef,
    type: payload.type,
    createdAt: (rumor.created_at ?? 0) * 1_000,
    senderPubkey: rumor.pubkey,
    recipientPubkey: rumor.tags.find((tag) => tag[0] === "p")?.[1] ?? "",
    rawContent: rumor.content,
    payload,
  } as ParsedEventMarketPrivateMessage
}

function signedWrap(recipientPubkey: string, nonce?: number): NDKEvent {
  const raw = finalizeEvent(
    {
      kind: EVENT_KINDS.GIFT_WRAP,
      created_at: ISSUED_AT,
      tags: [["p", recipientPubkey]],
      content: `ciphertext-${recipientPubkey}${nonce === undefined ? "" : `-${nonce}`}`,
    },
    WRAP_SECRET
  ) as SignedPublicNostrEvent
  return new NDKEvent(undefined, raw)
}

const merchantSigner = {
  user: async () => ({ pubkey: MERCHANT }),
} as unknown as NDKSigner

const organizerSigner = {
  user: async () => ({ pubkey: ORGANIZER }),
} as unknown as NDKSigner

function successfulDelivery(relays: readonly string[]) {
  return {
    plan: {
      intent: "recipient_event" as const,
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

function thrownPartialDelivery(relays: readonly string[]) {
  const diagnostics = {
    ...successfulDelivery(relays),
    successfulRelayUrls: relays.slice(0, 1),
    failedRelayUrls: relays.slice(1),
    relayFailureMessages: Object.fromEntries(
      relays
        .slice(1)
        .map((relayUrl) => [relayUrl, "No acknowledgement before timeout"])
    ),
  }
  return new RelayPublishDiagnosticsError(
    "Some private delivery relays did not acknowledge.",
    diagnostics,
    new Error("partial private delivery")
  )
}

function readyDeliveryRecord(): EventMarketPrivateDeliveryRecord {
  const rumor = buildEventMarketReadyReceiptRumor(readyPayload())
  return {
    messageType: "organizer_fulfillment_receipt",
    rumorId: rumor.id,
    readyReceiptId: rumor.id,
    claimRef: readyPayload().claimRef,
    senderPubkey: MERCHANT,
    recipientPubkey: ORGANIZER,
    graph: {
      calendar: readyPayload().calendar,
      collection: readyPayload().collection,
      option: readyPayload().option,
    },
    orderCorrelationRef: getEventMarketOrderCorrelationRef(pickupOrder().id),
    signedRecipientWrap: signedWrap(
      ORGANIZER
    ).rawEvent() as SignedPublicNostrEvent,
    signedSelfWrap: signedWrap(MERCHANT).rawEvent() as SignedPublicNostrEvent,
    createdAt: ISSUED_AT * 1_000,
  }
}

describe("event-market private handoff payloads", () => {
  it("derives the same opaque buyer claim and preserves collection d-tag identity", () => {
    const claim = readyPayload().claimRef
    expect(claim).toHaveLength(64)
    expect(
      getEventMarketPickupClaimRef({
        orderId: pickupOrder().id,
        merchantPubkey: MERCHANT.toUpperCase(),
        organizerPubkey: ORGANIZER.toUpperCase(),
        collectionCoordinate: `30405:${ORGANIZER.toUpperCase()}:market-catalog`,
      })
    ).toBe(claim)
    expect(
      getEventMarketPickupClaimRef({
        orderId: pickupOrder().id,
        merchantPubkey: MERCHANT,
        organizerPubkey: ORGANIZER,
        collectionCoordinate: `30405:${ORGANIZER}:Market-Catalog`,
      })
    ).not.toBe(claim)
    expect(formatEventMarketPickupClaimCode(claim)).toMatch(
      /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/
    )
  })

  it("derives a minimal receipt from the private order and current graph", () => {
    expect(
      buildEventMarketReadyReceiptPayload({
        order: pickupOrder(),
        market: activeMarket(),
        fulfillmentState: "paid",
        issuedAt: ISSUED_AT,
      })
    ).toEqual(readyPayload())
  })

  it("round-trips exact authority and rejects sensitive or free-form fields", () => {
    const payload = readyPayload()
    const rumor = buildEventMarketReadyReceiptRumor(payload)
    expect(parseEventMarketReadyReceiptRumor(rumor)).toEqual(payload)
    expect(rumor.tags).toContainEqual(["type", "organizer_fulfillment_receipt"])
    expect(rumor.tags).toContainEqual(["claim", payload.claimRef])

    for (const forbidden of [
      "note",
      "contact",
      "address",
      "invoice",
      "paymentHash",
      "preimage",
      "buyerPubkey",
    ]) {
      expect(
        eventMarketReadyReceiptSchema.safeParse({
          ...payload,
          [forbidden]: "sensitive",
        }).success
      ).toBe(false)
    }

    for (const claimRef of [
      "A".repeat(64),
      "g".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "short_token_value",
    ]) {
      expect(
        eventMarketReadyReceiptSchema.safeParse({ ...payload, claimRef })
          .success
      ).toBe(false)
      expect(
        eventMarketFulfillmentRevocationSchema.safeParse({
          ...revocationPayload(rumor.id),
          claimRef,
        }).success
      ).toBe(false)
      expect(
        eventMarketHandoffAckSchema.safeParse({
          ...ackPayload(rumor.id),
          claimRef,
        }).success
      ).toBe(false)
    }

    const malformed = parsedMessage(rumor, {
      ...payload,
      claimRef: "A".repeat(64),
    } as EventMarketReadyReceiptSchema)
    expect(
      reduceEventMarketOrganizerClaims({
        organizerPubkey: ORGANIZER,
        messages: [malformed],
      })
    ).toEqual([])
    expect(() => formatEventMarketPickupClaimCode("A".repeat(64))).toThrow(
      "invalid"
    )
    expect(() =>
      parseEventMarketPrivateDeliveryRecord({
        ...readyDeliveryRecord(),
        claimRef: "A".repeat(64),
      })
    ).toThrow("invalid")
  })

  it("parses scoped revocation and ACK while rejecting sender/recipient tampering", () => {
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const revocation = revocationPayload(readyRumor.id)
    const ack = ackPayload(readyRumor.id)
    expect(
      parseEventMarketFulfillmentRevocationRumor(
        buildEventMarketFulfillmentRevocationRumor(revocation)
      )
    ).toEqual(revocation)
    expect(
      parseEventMarketHandoffAckRumor(buildEventMarketHandoffAckRumor(ack))
    ).toEqual(ack)

    const tampered = buildEventMarketReadyReceiptRumor(readyPayload())
    tampered.pubkey = ORGANIZER
    expect(() => parseEventMarketReadyReceiptRumor(tampered)).toThrow(
      "authority"
    )
    const wrongRecipient = buildEventMarketReadyReceiptRumor(readyPayload())
    wrongRecipient.tags = wrongRecipient.tags.map((tag) =>
      tag[0] === "p" ? ["p", BUYER] : tag
    )
    expect(() => parseEventMarketReadyReceiptRumor(wrongRecipient)).toThrow(
      "authority"
    )
  })

  it("binds ready receipts to paid current organizer-handoff evidence", () => {
    expect(
      validateEventMarketReadyReceipt({
        payload: readyPayload(),
        order: pickupOrder(),
        market: activeMarket(),
        fulfillmentState: "paid",
      })
    ).toEqual(readyPayload())

    const stale = activeMarket()
    stale.state = "stale"
    expect(() =>
      validateEventMarketReadyReceipt({
        payload: readyPayload(),
        order: pickupOrder(),
        market: stale,
        fulfillmentState: "paid",
      })
    ).toThrow("not usable")

    const removed = activeMarket()
    removed.collection!.pickupCoordinates = []
    expect(() =>
      validateEventMarketReadyReceipt({
        payload: readyPayload(),
        order: pickupOrder(),
        market: removed,
        fulfillmentState: "paid",
      })
    ).toThrow("not current")

    const caseDistinct = activeMarket()
    caseDistinct.collection!.coordinate = `30405:${ORGANIZER}:Market-Catalog`
    expect(() =>
      validateEventMarketReadyReceipt({
        payload: readyPayload(),
        order: pickupOrder(),
        market: caseDistinct,
        fulfillmentState: "paid",
      })
    ).toThrow("not current")

    expect(() =>
      validateEventMarketReadyReceipt({
        payload: readyPayload({ claimRef: "0".repeat(64) }),
        order: pickupOrder(),
        market: activeMarket(),
        fulfillmentState: "paid",
      })
    ).toThrow("claim does not match")
  })

  it("allows exact positive preparation after an event ends under degradation", () => {
    const ended = activeMarket()
    ended.state = "ended"
    expect(
      validateEventMarketReadyReceipt({
        payload: readyPayload(),
        order: pickupOrder(),
        market: ended,
        fulfillmentState: "paid",
      })
    ).toEqual(readyPayload())

    ended.coverage.failedRelayCount = 1
    expect(
      validateEventMarketReadyReceipt({
        payload: readyPayload(),
        order: pickupOrder(),
        market: ended,
        fulfillmentState: "paid",
      })
    ).toEqual(readyPayload())
  })

  it("includes pickup lines only and fails closed on duplicate coordinates", () => {
    const mixed = pickupOrder()
    mixed.items.push({
      productId: `30402:${MERCHANT}:download`,
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: 500,
      currency: "SATS",
    })
    mixed.subtotal += 500
    expect(
      buildEventMarketReadyReceiptPayload({
        order: mixed,
        market: activeMarket(),
        fulfillmentState: "paid",
        issuedAt: ISSUED_AT,
      }).items
    ).toEqual(readyPayload().items)

    const duplicate = pickupOrder()
    duplicate.items.push({ ...duplicate.items[0]! })
    expect(() =>
      validateEventMarketReadyReceipt({
        payload: readyPayload(),
        order: duplicate,
        market: activeMarket(),
        fulfillmentState: "paid",
      })
    ).toThrow("Duplicate pickup product")
  })

  it("rejects zero-cost authorization when any order line is not exact pickup", () => {
    const mixedZero = pickupOrder()
    mixedZero.items[0]!.priceAtPurchase = 0
    mixedZero.items.push({
      productId: `30402:${MERCHANT}:free-download`,
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: 0,
      currency: "SATS",
    })
    mixedZero.subtotal = 0

    expect(() =>
      buildEventMarketReadyReceiptPayload({
        order: mixedZero,
        market: activeMarket(),
        fulfillmentState: "zero_cost",
        issuedAt: ISSUED_AT,
      })
    ).toThrow("zero-cost")
  })

  it("rejects all variant fields until signed product options are supported", () => {
    const payload = readyPayload({
      items: [
        {
          ...readyPayload().items[0]!,
          variants: [{ name: "Size", value: "Large" }],
        },
      ],
    })
    expect(() =>
      validateEventMarketReadyReceipt({
        payload,
        order: pickupOrder(),
        market: activeMarket(),
        fulfillmentState: "paid",
      })
    ).toThrow()
    expect(eventMarketReadyReceiptSchema.safeParse(payload).success).toBe(false)
  })
})

describe("event-market private handoff delivery", () => {
  it("persists exact signed wraps before relay I/O and reports partial ACKs", async () => {
    const calls: string[] = []
    let persisted: EventMarketPrivateDeliveryRecord | null = null
    const result = await publishEventMarketReadyReceipt({
      payload: readyPayload(),
      order: pickupOrder(),
      market: activeMarket(),
      fulfillmentState: "paid",
      signer: merchantSigner,
      persistExactWraps: async (record) => {
        calls.push("persist")
        persisted = record
      },
      transport: {
        recipientInboxRelays: ["wss://organizer.inbox.example"],
        senderInboxRelays: ["wss://merchant.inbox.example"],
        giftWrapFn: (async (_rumor, recipient) =>
          signedWrap(recipient.pubkey)) as never,
        publishFn: (async (_event, options) => {
          calls.push("publish")
          const relays = options.exclusiveRelayUrls ?? []
          if (options.recipientPubkeys?.[0] === ORGANIZER) {
            return {
              ...successfulDelivery(relays),
              successfulRelayUrls: [relays[0]!],
              failedRelayUrls: ["wss://organizer.backup.example"],
              relayFailureMessages: {
                "wss://organizer.backup.example":
                  "No acknowledgement before timeout",
              },
            }
          }
          return successfulDelivery(relays)
        }) as never,
      },
    })

    expect(calls[0]).toBe("persist")
    expect(result.deliveryRoute).toBe("declared_inbox")
    expect(result.deliveryStatus).toBe("partial_success")
    expect(result.deliveryProgress).toMatchObject({
      version: 1,
      recipientWrapId: persisted?.signedRecipientWrap.id,
      selfWrapId: persisted?.signedSelfWrap?.id,
    })
    expect(result.deliveryProgress.recipientAcknowledgedRelayRefs).toHaveLength(
      1
    )
    expect(result.deliveryProgress.selfAcknowledgedRelayRefs).toHaveLength(1)
    expect(JSON.stringify(result.deliveryProgress)).not.toContain("wss://")
    expect(persisted?.signedRecipientWrap.kind).toBe(EVENT_KINDS.GIFT_WRAP)
    expect(persisted).toMatchObject({
      rumorId: buildEventMarketReadyReceiptRumor(readyPayload()).id,
      readyReceiptId: buildEventMarketReadyReceiptRumor(readyPayload()).id,
      claimRef: readyPayload().claimRef,
      senderPubkey: MERCHANT,
      recipientPubkey: ORGANIZER,
      graph: {
        calendar: readyPayload().calendar,
        collection: readyPayload().collection,
        option: readyPayload().option,
      },
    })
    expect(Object.keys(persisted ?? {})).not.toContain("payload")
    expect(parseEventMarketPrivateDeliveryRecord(persisted)).toBe(persisted)
    expect(persisted?.orderCorrelationRef).toBe(
      getEventMarketOrderCorrelationRef(pickupOrder().id)
    )
    const revocationAuthorization =
      await authorizeEventMarketFulfillmentRevocation({
        deliveryRecord: persisted!,
        signer: merchantSigner,
        giftUnwrap: async () =>
          buildEventMarketReadyReceiptRumor(readyPayload()),
      })
    expect(
      buildEventMarketFulfillmentRevocationPayload({
        authorization: revocationAuthorization,
        issuedAt: ISSUED_AT + 1,
      })
    ).toEqual(revocationPayload(persisted!.rumorId))
  })

  it("publishes only scoped merchant revocation and organizer ACK updates", async () => {
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const claim = reduceEventMarketOrganizerClaims({
      organizerPubkey: ORGANIZER,
      messages: [parsedMessage(readyRumor, readyPayload())],
    })[0]!
    const authorization = authorizeEventMarketHandoffAck({
      claim,
      market: activeMarket(),
      merchandise: verifiedMerchandise(),
      read: {
        stale: false,
        decryptFailureCount: 0,
        inbox: {
          declarationState: "declared",
          coverage: "complete",
          readSource: "declared",
        },
      },
    })
    const ack = buildEventMarketHandoffAckPayload({
      authorization,
      handedOutAt: ISSUED_AT + 2,
    })
    expect(ack).toEqual(ackPayload(readyRumor.id))

    const persisted: EventMarketPrivateDeliveryRecord[] = []
    const transport = {
      giftWrapFn: (async (_rumor: NDKEvent, recipient: { pubkey: string }) =>
        signedWrap(recipient.pubkey)) as never,
      publishFn: (async (
        _event: NDKEvent,
        options: { exclusiveRelayUrls?: string[] }
      ) => successfulDelivery(options.exclusiveRelayUrls ?? [])) as never,
    }
    await publishEventMarketHandoffAck({
      payload: ack,
      authorization,
      signer: organizerSigner,
      persistExactWraps: (record) => persisted.push(record),
      transport: {
        ...transport,
        recipientInboxRelays: ["wss://merchant.inbox.example"],
        senderInboxRelays: ["wss://organizer.inbox.example"],
      },
    })
    const revocationAuthorization =
      await authorizeEventMarketFulfillmentRevocation({
        deliveryRecord: readyDeliveryRecord(),
        signer: merchantSigner,
        giftUnwrap: async () => readyRumor,
      })
    const revocation = buildEventMarketFulfillmentRevocationPayload({
      authorization: revocationAuthorization,
      issuedAt: ISSUED_AT + 1,
    })
    await publishEventMarketFulfillmentRevocation({
      payload: revocation,
      authorization: revocationAuthorization,
      signer: merchantSigner,
      persistExactWraps: (record) => persisted.push(record),
      transport: {
        ...transport,
        recipientInboxRelays: ["wss://organizer.inbox.example"],
        senderInboxRelays: ["wss://merchant.inbox.example"],
      },
    })
    expect(persisted.map((record) => record.messageType)).toEqual([
      "organizer_handoff_ack",
      "organizer_fulfillment_revocation",
    ])
    expect(persisted[0]).toMatchObject({
      senderPubkey: ORGANIZER,
      recipientPubkey: MERCHANT,
    })
    expect(persisted[1]).toMatchObject({
      senderPubkey: MERCHANT,
      recipientPubkey: ORGANIZER,
    })
  })

  it("requires ACK and revocation self-wraps before any recipient I/O", async () => {
    let publishCalls = 0
    const selfWrapFailureTransport = (
      senderPubkey: string,
      recipientRelay: string,
      senderRelay: string
    ) => ({
      recipientInboxRelays: [recipientRelay],
      senderInboxRelays: [senderRelay],
      giftWrapFn: (async (_rumor: NDKEvent, recipient: { pubkey: string }) => {
        if (recipient.pubkey === senderPubkey) {
          throw new Error("self-wrap signer rejected")
        }
        return signedWrap(recipient.pubkey)
      }) as never,
      publishFn: (async () => {
        publishCalls += 1
        return successfulDelivery([recipientRelay])
      }) as never,
    })

    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const claim = reduceEventMarketOrganizerClaims({
      organizerPubkey: ORGANIZER,
      messages: [parsedMessage(readyRumor, readyPayload())],
    })[0]!
    const ackAuthorization = authorizeEventMarketHandoffAck({
      claim,
      market: activeMarket(),
      merchandise: verifiedMerchandise(),
      read: {
        stale: false,
        decryptFailureCount: 0,
        inbox: {
          declarationState: "declared",
          coverage: "complete",
          readSource: "declared",
        },
      },
    })
    await expect(
      publishEventMarketHandoffAck({
        payload: buildEventMarketHandoffAckPayload({
          authorization: ackAuthorization,
          handedOutAt: ISSUED_AT + 2,
        }),
        authorization: ackAuthorization,
        signer: organizerSigner,
        persistExactWraps: async () => {
          throw new Error("missing self wrap must not persist")
        },
        transport: selfWrapFailureTransport(
          ORGANIZER,
          "wss://merchant.inbox.example",
          "wss://organizer.inbox.example"
        ),
      })
    ).rejects.toThrow("sender self-copy")

    const revocationAuthorization =
      await authorizeEventMarketFulfillmentRevocation({
        deliveryRecord: readyDeliveryRecord(),
        signer: merchantSigner,
        giftUnwrap: async () => readyRumor,
      })
    await expect(
      publishEventMarketFulfillmentRevocation({
        payload: buildEventMarketFulfillmentRevocationPayload({
          authorization: revocationAuthorization,
          issuedAt: ISSUED_AT + 1,
        }),
        authorization: revocationAuthorization,
        signer: merchantSigner,
        persistExactWraps: async () => {
          throw new Error("missing self wrap must not persist")
        },
        transport: selfWrapFailureTransport(
          MERCHANT,
          "wss://organizer.inbox.example",
          "wss://merchant.inbox.example"
        ),
      })
    ).rejects.toThrow("sender self-copy")
    expect(publishCalls).toBe(0)
  })

  it("blocks undeclared organizer delivery and signer mismatch", async () => {
    let wrapped = false
    const common = {
      payload: readyPayload(),
      order: pickupOrder(),
      market: activeMarket(),
      fulfillmentState: "paid" as const,
      persistExactWraps: async () => {},
      transport: {
        recipientInboxRelays: [] as string[],
        giftWrapFn: (async () => {
          wrapped = true
          return signedWrap(ORGANIZER)
        }) as never,
      },
    }
    await expect(
      publishEventMarketReadyReceipt({ ...common, signer: merchantSigner })
    ).rejects.toThrow("declared NIP-17 inbox")
    expect(wrapped).toBe(false)

    await expect(
      publishEventMarketReadyReceipt({
        ...common,
        signer: {
          user: async () => ({ pubkey: ORGANIZER }),
        } as unknown as NDKSigner,
        transport: {
          ...common.transport,
          recipientInboxRelays: ["wss://organizer.inbox.example"],
        },
      })
    ).rejects.toThrow("signer does not match sender")
  })

  it("retains the exact retry record before a zero-ACK failure", async () => {
    let persisted: EventMarketPrivateDeliveryRecord | null = null
    let initialProgress: ReturnType<
      typeof parseEventMarketPrivateDeliveryProgress
    > | null = null
    await expect(
      publishEventMarketReadyReceipt({
        payload: readyPayload(),
        order: pickupOrder(),
        market: activeMarket(),
        fulfillmentState: "paid",
        signer: merchantSigner,
        persistExactWraps: async (record, progress) => {
          persisted = record
          initialProgress = progress
        },
        transport: {
          recipientInboxRelays: ["wss://organizer.inbox.example"],
          senderInboxRelays: ["wss://merchant.inbox.example"],
          giftWrapFn: (async (_rumor, recipient) =>
            signedWrap(recipient.pubkey)) as never,
          publishFn: (async (_event, options) => ({
            ...successfulDelivery(options.exclusiveRelayUrls ?? []),
            successfulRelayUrls: [],
            failedRelayUrls: [...(options.exclusiveRelayUrls ?? [])],
          })) as never,
        },
      })
    ).rejects.toThrow("without a relay ACK")
    expect(persisted).not.toBeNull()
    expect(initialProgress).toEqual({
      version: 1,
      recipientWrapId: persisted!.signedRecipientWrap.id,
      selfWrapId: persisted!.signedSelfWrap.id,
      recipientAcknowledgedRelayRefs: [],
      selfAcknowledgedRelayRefs: [],
    })

    const publishedIds: string[] = []
    const retried = await retryEventMarketPrivateDelivery({
      record: persisted!,
      recipientInboxRelays: ["wss://organizer.inbox.example"],
      senderInboxRelays: ["wss://merchant.inbox.example"],
      publishFn: (async (event, options) => {
        publishedIds.push(event.id)
        return successfulDelivery(options.exclusiveRelayUrls ?? [])
      }) as never,
    })
    expect(publishedIds[0]).toBe(persisted!.signedRecipientWrap.id)
    expect(retried.selfDeliveryStatus).toBe("full_success")
    expect(retried.selfCopyError).toBeNull()
  })

  it("preserves zero and partial exact self-copy retry diagnostics", async () => {
    const record = readyDeliveryRecord()
    for (const testCase of [
      {
        successes: [] as string[],
        failures: ["wss://merchant.inbox.example"],
        status: "zero_success",
        error: "Sender self-copy received no relay ACK.",
      },
      {
        successes: ["wss://merchant-a.inbox.example"],
        failures: ["wss://merchant-b.inbox.example"],
        status: "partial_success",
        error: "Sender self-copy reached only part of its inbox relay set.",
      },
    ] as const) {
      let callCount = 0
      const result = await retryEventMarketPrivateDelivery({
        record,
        recipientInboxRelays: ["wss://organizer.inbox.example"],
        senderInboxRelays: [
          "wss://merchant-a.inbox.example",
          "wss://merchant-b.inbox.example",
        ],
        publishFn: (async (_event, options) => {
          callCount += 1
          return callCount === 1
            ? successfulDelivery(options.exclusiveRelayUrls ?? [])
            : {
                ...successfulDelivery(options.exclusiveRelayUrls ?? []),
                successfulRelayUrls: testCase.successes,
                failedRelayUrls: testCase.failures,
              }
        }) as never,
      })

      expect(result.selfDelivery?.successfulRelayUrls).toEqual(
        testCase.successes
      )
      expect(result.selfDeliveryStatus).toBe(testCase.status)
      expect(result.selfCopyError).toBe(testCase.error)
    }
  })

  it("returns recipient zero-ACK progress without promoting delivery", async () => {
    const record = readyDeliveryRecord()
    let callCount = 0
    const result = await retryEventMarketPrivateDelivery({
      record,
      recipientInboxRelays: ["wss://organizer.inbox.example"],
      senderInboxRelays: ["wss://merchant.inbox.example"],
      publishFn: (async (_event, options) => {
        callCount += 1
        return callCount === 1
          ? {
              ...successfulDelivery(options.exclusiveRelayUrls ?? []),
              successfulRelayUrls: [],
              failedRelayUrls: [...(options.exclusiveRelayUrls ?? [])],
            }
          : successfulDelivery(options.exclusiveRelayUrls ?? [])
      }) as never,
    })

    expect(result.recipientStatus).toBe("zero_success")
    expect(result.recipientDelivery?.successfulRelayUrls).toEqual([])
    expect(result.deliveryProgress.recipientAcknowledgedRelayRefs).toEqual([])
    expect(result.selfDeliveryStatus).toBe("full_success")
  })

  it("converges alternating relay ACKs without republishing exact wraps", async () => {
    const record = readyDeliveryRecord()
    const recipientRelays = [
      "wss://organizer-a.inbox.example",
      "wss://organizer-b.inbox.example",
    ]
    const selfRelays = [
      "wss://merchant-a.inbox.example",
      "wss://merchant-b.inbox.example",
    ]
    const firstWrapIds: string[] = []
    let firstCall = 0
    const first = await retryEventMarketPrivateDelivery({
      record,
      recipientInboxRelays: recipientRelays,
      senderInboxRelays: selfRelays,
      publishFn: (async (event, options) => {
        firstWrapIds.push(event.id)
        const relays = options.exclusiveRelayUrls ?? []
        const acknowledged = relays[0] ? [relays[0]] : []
        firstCall += 1
        return {
          ...successfulDelivery(relays),
          successfulRelayUrls: acknowledged,
          failedRelayUrls: relays.slice(1),
        }
      }) as never,
    })
    expect(firstCall).toBe(2)
    expect(first.recipientStatus).toBe("partial_success")
    expect(first.selfDeliveryStatus).toBe("partial_success")
    expect(first.deliveryProgress.recipientAcknowledgedRelayRefs).toHaveLength(
      1
    )
    expect(first.deliveryProgress.selfAcknowledgedRelayRefs).toHaveLength(1)
    expect(firstWrapIds).toEqual([
      record.signedRecipientWrap.id,
      record.signedSelfWrap!.id,
    ])

    const reloadedProgress = parseEventMarketPrivateDeliveryProgress(
      JSON.parse(JSON.stringify(first.deliveryProgress)),
      record
    )
    const secondTargets: string[][] = []
    const secondWrapIds: string[] = []
    const second = await retryEventMarketPrivateDelivery({
      record,
      deliveryProgress: reloadedProgress,
      recipientInboxRelays: recipientRelays,
      senderInboxRelays: selfRelays,
      publishFn: (async (event, options) => {
        secondWrapIds.push(event.id)
        secondTargets.push([...(options.exclusiveRelayUrls ?? [])])
        return successfulDelivery(options.exclusiveRelayUrls ?? [])
      }) as never,
    })
    expect(secondTargets).toEqual([[recipientRelays[1]!], [selfRelays[1]!]])
    expect(secondWrapIds).toEqual(firstWrapIds)
    expect(second.recipientStatus).toBe("full_success")
    expect(second.selfDeliveryStatus).toBe("full_success")
    expect(second.deliveryProgress.recipientAcknowledgedRelayRefs).toHaveLength(
      2
    )
    expect(second.deliveryProgress.selfAcknowledgedRelayRefs).toHaveLength(2)

    let completedCalls = 0
    const completed = await retryEventMarketPrivateDelivery({
      record,
      deliveryProgress: second.deliveryProgress,
      recipientInboxRelays: recipientRelays,
      senderInboxRelays: selfRelays,
      publishFn: (async () => {
        completedCalls += 1
        return successfulDelivery([])
      }) as never,
    })
    expect(completedCalls).toBe(0)
    expect(completed.recipientDelivery).toBeNull()
    expect(completed.selfDelivery).toBeNull()
    expect(completed.recipientStatus).toBe("full_success")
    expect(completed.selfDeliveryStatus).toBe("full_success")

    const changedRecipient = "wss://organizer-c.inbox.example"
    const changedSelf = "wss://merchant-c.inbox.example"
    const changedTargets: string[][] = []
    const changed = await retryEventMarketPrivateDelivery({
      record,
      deliveryProgress: completed.deliveryProgress,
      recipientInboxRelays: [recipientRelays[0]!, changedRecipient],
      senderInboxRelays: [selfRelays[0]!, changedSelf],
      publishFn: (async (_event, options) => {
        changedTargets.push([...(options.exclusiveRelayUrls ?? [])])
        return successfulDelivery(options.exclusiveRelayUrls ?? [])
      }) as never,
    })
    expect(changedTargets).toEqual([[changedRecipient], [changedSelf]])
    expect(
      changed.deliveryProgress.recipientAcknowledgedRelayRefs
    ).toHaveLength(3)
    expect(changed.deliveryProgress.selfAcknowledgedRelayRefs).toHaveLength(3)
    expect(JSON.stringify(changed.deliveryProgress)).not.toContain("wss://")

    let mismatchedCalls = 0
    await expect(
      retryEventMarketPrivateDelivery({
        record,
        deliveryProgress: {
          ...changed.deliveryProgress,
          recipientWrapId: "f".repeat(64),
        },
        recipientInboxRelays: recipientRelays,
        senderInboxRelays: selfRelays,
        publishFn: (async () => {
          mismatchedCalls += 1
          return successfulDelivery([])
        }) as never,
      })
    ).rejects.toThrow("progress")
    expect(mismatchedCalls).toBe(0)
  })

  it("converges thrown partial recipient and self ACKs across initial delivery and reload retries", async () => {
    const recipientRelays = [
      "wss://organizer-a.inbox.example",
      "wss://organizer-b.inbox.example",
    ]
    const selfRelays = [
      "wss://merchant-a.inbox.example",
      "wss://merchant-b.inbox.example",
    ]
    let record: EventMarketPrivateDeliveryRecord | null = null
    const initial = await publishEventMarketReadyReceipt({
      payload: readyPayload(),
      order: pickupOrder(),
      market: activeMarket(),
      fulfillmentState: "paid",
      signer: merchantSigner,
      persistExactWraps: async (persisted) => {
        record = persisted
      },
      transport: {
        recipientInboxRelays: recipientRelays,
        senderInboxRelays: selfRelays,
        giftWrapFn: (async (_rumor, recipient) =>
          signedWrap(recipient.pubkey)) as never,
        publishFn: (async (_event, options) => {
          throw thrownPartialDelivery(options.exclusiveRelayUrls ?? [])
        }) as never,
      },
    })

    expect(record).not.toBeNull()
    expect(initial.deliveryStatus).toBe("partial_success")
    expect(initial.selfDeliveryStatus).toBe("partial_success")
    expect(
      initial.deliveryProgress.recipientAcknowledgedRelayRefs
    ).toHaveLength(1)
    expect(initial.deliveryProgress.selfAcknowledgedRelayRefs).toHaveLength(1)

    const addedRecipient = "wss://organizer-c.inbox.example"
    const addedSelf = "wss://merchant-c.inbox.example"
    const retryWrapIds: string[] = []
    const retryTargets: string[][] = []
    const retried = await retryEventMarketPrivateDelivery({
      record: record!,
      deliveryProgress: parseEventMarketPrivateDeliveryProgress(
        JSON.parse(JSON.stringify(initial.deliveryProgress)),
        record!
      ),
      recipientInboxRelays: [...recipientRelays, addedRecipient],
      senderInboxRelays: [...selfRelays, addedSelf],
      publishFn: (async (event, options) => {
        retryWrapIds.push(event.id)
        retryTargets.push([...(options.exclusiveRelayUrls ?? [])])
        throw thrownPartialDelivery(options.exclusiveRelayUrls ?? [])
      }) as never,
    })

    expect(retryTargets).toEqual([
      [recipientRelays[1]!, addedRecipient],
      [selfRelays[1]!, addedSelf],
    ])
    expect(retryWrapIds).toEqual([
      record!.signedRecipientWrap.id,
      record!.signedSelfWrap.id,
    ])
    expect(retried.recipientStatus).toBe("partial_success")
    expect(retried.selfDeliveryStatus).toBe("partial_success")
    expect(
      retried.deliveryProgress.recipientAcknowledgedRelayRefs
    ).toHaveLength(2)
    expect(retried.deliveryProgress.selfAcknowledgedRelayRefs).toHaveLength(2)

    const finalTargets: string[][] = []
    const completed = await retryEventMarketPrivateDelivery({
      record: record!,
      deliveryProgress: parseEventMarketPrivateDeliveryProgress(
        JSON.parse(JSON.stringify(retried.deliveryProgress)),
        record!
      ),
      recipientInboxRelays: [...recipientRelays, addedRecipient],
      senderInboxRelays: [...selfRelays, addedSelf],
      publishFn: (async (_event, options) => {
        finalTargets.push([...(options.exclusiveRelayUrls ?? [])])
        return successfulDelivery(options.exclusiveRelayUrls ?? [])
      }) as never,
    })
    expect(finalTargets).toEqual([[addedRecipient], [addedSelf]])
    expect(completed.recipientStatus).toBe("full_success")
    expect(completed.selfDeliveryStatus).toBe("full_success")
    expect(JSON.stringify(completed.deliveryProgress)).not.toContain("wss://")
  })

  it("rejects validly signed cross-account or duplicate outer recipients before I/O", async () => {
    const record = readyDeliveryRecord()
    let publishCalls = 0
    const retry = (candidate: EventMarketPrivateDeliveryRecord) =>
      retryEventMarketPrivateDelivery({
        record: candidate,
        recipientInboxRelays: ["wss://organizer.inbox.example"],
        senderInboxRelays: ["wss://merchant.inbox.example"],
        publishFn: (async () => {
          publishCalls += 1
          return successfulDelivery(["wss://organizer.inbox.example"])
        }) as never,
      })
    const wrapWithRecipients = (recipients: string[]) =>
      finalizeEvent(
        {
          kind: EVENT_KINDS.GIFT_WRAP,
          created_at: ISSUED_AT,
          tags: recipients.map((recipient) => ["p", recipient]),
          content: "ciphertext",
        },
        WRAP_SECRET
      ) as SignedPublicNostrEvent

    await expect(
      retry({
        ...record,
        signedRecipientWrap: wrapWithRecipients([BUYER]),
      })
    ).rejects.toThrow("recipient wrap")
    await expect(
      retry({
        ...record,
        signedRecipientWrap: wrapWithRecipients([ORGANIZER, ORGANIZER]),
      })
    ).rejects.toThrow("recipient wrap")
    await expect(
      retry({
        ...record,
        signedSelfWrap: wrapWithRecipients([ORGANIZER]),
      })
    ).rejects.toThrow("self-wrap")
    expect(() =>
      parseEventMarketPrivateDeliveryRecord({
        ...record,
        signedSelfWrap: undefined,
      })
    ).toThrow("self-wrap")
    expect(publishCalls).toBe(0)
  })
})

describe("event-market organizer claim reduction", () => {
  it("dedupes exact retries and treats ACK plus revocation as conflicting", () => {
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const receipt = parsedMessage(readyRumor, readyPayload())
    const ack = parsedMessage(
      buildEventMarketHandoffAckRumor(ackPayload(readyRumor.id)),
      ackPayload(readyRumor.id)
    )
    expect(
      reduceEventMarketOrganizerClaims({
        organizerPubkey: ORGANIZER,
        messages: [receipt, receipt, ack],
      })[0]?.state
    ).toBe("handed_out")

    const revocation = parsedMessage(
      buildEventMarketFulfillmentRevocationRumor(
        revocationPayload(readyRumor.id)
      ),
      revocationPayload(readyRumor.id)
    )
    expect(
      reduceEventMarketOrganizerClaims({
        organizerPubkey: ORGANIZER,
        messages: [receipt, revocation],
      })[0]?.state
    ).toBe("revoked")
    expect(
      reduceEventMarketOrganizerClaims({
        organizerPubkey: ORGANIZER,
        messages: [receipt, ack, revocation],
      })[0]?.state
    ).toBe("conflicting")
  })

  it("fails closed on conflicting claim evidence", () => {
    const firstRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const conflictingPayload = readyPayload({
      issuedAt: ISSUED_AT + 10,
      items: [{ ...readyPayload().items[0]!, quantity: 99 }],
    })
    const secondRumor = buildEventMarketReadyReceiptRumor(conflictingPayload)
    const claims = reduceEventMarketOrganizerClaims({
      organizerPubkey: ORGANIZER,
      messages: [
        parsedMessage(firstRumor, readyPayload()),
        parsedMessage(secondRumor, conflictingPayload),
      ],
    })
    expect(claims[0]?.state).toBe("conflicting")
  })

  it("rejects multiple receipt ids but scopes equal claim refs by merchant", () => {
    const rumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const receipt = parsedMessage(rumor, readyPayload())
    const duplicateId = { ...receipt, id: "f".repeat(64) }
    const normalizedAuthorCollection = `30405:${ORGANIZER.toUpperCase()}:market-catalog`
    expect(
      reduceEventMarketOrganizerClaims({
        organizerPubkey: ORGANIZER,
        collectionCoordinate: normalizedAuthorCollection,
        messages: [receipt, duplicateId],
      })[0]?.state
    ).toBe("conflicting")
    expect(
      reduceEventMarketOrganizerClaims({
        organizerPubkey: ORGANIZER,
        collectionCoordinate: `30405:${ORGANIZER}:Market-Catalog`,
        messages: [receipt],
      })
    ).toEqual([])

    const secondPayload = readyPayload({
      merchantPubkey: SECOND_MERCHANT,
      items: [
        {
          product: {
            coordinate: `30402:${SECOND_MERCHANT}:tea`,
            eventId: "e".repeat(64),
            createdAt: EVIDENCE_CREATED_AT + 3_000,
          },
          quantity: 1,
          variants: [],
        },
      ],
    })
    const secondRumor = buildEventMarketReadyReceiptRumor(secondPayload)
    expect(
      reduceEventMarketOrganizerClaims({
        organizerPubkey: ORGANIZER,
        messages: [receipt, parsedMessage(secondRumor, secondPayload)],
      }).map((claim) => claim.state)
    ).toEqual(["ready_for_pickup", "ready_for_pickup"])
  })

  it("shows partial ready evidence but blocks irreversible handoff ACK", () => {
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const claim = reduceEventMarketOrganizerClaims({
      organizerPubkey: ORGANIZER,
      messages: [parsedMessage(readyRumor, readyPayload())],
    })[0]!
    const partialRead = {
      data: [claim],
      stale: false,
      decryptFailureCount: 0,
      inbox: {
        declarationState: "declared" as const,
        coverage: "partial" as const,
        readSource: "declared" as const,
      },
    }
    expect(claim.state).toBe("ready_for_pickup")
    expect(
      resolveEventMarketHandoffAckGate({
        claim,
        read: partialRead,
        market: activeMarket(),
        merchandise: verifiedMerchandise(),
      })
    ).toEqual({
      state: "blocked",
      reason: "incomplete_revocation_coverage",
    })
    expect(() =>
      authorizeEventMarketHandoffAck({
        claim,
        read: partialRead,
        market: activeMarket(),
        merchandise: verifiedMerchandise(),
      })
    ).toThrow("incomplete_revocation_coverage")

    const hiddenRevocation = parsedMessage(
      buildEventMarketFulfillmentRevocationRumor(
        revocationPayload(readyRumor.id)
      ),
      revocationPayload(readyRumor.id)
    )
    expect(
      reduceEventMarketOrganizerClaims({
        organizerPubkey: ORGANIZER,
        messages: [parsedMessage(readyRumor, readyPayload()), hiddenRevocation],
      })[0]?.state
    ).toBe("revoked")

    const completeRead = {
      ...partialRead,
      inbox: { ...partialRead.inbox, coverage: "complete" as const },
    }
    expect(
      authorizeEventMarketHandoffAck({
        claim,
        read: completeRead,
        market: activeMarket(),
        merchandise: verifiedMerchandise(),
      }).receiptId
    ).toBe(readyRumor.id)
  })

  it("binds ACK authority to current two-sided organizer handoff evidence", () => {
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const claim = reduceEventMarketOrganizerClaims({
      organizerPubkey: ORGANIZER,
      messages: [parsedMessage(readyRumor, readyPayload())],
    })[0]!
    const read = {
      stale: false,
      decryptFailureCount: 0,
      inbox: {
        declarationState: "declared" as const,
        coverage: "complete" as const,
        readSource: "declared" as const,
      },
    }
    const authorize = (
      market: EventMarketResolution,
      merchandise = verifiedMerchandise()
    ) => authorizeEventMarketHandoffAck({ claim, read, market, merchandise })

    const oneSided = activeMarket()
    oneSided.acceptedProductEvidence = []
    oneSided.acceptedProductCoordinates = []
    expect(() => authorize(oneSided)).toThrow("product_not_accepted")

    const changedHandler = activeMarket()
    changedHandler.acceptedProductEvidence[0] = {
      ...changedHandler.acceptedProductEvidence[0]!,
      handoffMode: "merchant_handoff",
      handoffPubkey: MERCHANT,
      pickupAuthorPubkey: MERCHANT,
    }
    expect(() => authorize(changedHandler)).toThrow("handoff_changed")

    for (const state of [
      "stale",
      "unavailable",
      "malformed",
      "conflicting",
      "deleted",
    ] as const) {
      const unusable = activeMarket()
      unusable.state = state
      expect(() => authorize(unusable)).toThrow("public_graph_not_current")
    }

    const newer = activeMarket()
    newer.calendar = {
      ...newer.calendar!,
      eventId: "1".repeat(64),
      createdAt: newer.calendar!.createdAt + 1_000,
    }
    newer.collection = {
      ...newer.collection!,
      eventId: "2".repeat(64),
      createdAt: newer.collection!.createdAt + 1_000,
      productCoordinates: [PRODUCT, `30402:${MERCHANT}:new-item`],
    }
    newer.acceptedProductEvidence[0] = {
      ...newer.acceptedProductEvidence[0]!,
      eventId: "4".repeat(64),
      createdAt: newer.acceptedProductEvidence[0]!.createdAt + 1_000,
    }
    expect(authorize(newer).receiptId).toBe(readyRumor.id)

    const changedPickup = activeMarket()
    changedPickup.pickups = [
      {
        ...changedPickup.pickups[0]!,
        eventId: "3".repeat(64),
        createdAt: changedPickup.pickups[0]!.createdAt + 1_000,
        title: "Changed pickup place or price",
      },
    ]
    changedPickup.pickup = changedPickup.pickups[0]
    expect(() => authorize(changedPickup)).toThrow("handoff_changed")

    const equalTimestampLowerId = activeMarket()
    equalTimestampLowerId.calendar = {
      ...equalTimestampLowerId.calendar!,
      eventId: "0".repeat(64),
    }
    expect(authorize(equalTimestampLowerId).receiptId).toBe(readyRumor.id)

    const equalTimestampHigherId = activeMarket()
    equalTimestampHigherId.calendar = {
      ...equalTimestampHigherId.calendar!,
      eventId: "f".repeat(64),
    }
    expect(() => authorize(equalTimestampHigherId)).toThrow(
      "public_graph_not_current"
    )
  })

  it("requires positively verified exact merchandise but permits partial sources", () => {
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const claim = reduceEventMarketOrganizerClaims({
      organizerPubkey: ORGANIZER,
      messages: [parsedMessage(readyRumor, readyPayload())],
    })[0]!
    const read = {
      stale: false,
      decryptFailureCount: 0,
      inbox: {
        declarationState: "declared" as const,
        coverage: "complete" as const,
        readSource: "declared" as const,
      },
    }
    const partialPositive = resolveEventMarketReceiptMerchandiseEvidence({
      receipt: readyPayload(),
      events: [PRODUCT_EVENT],
      coverage: {
        attemptedRelayCount: 2,
        completeRelayCount: 0,
        partialRelayCount: 1,
        failedRelayCount: 1,
      },
    })
    expect(partialPositive.state).toBe("verified")
    expect(
      authorizeEventMarketHandoffAck({
        claim,
        read,
        market: activeMarket(),
        merchandise: partialPositive,
      }).receiptId
    ).toBe(readyRumor.id)

    const missing = resolveEventMarketReceiptMerchandiseEvidence({
      receipt: readyPayload(),
      events: [],
      coverage: {
        attemptedRelayCount: 2,
        completeRelayCount: 0,
        partialRelayCount: 1,
        failedRelayCount: 1,
      },
    })
    expect(missing.state).toBe("unavailable")
    expect(() =>
      authorizeEventMarketHandoffAck({
        claim,
        read,
        market: activeMarket(),
        merchandise: missing,
      })
    ).toThrow("merchandise_not_verified")

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
    const deleted = resolveEventMarketReceiptMerchandiseEvidence({
      receipt: readyPayload(),
      events: [PRODUCT_EVENT, deletion],
      coverage: {
        attemptedRelayCount: 1,
        completeRelayCount: 1,
        partialRelayCount: 0,
        failedRelayCount: 0,
      },
    })
    expect(deleted.state).toBe("deleted")
    expect(() =>
      authorizeEventMarketHandoffAck({
        claim,
        read,
        market: activeMarket(),
        merchandise: deleted,
      })
    ).toThrow("merchandise_not_verified")
  })
})

describe("event-market organizer inbox readiness", () => {
  it("requires a current secure organizer kind-10050 declaration", async () => {
    __resetInboxRelayCache()
    const declaration = finalizeEvent(
      {
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        created_at: ISSUED_AT,
        tags: [["relay", "wss://organizer.inbox.example"]],
        content: "",
      },
      ORGANIZER_SECRET
    )
    await expect(
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: ["wss://discovery.example"],
        now: () => ISSUED_AT * 1_000,
        fetchEventsWithDiagnostics: async () => ({
          events: [new NDKEvent(undefined, declaration)],
          attemptedRelayUrls: ["wss://discovery.example"],
          successfulRelayUrls: ["wss://discovery.example"],
          failedRelayUrls: [],
        }),
      })
    ).resolves.toEqual({
      state: "ready",
      organizerPubkey: ORGANIZER,
      relayUrls: ["wss://organizer.inbox.example"],
    })

    expect(
      await resolveEventMarketOrganizerInbox("not-a-pubkey")
    ).toMatchObject({ state: "blocked", reason: "invalid_organizer" })

    __resetInboxRelayCache()
    await expect(
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: ["wss://discovery.example"],
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: ["wss://discovery.example"],
          successfulRelayUrls: ["wss://discovery.example"],
          failedRelayUrls: [],
        }),
      })
    ).resolves.toMatchObject({ state: "blocked", reason: "not_declared" })
  })

  it("reads handoff wraps from declared kind-10050 relays only", async () => {
    const declaredRelay = "wss://organizer.inbox.example"
    const compatibilityRelay = "wss://compatibility.example"
    const wrap = signedWrap(ORGANIZER)
    const seenPlans: string[][] = []
    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (_filter, options) => {
        const relays = [...(options?.relayUrls ?? [])]
        seenPlans.push(relays)
        return relays.includes(compatibilityRelay) ? [wrap] : []
      },
      giftUnwrap: async () => buildEventMarketReadyReceiptRumor(readyPayload()),
    })

    expect(
      (await getEventMarketPrivateMessageList(ORGANIZER)).messages
    ).toEqual([])
    expect(seenPlans).toEqual([[declaredRelay]])

    __setCommerceTestOverrides({
      fetchEventsFanout: async (_filter, options) => {
        const relays = [...(options?.relayUrls ?? [])]
        seenPlans.push(relays)
        return relays.includes(declaredRelay) ? [wrap] : []
      },
    })
    expect(
      (await getEventMarketPrivateMessageList(ORGANIZER)).messages.map(
        (message) => message.type
      )
    ).toEqual(["organizer_fulfillment_receipt"])
    expect(seenPlans.at(-1)).toEqual([declaredRelay])
  })

  it("blocks handoff when the inbox cap can hide a revocation", async () => {
    const declaredRelay = "wss://organizer.inbox.example"
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const hiddenRevocationRumor = buildEventMarketFulfillmentRevocationRumor(
      revocationPayload(readyRumor.id)
    )
    const relayEvents = Array.from({ length: 400 }, (_, index) =>
      signedWrap(ORGANIZER, index)
    )
    const hiddenRevocationWrap = signedWrap(ORGANIZER, 400)
    relayEvents.push(hiddenRevocationWrap)
    let requestedLimit: number | undefined

    __setCommerceTestOverrides({
      requireNdkConnected: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) => {
        requestedLimit = filter.limit
        return relayEvents.slice(0, filter.limit)
      },
      giftUnwrap: async (event) =>
        event.id === hiddenRevocationWrap.id
          ? hiddenRevocationRumor
          : readyRumor,
    })

    const read = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })

    expect(requestedLimit).toBe(400)
    expect(read.data).toHaveLength(1)
    expect(read.data[0]?.state).toBe("ready_for_pickup")
    expect(read.inbox?.coverage).toBe("partial")
    expect(
      resolveEventMarketHandoffAckGate({
        claim: read.data[0]!,
        read,
        market: activeMarket(),
        merchandise: verifiedMerchandise(),
      })
    ).toEqual({
      state: "blocked",
      reason: "incomplete_revocation_coverage",
    })
  })
})

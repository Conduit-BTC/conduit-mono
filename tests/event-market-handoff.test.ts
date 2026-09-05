import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  __resetInboxRelayCache,
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  applyE2eRelayIsolation,
  authorizeEventMarketFulfillmentRevocation,
  authorizeEventMarketHandoffAck,
  buildEventMarketFulfillmentRevocationPayload,
  buildEventMarketFulfillmentRevocationRumor,
  buildEventMarketHandoffAckPayload,
  buildEventMarketHandoffAckRumor,
  buildEventMarketReadyReceiptPayload,
  buildEventMarketReadyReceiptRumor,
  config,
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
import type { ResolveInboxDeclarationOptions } from "@conduit/core/protocol/private-message-routing"
import {
  __resetProtectedReadSigner,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type { NostrEventSigner } from "../packages/core/src/protocol/nostr-event-signer"

const ORGANIZER_SECRET = generateSecretKey()
const MERCHANT_SECRET = generateSecretKey()
const SECOND_MERCHANT_SECRET = generateSecretKey()
const WRAP_SECRET = generateSecretKey()
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
const originalConfig = structuredClone(config)

afterEach(() => {
  Object.assign(config, structuredClone(originalConfig))
  __resetInboxRelayCache()
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
})

function protectedReadSigner(secret: Uint8Array): NostrEventSigner {
  const pubkey = getPublicKey(secret)
  return {
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, secret),
  }
}

function readyPayload(
  overrides: Partial<EventMarketReadyReceiptSchema> = {}
): EventMarketReadyReceiptSchema {
  return {
    version: 1,
    type: "organizer_fulfillment_receipt",
    state: "ready_for_pickup",
    paymentConfirmed: true,
    orderReady: true,
    releaseAuthorized: true,
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

function signedWrap(
  recipientPubkey: string,
  nonce?: number,
  createdAt = ISSUED_AT
): NDKEvent {
  const raw = finalizeEvent(
    {
      kind: EVENT_KINDS.GIFT_WRAP,
      created_at: createdAt,
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
    const payload = buildEventMarketReadyReceiptPayload({
      order: pickupOrder(),
      market: activeMarket(),
      fulfillmentState: "paid",
      issuedAt: ISSUED_AT,
    })

    expect(payload).toEqual(readyPayload())
    expect(payload).toMatchObject({
      paymentConfirmed: true,
      orderReady: true,
      releaseAuthorized: true,
    })

    for (const assertion of [
      "paymentConfirmed",
      "orderReady",
      "releaseAuthorized",
    ] as const) {
      expect(
        eventMarketReadyReceiptSchema.safeParse({
          ...payload,
          [assertion]: false,
        }).success
      ).toBe(false)
      const missingAssertion = { ...payload } as Record<string, unknown>
      delete missingAssertion[assertion]
      expect(
        eventMarketReadyReceiptSchema.safeParse(missingAssertion).success
      ).toBe(false)
    }
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
        recipientInboxRelays: ["wss://organizer.inbox.relay.dev"],
        senderInboxRelays: ["wss://merchant.inbox.relay.dev"],
        giftWrapFn: (async (_rumor, recipient) =>
          signedWrap(recipient.pubkey)) as never,
        publishFn: (async (_event, options) => {
          calls.push("publish")
          const relays = options.exclusiveRelayUrls ?? []
          if (options.recipientPubkeys?.[0] === ORGANIZER) {
            return {
              ...successfulDelivery(relays),
              successfulRelayUrls: [relays[0]!],
              failedRelayUrls: ["wss://organizer.backup.relay.dev"],
              relayFailureMessages: {
                "wss://organizer.backup.relay.dev":
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
        recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
        senderInboxRelays: ["wss://organizer.inbox.relay.dev"],
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
        recipientInboxRelays: ["wss://organizer.inbox.relay.dev"],
        senderInboxRelays: ["wss://merchant.inbox.relay.dev"],
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
          "wss://merchant.inbox.relay.dev",
          "wss://organizer.inbox.relay.dev"
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
          "wss://organizer.inbox.relay.dev",
          "wss://merchant.inbox.relay.dev"
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
          recipientInboxRelays: ["wss://organizer.inbox.relay.dev"],
        },
      })
    ).rejects.toThrow("signer does not match sender")
  })

  it("tracks only the exact configured E2E loopback relay for private retries", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const otherLoopbackRelayUrl = "ws://127.0.0.1:7788"
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
    const attemptedTargets: string[][] = []

    const result = await retryEventMarketPrivateDelivery({
      record: readyDeliveryRecord(),
      recipientInboxRelays: [otherLoopbackRelayUrl, isolatedRelayUrl],
      senderInboxRelays: [isolatedRelayUrl, otherLoopbackRelayUrl],
      publishFn: (async (_event, options) => {
        const targets = [...(options.exclusiveRelayUrls ?? [])]
        attemptedTargets.push(targets)
        return successfulDelivery(targets)
      }) as never,
    })

    expect(attemptedTargets).toEqual([[isolatedRelayUrl], [isolatedRelayUrl]])
    expect(result.recipientStatus).toBe("full_success")
    expect(result.selfDeliveryStatus).toBe("full_success")
    expect(result.deliveryProgress.recipientAcknowledgedRelayRefs).toHaveLength(
      1
    )
    expect(result.deliveryProgress.selfAcknowledgedRelayRefs).toHaveLength(1)
    expect(JSON.stringify(result.deliveryProgress)).not.toContain("ws://")

    await expect(
      retryEventMarketPrivateDelivery({
        record: readyDeliveryRecord(),
        recipientInboxRelays: [otherLoopbackRelayUrl],
        senderInboxRelays: [isolatedRelayUrl],
        publishFn: (async () => successfulDelivery([])) as never,
      })
    ).rejects.toThrow("recipient inbox is not currently usable")
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
          recipientInboxRelays: ["wss://organizer.inbox.relay.dev"],
          senderInboxRelays: ["wss://merchant.inbox.relay.dev"],
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
      recipientInboxRelays: ["wss://organizer.inbox.relay.dev"],
      senderInboxRelays: ["wss://merchant.inbox.relay.dev"],
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
        failures: ["wss://merchant.inbox.relay.dev"],
        status: "zero_success",
        error: "Sender self-copy received no relay ACK.",
      },
      {
        successes: ["wss://merchant-a.inbox.relay.dev"],
        failures: ["wss://merchant-b.inbox.relay.dev"],
        status: "partial_success",
        error: "Sender self-copy reached only part of its inbox relay set.",
      },
    ] as const) {
      let callCount = 0
      const result = await retryEventMarketPrivateDelivery({
        record,
        recipientInboxRelays: ["wss://organizer.inbox.relay.dev"],
        senderInboxRelays: [
          "wss://merchant-a.inbox.relay.dev",
          "wss://merchant-b.inbox.relay.dev",
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
      recipientInboxRelays: ["wss://organizer.inbox.relay.dev"],
      senderInboxRelays: ["wss://merchant.inbox.relay.dev"],
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
      "wss://organizer-a.inbox.relay.dev",
      "wss://organizer-b.inbox.relay.dev",
    ]
    const selfRelays = [
      "wss://merchant-a.inbox.relay.dev",
      "wss://merchant-b.inbox.relay.dev",
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

    const changedRecipient = "wss://organizer-c.inbox.relay.dev"
    const changedSelf = "wss://merchant-c.inbox.relay.dev"
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
      "wss://organizer-a.inbox.relay.dev",
      "wss://organizer-b.inbox.relay.dev",
    ]
    const selfRelays = [
      "wss://merchant-a.inbox.relay.dev",
      "wss://merchant-b.inbox.relay.dev",
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

    const addedRecipient = "wss://organizer-c.inbox.relay.dev"
    const addedSelf = "wss://merchant-c.inbox.relay.dev"
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
        recipientInboxRelays: ["wss://organizer.inbox.relay.dev"],
        senderInboxRelays: ["wss://merchant.inbox.relay.dev"],
        publishFn: (async () => {
          publishCalls += 1
          return successfulDelivery(["wss://organizer.inbox.relay.dev"])
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

  it("finds no handoff authority without a valid merchant receipt", () => {
    expect(
      reduceEventMarketOrganizerClaims({
        organizerPubkey: ORGANIZER,
        collectionCoordinate: COLLECTION,
        messages: [],
      })
    ).toEqual([])
  })

  it("authorizes a found valid receipt despite incomplete inbox coverage", () => {
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const claim = reduceEventMarketOrganizerClaims({
      organizerPubkey: ORGANIZER,
      messages: [parsedMessage(readyRumor, readyPayload())],
    })[0]!
    expect(claim.state).toBe("ready_for_pickup")
    expect(
      resolveEventMarketHandoffAckGate({
        claim,
        market: activeMarket(),
        merchandise: verifiedMerchandise(),
      })
    ).toEqual({ state: "ready" })
    expect(
      authorizeEventMarketHandoffAck({
        claim,
        market: activeMarket(),
        merchandise: verifiedMerchandise(),
      }).receiptId
    ).toBe(readyRumor.id)

    const hiddenRevocation = parsedMessage(
      buildEventMarketFulfillmentRevocationRumor(
        revocationPayload(readyRumor.id)
      ),
      revocationPayload(readyRumor.id)
    )
    const revokedClaim = reduceEventMarketOrganizerClaims({
      organizerPubkey: ORGANIZER,
      messages: [parsedMessage(readyRumor, readyPayload()), hiddenRevocation],
    })[0]!
    expect(revokedClaim.state).toBe("revoked")
    expect(
      resolveEventMarketHandoffAckGate({
        claim: revokedClaim,
        market: activeMarket(),
        merchandise: verifiedMerchandise(),
      })
    ).toEqual({ state: "blocked", reason: "claim_not_ready" })
  })

  it("binds ACK authority to current two-sided organizer handoff evidence", () => {
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const claim = reduceEventMarketOrganizerClaims({
      organizerPubkey: ORGANIZER,
      messages: [parsedMessage(readyRumor, readyPayload())],
    })[0]!
    const authorize = (
      market: EventMarketResolution,
      merchandise = verifiedMerchandise()
    ) => authorizeEventMarketHandoffAck({ claim, market, merchandise })

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
        market: activeMarket(),
        merchandise: deleted,
      })
    ).toThrow("merchandise_not_verified")
  })
})

describe("event-market organizer inbox readiness", () => {
  function partialDeclarationRead(
    declarations: readonly SignedPublicNostrEvent[]
  ): ResolveInboxDeclarationOptions {
    return {
      relayUrls: ["wss://discovery.relay.dev", "wss://offline.relay.dev"],
      now: () => (ISSUED_AT + 10) * 1_000,
      freshnessMs: 0,
      fetchEventsWithDiagnostics: async (filter) => ({
        events: declarations
          .filter((event) => filter.authors?.includes(event.pubkey))
          .map((event) => new NDKEvent(undefined, event)),
        attemptedRelayUrls: [
          "wss://discovery.relay.dev",
          "wss://offline.relay.dev",
        ],
        successfulRelayUrls: ["wss://discovery.relay.dev"],
        failedRelayUrls: ["wss://offline.relay.dev"],
      }),
    }
  }

  function inboxDeclaration(
    secret: Uint8Array,
    relays: string[],
    createdAt = ISSUED_AT
  ) {
    return finalizeEvent(
      {
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        created_at: createdAt,
        tags: relays.map((relay) => ["relay", relay]),
        content: "",
      },
      secret
    )
  }

  it("retries the exact organizer and sender wraps using signed inboxes from partial discovery", async () => {
    const recipientRelay = "wss://organizer.inbox.relay.dev"
    const senderRelay = "wss://merchant.inbox.relay.dev"
    const record = readyDeliveryRecord()
    const calls: Array<{ id: string; relays: string[] }> = []
    const input = {
      record,
      inboxDeclarationOptions: partialDeclarationRead([
        inboxDeclaration(ORGANIZER_SECRET, [recipientRelay]),
        inboxDeclaration(MERCHANT_SECRET, [senderRelay]),
      ]),
      publishFn: (async (event, options) => {
        const relays = [...(options.exclusiveRelayUrls ?? [])]
        calls.push({ id: event.id, relays })
        return successfulDelivery(relays)
      }) as typeof import("@conduit/core").publishWithPlanner,
    }
    const delivered = await retryEventMarketPrivateDelivery(input)
    expect(calls).toEqual([
      { id: record.signedRecipientWrap.id, relays: [recipientRelay] },
      { id: record.signedSelfWrap!.id, relays: [senderRelay] },
    ])
    expect(delivered.recipientStatus).toBe("full_success")
    expect(delivered.selfDeliveryStatus).toBe("full_success")
    expect(delivered.selfCopyError).toBeNull()

    await retryEventMarketPrivateDelivery({
      ...input,
      deliveryProgress: delivered.deliveryProgress,
    })
    expect(calls).toHaveLength(2)
  })

  it.each([
    { relays: [], reason: "signed_empty" },
    { relays: ["https://not-an-inbox.example"], reason: "malformed" },
  ])(
    "blocks a newer signed $reason inbox even when older usable evidence remains",
    async ({ relays, reason }) => {
      const previous = inboxDeclaration(ORGANIZER_SECRET, [
        "wss://organizer.inbox.relay.dev",
      ])
      await expect(
        resolveEventMarketOrganizerInbox(
          ORGANIZER,
          partialDeclarationRead([previous])
        )
      ).resolves.toMatchObject({ state: "ready" })
      const current = inboxDeclaration(ORGANIZER_SECRET, relays, ISSUED_AT + 1)
      const options = partialDeclarationRead([previous, current])
      await expect(
        resolveEventMarketOrganizerInbox(ORGANIZER, options)
      ).resolves.toMatchObject({ state: "blocked", reason })
      let publishes = 0
      await expect(
        retryEventMarketPrivateDelivery({
          record: readyDeliveryRecord(),
          inboxDeclarationOptions: options,
          publishFn: (async () => {
            publishes += 1
            return successfulDelivery([])
          }) as never,
        })
      ).rejects.toThrow("recipient inbox is not currently usable")
      expect(publishes).toBe(0)
    }
  )

  it("keeps organizer delivery distinct from an unavailable sender self-copy", async () => {
    const recipientRelay = "wss://organizer.inbox.relay.dev"
    const calls: string[][] = []
    const delivered = await retryEventMarketPrivateDelivery({
      record: readyDeliveryRecord(),
      inboxDeclarationOptions: partialDeclarationRead([
        inboxDeclaration(ORGANIZER_SECRET, [recipientRelay]),
      ]),
      publishFn: (async (_event, options) => {
        const relays = [...(options.exclusiveRelayUrls ?? [])]
        calls.push(relays)
        return successfulDelivery(relays)
      }) as typeof import("@conduit/core").publishWithPlanner,
    })
    expect(calls).toEqual([[recipientRelay]])
    expect(delivered.recipientStatus).toBe("full_success")
    expect(delivered.selfDeliveryStatus).toBeNull()
    expect(delivered.selfCopyError).toContain("inbox is not currently usable")
  })

  it("accepts only the exact configured E2E loopback declaration", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const otherLoopbackRelayUrl = "ws://127.0.0.1:7788"
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
    const declaration = (relayUrl: string, createdAt: number) =>
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
          created_at: createdAt,
          tags: [["relay", relayUrl]],
          content: "",
        },
        ORGANIZER_SECRET
      )
    const resolve = (relayUrl: string, createdAt: number) =>
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: [isolatedRelayUrl],
        now: () => createdAt * 1_000,
        fetchEventsWithDiagnostics: async () => ({
          events: [new NDKEvent(undefined, declaration(relayUrl, createdAt))],
          attemptedRelayUrls: [isolatedRelayUrl],
          successfulRelayUrls: [isolatedRelayUrl],
          failedRelayUrls: [],
        }),
      })

    await expect(resolve(isolatedRelayUrl, ISSUED_AT)).resolves.toEqual({
      state: "ready",
      organizerPubkey: ORGANIZER,
      relayUrls: [isolatedRelayUrl],
    })

    __resetInboxRelayCache()
    await expect(
      resolve(otherLoopbackRelayUrl, ISSUED_AT + 1)
    ).resolves.toMatchObject({ state: "blocked", reason: "malformed" })
  })

  it("keeps a signed organizer inbox usable when another discovery relay fails", async () => {
    const declaration = finalizeEvent(
      {
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        created_at: ISSUED_AT,
        tags: [["relay", "wss://organizer.inbox.relay.dev"]],
        content: "",
      },
      ORGANIZER_SECRET
    )
    await expect(
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: ["wss://discovery.relay.dev", "wss://offline.relay.dev"],
        now: () => ISSUED_AT * 1_000,
        fetchEventsWithDiagnostics: async () => ({
          events: [new NDKEvent(undefined, declaration)],
          attemptedRelayUrls: [
            "wss://discovery.relay.dev",
            "wss://offline.relay.dev",
          ],
          successfulRelayUrls: ["wss://discovery.relay.dev"],
          failedRelayUrls: ["wss://offline.relay.dev"],
        }),
      })
    ).resolves.toEqual({
      state: "ready",
      organizerPubkey: ORGANIZER,
      relayUrls: ["wss://organizer.inbox.relay.dev"],
    })
  })

  it("requires a current secure organizer kind-10050 declaration", async () => {
    __resetInboxRelayCache()
    const declaration = finalizeEvent(
      {
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        created_at: ISSUED_AT,
        tags: [["relay", "wss://organizer.inbox.relay.dev"]],
        content: "",
      },
      ORGANIZER_SECRET
    )
    await expect(
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: ["wss://discovery.relay.dev"],
        now: () => ISSUED_AT * 1_000,
        fetchEventsWithDiagnostics: async () => ({
          events: [new NDKEvent(undefined, declaration)],
          attemptedRelayUrls: ["wss://discovery.relay.dev"],
          successfulRelayUrls: ["wss://discovery.relay.dev"],
          failedRelayUrls: [],
        }),
      })
    ).resolves.toEqual({
      state: "ready",
      organizerPubkey: ORGANIZER,
      relayUrls: ["wss://organizer.inbox.relay.dev"],
    })

    expect(
      await resolveEventMarketOrganizerInbox("not-a-pubkey")
    ).toMatchObject({ state: "blocked", reason: "invalid_organizer" })

    __resetInboxRelayCache()
    await expect(
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: ["wss://discovery.relay.dev"],
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: ["wss://discovery.relay.dev"],
          successfulRelayUrls: ["wss://discovery.relay.dev"],
          failedRelayUrls: [],
        }),
      })
    ).resolves.toMatchObject({ state: "blocked", reason: "not_declared" })
  })

  it("reads handoff wraps from declared kind-10050 relays only", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const compatibilityRelay = "wss://compatibility.relay.dev"
    const wrap = signedWrap(ORGANIZER)
    const seenPlans: string[][] = []
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
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

  it("reads handoff wraps only from the exact configured E2E loopback", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const otherLoopbackRelayUrl = "ws://127.0.0.1:7788"
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
    const wrap = signedWrap(ORGANIZER)
    const seenPlans: string[][] = []
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [
        otherLoopbackRelayUrl,
        isolatedRelayUrl,
      ],
      fetchEventsFanout: async (_filter, options) => {
        const relays = [...(options?.relayUrls ?? [])]
        seenPlans.push(relays)
        return relays.includes(isolatedRelayUrl) ? [wrap] : []
      },
      giftUnwrap: async () => buildEventMarketReadyReceiptRumor(readyPayload()),
    })

    const exact = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(exact.messages.map((message) => message.type)).toEqual([
      "organizer_fulfillment_receipt",
    ])
    expect(exact.inbox).toMatchObject({
      declarationState: "declared",
      coverage: "complete",
      readSource: "declared",
    })
    expect(seenPlans).toEqual([[isolatedRelayUrl]])

    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [otherLoopbackRelayUrl],
    })
    const rejected = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(rejected.messages).toEqual([])
    expect(rejected.inbox).toMatchObject({
      declarationState: "not_observed",
      coverage: "unavailable",
      readSource: "declared",
    })
    expect(seenPlans).toHaveLength(1)
  })

  it("coalesces concurrent bounded inbox reads before fetch and decrypt", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const readyWrap = signedWrap(ORGANIZER)
    let declarationCount = 0
    let fetchCount = 0
    let unwrapCount = 0
    let releaseDeclarations!: () => void
    const declarationsReady = new Promise<void>((resolve) => {
      releaseDeclarations = resolve
    })

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => {
        declarationCount += 1
        if (declarationCount === 2) releaseDeclarations()
        return [declaredRelay]
      },
      fetchEventsFanout: async () => {
        fetchCount += 1
        await declarationsReady
        return [readyWrap]
      },
      giftUnwrap: async () => {
        unwrapCount += 1
        return readyRumor
      },
    })

    const [first, second] = await Promise.all([
      getEventMarketPrivateMessageList(ORGANIZER),
      getEventMarketPrivateMessageList(ORGANIZER),
    ])

    expect(declarationCount).toBe(2)
    expect(fetchCount).toBe(1)
    expect(unwrapCount).toBe(1)
    expect(first.messages.map((message) => message.id)).toEqual(
      second.messages.map((message) => message.id)
    )
    expect(first.inbox?.coverage).toBe("complete")
  })

  it("rejects an in-flight scan after same-account signer session replacement", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const firstRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const secondRumor = buildEventMarketReadyReceiptRumor(
      readyPayload({ issuedAt: ISSUED_AT + 1 })
    )
    const firstWrap = signedWrap(ORGANIZER, 501, ISSUED_AT + 1)
    const secondWrap = signedWrap(ORGANIZER, 502, ISSUED_AT + 2)
    let fetchCount = 0
    let releaseFirstFetch!: () => void
    let markFirstFetchStarted!: () => void
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve
    })
    const firstFetchStarted = new Promise<void>((resolve) => {
      markFirstFetchStarted = resolve
    })
    const unwrappedIds: string[] = []

    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanoutWithDiagnostics: async (_filter, options) => {
        fetchCount += 1
        const isFirst = fetchCount === 1
        if (isFirst) {
          markFirstFetchStarted()
          await firstFetchGate
        }
        return {
          events: [isFirst ? firstWrap : secondWrap],
          attemptedRelayUrls: [...(options?.relayUrls ?? [])],
          successfulRelayUrls: [...(options?.relayUrls ?? [])],
          failedRelayUrls: [],
          cappedRelayUrls: [],
        }
      },
      giftUnwrap: async (event) => {
        unwrappedIds.push(event.id)
        return event.id === firstWrap.id ? firstRumor : secondRumor
      },
    })

    installProtectedReadSigner(
      protectedReadSigner(ORGANIZER_SECRET),
      ORGANIZER,
      () => true
    )
    const staleSessionRead = getEventMarketPrivateMessageList(ORGANIZER)
    await firstFetchStarted

    installProtectedReadSigner(
      protectedReadSigner(ORGANIZER_SECRET),
      ORGANIZER,
      () => true
    )
    const currentSessionRead = await getEventMarketPrivateMessageList(ORGANIZER)
    releaseFirstFetch()

    await expect(staleSessionRead).rejects.toThrow(
      "Protected-read authority changed during inbox synchronization"
    )
    expect(currentSessionRead.messages.map((message) => message.id)).toEqual([
      secondRumor.id,
    ])
    expect(currentSessionRead.inbox?.coverage).toBe("complete")
    expect(unwrappedIds).toEqual([secondWrap.id])
  })

  it("does not carry partial decrypted evidence into a replacement signer session", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const firstRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const secondRumor = buildEventMarketReadyReceiptRumor(
      readyPayload({ issuedAt: ISSUED_AT + 1 })
    )
    const firstWrap = signedWrap(ORGANIZER, 601, ISSUED_AT + 1)
    const secondWrap = signedWrap(ORGANIZER, 602, ISSUED_AT + 2)
    let currentWrap = firstWrap
    let firstSession = true

    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanoutWithDiagnostics: async (_filter, options) => ({
        events: [currentWrap],
        attemptedRelayUrls: [...(options?.relayUrls ?? [])],
        successfulRelayUrls: [...(options?.relayUrls ?? [])],
        failedRelayUrls: firstSession ? [...(options?.relayUrls ?? [])] : [],
        cappedRelayUrls: [],
      }),
      giftUnwrap: async (event) =>
        event.id === firstWrap.id ? firstRumor : secondRumor,
    })

    installProtectedReadSigner(
      protectedReadSigner(ORGANIZER_SECRET),
      ORGANIZER,
      () => true
    )
    const partial = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(partial.messages.map((message) => message.id)).toEqual([
      firstRumor.id,
    ])
    expect(partial.inbox?.coverage).toBe("partial")

    firstSession = false
    currentWrap = secondWrap
    installProtectedReadSigner(
      protectedReadSigner(ORGANIZER_SECRET),
      ORGANIZER,
      () => true
    )
    const replacement = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(replacement.messages.map((message) => message.id)).toEqual([
      secondRumor.id,
    ])
    expect(replacement.inbox?.coverage).toBe("complete")
  })

  it("rejects an in-flight read after the declared relay plan changes", async () => {
    const oldRelay = "wss://organizer.old-inbox.relay.dev"
    const newRelay = "wss://organizer.new-inbox.relay.dev"
    const oldRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const newRumor = buildEventMarketReadyReceiptRumor(
      readyPayload({ issuedAt: ISSUED_AT + 1 })
    )
    const oldWrap = signedWrap(ORGANIZER, 701, ISSUED_AT + 1)
    const newWrap = signedWrap(ORGANIZER, 702, ISSUED_AT + 2)
    let declaredRelay = oldRelay
    let releaseOldRelay!: () => void
    let markOldRelayStarted!: () => void
    const oldRelayGate = new Promise<void>((resolve) => {
      releaseOldRelay = resolve
    })
    const oldRelayStarted = new Promise<void>((resolve) => {
      markOldRelayStarted = resolve
    })

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (_filter, options) => {
        if (options?.relayUrls?.[0] === oldRelay) {
          markOldRelayStarted()
          await oldRelayGate
          return [oldWrap]
        }
        return [newWrap]
      },
      giftUnwrap: async (event) =>
        event.id === oldWrap.id ? oldRumor : newRumor,
    })

    const superseded = getEventMarketPrivateMessageList(ORGANIZER)
    await oldRelayStarted
    declaredRelay = newRelay
    const current = await getEventMarketPrivateMessageList(ORGANIZER)
    releaseOldRelay()

    await expect(superseded).rejects.toThrow(
      "Event-market inbox relay plan changed during synchronization"
    )
    expect(current.messages.map((message) => message.id)).toEqual([newRumor.id])
    expect(current.inbox?.coverage).toBe("complete")
  })

  it("discovers paginated receipt evidence without certifying a multi-request scan", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const revocationRumor = buildEventMarketFulfillmentRevocationRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const relayEvents = Array.from({ length: 400 }, (_, index) =>
      signedWrap(ORGANIZER, index, ISSUED_AT + 100)
    )
    const readyWrap = signedWrap(ORGANIZER, 400, ISSUED_AT)
    const revocationWrap = signedWrap(ORGANIZER, 401, ISSUED_AT)
    relayEvents.push(readyWrap, revocationWrap)
    const requestedFilters: Array<{
      limit?: number
      since?: number
      until?: number
    }> = []

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) => {
        requestedFilters.push({
          limit: filter.limit,
          since: filter.since,
          until: filter.until,
        })
        return relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length)
      },
      giftUnwrap: async (event) =>
        event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor,
    })

    const read = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })

    expect(requestedFilters).toEqual([
      { limit: 400, since: undefined, until: undefined },
      { limit: 512, since: ISSUED_AT + 100, until: ISSUED_AT + 100 },
      { limit: 400, since: undefined, until: ISSUED_AT + 99 },
    ])
    expect(read.data).toHaveLength(1)
    expect(read.data[0]?.state).toBe("revoked")
    expect(read.inbox?.coverage).toBe("partial")
  })

  it("keeps coverage partial when a backdated revocation arrives after the first page", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const revocationRumor = buildEventMarketFulfillmentRevocationRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const relayEvents = Array.from({ length: 399 }, (_, index) => {
      const event = new NDKEvent()
      event.id = (30_000 + index).toString(16).padStart(64, "0")
      event.kind = EVENT_KINDS.GIFT_WRAP
      event.created_at = ISSUED_AT + 1_000 - index
      event.pubkey = MERCHANT
      event.tags = [["p", ORGANIZER]]
      event.content = "ciphertext"
      return event
    })
    const readyWrap = signedWrap(ORGANIZER, 30_500, ISSUED_AT + 900)
    const revocationWrap = signedWrap(ORGANIZER, 30_501, ISSUED_AT + 800)
    relayEvents.push(readyWrap)
    let firstPrimary = true
    const unwrappedIds: string[] = []

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) => {
        const page = relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length)
        if (filter.limit === 400 && firstPrimary) {
          firstPrimary = false
          relayEvents.push(revocationWrap)
        }
        return page
      },
      giftUnwrap: async (event) => {
        unwrappedIds.push(event.id)
        return event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor
      },
    })

    const read = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })
    expect(unwrappedIds).toContain(readyWrap.id)
    expect(unwrappedIds).not.toContain(revocationWrap.id)
    expect(read.data[0]?.state).toBe("ready_for_pickup")
    expect(read.inbox?.coverage).toBe("partial")
  })

  it("discovers evidence past 3,200 wraps but keeps stitched coverage partial", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const revocationRumor = buildEventMarketFulfillmentRevocationRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const unrelatedWraps = Array.from({ length: 3_200 }, (_, index) => {
      const event = new NDKEvent()
      event.id = (index + 1).toString(16).padStart(64, "0")
      event.kind = EVENT_KINDS.GIFT_WRAP
      event.created_at = ISSUED_AT + 4_000 - index
      event.pubkey = MERCHANT
      event.tags = [["p", ORGANIZER]]
      event.content = "ciphertext"
      return event
    })
    const readyWrap = signedWrap(ORGANIZER, 3_201, ISSUED_AT)
    const revocationWrap = signedWrap(ORGANIZER, 3_202, ISSUED_AT)
    const relayEvents = [...unrelatedWraps, readyWrap, revocationWrap]
    const unwrapCounts = new Map<string, number>()
    let primaryPageCount = 0

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) => {
        if (filter.limit === 400) primaryPageCount += 1
        return relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length)
      },
      giftUnwrap: async (event) => {
        unwrapCounts.set(event.id, (unwrapCounts.get(event.id) ?? 0) + 1)
        return event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor
      },
    })

    const partial = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })
    expect(primaryPageCount).toBe(8)
    expect(unwrapCounts.size).toBe(3_200)
    expect(partial.data).toEqual([])
    expect(partial.inbox?.coverage).toBe("partial")

    const continued = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })
    expect(primaryPageCount).toBe(9)
    expect(unwrapCounts.size).toBe(3_202)
    expect(Math.max(...unwrapCounts.values())).toBe(1)
    expect(continued.data).toHaveLength(1)
    expect(continued.data[0]?.state).toBe("revoked")
    expect(continued.inbox?.coverage).toBe("partial")
  })

  it("restarts fresh to discover a late backdated revocation without certifying the stitched gap", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const revocationRumor = buildEventMarketFulfillmentRevocationRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const relayEvents = Array.from({ length: 3_200 }, (_, index) => {
      const event = new NDKEvent()
      event.id = (10_000 + index).toString(16).padStart(64, "0")
      event.kind = EVENT_KINDS.GIFT_WRAP
      event.created_at = ISSUED_AT + 4_000 - index
      event.pubkey = MERCHANT
      event.tags = [["p", ORGANIZER]]
      event.content = "ciphertext"
      return event
    })
    const readyWrap = signedWrap(ORGANIZER, 7_201, ISSUED_AT + 3_900)
    const revocationWrap = signedWrap(ORGANIZER, 7_202, ISSUED_AT + 2_000)
    relayEvents.push(readyWrap)
    const unwrapCounts = new Map<string, number>()

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) =>
        relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length),
      giftUnwrap: async (event) => {
        unwrapCounts.set(event.id, (unwrapCounts.get(event.id) ?? 0) + 1)
        return event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor
      },
    })

    const initial = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })
    expect(initial.data[0]?.state).toBe("ready_for_pickup")
    expect(initial.inbox?.coverage).toBe("partial")

    relayEvents.push(revocationWrap)
    const stitched = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })
    expect(unwrapCounts.get(revocationWrap.id)).toBeUndefined()
    expect(stitched.data[0]?.state).toBe("ready_for_pickup")
    expect(stitched.inbox?.coverage).toBe("partial")

    const revalidated = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })
    expect(unwrapCounts.get(revocationWrap.id)).toBe(1)
    expect(revalidated.data[0]?.state).toBe("revoked")
    expect(revalidated.inbox?.coverage).toBe("partial")
  })

  it("revalidates a relay that reached EOSE while another relay continues", async () => {
    const shortRelay = "wss://organizer.short-inbox.relay.dev"
    const longRelay = "wss://organizer.long-inbox.relay.dev"
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const revocationRumor = buildEventMarketFulfillmentRevocationRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const readyWrap = signedWrap(ORGANIZER, 8_001, ISSUED_AT + 1)
    const revocationWrap = signedWrap(ORGANIZER, 8_002, ISSUED_AT)
    const shortRelayEvents = [readyWrap]
    const longRelayEvents = Array.from({ length: 3_200 }, (_, index) => {
      const event = new NDKEvent()
      event.id = (20_000 + index).toString(16).padStart(64, "0")
      event.kind = EVENT_KINDS.GIFT_WRAP
      event.created_at = ISSUED_AT + 4_000 - index
      event.pubkey = MERCHANT
      event.tags = [["p", ORGANIZER]]
      event.content = "ciphertext"
      return event
    })
    let shortRelayPrimaryReads = 0

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [shortRelay, longRelay],
      fetchEventsFanout: async (filter, options) => {
        const relayUrl = options?.relayUrls?.[0]
        if (relayUrl === shortRelay && filter.limit === 400) {
          shortRelayPrimaryReads += 1
        }
        const source =
          relayUrl === shortRelay ? shortRelayEvents : longRelayEvents
        return source
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? source.length)
      },
      giftUnwrap: async (event) =>
        event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor,
    })

    const initial = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })
    expect(initial.data[0]?.state).toBe("ready_for_pickup")
    expect(initial.inbox?.coverage).toBe("partial")

    shortRelayEvents.push(revocationWrap)
    const continued = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })
    expect(shortRelayPrimaryReads).toBe(2)
    expect(continued.data[0]?.state).toBe("revoked")
    expect(continued.inbox?.coverage).toBe("partial")
  })

  it("retains a late matching revocation after bounded evidence reaches 1,024 messages", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumors = Array.from({ length: 1_024 }, (_, index) =>
      buildEventMarketReadyReceiptRumor(
        index === 0
          ? readyPayload()
          : readyPayload({
              issuedAt: ISSUED_AT + index,
              claimRef: (40_000 + index).toString(16).padStart(64, "0"),
            })
      )
    )
    const targetReady = readyRumors[0]!
    const revocationRumor = buildEventMarketFulfillmentRevocationRumor(
      revocationPayload(targetReady.id)
    )
    const rumorByWrapId = new Map<string, NDKEvent>()
    const relayEvents = readyRumors.map((rumor, index) => {
      const wrap = new NDKEvent()
      wrap.id = (50_000 + index).toString(16).padStart(64, "0")
      wrap.kind = EVENT_KINDS.GIFT_WRAP
      wrap.created_at = ISSUED_AT + 2_000 - index
      wrap.pubkey = MERCHANT
      wrap.tags = [["p", ORGANIZER]]
      wrap.content = "ciphertext"
      rumorByWrapId.set(wrap.id, rumor)
      return wrap
    })
    const revocationWrap = new NDKEvent()
    revocationWrap.id = "f".repeat(64)
    revocationWrap.kind = EVENT_KINDS.GIFT_WRAP
    revocationWrap.created_at = ISSUED_AT
    revocationWrap.pubkey = MERCHANT
    revocationWrap.tags = [["p", ORGANIZER]]
    revocationWrap.content = "ciphertext"
    rumorByWrapId.set(revocationWrap.id, revocationRumor)

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) =>
        relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length),
      giftUnwrap: async (event) => rumorByWrapId.get(event.id)!,
    })

    const initial = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(initial.messages).toHaveLength(1_024)
    expect(initial.inbox?.coverage).toBe("partial")

    relayEvents.push(revocationWrap)
    const continued = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(continued.messages).toHaveLength(1_024)
    expect(
      continued.messages.some((message) => message.id === targetReady.id)
    ).toBe(true)
    expect(
      continued.messages.some((message) => message.id === revocationRumor.id)
    ).toBe(true)
    expect(continued.inbox?.coverage).toBe("partial")
  })

  it("authorizes a found receipt when an exact timestamp boundary stays capped", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildEventMarketReadyReceiptRumor(readyPayload())
    const readyWrap = signedWrap(ORGANIZER)

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanoutWithDiagnostics: async () => ({
        events: [readyWrap],
        attemptedRelayUrls: [declaredRelay],
        successfulRelayUrls: [declaredRelay],
        failedRelayUrls: [],
        cappedRelayUrls: [declaredRelay],
      }),
      giftUnwrap: async () => readyRumor,
    })

    const read = await readEventMarketReadyReceipts({
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
    })

    expect(read.data).toHaveLength(1)
    expect(read.data[0]?.state).toBe("ready_for_pickup")
    expect(read.inbox?.coverage).toBe("partial")
    expect(
      resolveEventMarketHandoffAckGate({
        claim: read.data[0]!,
        market: activeMarket(),
        merchandise: verifiedMerchandise(),
      })
    ).toEqual({ state: "ready" })
  })
})

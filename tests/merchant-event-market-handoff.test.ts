import { describe, expect, it } from "bun:test"
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent } from "nostr-tools/pure"
import {
  buildEventMarketReadyReceiptRumor,
  createEventMarketPrivateDeliveryProgress,
  getEventMarketOrderCorrelationRef,
  RelayPublishDiagnosticsError,
  type EventMarketResolution,
  type OrderSchema,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  buildOrganizerReadyReceiptPayload,
  eventMarketHandoffDeliveryNeedsRetry,
  eventMarketHandoffRecipientAcknowledged,
  getOrganizerReadyReceiptFulfillmentState,
  issueOrganizerReadyReceipt,
  loadEventMarketHandoffDeliveries,
  rememberEventMarketHandoffDelivery,
  resolveMerchantHandoffAckEvidence,
  resolveMerchantHandoffAckReadState,
  revokeOrganizerReadyReceipt,
  type StoredEventMarketHandoffDelivery,
} from "../apps/merchant/src/lib/event-market-handoff"

const ORGANIZER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const BUYER = "c".repeat(64)
const OTHER = "d".repeat(64)
const COLLECTION = `30405:${ORGANIZER}:summer-market`
const CALENDAR = `31923:${ORGANIZER}:summer-market`
const PICKUP = `30406:${ORGANIZER}:summer-market-pickup`
const PRODUCT = `30402:${MERCHANT}:coffee`
const WRAP_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1)

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  private readonly writes: string[] = []
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
    this.writes.push(value)
  }
  serialized() {
    return JSON.stringify(Array.from(this.values.values()))
  }
  snapshots() {
    return [...this.writes]
  }
}

function order(price = 2_000, id = "order-private-1"): OrderSchema {
  return {
    id,
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    buyerIdentityKind: "guest_ephemeral",
    items: [
      {
        productId: PRODUCT,
        title: "Coffee",
        format: "physical",
        fulfillment: {
          type: "pickup",
          organizerPubkey: ORGANIZER,
          handoffMode: "organizer_handoff",
          handlerPubkey: ORGANIZER,
          product: {
            coordinate: PRODUCT,
            merchantPubkey: MERCHANT,
            eventId: "4".repeat(64),
            createdAt: 103,
          },
          calendar: {
            coordinate: CALENDAR,
            eventId: "2".repeat(64),
            createdAt: 101,
          },
          collection: {
            coordinate: COLLECTION,
            eventId: "1".repeat(64),
            createdAt: 100,
          },
          option: {
            coordinate: PICKUP,
            eventId: "3".repeat(64),
            createdAt: 102,
            title: "Organizer pickup",
            location: "Public hall entrance",
          },
          costSats: 0,
          sourceCost: {
            amount: 0,
            currency: "SATS",
            normalizedCurrency: "SATS",
          },
        },
        quantity: 2,
        priceAtPurchase: price,
        currency: "SATS",
        shippingOptionId: PICKUP,
        shippingOptionDTag: "summer-market-pickup",
        shippingCostSats: 0,
        sourceShippingCost: {
          amount: 0,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
      },
    ],
    subtotal: price * 2,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "included",
    guestContact: {
      email: "buyer@example.com",
      phone: "+15555550100",
    },
    note: "Private note that must not leave the order",
    createdAt: 1_800_000_000,
  }
}

function market(): EventMarketResolution {
  const calendar = {
    coordinate: CALENDAR,
    eventId: "2".repeat(64),
    authorPubkey: ORGANIZER,
    dTag: "summer-market",
    kind: 31923 as const,
    title: "Summer Market",
    content: "",
    locations: ["Public hall"],
    start: 1_800_000_000_000,
    createdAt: 101,
  }
  const pickup = {
    coordinate: PICKUP,
    eventId: "3".repeat(64),
    authorPubkey: ORGANIZER,
    dTag: "summer-market-pickup",
    title: "Organizer pickup",
    content: "",
    price: 0,
    currency: "SATS",
    countries: ["US"],
    location: "Public hall entrance",
    createdAt: 102,
  }
  const collection = {
    coordinate: COLLECTION,
    eventId: "1".repeat(64),
    authorPubkey: ORGANIZER,
    dTag: "summer-market",
    title: "Summer Market",
    content: "",
    eventCoordinates: [CALENDAR],
    pickupCoordinates: [PICKUP],
    productCoordinates: [PRODUCT],
    unsupportedReferences: [],
    createdAt: 100,
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
        eventId: "4".repeat(64),
        createdAt: 103,
        shippingOptionCoordinates: [PICKUP],
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

function fakeWrap(recipientPubkey: string): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      created_at: 1_800_000_000,
      kind: 1059,
      tags: [["p", recipientPubkey]],
      content: "ciphertext",
    },
    WRAP_SECRET
  )
}

function ndkWrap(recipientPubkey: string): NDKEvent {
  return new NDKEvent(undefined, fakeWrap(recipientPubkey))
}

const merchantSigner = {
  user: async () => ({ pubkey: MERCHANT }),
} as unknown as NDKSigner

function plannerResult(input: {
  attempted: readonly string[]
  successful: readonly string[]
  failed: readonly string[]
}): PublishWithPlannerResult {
  return {
    plan: {
      intent: "recipient_event",
      primaryRelayUrls: [...input.attempted],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    },
    attemptedRelayUrls: [...input.attempted],
    successfulRelayUrls: [...input.successful],
    failedRelayUrls: [...input.failed],
    relayFailureMessages: Object.fromEntries(
      input.failed.map((relay) => [relay, "No acknowledgement"])
    ),
  }
}

function readyDelivery(
  sourceOrder = order()
): StoredEventMarketHandoffDelivery {
  const payload = buildOrganizerReadyReceiptPayload(
    sourceOrder,
    market(),
    sourceOrder.subtotal === 0 ? "zero_cost" : "paid",
    1_800_000_000
  )
  const readyReceiptId = buildEventMarketReadyReceiptRumor(payload).id
  const record: StoredEventMarketHandoffDelivery["record"] = {
    messageType: payload.type,
    rumorId: readyReceiptId,
    readyReceiptId,
    claimRef: payload.claimRef,
    senderPubkey: MERCHANT,
    recipientPubkey: ORGANIZER,
    graph: {
      calendar: payload.calendar,
      collection: payload.collection,
      option: payload.option,
    },
    orderCorrelationRef: getEventMarketOrderCorrelationRef(sourceOrder.id),
    signedRecipientWrap: fakeWrap(ORGANIZER),
    signedSelfWrap: fakeWrap(MERCHANT),
    createdAt: 1_800_000_000_000,
  }
  return {
    record,
    deliveryProgress: progressFor(record, 1, 1),
    recipient: {
      status: "full_success",
      acknowledgedCount: 1,
      failedCount: 0,
    },
    selfCopy: {
      status: "full_success",
      acknowledgedCount: 1,
      failedCount: 0,
    },
    savedAt: 1_800_000_000_000,
  }
}

function revocationDelivery(
  ready: StoredEventMarketHandoffDelivery
): StoredEventMarketHandoffDelivery {
  const record: StoredEventMarketHandoffDelivery["record"] = {
    ...ready.record,
    messageType: "organizer_fulfillment_revocation",
    rumorId: "5".repeat(64),
    signedRecipientWrap: fakeWrap(ORGANIZER),
    signedSelfWrap: fakeWrap(MERCHANT),
  }
  return {
    record,
    deliveryProgress: progressFor(record, 1, 1),
    recipient: {
      status: "full_success",
      acknowledgedCount: 1,
      failedCount: 0,
    },
    selfCopy: {
      status: "full_success",
      acknowledgedCount: 1,
      failedCount: 0,
    },
    savedAt: ready.savedAt + 1,
  }
}

function deliveryWithIdentity(
  template: StoredEventMarketHandoffDelivery,
  index: number,
  recipient: StoredEventMarketHandoffDelivery["recipient"] = template.recipient,
  selfCopy: StoredEventMarketHandoffDelivery["selfCopy"] = template.selfCopy
): StoredEventMarketHandoffDelivery {
  const readyReceiptId = (index + 1).toString(16).padStart(64, "0")
  const record = {
    ...template.record,
    rumorId: readyReceiptId,
    readyReceiptId,
    orderCorrelationRef: (index + 10_000).toString(16).padStart(64, "0"),
  }
  return {
    ...template,
    record,
    deliveryProgress: progressFor(
      record,
      recipient.acknowledgedCount,
      selfCopy.acknowledgedCount,
      index * 4
    ),
    recipient,
    selfCopy,
    savedAt: index,
  }
}

function progressFor(
  record: StoredEventMarketHandoffDelivery["record"],
  recipientAcknowledgedCount: number,
  selfAcknowledgedCount: number,
  seed = 0
): StoredEventMarketHandoffDelivery["deliveryProgress"] {
  const relayRefs = (count: number, offset: number) =>
    Array.from({ length: count }, (_, index) =>
      (seed + offset + index + 1).toString(16).padStart(64, "0")
    )
  return {
    ...createEventMarketPrivateDeliveryProgress(record),
    recipientAcknowledgedRelayRefs: relayRefs(recipientAcknowledgedCount, 0),
    selfAcknowledgedRelayRefs: relayRefs(selfAcknowledgedCount, 128),
  }
}

function withDeliveryState(
  delivery: StoredEventMarketHandoffDelivery,
  recipient: StoredEventMarketHandoffDelivery["recipient"],
  selfCopy: StoredEventMarketHandoffDelivery["selfCopy"]
): StoredEventMarketHandoffDelivery {
  return {
    ...delivery,
    deliveryProgress: progressFor(
      delivery.record,
      recipient.acknowledgedCount,
      selfCopy.acknowledgedCount
    ),
    recipient,
    selfCopy,
  }
}

function seedDeliveries(
  storage: MemoryStorage,
  deliveries: readonly StoredEventMarketHandoffDelivery[]
): void {
  storage.setItem(
    `conduit:merchant:event-handoff-delivery:v1:${MERCHANT}`,
    JSON.stringify(deliveries)
  )
}

describe("merchant organizer handoff workflow", () => {
  it("builds only the minimal receipt and excludes private order fields", () => {
    const receipt = buildOrganizerReadyReceiptPayload(
      order(),
      market(),
      "paid",
      1_800_000_000
    )
    expect(receipt.items).toEqual([
      {
        product: {
          coordinate: PRODUCT,
          eventId: "4".repeat(64),
          createdAt: 103,
        },
        quantity: 2,
        variants: [],
      },
    ])
    const serialized = JSON.stringify(receipt)
    for (const privateField of [
      "guestContact",
      "shippingAddress",
      "note",
      "invoice",
      "payment",
      "buyer@example.com",
      "+15555550100",
    ]) {
      expect(serialized).not.toContain(privateField)
    }
  })

  it("permits zero-cost readiness and blocks nonzero unpaid readiness", () => {
    expect(getOrganizerReadyReceiptFulfillmentState(order(0), false)).toBe(
      "zero_cost"
    )
    expect(getOrganizerReadyReceiptFulfillmentState(order(), true)).toBe("paid")
    expect(() =>
      getOrganizerReadyReceiptFulfillmentState(order(), false)
    ).toThrow("Verify the paid order status")
  })

  it("does not classify a mixed pickup and digital order as zero-cost pickup", () => {
    const mixedOrder = order(0)
    mixedOrder.items.push({
      productId: `30402:${MERCHANT}:download`,
      title: "Download",
      format: "digital",
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: 0,
      currency: "SATS",
    })

    expect(() =>
      getOrganizerReadyReceiptFulfillmentState(mixedOrder, false)
    ).toThrow("Verify the paid order status")
    expect(getOrganizerReadyReceiptFulfillmentState(mixedOrder, true)).toBe(
      "paid"
    )
  })

  it("fails closed when an exact ACK shares a receipt id with a conflicting graph", () => {
    const readyReceiptId = "9".repeat(64)
    const expectedGraph = {
      claimRef: "8".repeat(64),
      merchantPubkey: MERCHANT,
      organizerPubkey: ORGANIZER,
      calendar: {
        coordinate: CALENDAR,
        eventId: "1".repeat(64),
        createdAt: 100,
      },
      collection: {
        coordinate: COLLECTION,
        eventId: "2".repeat(64),
        createdAt: 101,
      },
      option: {
        coordinate: PICKUP,
        eventId: "3".repeat(64),
        createdAt: 102,
      },
    }
    const exact = {
      id: "4".repeat(64),
      createdAt: 200,
      payload: { ...expectedGraph, readyReceiptId },
    }
    const conflicting = {
      id: "5".repeat(64),
      createdAt: 201,
      payload: {
        ...expectedGraph,
        claimRef: "7".repeat(64),
        readyReceiptId,
      },
    }

    expect(
      resolveMerchantHandoffAckEvidence({
        acks: [exact],
        readyReceiptId,
        expectedGraph,
        hasRevocation: false,
      })
    ).toEqual({ exactAck: exact, conflicting: false })
    expect(
      resolveMerchantHandoffAckEvidence({
        acks: [exact, conflicting],
        readyReceiptId,
        expectedGraph,
        hasRevocation: false,
      })
    ).toEqual({ exactAck: null, conflicting: true })
    expect(
      resolveMerchantHandoffAckEvidence({
        acks: [exact],
        readyReceiptId,
        expectedGraph,
        hasRevocation: true,
      })
    ).toEqual({ exactAck: null, conflicting: true })
  })

  it("separates a background ACK refresh from strict evidence degradation", () => {
    const readyReceiptId = "6".repeat(64)
    const expectedGraph = {
      claimRef: "8".repeat(64),
      merchantPubkey: MERCHANT,
      organizerPubkey: ORGANIZER,
      calendar: {
        coordinate: CALENDAR,
        eventId: "1".repeat(64),
        createdAt: 100,
      },
      collection: {
        coordinate: COLLECTION,
        eventId: "2".repeat(64),
        createdAt: 101,
      },
      option: {
        coordinate: PICKUP,
        eventId: "3".repeat(64),
        createdAt: 102,
      },
    }
    const exact = {
      id: "4".repeat(64),
      createdAt: 200,
      payload: { ...expectedGraph, readyReceiptId },
    }
    const completeRead = {
      data: [exact],
      stale: false,
      decryptFailureCount: 0,
      inbox: {
        declarationState: "declared" as const,
        coverage: "complete" as const,
        readSource: "declared" as const,
      },
    }

    expect(
      resolveMerchantHandoffAckReadState({
        read: completeRead,
        isError: false,
        isFetching: true,
        readyReceiptId,
        expectedGraph,
        hasRevocation: false,
      })
    ).toEqual({
      exactAck: exact,
      conflicting: false,
      blocker: null,
      refreshing: true,
    })
    expect(
      resolveMerchantHandoffAckReadState({
        read: null,
        isError: false,
        isFetching: true,
        readyReceiptId,
        expectedGraph,
        hasRevocation: false,
      })
    ).toEqual({
      exactAck: null,
      conflicting: false,
      blocker: "pending",
      refreshing: true,
    })
  })

  it("keeps stale, unreadable, undeclared, and partial ACK reads fail-closed", () => {
    const readyReceiptId = "6".repeat(64)
    const expectedGraph = {
      claimRef: "8".repeat(64),
      merchantPubkey: MERCHANT,
      organizerPubkey: ORGANIZER,
      calendar: {
        coordinate: CALENDAR,
        eventId: "1".repeat(64),
        createdAt: 100,
      },
      collection: {
        coordinate: COLLECTION,
        eventId: "2".repeat(64),
        createdAt: 101,
      },
      option: {
        coordinate: PICKUP,
        eventId: "3".repeat(64),
        createdAt: 102,
      },
    }
    const exact = {
      id: "4".repeat(64),
      createdAt: 200,
      payload: { ...expectedGraph, readyReceiptId },
    }
    const resolve = (overrides: {
      stale?: boolean
      decryptFailureCount?: number
      declarationState?: "declared" | "not_declared"
      coverage?: "complete" | "partial"
    }) =>
      resolveMerchantHandoffAckReadState({
        read: {
          data: [exact],
          stale: overrides.stale ?? false,
          decryptFailureCount: overrides.decryptFailureCount ?? 0,
          inbox: {
            declarationState: overrides.declarationState ?? "declared",
            coverage: overrides.coverage ?? "complete",
            readSource: "declared",
          },
        },
        isError: false,
        isFetching: false,
        readyReceiptId,
        expectedGraph,
        hasRevocation: false,
      })

    expect(resolve({ stale: true }).blocker).toBe("stale")
    expect(resolve({ decryptFailureCount: 1 }).blocker).toBe("decrypt_failure")
    expect(resolve({ declarationState: "not_declared" }).blocker).toBe(
      "inbox_not_declared"
    )
    expect(resolve({ coverage: "partial" }).blocker).toBe("coverage_incomplete")
    for (const result of [
      resolve({ stale: true }),
      resolve({ decryptFailureCount: 1 }),
      resolve({ declarationState: "not_declared" }),
      resolve({ coverage: "partial" }),
    ]) {
      expect(result.exactAck).toBeNull()
    }
  })

  it("reloads one durable receipt idempotently without republishing", async () => {
    const storage = new MemoryStorage()
    const delivery = readyDelivery()
    rememberEventMarketHandoffDelivery(MERCHANT, delivery, storage)
    rememberEventMarketHandoffDelivery(
      MERCHANT,
      { ...delivery, savedAt: delivery.savedAt + 1 },
      storage
    )

    expect(loadEventMarketHandoffDeliveries(MERCHANT, storage)).toHaveLength(1)
    const result = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: order(),
      paymentAuthenticated: false,
      market: market(),
      signer: {} as never,
      storage,
    })
    expect(result.record.readyReceiptId).toBe(delivery.record.readyReceiptId)
    expect(eventMarketHandoffDeliveryNeedsRetry(result)).toBe(false)
  })

  it("migrates aggregate-only rows to a bound retry checkpoint without trusting old ACK state", async () => {
    const storage = new MemoryStorage()
    const sourceOrder = order(2_000, "legacy-progress-order")
    const legacy = {
      ...readyDelivery(sourceOrder),
    } as Partial<StoredEventMarketHandoffDelivery>
    const record = legacy.record!
    delete legacy.deliveryProgress
    storage.setItem(
      `conduit:merchant:event-handoff-delivery:v1:${MERCHANT}`,
      JSON.stringify([legacy])
    )

    const migrated = loadEventMarketHandoffDeliveries(MERCHANT, storage)[0]!
    expect(migrated.recipient.status).toBe("unknown")
    expect(migrated.selfCopy.status).toBe("unknown")
    expect(migrated.deliveryProgress).toEqual(
      createEventMarketPrivateDeliveryProgress(record)
    )
    expect(eventMarketHandoffDeliveryNeedsRetry(migrated)).toBe(true)

    const publishedIds: string[] = []
    const converged = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: sourceOrder,
      paymentAuthenticated: true,
      market: market(),
      signer: {} as never,
      storage,
      transport: {
        recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        publishFn: (async (event, options) => {
          publishedIds.push(event.id)
          const relays = options.exclusiveRelayUrls ?? []
          return plannerResult({
            attempted: relays,
            successful: relays,
            failed: [],
          })
        }) as never,
      },
    })

    expect(publishedIds).toEqual([
      record.signedRecipientWrap.id,
      record.signedSelfWrap.id,
    ])
    expect(converged.recipient.status).toBe("full_success")
    expect(converged.selfCopy.status).toBe("full_success")
    expect(storage.serialized()).not.toContain("wss://")
  })

  it("persists only account-scoped ciphertext descriptors", () => {
    const storage = new MemoryStorage()
    rememberEventMarketHandoffDelivery(MERCHANT, readyDelivery(), storage)

    const serialized = storage.serialized()
    for (const privateValue of [
      "payload",
      "order-private-1",
      "Coffee",
      "buyer@example.com",
      "+15555550100",
      "Private note",
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(serialized).toContain("ciphertext")
  })

  it("persists partial recipient delivery without claiming clean delivery", async () => {
    const storage = new MemoryStorage()
    const recipientRelays = [
      "wss://organizer-primary.relay.dev",
      "wss://organizer-backup.relay.dev",
    ]
    const result = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: order(),
      paymentAuthenticated: true,
      market: market(),
      signer: merchantSigner,
      storage,
      transport: {
        recipientInboxRelays: recipientRelays,
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        giftWrapFn: (async (_rumor, recipient) =>
          ndkWrap(recipient.pubkey)) as never,
        publishFn: (async (_event, options) => {
          const relays = options.exclusiveRelayUrls ?? []
          return options.recipientPubkeys?.[0] === ORGANIZER
            ? plannerResult({
                attempted: relays,
                successful: [recipientRelays[0]!],
                failed: [recipientRelays[1]!],
              })
            : plannerResult({
                attempted: relays,
                successful: relays,
                failed: [],
              })
        }) as never,
      },
    })

    expect(result.recipient).toEqual({
      status: "partial_success",
      acknowledgedCount: 1,
      failedCount: 1,
    })
    expect(result.selfCopy).toEqual({
      status: "full_success",
      acknowledgedCount: 1,
      failedCount: 0,
    })
    expect(eventMarketHandoffRecipientAcknowledged(result)).toBe(true)
    expect(eventMarketHandoffDeliveryNeedsRetry(result)).toBe(true)
    expect(loadEventMarketHandoffDeliveries(MERCHANT, storage)).toEqual([
      result,
    ])
  })

  it("unions alternating recipient ACKs and retries only missing exact-wrap targets", async () => {
    const storage = new MemoryStorage()
    const sourceOrder = order(2_000, "alternating-recipient-order")
    const recipientRelays = [
      "wss://organizer-primary.relay.dev",
      "wss://organizer-backup.relay.dev",
    ]
    const initial = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: sourceOrder,
      paymentAuthenticated: true,
      market: market(),
      signer: merchantSigner,
      storage,
      transport: {
        recipientInboxRelays: recipientRelays,
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        giftWrapFn: (async (_rumor, recipient) =>
          ndkWrap(recipient.pubkey)) as never,
        publishFn: (async (_event, options) => {
          const relays = options.exclusiveRelayUrls ?? []
          return options.recipientPubkeys?.[0] === ORGANIZER
            ? plannerResult({
                attempted: relays,
                successful: [recipientRelays[0]!],
                failed: [recipientRelays[1]!],
              })
            : plannerResult({
                attempted: relays,
                successful: relays,
                failed: [],
              })
        }) as never,
      },
    })
    expect(initial.recipient.status).toBe("partial_success")
    expect(
      initial.deliveryProgress.recipientAcknowledgedRelayRefs
    ).toHaveLength(1)
    expect(storage.serialized()).not.toContain("wss://")

    const retryTargets: string[][] = []
    const retried = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: sourceOrder,
      paymentAuthenticated: true,
      market: market(),
      signer: {} as never,
      storage,
      transport: {
        recipientInboxRelays: recipientRelays,
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        publishFn: (async (_event, options) => {
          const relays = options.exclusiveRelayUrls ?? []
          retryTargets.push([...relays])
          return plannerResult({
            attempted: relays,
            successful: relays,
            failed: [],
          })
        }) as never,
      },
    })

    expect(retryTargets).toEqual([[recipientRelays[1]!]])
    expect(retried.recipient).toEqual({
      status: "full_success",
      acknowledgedCount: 2,
      failedCount: 0,
    })
    expect(
      retried.deliveryProgress.recipientAcknowledgedRelayRefs
    ).toHaveLength(2)
    expect(retried.record).toEqual(initial.record)
    expect(storage.serialized()).not.toContain("wss://")
  })

  it("unions alternating self-copy ACKs without replaying completed legs", async () => {
    const storage = new MemoryStorage()
    const sourceOrder = order(2_000, "alternating-self-order")
    const recipientRelay = "wss://organizer-inbox.relay.dev"
    const senderRelays = [
      "wss://merchant-primary.relay.dev",
      "wss://merchant-backup.relay.dev",
    ]
    const initial = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: sourceOrder,
      paymentAuthenticated: true,
      market: market(),
      signer: merchantSigner,
      storage,
      transport: {
        recipientInboxRelays: [recipientRelay],
        senderInboxRelays: senderRelays,
        giftWrapFn: (async (_rumor, recipient) =>
          ndkWrap(recipient.pubkey)) as never,
        publishFn: (async (_event, options) => {
          const relays = options.exclusiveRelayUrls ?? []
          return options.recipientPubkeys?.[0] === MERCHANT
            ? plannerResult({
                attempted: relays,
                successful: [senderRelays[0]!],
                failed: [senderRelays[1]!],
              })
            : plannerResult({
                attempted: relays,
                successful: relays,
                failed: [],
              })
        }) as never,
      },
    })
    expect(initial.selfCopy.status).toBe("partial_success")

    const retryTargets: string[][] = []
    const retried = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: sourceOrder,
      paymentAuthenticated: true,
      market: market(),
      signer: {} as never,
      storage,
      transport: {
        recipientInboxRelays: [recipientRelay],
        senderInboxRelays: senderRelays,
        publishFn: (async (_event, options) => {
          const relays = options.exclusiveRelayUrls ?? []
          retryTargets.push([...relays])
          return plannerResult({
            attempted: relays,
            successful: relays,
            failed: [],
          })
        }) as never,
      },
    })

    expect(retryTargets).toEqual([[senderRelays[1]!]])
    expect(retried.selfCopy).toEqual({
      status: "full_success",
      acknowledgedCount: 2,
      failedCount: 0,
    })
    expect(retried.deliveryProgress.selfAcknowledgedRelayRefs).toHaveLength(2)
    expect(storage.serialized()).not.toContain("wss://")
  })

  it("moves recipient zero to partial without losing durable progress", async () => {
    const storage = new MemoryStorage()
    const sourceOrder = order(2_000, "zero-to-partial-order")
    const recipientRelays = [
      "wss://organizer-primary.relay.dev",
      "wss://organizer-backup.relay.dev",
    ]
    const zeroDiagnostics = plannerResult({
      attempted: recipientRelays,
      successful: [],
      failed: recipientRelays,
    })
    await expect(
      issueOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        order: sourceOrder,
        paymentAuthenticated: true,
        market: market(),
        signer: merchantSigner,
        storage,
        transport: {
          recipientInboxRelays: recipientRelays,
          senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
          giftWrapFn: (async (_rumor, recipient) =>
            ndkWrap(recipient.pubkey)) as never,
          publishFn: (async () => {
            throw new RelayPublishDiagnosticsError(
              "No recipient relay acknowledged",
              zeroDiagnostics,
              new Error("relay delivery failed")
            )
          }) as never,
        },
      })
    ).rejects.toThrow("No recipient relay acknowledged")

    const zero = loadEventMarketHandoffDeliveries(MERCHANT, storage)[0]!
    expect(zero.recipient.status).toBe("zero_ack")
    expect(zero.deliveryProgress.recipientAcknowledgedRelayRefs).toEqual([])
    expect(storage.serialized()).not.toContain("wss://")

    const partial = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: sourceOrder,
      paymentAuthenticated: true,
      market: market(),
      signer: {} as never,
      storage,
      transport: {
        recipientInboxRelays: recipientRelays,
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        publishFn: (async (_event, options) => {
          const relays = options.exclusiveRelayUrls ?? []
          return options.recipientPubkeys?.[0] === ORGANIZER
            ? plannerResult({
                attempted: relays,
                successful: [recipientRelays[0]!],
                failed: [recipientRelays[1]!],
              })
            : plannerResult({
                attempted: relays,
                successful: relays,
                failed: [],
              })
        }) as never,
      },
    })
    expect(partial.recipient).toEqual({
      status: "partial_success",
      acknowledgedCount: 1,
      failedCount: 1,
    })
    expect(
      partial.deliveryProgress.recipientAcknowledgedRelayRefs
    ).toHaveLength(1)
  })

  it("preserves progress across reload and current inbox changes", async () => {
    const storage = new MemoryStorage()
    const sourceOrder = order(2_000, "reload-current-inbox-order")
    const relayA = "wss://organizer-a.relay.dev"
    const relayB = "wss://organizer-b.relay.dev"
    const relayC = "wss://organizer-c.relay.dev"
    await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: sourceOrder,
      paymentAuthenticated: true,
      market: market(),
      signer: merchantSigner,
      storage,
      transport: {
        recipientInboxRelays: [relayA, relayB],
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        giftWrapFn: (async (_rumor, recipient) =>
          ndkWrap(recipient.pubkey)) as never,
        publishFn: (async (_event, options) => {
          const relays = options.exclusiveRelayUrls ?? []
          return options.recipientPubkeys?.[0] === ORGANIZER
            ? plannerResult({
                attempted: relays,
                successful: [relayA],
                failed: [relayB],
              })
            : plannerResult({
                attempted: relays,
                successful: relays,
                failed: [],
              })
        }) as never,
      },
    })

    const changedInboxAttempts: string[][] = []
    const changedInbox = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: sourceOrder,
      paymentAuthenticated: true,
      market: market(),
      signer: {} as never,
      storage,
      transport: {
        recipientInboxRelays: [relayB, relayC],
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        publishFn: (async (_event, options) => {
          const relays = options.exclusiveRelayUrls ?? []
          changedInboxAttempts.push([...relays])
          return plannerResult({
            attempted: relays,
            successful: [relayB],
            failed: [relayC],
          })
        }) as never,
      },
    })
    expect(changedInboxAttempts).toEqual([[relayB, relayC]])
    expect(
      changedInbox.deliveryProgress.recipientAcknowledgedRelayRefs
    ).toHaveLength(2)

    const readdedInboxAttempts: string[][] = []
    const converged = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: sourceOrder,
      paymentAuthenticated: true,
      market: market(),
      signer: {} as never,
      storage,
      transport: {
        recipientInboxRelays: [relayA, relayB, relayC],
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        publishFn: (async (_event, options) => {
          const relays = options.exclusiveRelayUrls ?? []
          readdedInboxAttempts.push([...relays])
          return plannerResult({
            attempted: relays,
            successful: relays,
            failed: [],
          })
        }) as never,
      },
    })
    expect(readdedInboxAttempts).toEqual([[relayC]])
    expect(converged.recipient.status).toBe("full_success")
    expect(converged.recipient.acknowledgedCount).toBe(3)
    expect(
      converged.deliveryProgress.recipientAcknowledgedRelayRefs
    ).toHaveLength(3)
    expect(storage.serialized()).not.toContain("wss://")
  })

  it("persists initial ready self-copy zero, partial, and full diagnostics", async () => {
    const cases = [
      {
        name: "zero",
        successfulCount: 0,
        expected: {
          status: "zero_ack" as const,
          acknowledgedCount: 0,
          failedCount: 2,
        },
        retryable: true,
      },
      {
        name: "partial",
        successfulCount: 1,
        expected: {
          status: "partial_success" as const,
          acknowledgedCount: 1,
          failedCount: 1,
        },
        retryable: true,
      },
      {
        name: "full",
        successfulCount: 2,
        expected: {
          status: "full_success" as const,
          acknowledgedCount: 2,
          failedCount: 0,
        },
        retryable: false,
      },
    ]

    for (const testCase of cases) {
      const storage = new MemoryStorage()
      const sourceOrder = order(2_000, `ready-self-${testCase.name}`)
      const initialPublishedIds: string[] = []
      const senderRelays = [
        "wss://merchant-primary.relay.dev",
        "wss://merchant-backup.relay.dev",
      ]
      const result = await issueOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        order: sourceOrder,
        paymentAuthenticated: true,
        market: market(),
        signer: merchantSigner,
        storage,
        transport: {
          recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
          senderInboxRelays: senderRelays,
          giftWrapFn: (async (_rumor, recipient) =>
            ndkWrap(recipient.pubkey)) as never,
          publishFn: (async (event, options) => {
            initialPublishedIds.push(event.id)
            const relays = options.exclusiveRelayUrls ?? []
            if (options.recipientPubkeys?.[0] !== MERCHANT) {
              return plannerResult({
                attempted: relays,
                successful: relays,
                failed: [],
              })
            }
            return plannerResult({
              attempted: relays,
              successful: relays.slice(0, testCase.successfulCount),
              failed: relays.slice(testCase.successfulCount),
            })
          }) as never,
        },
      })

      expect(result.selfCopy).toEqual(testCase.expected)
      expect(eventMarketHandoffDeliveryNeedsRetry(result)).toBe(
        testCase.retryable
      )
      expect(
        loadEventMarketHandoffDeliveries(MERCHANT, storage)[0]?.selfCopy
      ).toEqual(testCase.expected)
      expect(initialPublishedIds).toEqual([
        result.record.signedRecipientWrap.id,
        result.record.signedSelfWrap?.id,
      ])

      if (testCase.retryable) {
        const retriedIds: string[] = []
        const retried = await issueOrganizerReadyReceipt({
          merchantPubkey: MERCHANT,
          order: sourceOrder,
          paymentAuthenticated: true,
          market: market(),
          signer: {} as never,
          storage,
          transport: {
            recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
            senderInboxRelays: senderRelays,
            publishFn: (async (event, options) => {
              retriedIds.push(event.id)
              const relays = options.exclusiveRelayUrls ?? []
              return plannerResult({
                attempted: relays,
                successful: relays,
                failed: [],
              })
            }) as never,
          },
        })
        expect(retriedIds).toEqual([result.record.signedSelfWrap.id])
        expect(retried.record).toEqual(result.record)
        expect(eventMarketHandoffDeliveryNeedsRetry(retried)).toBe(false)
      }
    }
  })

  it("records zero recipient ACKs and bounded failed-target counts", async () => {
    const storage = new MemoryStorage()
    const recipientRelays = [
      "wss://organizer-primary.relay.dev",
      "wss://organizer-backup.relay.dev",
    ]
    const diagnostics = plannerResult({
      attempted: recipientRelays,
      successful: [],
      failed: recipientRelays,
    })

    await expect(
      issueOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        order: order(),
        paymentAuthenticated: true,
        market: market(),
        signer: merchantSigner,
        storage,
        transport: {
          recipientInboxRelays: recipientRelays,
          senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
          giftWrapFn: (async (_rumor, recipient) =>
            ndkWrap(recipient.pubkey)) as never,
          publishFn: (async () => {
            throw new RelayPublishDiagnosticsError(
              "No recipient relay acknowledged",
              diagnostics,
              new Error("relay delivery failed")
            )
          }) as never,
        },
      })
    ).rejects.toThrow("No recipient relay acknowledged")

    const [stored] = loadEventMarketHandoffDeliveries(MERCHANT, storage)
    expect(stored?.recipient).toEqual({
      status: "zero_ack",
      acknowledgedCount: 0,
      failedCount: 2,
    })
    expect(stored?.selfCopy.status).toBe("pending")
    expect(stored && eventMarketHandoffDeliveryNeedsRetry(stored)).toBe(true)
  })

  it("exposes self-copy failure and reloads the exact wraps for retry", async () => {
    const storage = new MemoryStorage()
    const firstPublishedIds: string[] = []
    const initial = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: order(),
      paymentAuthenticated: true,
      market: market(),
      signer: merchantSigner,
      storage,
      transport: {
        recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        giftWrapFn: (async (_rumor, recipient) =>
          ndkWrap(recipient.pubkey)) as never,
        publishFn: (async (event, options) => {
          firstPublishedIds.push(event.id)
          if (options.recipientPubkeys?.[0] === MERCHANT) {
            throw new Error("self-copy unavailable")
          }
          const relays = options.exclusiveRelayUrls ?? []
          return plannerResult({
            attempted: relays,
            successful: relays,
            failed: [],
          })
        }) as never,
      },
    })

    expect(initial.recipient.status).toBe("full_success")
    expect(initial.selfCopy.status).toBe("failed")
    expect(eventMarketHandoffDeliveryNeedsRetry(initial)).toBe(true)

    const reloaded = loadEventMarketHandoffDeliveries(MERCHANT, storage)[0]!
    const retriedIds: string[] = []
    const retried = await issueOrganizerReadyReceipt({
      merchantPubkey: MERCHANT,
      order: order(),
      paymentAuthenticated: true,
      market: market(),
      signer: {} as never,
      storage,
      transport: {
        recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
        senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
        publishFn: (async (event, options) => {
          retriedIds.push(event.id)
          const relays = options.exclusiveRelayUrls ?? []
          return plannerResult({
            attempted: relays,
            successful: relays,
            failed: [],
          })
        }) as never,
      },
    })

    expect(firstPublishedIds).toEqual([
      reloaded.record.signedRecipientWrap.id,
      reloaded.record.signedSelfWrap?.id,
    ])
    expect(retriedIds).toEqual([reloaded.record.signedSelfWrap.id])
    expect(retried.record.signedRecipientWrap).toEqual(
      reloaded.record.signedRecipientWrap
    )
    expect(retried.record.signedSelfWrap).toEqual(
      reloaded.record.signedSelfWrap
    )
    expect(retried.recipient.status).toBe("full_success")
    expect(retried.selfCopy.status).toBe("full_success")
    expect(eventMarketHandoffDeliveryNeedsRetry(retried)).toBe(false)
  })

  it("aborts before storage mutation and relay I/O when retry capacity is full", async () => {
    const storage = new MemoryStorage()
    const template = readyDelivery()
    seedDeliveries(
      storage,
      Array.from({ length: 100 }, (_, index) =>
        deliveryWithIdentity(
          template,
          index,
          {
            status: "zero_ack",
            acknowledgedCount: 0,
            failedCount: 1,
          },
          {
            status: "pending",
            acknowledgedCount: 0,
            failedCount: 0,
          }
        )
      )
    )
    const before = storage.serialized()
    let relayPublishCount = 0

    await expect(
      issueOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        order: order(2_000, "capacity-order-101"),
        paymentAuthenticated: true,
        market: market(),
        signer: merchantSigner,
        storage,
        transport: {
          recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
          senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
          giftWrapFn: (async (_rumor, recipient) =>
            ndkWrap(recipient.pubkey)) as never,
          publishFn: (async (_event, options) => {
            relayPublishCount += 1
            const relays = options.exclusiveRelayUrls ?? []
            return plannerResult({
              attempted: relays,
              successful: relays,
              failed: [],
            })
          }) as never,
        },
      })
    ).rejects.toThrow("could not be saved")

    expect(relayPublishCount).toBe(0)
    expect(storage.serialized()).toBe(before)
    expect(loadEventMarketHandoffDeliveries(MERCHANT, storage)).toHaveLength(
      100
    )
  })

  it("protects delivered ready descriptors at capacity before relay I/O", async () => {
    const storage = new MemoryStorage()
    const template = readyDelivery()
    seedDeliveries(
      storage,
      Array.from({ length: 100 }, (_, index) =>
        deliveryWithIdentity(template, index)
      )
    )
    const before = storage.serialized()
    let relayPublishCount = 0

    await expect(
      issueOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        order: order(2_000, "protected-ready-capacity-order"),
        paymentAuthenticated: true,
        market: market(),
        signer: merchantSigner,
        storage,
        transport: {
          recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
          senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
          giftWrapFn: (async (_rumor, recipient) =>
            ndkWrap(recipient.pubkey)) as never,
          publishFn: (async (_event, options) => {
            relayPublishCount += 1
            const relays = options.exclusiveRelayUrls ?? []
            return plannerResult({
              attempted: relays,
              successful: relays,
              failed: [],
            })
          }) as never,
        },
      })
    ).rejects.toThrow("could not be saved")

    expect(relayPublishCount).toBe(0)
    expect(storage.serialized()).toBe(before)
    expect(loadEventMarketHandoffDeliveries(MERCHANT, storage)).toHaveLength(
      100
    )
  })

  it("evicts only terminal clean history when a retryable record needs room", () => {
    const storage = new MemoryStorage()
    const template = readyDelivery()
    const terminal = revocationDelivery(template)
    seedDeliveries(storage, [
      terminal,
      ...Array.from({ length: 99 }, (_, index) =>
        deliveryWithIdentity(template, index + 1, {
          status: "partial_success",
          acknowledgedCount: 1,
          failedCount: 1,
        })
      ),
    ])
    const incoming = deliveryWithIdentity(
      template,
      101,
      {
        status: "zero_ack",
        acknowledgedCount: 0,
        failedCount: 1,
      },
      template.selfCopy
    )
    rememberEventMarketHandoffDelivery(MERCHANT, incoming, storage)

    const reloaded = loadEventMarketHandoffDeliveries(MERCHANT, storage)
    expect(reloaded).toHaveLength(100)
    expect(
      reloaded.some(
        (delivery) =>
          delivery.record.orderCorrelationRef ===
          terminal.record.orderCorrelationRef
      )
    ).toBe(false)
    expect(reloaded.every(eventMarketHandoffDeliveryNeedsRetry)).toBe(true)
  })

  it("rejects cross-account and structurally tampered outbox records", () => {
    const storage = new MemoryStorage()
    const delivery = readyDelivery()

    expect(() =>
      rememberEventMarketHandoffDelivery(OTHER, delivery, storage)
    ).toThrow("invalid")
    expect(() =>
      rememberEventMarketHandoffDelivery(
        MERCHANT,
        {
          ...delivery,
          record: { ...delivery.record, rumorId: "6".repeat(64) },
        },
        storage
      )
    ).toThrow("invalid")
    expect(() =>
      rememberEventMarketHandoffDelivery(
        MERCHANT,
        {
          ...delivery,
          recipient: {
            status: "full_success",
            acknowledgedCount: 0,
            failedCount: 0,
          },
        },
        storage
      )
    ).toThrow("invalid")
  })

  it("recognizes a delivered revocation after reload without recreating it", async () => {
    const storage = new MemoryStorage()
    const ready = readyDelivery()
    rememberEventMarketHandoffDelivery(MERCHANT, ready, storage)
    rememberEventMarketHandoffDelivery(
      MERCHANT,
      revocationDelivery(ready),
      storage
    )

    await expect(
      revokeOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        orderId: order().id,
        signer: {} as never,
        matchingAckReceiptIds: new Set(),
        evidenceReadStale: false,
        storage,
      })
    ).resolves.toBe("revoked")
  })

  it("persists initial revocation self-copy zero and partial diagnostics", async () => {
    for (const testCase of [
      {
        name: "zero",
        successfulCount: 0,
        expected: {
          status: "zero_ack" as const,
          acknowledgedCount: 0,
          failedCount: 2,
        },
      },
      {
        name: "partial",
        successfulCount: 1,
        expected: {
          status: "partial_success" as const,
          acknowledgedCount: 1,
          failedCount: 1,
        },
      },
    ]) {
      const storage = new MemoryStorage()
      const sourceOrder = order(2_000, `revocation-self-${testCase.name}`)
      const ready = readyDelivery(sourceOrder)
      const readyRumor = buildEventMarketReadyReceiptRumor(
        buildOrganizerReadyReceiptPayload(
          sourceOrder,
          market(),
          "paid",
          1_800_000_000
        )
      )
      rememberEventMarketHandoffDelivery(MERCHANT, ready, storage)
      const senderRelays = [
        "wss://merchant-primary.relay.dev",
        "wss://merchant-backup.relay.dev",
      ]
      const publishedIds: string[] = []

      const revocationAttempt = revokeOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        orderId: sourceOrder.id,
        signer: merchantSigner,
        giftUnwrap: async () => readyRumor,
        matchingAckReceiptIds: new Set(),
        evidenceReadStale: false,
        storage,
        transport: {
          recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
          senderInboxRelays: senderRelays,
          giftWrapFn: (async (_rumor, recipient) =>
            ndkWrap(recipient.pubkey)) as never,
          publishFn: (async (event, options) => {
            publishedIds.push(event.id)
            const relays = options.exclusiveRelayUrls ?? []
            if (options.recipientPubkeys?.[0] !== MERCHANT) {
              return plannerResult({
                attempted: relays,
                successful: relays,
                failed: [],
              })
            }
            return plannerResult({
              attempted: relays,
              successful: relays.slice(0, testCase.successfulCount),
              failed: relays.slice(testCase.successfulCount),
            })
          }) as never,
        },
      })
      if (testCase.successfulCount === 0) {
        await expect(revocationAttempt).rejects.toThrow(
          "Cancellation remains blocked"
        )
      } else {
        await expect(revocationAttempt).resolves.toBe("revoked")
      }

      const revocation = loadEventMarketHandoffDeliveries(
        MERCHANT,
        storage
      ).find(
        (delivery) =>
          delivery.record.messageType === "organizer_fulfillment_revocation"
      )
      expect(revocation?.selfCopy).toEqual(
        testCase.successfulCount === 0
          ? testCase.expected
          : {
              status: "full_success",
              acknowledgedCount: 2,
              failedCount: 0,
            }
      )
      expect(
        revocation && eventMarketHandoffDeliveryNeedsRetry(revocation)
      ).toBe(testCase.successfulCount === 0)
      expect(
        storage
          .snapshots()
          .some((snapshot) =>
            snapshot.includes(`"status":"${testCase.expected.status}"`)
          )
      ).toBe(true)
      expect(publishedIds).toEqual([
        revocation!.record.signedRecipientWrap.id,
        revocation!.record.signedSelfWrap.id,
        revocation!.record.signedSelfWrap.id,
      ])
    }
  })

  it("replaces only its matching ready descriptor when revoking at capacity", async () => {
    const storage = new MemoryStorage()
    const sourceOrder = order(2_000, "capacity-revocation-order")
    const target = readyDelivery(sourceOrder)
    const unrelated = Array.from({ length: 99 }, (_, index) =>
      deliveryWithIdentity(readyDelivery(), index + 1)
    )
    seedDeliveries(storage, [target, ...unrelated])
    const unrelatedReadyIds = new Set(
      unrelated.map((delivery) => delivery.record.readyReceiptId)
    )
    const readyRumor = buildEventMarketReadyReceiptRumor(
      buildOrganizerReadyReceiptPayload(
        sourceOrder,
        market(),
        "paid",
        1_800_000_000
      )
    )
    const publishedIds: string[] = []

    await expect(
      revokeOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        orderId: sourceOrder.id,
        signer: merchantSigner,
        giftUnwrap: async () => readyRumor,
        matchingAckReceiptIds: new Set(),
        evidenceReadStale: false,
        storage,
        transport: {
          recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
          senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
          giftWrapFn: (async (_rumor, recipient) =>
            ndkWrap(recipient.pubkey)) as never,
          publishFn: (async (event, options) => {
            publishedIds.push(event.id)
            const relays = options.exclusiveRelayUrls ?? []
            return plannerResult({
              attempted: relays,
              successful: relays,
              failed: [],
            })
          }) as never,
        },
      })
    ).resolves.toBe("revoked")

    const stored = loadEventMarketHandoffDeliveries(MERCHANT, storage)
    expect(stored).toHaveLength(100)
    expect(
      stored.some(
        (delivery) =>
          delivery.record.messageType === "organizer_fulfillment_receipt" &&
          delivery.record.readyReceiptId === target.record.readyReceiptId
      )
    ).toBe(false)
    expect(
      stored.find(
        (delivery) =>
          delivery.record.messageType === "organizer_fulfillment_revocation" &&
          delivery.record.readyReceiptId === target.record.readyReceiptId
      )?.record.orderCorrelationRef
    ).toBe(target.record.orderCorrelationRef)
    const revocation = stored.find(
      (delivery) =>
        delivery.record.messageType === "organizer_fulfillment_revocation" &&
        delivery.record.readyReceiptId === target.record.readyReceiptId
    )!
    expect(publishedIds).toEqual([
      revocation.record.signedRecipientWrap.id,
      revocation.record.signedSelfWrap?.id,
    ])
    expect(
      stored.filter(
        (delivery) =>
          delivery.record.messageType === "organizer_fulfillment_receipt" &&
          unrelatedReadyIds.has(delivery.record.readyReceiptId)
      )
    ).toHaveLength(99)

    let reissuePublishCount = 0
    await expect(
      issueOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        order: sourceOrder,
        paymentAuthenticated: true,
        market: market(),
        signer: merchantSigner,
        storage,
        transport: {
          publishFn: (async () => {
            reissuePublishCount += 1
            throw new Error("should not publish")
          }) as never,
        },
      })
    ).rejects.toThrow("was revoked")
    expect(reissuePublishCount).toBe(0)
  }, 15_000)

  it("retries existing partial and self-copy-failed revocations exactly", async () => {
    for (const retryState of [
      {
        recipient: {
          status: "partial_success" as const,
          acknowledgedCount: 1,
          failedCount: 1,
        },
        selfCopy: {
          status: "accepted" as const,
          acknowledgedCount: 0,
          failedCount: 0,
        },
      },
      {
        recipient: {
          status: "full_success" as const,
          acknowledgedCount: 1,
          failedCount: 0,
        },
        selfCopy: {
          status: "failed" as const,
          acknowledgedCount: 0,
          failedCount: 1,
        },
      },
    ]) {
      const storage = new MemoryStorage()
      const ready = readyDelivery()
      const revocation = withDeliveryState(
        revocationDelivery(ready),
        retryState.recipient,
        retryState.selfCopy
      )
      rememberEventMarketHandoffDelivery(MERCHANT, ready, storage)
      rememberEventMarketHandoffDelivery(MERCHANT, revocation, storage)
      const publishedIds: string[] = []

      await expect(
        revokeOrganizerReadyReceipt({
          merchantPubkey: MERCHANT,
          orderId: order().id,
          signer: {} as never,
          matchingAckReceiptIds: new Set(),
          evidenceReadStale: false,
          storage,
          transport: {
            recipientInboxRelays: ["wss://organizer-inbox.relay.dev"],
            senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
            publishFn: (async (event, options) => {
              publishedIds.push(event.id)
              const relays = options.exclusiveRelayUrls ?? []
              return plannerResult({
                attempted: relays,
                successful: relays,
                failed: [],
              })
            }) as never,
          },
        })
      ).resolves.toBe("revoked")

      expect(publishedIds).toEqual([
        revocation.record.signedRecipientWrap.id,
        revocation.record.signedSelfWrap?.id,
      ])
      const reloaded = loadEventMarketHandoffDeliveries(MERCHANT, storage).find(
        (delivery) =>
          delivery.record.messageType === "organizer_fulfillment_revocation"
      )!
      expect(JSON.stringify(reloaded.record)).toBe(
        JSON.stringify(revocation.record)
      )
      expect(eventMarketHandoffDeliveryNeedsRetry(reloaded)).toBe(false)
    }
  })

  it("keeps cancellation blocked while an exact revocation retry remains degraded", async () => {
    for (const failureLeg of ["recipient", "self"] as const) {
      const storage = new MemoryStorage()
      const ready = readyDelivery()
      const revocation = {
        ...revocationDelivery(ready),
        recipient: {
          status: "partial_success" as const,
          acknowledgedCount: 1,
          failedCount: 1,
        },
      }
      rememberEventMarketHandoffDelivery(MERCHANT, ready, storage)
      rememberEventMarketHandoffDelivery(MERCHANT, revocation, storage)

      await expect(
        revokeOrganizerReadyReceipt({
          merchantPubkey: MERCHANT,
          orderId: order().id,
          signer: {} as never,
          matchingAckReceiptIds: new Set(),
          evidenceReadStale: false,
          storage,
          transport: {
            recipientInboxRelays: [
              "wss://organizer-primary.relay.dev",
              "wss://organizer-backup.relay.dev",
            ],
            senderInboxRelays: ["wss://merchant-inbox.relay.dev"],
            publishFn: (async (_event, options) => {
              const relays = options.exclusiveRelayUrls ?? []
              if (
                failureLeg === "self" &&
                options.recipientPubkeys?.[0] === MERCHANT
              ) {
                throw new Error("self copy failed")
              }
              return plannerResult({
                attempted: relays,
                successful:
                  failureLeg === "recipient" &&
                  options.recipientPubkeys?.[0] === ORGANIZER
                    ? relays.slice(0, 1)
                    : relays,
                failed:
                  failureLeg === "recipient" &&
                  options.recipientPubkeys?.[0] === ORGANIZER
                    ? relays.slice(1)
                    : [],
              })
            }) as never,
          },
        })
      ).rejects.toThrow("Cancellation remains blocked")

      const reloaded = loadEventMarketHandoffDeliveries(MERCHANT, storage).find(
        (delivery) =>
          delivery.record.messageType === "organizer_fulfillment_revocation"
      )!
      expect(eventMarketHandoffDeliveryNeedsRetry(reloaded)).toBe(true)
      expect(reloaded.record.signedRecipientWrap.id).toBe(
        revocation.record.signedRecipientWrap.id
      )
    }
  })

  it("blocks cancellation when a scoped handed-out acknowledgement exists", async () => {
    const storage = new MemoryStorage()
    const delivery = readyDelivery()
    rememberEventMarketHandoffDelivery(MERCHANT, delivery, storage)

    await expect(
      revokeOrganizerReadyReceipt({
        merchantPubkey: MERCHANT,
        orderId: order().id,
        signer: {} as never,
        matchingAckReceiptIds: new Set([delivery.record.readyReceiptId]),
        evidenceReadStale: false,
        storage,
      })
    ).rejects.toThrow("already marked this order handed out")
  })
})

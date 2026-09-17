import { describe, expect, it } from "bun:test"
import type {
  MerchantConversationSummary,
  ParsedOrderMessage,
  ProductSchema,
  ProductsByIdsResult,
} from "@conduit/core"
import type { MerchantOrganizerEventMarket } from "../apps/merchant/src/lib/event-market"
import {
  checkpointMerchantEventHandoffOrders,
  readMerchantEventHandoffChangeSource,
  type MerchantEventHandoffChangeRuntimeDependencies,
} from "../apps/merchant/src/lib/merchant-event-handoff-change-runtime"

const MERCHANT = "a".repeat(64)
const ORGANIZER = "b".repeat(64)
const BUYER = "c".repeat(64)
const PRODUCT = `30402:${MERCHANT}:coffee`
const COLLECTION = `30405:${ORGANIZER}:market`
const PRODUCT_EVENT_ID = "d".repeat(64)

function product(): ProductSchema {
  return {
    id: PRODUCT,
    pubkey: MERCHANT,
    title: "Coffee",
    price: 1_000,
    currency: "SAT",
    type: "simple",
    specifications: [],
    format: "physical",
    shippingOptionId: `30406:${MERCHANT}:market-booth`,
    shippingOptionRefs: [{ coordinate: `30406:${MERCHANT}:market-booth` }],
    collectionRefs: [COLLECTION],
    canonicalShippingResolved: false,
    visibility: "public",
    stock: 5,
    images: [{ url: "https://example.com/coffee.jpg" }],
    tags: [],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

function market(): MerchantOrganizerEventMarket {
  return {
    state: "active",
    organizerPubkey: ORGANIZER,
    collectionCoordinate: COLLECTION,
    calendarCoordinate: `31923:${ORGANIZER}:market`,
    naddr: "naddr1market",
    title: "Market",
    calendarKind: 31923,
    start: 1_800_000_000,
    calendarCreatedAt: 10,
    calendarEventId: "1".repeat(64),
    collectionCreatedAt: 11,
    collectionEventId: "2".repeat(64),
    productCoordinates: [PRODUCT],
    participation: [
      {
        productCoordinate: PRODUCT,
        eventId: PRODUCT_EVENT_ID,
        createdAt: 1_000,
        title: "Coffee",
        merchantPubkey: MERCHANT,
        fulfillmentStatus: "resolved",
        pickupCoordinate: `30406:${MERCHANT}:market-booth`,
        pickupAuthorPubkey: MERCHANT,
        handoffMode: "merchant_handoff",
        handlerPubkey: MERCHANT,
        status: "accepted",
      },
    ],
    source: {},
  } as unknown as MerchantOrganizerEventMarket
}

function productsResult(
  overrides: {
    degraded?: boolean
    eventId?: string
    includeRecord?: boolean
  } = {}
): ProductsByIdsResult {
  return {
    data:
      overrides.includeRecord === false
        ? []
        : [
            {
              product: product(),
              eventId: overrides.eventId ?? PRODUCT_EVENT_ID,
              addressId: PRODUCT,
              dTag: "coffee",
              eventCreatedAt: 1_000,
            },
          ],
    meta: {
      source: "commerce",
      degraded: overrides.degraded ?? false,
      stale: false,
      capabilities: {
        sortModes: [],
        textSearch: false,
        protectedSummaries: false,
        canonicalFreshness: true,
        cursorPagination: false,
      },
      fetchedAt: 1,
    },
    diagnostics: [
      {
        productId: PRODUCT,
        addressId: PRODUCT,
        issue: null,
        coverage: { listing: "complete", deletion: "complete" },
      },
    ],
  }
}

function orderConversation(productId = PRODUCT): MerchantConversationSummary {
  const message = {
    id: "order-message",
    orderId: "order-1",
    type: "order",
    createdAt: 1,
    senderPubkey: BUYER,
    recipientPubkey: MERCHANT,
    rawContent: "",
    payload: {
      id: "order-1",
      buyerPubkey: BUYER,
      merchantPubkey: MERCHANT,
      items: [
        {
          productId,
          title: "Coffee",
          format: "physical",
          quantity: 1,
          priceAtPurchase: 1_000,
          currency: "SATS",
        },
      ],
      subtotal: 1_000,
      currency: "SATS",
      createdAt: 1,
    },
  } as ParsedOrderMessage
  return {
    id: "order-1",
    orderId: "order-1",
    buyerPubkey: BUYER,
    merchantPubkey: MERCHANT,
    latestAt: 1,
    latestType: "order",
    status: null,
    totalSummary: "1,000 SATS",
    preview: "Order",
    messageCount: 1,
    messages: [message],
    context: "complete",
  }
}

function dependencies(
  input: {
    market?: MerchantOrganizerEventMarket
    products?: ProductsByIdsResult
    conversations?: MerchantConversationSummary[]
    inboxComplete?: boolean
    onCheckpoint?: (orderId: string) => void
    onConversationLimit?: (limit: number | undefined) => void
  } = {}
): MerchantEventHandoffChangeRuntimeDependencies {
  return {
    resolveMarket: async () => input.market ?? market(),
    getProducts: async () => input.products ?? productsResult(),
    getConversations: async (query) => {
      input.onConversationLimit?.(query.limit)
      return {
        data: input.conversations ?? [],
        meta: {
          source: "commerce",
          degraded: input.inboxComplete === false,
          stale: false,
          capabilities: {
            sortModes: [],
            textSearch: false,
            protectedSummaries: true,
            canonicalFreshness: true,
            cursorPagination: false,
          },
          fetchedAt: 1,
          inbox: {
            declarationState: "declared",
            coverage: input.inboxComplete === false ? "partial" : "complete",
            readSource: "declared_relays",
          },
        },
      }
    },
    checkpointOrder: async ({ orderId }) => {
      input.onCheckpoint?.(orderId)
      return { status: "verified" } as Awaited<
        ReturnType<
          MerchantEventHandoffChangeRuntimeDependencies["checkpointOrder"]
        >
      >
    },
  } as MerchantEventHandoffChangeRuntimeDependencies
}

describe("merchant event handoff change runtime", () => {
  it("reads one exact current revision for every merchant event listing", async () => {
    const result = await readMerchantEventHandoffChangeSource(
      {
        merchantPubkey: MERCHANT,
        marketReference: "naddr1market",
        authenticatedPubkey: MERCHANT,
      },
      dependencies()
    )

    expect(result.listings).toEqual([
      {
        eventId: PRODUCT_EVENT_ID,
        createdAt: 1_000,
        product: product(),
      },
    ])
  })

  it("refuses a partial product read before an arrangement-wide mutation", async () => {
    expect(
      readMerchantEventHandoffChangeSource(
        {
          merchantPubkey: MERCHANT,
          marketReference: "naddr1market",
          authenticatedPubkey: MERCHANT,
        },
        dependencies({ products: productsResult({ degraded: true }) })
      )
    ).rejects.toThrow("Complete current product evidence")
  })

  it("checkpoints every affected existing order and leaves unrelated orders alone", async () => {
    const checkpointed: string[] = []
    let requestedLimit: number | undefined
    const result = await checkpointMerchantEventHandoffOrders(
      {
        merchantPubkey: MERCHANT,
        authenticatedPubkey: MERCHANT,
        affectedListings: [
          {
            eventId: PRODUCT_EVENT_ID,
            createdAt: 1_000,
            product: product(),
            productCoordinate: PRODUCT,
            status: "accepted",
            previousHandoffMode: "merchant_handoff",
          },
        ],
      },
      dependencies({
        conversations: [
          orderConversation(),
          {
            ...orderConversation(`30402:${MERCHANT}:unrelated`),
            id: "order-2",
            orderId: "order-2",
          },
        ],
        onCheckpoint: (orderId) => checkpointed.push(orderId),
        onConversationLimit: (limit) => {
          requestedLimit = limit
        },
      })
    )

    expect(result).toEqual({ affectedOrderCount: 1 })
    expect(checkpointed).toEqual(["order-1"])
    expect(requestedLimit).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("blocks before mutation when the private order inbox is incomplete", async () => {
    expect(
      checkpointMerchantEventHandoffOrders(
        {
          merchantPubkey: MERCHANT,
          authenticatedPubkey: MERCHANT,
          affectedListings: [],
        },
        dependencies({ inboxComplete: false })
      )
    ).rejects.toThrow("complete merchant order inbox")
  })
})

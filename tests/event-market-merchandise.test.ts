import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"

import {
  __resetEventMarketMerchandiseTestOverrides,
  __setEventMarketMerchandiseTestOverrides,
  EVENT_KINDS,
  eventMarketReadyReceiptSchema,
  getEventMarketReceiptMerchandise,
  getEventMarketPickupClaimRef,
  resolveEventMarketReceiptMerchandiseEvidence,
  type EventMarketReadyReceiptSchema,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"

const MERCHANT_SECRET = new Uint8Array(32).fill(41)
const ORGANIZER_SECRET = new Uint8Array(32).fill(42)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const COLLECTION = `30405:${ORGANIZER}:market`
const CALENDAR = `31923:${ORGANIZER}:market-day`
const PICKUP = `30406:${ORGANIZER}:organizer-pickup`
const CREATED_AT = 1_700_000_000
const RELAY_URL = "wss://merchant-products.example"

function productEvent(dTag: string, title: string): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind: EVENT_KINDS.PRODUCT,
      created_at: CREATED_AT,
      tags: [
        ["d", dTag],
        ["title", title],
        ["price", "1000", "SATS"],
        ["a", COLLECTION],
        ["shipping_option", PICKUP],
      ],
      content: title,
    },
    MERCHANT_SECRET
  ) as SignedPublicNostrEvent
}

function receiptFor(
  products: readonly SignedPublicNostrEvent[]
): EventMarketReadyReceiptSchema {
  return eventMarketReadyReceiptSchema.parse({
    version: 1,
    type: "organizer_fulfillment_receipt",
    state: "ready_for_pickup",
    claimRef: getEventMarketPickupClaimRef({
      orderId: "private-order-id",
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
    items: products.map((product) => ({
      product: {
        coordinate: `${EVENT_KINDS.PRODUCT}:${MERCHANT}:${product.tags.find((tag) => tag[0] === "d")![1]}`,
        eventId: product.id,
        createdAt: product.created_at * 1_000,
      },
      quantity: 1,
      variants: [],
    })),
    issuedAt: CREATED_AT + 10,
  })
}

function completeCoverage() {
  return {
    attemptedRelayCount: 1,
    completeRelayCount: 1,
    partialRelayCount: 0,
    failedRelayCount: 0,
  }
}

afterEach(() => {
  __resetEventMarketMerchandiseTestOverrides()
})

describe("event-market organizer merchandise evidence", () => {
  it("returns only display-safe title from the exact signed product revision", () => {
    const product = productEvent("coffee", "Fresh coffee")
    const resolution = resolveEventMarketReceiptMerchandiseEvidence({
      receipt: receiptFor([product]),
      events: [product],
      coverage: completeCoverage(),
      sourceRelayUrlsById: new Map([[product.id, [RELAY_URL]]]),
    })

    expect(resolution).toMatchObject({
      state: "verified",
      items: [
        {
          state: "verified",
          title: "Fresh coffee",
          quantity: 1,
          sourceRelayUrls: [RELAY_URL],
        },
      ],
    })
    expect(JSON.stringify(resolution)).not.toContain("1000")
  })

  it("fails closed on invalid exact metadata, signature, and missing coverage", () => {
    const product = productEvent("coffee", "Fresh coffee")
    const receipt = receiptFor([product])
    const wrongTimestamp = receiptFor([product])
    wrongTimestamp.items[0]!.product.createdAt += 1_000
    expect(
      resolveEventMarketReceiptMerchandiseEvidence({
        receipt: wrongTimestamp,
        events: [product],
        coverage: completeCoverage(),
      }).state
    ).toBe("malformed")

    const badSignature = { ...product, sig: "0".repeat(128) }
    expect(
      resolveEventMarketReceiptMerchandiseEvidence({
        receipt,
        events: [badSignature],
        coverage: completeCoverage(),
      }).state
    ).toBe("malformed")

    expect(
      resolveEventMarketReceiptMerchandiseEvidence({
        receipt,
        events: [],
        coverage: completeCoverage(),
      }).state
    ).toBe("missing")
    expect(
      resolveEventMarketReceiptMerchandiseEvidence({
        receipt,
        events: [],
        coverage: {
          attemptedRelayCount: 1,
          completeRelayCount: 0,
          partialRelayCount: 0,
          failedRelayCount: 1,
        },
      }).state
    ).toBe("unavailable")
  })

  it("uses one exact deletion target per bounded query so sibling floods cannot starve evidence", async () => {
    const sibling = productEvent("sibling", "Sibling item")
    const target = productEvent("target", "Target item")
    const receipt = receiptFor([sibling, target])
    const siblingFlood = Array.from({ length: 401 }, (_, index) =>
      finalizeEvent(
        {
          kind: EVENT_KINDS.DELETION,
          created_at: CREATED_AT + index + 2,
          tags: [
            ["e", sibling.id],
            ["k", String(EVENT_KINDS.PRODUCT)],
          ],
          content: "",
        },
        MERCHANT_SECRET
      )
    )
    const targetDeletion = finalizeEvent(
      {
        kind: EVENT_KINDS.DELETION,
        created_at: CREATED_AT + 1,
        tags: [
          ["e", target.id],
          ["k", String(EVENT_KINDS.PRODUCT)],
        ],
        content: "",
      },
      MERCHANT_SECRET
    )
    const deletions = [...siblingFlood, targetDeletion]
    const observedFilters: NDKFilter[] = []
    let active = 0
    let maxActive = 0

    __setEventMarketMerchandiseTestOverrides({
      getRelayLists: (async () =>
        new Map([
          [
            MERCHANT,
            {
              pubkey: MERCHANT,
              readRelayUrls: [],
              writeRelayUrls: [RELAY_URL],
              eventCreatedAt: CREATED_AT,
              lookupState: "network" as const,
              cachedAt: Date.now(),
            },
          ],
        ])) as never,
      fetchEventsFanoutDetailed: (async (filter, options) => {
        observedFilters.push(filter)
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        try {
          let events: SignedPublicNostrEvent[] = []
          if (filter.kinds?.includes(EVENT_KINDS.PRODUCT as never)) {
            events = [sibling, target]
          } else if (filter["#e"]?.length) {
            const targets = new Set(filter["#e"])
            events = deletions
              .filter((event) =>
                event.tags.some((tag) => tag[0] === "e" && targets.has(tag[1]!))
              )
              .sort((left, right) => right.created_at - left.created_at)
              .slice(0, filter.limit)
          }
          return {
            events: events.map((event) => new NDKEvent(undefined, event)),
            relays: options.relayUrls.map((relayUrl) => ({
              relayUrl,
              status: "success" as const,
              eventCount: events.length,
            })),
            eventsVerified: true,
          }
        } finally {
          active -= 1
        }
      }) as never,
    })

    const resolution = await getEventMarketReceiptMerchandise({ receipt })

    expect(maxActive).toBeLessThanOrEqual(4)
    expect(
      observedFilters
        .filter((filter) => filter["#e"])
        .every((filter) => filter["#e"]?.length === 1 && filter.limit === 4)
    ).toBe(true)
    expect(
      observedFilters
        .filter((filter) => filter["#a"])
        .every((filter) => filter["#a"]?.length === 1 && filter.limit === 4)
    ).toBe(true)
    expect(resolution.items.map((item) => item.state)).toEqual([
      "deleted",
      "deleted",
    ])
  })
})

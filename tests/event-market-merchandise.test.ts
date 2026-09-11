import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKFilter } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

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

const MERCHANT_SECRET = generateSecretKey()
const ORGANIZER_SECRET = generateSecretKey()
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
    paymentConfirmed: true,
    orderReady: true,
    releaseAuthorized: true,
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
    const receipt = receiptFor([product])
    const coverage = completeCoverage()
    const resolution = resolveEventMarketReceiptMerchandiseEvidence({
      receipt,
      events: [product],
      coverage,
      sourceRelayUrlsById: new Map([[product.id, [RELAY_URL]]]),
    })

    expect(resolution).toEqual({
      state: "verified",
      claimRef: receipt.claimRef,
      merchantPubkey: MERCHANT,
      organizerPubkey: ORGANIZER,
      items: [
        {
          state: "verified",
          product: receipt.items[0]!.product,
          title: "Fresh coffee",
          quantity: 1,
          sourceRelayUrls: [RELAY_URL],
        },
      ],
      coverage,
    })
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

  it("keeps owner read ws authority separate from remote merchant hints", async () => {
    const product = productEvent("coffee", "Fresh coffee")
    const ownerRelay = "ws://owner-network.example:4848"
    const remoteRelay = "ws://remote-merchant.example:4848"
    const observedRelayUrls: string[] = []
    const observedOwnerSelectedRelayUrls: string[] = []
    const observedAuthenticatedPubkeys: Array<string | null | undefined> = []
    const observedShouldContinue: Array<(() => boolean) | undefined> = []
    const shouldContinue = () => true
    let relayListAuthenticatedPubkey: string | null | undefined
    let relayListShouldContinue: (() => boolean) | undefined
    __setEventMarketMerchandiseTestOverrides({
      getRelayLists: (async (_pubkeys, options) => {
        relayListAuthenticatedPubkey = options?.authenticatedPubkey
        relayListShouldContinue = options?.shouldContinue
        return new Map([
          [
            MERCHANT,
            {
              pubkey: MERCHANT,
              readRelayUrls: [],
              writeRelayUrls: [remoteRelay],
              eventCreatedAt: CREATED_AT,
              lookupState: "network" as const,
              cachedAt: Date.now(),
            },
          ],
        ])
      }) as never,
      fetchEventsFanoutDetailed: (async (filter, options) => {
        observedRelayUrls.push(...options.relayUrls)
        observedOwnerSelectedRelayUrls.push(
          ...(options.ownerSelectedRelayUrls ?? [])
        )
        observedAuthenticatedPubkeys.push(options.authenticatedPubkey)
        observedShouldContinue.push(options.shouldContinue)
        const events = filter.kinds?.includes(EVENT_KINDS.PRODUCT as never)
          ? [product]
          : []
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: options.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      }) as never,
    })

    const resolution = await getEventMarketReceiptMerchandise({
      receipt: receiptFor([product]),
      authenticatedPubkey: ORGANIZER,
      shouldContinue,
      readAccountRelaySettingsPlanningSnapshot: async () => ({
        settings: {
          version: 1,
          updatedAt: 1,
          entries: [
            {
              url: ownerRelay,
              readEnabled: true,
              writeEnabled: false,
              section: "public",
              capabilities: {
                nip11: false,
                search: false,
                dm: false,
                auth: false,
                commerce: false,
              },
              warnings: {
                dmWithoutAuth: false,
                staleRelayInfo: false,
                unreachable: false,
                commercePartialSupport: false,
              },
            },
          ],
        },
        signedRelayListAuthoritative: true,
      }),
    })

    expect(resolution.state).toBe("verified")
    expect(observedRelayUrls).toContain(ownerRelay)
    expect(observedOwnerSelectedRelayUrls).toContain(ownerRelay)
    expect(observedRelayUrls).not.toContain(remoteRelay)
    expect(relayListAuthenticatedPubkey).toBe(ORGANIZER)
    expect(relayListShouldContinue).toBe(shouldContinue)
    expect(
      observedAuthenticatedPubkeys.every((value) => value === ORGANIZER)
    ).toBe(true)
    expect(
      observedShouldContinue.every((value) => value === shouldContinue)
    ).toBe(true)
  })

  it("does not infer owner ws authority from a disconnected receipt target", async () => {
    const product = productEvent("coffee", "Fresh coffee")
    const ownerRelay = "ws://owner-network.example:4848"
    const remoteMerchantRelay = "wss://merchant-products.vendor.dev"
    const observedRelayUrls: string[] = []
    const observedOwnerSelectedRelayUrls: string[] = []
    const observedAuthenticatedPubkeys: Array<string | null | undefined> = []
    let ownerSettingsReadCount = 0
    __setEventMarketMerchandiseTestOverrides({
      getRelayLists: (async () =>
        new Map([
          [
            MERCHANT,
            {
              pubkey: MERCHANT,
              readRelayUrls: [],
              writeRelayUrls: [remoteMerchantRelay],
              eventCreatedAt: CREATED_AT,
              lookupState: "network" as const,
              cachedAt: Date.now(),
            },
          ],
        ])) as never,
      fetchEventsFanoutDetailed: (async (filter, options) => {
        observedRelayUrls.push(...options.relayUrls)
        observedOwnerSelectedRelayUrls.push(
          ...(options.ownerSelectedRelayUrls ?? [])
        )
        observedAuthenticatedPubkeys.push(options.authenticatedPubkey)
        const events = filter.kinds?.includes(EVENT_KINDS.PRODUCT as never)
          ? [product]
          : []
        return {
          events: events.map((event) => new NDKEvent(undefined, event)),
          relays: options.relayUrls.map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: events.length,
          })),
          eventsVerified: true,
        }
      }) as never,
    })

    const resolution = await getEventMarketReceiptMerchandise({
      receipt: receiptFor([product]),
      readAccountRelaySettingsPlanningSnapshot: async () => {
        ownerSettingsReadCount += 1
        return {
          settings: {
            version: 1,
            updatedAt: 1,
            entries: [
              {
                url: ownerRelay,
                readEnabled: true,
                writeEnabled: false,
                section: "public",
                capabilities: {
                  nip11: false,
                  search: false,
                  dm: false,
                  auth: false,
                  commerce: false,
                },
                warnings: {
                  dmWithoutAuth: false,
                  staleRelayInfo: false,
                  unreachable: false,
                  commercePartialSupport: false,
                },
              },
            ],
          },
          signedRelayListAuthoritative: true,
        }
      },
    })

    expect(resolution.state).toBe("verified")
    expect(ownerSettingsReadCount).toBe(0)
    expect(observedRelayUrls).toContain(remoteMerchantRelay)
    expect(observedRelayUrls).not.toContain(ownerRelay)
    expect(observedOwnerSelectedRelayUrls).not.toContain(ownerRelay)
    expect(observedAuthenticatedPubkeys.every((value) => value == null)).toBe(
      true
    )
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

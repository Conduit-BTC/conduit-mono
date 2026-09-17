import { describe, expect, it } from "bun:test"
import type { ParsedEventMarketPickup } from "@conduit/core"
import type { MerchantOrganizerEventMarket } from "../apps/merchant/src/lib/event-market"
import {
  createMerchantEventHandoffPreference,
  ensureMerchantEventHandoffPreference,
  getMerchantEventPickupIdentity,
  loadMerchantEventHandoffPreference,
  resolveMerchantEventHandoffArrangement,
  type MerchantEventHandoffListingEvidence,
  type MerchantEventHandoffStorage,
} from "../apps/merchant/src/lib/merchant-event-handoff-arrangement"

const MERCHANT = "a".repeat(64)
const OTHER_MERCHANT = "c".repeat(64)
const ORGANIZER = "b".repeat(64)
const COLLECTION = `30405:${ORGANIZER}:community-market`
const ORGANIZER_PICKUP = `30406:${ORGANIZER}:organizer-desk`

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

function pickup(
  dTag: string,
  overrides: Partial<ParsedEventMarketPickup> = {}
): ParsedEventMarketPickup {
  return {
    coordinate: `30406:${MERCHANT}:${dTag}`,
    eventId: dTag.padEnd(64, "0").slice(0, 64),
    authorPubkey: MERCHANT,
    dTag,
    title: "Merchant pickup",
    content: "",
    price: 0,
    currency: "SAT",
    countries: ["US"],
    location: "Booth 12",
    createdAt: 1,
    evidenceState: "live",
    ...overrides,
  }
}

function market(
  input: {
    state?: MerchantOrganizerEventMarket["state"]
    organizerPickup?: boolean
    pickups?: ParsedEventMarketPickup[]
    participation?: MerchantOrganizerEventMarket["participation"]
  } = {}
): MerchantOrganizerEventMarket {
  const organizerPickup = input.organizerPickup ?? true
  return {
    state: input.state ?? "active",
    organizerPubkey: ORGANIZER,
    collectionCoordinate: COLLECTION,
    calendarCoordinate: `31923:${ORGANIZER}:community-market-calendar`,
    ...(organizerPickup ? { pickupCoordinate: ORGANIZER_PICKUP } : {}),
    pickupCoordinates: organizerPickup ? [ORGANIZER_PICKUP] : [],
    naddr: "naddr1example",
    title: "Community market",
    eventLocation: "Main hall",
    pickupCountry: "US",
    calendarKind: 31923,
    start: 1,
    productCoordinates: [],
    participation: input.participation ?? [],
    source: {
      state: input.state ?? "active",
      reference: COLLECTION,
      organizerPubkey: ORGANIZER,
      collectionCoordinate: COLLECTION,
      calendarCoordinate: `31923:${ORGANIZER}:community-market-calendar`,
      ...(organizerPickup ? { pickupCoordinate: ORGANIZER_PICKUP } : {}),
      pickups: input.pickups ?? [],
      organizerProductCoordinates: [],
      acceptedProductCoordinates: [],
      acceptedProductEvidence: [],
      organizerOnlyProductCoordinates: [],
      participationRequests: [],
      participationBudget: {
        state: "within_budget",
        targetCount: 0,
        targetLimit: 100,
      },
      pickupBudget: {
        state: "within_budget",
        targetCount: 0,
        targetLimit: 100,
      },
      coverage: {
        attemptedRelayCount: 1,
        completeRelayCount: input.state === "partial" ? 0 : 1,
        partialRelayCount: input.state === "partial" ? 1 : 0,
        failedRelayCount: 0,
      },
    },
  } as MerchantOrganizerEventMarket
}

function listing(
  dTag: string,
  pickupRecord: ParsedEventMarketPickup,
  mode: "merchant_handoff" | "organizer_handoff" = "merchant_handoff"
): MerchantEventHandoffListingEvidence {
  const handler = mode === "merchant_handoff" ? MERCHANT : ORGANIZER
  return {
    productCoordinate: `30402:${MERCHANT}:${dTag}`,
    merchantPubkey: MERCHANT,
    fulfillmentStatus: "resolved",
    pickupCoordinate:
      mode === "merchant_handoff" ? pickupRecord.coordinate : ORGANIZER_PICKUP,
    pickupAuthorPubkey: handler,
    handoffMode: mode,
    handlerPubkey: handler,
  }
}

describe("merchant/event handoff arrangement", () => {
  it("uses one deterministic merchant pickup identity per merchant and event", async () => {
    const first = await getMerchantEventPickupIdentity({
      merchantPubkey: MERCHANT,
      collectionCoordinate: COLLECTION,
    })
    const second = await getMerchantEventPickupIdentity({
      merchantPubkey: MERCHANT,
      collectionCoordinate: COLLECTION,
    })
    const otherEvent = await getMerchantEventPickupIdentity({
      merchantPubkey: MERCHANT,
      collectionCoordinate: `30405:${ORGANIZER}:other-market`,
    })

    expect(first).toEqual(second)
    expect(first.coordinate).toBe(`30406:${MERCHANT}:${first.dTag}`)
    expect(otherEvent.coordinate).not.toBe(first.coordinate)
  })

  it("stores the first choice by account and makes later products inherit it", async () => {
    const storage = new MemoryStorage()
    const eventMarket = market()
    const first = await ensureMerchantEventHandoffPreference({
      merchantPubkey: MERCHANT,
      market: eventMarket,
      requested: { mode: "organizer_handoff" },
      storage,
      now: 10,
    })
    const inherited = await ensureMerchantEventHandoffPreference({
      merchantPubkey: MERCHANT,
      market: eventMarket,
      requested: {
        mode: "merchant_handoff",
        merchantPickup: { location: "Different booth", country: "CA" },
      },
      storage,
      now: 20,
    })

    expect(first.mode).toBe("organizer_handoff")
    expect(inherited).toEqual(first)
    expect(
      loadMerchantEventHandoffPreference(OTHER_MERCHANT, COLLECTION, storage)
    ).toBeNull()
  })

  it("refuses organizer handoff when the organizer has no current offer", async () => {
    await expect(
      createMerchantEventHandoffPreference({
        merchantPubkey: MERCHANT,
        market: market({ organizerPickup: false }),
        mode: "organizer_handoff",
      })
    ).rejects.toThrow("not offering organizer handoff")
  })

  it("keeps partial evidence distinct from an unconfigured complete read", async () => {
    const unconfigured = await resolveMerchantEventHandoffArrangement({
      merchantPubkey: MERCHANT,
      market: market(),
    })
    const partial = await resolveMerchantEventHandoffArrangement({
      merchantPubkey: MERCHANT,
      market: market({ state: "partial" }),
    })

    expect(unconfigured.state).toBe("unconfigured")
    expect(partial).toMatchObject({
      state: "unresolved",
      coverage: "partial",
      reason: "partial_without_known_arrangement",
    })
  })

  it("classifies equivalent legacy pickup records separately from conflicts", async () => {
    const firstPickup = pickup("legacy-a")
    const secondPickup = pickup("legacy-b")
    const listings = [
      listing("coffee", firstPickup),
      listing("tea", secondPickup),
    ]
    const equivalent = await resolveMerchantEventHandoffArrangement({
      merchantPubkey: MERCHANT,
      market: market({ pickups: [firstPickup, secondPickup] }),
      listings,
    })
    const conflicting = await resolveMerchantEventHandoffArrangement({
      merchantPubkey: MERCHANT,
      market: market({
        pickups: [firstPickup, pickup("legacy-b", { location: "Lobby table" })],
      }),
      listings,
    })

    expect(equivalent).toMatchObject({
      state: "legacy_equivalent",
      pickupCoordinates: [firstPickup.coordinate, secondPickup.coordinate],
    })
    expect(conflicting).toMatchObject({
      state: "conflicting",
      reasons: ["different_merchant_pickup_terms"],
    })
  })

  it("surfaces mixed listing modes and an in-progress transition", async () => {
    const merchantPickup = pickup("merchant-booth")
    const listings = [
      listing("coffee", merchantPickup),
      listing("tea", merchantPickup, "organizer_handoff"),
    ]
    const conflict = await resolveMerchantEventHandoffArrangement({
      merchantPubkey: MERCHANT,
      market: market({ pickups: [merchantPickup] }),
      listings,
    })
    const transitioning = await resolveMerchantEventHandoffArrangement({
      merchantPubkey: MERCHANT,
      market: market({ pickups: [merchantPickup] }),
      listings,
      transition: {
        target: {
          mode: "organizer_handoff",
          handlerPubkey: ORGANIZER,
          pickupCoordinate: ORGANIZER_PICKUP,
        },
        listings: [
          {
            productCoordinate: listings[0]!.productCoordinate,
            status: "delivered",
          },
          {
            productCoordinate: listings[1]!.productCoordinate,
            status: "partial",
          },
        ],
      },
    })

    expect(conflict).toMatchObject({
      state: "conflicting",
      reasons: ["mixed_handoff_modes"],
    })
    expect(transitioning).toMatchObject({
      state: "transitioning",
      completedListingCount: 1,
      totalListingCount: 2,
    })
  })
})

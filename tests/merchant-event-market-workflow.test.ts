import { describe, expect, it } from "bun:test"
import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
} from "@conduit/core"
import {
  findOrganizerEventMarketByReference,
  findSavedOrganizerEventMarketReference,
  forgetOrganizerEventMarket,
  getDiscoveredEventMarketStorageKey,
  getOrganizerEventMarketDisplayState,
  getOrganizerEventMarketStorageKey,
  isPreferredOrganizerEventMarketListResolution,
  loadSavedDiscoveredEventMarkets,
  loadSavedOrganizerEventMarkets,
  rememberDiscoveredEventMarket,
  rememberOrganizerEventMarket,
  selectOrganizerEventMarketResolution,
  shouldResolveOrganizerEventMarketReference,
  updateOrganizerCollectionProducts,
} from "../apps/merchant/src/lib/event-market-workflow"
import {
  isParticipationHandoffVerified,
  isParticipationProductPreviewVerified,
} from "../apps/merchant/src/lib/event-market"
import { getEventMarketUrl } from "../apps/merchant/src/lib/market-links"

const ORGANIZER = "a".repeat(64)
const OTHER_ORGANIZER = "b".repeat(64)
const PRODUCT_ONE = `30402:${"c".repeat(64)}:bread`
const PRODUCT_TWO = `30402:${"d".repeat(64)}:coffee`
const COLLECTION = `30405:${ORGANIZER}:market`
const OTHER_COLLECTION = `30405:${OTHER_ORGANIZER}:meetup`
const MERCHANT = "c".repeat(64)
const MERCHANT_PICKUP = `30406:${MERCHANT}:market-booth`

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe("merchant organizer event workflow", () => {
  it("keeps saved public event references scoped to the organizer signer", () => {
    const storage = new MemoryStorage()
    rememberOrganizerEventMarket(
      ORGANIZER,
      { reference: COLLECTION, title: "Market", savedAt: 10 },
      storage
    )

    expect(loadSavedOrganizerEventMarkets(ORGANIZER, storage)).toEqual([
      { reference: COLLECTION, title: "Market", savedAt: 10 },
    ])
    expect(loadSavedOrganizerEventMarkets(OTHER_ORGANIZER, storage)).toEqual([])
    expect(getOrganizerEventMarketStorageKey(ORGANIZER)).not.toBe(
      getOrganizerEventMarketStorageKey(OTHER_ORGANIZER)
    )
  })

  it("keeps merchant-discovered events separate from signer-owned events", () => {
    const storage = new MemoryStorage()
    rememberDiscoveredEventMarket(
      MERCHANT,
      { reference: OTHER_COLLECTION, title: "Meetup", savedAt: 20 },
      storage
    )

    expect(loadSavedDiscoveredEventMarkets(MERCHANT, storage)).toEqual([
      { reference: OTHER_COLLECTION, title: "Meetup", savedAt: 20 },
    ])
    expect(loadSavedOrganizerEventMarkets(MERCHANT, storage)).toEqual([])
    expect(getDiscoveredEventMarketStorageKey(MERCHANT)).not.toBe(
      getOrganizerEventMarketStorageKey(MERCHANT)
    )
  })

  it("deduplicates references and keeps the newest local label", () => {
    const storage = new MemoryStorage()
    rememberOrganizerEventMarket(
      ORGANIZER,
      { reference: COLLECTION, title: "Old", savedAt: 10 },
      storage
    )
    rememberOrganizerEventMarket(
      ORGANIZER,
      { reference: COLLECTION, title: "Updated", savedAt: 20 },
      storage
    )

    expect(loadSavedOrganizerEventMarkets(ORGANIZER, storage)).toEqual([
      { reference: COLLECTION, title: "Updated", savedAt: 20 },
    ])
  })

  it("keeps the in-session reference when browser storage rejects writes", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled")
      },
    }

    expect(
      rememberOrganizerEventMarket(
        ORGANIZER,
        { reference: COLLECTION, savedAt: 10 },
        storage
      )
    ).toEqual([{ reference: COLLECTION, savedAt: 10 }])
  })

  it("merges same-coordinate relay hints across imports and reload", () => {
    const storage = new MemoryStorage()
    const first = encodeEventMarketNaddr(COLLECTION, ["wss://one.example"])
    const second = encodeEventMarketNaddr(COLLECTION, ["wss://two.example"])

    rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference: first,
        title: "First",
        savedAt: 10,
        expectedCollectionCreatedAt: 1_000,
      },
      storage
    )
    rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference: second,
        title: "Second",
        savedAt: 20,
        expectedCollectionCreatedAt: 2_000,
      },
      storage
    )

    const reloaded = loadSavedOrganizerEventMarkets(ORGANIZER, storage)
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]).toMatchObject({
      title: "Second",
      savedAt: 20,
      expectedCollectionCreatedAt: 2_000,
    })
    expect(
      decodeEventMarketReference(reloaded[0]!.reference, [30405])?.relayHints
    ).toEqual(["wss://two.example", "wss://one.example"])
    expect(
      findSavedOrganizerEventMarketReference(reloaded, COLLECTION)?.reference
    ).toBe(reloaded[0]!.reference)
  })

  it("preserves all eight hints on a directly imported reference", () => {
    const storage = new MemoryStorage()
    const importedHints = Array.from(
      { length: 8 },
      (_, index) => `wss://import-${index + 1}.example/events`
    )
    const imported = encodeEventMarketNaddr(COLLECTION, importedHints)

    rememberOrganizerEventMarket(
      ORGANIZER,
      { reference: imported, title: "Imported", savedAt: 10 },
      storage
    )
    const savedAgain = rememberOrganizerEventMarket(
      ORGANIZER,
      { reference: imported, title: "Imported again", savedAt: 20 },
      storage
    )

    expect(
      decodeEventMarketReference(savedAgain[0]!.reference, [30405])?.relayHints
    ).toEqual(importedHints)
    expect(
      decodeEventMarketReference(
        loadSavedOrganizerEventMarkets(ORGANIZER, storage)[0]!.reference,
        [30405]
      )?.relayHints
    ).toEqual(importedHints)
  })

  it("keeps the guest fallback slot when merging a seven-hint publish result", () => {
    const storage = new MemoryStorage()
    const staleHint = "wss://stale.example/events"
    const publishHints = Array.from(
      { length: 7 },
      (_, index) => `wss://publish-${index + 1}.example/events`
    )

    rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference: encodeEventMarketNaddr(COLLECTION, [staleHint]),
        title: "Imported",
        savedAt: 10,
      },
      storage
    )
    const saved = rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference: encodeEventMarketNaddr(COLLECTION, publishHints),
        title: "Published",
        savedAt: 20,
      },
      storage
    )

    expect(saved).toHaveLength(1)
    expect(
      decodeEventMarketReference(saved[0]!.reference, [30405])?.relayHints
    ).toEqual(publishHints)
    expect(saved[0]).toMatchObject({ title: "Published", savedAt: 20 })
  })

  it("prefers a current organizer-list market over a stale hinted selection", () => {
    const staleReference = encodeEventMarketNaddr(
      COLLECTION,
      Array.from(
        { length: 7 },
        (_, index) => `wss://stale-${index + 1}.example/events`
      )
    )
    const currentRelay = "wss://planner-two.example/events"
    const currentMarket = {
      collectionCoordinate: COLLECTION,
      naddr: encodeEventMarketNaddr(COLLECTION, [currentRelay]),
      state: "active",
    }

    const selected = findOrganizerEventMarketByReference(
      [currentMarket],
      staleReference
    )

    expect(selected).toBe(currentMarket)
    expect(
      decodeEventMarketReference(selected!.naddr, [30405])?.relayHints
    ).toEqual([currentRelay])
    expect(
      getEventMarketUrl(selected!.naddr, {
        hostname: "127.0.0.1",
        protocol: "http:",
        port: "7001",
      })
    ).toContain(selected!.naddr)
  })

  it("uses an exact hinted read when the organizer list only has stale evidence", () => {
    const hintedRelay = "wss://current-hint.example/events"
    const hintedReference = encodeEventMarketNaddr(COLLECTION, [hintedRelay])
    const staleListMarket = {
      collectionCoordinate: COLLECTION,
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://stale-cache.example/events",
      ]),
      state: "stale",
    }
    const currentHintedMarket = {
      collectionCoordinate: COLLECTION,
      naddr: hintedReference,
      state: "active",
    }

    const selectedListMarket = findOrganizerEventMarketByReference(
      [staleListMarket],
      hintedReference
    )

    expect(selectedListMarket).toBe(staleListMarket)
    expect(
      isPreferredOrganizerEventMarketListResolution(selectedListMarket)
    ).toBe(false)
    expect(
      isPreferredOrganizerEventMarketListResolution({ state: "active" })
    ).toBe(true)
    expect(
      isPreferredOrganizerEventMarketListResolution({ state: "deleted" })
    ).toBe(true)
    const selected = selectOrganizerEventMarketResolution(
      selectedListMarket,
      currentHintedMarket
    )
    expect(selected).toBe(currentHintedMarket)
    expect(
      getEventMarketUrl(selected!.naddr, {
        hostname: "127.0.0.1",
        protocol: "http:",
        port: "7001",
      })
    ).toContain(selected!.naddr)
    expect(
      decodeEventMarketReference(selected!.naddr, [30405])?.relayHints
    ).toEqual([hintedRelay])
  })

  it("reconciles an imported hint with an older active organizer-list frontier", () => {
    const listRelay = "wss://planner.example/events"
    const importedRelay = "wss://imported.example/events"
    const importedReference = {
      reference: encodeEventMarketNaddr(COLLECTION, [importedRelay]),
      savedAt: 20,
    }
    const olderListMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 1_000,
      collectionEventId: "b".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [listRelay]),
      state: "active",
    }
    const newerHintedMarket = {
      ...olderListMarket,
      collectionCreatedAt: 2_000,
      collectionEventId: "a".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [importedRelay]),
    }

    expect(
      shouldResolveOrganizerEventMarketReference(
        olderListMarket,
        importedReference
      )
    ).toBe(true)
    const selected = selectOrganizerEventMarketResolution(
      olderListMarket,
      newerHintedMarket,
      importedReference
    )
    expect(selected?.collectionCreatedAt).toBe(2_000)
    expect(selected?.collectionEventId).toBe("a".repeat(64))
    expect(
      decodeEventMarketReference(selected!.naddr, [30405])?.relayHints
    ).toEqual([importedRelay, listRelay])
  })

  it("keeps newer list and known deletion frontiers over an imported hint", () => {
    const importedReference = {
      reference: encodeEventMarketNaddr(COLLECTION, [
        "wss://imported.example/events",
      ]),
      savedAt: 20,
    }
    const hintedMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 2_000,
      collectionEventId: "b".repeat(64),
      naddr: importedReference.reference,
      state: "active",
    }
    const newerListMarket = {
      ...hintedMarket,
      collectionCreatedAt: 3_000,
      collectionEventId: "a".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://planner.example/events",
      ]),
    }

    expect(
      selectOrganizerEventMarketResolution(
        newerListMarket,
        hintedMarket,
        importedReference
      )?.collectionCreatedAt
    ).toBe(3_000)
    expect(
      shouldResolveOrganizerEventMarketReference(
        { ...newerListMarket, state: "deleted" },
        importedReference
      )
    ).toBe(false)
    expect(
      selectOrganizerEventMarketResolution(
        { ...newerListMarket, state: "deleted" },
        { ...hintedMarket, collectionCreatedAt: 4_000 },
        importedReference
      )?.state
    ).toBe("deleted")
  })

  it("uses the NIP-01 lowest-id tie break when reconciling views", () => {
    const common = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 2_000,
      state: "active",
    }
    const listMarket = {
      ...common,
      collectionEventId: "b".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://planner.example/events",
      ]),
    }
    const hintedMarket = {
      ...common,
      collectionEventId: "a".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://imported.example/events",
      ]),
    }

    expect(
      selectOrganizerEventMarketResolution(listMarket, hintedMarket, {
        reference: hintedMarket.naddr,
        savedAt: 20,
      })?.collectionEventId
    ).toBe("a".repeat(64))
  })

  it("keeps an updated acknowledgement hint until the signed collection frontier is observed", () => {
    const listRelay = "wss://list.example/events"
    const acknowledgementRelay = "wss://ack.example/events"
    const selectedReference = {
      reference: encodeEventMarketNaddr(COLLECTION, [acknowledgementRelay]),
      savedAt: 20,
      expectedCollectionCreatedAt: 2_000,
    }
    const olderListMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 1_000,
      naddr: encodeEventMarketNaddr(COLLECTION, [listRelay]),
      state: "active",
    }

    expect(
      shouldResolveOrganizerEventMarketReference(
        olderListMarket,
        selectedReference
      )
    ).toBe(true)
    const pendingRead = selectOrganizerEventMarketResolution(
      olderListMarket,
      undefined,
      selectedReference
    )
    expect(pendingRead?.state).toBe("active")
    expect(
      decodeEventMarketReference(pendingRead!.naddr, [30405])?.relayHints
    ).toEqual([acknowledgementRelay, listRelay])

    const updatedHintedMarket = {
      ...olderListMarket,
      collectionCreatedAt: 2_000,
      naddr: encodeEventMarketNaddr(COLLECTION, [acknowledgementRelay]),
    }
    const observedUpdate = selectOrganizerEventMarketResolution(
      olderListMarket,
      updatedHintedMarket,
      selectedReference
    )
    expect(observedUpdate?.collectionCreatedAt).toBe(2_000)
    expect(
      decodeEventMarketReference(observedUpdate!.naddr, [30405])?.relayHints
    ).toEqual([acknowledgementRelay, listRelay])
    expect(
      shouldResolveOrganizerEventMarketReference(
        updatedHintedMarket,
        selectedReference
      )
    ).toBe(false)
  })

  it("keeps the hinted read until every published event-record frontier is observed", () => {
    const listRelay = "wss://list.example/events"
    const acknowledgementRelay = "wss://ack.example/events"
    const selectedReference = {
      reference: encodeEventMarketNaddr(COLLECTION, [acknowledgementRelay]),
      savedAt: 20,
      expectedCollectionCreatedAt: 2_000,
      expectedCollectionEventId: "a".repeat(64),
      expectedCalendarCreatedAt: 3_000,
      expectedCalendarEventId: "b".repeat(64),
      expectedPickupCreatedAt: 4_000,
      expectedPickupEventId: "c".repeat(64),
    }
    const incompleteListMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 2_000,
      collectionEventId: "a".repeat(64),
      calendarCreatedAt: 2_000,
      calendarEventId: "d".repeat(64),
      pickupCreatedAt: 3_000,
      pickupEventId: "e".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [listRelay]),
      state: "active",
    }
    const completeHintedMarket = {
      ...incompleteListMarket,
      calendarCreatedAt: 3_000,
      calendarEventId: "b".repeat(64),
      pickupCreatedAt: 4_000,
      pickupEventId: "c".repeat(64),
      naddr: selectedReference.reference,
    }

    expect(
      shouldResolveOrganizerEventMarketReference(
        incompleteListMarket,
        selectedReference
      )
    ).toBe(true)
    const selected = selectOrganizerEventMarketResolution(
      incompleteListMarket,
      completeHintedMarket,
      selectedReference
    )
    expect(selected?.calendarCreatedAt).toBe(3_000)
    expect(selected?.pickupCreatedAt).toBe(4_000)
    expect(
      decodeEventMarketReference(selected!.naddr, [30405])?.relayHints
    ).toEqual([acknowledgementRelay, listRelay])
    expect(
      shouldResolveOrganizerEventMarketReference(
        completeHintedMarket,
        selectedReference
      )
    ).toBe(false)
  })

  it("merges signed calendar, pickup, and collection frontiers for one saved event", () => {
    const storage = new MemoryStorage()
    const reference = encodeEventMarketNaddr(COLLECTION, [
      "wss://ack.example/events",
    ])

    rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference,
        savedAt: 10,
        expectedCalendarCreatedAt: 2_000,
        expectedCalendarEventId: "b".repeat(64),
      },
      storage
    )
    rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference,
        savedAt: 20,
        expectedPickupCreatedAt: 3_000,
        expectedPickupEventId: "c".repeat(64),
      },
      storage
    )
    const saved = rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference,
        savedAt: 30,
        expectedCollectionCreatedAt: 4_000,
        expectedCollectionEventId: "a".repeat(64),
      },
      storage
    )

    expect(saved[0]).toMatchObject({
      expectedCalendarCreatedAt: 2_000,
      expectedCalendarEventId: "b".repeat(64),
      expectedPickupCreatedAt: 3_000,
      expectedPickupEventId: "c".repeat(64),
      expectedCollectionCreatedAt: 4_000,
      expectedCollectionEventId: "a".repeat(64),
    })

    const withoutPickup = rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference,
        savedAt: 40,
        expectedCalendarCreatedAt: 5_000,
        expectedCalendarEventId: "d".repeat(64),
        expectedCollectionCreatedAt: 6_000,
        expectedCollectionEventId: "e".repeat(64),
        replaceExpectedRecordFrontiers: true,
      },
      storage
    )

    expect(withoutPickup[0]).toMatchObject({
      expectedCalendarCreatedAt: 5_000,
      expectedCollectionCreatedAt: 6_000,
      replaceExpectedRecordFrontiers: true,
    })
    expect(withoutPickup[0]?.expectedPickupCreatedAt).toBeUndefined()
    expect(withoutPickup[0]?.expectedPickupEventId).toBeUndefined()
  })

  it("keeps a hinted selection through bare edit and publish references for sharing", () => {
    const storage = new MemoryStorage()
    const imported = encodeEventMarketNaddr(COLLECTION, [
      "wss://hint.example/events",
    ])
    rememberOrganizerEventMarket(
      ORGANIZER,
      { reference: imported, title: "Imported", savedAt: 10 },
      storage
    )

    const afterPublish = rememberOrganizerEventMarket(
      ORGANIZER,
      { reference: COLLECTION, title: "Edited", savedAt: 20 },
      storage
    )
    const selected = findSavedOrganizerEventMarketReference(
      afterPublish,
      COLLECTION
    )

    expect(selected).toMatchObject({ title: "Edited", savedAt: 20 })
    expect(
      decodeEventMarketReference(selected!.reference, [30405])
    ).toMatchObject({
      coordinate: COLLECTION,
      relayHints: ["wss://hint.example/events"],
    })
    expect(
      loadSavedOrganizerEventMarkets(ORGANIZER, storage)[0]?.reference
    ).toBe(selected!.reference)

    expect(forgetOrganizerEventMarket(ORGANIZER, imported, storage)).toEqual([])
  })

  it("keeps an acknowledgement-hinted publish shareable before relay readback", () => {
    const storage = new MemoryStorage()
    const acknowledgementRelay = "wss://publish-only.example/events"
    const published = encodeEventMarketNaddr(COLLECTION, [acknowledgementRelay])

    const saved = rememberOrganizerEventMarket(
      ORGANIZER,
      { reference: published, title: "Published", savedAt: 30 },
      storage
    )
    const selected = findSavedOrganizerEventMarketReference(saved, COLLECTION)

    expect(selected?.reference).toBe(published)
    expect(
      decodeEventMarketReference(selected!.reference, [30405])
    ).toMatchObject({
      coordinate: COLLECTION,
      relayHints: [acknowledgementRelay],
    })
    expect(
      getEventMarketUrl(selected!.reference, {
        hostname: "127.0.0.1",
        protocol: "http:",
        port: "7001",
      })
    ).toBe(`http://127.0.0.1:7000/events/${published}`)
  })

  it("accepts and removes exact products without changing other membership", () => {
    expect(
      updateOrganizerCollectionProducts(
        [PRODUCT_ONE, PRODUCT_ONE],
        PRODUCT_TWO,
        "accept"
      )
    ).toEqual([PRODUCT_ONE, PRODUCT_TWO])
    expect(
      updateOrganizerCollectionProducts(
        [PRODUCT_ONE, PRODUCT_TWO],
        PRODUCT_ONE,
        "remove"
      )
    ).toEqual([PRODUCT_TWO])
  })

  it("refuses non-product references in organizer membership updates", () => {
    expect(() =>
      updateOrganizerCollectionProducts(
        [PRODUCT_ONE],
        `31923:${ORGANIZER}:market`,
        "accept"
      )
    ).toThrow("kind-30402")
  })

  it("accepts only a Core-resolved handoff whose pickup and handler authority match", () => {
    const request = {
      productCoordinate: `30402:${MERCHANT}:bread`,
      merchantPubkey: MERCHANT,
      fulfillmentStatus: "resolved" as const,
      pickupCoordinate: MERCHANT_PICKUP,
      pickupAuthorPubkey: MERCHANT,
      handoffMode: "merchant_handoff" as const,
      handlerPubkey: MERCHANT,
      status: "pending" as const,
    }

    expect(isParticipationHandoffVerified(request, ORGANIZER)).toBe(true)
    expect(
      isParticipationHandoffVerified(
        { ...request, fulfillmentStatus: "ambiguous" },
        ORGANIZER
      )
    ).toBe(false)
    expect(
      isParticipationHandoffVerified(
        { ...request, handoffMode: "organizer_handoff" },
        ORGANIZER
      )
    ).toBe(false)
  })

  it("accepts only a revision-bound Core product preview with usable canonical price evidence", () => {
    const eventId = "e".repeat(64)
    const request = {
      productCoordinate: `30402:${MERCHANT}:bread`,
      eventId,
      createdAt: 1_000,
      merchantPubkey: MERCHANT,
      productPreview: {
        coordinate: `30402:${MERCHANT}:bread`,
        eventId,
        createdAt: 1_000,
        title: "Fresh bread",
        summary: "A signed product description.",
        images: [{ url: "https://images.example/bread.jpg" }],
        type: "simple" as const,
        format: "physical" as const,
        stock: 4,
        priceStatus: "resolved" as const,
        price: 25,
        currency: "SAT",
      },
      status: "pending" as const,
    }

    expect(isParticipationProductPreviewVerified(request)).toBe(true)
    expect(
      isParticipationProductPreviewVerified({
        ...request,
        eventId: "f".repeat(64),
      })
    ).toBe(false)
    expect(
      isParticipationProductPreviewVerified({
        ...request,
        productPreview: {
          ...request.productPreview,
          priceStatus: "malformed" as const,
        },
      })
    ).toBe(false)
    expect(
      isParticipationProductPreviewVerified({
        ...request,
        productPreview: {
          ...request.productPreview,
          coordinate: `30402:${MERCHANT}:another-product`,
        },
      })
    ).toBe(false)
  })

  it("keeps network evidence states distinct in the organizer view", () => {
    expect(getOrganizerEventMarketDisplayState("active")).toBe("active")
    expect(getOrganizerEventMarketDisplayState("ended")).toBe("ended")
    expect(getOrganizerEventMarketDisplayState("deleted")).toBe("deleted")
    expect(getOrganizerEventMarketDisplayState("partial")).toBe("degraded")
    expect(getOrganizerEventMarketDisplayState("stale")).toBe("degraded")
    expect(getOrganizerEventMarketDisplayState("unavailable")).toBe(
      "unavailable"
    )
  })
})

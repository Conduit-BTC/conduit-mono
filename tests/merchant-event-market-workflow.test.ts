import { describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
} from "@conduit/core"
import {
  findSavedOrganizerEventMarketReference,
  expectedOrganizerEventMarketFrontiersAfterMembership,
  expectedOrganizerEventMarketFrontiersAfterRetry,
  expectedOrganizerEventMarketTitleFrontiers,
  forgetOrganizerEventMarket,
  getDiscoveredEventMarketStorageKey,
  getOrganizerEventMarketDisplayState,
  getOrganizerEventMarketStorageKey,
  isPreferredOrganizerEventMarketListResolution,
  loadSavedDiscoveredEventMarkets,
  loadSavedOrganizerEventMarkets,
  normalizeOrganizerEventMarketTitle,
  organizerEventMarketCanSupplySavedTitle,
  organizerEventMarketDeletionRetiresDelivery,
  organizerEventMarketHasSavedTitleEvidence,
  organizerEventMarketReachesExpectedFrontiers,
  organizerEventMarketRetryRemainsCurrent,
  rememberDiscoveredEventMarket,
  rememberOrganizerEventMarket,
  selectOrganizerEventMarketResolution,
  shortenOrganizerEventMarketReference,
  shouldResolveOrganizerEventMarketReference,
  updateOrganizerCollectionProducts,
} from "../apps/merchant/src/lib/event-market-workflow"
import {
  isParticipationHandoffVerified,
  isParticipationProductAvailable,
  isParticipationProductPreviewVerified,
  publishMerchantOrganizerMembership,
  type MerchantOrganizerEventMarket,
  type MerchantOrganizerRecordDelivery,
} from "../apps/merchant/src/lib/event-market"
import { getEventMarketUrl } from "../apps/merchant/src/lib/market-links"

const ORGANIZER = "a".repeat(64)
const OTHER_ORGANIZER = "b".repeat(64)
const PRODUCT_ONE = `30402:${"c".repeat(64)}:bread`
const PRODUCT_TWO = `30402:${"d".repeat(64)}:coffee`
const COLLECTION = `30405:${ORGANIZER}:market`
const CALENDAR = `31923:${ORGANIZER}:market-calendar`
const ORGANIZER_PICKUP = `30406:${ORGANIZER}:organizer-desk`
const REPLACEMENT_ORGANIZER_PICKUP = `30406:${ORGANIZER}:replacement-desk`
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

  it("hydrates a title without changing saved mutation frontiers", () => {
    const storage = new MemoryStorage()
    const mutationFrontiers = {
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 2_000,
      expectedCollectionEventId: "a".repeat(64),
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 3_000,
      expectedCalendarEventId: "b".repeat(64),
      expectedPickupCoordinate: ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 4_000,
      expectedPickupEventId: "c".repeat(64),
    }
    const [saved] = rememberDiscoveredEventMarket(
      MERCHANT,
      {
        reference: encodeEventMarketNaddr(COLLECTION),
        savedAt: 10,
        ...mutationFrontiers,
      },
      storage
    )

    const [hydrated] = rememberDiscoveredEventMarket(
      MERCHANT,
      { ...saved!, title: "Resolved market title" },
      storage
    )

    expect(hydrated).toMatchObject({
      title: "Resolved market title",
      ...mutationFrontiers,
    })
  })

  it("uses one deterministic shortened coordinate label across relay hints", () => {
    const first = encodeEventMarketNaddr(COLLECTION, [
      "wss://one.example/events",
    ])
    const second = encodeEventMarketNaddr(COLLECTION, [
      "wss://two.example/events",
    ])

    expect(shortenOrganizerEventMarketReference(first)).toBe(
      shortenOrganizerEventMarketReference(second)
    )
    expect(shortenOrganizerEventMarketReference(first)).toContain("…")
    expect(shortenOrganizerEventMarketReference(first)).not.toBe(
      shortenOrganizerEventMarketReference(
        encodeEventMarketNaddr(OTHER_COLLECTION)
      )
    )
  })

  it("does not replace an unanchored legacy title with a different relay title", () => {
    const saved = {
      reference: encodeEventMarketNaddr(COLLECTION),
      title: "Current cached title",
      savedAt: 10,
    }
    const staleMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 1_000,
      collectionEventId: "b".repeat(64),
      calendarCoordinate: CALENDAR,
      calendarCreatedAt: 1_000,
      calendarEventId: "c".repeat(64),
      state: "stale",
      title: "Older stale title",
    }
    const currentMarket = {
      ...staleMarket,
      state: "active",
      title: "Current resolved title",
    }

    expect(organizerEventMarketCanSupplySavedTitle(staleMarket, saved)).toBe(
      false
    )
    expect(organizerEventMarketCanSupplySavedTitle(currentMarket, saved)).toBe(
      false
    )
    expect(
      organizerEventMarketCanSupplySavedTitle(currentMarket, {
        ...saved,
        expectedCollectionCreatedAt: 1_000,
        expectedCalendarCoordinate: CALENDAR,
        expectedCalendarCreatedAt: 1_000,
      })
    ).toBe(false)
    expect(
      organizerEventMarketCanSupplySavedTitle(
        { ...currentMarket, title: saved.title },
        saved
      )
    ).toBe(true)
    expect(
      organizerEventMarketCanSupplySavedTitle(staleMarket, {
        ...saved,
        title: undefined,
      })
    ).toBe(true)
  })

  it("anchors an exact hydrated title before accepting newer list revisions", () => {
    const storage = new MemoryStorage()
    const imported = {
      reference: encodeEventMarketNaddr(COLLECTION),
      savedAt: 10,
    }
    const exactMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 2_000,
      collectionEventId: "b".repeat(64),
      calendarCoordinate: CALENDAR,
      calendarCreatedAt: 2_000,
      calendarEventId: "c".repeat(64),
      state: "active",
      title: "Current exact title",
    }

    expect(organizerEventMarketCanSupplySavedTitle(exactMarket, imported)).toBe(
      true
    )
    const [anchored] = rememberDiscoveredEventMarket(
      MERCHANT,
      {
        ...imported,
        title: exactMarket.title,
        ...expectedOrganizerEventMarketTitleFrontiers(exactMarket),
      },
      storage
    )
    expect(anchored).toMatchObject({
      title: "Current exact title",
      titleCollectionCoordinate: COLLECTION,
      titleCollectionCreatedAt: 2_000,
      titleCollectionEventId: "b".repeat(64),
      titleCalendarCoordinate: CALENDAR,
      titleCalendarCreatedAt: 2_000,
      titleCalendarEventId: "c".repeat(64),
    })
    expect(
      organizerEventMarketHasSavedTitleEvidence(exactMarket, anchored)
    ).toBe(true)
    expect(anchored?.expectedCollectionCreatedAt).toBeUndefined()
    expect(anchored?.expectedCalendarCreatedAt).toBeUndefined()
    expect(
      organizerEventMarketHasSavedTitleEvidence(
        { ...exactMarket, title: "  Current exact title  " },
        anchored
      )
    ).toBe(true)
    expect(
      organizerEventMarketCanSupplySavedTitle(
        { ...exactMarket, title: "  Current exact title  " },
        anchored
      )
    ).toBe(true)

    const olderListMarket = {
      ...exactMarket,
      collectionCreatedAt: 1_000,
      collectionEventId: "d".repeat(64),
      calendarCreatedAt: 1_000,
      calendarEventId: "e".repeat(64),
      title: "Older active list title",
    }
    expect(
      organizerEventMarketCanSupplySavedTitle(olderListMarket, anchored)
    ).toBe(false)
    expect(
      organizerEventMarketHasSavedTitleEvidence(olderListMarket, anchored)
    ).toBe(false)

    const newerListMarket = {
      ...exactMarket,
      collectionCreatedAt: 3_000,
      collectionEventId: "f".repeat(64),
      calendarCreatedAt: 3_000,
      calendarEventId: "1".repeat(64),
      title: "Newer signed title",
    }
    expect(
      organizerEventMarketCanSupplySavedTitle(newerListMarket, anchored)
    ).toBe(true)
    expect(
      expectedOrganizerEventMarketTitleFrontiers(newerListMarket)
    ).toMatchObject({
      titleCollectionCreatedAt: 3_000,
      titleCollectionEventId: "f".repeat(64),
      titleCalendarCreatedAt: 3_000,
      titleCalendarEventId: "1".repeat(64),
    })
  })

  it("normalizes event titles to one stable nonblank value", () => {
    expect(normalizeOrganizerEventMarketTitle("  Event title  ")).toBe(
      "Event title"
    )
    expect(normalizeOrganizerEventMarketTitle("   ")).toBeUndefined()
    expect(normalizeOrganizerEventMarketTitle(undefined)).toBeUndefined()
  })

  it("keeps an anchored title when a later product-page write has no provenance", () => {
    const storage = new MemoryStorage()
    const reference = encodeEventMarketNaddr(COLLECTION)
    const anchoredTitleEvidence = {
      titleCollectionCoordinate: COLLECTION,
      titleCollectionCreatedAt: 2_000,
      titleCollectionEventId: "b".repeat(64),
      titleCalendarCoordinate: CALENDAR,
      titleCalendarCreatedAt: 2_000,
      titleCalendarEventId: "c".repeat(64),
    }

    rememberDiscoveredEventMarket(
      MERCHANT,
      {
        reference,
        title: "Current exact title",
        savedAt: 10,
        ...anchoredTitleEvidence,
      },
      storage
    )

    const [afterProductOpen] = rememberDiscoveredEventMarket(
      MERCHANT,
      {
        reference,
        title: "Older product-page title",
        savedAt: 20,
      },
      storage
    )

    expect(afterProductOpen).toMatchObject({
      title: "Current exact title",
      savedAt: 20,
      ...anchoredTitleEvidence,
    })

    const [afterOlderProvenWrite] = rememberDiscoveredEventMarket(
      MERCHANT,
      {
        reference,
        title: "Older proven title",
        savedAt: 30,
        titleCollectionCoordinate: COLLECTION,
        titleCollectionCreatedAt: 1_000,
        titleCollectionEventId: "d".repeat(64),
        titleCalendarCoordinate: CALENDAR,
        titleCalendarCreatedAt: 1_000,
        titleCalendarEventId: "e".repeat(64),
      },
      storage
    )
    expect(afterOlderProvenWrite).toMatchObject({
      title: "Current exact title",
      savedAt: 30,
      ...anchoredTitleEvidence,
    })

    const [afterCrossedFrontierWrite] = rememberDiscoveredEventMarket(
      MERCHANT,
      {
        reference,
        title: "Newer collection with stale calendar title",
        savedAt: 35,
        titleCollectionCoordinate: COLLECTION,
        titleCollectionCreatedAt: 3_000,
        titleCollectionEventId: "f".repeat(64),
        titleCalendarCoordinate: CALENDAR,
        titleCalendarCreatedAt: 1_000,
        titleCalendarEventId: "1".repeat(64),
      },
      storage
    )
    expect(afterCrossedFrontierWrite).toMatchObject({
      title: "Current exact title",
      savedAt: 35,
      ...anchoredTitleEvidence,
    })

    const replacementCalendar = `31923:${ORGANIZER}:replacement-calendar`
    const [afterNewerProvenWrite] = rememberDiscoveredEventMarket(
      MERCHANT,
      {
        reference,
        title: "Newer relinked title",
        savedAt: 40,
        titleCollectionCoordinate: COLLECTION,
        titleCollectionCreatedAt: 4_000,
        titleCollectionEventId: "2".repeat(64),
        titleCalendarCoordinate: replacementCalendar,
        titleCalendarCreatedAt: 500,
        titleCalendarEventId: "3".repeat(64),
      },
      storage
    )
    expect(afterNewerProvenWrite).toMatchObject({
      title: "Newer relinked title",
      savedAt: 40,
      titleCollectionCoordinate: COLLECTION,
      titleCollectionCreatedAt: 4_000,
      titleCollectionEventId: "2".repeat(64),
      titleCalendarCoordinate: replacementCalendar,
      titleCalendarCreatedAt: 500,
      titleCalendarEventId: "3".repeat(64),
    })
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

    const selectedIdentity = decodeEventMarketReference(staleReference, [30405])
    const selected = [currentMarket].find(
      (market) => market.collectionCoordinate === selectedIdentity?.coordinate
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

    const selectedIdentity = decodeEventMarketReference(
      hintedReference,
      [30405]
    )
    const selectedListMarket = [staleListMarket].find(
      (market) => market.collectionCoordinate === selectedIdentity?.coordinate
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
    ).toBe(false)
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

  it("keeps a newer list frontier over an imported hint", () => {
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
    ).toBe(true)
    expect(
      selectOrganizerEventMarketResolution(
        { ...newerListMarket, state: "deleted" },
        { ...hintedMarket, collectionCreatedAt: 4_000 },
        importedReference
      )?.state
    ).toBe("active")
  })

  it("keeps crossed relay frontiers non-actionable until one graph wins", () => {
    const listMarket = {
      collectionCoordinate: COLLECTION,
      calendarCoordinate: CALENDAR,
      pickupCoordinate: ORGANIZER_PICKUP,
      collectionCreatedAt: 4_000,
      collectionEventId: "a".repeat(64),
      calendarCreatedAt: 1_000,
      calendarEventId: "d".repeat(64),
      pickupCreatedAt: 1_000,
      pickupEventId: "f".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, ["wss://list.example/events"]),
      state: "active",
    }
    const hintedMarket = {
      ...listMarket,
      collectionCreatedAt: 3_000,
      collectionEventId: "b".repeat(64),
      calendarCreatedAt: 5_000,
      calendarEventId: "c".repeat(64),
      pickupCreatedAt: 5_000,
      pickupEventId: "e".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, ["wss://hint.example/events"]),
    }

    const selected = selectOrganizerEventMarketResolution(
      listMarket,
      hintedMarket,
      {
        reference: listMarket.naddr,
        savedAt: 20,
        expectedCollectionCreatedAt: 4_000,
        expectedCollectionEventId: "a".repeat(64),
      }
    )

    expect(selected).toMatchObject({
      terminal: true,
      state: "pending",
      reason: "crossed_frontiers",
      collectionCoordinate: COLLECTION,
    })
    expect(selected).not.toBe(listMarket)
    expect(selected).not.toBe(hintedMarket)
  })

  it("selects a complete pickup-removal graph before the crossed-frontier fallback", () => {
    const olderMarket = {
      collectionCoordinate: COLLECTION,
      calendarCoordinate: CALENDAR,
      pickupCoordinate: ORGANIZER_PICKUP,
      collectionCreatedAt: 1_000,
      collectionEventId: "d".repeat(64),
      calendarCreatedAt: 1_000,
      calendarEventId: "e".repeat(64),
      pickupCreatedAt: 5_000,
      pickupEventId: "f".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, ["wss://older.example/events"]),
      state: "active",
    }
    const pickupRemoved = {
      collectionCoordinate: COLLECTION,
      calendarCoordinate: CALENDAR,
      collectionCreatedAt: 2_000,
      collectionEventId: "a".repeat(64),
      calendarCreatedAt: 2_000,
      calendarEventId: "b".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://current.example/events",
      ]),
      state: "active",
    }
    const savedReference = {
      reference: pickupRemoved.naddr,
      savedAt: 20,
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 2_000,
      expectedCollectionEventId: "a".repeat(64),
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 2_000,
      expectedCalendarEventId: "b".repeat(64),
    }

    for (const [listMarket, hintedMarket] of [
      [olderMarket, pickupRemoved],
      [pickupRemoved, olderMarket],
    ] as const) {
      expect(
        selectOrganizerEventMarketResolution(
          listMarket,
          hintedMarket,
          savedReference
        )
      ).toMatchObject({
        state: "active",
        collectionEventId: "a".repeat(64),
        calendarEventId: "b".repeat(64),
      })
    }
  })

  it("lets a newer collection supersede a saved pickup frontier that it removes or replaces", () => {
    const olderMarket = {
      collectionCoordinate: COLLECTION,
      calendarCoordinate: CALENDAR,
      pickupCoordinate: ORGANIZER_PICKUP,
      collectionCreatedAt: 1_000,
      collectionEventId: "d".repeat(64),
      calendarCreatedAt: 1_000,
      calendarEventId: "e".repeat(64),
      pickupCreatedAt: 5_000,
      pickupEventId: "f".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, ["wss://older.example/events"]),
      state: "active",
    }
    const pickupRemoved = {
      collectionCoordinate: COLLECTION,
      calendarCoordinate: CALENDAR,
      collectionCreatedAt: 2_000,
      collectionEventId: "a".repeat(64),
      calendarCreatedAt: 1_000,
      calendarEventId: "e".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://current.example/events",
      ]),
      state: "active",
    }
    const savedReference = {
      reference: olderMarket.naddr,
      savedAt: 20,
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 1_000,
      expectedCollectionEventId: "d".repeat(64),
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 1_000,
      expectedCalendarEventId: "e".repeat(64),
      expectedPickupCoordinate: ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 5_000,
      expectedPickupEventId: "f".repeat(64),
    }
    const pickupReplaced = {
      ...pickupRemoved,
      pickupCoordinate: REPLACEMENT_ORGANIZER_PICKUP,
      pickupCreatedAt: 2_000,
      pickupEventId: "c".repeat(64),
    }

    for (const candidate of [pickupRemoved, pickupReplaced]) {
      for (const reference of [savedReference, undefined]) {
        const selected = selectOrganizerEventMarketResolution(
          olderMarket,
          candidate,
          reference
        )
        expect(selected).toMatchObject({
          state: "active",
          collectionEventId: "a".repeat(64),
        })
        expect(selected?.pickupCoordinate).toBe(candidate.pickupCoordinate)
      }
      expect(
        organizerEventMarketReachesExpectedFrontiers(candidate, savedReference)
      ).toBe(true)
    }
  })

  it("makes calendar replacement relative to the collection that advertises it", () => {
    const replacementCalendar = `31923:${ORGANIZER}:replacement-calendar`
    const olderMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 1_000,
      collectionEventId: "d".repeat(64),
      calendarCoordinate: CALENDAR,
      calendarCreatedAt: 5_000,
      calendarEventId: "c".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, ["wss://older.example/events"]),
      state: "active",
    }
    const replacementMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 2_000,
      collectionEventId: "a".repeat(64),
      calendarCoordinate: replacementCalendar,
      calendarCreatedAt: 2_000,
      calendarEventId: "b".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://current.example/events",
      ]),
      state: "active",
    }
    const savedReference = {
      reference: olderMarket.naddr,
      savedAt: 20,
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 1_000,
      expectedCollectionEventId: "d".repeat(64),
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 5_000,
      expectedCalendarEventId: "c".repeat(64),
    }

    for (const [listMarket, hintedMarket] of [
      [olderMarket, replacementMarket],
      [replacementMarket, olderMarket],
    ] as const) {
      expect(
        selectOrganizerEventMarketResolution(
          listMarket,
          hintedMarket,
          savedReference
        )
      ).toMatchObject({
        state: "active",
        collectionEventId: "a".repeat(64),
        calendarCoordinate: replacementCalendar,
        calendarEventId: "b".repeat(64),
      })
    }
    expect(
      organizerEventMarketReachesExpectedFrontiers(
        replacementMarket,
        savedReference
      )
    ).toBe(true)
  })

  it("keeps a newer collection non-actionable until its advertised replacement pickup resolves", () => {
    const savedReference = {
      reference: encodeEventMarketNaddr(COLLECTION, [
        "wss://older.example/events",
      ]),
      savedAt: 20,
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 1_000,
      expectedCollectionEventId: "d".repeat(64),
      expectedPickupCoordinate: ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 5_000,
      expectedPickupEventId: "f".repeat(64),
    }
    const newerUnresolvedMarket = {
      collectionCoordinate: COLLECTION,
      pickupCoordinate: REPLACEMENT_ORGANIZER_PICKUP,
      collectionCreatedAt: 2_000,
      collectionEventId: "a".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://current.example/events",
      ]),
      state: "active",
    }

    for (const reference of [savedReference, undefined]) {
      expect(
        organizerEventMarketReachesExpectedFrontiers(
          newerUnresolvedMarket,
          reference
        )
      ).toBe(false)
    }
  })

  it("lets an exact hinted deletion retire an older active list market", () => {
    const listMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 1_000,
      collectionEventId: "b".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://planner.example/events",
      ]),
      state: "active",
    }
    const hintedDeletion = {
      terminal: true as const,
      state: "deleted" as const,
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 1_000,
      collectionEventId: "b".repeat(64),
      deletion: {
        record: "collection" as const,
        coordinate: COLLECTION,
        eventId: "b".repeat(64),
        createdAt: 1_000,
        deletions: [
          {
            deletionEventId: "d".repeat(64),
            deletionCreatedAt: 2_000,
            authorPubkey: ORGANIZER,
            eventTargets: ["b".repeat(64)],
            addressableTargets: [],
          },
        ],
      },
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://deletion.example/events",
      ]),
    }

    const selectedDeletion = selectOrganizerEventMarketResolution(
      listMarket,
      hintedDeletion
    )
    expect(selectedDeletion).toMatchObject({
      terminal: true,
      state: "deleted",
      collectionCoordinate: COLLECTION,
    })
    expect(
      decodeEventMarketReference(selectedDeletion!.naddr, [30405])?.relayHints
    ).toEqual(["wss://deletion.example/events", "wss://planner.example/events"])
    expect(selectOrganizerEventMarketResolution(listMarket, undefined)).toBe(
      listMarket
    )
  })

  it("does not let an exact deletion hide a different active revision", () => {
    const listMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 3_000,
      collectionEventId: "a".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://planner.example/events",
      ]),
      state: "active",
    }
    const hintedDeletion = {
      terminal: true as const,
      state: "deleted" as const,
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 2_000,
      collectionEventId: "b".repeat(64),
      deletion: {
        record: "collection" as const,
        coordinate: COLLECTION,
        eventId: "b".repeat(64),
        createdAt: 2_000,
        deletions: [
          {
            deletionEventId: "d".repeat(64),
            deletionCreatedAt: 4_000,
            authorPubkey: ORGANIZER,
            eventTargets: ["b".repeat(64)],
            addressableTargets: [],
          },
        ],
      },
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://deletion.example/events",
      ]),
    }

    expect(
      selectOrganizerEventMarketResolution(listMarket, hintedDeletion)
        ?.collectionEventId
    ).toBe("a".repeat(64))
  })

  it("makes pickup deletion relative to the collection that advertises it", () => {
    const oldPickupGraph = {
      collectionCoordinate: COLLECTION,
      pickupCoordinate: ORGANIZER_PICKUP,
      collectionCreatedAt: 1_000,
      collectionEventId: "d".repeat(64),
      pickupCreatedAt: 1_000,
      pickupEventId: "c".repeat(64),
    }
    const deletedOldPickup = {
      ...oldPickupGraph,
      terminal: true as const,
      state: "deleted" as const,
      deletion: {
        record: "pickup" as const,
        coordinate: ORGANIZER_PICKUP,
        eventId: "c".repeat(64),
        createdAt: 1_000,
        deletions: [
          {
            deletionEventId: "f".repeat(64),
            deletionCreatedAt: 2_000,
            authorPubkey: ORGANIZER,
            eventTargets: ["c".repeat(64)],
            addressableTargets: [],
          },
        ],
      },
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://deletion.example/events",
      ]),
    }
    const newerMarketWithoutPickup = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 3_000,
      collectionEventId: "a".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://current.example/events",
      ]),
      state: "active",
    }
    const savedOldPickup = {
      reference: deletedOldPickup.naddr,
      savedAt: 20,
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 1_000,
      expectedCollectionEventId: "d".repeat(64),
      expectedPickupCoordinate: ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 1_000,
      expectedPickupEventId: "c".repeat(64),
    }

    for (const savedReference of [undefined, savedOldPickup]) {
      const boundedViewOrders = [
        selectOrganizerEventMarketResolution(
          newerMarketWithoutPickup,
          deletedOldPickup,
          savedReference
        ),
        selectOrganizerEventMarketResolution(
          deletedOldPickup,
          newerMarketWithoutPickup,
          savedReference
        ),
      ]
      for (const selected of boundedViewOrders) {
        expect(selected).toMatchObject({
          state: "active",
          collectionEventId: "a".repeat(64),
        })
        expect(selected?.pickupCoordinate).toBeUndefined()
      }
      expect(
        organizerEventMarketReachesExpectedFrontiers(
          newerMarketWithoutPickup,
          savedReference
        )
      ).toBe(true)
    }

    const currentMarketWithPickup = {
      ...oldPickupGraph,
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://current.example/events",
      ]),
      state: "active",
    }
    expect(
      selectOrganizerEventMarketResolution(
        currentMarketWithPickup,
        deletedOldPickup
      )?.state
    ).toBe("deleted")
  })

  it("does not apply a calendar tombstone to a replacement coordinate", () => {
    const replacementCalendar = `31923:${ORGANIZER}:replacement-calendar`
    const replacementMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 3_000,
      collectionEventId: "a".repeat(64),
      calendarCoordinate: replacementCalendar,
      calendarCreatedAt: 3_000,
      calendarEventId: "b".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://planner.example/events",
      ]),
      state: "active",
    }
    const oldCalendarDeletion = {
      terminal: true as const,
      state: "deleted" as const,
      collectionCoordinate: COLLECTION,
      calendarCoordinate: CALENDAR,
      calendarCreatedAt: 2_000,
      calendarEventId: "c".repeat(64),
      deletion: {
        record: "calendar" as const,
        coordinate: CALENDAR,
        eventId: "c".repeat(64),
        createdAt: 2_000,
        deletions: [
          {
            deletionEventId: "d".repeat(64),
            deletionCreatedAt: 4_000,
            authorPubkey: ORGANIZER,
            eventTargets: [],
            addressableTargets: [CALENDAR],
          },
        ],
      },
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://deletion.example/events",
      ]),
    }
    const savedReference = {
      reference: replacementMarket.naddr,
      savedAt: 20,
      expectedCalendarCoordinate: replacementCalendar,
      expectedCalendarCreatedAt: 3_000,
      expectedCalendarEventId: "b".repeat(64),
    }

    expect(
      selectOrganizerEventMarketResolution(
        replacementMarket,
        oldCalendarDeletion,
        savedReference
      )
    ).toMatchObject({
      state: "active",
      calendarCoordinate: replacementCalendar,
      calendarEventId: "b".repeat(64),
    })
    expect(
      selectOrganizerEventMarketResolution(
        { ...replacementMarket, calendarCoordinate: CALENDAR },
        oldCalendarDeletion
      )?.state
    ).toBe("deleted")
  })

  it("lets a newer revision survive an older addressable tombstone", () => {
    const listMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 3_000,
      collectionEventId: "a".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://planner.example/events",
      ]),
      state: "active",
    }
    const hintedDeletion = {
      terminal: true as const,
      state: "deleted" as const,
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 1_000,
      collectionEventId: "b".repeat(64),
      deletion: {
        record: "collection" as const,
        coordinate: COLLECTION,
        eventId: "b".repeat(64),
        createdAt: 1_000,
        deletions: [
          {
            deletionEventId: "d".repeat(64),
            deletionCreatedAt: 2_000,
            authorPubkey: ORGANIZER,
            eventTargets: [],
            addressableTargets: [COLLECTION],
          },
        ],
      },
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://deletion.example/events",
      ]),
    }

    expect(
      selectOrganizerEventMarketResolution(listMarket, hintedDeletion)
        ?.collectionEventId
    ).toBe("a".repeat(64))
    expect(
      selectOrganizerEventMarketResolution(listMarket, {
        ...hintedDeletion,
        deletion: {
          ...hintedDeletion.deletion,
          deletions: [
            {
              ...hintedDeletion.deletion.deletions[0]!,
              deletionCreatedAt: 4_000,
            },
          ],
        },
      })?.state
    ).toBe("deleted")
  })

  it("applies equal-timestamp addressable tombstones regardless of deletion id", () => {
    const listMarket = {
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 3_000,
      collectionEventId: "b".repeat(64),
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://planner.example/events",
      ]),
      state: "active",
    }
    const deletion = {
      terminal: true as const,
      state: "deleted" as const,
      collectionCoordinate: COLLECTION,
      collectionCreatedAt: 1_000,
      collectionEventId: "b".repeat(64),
      deletion: {
        record: "collection" as const,
        coordinate: COLLECTION,
        deletions: [
          {
            deletionEventId: "0".repeat(64),
            deletionCreatedAt: 3_000,
            authorPubkey: ORGANIZER,
            eventTargets: [],
            addressableTargets: [COLLECTION],
          },
        ],
      },
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://deletion.example/events",
      ]),
    }

    expect(
      selectOrganizerEventMarketResolution(listMarket, deletion)?.state
    ).toBe("deleted")
    expect(
      selectOrganizerEventMarketResolution(listMarket, {
        ...deletion,
        deletion: {
          ...deletion.deletion,
          deletions: [
            {
              ...deletion.deletion.deletions[0]!,
              deletionEventId: "f".repeat(64),
            },
          ],
        },
      })?.state
    ).toBe("deleted")
  })

  it("compares a standalone coordinate tombstone with the saved frontier", () => {
    const savedReference = {
      reference: encodeEventMarketNaddr(COLLECTION, [
        "wss://saved.example/events",
      ]),
      savedAt: 20,
      expectedCollectionCreatedAt: 3_000,
      expectedCollectionEventId: "a".repeat(64),
    }
    const standaloneDeletion = {
      terminal: true as const,
      state: "deleted" as const,
      collectionCoordinate: COLLECTION,
      deletion: {
        record: "collection" as const,
        coordinate: COLLECTION,
        deletions: [
          {
            deletionEventId: "d".repeat(64),
            deletionCreatedAt: 2_000,
            authorPubkey: ORGANIZER,
            eventTargets: [],
            addressableTargets: [COLLECTION],
          },
        ],
      },
      naddr: encodeEventMarketNaddr(COLLECTION, [
        "wss://deletion.example/events",
      ]),
    }

    expect(
      selectOrganizerEventMarketResolution(
        undefined,
        standaloneDeletion,
        savedReference
      )
    ).toMatchObject({
      terminal: true,
      state: "pending",
      reason: "saved_frontier_ahead",
      collectionCoordinate: COLLECTION,
    })
    expect(
      selectOrganizerEventMarketResolution(
        undefined,
        {
          ...standaloneDeletion,
          deletion: {
            ...standaloneDeletion.deletion,
            deletions: [
              {
                ...standaloneDeletion.deletion.deletions[0]!,
                deletionCreatedAt: 4_000,
              },
            ],
          },
        },
        savedReference
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
    expect(
      organizerEventMarketReachesExpectedFrontiers(
        olderListMarket,
        selectedReference
      )
    ).toBe(false)
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
    expect(
      organizerEventMarketReachesExpectedFrontiers(
        updatedHintedMarket,
        selectedReference
      )
    ).toBe(true)
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
        expectedCalendarCoordinate: CALENDAR,
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
        expectedPickupCoordinate: ORGANIZER_PICKUP,
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
        expectedCollectionCoordinate: COLLECTION,
        expectedCollectionCreatedAt: 4_000,
        expectedCollectionEventId: "a".repeat(64),
      },
      storage
    )

    expect(saved[0]).toMatchObject({
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 2_000,
      expectedCalendarEventId: "b".repeat(64),
      expectedPickupCoordinate: ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 3_000,
      expectedPickupEventId: "c".repeat(64),
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 4_000,
      expectedCollectionEventId: "a".repeat(64),
    })

    const withoutPickup = rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference,
        savedAt: 40,
        expectedCalendarCoordinate: CALENDAR,
        expectedCalendarCreatedAt: 5_000,
        expectedCalendarEventId: "d".repeat(64),
        expectedCollectionCoordinate: COLLECTION,
        expectedCollectionCreatedAt: 6_000,
        expectedCollectionEventId: "e".repeat(64),
        replaceExpectedRecordFrontiers: true,
      },
      storage
    )

    expect(withoutPickup[0]).toMatchObject({
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 5_000,
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 6_000,
      replaceExpectedRecordFrontiers: true,
    })
    expect(withoutPickup[0]?.expectedPickupCreatedAt).toBeUndefined()
    expect(withoutPickup[0]?.expectedPickupEventId).toBeUndefined()
    expect(withoutPickup[0]?.expectedPickupCoordinate).toBeUndefined()
  })

  it("clears an obsolete pickup frontier after retrying a collection without pickup", () => {
    const savedReference = {
      reference: COLLECTION,
      savedAt: 10,
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 2_000,
      expectedCalendarEventId: "b".repeat(64),
      expectedPickupCoordinate: ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 3_000,
      expectedPickupEventId: "c".repeat(64),
    }
    const retriedCollection = {
      id: "d".repeat(64),
      pubkey: ORGANIZER,
      created_at: 4,
      kind: 30405,
      content: "",
      tags: [
        ["d", "market"],
        ["a", CALENDAR],
        ["a", `30406:${ORGANIZER}:not-a-collection-pickup-link`],
      ],
      sig: "e".repeat(128),
    }

    expect(
      expectedOrganizerEventMarketFrontiersAfterRetry(
        { record: "collection", signedEvent: retriedCollection },
        savedReference
      )
    ).toEqual({
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 4_000,
      expectedCollectionEventId: retriedCollection.id,
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 2_000,
      expectedCalendarEventId: "b".repeat(64),
      replaceExpectedRecordFrontiers: true,
    })
  })

  it("replaces child frontiers after a collection-only membership update", () => {
    const storage = new MemoryStorage()
    const replacementCalendar = `31923:${ORGANIZER}:replacement-calendar`
    const collectionEvent = {
      id: "a".repeat(64),
      pubkey: ORGANIZER,
      created_at: 7,
      kind: 30405,
      content: "",
      tags: [["d", "market"]],
      sig: "e".repeat(128),
    }

    rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference: COLLECTION,
        savedAt: 10,
        expectedCollectionCoordinate: COLLECTION,
        expectedCollectionCreatedAt: 4_000,
        expectedCollectionEventId: "d".repeat(64),
        expectedCalendarCoordinate: CALENDAR,
        expectedCalendarCreatedAt: 2_000,
        expectedCalendarEventId: "b".repeat(64),
        expectedPickupCoordinate: ORGANIZER_PICKUP,
        expectedPickupCreatedAt: 3_000,
        expectedPickupEventId: "c".repeat(64),
      },
      storage
    )

    const savedWithoutPickup = rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference: COLLECTION,
        savedAt: 20,
        ...expectedOrganizerEventMarketFrontiersAfterMembership(
          { record: "collection", signedEvent: collectionEvent },
          {
            collectionCoordinate: COLLECTION,
            collectionCreatedAt: 6_000,
            collectionEventId: "f".repeat(64),
            calendarCoordinate: replacementCalendar,
            calendarCreatedAt: 5_000,
            calendarEventId: "1".repeat(64),
          }
        ),
      },
      storage
    )

    expect(savedWithoutPickup[0]).toMatchObject({
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 7_000,
      expectedCollectionEventId: collectionEvent.id,
      expectedCalendarCoordinate: replacementCalendar,
      expectedCalendarCreatedAt: 5_000,
      expectedCalendarEventId: "1".repeat(64),
      replaceExpectedRecordFrontiers: true,
    })
    expect(savedWithoutPickup[0]?.expectedPickupCoordinate).toBeUndefined()
    expect(savedWithoutPickup[0]?.expectedPickupCreatedAt).toBeUndefined()
    expect(savedWithoutPickup[0]?.expectedPickupEventId).toBeUndefined()

    const savedWithReplacementPickup = rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference: COLLECTION,
        savedAt: 30,
        ...expectedOrganizerEventMarketFrontiersAfterMembership(
          {
            record: "collection",
            signedEvent: {
              ...collectionEvent,
              id: "0".repeat(64),
              created_at: 8,
            },
          },
          {
            collectionCoordinate: COLLECTION,
            collectionCreatedAt: 7_000,
            collectionEventId: collectionEvent.id,
            calendarCoordinate: replacementCalendar,
            calendarCreatedAt: 5_000,
            calendarEventId: "1".repeat(64),
            pickupCoordinate: REPLACEMENT_ORGANIZER_PICKUP,
            pickupCreatedAt: 6_000,
            pickupEventId: "2".repeat(64),
          }
        ),
      },
      storage
    )

    expect(savedWithReplacementPickup[0]).toMatchObject({
      expectedCollectionCreatedAt: 8_000,
      expectedCalendarCoordinate: replacementCalendar,
      expectedCalendarCreatedAt: 5_000,
      expectedPickupCoordinate: REPLACEMENT_ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 6_000,
      expectedPickupEventId: "2".repeat(64),
      replaceExpectedRecordFrontiers: true,
    })
  })

  it("retains the pickup frontier after retrying a collection that still advertises pickup", () => {
    const savedReference = {
      reference: COLLECTION,
      savedAt: 10,
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 2_000,
      expectedCalendarEventId: "b".repeat(64),
      expectedPickupCoordinate: ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 3_000,
      expectedPickupEventId: "c".repeat(64),
    }
    const retriedCollection = {
      id: "d".repeat(64),
      pubkey: ORGANIZER,
      created_at: 4,
      kind: 30405,
      content: "",
      tags: [
        ["d", "market"],
        ["a", CALENDAR],
        ["shipping_option", ORGANIZER_PICKUP],
      ],
      sig: "e".repeat(128),
    }

    expect(
      expectedOrganizerEventMarketFrontiersAfterRetry(
        { record: "collection", signedEvent: retriedCollection },
        savedReference
      )
    ).toEqual({
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 4_000,
      expectedCollectionEventId: retriedCollection.id,
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 2_000,
      expectedCalendarEventId: "b".repeat(64),
      expectedPickupCoordinate: ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 3_000,
      expectedPickupEventId: "c".repeat(64),
      replaceExpectedRecordFrontiers: true,
    })
  })

  it("retires losing child frontiers when an equal-timestamp winning retry replaces them", () => {
    const replacementCalendar = `31923:${ORGANIZER}:replacement-calendar`
    const savedReference = {
      reference: COLLECTION,
      savedAt: 10,
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 4_000,
      expectedCollectionEventId: "f".repeat(64),
      expectedCalendarCoordinate: CALENDAR,
      expectedCalendarCreatedAt: 2_000,
      expectedCalendarEventId: "b".repeat(64),
      expectedPickupCoordinate: ORGANIZER_PICKUP,
      expectedPickupCreatedAt: 3_000,
      expectedPickupEventId: "c".repeat(64),
    }
    const retriedCollection = {
      id: "a".repeat(64),
      pubkey: ORGANIZER,
      created_at: 4,
      kind: 30405,
      content: "",
      tags: [
        ["d", "market"],
        ["a", replacementCalendar],
        ["shipping_option", REPLACEMENT_ORGANIZER_PICKUP],
      ],
      sig: "e".repeat(128),
    }
    const retryFrontiers = expectedOrganizerEventMarketFrontiersAfterRetry(
      { record: "collection", signedEvent: retriedCollection },
      savedReference
    )

    expect(retryFrontiers).toEqual({
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 4_000,
      expectedCollectionEventId: retriedCollection.id,
      replaceExpectedRecordFrontiers: true,
    })

    const storage = new MemoryStorage()
    rememberOrganizerEventMarket(ORGANIZER, savedReference, storage)
    const [savedAfterRetry] = rememberOrganizerEventMarket(
      ORGANIZER,
      {
        reference: COLLECTION,
        savedAt: 20,
        ...retryFrontiers,
      },
      storage
    )

    expect(savedAfterRetry?.expectedCalendarCoordinate).toBeUndefined()
    expect(savedAfterRetry?.expectedCalendarCreatedAt).toBeUndefined()
    expect(savedAfterRetry?.expectedPickupCoordinate).toBeUndefined()
    expect(savedAfterRetry?.expectedPickupCreatedAt).toBeUndefined()
    expect(
      organizerEventMarketReachesExpectedFrontiers(
        {
          collectionCoordinate: COLLECTION,
          collectionCreatedAt: 4_000,
          collectionEventId: retriedCollection.id,
          calendarCoordinate: replacementCalendar,
          calendarCreatedAt: 5_000,
          calendarEventId: "1".repeat(64),
          pickupCoordinate: REPLACEMENT_ORGANIZER_PICKUP,
          pickupCreatedAt: 6_000,
          pickupEventId: "2".repeat(64),
        },
        savedAfterRetry
      )
    ).toBe(true)
  })

  it("rejects a late collection retry behind the persisted or exact-retry frontier", () => {
    const retriedCollection = {
      id: "f".repeat(64),
      pubkey: ORGANIZER,
      created_at: 4,
      kind: 30405,
      content: "",
      tags: [["d", "market"]],
      sig: "e".repeat(128),
    }
    const newerCollection = {
      ...retriedCollection,
      id: "a".repeat(64),
      created_at: 5,
    }
    const savedReference = {
      reference: COLLECTION,
      savedAt: 20,
      expectedCollectionCoordinate: COLLECTION,
      expectedCollectionCreatedAt: 5_000,
      expectedCollectionEventId: newerCollection.id,
    }

    expect(
      organizerEventMarketRetryRemainsCurrent(
        { record: "collection", signedEvent: retriedCollection },
        savedReference,
        { record: "collection", signedEvent: newerCollection }
      )
    ).toBe(false)
    expect(
      organizerEventMarketRetryRemainsCurrent(
        { record: "collection", signedEvent: newerCollection },
        savedReference,
        { record: "collection", signedEvent: newerCollection }
      )
    ).toBe(true)

    const losingEqualTimestampRetry = {
      ...retriedCollection,
      created_at: newerCollection.created_at,
    }
    expect(
      organizerEventMarketRetryRemainsCurrent(
        { record: "collection", signedEvent: losingEqualTimestampRetry },
        savedReference,
        { record: "collection", signedEvent: newerCollection }
      )
    ).toBe(false)
  })

  it("keeps newer exact retries beyond a legacy coordinate deletion frontier", () => {
    const signedCollection = {
      id: "b".repeat(64),
      pubkey: ORGANIZER,
      created_at: 5,
      kind: 30405,
      content: "",
      tags: [["d", "market"]],
      sig: "e".repeat(128),
    }
    const terminalDeletion = {
      terminal: true as const,
      state: "deleted" as const,
      collectionCoordinate: COLLECTION,
      deletion: {
        record: "collection" as const,
        coordinate: COLLECTION,
        deletions: [
          {
            deletionEventId: "c".repeat(64),
            deletionCreatedAt: 4_000,
            authorPubkey: ORGANIZER,
            eventTargets: [],
            addressableTargets: [COLLECTION],
          },
        ],
      },
      naddr: COLLECTION,
    }

    expect(
      organizerEventMarketDeletionRetiresDelivery(terminalDeletion, {
        record: "collection",
        signedEvent: signedCollection,
      })
    ).toBe(false)
    expect(
      organizerEventMarketDeletionRetiresDelivery(
        {
          ...terminalDeletion,
          deletion: {
            ...terminalDeletion.deletion,
            deletions: [
              {
                ...terminalDeletion.deletion.deletions[0]!,
                deletionCreatedAt: 6_000,
              },
            ],
          },
        },
        { record: "collection", signedEvent: signedCollection }
      )
    ).toBe(true)
    expect(
      organizerEventMarketDeletionRetiresDelivery(
        {
          ...terminalDeletion,
          deletion: {
            ...terminalDeletion.deletion,
            deletions: [
              {
                ...terminalDeletion.deletion.deletions[0]!,
                deletionCreatedAt: 1_000,
                eventTargets: [signedCollection.id],
                addressableTargets: [],
              },
            ],
          },
        },
        { record: "collection", signedEvent: signedCollection }
      )
    ).toBe(true)

    const equalTimestampDeletion = {
      ...terminalDeletion,
      deletion: {
        ...terminalDeletion.deletion,
        deletions: [
          {
            ...terminalDeletion.deletion.deletions[0]!,
            deletionEventId: "a".repeat(64),
            deletionCreatedAt: 5_000,
          },
        ],
      },
    }
    expect(
      organizerEventMarketDeletionRetiresDelivery(equalTimestampDeletion, {
        record: "collection",
        signedEvent: signedCollection,
      })
    ).toBe(true)
    expect(
      organizerEventMarketDeletionRetiresDelivery(
        {
          ...equalTimestampDeletion,
          deletion: {
            ...equalTimestampDeletion.deletion,
            deletions: [
              {
                ...equalTimestampDeletion.deletion.deletions[0]!,
                deletionEventId: "f".repeat(64),
              },
            ],
          },
        },
        { record: "collection", signedEvent: signedCollection }
      )
    ).toBe(true)
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

  it("rejects an organizer handoff removed by a newer retained collection", async () => {
    const secret = generateSecretKey()
    const organizer = getPublicKey(secret)
    const collectionCoordinate = `30405:${organizer}:market`
    const calendarCoordinate = `31923:${organizer}:market`
    const oldPickup = `30406:${organizer}:old-booth`
    const currentPickup = `30406:${organizer}:current-booth`
    const productCoordinate = `30402:${MERCHANT}:bread`
    const retainedEvent = finalizeEvent(
      {
        kind: 30405,
        created_at: 2,
        content: "Current collection",
        tags: [
          ["d", "market"],
          ["title", "Current market"],
          ["a", calendarCoordinate],
          ["shipping_option", currentPickup],
        ],
      },
      secret
    )
    const retainedCollection = {
      record: "collection",
      acknowledgedCount: 1,
      rejectedCount: 0,
      timedOutCount: 0,
      signedEvent: retainedEvent,
    } satisfies MerchantOrganizerRecordDelivery
    const market = {
      state: "partial",
      organizerPubkey: organizer,
      collectionCoordinate,
      calendarCoordinate,
      pickupCoordinate: oldPickup,
      pickupCoordinates: [oldPickup],
      naddr: "naddr-test",
      title: "Older relay market",
      calendarKind: 31923,
      start: 1,
      collectionCreatedAt: 1_000,
      productCoordinates: [],
      participation: [],
      source: {
        collection: {
          eventId: "f".repeat(64),
          createdAt: 1_000,
          content: "Older relay collection",
        },
      },
    } as MerchantOrganizerEventMarket
    const item = {
      productCoordinate,
      eventId: "e".repeat(64),
      createdAt: 1_000,
      merchantPubkey: MERCHANT,
      fulfillmentStatus: "resolved" as const,
      pickupCoordinate: oldPickup,
      pickupAuthorPubkey: organizer,
      handoffMode: "organizer_handoff" as const,
      handlerPubkey: organizer,
      productPreview: {
        coordinate: productCoordinate,
        eventId: "e".repeat(64),
        createdAt: 1_000,
        title: "Fresh bread",
        priceStatus: "resolved" as const,
        price: 25,
        currency: "SAT",
      },
      status: "pending" as const,
    }

    await expect(
      publishMerchantOrganizerMembership({
        organizerPubkey: organizer,
        market,
        item,
        action: "accept",
        retainedCollection,
      })
    ).rejects.toThrow("Current signed product preview or handoff evidence")
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

  it("counts a product as available only with exact preview and handoff evidence", () => {
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
        priceStatus: "resolved" as const,
        price: 25,
        currency: "SAT",
      },
      fulfillmentStatus: "resolved" as const,
      pickupCoordinate: MERCHANT_PICKUP,
      pickupAuthorPubkey: MERCHANT,
      handoffMode: "merchant_handoff" as const,
      handlerPubkey: MERCHANT,
      status: "accepted" as const,
    }

    expect(isParticipationProductAvailable(request, ORGANIZER)).toBe(true)
    expect(
      isParticipationProductAvailable(
        { ...request, fulfillmentStatus: "ambiguous" },
        ORGANIZER
      )
    ).toBe(false)
    expect(
      isParticipationProductAvailable(
        {
          ...request,
          productPreview: {
            ...request.productPreview,
            eventId: "f".repeat(64),
          },
        },
        ORGANIZER
      )
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

import { describe, expect, it, setSystemTime } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { matchFilter, type Filter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { ConduitDB } from "@conduit/core/db"
import {
  buildEventMarketAssignmentDraft,
  EVENT_MARKET_ASSIGNMENT_STOCK_POOL_TAG,
  isEventMarketAssignmentProductSuitable,
  parseEventMarketAssignmentEvent,
  type EventMarketAssignmentDraftInput,
  type EventMarketAssignmentOrganizerStockPool,
} from "@conduit/core/protocol/event-market-assignment"
import { recoverMerchantInventoryProduct } from "@conduit/core/protocol/merchant-inventory-recovery"
import { readEventMarketAssignment } from "@conduit/core/protocol/event-market-roster-read"
import { parseProductEvent } from "@conduit/core/protocol/products"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"
import { admitFixtureEvent } from "./helpers/admit-event"

const merchantSecret = generateSecretKey()
const organizer = getPublicKey(generateSecretKey())
const merchant = getPublicKey(merchantSecret)
const poolId = finalizeEvent(
  {
    kind: 16,
    created_at: 100,
    tags: [],
    content: "synthetic grant commitment",
  },
  merchantSecret
).id
const base: EventMarketAssignmentDraftInput = {
  merchantPubkey: merchant,
  marketCoordinate: `30409:${organizer}:market`,
  occurrenceCoordinate: `31923:${organizer}:occurrence`,
  productCoordinate: `30402:${merchant}:item`,
  state: "active",
  inventory: { mode: "tracked", quantity: 6 },
  fulfillmentMethods: ["pickup"],
}
const pool: EventMarketAssignmentOrganizerStockPool = {
  state: "active",
  poolId,
  organizerPubkey: organizer,
  quantity: 6,
  importedQuantity: 0,
}

function signed(input: EventMarketAssignmentDraftInput = base) {
  return finalizeEvent(
    { ...buildEventMarketAssignmentDraft(input), created_at: 101 },
    merchantSecret
  )
}

function marker(value = pool): string[] {
  return [
    EVENT_MARKET_ASSIGNMENT_STOCK_POOL_TAG,
    "1",
    value.state,
    value.poolId,
    value.organizerPubkey,
    String(value.quantity),
    String(value.importedQuantity),
  ]
}

function signedMarkers(markers: string[][], input = base) {
  const draft = buildEventMarketAssignmentDraft(input)
  return finalizeEvent(
    { ...draft, tags: [...draft.tags, ...markers], created_at: 101 },
    merchantSecret
  )
}

describe("Conduit assignment stock-pool commitment", () => {
  it("preserves external assignment parsing without the optional extension", () => {
    const draft = buildEventMarketAssignmentDraft(base)
    const event = finalizeEvent(
      {
        ...draft,
        tags: [...draft.tags, ["title", "External item"]],
        created_at: 101,
      },
      merchantSecret
    )
    expect(parseEventMarketAssignmentEvent(event)).toMatchObject({
      stockPool: { state: "absent" },
      productCoordinate: base.productCoordinate,
      inventory: base.inventory,
    })
  })

  for (const state of ["active", "closed"] as const) {
    for (const importedQuantity of [0, 2, 6]) {
      it(`round trips ${state} with ${importedQuantity} imported units`, () => {
        const terms = { ...pool, state, importedQuantity }
        const event = signed({ ...base, organizerStockPool: terms })
        expect(
          event.tags.filter(
            (tag) => tag[0] === EVENT_MARKET_ASSIGNMENT_STOCK_POOL_TAG
          )
        ).toEqual([marker(terms)])
        expect(parseEventMarketAssignmentEvent(event)?.stockPool).toEqual({
          state: "valid",
          pool: terms,
        })
      })
    }
  }

  it("supports the exact maximum count and retains a closed removed assignment", () => {
    const maximum = {
      ...pool,
      quantity: 2_147_483_647,
      importedQuantity: 2_147_483_647,
    }
    expect(
      parseEventMarketAssignmentEvent(
        signed({ ...base, organizerStockPool: maximum })
      )?.stockPool
    ).toEqual({ state: "valid", pool: maximum })
    const closed = { ...pool, state: "closed" as const, importedQuantity: 2 }
    expect(
      parseEventMarketAssignmentEvent(
        signed({
          ...base,
          state: "removed",
          inventory: { mode: "tracked", quantity: 0 },
          fulfillmentMethods: [],
          organizerStockPool: closed,
        })
      )?.stockPool
    ).toEqual({ state: "valid", pool: closed })
  })

  const invalidPools: Array<
    [string, Partial<EventMarketAssignmentOrganizerStockPool>]
  > = [
    ["zero quantity", { quantity: 0 }],
    ["negative quantity", { quantity: -1 }],
    ["fractional quantity", { quantity: 1.5 }],
    ["over-limit quantity", { quantity: 2_147_483_648 }],
    ["nonfinite quantity", { quantity: Infinity }],
    ["negative imports", { importedQuantity: -1 }],
    ["fractional imports", { importedQuantity: 1.5 }],
    ["excess imports", { importedQuantity: 7 }],
    ["wrong organizer", { organizerPubkey: merchant }],
    ["malformed commitment", { poolId: "not-an-event-id" }],
  ]
  for (const [name, change] of invalidPools) {
    it(`rejects builder ${name}`, () => {
      expect(() =>
        buildEventMarketAssignmentDraft({
          ...base,
          organizerStockPool: { ...pool, ...change },
        })
      ).toThrow("occurrence assignment is invalid")
    })
  }

  it("does not invent an organizer count for untracked inventory", () => {
    const untracked: EventMarketAssignmentDraftInput = {
      ...base,
      inventory: { mode: "untracked" },
    }
    expect(() =>
      buildEventMarketAssignmentDraft({
        ...untracked,
        organizerStockPool: pool,
      })
    ).toThrow()
    expect(
      parseEventMarketAssignmentEvent(signedMarkers([marker()], untracked))
        ?.stockPool
    ).toEqual({ state: "invalid" })
  })

  const invalidMarkers: Array<[string, (tag: string[]) => string[][]]> = [
    ["duplicate", (tag) => [tag, [...tag]]],
    ["unknown version", (tag) => [[tag[0]!, "2", ...tag.slice(2)]]],
    [
      "unknown state",
      (tag) => [[...tag.slice(0, 2), "revoked", ...tag.slice(3)]],
    ],
    ["extra field", (tag) => [[...tag, "extra"]]],
    ["missing field", (tag) => [tag.slice(0, -1)]],
    ["zero quantity", (tag) => [[...tag.slice(0, 5), "0", "0"]]],
    ["leading-zero quantity", (tag) => [[...tag.slice(0, 5), "06", "0"]]],
    ["leading-zero imported", (tag) => [[...tag.slice(0, 6), "00"]]],
    ["negative imported", (tag) => [[...tag.slice(0, 6), "-1"]]],
    ["over-limit quantity", (tag) => [[...tag.slice(0, 5), "2147483648", "0"]]],
    ["excess imported", (tag) => [[...tag.slice(0, 6), "7"]]],
    [
      "wrong organizer",
      (tag) => [[...tag.slice(0, 4), merchant, ...tag.slice(5)]],
    ],
    [
      "malformed commitment",
      (tag) => [[...tag.slice(0, 3), "invalid", ...tag.slice(4)]],
    ],
  ]
  for (const [name, mutate] of invalidMarkers) {
    it(`keeps general evidence but denies marker authority for ${name}`, () => {
      const event = signedMarkers(mutate(marker()))
      const parsed = parseEventMarketAssignmentEvent(event)
      expect(parsed).not.toBeNull()
      expect(parsed?.stockPool).toEqual({ state: "invalid" })
      expect(parsed?.signedEvent).toEqual(event)
    })
  }

  it("requires the marker to be covered by the merchant signature", () => {
    const event = signed()
    expect(
      parseEventMarketAssignmentEvent({
        ...event,
        tags: [...event.tags, marker()],
      })
    ).toBeNull()
  })

  it("does not admit held or invalid terms through ordinary product suitability", async () => {
    const product = parseProductEvent(
      await admitFixtureEvent(
        finalizeEvent(
          {
            kind: 30402,
            created_at: 100,
            tags: [
              ["d", "item"],
              ["type", "simple", "physical"],
              ["stock", "6"],
              ["price", "10", "SATS"],
            ],
            content: "item",
          },
          merchantSecret
        )
      )
    )
    const active = parseEventMarketAssignmentEvent(
      signed({ ...base, organizerStockPool: pool })
    )!
    const invalid = parseEventMarketAssignmentEvent(
      signedMarkers([[EVENT_MARKET_ASSIGNMENT_STOCK_POOL_TAG, "9"]])
    )!
    const absent = parseEventMarketAssignmentEvent(signed())!
    const closed = parseEventMarketAssignmentEvent(
      signed({ ...base, organizerStockPool: { ...pool, state: "closed" } })
    )!
    expect(
      isEventMarketAssignmentProductSuitable({ assignment: active, product })
    ).toBe(false)
    expect(
      isEventMarketAssignmentProductSuitable({
        assignment: active,
        product,
        organizerHandoff: { organizerPubkey: organizer },
      })
    ).toBe(true)
    expect(
      isEventMarketAssignmentProductSuitable({
        assignment: active,
        product,
        organizerHandoff: { organizerPubkey: merchant },
      })
    ).toBe(false)
    expect(
      isEventMarketAssignmentProductSuitable({
        assignment: absent,
        product,
        organizerHandoff: { organizerPubkey: organizer },
      })
    ).toBe(false)
    expect(
      isEventMarketAssignmentProductSuitable({
        assignment: closed,
        product,
        organizerHandoff: { organizerPubkey: organizer },
      })
    ).toBe(false)
    expect(
      isEventMarketAssignmentProductSuitable({ assignment: invalid, product })
    ).toBe(false)
    expect(
      isEventMarketAssignmentProductSuitable({ assignment: absent, product })
    ).toBe(true)
    expect(
      isEventMarketAssignmentProductSuitable({ assignment: closed, product })
    ).toBe(true)
  })

  it("detects divergent pool commitments even when assignment quantities match", async () => {
    const initial = signed()
    const first = signed({
      ...base,
      previousEventId: initial.id,
      organizerStockPool: pool,
    })
    const secondPoolId = finalizeEvent(
      { kind: 16, created_at: 100, tags: [], content: "other synthetic grant" },
      merchantSecret
    ).id
    const second = signed({
      ...base,
      previousEventId: initial.id,
      organizerStockPool: { ...pool, poolId: secondPoolId },
    })
    const dependencies = {
      ...source([initial, first, second]),
      load: async () => [] as SignedPublicNostrEvent[],
      retain: async () => undefined,
    }
    const result = await readEventMarketAssignment(
      {
        marketCoordinate: base.marketCoordinate,
        occurrenceCoordinate: base.occurrenceCoordinate,
        productCoordinate: base.productCoordinate,
      },
      dependencies
    )
    expect(result.state).toBe("conflicting")
  })
})

function source(
  events: readonly SignedPublicNostrEvent[],
  status: "success" | "partial" = "success"
) {
  return {
    plan: async () => ({
      relayUrls: ["wss://source.example"],
      candidateRelayUrls: ["wss://source.example"],
      maxRelayAttempts: 1,
      ownerSelectedRelayUrls: [],
      appRelayUrls: ["wss://source.example"],
      personalRelayUrls: [],
      independentRelayUrls: [],
      relayListState: "missing" as const,
      relayHintTruncated: false,
    }),
    fetch: async (filter: Filter) => ({
      events: events.filter((event) => matchFilter(filter, event)),
      relays: [{ relayUrl: "wss://source.example", status }],
    }),
  }
}

async function withDb(run: (db: ConduitDB) => Promise<void>) {
  const db = new ConduitDB(`organizer-marker-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  try {
    await run(db)
  } finally {
    await db.delete()
  }
}

function recoveryFixture(state: "active" | "closed" = "active") {
  const fixture = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const original = fixture.fulfillment.occurrenceAssignment!.signedEvent
  const terms = {
    ...pool,
    state,
    organizerPubkey: fixture.organizer,
    importedQuantity: 2,
  }
  const assignment = finalizeEvent(
    {
      kind: original.kind,
      content: original.content,
      tags: [...original.tags, marker(terms)],
      created_at: original.created_at + 1,
    },
    fixture.merchantSecret
  )
  return {
    ...fixture,
    original,
    assignment,
    events: [
      ...fixture.events.filter((event) => event.kind !== 30410),
      assignment,
    ],
    input: (db: ConduitDB) => ({
      db,
      merchantPubkey: fixture.merchant,
      productCoordinate: fixture.fulfillment.product.coordinate,
      signedProductEvent: fixture.fulfillment.product.signedEvent,
    }),
  }
}

describe("cold Merchant stock recovery with organizer commitments", () => {
  it("retains an active hold and creates no inferred Merchant stock", async () => {
    await withDb(async (db) => {
      const fixture = recoveryFixture()
      const result = await recoverMerchantInventoryProduct(
        fixture.input(db),
        source(fixture.events)
      )
      expect(result).toMatchObject({
        state: "unsafe_conflict",
        reason: "organizer_stock_recovery_required",
      })
      expect(await db.merchantInventoryProducts.count()).toBe(0)
      expect(await db.merchantInventoryAssignments.count()).toBe(0)
      expect(
        (await db.eventMarketRosterEvidence.toCollection().first())?.signedEvent
          .id
      ).toBe(fixture.assignment.id)
      db.close()
      await db.open()
      const stale = await recoverMerchantInventoryProduct(
        fixture.input(db),
        source([fixture.original], "partial")
      )
      expect(stale).toMatchObject({
        state: "unsafe_conflict",
        reason: "organizer_stock_recovery_required",
        coverage: "partial",
      })
      expect(await db.merchantInventoryProducts.count()).toBe(0)
    })
  })

  it("does not free an active hold after occurrence expiry or a signed assignment deletion", async () => {
    await withDb(async (db) => {
      const fixture = recoveryFixture()
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: 200,
          tags: [["e", fixture.assignment.id]],
          content: "",
        },
        fixture.merchantSecret
      )
      setSystemTime(new Date(fixture.fulfillment.calendar.end + 1_000))
      try {
        const result = await recoverMerchantInventoryProduct(
          fixture.input(db),
          source([...fixture.events, deletion])
        )
        expect(result).toMatchObject({
          state: "unsafe_conflict",
          reason: "organizer_stock_recovery_required",
        })
      } finally {
        setSystemTime()
      }
      expect(await db.merchantInventoryProducts.count()).toBe(0)
    })
  })

  it("treats malformed or unsupported markers as a scoped recovery requirement", async () => {
    for (const tag of [
      marker({ ...pool, organizerPubkey: merchant }),
      [EVENT_MARKET_ASSIGNMENT_STOCK_POOL_TAG, "9"],
    ]) {
      await withDb(async (db) => {
        const fixture = recoveryFixture()
        const malformed = finalizeEvent(
          {
            ...fixture.original,
            tags: [...fixture.original.tags, tag],
            created_at: 103,
          },
          fixture.merchantSecret
        )
        const result = await recoverMerchantInventoryProduct(
          fixture.input(db),
          source([malformed])
        )
        expect(result).toMatchObject({
          state: "unsafe_conflict",
          reason: "organizer_stock_recovery_required",
        })
        expect(await db.merchantInventoryProducts.count()).toBe(0)
      })
    }
  })

  it("retains an explicit closed marker without restoring a new delegation", async () => {
    await withDb(async (db) => {
      const fixture = recoveryFixture("closed")
      const result = await recoverMerchantInventoryProduct(
        fixture.input(db),
        source(fixture.events)
      )
      expect(result).toMatchObject({ state: "ready", recoveredAssignments: 1 })
      const recovered = await db.merchantInventoryAssignments
        .toCollection()
        .first()
      expect(
        parseEventMarketAssignmentEvent(recovered!.signedAssignmentEvent!)
          ?.stockPool
      ).toMatchObject({ state: "valid", pool: { state: "closed", poolId } })
    })
  })

  it("catches a newer hold discovered only during exact assignment lookup", async () => {
    await withDb(async (db) => {
      const fixture = recoveryFixture()
      const dependencies = source(fixture.events)
      const fetch = dependencies.fetch
      dependencies.fetch = async (filter) =>
        filter.kinds?.includes(30410) && !filter["#d"]
          ? {
              events: [fixture.original],
              relays: [{ relayUrl: "wss://source.example", status: "success" }],
            }
          : fetch(filter)
      const result = await recoverMerchantInventoryProduct(
        fixture.input(db),
        dependencies
      )
      expect(result).toMatchObject({
        state: "unsafe_conflict",
        reason: "organizer_stock_recovery_required",
      })
      expect(await db.merchantInventoryProducts.count()).toBe(0)
    })
  })

  it("does not infer reconciliation from an exact-read deletion of a newer held assignment", async () => {
    await withDb(async (db) => {
      const fixture = recoveryFixture()
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: 200,
          tags: [["e", fixture.assignment.id]],
          content: "",
        },
        fixture.merchantSecret
      )
      const dependencies = source([...fixture.events, deletion])
      const fetch = dependencies.fetch
      dependencies.fetch = async (filter) =>
        filter.kinds?.includes(30410) && !filter["#d"]
          ? {
              events: [fixture.original],
              relays: [{ relayUrl: "wss://source.example", status: "success" }],
            }
          : fetch(filter)
      const result = await recoverMerchantInventoryProduct(
        fixture.input(db),
        dependencies
      )
      expect(result).toMatchObject({
        state: "unsafe_conflict",
        reason: "organizer_stock_recovery_required",
      })
      expect(await db.merchantInventoryProducts.count()).toBe(0)
    })
  })
})

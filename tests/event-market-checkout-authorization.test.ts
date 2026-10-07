import { describe, expect, it } from "bun:test"
import { matchFilter, type Filter } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  buildEventMarketAssignmentDraft,
  buildEventMarketRosterDraft,
  buildEventMarketSeriesDraft,
  createEventMarketPickupSnapshot,
  orderItemSchema,
  parseProductEvent,
  readEventMarketProduct,
  readEventMarketRoster,
  type EventMarketMerchantRow,
  type Product,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import { authorizeCurrentCheckoutItems } from "../apps/market/src/lib/checkout-authorization"
import {
  createCartItemFromProduct,
  type CartItem,
} from "../apps/market/src/lib/cart-model"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const anotherMerchant = getPublicKey(generateSecretKey())
const marketCoordinate = `30409:${organizer}:market`
const calendarCoordinate = `31923:${organizer}:first`
const secondCalendarCoordinate = `31923:${organizer}:second`
const seriesCoordinate = `31924:${organizer}:series`
const productCoordinate = `30402:${merchant}:soap`
const row: EventMarketMerchantRow = {
  pubkey: merchant,
  mode: "merchant_present",
  assignment: "Booth 12",
}

function signed(
  kind: number,
  tags: string[][],
  createdAt = 100,
  secret = organizerSecret,
  content = ""
): SignedPublicNostrEvent {
  return finalizeEvent({ kind, tags, created_at: createdAt, content }, secret)
}

function calendar(dTag = "first", createdAt = 100, start = 1_900_000_000) {
  return signed(
    31923,
    [
      ["d", dTag],
      ["title", "Community market"],
      ["start", String(start)],
      ["end", String(start + 3_600)],
      ["D", String(Math.floor(start / 86_400))],
    ],
    createdAt
  )
}

function roster(
  rows = [row],
  createdAt = 100,
  previousEventId?: string,
  series = false
) {
  const draft = buildEventMarketRosterDraft({
    dTag: "market",
    organizerPubkey: organizer,
    calendarCoordinate: series ? seriesCoordinate : calendarCoordinate,
    state: "open",
    merchants: rows,
    previousEventId,
  })
  return signed(draft.kind, draft.tags, createdAt)
}

function schedule(
  members = [calendarCoordinate, secondCalendarCoordinate],
  createdAt = 100
) {
  const draft = buildEventMarketSeriesDraft({
    dTag: "series",
    organizerPubkey: organizer,
    title: "Community market dates",
    memberCoordinates: members,
  })
  return signed(draft.kind, draft.tags, createdAt)
}

function product(createdAt = 100, price = "100") {
  return signed(
    30402,
    [
      ["d", "soap"],
      ["title", "Handmade soap"],
      ["price", price, "SAT"],
      ["type", "simple", "physical"],
      ["stock", "6"],
    ],
    createdAt,
    merchantSecret,
    "Soap"
  )
}

function assignment(occurrenceCoordinate = calendarCoordinate) {
  const draft = buildEventMarketAssignmentDraft({
    marketCoordinate,
    occurrenceCoordinate,
    productCoordinate,
    merchantPubkey: merchant,
    state: "active",
    inventory: { mode: "tracked", quantity: 6 },
    fulfillmentMethods: ["pickup"],
  })
  return signed(draft.kind, draft.tags, 101, merchantSecret)
}

function grant(
  state: "active" | "revoked" = "active",
  parent?: SignedPublicNostrEvent,
  createdAt = 100
) {
  const draft = buildEventMarketAuthorizationDraft({
    marketCoordinate,
    merchantPubkey: merchant,
    state,
    sequence: parent ? 1 : 0,
    parentIds: parent ? [parent.id] : [],
  })
  return signed(draft.kind, draft.tags, createdAt)
}

async function fixture(series = false) {
  const live = [
    roster([row], 100, undefined, series),
    calendar(),
    grant(),
    product(),
    assignment(),
  ]
  if (series)
    live.push(
      schedule(),
      calendar("second", 100, 1_900_086_400),
      assignment(secondCalendarCoordinate)
    )
  const retained = new Map<string, SignedPublicNostrEvent>()
  const dependencies: NonNullable<Parameters<typeof readEventMarketRoster>[1]> =
    {
      plan: async () => ({
        relayUrls: ["wss://ready.example", "wss://offline.example"],
        candidateRelayUrls: ["wss://ready.example", "wss://offline.example"],
        maxRelayAttempts: 2,
        ownerSelectedRelayUrls: [],
        appRelayUrls: ["wss://ready.example"],
        personalRelayUrls: [],
        independentRelayUrls: ["wss://offline.example"],
        relayListState: "missing",
        relayHintTruncated: false,
      }),
      fetch: async (filter) => ({
        events: live.filter((event) => matchFilter(filter as Filter, event)),
        relays: [{ relayUrl: "wss://ready.example", status: "success" }],
      }),
      load: async () => [...retained.values()],
      retain: async (_coordinate, events) => {
        for (const event of events) retained.set(event.id, event)
      },
    }
  const readMarket = (query: Parameters<typeof readEventMarketRoster>[0]) =>
    readEventMarketRoster(query, dependencies)
  const readProduct = (query: Parameters<typeof readEventMarketProduct>[0]) =>
    readEventMarketProduct(query, dependencies)
  const marketRead = await readMarket({ reference: marketCoordinate })
  const productRead = await readProduct({
    marketRead,
    productCoordinate,
    selectedOccurrenceCoordinate: calendarCoordinate,
  })
  expect(productRead.actionable).toBe(true)
  const accepted = createEventMarketPickupSnapshot({
    marketRead,
    productRead,
    selectedOccurrenceCoordinate: calendarCoordinate,
  })
  const parsedProduct = () => {
    const event =
      live.filter((entry) => entry.kind === 30402).at(-1) ??
      [...retained.values()].filter((entry) => entry.kind === 30402).at(-1)!
    return { ...parseProductEvent(event), sourceEventId: event.id } as Product
  }
  const item: CartItem = {
    ...createCartItemFromProduct(parsedProduct(), accepted),
    quantity: 1,
  }
  let handlerCalls = 0
  const submit = (
    reviewedItems: CartItem[] = [item],
    rawItems: CartItem[] = [item],
    overrides: Partial<Parameters<typeof authorizeCurrentCheckoutItems>[0]> = {}
  ) =>
    authorizeCurrentCheckoutItems({
      mode: "direct_payment",
      reviewedItems,
      rawItems,
      refreshedProducts: [parsedProduct()],
      readShippingOptions: async () => {
        throw new Error("Event pickup must not read shipping")
      },
      authorizePickupHandlers: async () => {
        handlerCalls++
      },
      futureEventMarketDependencies: {
        readMarket,
        readProduct,
        snapshot: createEventMarketPickupSnapshot,
      },
      ...overrides,
    })
  const replace = (kind: number, event: SignedPublicNostrEvent) => {
    live.splice(
      live.findIndex((entry) => entry.kind === kind),
      1,
      event
    )
  }
  return {
    live,
    retained,
    dependencies,
    item,
    submit,
    replace,
    readMarket,
    readProduct,
    handlerCalls: () => handlerCalls,
  }
}

describe("composed Event Market submit authorization", () => {
  it("blocks a single-date market after its occurrence ends", async () => {
    const state = await fixture(false)
    const originalNow = Date.now
    Date.now = () => 1_900_004_000_000
    try {
      expect((await state.submit()).status).toBe("changed")
      expect(state.handlerCalls()).toBe(0)
    } finally {
      Date.now = originalNow
    }
  })

  it("rejects an expired series date at snapshot creation and submit without closing other dates", async () => {
    const state = await fixture(true)
    const originalNow = Date.now
    Date.now = () => 1_900_004_000_000
    try {
      expect((await state.submit()).status).not.toBe("ok")
      expect(state.handlerCalls()).toBe(0)
      const marketRead = await state.readMarket({ reference: marketCoordinate })
      const productRead = await state.readProduct({
        marketRead,
        productCoordinate,
        selectedOccurrenceCoordinate: secondCalendarCoordinate,
      })
      expect(
        createEventMarketPickupSnapshot({
          marketRead,
          productRead,
          selectedOccurrenceCoordinate: secondCalendarCoordinate,
        }).calendar.coordinate
      ).toBe(secondCalendarCoordinate)
    } finally {
      Date.now = originalNow
    }
  })

  for (const series of [false, true]) {
    it(`refreshes harmless ${series ? "series" : "single-date"} roster evidence through both checkout fingerprints`, async () => {
      const state = await fixture(series)
      const previous = state.live[0]!
      const current = roster(
        [row, { ...row, pubkey: anotherMerchant, assignment: "Booth 14" }],
        101,
        previous.id,
        series
      )
      state.replace(30409, current)
      const result = await state.submit()
      expect(result.status).toBe("ok")
      if (result.status !== "ok")
        throw new Error("Harmless roster refresh blocked submit")
      const fulfillment = result.items[0]!.fulfillment
      expect(fulfillment?.type).toBe("event_market_pickup")
      if (fulfillment?.type !== "event_market_pickup")
        throw new Error("Missing current snapshot")
      expect(fulfillment.market.eventId).toBe(current.id)
      expect(fulfillment.market.signedEvent).toEqual(
        JSON.parse(JSON.stringify(current))
      )
      expect(state.item.fulfillment).toMatchObject({
        market: { eventId: previous.id },
      })
      expect(state.handlerCalls()).toBe(1)
      const acceptedOrderItem = orderItemSchema.parse({
        productId: productCoordinate,
        title: "Handmade soap",
        format: "physical",
        quantity: 1,
        priceAtPurchase: 100,
        currency: "SATS",
        sourcePrice: result.items[0]!.sourcePrice,
        fulfillment,
      })
      expect(acceptedOrderItem.fulfillment).toEqual(fulfillment)
    })
  }

  for (const failure of ["one-relay", "deletion-reads"] as const) {
    it(`authorizes adequate signed positive facts while reporting ${failure} partial coverage`, async () => {
      const state = await fixture(true)
      const fetch = state.dependencies.fetch
      state.dependencies.fetch = async (filter, options) => {
        if (failure === "deletion-reads" && filter.kinds?.includes(5))
          throw new Error("Deletion source unavailable")
        const result = await fetch(filter, options)
        return {
          ...result,
          relays: [
            ...result.relays,
            { relayUrl: "wss://offline.example", status: "failed" as const },
          ],
        }
      }
      const marketRead = await state.readMarket({ reference: marketCoordinate })
      const exact = await state.readProduct({
        marketRead,
        productCoordinate,
        selectedOccurrenceCoordinate: calendarCoordinate,
      })
      expect(marketRead.coverage).toBe("partial")
      expect(marketRead.calendarCoverage).toBe("partial")
      expect(exact.coverage).toBe("partial")
      expect(exact.authorization?.coverage).toBe("partial")
      expect(exact.actionable).toBe(true)
      expect((await state.submit()).status).toBe("ok")
    })
  }

  for (const change of [
    "mode",
    "assignment",
    "venue",
    "date",
    "product",
    "price",
    "membership",
  ] as const) {
    it(`requires review for a signed ${change} change before handler authorization`, async () => {
      const state = await fixture(change === "membership")
      if (change === "mode" || change === "assignment") {
        state.replace(
          30409,
          roster(
            [
              {
                ...row,
                ...(change === "mode"
                  ? { mode: "organizer_handoff" as const }
                  : { assignment: "Booth 20" }),
              },
            ],
            101,
            state.live[0]!.id
          )
        )
      } else if (change === "venue") {
        const current = calendar("first", 101)
        state.replace(
          31923,
          signed(31923, [...current.tags, ["location", "New venue"]], 101)
        )
      } else if (change === "date")
        state.replace(31923, calendar("first", 101, 1_900_001_000))
      else if (change === "membership")
        state.replace(31924, schedule([secondCalendarCoordinate], 101))
      else
        state.replace(30402, product(101, change === "price" ? "101" : "100"))
      expect(await state.submit()).toEqual({ status: "changed" })
      expect(state.handlerCalls()).toBe(0)
    })
  }

  it("checks reviewed terms before replacing their signed evidence", async () => {
    const state = await fixture()
    if (state.item.fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing snapshot")
    const reviewed = {
      ...state.item,
      fulfillment: { ...state.item.fulfillment, assignment: "Booth 99" },
    }
    expect(await state.submit([reviewed])).toEqual({ status: "changed" })
  })

  it("blocks a changed reviewed payee before commitment", async () => {
    const state = await fixture()
    if (state.item.fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing snapshot")
    const reviewed = {
      ...state.item,
      fulfillment: { ...state.item.fulfillment, payeePubkey: organizer },
    }
    expect(await state.submit([reviewed])).toEqual({ status: "changed" })
    expect(state.handlerCalls()).toBe(0)
  })

  it("permits the selected date when a sibling is unavailable", async () => {
    const state = await fixture(true)
    const second = state.live.find((event) =>
      event.tags.some((tag) => tag[0] === "d" && tag[1] === "second")
    )!
    state.live.splice(state.live.indexOf(second), 1)
    state.retained.delete(second.id)
    const marketRead = await state.readMarket({ reference: marketCoordinate })
    expect(marketRead.scheduleCoverage).toBe("partial")
    expect((await state.submit()).status).toBe("ok")
  })

  it("refreshes signed schedule membership when only unrelated dates are added or removed", async () => {
    const state = await fixture(true)
    const third = `31923:${organizer}:third`
    for (const current of [
      schedule([calendarCoordinate, secondCalendarCoordinate, third], 101),
      schedule([calendarCoordinate], 102),
    ]) {
      state.replace(31924, current)
      const result = await state.submit()
      expect(result.status).toBe("ok")
      if (
        result.status !== "ok" ||
        result.items[0]?.fulfillment?.type !== "event_market_pickup"
      )
        throw new Error("Unrelated schedule membership blocked submit")
      expect(result.items[0].fulfillment.schedule?.eventId).toBe(current.id)
    }
  })

  it("refreshes an unchanged schedule revision but blocks removal of the selected date", async () => {
    const state = await fixture(true)
    state.replace(31924, schedule(undefined, 101))
    expect((await state.submit()).status).toBe("ok")
    state.replace(31924, schedule([secondCalendarCoordinate], 102))
    expect(await state.submit()).toEqual({ status: "changed" })
  })

  for (const kind of [30409, 31923, 3841, 30402]) {
    it(`blocks cached-only required kind ${kind} despite other healthy sources`, async () => {
      const state = await fixture()
      state.live.splice(
        state.live.findIndex((event) => event.kind === kind),
        1
      )
      expect(await state.submit()).toEqual({ status: "changed" })
      expect(state.handlerCalls()).toBe(0)
      expect(state.retained.size).toBeGreaterThan(0)
    })
  }

  for (const defect of [
    "revoke",
    "deletion",
    "fork",
    "missing-parent",
  ] as const) {
    it(`keeps known ${defect} authorization blocking with one failed relay`, async () => {
      const state = await fixture()
      const root = state.live.find((event) => event.kind === 3841)!
      const next = grant(defect === "revoke" ? "revoked" : "active", root, 101)
      if (defect === "revoke") state.retained.set(next.id, next)
      else if (defect === "deletion") {
        const deletion = signed(
          5,
          [
            ["e", root.id],
            ["a", marketCoordinate],
            ["p", merchant],
          ],
          101
        )
        state.retained.set(deletion.id, deletion)
      } else if (defect === "fork") {
        state.live.push(next)
        const sibling = grant("active", root, 102)
        state.retained.set(sibling.id, sibling)
      } else {
        state.replace(3841, next)
        state.retained.delete(root.id)
      }
      const fetch = state.dependencies.fetch
      state.dependencies.fetch = async (filter, options) => {
        const result = await fetch(filter, options)
        return {
          ...result,
          relays: [
            ...result.relays,
            { relayUrl: "wss://offline.example", status: "failed" as const },
          ],
        }
      }
      expect(await state.submit()).toEqual({ status: "changed" })
      expect(state.handlerCalls()).toBe(0)
    })
  }

  for (const boundary of ["hint-truncation", "transition-cap"] as const) {
    for (const defect of ["missing-parent", "malformed"] as const) {
      it(`keeps ${defect} blocking when source coverage has ${boundary}`, async () => {
        const state = await fixture()
        const root = state.live.find((event) => event.kind === 3841)!
        const next = grant("active", root, 101)
        if (defect === "missing-parent") {
          state.replace(3841, next)
          state.retained.delete(root.id)
        } else {
          state.live.push(
            signed(3841, [...next.tags, ["state", "revoked"]], 102)
          )
        }
        if (boundary === "hint-truncation") {
          const plan = state.dependencies.plan
          state.dependencies.plan = async (query) => ({
            ...(await plan(query)),
            relayHintTruncated: true,
          })
        } else {
          const fetch = state.dependencies.fetch
          state.dependencies.fetch = async (filter, options) => {
            const result = await fetch(filter, options)
            return filter.kinds?.includes(3841 as never) && !filter.ids
              ? {
                  ...result,
                  events: [
                    ...result.events,
                    ...Array.from(
                      { length: 128 - result.events.length },
                      () => result.events[0]!
                    ),
                  ],
                }
              : result
          }
        }
        const marketRead = await state.readMarket({
          reference: marketCoordinate,
        })
        const exact = await state.readProduct({ marketRead, productCoordinate })
        expect(exact.authorization?.coverage).toBe("partial")
        expect(exact.authorization?.resolution.state).toBe(
          defect === "missing-parent" ? "missing_parent" : "malformed"
        )
        expect(await state.submit()).toEqual({ status: "changed" })
        expect(state.handlerCalls()).toBe(0)
      })
    }
  }

  it("propagates handler authorization failure after exact current terms pass", async () => {
    const state = await fixture()
    await expect(
      state.submit(undefined, undefined, {
        authorizePickupHandlers: async () => {
          throw new Error("Organizer inbox unavailable")
        },
      })
    ).rejects.toThrow("Organizer inbox unavailable")
  })
})

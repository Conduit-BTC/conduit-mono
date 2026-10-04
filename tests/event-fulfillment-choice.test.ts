import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  buildEventMarketRosterDraft,
} from "@conduit/core"
import {
  groupCartPurchases,
  parsePersistedCart,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import {
  addCartRepositoryItem,
  changeCartRepositoryFulfillment,
  clearCartRepository,
  captureCartPurchase,
  consumeCartPurchase,
  getCartRepositorySnapshot,
  incrementCartRepositoryItem,
} from "../apps/market/src/lib/cart-repository"
import { hasEventShippingChoice } from "../apps/market/src/lib/event-fulfillment-choice"

const organizerSecret = generateSecretKey()
const organizer = getPublicKey(organizerSecret)
const merchantSecret = generateSecretKey()
const merchant = getPublicKey(merchantSecret)
const marketCoordinate = `30409:${organizer}:fair-market`
const calendarCoordinate = `31923:${organizer}:fair`
const calendar = finalizeEvent(
  {
    kind: 31923,
    tags: [
      ["d", "fair"],
      ["title", "Fair"],
      ["start", "1790000000"],
      ["end", "1790003600"],
      ["D", "20717"],
    ],
    content: "",
    created_at: 100,
  },
  organizerSecret
)
const grantDraft = buildEventMarketAuthorizationDraft({
  marketCoordinate,
  merchantPubkey: merchant,
  state: "active",
  sequence: 0,
  parentIds: [],
})
const grant = finalizeEvent({ ...grantDraft, created_at: 1 }, organizerSecret)

function item(
  dTag: string,
  assignment = "Booth 12",
  marketEventId?: string
): CartItem {
  const productId = `30402:${merchant}:${dTag}`
  const market = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag: "fair-market",
        organizerPubkey: organizer,
        calendarCoordinate,
        state: "open",
        merchants: [{ pubkey: merchant, mode: "merchant_present", assignment }],
      }),
      created_at: 100,
    },
    organizerSecret
  )
  const product = finalizeEvent(
    {
      kind: 30402,
      tags: [
        ["d", dTag],
        ["title", dTag],
        ["price", "12", "USD"],
        ["type", "simple", "physical"],
        ["a", marketCoordinate],
      ],
      content: dTag,
      created_at: 100,
    },
    merchantSecret
  )
  return {
    productId,
    merchantPubkey: merchant,
    title: dTag,
    price: 12,
    currency: "USD",
    format: "physical",
    quantity: 1,
    fulfillment: {
      type: "event_market_pickup",
      organizerPubkey: organizer,
      merchantPubkey: merchant,
      payeePubkey: merchant,
      market: {
        coordinate: marketCoordinate,
        eventId: marketEventId ?? market.id,
        createdAt: 100_000,
        signedEvent: market,
      },
      grant: {
        kind: 3841,
        pubkey: organizer,
        eventId: grant.id,
        createdAt: 1_000,
        ancestryEventIds: [grant.id],
        observedDeletionEventIds: [],
        signedEvidence: { tip: grant, ancestry: [grant], deletions: [] },
      },
      calendar: {
        coordinate: calendarCoordinate,
        eventId: calendar.id,
        createdAt: 100_000,
        start: 1_790_000_000_000,
        end: 1_790_003_600_000,
        signedEvent: calendar,
      },
      product: {
        coordinate: productId,
        eventId: product.id,
        createdAt: 100_000,
        signedEvent: product,
      },
      mode: "merchant_present",
      assignment,
    },
  }
}

afterEach(async () => {
  await clearCartRepository()
})

describe("Event Market fulfillment choice", () => {
  function pickup() {
    const input = item("soap")
    if (input.fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing pickup")
    return {
      ...input,
      stock: 3,
      productEventId: input.fulfillment.product.eventId,
      productUpdatedAt: input.fulfillment.product.createdAt,
      eventMarketContext: { marketCoordinate, calendarCoordinate },
    }
  }
  function shipping() {
    const input = pickup()
    return {
      ...input,
      fulfillment: { type: "shipping" as const },
      shippingOptionId: `30406:${merchant}:shop-shipping`,
      shippingCostSats: 200,
    }
  }
  it("persists choice and groups shipping separately from the same product at an event", () => {
    const parsed = parsePersistedCart({
      version: 2,
      items: [pickup(), shipping()],
    })
    expect(parsed.state.items).toHaveLength(2)
    expect(parsed.state.items[1]?.eventMarketContext).toEqual({
      marketCoordinate,
      calendarCoordinate,
    })
    expect(
      groupCartPurchases(parsed.state.items)
        .map((group) => group.kind)
        .sort()
    ).toEqual(["delivery", "pickup"])
  })
  it("preserves quantity, invalidates a captured purchase and rejects a stale revision", async () => {
    await clearCartRepository()
    await addCartRepositoryItem(pickup(), 2)
    const before = getCartRepositorySnapshot()
    const line = before.items[0]!
    const purchase = groupCartPurchases(before.items)[0]!
    const claim = await captureCartPurchase(purchase.id, purchase.items)
    const result = await changeCartRepositoryFulfillment(
      line,
      shipping(),
      before.revision
    )
    expect(result.changed).toBe(true)
    expect(result.after[0]?.quantity).toBe(2)
    expect(result.after[0]?.cartLineId).not.toBe(line.cartLineId)
    await consumeCartPurchase(claim)
    expect(getCartRepositorySnapshot().items[0]?.quantity).toBe(2)
    expect(
      (await changeCartRepositoryFulfillment(line, pickup(), before.revision))
        .changed
    ).toBe(false)
  })
  it("checks one stock pool across fulfillment lanes", async () => {
    await clearCartRepository()
    await addCartRepositoryItem(pickup(), 2)
    expect((await addCartRepositoryItem(shipping())).changed).toBe(true)
    expect((await addCartRepositoryItem(pickup())).changed).toBe(false)
    const line = getCartRepositorySnapshot().items[0]!
    expect((await incrementCartRepositoryItem(line)).changed).toBe(false)
  })
  for (const destination of ["shipping", "pickup"] as const) {
    it(`merges into an existing ${destination} line without consuming moved quantities through old claims`, async () => {
      const source = destination === "shipping" ? pickup() : shipping()
      const target = destination === "shipping" ? shipping() : pickup()
      await addCartRepositoryItem(source, 2)
      await addCartRepositoryItem(target, 1)
      const before = getCartRepositorySnapshot()
      const sourceLine = before.items[0]!
      const targetLine = before.items[1]!
      const groups = groupCartPurchases(before.items)
      const sourceGroup = groups.find((group) =>
        group.items.some((item) => item.cartLineId === sourceLine.cartLineId)
      )!
      const targetGroup = groups.find((group) =>
        group.items.some((item) => item.cartLineId === targetLine.cartLineId)
      )!
      const sourceClaim = await captureCartPurchase(
        sourceGroup.id,
        sourceGroup.items
      )
      const targetClaim = await captureCartPurchase(
        targetGroup.id,
        targetGroup.items
      )

      const result = await changeCartRepositoryFulfillment(
        sourceLine,
        target,
        before.revision
      )
      expect(result.changed).toBe(true)
      expect(result.after).toHaveLength(1)
      expect(result.after[0]?.quantity).toBe(3)
      expect(result.after[0]?.cartLineId).toBe(targetLine.cartLineId)
      expect((await consumeCartPurchase(sourceClaim)).changed).toBe(false)
      expect((await consumeCartPurchase(targetClaim)).changed).toBe(true)
      expect(getCartRepositorySnapshot().items[0]?.quantity).toBe(2)
    })
  }
  it("rejects a switch whose destination has newer product evidence", async () => {
    await addCartRepositoryItem(pickup())
    await addCartRepositoryItem({ ...shipping(), productUpdatedAt: 101_000 })
    const before = getCartRepositorySnapshot()
    expect(
      (
        await changeCartRepositoryFulfillment(
          before.items[0]!,
          shipping(),
          before.revision
        )
      ).changed
    ).toBe(false)
    expect(getCartRepositorySnapshot().items).toEqual(before.items)
  })
  it("does not offer shipping for missing or unsupported product references", () => {
    const product = {
      format: "physical",
      shippingOptionId: undefined,
    } as Parameters<typeof hasEventShippingChoice>[0]
    expect(hasEventShippingChoice(product)).toBe(false)
    expect(
      hasEventShippingChoice({
        ...product,
        shippingOptionId: `30406:${merchant}:shipping`,
      })
    ).toBe(true)
    expect(
      hasEventShippingChoice({
        ...product,
        shippingOptionId: `30406:${merchant}:shipping`,
        shippingOptionLaunchUnsupported: true,
      })
    ).toBe(false)
  })
})

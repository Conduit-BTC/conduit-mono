import { describe, expect, it, spyOn } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildEventMarketAuthorizationDraft,
  buildEventMarketRosterDraft,
  buildProductListingEventDraft,
  createEventGuestReceipt,
  eventGuestReceiptSchema,
  getEventGuestReceiptCommitment,
  hasSignedEventGuestOptIn,
  isContactFreeEventHandoff,
  orderSchema,
  parseOrderMessageRumorEvent,
  parseProductEvent,
  verifyEventGuestReceipt,
} from "@conduit/core"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"
import {
  createCartItemFromProduct,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
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
        ["price", "1000", "SAT"],
        ["type", "simple", "physical"],
        ["a", marketCoordinate],
        ["conduit_event_guest", "contact_optional"],
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
    price: 1000,
    currency: "SAT",
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

function guestOrder() {
  const fixture = item("soap")
  if (fixture.fulfillment?.type !== "event_market_pickup")
    throw new Error("Missing pickup")
  const cart = {
    ...createCartItemFromProduct(
      parseProductEvent(fixture.fulfillment.product.signedEvent),
      fixture.fulfillment
    ),
    quantity: 1,
  }
  const receipt = createEventGuestReceipt(merchant)
  const pricing = buildCheckoutPricingIntent([cart], null)
  if (
    pricing.status !== "ok" ||
    cart.fulfillment?.type !== "event_market_pickup"
  )
    throw new Error("Bad signed fixture")
  const order = {
    id: receipt.orderId,
    merchantPubkey: merchant,
    buyerPubkey: "e".repeat(64),
    buyerIdentityKind: "guest_ephemeral" as const,
    items: pricing.items,
    subtotal: pricing.totalSats,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required" as const,
    createdAt: cart.fulfillment.calendar.start + 1000,
    contactFreePickup: {
      label: "Soap fan",
      receiptCommitment: getEventGuestReceiptCommitment(receipt),
    },
  }
  return { order, receipt, cart }
}

describe("merchant opt-in contact-free immediate handoff", () => {
  it("uses a single exact signed opt-in; ambiguous and unknown policy require contact", () => {
    expect(hasSignedEventGuestOptIn([])).toBe(false)
    expect(
      hasSignedEventGuestOptIn([["conduit_event_guest", "contact_optional"]])
    ).toBe(true)
    expect(
      hasSignedEventGuestOptIn([
        ["conduit_event_guest", "contact_optional"],
        ["conduit_event_guest", "contact_required"],
      ])
    ).toBe(false)
    expect(hasSignedEventGuestOptIn([["conduit_event_guest", "unknown"]])).toBe(
      false
    )
    const product = parseProductEvent(
      finalizeEvent(
        {
          kind: 30402,
          created_at: 100,
          tags: [
            ["d", "policy"],
            ["title", "Policy"],
            ["price", "1", "SAT"],
            ["type", "simple", "physical"],
          ],
          content: JSON.stringify({ eventGuestContactOptional: true }),
        },
        merchantSecret
      )
    )
    expect(product.eventGuestContactOptional).toBe(false)
    const draft = buildProductListingEventDraft({
      product: { ...product, eventGuestContactOptional: true },
      dTag: "policy",
    })
    expect(draft.tags).toContainEqual([
      "conduit_event_guest",
      "contact_optional",
    ])
    expect(
      parseProductEvent(
        finalizeEvent({ ...draft, created_at: 101 }, merchantSecret)
      ).eventGuestContactOptional
    ).toBe(true)
  })
  it("creates a valid contact-free private order without email, phone or receipt secret", () => {
    const { order, receipt } = guestOrder()
    const parsed = orderSchema.parse(order)
    expect(parsed.guestContact).toBeUndefined()
    expect(JSON.stringify(parsed)).not.toContain(receipt.claimSecret)
    const message = parseOrderMessageRumorEvent({
      id: "a".repeat(64),
      pubkey: parsed.buyerPubkey,
      created_at: Math.floor(parsed.createdAt / 1000),
      tags: [
        ["p", merchant],
        ["type", "order"],
        ["order", parsed.id],
      ],
      content: JSON.stringify(parsed),
    })
    if (message.type !== "order") throw new Error("Wrong message")
    expect(message.payload.contactFreePickup).toEqual(parsed.contactFreePickup)
    expect(verifyEventGuestReceipt(receipt, message.payload, merchant)).toBe(
      true
    )
  })
  it("recovers contact-free orders after the event without trusting sender time as observation time", () => {
    const { order, receipt } = guestOrder()
    const fulfillment = order.items[0]!.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing pickup")
    const now = spyOn(Date, "now").mockReturnValue(
      fulfillment.calendar.end + 86_400_000
    )
    try {
      expect(isContactFreeEventHandoff(order.items, Date.now())).toBe(false)
      const message = parseOrderMessageRumorEvent({
        id: "a".repeat(64),
        pubkey: order.buyerPubkey,
        created_at: Math.floor(order.createdAt / 1000),
        tags: [
          ["p", merchant],
          ["type", "order"],
          ["order", order.id],
        ],
        content: JSON.stringify(order),
      })
      if (message.type !== "order") throw new Error("Wrong message")
      expect(message.payload.createdAt).toBe(order.createdAt)
      expect(message.payload.guestContact).toBeUndefined()
      expect(verifyEventGuestReceipt(receipt, message.payload, merchant)).toBe(
        true
      )
      // Parsing preserves historical terms; the sender can also claim this
      // timestamp, so successful decoding cannot prove timely observation.
      expect(message.createdAt).toBeLessThan(Date.now())
    } finally {
      now.mockRestore()
    }
  })
  it("rejects absent opt-in, an expired/future occurrence and organizer handoff", () => {
    const { order, cart } = guestOrder()
    if (cart.fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing pickup")
    expect(
      isContactFreeEventHandoff([cart], cart.fulfillment.calendar.start - 1)
    ).toBe(false)
    expect(
      isContactFreeEventHandoff([cart], cart.fulfillment.calendar.end)
    ).toBe(false)
    expect(
      isContactFreeEventHandoff(
        [
          {
            ...cart,
            fulfillment: { ...cart.fulfillment, mode: "organizer_handoff" },
          },
        ],
        order.createdAt
      )
    ).toBe(false)
    const product = cart.fulfillment.product.signedEvent
    const noPolicy = finalizeEvent(
      {
        ...product,
        tags: product.tags.filter((tag) => tag[0] !== "conduit_event_guest"),
      },
      merchantSecret
    )
    const fulfillment = {
      ...cart.fulfillment,
      product: {
        ...cart.fulfillment.product,
        signedEvent: noPolicy,
        eventId: noPolicy.id,
      },
    }
    expect(
      orderSchema.safeParse({
        ...order,
        items: [{ ...order.items[0]!, fulfillment }],
      }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        ...order,
        createdAt: cart.fulfillment.calendar.end,
      }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({ ...order, buyerIdentityKind: "signed_in" })
        .success
    ).toBe(false)
    expect(
      orderSchema.safeParse({ ...order, contactFreePickup: undefined }).success
    ).toBe(false)
    expect(
      orderSchema.safeParse({
        ...order,
        contactFreePickup: { ...order.contactFreePickup, label: "  " },
      }).success
    ).toBe(false)
  })
  it("retains one contact for ordinary guest pickup and both for shipping", () => {
    const { order } = guestOrder()
    expect(
      orderSchema.safeParse({
        ...order,
        contactFreePickup: undefined,
        guestContact: { email: "guest@example.com" },
      }).success
    ).toBe(true)
    expect(
      orderSchema.safeParse({
        ...order,
        contactFreePickup: undefined,
        guestContact: { phone: "+14155552671" },
      }).success
    ).toBe(true)
    const shipment = {
      ...order,
      contactFreePickup: undefined,
      items: [
        { ...order.items[0]!, fulfillment: { type: "shipping" as const } },
      ],
      guestContact: { email: "guest@example.com" },
    }
    expect(orderSchema.safeParse(shipment).success).toBe(false)
    expect(
      orderSchema.safeParse({
        ...shipment,
        guestContact: { ...shipment.guestContact, phone: "+14155552671" },
      }).success
    ).toBe(true)
    expect(
      orderSchema.safeParse({
        ...shipment,
        contactFreePickup: order.contactFreePickup,
        guestContact: undefined,
      }).success
    ).toBe(false)
  })
  it("binds each receipt to one order and merchant; invented or damaged receipts fail", () => {
    const { order, receipt } = guestOrder()
    const parsed = orderSchema.parse(order)
    expect(receipt.claimSecret).toHaveLength(64)
    expect(verifyEventGuestReceipt(receipt, parsed, merchant)).toBe(true)
    expect(
      verifyEventGuestReceipt(
        receipt,
        { ...parsed, id: crypto.randomUUID() },
        merchant
      )
    ).toBe(false)
    expect(verifyEventGuestReceipt(receipt, parsed, organizer)).toBe(false)
    expect(
      verifyEventGuestReceipt(
        { ...receipt, claimSecret: "0".repeat(64) },
        parsed,
        merchant
      )
    ).toBe(false)
    expect(
      verifyEventGuestReceipt({ ...receipt, version: 2 }, parsed, merchant)
    ).toBe(false)
    expect(
      eventGuestReceiptSchema.safeParse({ ...receipt, unknown: "data" }).success
    ).toBe(false)
    expect(
      verifyEventGuestReceipt(
        createEventGuestReceipt(merchant),
        parsed,
        merchant
      )
    ).toBe(false)
  })
})

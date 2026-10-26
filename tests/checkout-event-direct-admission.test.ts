import { expect, test } from "bun:test"
import type { EventMarketOrganizerFeeAuthoring } from "@conduit/core"
import { assertCheckoutEventDirectCheckoutAllowed } from "../apps/market/src/lib/checkout-event-fee-preview"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

test("fresh positive organizer fees cannot enter direct order or payment", () => {
  const event = createEventMarketOrderFixture({
    organizerFee: {
      state: "active",
      basisPoints: 250,
      minimumSats: 0,
      lightningAddress: "organizer@example.test",
    },
  })
  expect(() =>
    assertCheckoutEventDirectCheckoutAllowed(
      [{ merchantPubkey: event.merchant, fulfillment: event.fulfillment }],
      100,
      150_000
    )
  ).toThrow("This event requires coordinated payment.")
})

test("free merchandise with a positive organizer minimum still requires payment", () => {
  const event = createEventMarketOrderFixture({
    price: 0,
    organizerFee: {
      state: "active",
      basisPoints: 0,
      minimumSats: 5,
      lightningAddress: "organizer@example.test",
    },
  })
  expect(() =>
    assertCheckoutEventDirectCheckoutAllowed(
      [{ merchantPubkey: event.merchant, fulfillment: event.fulfillment }],
      0,
      150_000
    )
  ).toThrow("This event requires coordinated payment.")
})

test("unusable current fee evidence cannot authorize direct checkout", () => {
  const event = createEventMarketOrderFixture({
    organizerFee: {
      state: "active",
      basisPoints: 250,
      minimumSats: 0,
      lightningAddress: "organizer@example.test",
      expiresAt: 200,
    },
  })
  const items = [
    { merchantPubkey: event.merchant, fulfillment: event.fulfillment },
  ]
  expect(() =>
    assertCheckoutEventDirectCheckoutAllowed(items, 100, 200_000)
  ).toThrow("The signed event fee terms are unavailable.")
  expect(() =>
    assertCheckoutEventDirectCheckoutAllowed(items, 100, 99_000)
  ).toThrow("The signed event fee terms are unavailable.")
  const changed = structuredClone(items)
  changed[0]!.fulfillment.market.signedEvent.content = "Changed signed terms"
  expect(() =>
    assertCheckoutEventDirectCheckoutAllowed(changed, 100, 150_000)
  ).toThrow("The signed event fee terms are unavailable.")
})

test("ordinary and positively zero-fee event purchases retain direct checkout", () => {
  const policies: (EventMarketOrganizerFeeAuthoring | undefined)[] = [
    undefined,
    { state: "disabled" },
    { state: "revoked" },
    {
      state: "active",
      basisPoints: 0,
      minimumSats: 0,
      lightningAddress: "organizer@example.test",
    },
  ]
  for (const organizerFee of policies) {
    const event = createEventMarketOrderFixture({ organizerFee })
    expect(() =>
      assertCheckoutEventDirectCheckoutAllowed(
        [{ merchantPubkey: event.merchant, fulfillment: event.fulfillment }],
        100,
        150_000
      )
    ).not.toThrow()
    expect(() =>
      assertCheckoutEventDirectCheckoutAllowed(
        [{ merchantPubkey: event.merchant }],
        100,
        150_000
      )
    ).not.toThrow()
  }
})

test("a percentage with no minimum permits genuinely free merchandise", () => {
  const event = createEventMarketOrderFixture({
    price: 0,
    organizerFee: {
      state: "active",
      basisPoints: 250,
      minimumSats: 0,
      lightningAddress: "organizer@example.test",
    },
  })
  expect(() =>
    assertCheckoutEventDirectCheckoutAllowed(
      [{ merchantPubkey: event.merchant, fulfillment: event.fulfillment }],
      0,
      150_000
    )
  ).not.toThrow()
})

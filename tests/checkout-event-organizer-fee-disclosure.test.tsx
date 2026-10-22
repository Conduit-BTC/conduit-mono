import { expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { formatNpub } from "@conduit/core"
import { CheckoutEventOrganizerFeeDisclosure } from "../apps/market/src/components/CheckoutEventOrganizerFeeDisclosure"
import { getCheckoutEventFeePreview } from "../apps/market/src/lib/checkout-event-fee-preview"
import { getCartPickupHandoffSummary } from "../apps/market/src/lib/pickup-handoff"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT,
} from "./support/checkout-spark-event-market-fixture"

function feeFixture(minimumSats = 50) {
  const fixture = checkoutSparkEventMarketFixture({
    mode: "merchant_present",
    organizerFee: {
      state: "active",
      basisPoints: 250,
      minimumSats,
      lightningAddress: "organizer@example.test",
    },
  })
  const order = createCheckoutSparkEventMarketFixtureOrder(
    fixture,
    getPublicKey(generateSecretKey())
  )
  const items = order.items.map((item) => ({
    merchantPubkey: order.merchantPubkey,
    fulfillment: item.fulfillment,
  }))
  const fee = getCheckoutEventFeePreview(
    items,
    order.subtotal,
    EVENT_MARKET_FIXTURE_AT
  )
  if (fee.status !== "ready" || fee.terms.state !== "active") {
    throw new Error("Expected signed active organizer fee fixture")
  }
  return { fixture, items, terms: fee.terms }
}

it("discloses the signed fee recipient even when the Merchant handles pickup", () => {
  const { fixture, items, terms } = feeFixture()
  expect(getCartPickupHandoffSummary(items)?.handlerPubkey).toBe(
    fixture.merchantPubkey
  )
  expect(terms.organizerPubkey).not.toBe(fixture.merchantPubkey)
  const html = renderToStaticMarkup(
    <CheckoutEventOrganizerFeeDisclosure
      terms={terms}
      organizerIdentity={{ displayName: "Event host" }}
    />
  )
  expect(html).toContain("Event organizer fee paid to")
  expect(html).toContain("Event host")
  expect(html).toContain("2.5% of items and shipping, minimum")
  expect(html).toContain("50 sats")
  expect(html).not.toContain(terms.lightningAddress)
})

it("uses the exact signed organizer public-key fallback while its profile is unavailable", () => {
  const { fixture, terms } = feeFixture()
  const html = renderToStaticMarkup(
    <CheckoutEventOrganizerFeeDisclosure
      terms={terms}
      organizerIdentity={null}
    />
  )
  expect(html).toContain(formatNpub(fixture.organizerPubkey, 8))
  expect(html).not.toContain(formatNpub(fixture.merchantPubkey, 8))
})

it("shows percentage-only terms without a meaningless zero minimum", () => {
  const { terms } = feeFixture(0)
  const html = renderToStaticMarkup(
    <CheckoutEventOrganizerFeeDisclosure
      terms={terms}
      organizerIdentity={{ displayName: "Event host" }}
    />
  )
  expect(html).toContain("Event host")
  expect(html).toContain("2.5% of items and shipping.")
  expect(html).not.toContain("minimum")
  expect(html).not.toContain(terms.lightningAddress)
})

it("wires organizer presentation from active signed fee terms, not the pickup actor", async () => {
  const source = await Bun.file("apps/market/src/routes/checkout.tsx").text()
  const summary = source.slice(
    source.indexOf("function OrderSummary("),
    source.indexOf("function CheckoutPage(")
  )
  expect(summary).toContain(
    "const organizerFeeIdentity = useEventActorIdentity("
  )
  expect(summary).toContain("? eventFeePreview.terms.organizerPubkey")
  expect(summary).toContain("organizerIdentity={organizerFeeIdentity}")
  expect(summary).not.toContain("organizerIdentity={pickupHandlerIdentity}")
  expect(source).toContain("Keep your private pickup receipt and code.")
  expect(source).not.toContain(
    "When your order is ready, the merchant privately shares"
  )
})

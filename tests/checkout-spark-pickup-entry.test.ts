import { expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  CheckoutSparkSettledPayoutPreflightError,
  isCheckoutSparkSettledCart,
  prepareCheckoutSparkSettledOrder,
  type PrepareCheckoutSparkSettledOrderInput,
} from "../apps/market/src/lib/checkout-spark-settled-entry"
import { createCheckoutSparkPickupQuoteFixture } from "./support/checkout-spark-pickup-quote-fixture"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"

const BUYER = NDKPrivateKeySigner.generate()

it("offers the local router for verified merchant pickup, but not organizer or pending pickup", async () => {
  const f = await createCheckoutSparkPickupQuoteFixture()
  expect(isCheckoutSparkSettledCart([f.item])).toBe(true)
  const organizer = await createCheckoutSparkPickupQuoteFixture({
    handoffMode: "organizer_handoff",
  })
  expect(isCheckoutSparkSettledCart([organizer.item])).toBe(false)
  expect(
    isCheckoutSparkSettledCart([
      {
        ...f.item,
        fulfillment: {
          type: "event_pickup_pending",
          collectionCoordinate: f.line.pickup!.collection.coordinate,
        },
      },
    ])
  ).toBe(false)
})

function request(
  f: Awaited<ReturnType<typeof createCheckoutSparkPickupQuoteFixture>>
): PrepareCheckoutSparkSettledOrderInput {
  return {
    checkoutId: "pickup-checkout",
    orderId: "pickup-order",
    quoteAuthority: f.quote,
    buyer: { kind: "signed_in", pubkey: BUYER.pubkey, signer: BUYER },
    network: "mainnet",
    nowMs: f.acceptedAtMs,
    shouldContinue: () => true,
  }
}

it("carries current merchant pickup to recipient preflight without a postal address", async () => {
  const f = await createCheckoutSparkPickupQuoteFixture()
  let reads = 0
  await expect(
    prepareCheckoutSparkSettledOrder(request(f), {
      now: () => f.acceptedAtMs,
      readRecipientPayout: async () => {
        reads++
        return { state: "unavailable", reason: "profile_unavailable" }
      },
    })
  ).rejects.toBeInstanceOf(CheckoutSparkSettledPayoutPreflightError)
  expect(reads).toBe(1)
})

it.each([
  "missing_graph",
  "missing_calendar",
  "changed_handler",
  "changed_location",
  "changed_cost",
  "postal_address",
  "postal_country",
  "changed_status",
  "expired_event",
])(
  "rejects unusable pickup terms before recipient or wallet work: %s",
  async (change) => {
    const f = await createCheckoutSparkPickupQuoteFixture()
    const input = request(f)
    input.quoteAuthority = structuredClone(input.quoteAuthority)
    const priced = input.quoteAuthority.pricing.items[0]!
    if (change === "missing_graph")
      input.quoteAuthority.pickupSourceEvents = undefined
    if (change === "missing_calendar")
      input.quoteAuthority.pickupSourceEvents = [f.collection, f.pickup]
    if (change === "changed_handler" && priced.fulfillment?.type === "pickup")
      priced.fulfillment.handlerPubkey = f.organizerPubkey
    if (change === "changed_location" && priced.fulfillment?.type === "pickup")
      priced.fulfillment.option.location = "Different booth"
    if (change === "changed_cost") priced.shippingCostSats = 11
    if (change === "postal_country") priced.shippingCountries = ["US"]
    if (change === "changed_status")
      input.quoteAuthority.pricing.shippingCost.status = "not_required"
    if (change === "expired_event") input.nowMs += 86_400_000
    if (change === "postal_address")
      input.shippingAddress = {
        name: "Test Buyer",
        street: "123 Main Street",
        city: "New York",
        state: "NY",
        postalCode: "10001",
        country: "US",
      }
    let reads = 0
    await expect(
      prepareCheckoutSparkSettledOrder(input, {
        now: () => input.nowMs,
        readRecipientPayout: async () => {
          reads++
          return { state: "unavailable", reason: "profile_unavailable" }
        },
      })
    ).rejects.toThrow()
    expect(reads).toBe(0)
  }
)

it("keeps organizer handoff outside new preparation until its extra recovery path is integrated", async () => {
  const f = await createCheckoutSparkPickupQuoteFixture({
    handoffMode: "organizer_handoff",
  })
  let reads = 0
  await expect(
    prepareCheckoutSparkSettledOrder(request(f), {
      now: () => f.acceptedAtMs,
      readRecipientPayout: async () => {
        reads++
        return { state: "unavailable", reason: "profile_unavailable" }
      },
    })
  ).rejects.toThrow("verified merchant pickup terms")
  expect(reads).toBe(0)
})

it.each(["email_only", "phone_only", "blank_email", "blank_phone"] as const)(
  "requires both contacts for a new guest pickup before recipient or wallet work: %s",
  async (contact) => {
    const f = await createCheckoutSparkPickupQuoteFixture()
    const input = request(f)
    input.buyer = createSessionGuestOrderSigningIdentity(
      input.orderId,
      f.merchantPubkey,
      { storage: null, nowMs: f.acceptedAtMs }
    )
    input.guestContact =
      contact === "email_only"
        ? { email: "guest@example.test" }
        : contact === "phone_only"
          ? { phone: "+12025550123" }
          : contact === "blank_email"
            ? { email: "  ", phone: "+12025550123" }
            : { email: "guest@example.test", phone: "  " }
    const calls = { recipients: 0, funding: 0, publishing: 0 }
    await expect(
      prepareCheckoutSparkSettledOrder(input, {
        now: () => f.acceptedAtMs,
        readRecipientPayout: async () => {
          calls.recipients++
          return { state: "unavailable", reason: "profile_unavailable" }
        },
        prepareFunding: async () => {
          calls.funding++
          throw new Error("Unexpected wallet preparation")
        },
        publishOrder: async () => {
          calls.publishing++
          throw new Error("Unexpected order publication")
        },
      })
    ).rejects.toThrow("Guest orders require both email and phone.")
    expect(calls).toEqual({ recipients: 0, funding: 0, publishing: 0 })
  }
)

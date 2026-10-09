import { expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  isCheckoutSparkSettledCart,
  prepareCheckoutSparkSettledOrder,
  type PrepareCheckoutSparkSettledOrderInput,
} from "../apps/market/src/lib/checkout-spark-settled-entry"
import { createCheckoutSparkPickupQuoteFixture } from "./support/checkout-spark-pickup-quote-fixture"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import { parsePersistedCart } from "../apps/market/src/lib/cart-model"
import {
  orderItemFulfillmentSchema,
  type OrderPickupFulfillmentSchema,
} from "@conduit/core"
import { createEventMarketOrderFixture } from "./helpers/event-market-order-fixture"

const BUYER = NDKPrivateKeySigner.generate()

it("keeps historical pickup and current Event Market pickup outside new router admission", async () => {
  const f = await createCheckoutSparkPickupQuoteFixture()
  expect(isCheckoutSparkSettledCart([f.item])).toBe(false)
  const organizer = await createCheckoutSparkPickupQuoteFixture({
    handoffMode: "organizer_handoff",
  })
  expect(isCheckoutSparkSettledCart([organizer.item])).toBe(false)
  const current = createEventMarketOrderFixture({ mode: "merchant_present" })
  expect(
    isCheckoutSparkSettledCart([
      {
        ...f.item,
        merchantPubkey: current.fulfillment.merchantPubkey,
        fulfillment: current.fulfillment,
      },
    ])
  ).toBe(false)
})

it("rejects retired pickup snapshots in unpaid carts without deleting historical order parsing", async () => {
  const f = await createCheckoutSparkPickupQuoteFixture()
  expect(orderItemFulfillmentSchema.safeParse(f.item.fulfillment).success).toBe(
    true
  )
  expect(
    parsePersistedCart({ version: 2, items: [f.item] }).state.items
  ).toEqual([])
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

it("rejects even exact historical merchant pickup before recipient or wallet work", async () => {
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
  ).rejects.toThrow("Historical pickup checkout terms")
  expect(reads).toBe(0)
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
    const historical =
      priced.fulfillment as unknown as OrderPickupFulfillmentSchema
    if (change === "missing_graph")
      input.quoteAuthority.pickupSourceEvents = undefined
    if (change === "missing_calendar")
      input.quoteAuthority.pickupSourceEvents = [f.collection, f.pickup]
    if (change === "changed_handler")
      historical.handlerPubkey = f.organizerPubkey
    if (change === "changed_location")
      historical.option.location = "Different booth"
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

it("does not reinterpret historical organizer handoff as current Event Market admission", async () => {
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
  ).rejects.toThrow("Historical pickup checkout terms")
  expect(reads).toBe(0)
})

it.each(["email_only", "phone_only", "blank_email", "blank_phone"] as const)(
  "does not revive the historical pickup funding lane with guest contacts: %s",
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
    ).rejects.toThrow("Historical pickup checkout terms")
    expect(calls).toEqual({ recipients: 0, funding: 0, publishing: 0 })
  }
)

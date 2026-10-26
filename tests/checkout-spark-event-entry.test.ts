import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  createCheckoutSparkSettledReconciliation,
  getNdk,
  isContactFreeEventHandoff,
  orderSchema,
  parseProductEvent,
  type OrderSchema,
} from "@conduit/core"
import { prepareCheckoutSparkSettledOrder } from "../apps/market/src/lib/checkout-spark-settled-entry"
import { buildCheckoutSparkQuoteAuthority } from "../apps/market/src/lib/checkout-spark-quote-authority"
import { createCartItemFromProduct } from "../apps/market/src/lib/cart-model"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import { publishCheckoutSparkSettledBoundOrder } from "../apps/market/src/lib/checkout-spark-bound-order"
import {
  saveCheckoutSparkSettledPreparation,
  type PreparedCheckoutSparkSettledFunding,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import type { BuyerMessageDeliveryResult } from "../apps/market/src/lib/order-publish"
import { admitFixture } from "./helpers/public-event"
import { plainTestSigner } from "./helpers/plain-signer"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

async function quote(
  fixture: ReturnType<typeof checkoutSparkEventMarketFixture>,
  buyerPubkey: string
) {
  const order = createCheckoutSparkEventMarketFixtureOrder(
    fixture,
    buyerPubkey,
    AT
  )
  const product = {
    ...parseProductEvent(await admitFixture(fixture.events.product)),
    sourceEventId: fixture.events.product.id,
  }
  const item = {
    ...createCartItemFromProduct(product, order.items[0]!.fulfillment),
    quantity: 1,
  }
  return buildCheckoutSparkQuoteAuthority({
    authorization: {
      status: "ok",
      items: [item],
      listingReadProducts: [product],
      fulfillmentResolvedProducts: [product],
      shippingOptionEvidence: { status: "not_required", options: [] },
      pickupSourceEvents: fixture.sourceEvents,
    },
    rateInput: null,
    nowMs: AT,
  })
}

describe("event router entry and private order boundary", () => {
  it.each([100_000, 0])(
    "prepares additive organizer terms for %s-sat goods without a second profile lookup",
    async (commerceTotalSats) => {
      const f = checkoutSparkEventMarketFixture({
        commerceTotalSats,
        supplier: false,
      })
      const signer = plainTestSigner(NDKPrivateKeySigner.generate())
      const authority = await quote(f, signer.pubkey)
      let profiles = 0
      let prepared = 0
      let published = 0
      await prepareCheckoutSparkSettledOrder(
        {
          checkoutId: f.plan.checkoutId,
          orderId: f.plan.orderId,
          buyer: { kind: "signed_in", pubkey: signer.pubkey, signer },
          network: "mainnet",
          nowMs: AT,
          shouldContinue: () => true,
          quoteAuthority: authority,
        },
        {
          now: () => AT,
          ndk: getNdk(),
          readRecipientPayout: async () => {
            profiles++
            const event = f.events.merchantProfile
            return {
              state: "ready",
              recipientPubkey: f.merchantPubkey,
              lud16: "merchant@example.test",
              profileEventId: event.id,
              profileEventCreatedAt: event.created_at,
              signedEvent: event,
            }
          },
          prepareFunding: async (terms) => {
            prepared++
            expect(terms.grossFundingSats).toBe(f.plan.funding.grossFundingSats)
            expect(terms.eventMarket).toEqual(authority.eventMarket)
            expect(terms.recipients.map((recipient) => recipient.kind)).toEqual(
              commerceTotalSats === 0
                ? ["organizer", "conduit"]
                : ["merchant", "organizer", "conduit"]
            )
            expect(
              terms.recipients.find(
                (recipient) => recipient.kind === "organizer"
              )
            ).toMatchObject({
              weightSats: f.eventMarket.organizerFeeSats,
              destination: {
                source: {
                  type: "signed_event_market",
                  eventId: f.events.market.id,
                },
              },
            })
            return {
              plan: { createdAt: AT },
            } as PreparedCheckoutSparkSettledFunding
          },
          publishOrder: async (publish) => {
            published++
            expect(publish.order.subtotal).toBe(commerceTotalSats)
            expect(publish.order.createdAt).toBe(AT)
            expect(publish.order.items[0]!.fulfillment?.type).toBe(
              "event_market_pickup"
            )
            return {
              orderId: f.plan.orderId,
              delivery: {} as BuyerMessageDeliveryResult,
            }
          },
        }
      )
      expect(profiles).toBe(commerceTotalSats === 0 ? 0 : 1)
      expect(prepared).toBe(1)
      expect(published).toBe(1)
    }
  )

  it.each(["merchant_present", "organizer_handoff"] as const)(
    "publishes exact %s contact-free event orders under the existing guest boundary",
    async (mode) => {
      const f = checkoutSparkEventMarketFixture({ mode, supplier: false })
      const storage = new MemoryStorage()
      const identity = createSessionGuestOrderSigningIdentity(
        f.plan.orderId,
        f.merchantPubkey,
        { nowMs: AT, storage: null }
      )
      const draft = createCheckoutSparkEventMarketFixtureOrder(
        f,
        identity.pubkey,
        AT
      )
      const order = orderSchema.parse({
        ...draft,
        buyerIdentityKind: "guest_ephemeral",
        shippingCostStatus: "included",
        contactFreePickup: {
          label: "Test pickup receipt",
          receiptCommitment: randomBytes(32).toString("hex"),
        },
      })
      expect(isContactFreeEventHandoff(order.items, AT)).toBe(true)
      saveCheckoutSparkSettledPreparation(
        {
          schemaVersion: 3,
          checkoutId: f.plan.checkoutId,
          planDigest: f.plan.planDigest,
          recoveryHandoffId: randomBytes(32).toString("hex"),
          fundingInvoiceExposedAt: AT,
          fundingSubmissionState: "not_started",
          savedAt: AT,
        },
        storage
      )
      let published = 0
      const result = await publishCheckoutSparkSettledBoundOrder(
        {
          checkoutId: f.plan.checkoutId,
          order,
          buyer: identity,
          authenticatedPubkey: null,
          ndk: getNdk(),
          shouldContinue: () => true,
          sourceEvents: f.sourceEvents,
          addressValidity: "not_required",
          shippingZoneEligibility: "not_required",
          storage,
        },
        {
          now: () => AT + 1,
          loadSettledFunding: async () =>
            ({
              plan: f.plan,
              state: createCheckoutSparkSettledReconciliation(f.plan),
            }) as PreparedCheckoutSparkSettledFunding,
          publishOrder: async (rumor, _recipient, _identity, options) => {
            published++
            expect(options?.shouldContinue?.()).toBe(true)
            expect(JSON.parse(rumor.content)).toEqual(order)
            expect(JSON.parse(rumor.content)).not.toHaveProperty("guestContact")
            return { localCacheError: null } as BuyerMessageDeliveryResult
          },
          bindBuyerOrder: async () => ({
            schemaVersion: 2,
            checkoutId: f.plan.checkoutId,
            planDigest: f.plan.planDigest,
            orderId: f.plan.orderId,
            merchantPubkey: f.merchantPubkey,
            buyerPubkey: identity.pubkey,
            walletId: f.plan.walletId,
            commerceTotalSats: f.plan.commerceQuote.commerceTotalSats,
          }),
        }
      )
      expect(published).toBe(1)
      expect(result.delivery.localCacheError).toBeNull()
      const changed: OrderSchema = { ...order, createdAt: AT + 1 }
      await expect(
        publishCheckoutSparkSettledBoundOrder(
          {
            checkoutId: f.plan.checkoutId,
            order: changed,
            buyer: identity,
            authenticatedPubkey: null,
            ndk: getNdk(),
            shouldContinue: () => true,
            sourceEvents: f.sourceEvents,
            addressValidity: "not_required",
            shippingZoneEligibility: "not_required",
            storage,
          },
          {
            now: () => AT + 2,
            loadSettledFunding: async () =>
              ({
                plan: f.plan,
                state: createCheckoutSparkSettledReconciliation(f.plan),
              }) as PreparedCheckoutSparkSettledFunding,
          }
        )
      ).rejects.toThrow("frozen plan")
    }
  )

  it("requires an active exact Merchant stock commitment for contact-free organizer handoff", () => {
    const f = checkoutSparkEventMarketFixture({ mode: "organizer_handoff" })
    const order = createCheckoutSparkEventMarketFixtureOrder(
      f,
      plainTestSigner(NDKPrivateKeySigner.generate()).pubkey,
      AT
    )
    const fulfillment = order.items[0]!.fulfillment
    if (fulfillment?.type !== "event_market_pickup")
      throw new Error("Missing event.")
    expect(isContactFreeEventHandoff(order.items, AT)).toBe(true)
    expect(
      isContactFreeEventHandoff(order.items, fulfillment.calendar.end)
    ).toBe(false)
    for (const changed of [
      undefined,
      {
        ...fulfillment.occurrenceAssignment!,
        signedEvent: { ...f.events.assignment, content: "tampered" },
      },
    ]) {
      expect(
        isContactFreeEventHandoff(
          [{ fulfillment: { ...fulfillment, occurrenceAssignment: changed } }],
          AT
        )
      ).toBe(false)
    }
    const closed = f.signMerchant({
      ...f.events.assignment,
      tags: f.events.assignment.tags.map((tag) =>
        tag[0] === "conduit_stock_pool"
          ? [tag[0]!, tag[1]!, "closed", ...tag.slice(3)]
          : tag
      ),
    })
    expect(
      isContactFreeEventHandoff(
        [
          {
            fulfillment: {
              ...fulfillment,
              occurrenceAssignment: {
                ...fulfillment.occurrenceAssignment!,
                signedEvent: closed,
                eventId: closed.id,
              },
            },
          },
        ],
        AT
      )
    ).toBe(false)
  })
})

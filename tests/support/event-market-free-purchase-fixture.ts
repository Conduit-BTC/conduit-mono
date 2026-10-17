import {
  createEventMarketFreePurchase,
  buildEventMarketFreePurchaseRumor,
  freezeCheckoutSparkEventMarketBinding,
  parseEventMarketOrganizerFeeTerms,
  openEventMarketFreePurchaseAuthority,
} from "@conduit/core"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import {
  createSessionGuestOrderSigningIdentity,
  createGuestEventMarketFreePurchaseSigner,
} from "../../apps/market/src/lib/guest-order-identity"
import { checkoutSparkOrganizerFixture } from "./checkout-spark-organizer-fixture"
import {
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./checkout-spark-event-market-fixture"

/** Real signed zero-cost graph and bounded guest seal; no wallet is opened. */
export async function eventMarketFreePurchaseFixture() {
  const f = await checkoutSparkOrganizerFixture({
    commerceTotalSats: 0,
    supplier: false,
  })
  const market = f.signOrganizer({
    ...f.events.market,
    tags: f.events.market.tags.filter((tag) => tag[0] !== "conduit_event_fee"),
  })
  const eventMarket = freezeCheckoutSparkEventMarketBinding(
    {
      ...f.eventMarket,
      marketEventId: market.id,
      organizerFee: parseEventMarketOrganizerFeeTerms({
        event: market,
        marketCoordinate: f.eventMarket.marketCoordinate,
      }),
      organizerFeeSats: 0,
    },
    {
      merchantPubkey: f.merchantPubkey,
      commerceQuote: f.plan.commerceQuote,
      acceptedAtMs: AT,
    }
  )
  const sourceEvents = f.sourceEvents.map((event) =>
    event.id === f.events.market.id ? market : event
  )
  const identity = createSessionGuestOrderSigningIdentity(
    f.plan.orderId,
    f.merchantPubkey,
    { storage: null, nowMs: AT }
  )
  const order = createCheckoutSparkEventMarketFixtureOrder(
    { ...f, sourceEvents },
    identity.pubkey,
    AT,
    eventMarket
  )
  const payload = createEventMarketFreePurchase({
    order,
    commerceQuote: f.plan.commerceQuote,
    eventMarket,
    sourceEvents,
  })
  const guestSigner = createGuestEventMarketFreePurchaseSigner(identity, {
    payload,
    now: () => f.clock.now,
  })
  const rumor = buildEventMarketFreePurchaseRumor(payload)
  const wrap = await wrapPrivateMessage(
    rumor,
    { pubkey: f.organizerPubkey },
    guestSigner,
    { rumorKind: 16 }
  )
  const authorityInput = {
    db: f.database,
    signer: f.organizerSigner,
    authenticatedPubkey: f.organizerPubkey,
    writerId: f.writerId,
    signedRecipientWrap: wrap,
    shouldContinue: () => f.clock.active,
    now: () => f.clock.now,
  }
  const freeAuthority =
    await openEventMarketFreePurchaseAuthority(authorityInput)
  return {
    ...f,
    payload,
    order,
    identity,
    guestSigner,
    rumor,
    wrap,
    freeAuthority,
    authorityInput,
  }
}

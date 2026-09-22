import { describe, expect, it } from "bun:test"
import type { ProductSchema } from "@conduit/core"
import type { MerchantOrganizerEventMarket } from "../apps/merchant/src/lib/event-market"
import {
  createEmptyEventProductForm,
  createFreshEventProductDTag,
  eventProductFormFromTemplate,
  getEventProductDeliveryPresentation,
  getMerchantEventPublishPresentation,
  validateEventProductPublishForm,
} from "../apps/merchant/src/lib/event-product-publishing"

const MERCHANT = "a".repeat(64)
const ORGANIZER = "b".repeat(64)

const MARKET = {
  organizerPubkey: ORGANIZER,
  collectionCoordinate: `30405:${ORGANIZER}:meetup`,
  naddr: "naddr1example",
  title: "Community meetup",
  eventLocation: "Main hall",
  pickupCountry: "US",
} as MerchantOrganizerEventMarket

const PRODUCT = {
  id: `30402:${MERCHANT}:coffee`,
  pubkey: MERCHANT,
  title: "Coffee beans",
  summary: "Fresh roast",
  price: 2_100,
  currency: "SATS",
  type: "simple",
  specifications: [],
  format: "physical",
  visibility: "public",
  stock: 4,
  images: [{ url: "https://cdn.pixabay.com/photo/coffee.jpg" }],
  tags: ["coffee", "local", "roasted"],
  publicZapEnabled: true,
  zapMessagePolicy: "generic_only",
  publicZapPolicyKnown: true,
  createdAt: 1,
  updatedAt: 1,
} as ProductSchema

describe("merchant event-led product publishing", () => {
  it("requires a common product-family relay ACK before event acceptance", () => {
    const baseDelivery = {
      plan: {
        intent: "author_event" as const,
        primaryRelayUrls: ["wss://relay.example"],
        broadcastRelayUrls: [],
        parkedRelayUrls: [],
      },
      attemptedRelayUrls: ["wss://relay.example"],
      relayFailureMessages: {},
    }

    expect(
      getEventProductDeliveryPresentation({
        ...baseDelivery,
        successfulRelayUrls: ["wss://relay.example"],
        failedRelayUrls: [],
        rejectedRelayUrls: [],
      })
    ).toEqual({
      acknowledged: true,
      retryable: false,
      message: null,
    })

    expect(
      getEventProductDeliveryPresentation({
        ...baseDelivery,
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://relay.example"],
        rejectedRelayUrls: [],
      })
    ).toEqual({
      acknowledged: false,
      retryable: true,
      message:
        "No relay acknowledged the complete product yet. The exact signed product is saved; retry delivery before requesting event acceptance.",
    })

    expect(
      getEventProductDeliveryPresentation({
        ...baseDelivery,
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://relay.example"],
        rejectedRelayUrls: ["wss://relay.example"],
      })
    ).toEqual({
      acknowledged: false,
      retryable: false,
      message:
        "Every target relay rejected the signed product. Event acceptance was not published; update the listing or relay setup and start again.",
    })

    expect(
      getEventProductDeliveryPresentation({
        ...baseDelivery,
        successfulRelayUrls: ["wss://relay.example"],
        failedRelayUrls: ["wss://second.example"],
        rejectedRelayUrls: ["wss://second.example"],
      })
    ).toMatchObject({ acknowledged: true, retryable: false })

    expect(
      getEventProductDeliveryPresentation({
        ...baseDelivery,
        attemptedRelayUrls: ["wss://relay.example", "wss://second.example"],
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://relay.example", "wss://second.example"],
        rejectedRelayUrls: ["wss://relay.example"],
      })
    ).toMatchObject({ acknowledged: false, retryable: true })
  })

  it("gates initial and retry acceptance on acknowledged product delivery", async () => {
    const source = await Bun.file(
      "apps/merchant/src/components/EventProductPublisherDialog.tsx"
    ).text()
    const initialGate = source.indexOf(
      "requireAcknowledgedProductDelivery(result.delivery)"
    )
    const initialAcceptance = source.indexOf(
      "return completeAcceptance(result.productCoordinate)",
      initialGate
    )
    const retryDelivery = source.indexOf(
      "const delivery = await retryEventProductDelivery("
    )
    const retryGate = source.indexOf(
      "requireAcknowledgedProductDelivery(delivery)",
      retryDelivery
    )
    const retryAcceptance = source.indexOf(
      "return completeAcceptance(`30402:${merchantPubkey}:${dTag}`)",
      retryGate
    )

    expect(initialGate).toBeGreaterThan(-1)
    expect(initialAcceptance).toBeGreaterThan(initialGate)
    expect(retryDelivery).toBeGreaterThan(-1)
    expect(retryGate).toBeGreaterThan(retryDelivery)
    expect(retryAcceptance).toBeGreaterThan(retryGate)
    expect(source).toContain("productDeliveryRetryable")
    expect(source).toContain("error instanceof SignedProductDeliveryError")
    expect(source).toContain("setProductDeliveryRetryable(error.retryable)")
    expect(source).toContain("Start over")
  })

  it("distinguishes closed and ended events from recoverable exact reads", () => {
    expect(
      getMerchantEventPublishPresentation({
        actionReady: true,
        orderAcceptance: "closed",
        refreshing: false,
        requiredRecordsResolved: true,
        state: "ended",
      })
    ).toEqual({
      message: "This event is closed. New products can't be published.",
      publishable: false,
      retryLabel: null,
      state: "closed",
    })

    expect(
      getMerchantEventPublishPresentation({
        actionReady: true,
        refreshing: false,
        requiredRecordsResolved: true,
        state: "ended",
      })
    ).toEqual({
      message: "This event has ended. New products can't be published.",
      publishable: false,
      retryLabel: null,
      state: "ended",
    })

    expect(
      getMerchantEventPublishPresentation({
        actionReady: false,
        refreshing: false,
        requiredRecordsResolved: false,
        state: "partial",
      })
    ).toEqual({
      message:
        "Current event details couldn't be confirmed. Retry before publishing a product.",
      publishable: false,
      retryLabel: "Retry event details",
      state: "recoverable",
    })

    expect(
      getMerchantEventPublishPresentation({
        actionReady: false,
        refreshing: true,
        requiredRecordsResolved: false,
        state: "partial",
      })
    ).toMatchObject({
      message: "Checking current event details before publishing.",
      publishable: false,
      retryLabel: "Checking event details...",
      state: "checking",
    })
  })

  it("publishes dedicated event products as hidden ordinary-market listings", async () => {
    const source = await Bun.file(
      "apps/merchant/src/lib/event-product-publishing.ts"
    ).text()
    const publish = source.slice(
      source.indexOf("export async function publishEventProduct("),
      source.indexOf("export async function retryEventProductDelivery(")
    )

    expect(publish).toContain('visibility: "private"')
    expect(publish).not.toContain('visibility: "public"')
  })

  it("starts blank at the event venue without mutating a source product", () => {
    expect(createEmptyEventProductForm(MARKET)).toMatchObject({
      templateCoordinate: "",
      currency: "SATS",
      handoffMode: "merchant_handoff",
      merchantPickupLocation: "Main hall",
      merchantPickupCountry: "US",
    })
  })

  it("copies product fields into a new event draft", () => {
    const sourceSnapshot = structuredClone(PRODUCT)
    const form = eventProductFormFromTemplate(
      { coordinate: PRODUCT.id, product: PRODUCT },
      MARKET
    )

    expect(form).toMatchObject({
      templateCoordinate: PRODUCT.id,
      title: "Coffee beans",
      summary: "Fresh roast",
      price: "2100",
      currency: "SATS",
      stock: "4",
      images: [{ url: "https://cdn.pixabay.com/photo/coffee.jpg" }],
      tags: "coffee, local, roasted",
    })
    expect(PRODUCT).toEqual(sourceSnapshot)
  })

  it("always gives a copied event product a fresh coordinate", () => {
    expect(
      createFreshEventProductDTag(
        "Coffee beans",
        `30402:${MERCHANT}:coffee-beans-fixed`,
        "fixed"
      )
    ).toBe("coffee-beans-fixed-event")
    expect(
      createFreshEventProductDTag("Coffee beans", PRODUCT.id, "fixed")
    ).toBe("coffee-beans-fixed")
  })

  it("preserves template image evidence but blocks malformed URLs", () => {
    const malformedProduct = {
      ...PRODUCT,
      images: [
        {
          url: "![coffee](https://cdn.pixabay.com/photo/coffee.jpg)",
        },
      ],
    } as ProductSchema
    const sourceSnapshot = structuredClone(malformedProduct)

    const form = eventProductFormFromTemplate(
      { coordinate: malformedProduct.id, product: malformedProduct },
      MARKET
    )

    expect(form.images).toEqual(malformedProduct.images)
    expect(validateEventProductPublishForm(form).product.errors.images).toBe(
      "Image URL must start with https://"
    )
    expect(malformedProduct).toEqual(sourceSnapshot)
  })

  it("requires complete product fields and a merchant pickup point", () => {
    const blank = createEmptyEventProductForm(MARKET)
    expect(validateEventProductPublishForm(blank).canPublish).toBe(false)

    const valid = {
      ...blank,
      title: "Event coffee",
      price: "2100",
      stock: "4",
      images: [
        {
          url: "https://cdn.pixabay.com/photo/event-coffee.jpg",
          alt: "Event coffee cover",
        },
        { url: "https://cdn.pixabay.com/photo/event-coffee-detail.jpg" },
      ],
      tags: "coffee, local, meetup",
    }
    expect(validateEventProductPublishForm(valid)).toMatchObject({
      canPublish: true,
      pickupError: null,
    })
    expect(
      validateEventProductPublishForm({
        ...valid,
        merchantPickupLocation: "",
      }).pickupError
    ).toContain("location or geohash")
  })
})

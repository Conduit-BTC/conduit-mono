import { describe, expect, it } from "bun:test"
import type { ProductSchema } from "@conduit/core"
import type { MerchantOrganizerEventMarket } from "../apps/merchant/src/lib/event-market"
import {
  createEmptyEventProductForm,
  eventProductFormFromTemplate,
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
      imageUrl: "https://cdn.pixabay.com/photo/coffee.jpg",
      tags: "coffee, local, roasted",
    })
    expect(PRODUCT.collectionRefs).toBeUndefined()
  })

  it("requires complete product fields and a merchant pickup point", () => {
    const blank = createEmptyEventProductForm(MARKET)
    expect(validateEventProductPublishForm(blank).canPublish).toBe(false)

    const valid = {
      ...blank,
      title: "Event coffee",
      price: "2100",
      stock: "4",
      imageUrl: "https://cdn.pixabay.com/photo/event-coffee.jpg",
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

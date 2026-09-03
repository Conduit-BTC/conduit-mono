import { describe, expect, it } from "bun:test"
import type { ProductSchema } from "@conduit/core"
import { getMerchantProductEventContext } from "../apps/merchant/src/lib/merchant-product-event-context"

const MERCHANT = "a".repeat(64)
const ORGANIZER = "b".repeat(64)
const COLLECTION = `30405:${ORGANIZER}:community-market`
const ORGANIZER_PICKUP = `30406:${ORGANIZER}:community-market-pickup`

function product(overrides: Partial<ProductSchema> = {}): ProductSchema {
  return {
    id: `30402:${MERCHANT}:coffee`,
    pubkey: MERCHANT,
    title: "Event coffee",
    price: 1_000,
    currency: "SATS",
    type: "simple",
    specifications: [],
    format: "physical",
    visibility: "private",
    stock: 4,
    images: [],
    tags: [],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1,
    updatedAt: 1,
    collectionRefs: [COLLECTION],
    shippingOptionId: COLLECTION,
    shippingOptionRefs: [{ coordinate: COLLECTION }],
    ...overrides,
  }
}

describe("merchant event-product management context", () => {
  it("recognizes a hidden collection-fulfillment event product", () => {
    const context = getMerchantProductEventContext(product())

    expect(context?.collectionCoordinate).toBe(COLLECTION)
    expect(context?.naddr).toStartWith("naddr1")
    expect(context?.referenceLabel).toContain("…")
  })

  it("recognizes a hidden direct event-pickup product", () => {
    expect(
      getMerchantProductEventContext(
        product({
          shippingOptionId: ORGANIZER_PICKUP,
          shippingOptionRefs: [{ coordinate: ORGANIZER_PICKUP }],
        })
      )?.collectionCoordinate
    ).toBe(COLLECTION)
  })

  it("does not reclassify an ordinary public listing", () => {
    expect(
      getMerchantProductEventContext(product({ visibility: "public" }))
    ).toBeNull()
  })

  it("does not reclassify a generic hidden listing", () => {
    expect(
      getMerchantProductEventContext(
        product({
          collectionRefs: [],
          shippingOptionId: undefined,
          shippingOptionRefs: [],
        })
      )
    ).toBeNull()
  })

  it("does not choose between ambiguous event references", () => {
    const secondCollection = `30405:${ORGANIZER}:second-market`
    expect(
      getMerchantProductEventContext(
        product({
          collectionRefs: [COLLECTION, secondCollection],
          shippingOptionRefs: [
            { coordinate: COLLECTION },
            { coordinate: secondCollection },
          ],
        })
      )
    ).toBeNull()
  })

  it("keeps event management distinct from generic hidden-listing recovery", async () => {
    const route = await Bun.file("apps/merchant/src/routes/products.tsx").text()
    const eventBranch = route.indexOf(
      "if (!item.safety.marketVisible && eventProductContext)"
    )
    const genericHiddenBranch = route.indexOf(
      "if (!item.safety.marketVisible)",
      eventBranch + 1
    )

    expect(eventBranch).toBeGreaterThan(-1)
    expect(genericHiddenBranch).toBeGreaterThan(eventBranch)
    expect(route).toContain("EventProductManagementSummary")
    expect(route).toMatch(/eventUrl\.searchParams\.set\(\s*"event"/)
    expect(route).toContain("Hidden from the ordinary Market")
    expect(route).toMatch(/>\s*Edit\s*<\/Button>/)
    expect(route).toContain('{isDeleting ? "..." : "Delete"}')
  })
})

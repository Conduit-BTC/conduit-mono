import { describe, expect, it } from "bun:test"
import type { Product, ProductsByIdsResult } from "@conduit/core"
import { readEventShippingProduct } from "../apps/market/src/lib/event-fulfillment-choice"

const merchant = "a".repeat(64)
const productId = `30402:${merchant}:soap`
const product: Product = {
  id: productId,
  pubkey: merchant,
  title: "Soap",
  price: 1000,
  currency: "SATS",
  type: "simple",
  specifications: [],
  format: "physical",
  shippingOptionId: `30406:${merchant}:shipping`,
  visibility: "public",
  images: [],
  tags: [],
  publicZapEnabled: false,
  zapMessagePolicy: "generic_only",
  publicZapPolicyKnown: true,
  createdAt: 1000,
  updatedAt: 1000,
}
const input = {
  productId,
  merchantPubkey: merchant,
  authenticatedPubkey: null,
  expectedEventId: "b".repeat(64),
  shouldContinue: () => true,
}
function liveResult(): ProductsByIdsResult {
  return {
    data: [
      {
        product,
        eventId: input.expectedEventId,
        addressId: productId,
        dTag: "soap",
        eventCreatedAt: 1000,
      },
    ],
    diagnostics: [
      {
        productId,
        addressId: productId,
        issue: null,
        coverage: { listing: "partial", deletion: "partial" },
      },
    ],
    meta: {
      source: "commerce",
      degraded: true,
      stale: false,
      fetchedAt: 1000,
      capabilities: {
        sortModes: [],
        textSearch: false,
        protectedSummaries: false,
        canonicalFreshness: false,
        cursorPagination: false,
      },
    },
  }
}

describe("event catalog ordinary shipping", () => {
  it("accepts exact positive listing evidence without requiring event authority or complete relay coverage", async () => {
    const result = await readEventShippingProduct(
      input,
      async (ids, options) => {
        expect(ids).toEqual([productId])
        expect(options?.shouldContinue).toBe(input.shouldContinue)
        return liveResult()
      }
    )
    expect(result).toBe(product)
  })

  it("rejects a changed signed revision before adding the catalog selection", async () => {
    const result = liveResult()
    result.data[0]!.eventId = "c".repeat(64)
    await expect(
      readEventShippingProduct(input, async () => result)
    ).rejects.toThrow("Product details changed")
  })

  it("does not turn stale, filtered, missing, or unavailable listing evidence into shipping authority", async () => {
    const variants = [liveResult(), liveResult(), liveResult(), liveResult()]
    variants[0]!.meta.source = "local_cache"
    variants[1]!.diagnostics[0]!.issue = "listing_filtered"
    variants[2]!.data = []
    variants[3]!.diagnostics[0]!.coverage!.listing = "unavailable"
    for (const result of variants)
      await expect(
        readEventShippingProduct(input, async () => result)
      ).rejects.toThrow("Current shipping terms could not be verified")
  })

  it("rejects owner changes, unsupported shipping, and cancellation during the read", async () => {
    for (const changed of [
      { ...product, pubkey: "c".repeat(64) },
      { ...product, shippingOptionId: undefined },
    ]) {
      const result = liveResult()
      result.data[0]!.product = changed
      await expect(
        readEventShippingProduct(input, async () => result)
      ).rejects.toThrow("Current shipping terms could not be verified")
    }
    let current = true
    await expect(
      readEventShippingProduct(
        { ...input, shouldContinue: () => current },
        async () => {
          current = false
          return liveResult()
        }
      )
    ).rejects.toThrow("Current shipping terms could not be verified")
  })
})

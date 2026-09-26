import { describe, expect, it } from "bun:test"
import {
  encodeProductNaddr,
  type CheckoutIntent,
  type Product,
  type ProductsByIdsResult,
} from "@conduit/core"
import { prepareCheckoutIntent } from "../apps/market/src/lib/checkout-intent-import"

const merchant = "a".repeat(64)
const other = "b".repeat(64)
const first = `30402:${merchant}:first`
const second = `30402:${merchant}:second`

function intent(coordinates: string[]): CheckoutIntent {
  return {
    v: 1,
    mode: "cart",
    items: coordinates.map((coordinate, index) => ({
      coordinate,
      product: encodeProductNaddr(coordinate, ["wss://relay.example.com"]),
      quantity: index + 1,
    })),
  }
}

function product(id: string, overrides: Partial<Product> = {}): Product {
  return {
    id,
    pubkey: merchant,
    title: "Signed product",
    price: 1000,
    currency: "SATS",
    type: "simple",
    specifications: [],
    format: "digital",
    visibility: "public",
    stock: 5,
    images: [],
    tags: [],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

function readResult(
  request: CheckoutIntent,
  issue: string | null = null,
  overrides: Partial<Product> = {}
): ProductsByIdsResult {
  return {
    meta: { source: "commerce" } as ProductsByIdsResult["meta"],
    data: request.items.map((item) => ({
      addressId: item.coordinate,
      eventId: "1".repeat(64),
      dTag: item.coordinate.split(":")[2]!,
      eventCreatedAt: 100,
      product: product(item.coordinate, overrides),
    })),
    diagnostics: request.items.map((item) => ({
      productId: item.product,
      addressId: item.coordinate,
      issue: issue as ProductsByIdsResult["diagnostics"][number]["issue"],
      coverage: { listing: "complete", deletion: "complete" },
    })),
  }
}

describe("checkout intent signed resolution", () => {
  it("preserves hinted naddr references and exact quantities", async () => {
    const request = intent([first, second])
    let received: string[] = []
    const result = await prepareCheckoutIntent(request, {}, async (ids) => {
      received = ids
      return readResult(request)
    })
    expect(received).toEqual(request.items.map((item) => item.product))
    expect(result).toMatchObject({
      status: "ready",
      merchantPubkey: merchant,
      items: [
        { productId: first, quantity: 1 },
        { productId: second, quantity: 2 },
      ],
    })
  })

  it("stops mixed merchant links before relay reads", async () => {
    let reads = 0
    const result = await prepareCheckoutIntent(
      intent([first, `30402:${other}:other`]),
      {},
      async () => {
        reads += 1
        throw new Error("should not read")
      }
    )
    expect(reads).toBe(0)
    expect(result).toEqual({
      status: "error",
      error: "merchant_scope_mismatch",
    })
  })

  it("does not prepare partial reads or insufficient stock", async () => {
    const request = intent([first])
    expect(
      await prepareCheckoutIntent(request, {}, async () =>
        readResult(request, "lookup_partial")
      )
    ).toEqual({ status: "error", error: "relay_unavailable" })
    expect(
      await prepareCheckoutIntent(request, {}, async () =>
        readResult(request, null, { stock: 0 })
      )
    ).toEqual({ status: "error", error: "product_unavailable" })
  })
})

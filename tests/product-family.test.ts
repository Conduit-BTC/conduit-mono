import { describe, expect, it } from "bun:test"
import {
  prepareProductCatalog,
  resolvePurchasableSelection,
  type Product,
  type ProductFamilyRecord,
} from "@conduit/core"

const MERCHANT_PUBKEY = "a".repeat(64)

function product(overrides: Partial<Product>): Product {
  return {
    id: `30402:${MERCHANT_PUBKEY}:product`,
    pubkey: MERCHANT_PUBKEY,
    title: "Portable Workspace",
    price: 25_000,
    currency: "SATS",
    type: "simple",
    specifications: [],
    format: "digital",
    visibility: "public",
    images: [{ url: "https://example.com/workspace.png" }],
    tags: ["software"],
    publicZapEnabled: true,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function record(
  dTag: string,
  productOverrides: Partial<Product>
): ProductFamilyRecord {
  const addressId = `30402:${MERCHANT_PUBKEY}:${dTag}`
  return {
    addressId,
    eventId: `${dTag}-event`,
    eventCreatedAt: 1,
    product: product({ id: addressId, ...productOverrides }),
    sourceRelayUrls: ["wss://relay.example"],
  }
}

describe("product family module", () => {
  it("assembles generic sparse children without mutating the atomic parent", () => {
    const parent = record("workspace", {
      type: "variable",
      title: "Portable Workspace",
    })
    const children = [
      record("workspace-13-personal", {
        type: "variation",
        parentProductId: parent.addressId,
        specifications: [
          { key: "screen-size", value: '13"' },
          { key: "license-tier", value: "Personal" },
        ],
      }),
      record("workspace-15-personal", {
        type: "variation",
        parentProductId: parent.addressId,
        specifications: [
          { key: "screen-size", value: '15"' },
          { key: "license-tier", value: "Personal" },
        ],
      }),
      record("workspace-15-business", {
        type: "variation",
        parentProductId: parent.addressId,
        specifications: [
          { key: "screen-size", value: '15"' },
          { key: "license-tier", value: "Business" },
        ],
      }),
    ]

    const catalog = prepareProductCatalog([parent, ...children], {
      source: "commerce",
      fetchedAt: 2,
      stale: false,
      degraded: false,
      capped: false,
    })

    expect(catalog.items).toHaveLength(1)
    expect(catalog.unresolved).toHaveLength(0)
    expect(catalog.items[0]?.kind).toBe("family")
    if (catalog.items[0]?.kind !== "family") {
      throw new Error("Expected a prepared family")
    }

    expect(catalog.items[0].family.state).toBe("ready")
    expect(
      catalog.items[0].family.children.map((child) => child.addressId)
    ).toEqual([
      `30402:${MERCHANT_PUBKEY}:workspace-15-business`,
      `30402:${MERCHANT_PUBKEY}:workspace-13-personal`,
      `30402:${MERCHANT_PUBKEY}:workspace-15-personal`,
    ])
    expect(catalog.items[0].family.axes).toEqual([
      {
        key: "license-tier",
        label: "license-tier",
        values: ["Business", "Personal"],
      },
      {
        key: "screen-size",
        label: "screen-size",
        values: ['13"', '15"'],
      },
    ])
    expect(parent.product).not.toHaveProperty("variations")
  })

  it("rejects ambiguous and incomplete child tuples with repair diagnostics", () => {
    const parent = record("workspace", { type: "variable" })
    const variation = (
      dTag: string,
      specifications: Product["specifications"]
    ) =>
      record(dTag, {
        type: "variation",
        parentProductId: parent.addressId,
        specifications,
      })
    const catalog = prepareProductCatalog(
      [
        parent,
        variation("workspace-13-personal", [
          { key: "screen-size", value: '13"' },
          { key: "license-tier", value: "Personal" },
        ]),
        variation("workspace-15-personal", [
          { key: "screen-size", value: '15"' },
          { key: "license-tier", value: "Personal" },
        ]),
        variation("workspace-duplicate-key", [
          { key: "screen-size", value: '13"' },
          { key: "Screen-Size", value: '15"' },
          { key: "license-tier", value: "Business" },
        ]),
        variation("workspace-missing-key", [
          { key: "screen-size", value: '17"' },
        ]),
        variation("workspace-duplicate-tuple-a", [
          { key: "screen-size", value: '16"' },
          { key: "license-tier", value: "Business" },
        ]),
        variation("workspace-duplicate-tuple-b", [
          { key: "screen-size", value: '16"' },
          { key: "license-tier", value: "Business" },
        ]),
      ],
      {
        source: "commerce",
        fetchedAt: 2,
        stale: false,
        degraded: false,
        capped: false,
      }
    )
    const item = catalog.items[0]
    if (item?.kind !== "family") throw new Error("Expected a family")

    expect(item.family.children.map((child) => child.addressId)).toEqual([
      `30402:${MERCHANT_PUBKEY}:workspace-13-personal`,
      `30402:${MERCHANT_PUBKEY}:workspace-15-personal`,
    ])
    expect(
      item.family.diagnostics.map((diagnostic) => diagnostic.code)
    ).toEqual([
      "duplicate_specification_key",
      "missing_specification_key",
      "duplicate_specification_tuple",
      "duplicate_specification_tuple",
    ])
  })

  it("requires a complete selection and resolves one exact purchasable child", () => {
    const parent = record("workspace", {
      type: "variable",
      images: [{ url: "https://example.com/family.png" }],
    })
    const child = record("workspace-15-business-dark", {
      type: "variation",
      parentProductId: parent.addressId,
      specifications: [
        { key: "screen-size", value: '15"' },
        { key: "license-tier", value: "Business" },
        { key: "theme", value: "Dark" },
      ],
      images: [],
      stock: 2,
    })
    const catalog = prepareProductCatalog([parent, child], {
      source: "commerce",
      fetchedAt: 2,
      stale: false,
      degraded: false,
      capped: false,
    })
    const item = catalog.items[0]
    if (item?.kind !== "family") throw new Error("Expected a family")

    const partial = resolvePurchasableSelection(item, {
      specifications: [{ key: "screen-size", value: '15"' }],
    })
    expect(partial.status).toBe("selection_required")

    const resolved = resolvePurchasableSelection(item, {
      specifications: [
        { key: "theme", value: "Dark" },
        { key: "screen-size", value: '15"' },
        { key: "license-tier", value: "Business" },
      ],
    })
    expect(resolved.status).toBe("selected")
    if (resolved.status !== "selected") {
      throw new Error("Expected an exact child selection")
    }

    expect(resolved.record.addressId).toBe(child.addressId)
    expect(resolved.selectedSpecifications).toEqual(
      child.product.specifications
    )
    expect(resolved.imageProjection).toEqual({
      images: parent.product.images,
      source: "parent",
      sourceProductId: parent.addressId,
    })
  })

  it("derives price and inventory summaries from purchasable children", () => {
    const parent = record("workspace", {
      type: "variable",
      price: 999_999,
      stock: 999,
    })
    const child = (dTag: string, value: string, price: number, stock: number) =>
      record(dTag, {
        type: "variation",
        parentProductId: parent.addressId,
        specifications: [{ key: "license-tier", value }],
        price,
        stock,
      })
    const catalog = prepareProductCatalog(
      [
        parent,
        child("workspace-personal", "Personal", 10_000, 0),
        child("workspace-business", "Business", 30_000, 4),
        child("workspace-enterprise", "Enterprise", 20_000, 2),
      ],
      {
        source: "commerce",
        fetchedAt: 2,
        stale: false,
        degraded: false,
        capped: false,
      }
    )
    const item = catalog.items[0]
    if (item?.kind !== "family") throw new Error("Expected a family")

    expect(item.family.priceSummary).toMatchObject({
      varies: true,
      minimum: { addressId: `30402:${MERCHANT_PUBKEY}:workspace-personal` },
      maximum: { addressId: `30402:${MERCHANT_PUBKEY}:workspace-business` },
    })
    expect(item.family.inventorySummary).toEqual({
      tracking: "tracked",
      availability: "available",
      totalStock: 6,
    })
  })
})

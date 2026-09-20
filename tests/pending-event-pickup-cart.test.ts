import { describe, expect, it } from "bun:test"
import {
  evaluateListingSafety,
  resolveEventMarketProductParticipation,
  type CommerceProductRecord,
  type EventMarketResolution,
  type Product,
  type ProductAvailabilityIssue,
  type ProductsByIdsResult,
} from "@conduit/core"
import {
  buildPickupFulfillmentSnapshot,
  type EventCatalog,
} from "../apps/market/src/lib/event-market-adapter"
import {
  createPendingEventPickupFulfillment,
  type CartItem,
} from "../apps/market/src/lib/cart-model"
import {
  resolvePendingEventPickupCartUpgrades,
  type PendingEventPickupCartDependencies,
} from "../apps/market/src/lib/pending-event-pickup-cart"

type Fixture = {
  product: Product
  collectionCoordinate: string
  catalog: EventCatalog
  pendingItem: CartItem
}

function productRecord(product: Product): CommerceProductRecord {
  return {
    product,
    safety: evaluateListingSafety(product),
    addressId: product.id,
    eventId: product.sourceEventId!,
    eventCreatedAt: product.createdAt / 1_000,
    dTag: product.id.split(":").at(-1) ?? null,
  }
}

function productResult(
  products: readonly Product[],
  issue: ProductAvailabilityIssue | null = null
): ProductsByIdsResult {
  return {
    data: products.map(productRecord),
    meta: {
      source: "commerce",
      degraded: issue !== null,
      stale: issue === "cached_only",
      capped: false,
      capabilities: {
        sortModes: [],
        textSearch: false,
        protectedSummaries: false,
        canonicalFreshness: true,
        cursorPagination: false,
      },
      fetchedAt: 1,
    },
    diagnostics: products.map((product) => ({
      productId: product.id,
      addressId: product.id,
      issue,
      coverage: {
        listing: issue === null ? "complete" : "partial",
        deletion: "complete",
      },
    })),
  }
}

function fixture(input: {
  organizerChar: string
  merchantChar: string
  suffix: string
  eventIdChar: string
}): Fixture {
  const organizer = input.organizerChar.repeat(64)
  const merchant = input.merchantChar.repeat(64)
  const collectionCoordinate = `30405:${organizer}:market-${input.suffix}`
  const calendarCoordinate = `31923:${organizer}:market-${input.suffix}`
  const pickupCoordinate = `30406:${organizer}:pickup-${input.suffix}`
  const productCoordinate = `30402:${merchant}:product-${input.suffix}`
  const productEventId = input.eventIdChar.repeat(64)
  const product: Product = {
    id: productCoordinate,
    pubkey: merchant,
    title: `Product ${input.suffix}`,
    price: 2_000,
    currency: "SATS",
    priceSats: 2_000,
    type: "simple",
    format: "physical",
    visibility: "public",
    images: [{ url: `https://cdn.conduit.market/${input.suffix}.png` }],
    tags: [],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 103_000,
    updatedAt: 103_000,
    sourceEventId: productEventId,
    collectionRefs: [collectionCoordinate],
    shippingOptionRefs: [{ coordinate: pickupCoordinate }],
    stock: 2,
  }
  const pickup = {
    coordinate: pickupCoordinate,
    eventId: "3".repeat(64),
    authorPubkey: organizer,
    dTag: `pickup-${input.suffix}`,
    title: "Event pickup",
    content: "",
    price: 0,
    currency: "SATS",
    countries: [],
    location: "Fixture entrance",
    geohash: "dpz83",
    createdAt: 102,
  }
  const resolution: EventMarketResolution = {
    state: "active",
    reference: collectionCoordinate,
    organizerPubkey: organizer,
    collectionCoordinate,
    calendarCoordinate,
    pickupCoordinate,
    collection: {
      coordinate: collectionCoordinate,
      eventId: "1".repeat(64),
      authorPubkey: organizer,
      dTag: `market-${input.suffix}`,
      title: `Market ${input.suffix}`,
      content: "",
      eventCoordinates: [calendarCoordinate],
      pickupCoordinates: [pickupCoordinate],
      productCoordinates: [productCoordinate],
      unsupportedReferences: [],
      createdAt: 100,
    },
    calendar: {
      coordinate: calendarCoordinate,
      eventId: "2".repeat(64),
      authorPubkey: organizer,
      dTag: `market-${input.suffix}`,
      kind: 31923,
      title: `Market ${input.suffix}`,
      content: "",
      locations: ["Fixture Hall"],
      start: 1_800_000_000_000,
      end: 1_800_003_600_000,
      createdAt: 101,
    },
    pickup,
    pickups: [pickup],
    organizerProductCoordinates: [productCoordinate],
    acceptedProductCoordinates: [productCoordinate],
    acceptedProductEvidence: [
      {
        productCoordinate,
        eventId: productEventId,
        createdAt: product.createdAt,
        shippingOptionCoordinates: [pickupCoordinate],
        merchantPubkey: merchant,
      },
    ],
    organizerOnlyProductCoordinates: [],
    participationRequests: [{ productCoordinate, merchantPubkey: merchant }],
    participationBudget: {
      state: "within_budget",
      targetCount: 1,
      targetLimit: 64,
    },
    pickupBudget: {
      state: "within_budget",
      targetCount: 1,
      targetLimit: 64,
    },
    coverage: {
      attemptedRelayCount: 1,
      completeRelayCount: 1,
      partialRelayCount: 0,
      failedRelayCount: 0,
    },
  }
  const pickupFulfillment = buildPickupFulfillmentSnapshot(
    product,
    resolution,
    productRecord(product),
    null
  )
  if (!pickupFulfillment) throw new Error("Expected exact pickup fixture")
  const catalog: EventCatalog = {
    state: "active",
    reference: collectionCoordinate,
    canonicalNaddr: `naddr1${input.suffix}`,
    organizerPubkey: organizer,
    collection: resolution.collection,
    calendar: resolution.calendar,
    pickup,
    pickups: [pickup],
    products: [
      {
        product,
        evidenceState: "live",
        participation: resolveEventMarketProductParticipation(
          product,
          resolution
        ),
        pickupFulfillment,
        pickupReadiness: "resolved",
      },
    ],
    acceptedProductCount: 1,
    unresolvedProductCoordinates: [],
    productReadState: "ready",
    purchaseReady: true,
  }
  const pendingFulfillment =
    createPendingEventPickupFulfillment(collectionCoordinate)
  if (!pendingFulfillment) throw new Error("Expected pending pickup fixture")
  return {
    product,
    collectionCoordinate,
    catalog,
    pendingItem: {
      cartLineId: `line-${input.suffix}`,
      productId: product.id,
      merchantPubkey: product.pubkey,
      title: product.title,
      price: product.price,
      currency: product.currency,
      priceSats: product.priceSats,
      format: "physical",
      fulfillment: pendingFulfillment,
      productUpdatedAt: product.updatedAt,
      productEventId: product.sourceEventId,
      stock: product.stock,
      quantity: 1,
    },
  }
}

function dependencies(
  read: ProductsByIdsResult,
  loadCatalog: PendingEventPickupCartDependencies["loadCatalog"]
): PendingEventPickupCartDependencies {
  return {
    getProductsByIds: async () => read,
    loadCatalog,
  }
}

describe("pending event pickup cart resolution", () => {
  it("retries stale no-claim evidence, upgrades a later live claim, and stops on a stronger withdrawal", async () => {
    const current = fixture({
      organizerChar: "a",
      merchantChar: "b",
      suffix: "retry",
      eventIdChar: "4",
    })
    const staleNoClaim: Product = {
      ...current.product,
      createdAt: current.product.createdAt - 1_000,
      updatedAt: current.product.updatedAt - 1_000,
      sourceEventId: "5".repeat(64),
      collectionRefs: [],
      shippingOptionRefs: [],
    }
    for (const issue of ["cached_only", "lookup_partial"] as const) {
      const unresolved = await resolvePendingEventPickupCartUpgrades(
        [current.pendingItem],
        null,
        {},
        dependencies(productResult([staleNoClaim], issue), async () =>
          Promise.reject(
            new Error("stale no-claim read must not load a catalog")
          )
        )
      )

      expect(unresolved).toEqual({ upgrades: [], retryable: true })
    }

    const live = await resolvePendingEventPickupCartUpgrades(
      [current.pendingItem],
      null,
      {},
      dependencies(
        productResult([current.product]),
        async () => current.catalog
      )
    )

    expect(live.retryable).toBe(false)
    expect(live.upgrades).toHaveLength(1)
    expect(live.upgrades[0]?.identity.cartLineId).toBe(
      current.pendingItem.cartLineId
    )
    expect(live.upgrades[0]?.item.fulfillment.type).toBe("pickup")

    const strongerWithdrawal: Product = {
      ...current.product,
      createdAt: current.product.createdAt + 1_000,
      updatedAt: current.product.updatedAt + 1_000,
      sourceEventId: "0".repeat(64),
      collectionRefs: [],
      shippingOptionRefs: [],
    }
    const terminal = await resolvePendingEventPickupCartUpgrades(
      [current.pendingItem],
      null,
      {},
      dependencies(
        productResult([strongerWithdrawal], "lookup_partial"),
        async () =>
          Promise.reject(new Error("signed withdrawal must not load a catalog"))
      )
    )

    expect(terminal).toEqual({ upgrades: [], retryable: false })
  })

  it("retries older same-claim product revisions until the pending frontier is observed", async () => {
    const current = fixture({
      organizerChar: "a",
      merchantChar: "b",
      suffix: "older-frontier",
      eventIdChar: "4",
    })
    const olderProducts: Product[] = [
      {
        ...current.product,
        createdAt: current.product.createdAt - 1_000,
        updatedAt: current.product.updatedAt - 1_000,
        sourceEventId: "0".repeat(64),
      },
      {
        ...current.product,
        sourceEventId: "5".repeat(64),
      },
    ]

    for (const olderProduct of olderProducts) {
      const currentEntry = current.catalog.products[0]!
      const currentFulfillment = currentEntry.pickupFulfillment!
      const olderCatalog: EventCatalog = {
        ...current.catalog,
        products: [
          {
            ...currentEntry,
            product: olderProduct,
            pickupFulfillment: {
              ...currentFulfillment,
              product: {
                ...currentFulfillment.product,
                createdAt: olderProduct.updatedAt,
                eventId: olderProduct.sourceEventId!,
              },
            },
          },
        ],
      }
      let catalogReads = 0
      const unresolved = await resolvePendingEventPickupCartUpgrades(
        [current.pendingItem],
        null,
        {},
        dependencies(productResult([olderProduct]), async () => {
          catalogReads += 1
          return olderCatalog
        })
      )

      expect(unresolved).toEqual({ upgrades: [], retryable: true })
      expect(catalogReads).toBe(0)
    }

    const resolved = await resolvePendingEventPickupCartUpgrades(
      [current.pendingItem],
      null,
      {},
      dependencies(
        productResult([current.product]),
        async () => current.catalog
      )
    )

    expect(resolved.retryable).toBe(false)
    expect(resolved.upgrades).toHaveLength(1)
    expect(resolved.upgrades[0]?.identity.cartLineId).toBe(
      current.pendingItem.cartLineId
    )
  })

  it("keeps valid upgrades when another event catalog read fails", async () => {
    const failed = fixture({
      organizerChar: "a",
      merchantChar: "b",
      suffix: "failed",
      eventIdChar: "4",
    })
    const valid = fixture({
      organizerChar: "c",
      merchantChar: "d",
      suffix: "valid",
      eventIdChar: "5",
    })
    const result = await resolvePendingEventPickupCartUpgrades(
      [failed.pendingItem, valid.pendingItem],
      null,
      {},
      dependencies(
        productResult([failed.product, valid.product]),
        async (_reference, _rateInput, options) => {
          if (options.selectedProductCoordinates.includes(failed.product.id)) {
            throw new Error("synthetic catalog outage")
          }
          return valid.catalog
        }
      )
    )

    expect(result.retryable).toBe(true)
    expect(result.upgrades).toHaveLength(1)
    expect(result.upgrades[0]?.identity.productId).toBe(valid.product.id)
    expect(result.upgrades[0]?.item.fulfillment.type).toBe("pickup")
  })

  it("propagates catalog cancellation instead of converting it to retryable evidence", async () => {
    const current = fixture({
      organizerChar: "a",
      merchantChar: "b",
      suffix: "abort",
      eventIdChar: "4",
    })
    const abort = new DOMException("cancelled", "AbortError")

    await expect(
      resolvePendingEventPickupCartUpgrades(
        [current.pendingItem],
        null,
        {},
        dependencies(productResult([current.product]), async () => {
          throw abort
        })
      )
    ).rejects.toBe(abort)
  })
})

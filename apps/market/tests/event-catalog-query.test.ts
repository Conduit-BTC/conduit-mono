import { afterEach, describe, expect, it } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  encodeEventMarketNaddr,
  evaluateListingSafety,
  prepareProductCatalog,
  type CommerceProductRecord,
  type EventMarketResolution,
  type Product,
  type ProductsByIdsResult,
} from "@conduit/core"
import {
  eventCatalogQueryIdentity,
  eventCatalogQueryOptions,
  type EventCatalogQueryScope,
} from "../src/lib/event-catalog-query"
import {
  __resetEventCatalogAdapterTestOverrides,
  __setEventCatalogAdapterTestOverrides,
  eventCatalogAcceptedProductRecoveryCoordinates,
  mergeEventCatalogAcceptedProductRecovery,
  projectEventCatalogHydration,
  projectRawEventCatalog,
  resolveProductCartFulfillmentFromCatalogs,
  getProductEventMarketCandidates,
  eventCatalogNeedsProductRefresh,
  getEventCatalogProductSourceObservation,
  loadRawEventCatalog,
  takeEventCatalogProductRefreshObservations,
  type RawEventCatalog,
} from "../src/lib/event-market-adapter"

const organizer = "a".repeat(64)
const merchant = "b".repeat(64)
const collectionCoordinate = `30405:${organizer}:summer-market`
const calendarCoordinate = `31923:${organizer}:summer-market`
const pickupCoordinate = `30406:${organizer}:summer-market-pickup`
const productCoordinate = `30402:${merchant}:coffee`

function market(
  state: EventMarketResolution["state"] = "active"
): EventMarketResolution {
  const pickup = {
    coordinate: pickupCoordinate,
    eventId: "3".repeat(64),
    authorPubkey: organizer,
    dTag: "summer-market-pickup",
    title: "Event pickup",
    content: "",
    price: 0,
    currency: "SATS",
    countries: [],
    location: "Public hall entrance",
    geohash: "dpz83",
    createdAt: 102,
  }
  return {
    state,
    reference: collectionCoordinate,
    organizerPubkey: organizer,
    collectionCoordinate,
    calendarCoordinate,
    pickupCoordinate,
    collection: {
      coordinate: collectionCoordinate,
      eventId: "1".repeat(64),
      authorPubkey: organizer,
      dTag: "summer-market",
      title: "Summer Market",
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
      dTag: "summer-market",
      kind: 31923,
      title: "Summer Market",
      content: "",
      locations: ["Public hall"],
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
        eventId: "4".repeat(64),
        createdAt: 103_000,
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
      attemptedRelayCount: 2,
      completeRelayCount: 2,
      partialRelayCount: 0,
      failedRelayCount: 0,
    },
  }
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: productCoordinate,
    pubkey: merchant,
    title: "Coffee",
    price: 2_000,
    currency: "SATS",
    priceSats: 2_000,
    type: "simple",
    format: "physical",
    visibility: "public",
    images: [{ url: "https://cdn.conduit.market/coffee.png" }],
    tags: [],
    publicZapEnabled: false,
    zapMessagePolicy: "generic_only",
    publicZapPolicyKnown: true,
    createdAt: 103_000,
    updatedAt: 103_000,
    collectionRefs: [collectionCoordinate],
    shippingOptionRefs: [{ coordinate: pickupCoordinate }],
    ...overrides,
  }
}

function commerceRecord(
  candidate: Product,
  overrides: Partial<CommerceProductRecord> = {}
): CommerceProductRecord {
  return {
    product: candidate,
    safety: evaluateListingSafety(candidate),
    addressId: candidate.id,
    eventId: "4".repeat(64),
    eventCreatedAt: candidate.createdAt / 1_000,
    dTag: candidate.id.split(":").at(-1) ?? null,
    ...overrides,
  }
}

function productRead(
  options: {
    product?: Product
    includeRecord?: boolean
    issue?: ProductsByIdsResult["diagnostics"][number]["issue"]
    source?: ProductsByIdsResult["meta"]["source"]
    stale?: boolean
    listing?: "complete" | "partial" | "unavailable"
    eventId?: string
    eventCreatedAt?: number
  } = {}
): ProductsByIdsResult {
  const candidate = options.product ?? product()
  const record = commerceRecord(candidate, {
    eventId: options.eventId ?? "4".repeat(64),
    eventCreatedAt: options.eventCreatedAt ?? 103,
  })
  return {
    data: options.includeRecord === false ? [] : [record],
    meta: {
      source: options.source ?? "commerce",
      degraded: (options.issue ?? null) !== null,
      stale: options.stale ?? false,
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
    diagnostics: [
      {
        productId: candidate.id,
        addressId: candidate.id,
        issue: options.issue ?? null,
        coverage: {
          listing: options.listing ?? "complete",
          deletion: "complete",
        },
      },
    ],
  }
}

const scope: EventCatalogQueryScope = {
  relayScope: "relay-a",
  authenticatedPubkey: null,
  authGeneration: 1,
}
function raw(): RawEventCatalog {
  return {
    reference: collectionCoordinate,
    resolution: market(),
    result: productRead(),
    complete: true,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  __resetEventCatalogAdapterTestOverrides()
})

describe("shared progressive event catalogs", () => {
  it("targets missing, older, or unsettled products when acceptance advances", () => {
    const healthyCoordinate = `30402:${merchant}:tea`
    const pendingCoordinate = `30402:${"c".repeat(64)}:pending`
    const healthy = product({
      id: healthyCoordinate,
      title: "Tea",
      createdAt: 104_000,
      updatedAt: 104_000,
    })
    const resolution: EventMarketResolution = {
      ...market(),
      organizerProductCoordinates: [
        productCoordinate,
        healthyCoordinate,
        pendingCoordinate,
      ],
      acceptedProductCoordinates: [
        productCoordinate,
        healthyCoordinate,
        pendingCoordinate,
      ],
      acceptedProductEvidence: [
        ...market().acceptedProductEvidence,
        {
          productCoordinate: healthyCoordinate,
          eventId: "5".repeat(64),
          createdAt: 104_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: merchant,
        },
        {
          productCoordinate: pendingCoordinate,
          eventId: "6".repeat(64),
          createdAt: 105_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: "c".repeat(64),
        },
      ],
    }
    const missing = productRead({
      includeRecord: false,
      issue: "product_missing",
    })
    const result: ProductsByIdsResult = {
      ...missing,
      data: [
        commerceRecord(healthy, {
          eventId: "5".repeat(64),
          eventCreatedAt: 104,
        }),
      ],
      diagnostics: [
        ...missing.diagnostics,
        {
          productId: healthyCoordinate,
          addressId: healthyCoordinate,
          issue: null,
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    }

    expect(
      eventCatalogAcceptedProductRecoveryCoordinates(resolution, result)
    ).toEqual([productCoordinate, pendingCoordinate])

    const older = productRead({ eventId: "3".repeat(64), eventCreatedAt: 102 })
    expect(
      eventCatalogAcceptedProductRecoveryCoordinates(market(), older)
    ).toEqual([productCoordinate])

    const newerWithdrawal = productRead({
      product: product({ collectionRefs: [], createdAt: 104_000 }),
      eventId: "7".repeat(64),
      eventCreatedAt: 104,
      issue: "listing_filtered",
    })
    expect(
      eventCatalogAcceptedProductRecoveryCoordinates(market(), newerWithdrawal)
    ).toEqual([])

    const recovered = productRead()
    const recoveredWithUnrelatedDegradation: ProductsByIdsResult = {
      ...recovered,
      meta: { ...recovered.meta, stale: true, degraded: true },
      diagnostics: [
        ...recovered.diagnostics,
        {
          productId: pendingCoordinate,
          addressId: pendingCoordinate,
          issue: "lookup_unavailable",
          coverage: { listing: "unavailable", deletion: "unavailable" },
        },
      ],
    }
    const hydration = projectEventCatalogHydration({
      resolution,
      result: recoveredWithUnrelatedDegradation,
    })
    expect(hydration.productReadState).toBe("partial")
    expect(
      hydration.products.find((entry) => entry.product.id === productCoordinate)
        ?.pickupFulfillment
    ).not.toBeNull()

    const withdrawnHealthy = product({
      ...healthy,
      collectionRefs: [],
      createdAt: 105_000,
      updatedAt: 105_000,
    })
    const baseAfterWithdrawal: ProductsByIdsResult = {
      ...missing,
      data: [
        commerceRecord(withdrawnHealthy, {
          eventId: "7".repeat(64),
          eventCreatedAt: 105,
        }),
      ],
      diagnostics: [
        ...missing.diagnostics,
        {
          productId: healthyCoordinate,
          addressId: healthyCoordinate,
          issue: "listing_filtered",
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    }
    const earlierRecovery: ProductsByIdsResult = {
      ...recovered,
      data: [
        ...recovered.data,
        commerceRecord(healthy, {
          eventId: "5".repeat(64),
          eventCreatedAt: 104,
        }),
      ],
      diagnostics: [
        ...recovered.diagnostics,
        {
          productId: healthyCoordinate,
          addressId: healthyCoordinate,
          issue: null,
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    }
    const merged = mergeEventCatalogAcceptedProductRecovery(
      baseAfterWithdrawal,
      earlierRecovery
    )
    expect(
      merged.diagnostics.find(
        (diagnostic) => diagnostic.productId === healthyCoordinate
      )?.issue
    ).toBe("listing_filtered")
    expect(
      merged.data.find((record) => record.addressId === healthyCoordinate)
        ?.eventId
    ).toBeUndefined()
    const mergedHydration = projectEventCatalogHydration({
      resolution,
      result: merged,
    })
    expect(
      mergedHydration.products.find(
        (entry) => entry.product.id === productCoordinate
      )?.pickupFulfillment
    ).not.toBeNull()
    expect(
      mergedHydration.products.find(
        (entry) => entry.product.id === healthyCoordinate
      )?.pickupFulfillment
    ).toBeUndefined()
  })

  it("retains a signed product for browsing when a later exact read is missing", () => {
    const merged = mergeEventCatalogAcceptedProductRecovery(
      productRead(),
      productRead({ includeRecord: false, issue: "product_missing" })
    )

    expect(merged.data.map((record) => record.product.id)).toEqual([
      productCoordinate,
    ])
    expect(merged.diagnostics[0]?.issue).toBe("product_missing")
    expect(
      projectEventCatalogHydration({ resolution: market(), result: merged })
        .products[0]?.pickupFulfillment
    ).toBeNull()
  })

  it("merges a final affected-author family recovery without borrowing authority", () => {
    const parent = product({
      id: `30402:${merchant}:family`,
      type: "variable",
    })
    const child = (dTag: string, createdAt: number) =>
      product({
        id: `30402:${merchant}:${dTag}`,
        title: dTag,
        type: "variation",
        parentProductId: parent.id,
        specifications: [{ key: "Size", value: dTag }],
        createdAt,
        updatedAt: createdAt,
      })
    const recoveredChild = child("recovered-child", 103_000)
    const sibling = child("settled-sibling", 105_000)
    const staleSibling = child("settled-sibling", 104_000)
    const family = (...children: Product[]) => {
      const prepared = prepareProductCatalog(
        [
          commerceRecord(parent),
          ...children.map((entry) => commerceRecord(entry)),
        ],
        {
          source: "commerce",
          stale: false,
          degraded: false,
          capped: false,
          fetchedAt: 1,
        }
      ).items[0]
      if (prepared?.kind !== "family") throw new Error("Expected family")
      return { ...prepared.family.parent, family: prepared.family }
    }
    const resolution: EventMarketResolution = {
      ...market(),
      organizerProductCoordinates: [parent.id, recoveredChild.id, sibling.id],
      acceptedProductCoordinates: [recoveredChild.id, sibling.id],
      acceptedProductEvidence: [
        {
          productCoordinate: recoveredChild.id,
          eventId: "4".repeat(64),
          createdAt: 103_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: merchant,
        },
        {
          productCoordinate: sibling.id,
          eventId: "4".repeat(64),
          createdAt: 105_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: merchant,
        },
      ],
    }
    const base = productRead({ includeRecord: false })
    base.data = [family(sibling)]
    base.diagnostics = [
      {
        productId: recoveredChild.id,
        addressId: recoveredChild.id,
        issue: "product_missing",
        coverage: { listing: "complete", deletion: "complete" },
      },
      {
        productId: sibling.id,
        addressId: sibling.id,
        issue: null,
        coverage: { listing: "complete", deletion: "complete" },
      },
    ]
    const recovery = productRead({ includeRecord: false })
    recovery.data = [family(recoveredChild, staleSibling)]
    recovery.diagnostics = [
      {
        productId: recoveredChild.id,
        addressId: recoveredChild.id,
        issue: null,
        coverage: { listing: "complete", deletion: "complete" },
      },
      {
        productId: sibling.id,
        addressId: sibling.id,
        issue: null,
        coverage: { listing: "complete", deletion: "complete" },
      },
    ]

    const merged = mergeEventCatalogAcceptedProductRecovery(base, recovery)
    const mergedFamily = merged.data[0]?.family
    expect(
      mergedFamily?.children.map((entry) => entry.product.id).sort()
    ).toEqual([recoveredChild.id, sibling.id].sort())
    expect(
      mergedFamily?.children.find((entry) => entry.product.id === sibling.id)
        ?.eventCreatedAt
    ).toBe(105)
    expect(
      merged.diagnostics.find(
        (diagnostic) => diagnostic.productId === sibling.id
      )?.issue
    ).toBeNull()

    const retainedSiblingBase: ProductsByIdsResult = {
      ...base,
      diagnostics: base.diagnostics.map((diagnostic) =>
        diagnostic.productId === sibling.id
          ? { ...diagnostic, issue: "cached_only" }
          : diagnostic
      ),
    }
    const mergedRetainedSibling = mergeEventCatalogAcceptedProductRecovery(
      retainedSiblingBase,
      recovery
    )
    expect(
      mergedRetainedSibling.data[0]?.family?.children.find(
        (entry) => entry.product.id === sibling.id
      )?.eventCreatedAt
    ).toBe(105)
    expect(
      mergedRetainedSibling.diagnostics.find(
        (diagnostic) => diagnostic.productId === sibling.id
      )?.issue
    ).toBe("cached_only")
    const retainedSiblingHydration = projectEventCatalogHydration({
      resolution,
      result: mergedRetainedSibling,
    })
    expect(
      retainedSiblingHydration.products.some(
        (entry) =>
          (entry.product.id === sibling.id &&
            entry.pickupFulfillment !== null) ||
          !!entry.familyPickupFulfillments?.[sibling.id]
      )
    ).toBe(false)

    const parentResolution: EventMarketResolution = {
      ...resolution,
      acceptedProductCoordinates: [parent.id],
      acceptedProductEvidence: [
        {
          productCoordinate: parent.id,
          eventId: "4".repeat(64),
          createdAt: 103_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: merchant,
        },
      ],
    }
    const parentBase: ProductsByIdsResult = {
      ...base,
      diagnostics: [
        {
          productId: parent.id,
          addressId: parent.id,
          issue: "lookup_partial",
          coverage: { listing: "partial", deletion: "partial" },
        },
      ],
    }
    const parentRecovery: ProductsByIdsResult = {
      ...recovery,
      diagnostics: [
        {
          productId: parent.id,
          addressId: parent.id,
          issue: null,
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    }
    const mergedParent = mergeEventCatalogAcceptedProductRecovery(
      parentBase,
      parentRecovery
    )
    expect(
      mergedParent.data[0]?.family?.children
        .map((entry) => entry.product.id)
        .sort()
    ).toEqual([recoveredChild.id, sibling.id].sort())
    expect(
      mergedParent.data[0]?.family?.children.find(
        (entry) => entry.product.id === sibling.id
      )?.eventCreatedAt
    ).toBe(105)
    expect(
      mergedParent.diagnostics.find(
        (diagnostic) => diagnostic.productId === sibling.id
      )
    ).toBeUndefined()

    const parentAndChildResolution: EventMarketResolution = {
      ...parentResolution,
      organizerProductCoordinates: [parent.id, staleSibling.id],
      acceptedProductCoordinates: [parent.id, staleSibling.id],
      acceptedProductEvidence: [
        ...parentResolution.acceptedProductEvidence,
        {
          productCoordinate: staleSibling.id,
          eventId: "4".repeat(64),
          createdAt: 104_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: merchant,
        },
      ],
      participationRequests: [
        { productCoordinate: parent.id, merchantPubkey: merchant },
        { productCoordinate: staleSibling.id, merchantPubkey: merchant },
      ],
    }
    const baseWithExactStandaloneChild: ProductsByIdsResult = {
      ...parentBase,
      data: [family(staleSibling), commerceRecord(staleSibling)],
      diagnostics: [
        ...parentBase.diagnostics,
        {
          productId: staleSibling.id,
          addressId: staleSibling.id,
          issue: null,
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    }
    const parentRecoveryWithNewerRetainedChild: ProductsByIdsResult = {
      ...parentRecovery,
      data: [family(sibling)],
      diagnostics: [
        ...parentRecovery.diagnostics,
        {
          productId: sibling.id,
          addressId: sibling.id,
          issue: "cached_only",
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    }
    const mergedAtomicChild = mergeEventCatalogAcceptedProductRecovery(
      baseWithExactStandaloneChild,
      parentRecoveryWithNewerRetainedChild
    )
    expect(
      mergedAtomicChild.data[0]?.family?.children.find(
        (entry) => entry.product.id === staleSibling.id
      )?.eventCreatedAt
    ).toBe(105)
    expect(
      mergedAtomicChild.data.find(
        (entry) => entry.addressId === staleSibling.id
      )?.eventCreatedAt
    ).toBe(105)
    expect(
      mergedAtomicChild.diagnostics.find(
        (diagnostic) => diagnostic.productId === staleSibling.id
      )?.issue
    ).toBe("cached_only")
    const atomicHydration = projectEventCatalogHydration({
      resolution: parentAndChildResolution,
      result: mergedAtomicChild,
    })
    expect(
      atomicHydration.products
        .find((entry) => entry.product.id === parent.id)
        ?.family?.children.find((entry) => entry.product.id === staleSibling.id)
        ?.product.createdAt
    ).toBe(105_000)
    expect(
      atomicHydration.products.find((entry) => entry.product.id === parent.id)
        ?.familyPickupFulfillments?.[staleSibling.id]
    ).toBeNull()

    const recoveryWithoutChildDiagnostic: ProductsByIdsResult = {
      ...parentRecoveryWithNewerRetainedChild,
      diagnostics: parentRecovery.diagnostics,
    }
    const mergedWithoutChildDiagnostic =
      mergeEventCatalogAcceptedProductRecovery(
        baseWithExactStandaloneChild,
        recoveryWithoutChildDiagnostic
      )
    expect(
      mergedWithoutChildDiagnostic.data[0]?.family?.children.find(
        (entry) => entry.product.id === staleSibling.id
      )?.eventCreatedAt
    ).toBe(105)
    expect(
      mergedWithoutChildDiagnostic.data.find(
        (entry) => entry.addressId === staleSibling.id
      )?.eventCreatedAt
    ).toBe(104)

    const recoveryAfterSiblingDeletion: ProductsByIdsResult = {
      ...parentRecovery,
      data: [family(recoveredChild)],
      diagnostics: [
        ...parentRecovery.diagnostics,
        {
          productId: sibling.id,
          addressId: sibling.id,
          issue: "product_missing",
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    }
    const mergedAfterSiblingDeletion = mergeEventCatalogAcceptedProductRecovery(
      parentBase,
      recoveryAfterSiblingDeletion
    )
    expect(
      mergedAfterSiblingDeletion.data[0]?.family?.children.map(
        (entry) => entry.product.id
      )
    ).toEqual([recoveredChild.id, sibling.id])
    expect(
      mergedAfterSiblingDeletion.diagnostics.find(
        (diagnostic) => diagnostic.productId === sibling.id
      )?.issue
    ).toBe("product_missing")

    const filteredSibling = mergeEventCatalogAcceptedProductRecovery(
      parentBase,
      {
        ...recoveryAfterSiblingDeletion,
        diagnostics: recoveryAfterSiblingDeletion.diagnostics.map(
          (diagnostic) =>
            diagnostic.productId === sibling.id
              ? { ...diagnostic, issue: "listing_filtered" }
              : diagnostic
        ),
      }
    )
    expect(
      filteredSibling.data[0]?.family?.children.map((entry) => entry.product.id)
    ).toEqual([recoveredChild.id])

    const partialParentRecovery: ProductsByIdsResult = {
      ...parentRecovery,
      data: [family(recoveredChild)],
      meta: { ...parentRecovery.meta, degraded: true },
      diagnostics: [
        {
          productId: parent.id,
          addressId: parent.id,
          issue: "lookup_partial",
          coverage: { listing: "partial", deletion: "partial" },
        },
      ],
    }
    const mergedPartialParent = mergeEventCatalogAcceptedProductRecovery(
      parentBase,
      partialParentRecovery
    )
    expect(
      mergedPartialParent.data[0]?.family?.children
        .map((entry) => entry.product.id)
        .sort()
    ).toEqual([recoveredChild.id, sibling.id].sort())
    expect(
      mergedPartialParent.data[0]?.family?.children.find(
        (entry) => entry.product.id === sibling.id
      )?.eventCreatedAt
    ).toBe(105)

    const baseAfterChildDeletion: ProductsByIdsResult = {
      ...parentBase,
      data: [family(sibling)],
      diagnostics: [
        ...parentBase.diagnostics,
        {
          productId: recoveredChild.id,
          addressId: recoveredChild.id,
          issue: "product_missing",
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    }
    const oldCompletedParentRecovery: ProductsByIdsResult = {
      ...parentRecovery,
      data: [family(recoveredChild, staleSibling)],
    }
    const mergedAfterLaterBaseDeletion =
      mergeEventCatalogAcceptedProductRecovery(
        baseAfterChildDeletion,
        oldCompletedParentRecovery
      )
    expect(
      mergedAfterLaterBaseDeletion.data[0]?.family?.children.map(
        (entry) => entry.product.id
      )
    ).toEqual([recoveredChild.id, sibling.id])
    expect(
      mergedAfterLaterBaseDeletion.diagnostics.find(
        (diagnostic) => diagnostic.productId === recoveredChild.id
      )?.issue
    ).toBe("product_missing")
  })

  it("keeps settled products actionable and performs one final affected-author recovery", async () => {
    const slowMerchant = "c".repeat(64)
    const slowCoordinate = `30402:${slowMerchant}:slow`
    const resolution: EventMarketResolution = {
      ...market(),
      organizerProductCoordinates: [productCoordinate, slowCoordinate],
      acceptedProductCoordinates: [productCoordinate, slowCoordinate],
      acceptedProductEvidence: [
        ...market().acceptedProductEvidence,
        {
          productCoordinate: slowCoordinate,
          eventId: "5".repeat(64),
          createdAt: 104_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: slowMerchant,
        },
      ],
      participationRequests: [
        ...market().participationRequests,
        { productCoordinate: slowCoordinate, merchantPubkey: slowMerchant },
      ],
      participationBudget: {
        state: "within_budget",
        targetCount: 2,
        targetLimit: 64,
      },
    }
    const broadResult: ProductsByIdsResult = {
      ...productRead(),
      diagnostics: [
        {
          productId: productCoordinate,
          addressId: productCoordinate,
          issue: null,
          coverage: { listing: "complete", deletion: "complete" },
        },
        {
          productId: slowCoordinate,
          addressId: slowCoordinate,
          issue: "product_missing",
          coverage: { listing: "complete", deletion: "complete" },
        },
      ],
    }
    const slowProduct = product({
      id: slowCoordinate,
      pubkey: slowMerchant,
      title: "Slow product",
      createdAt: 104_000,
      updatedAt: 104_000,
    })
    const slowRecovery = productRead({
      product: slowProduct,
      eventId: "5".repeat(64),
      eventCreatedAt: 104,
    })
    const eventFinal = deferred<void>()
    const broadFinal = deferred<void>()
    let productReads = 0
    const productTargets: string[][] = []

    __setEventCatalogAdapterTestOverrides({
      getCachedProductsByIds: async () => ({
        data: [],
        meta: { ...broadResult.meta, source: "local_cache", stale: true },
      }),
      getEventMarket: async (input) => {
        input.onProgress?.(resolution)
        await eventFinal.promise
        return resolution
      },
      getProductsByIds: async (coordinates, options = {}) => {
        productReads += 1
        productTargets.push([...coordinates])
        if (productReads === 1) {
          options.onAuthorSettled?.(broadResult)
          await broadFinal.promise
          return broadResult
        }
        return slowRecovery
      },
    })

    const snapshots: RawEventCatalog[] = []
    const loading = loadRawEventCatalog(collectionCoordinate, {
      onProgress: (snapshot) => snapshots.push(snapshot),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      snapshots.some((snapshot) =>
        snapshot.actionableProductCoordinates?.includes(productCoordinate)
      )
    ).toBe(true)
    expect(snapshots.at(-1)?.actionableProductCoordinates ?? []).not.toContain(
      slowCoordinate
    )
    expect(productReads).toBe(1)

    // Recovery waits until both broad reads have settled, then rechecks only
    // the final accepted set owned by the affected merchant.
    eventFinal.resolve(undefined)
    broadFinal.resolve(undefined)
    const completed = await loading
    expect(productReads).toBe(2)
    expect(productTargets[1]).toEqual([slowCoordinate])
    expect(
      completed.result?.data.map((record) => record.product.id).sort()
    ).toEqual([productCoordinate, slowCoordinate].sort())
    expect(
      completed.result?.diagnostics.find(
        (diagnostic) => diagnostic.productId === slowCoordinate
      )?.issue
    ).toBeNull()
  })

  it("shares a matching pending detail/card query and reprices without another read", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    let reads = 0
    const loader: typeof loadRawEventCatalog = async () => {
      reads++
      return pending.promise
    }
    const first = client.fetchQuery(
      eventCatalogQueryOptions(
        client,
        collectionCoordinate,
        scope,
        () => true,
        loader
      )
    )
    const second = client.fetchQuery(
      eventCatalogQueryOptions(
        client,
        encodeEventMarketNaddr(collectionCoordinate),
        scope,
        () => true,
        loader
      )
    )
    const snapshot = raw()
    snapshot.resolution!.pickup!.price = 5
    snapshot.resolution!.pickup!.currency = "USD"
    pending.resolve(snapshot)
    const [detail, card] = await Promise.all([first, second])
    expect(detail).toBe(card)
    expect(reads).toBe(1)
    const quoteA = projectRawEventCatalog(detail, 50_000)
    const quoteB = projectRawEventCatalog(detail, 100_000)
    expect(quoteA.products[0]?.pickupFulfillment?.costSats).toBe(10_000)
    expect(quoteB.products[0]?.pickupFulfillment?.costSats).toBe(5_000)
    const resolution = resolveProductCartFulfillmentFromCatalogs(
      product(),
      getProductEventMarketCandidates(product()).map((candidate) => ({
        candidate,
        catalog: quoteB,
      }))
    )
    expect(resolution.status).toBe("pickup")
    expect(reads).toBe(1)
    client.clear()
  })

  it("canonicalizes coordinate and naddr while separating relay hints, principal and auth generation", () => {
    const key = eventCatalogQueryIdentity(collectionCoordinate, scope).queryKey
    expect(
      eventCatalogQueryIdentity(
        encodeEventMarketNaddr(collectionCoordinate),
        scope
      ).queryKey
    ).toEqual(key)
    const hints = ["wss://nos.lol", "wss://relay.conduit.market"]
    expect(
      eventCatalogQueryIdentity(
        encodeEventMarketNaddr(collectionCoordinate, hints),
        scope
      ).queryKey
    ).toEqual(
      eventCatalogQueryIdentity(
        encodeEventMarketNaddr(collectionCoordinate, hints.toReversed()),
        scope
      ).queryKey
    )
    expect(
      eventCatalogQueryIdentity(
        encodeEventMarketNaddr(collectionCoordinate, hints),
        scope
      ).queryKey
    ).not.toEqual(key)
    for (const changed of [
      { ...scope, relayScope: "relay-b" },
      { ...scope, authenticatedPubkey: merchant },
      { ...scope, authGeneration: 2 },
    ]) {
      expect(
        eventCatalogQueryIdentity(collectionCoordinate, changed).queryKey
      ).not.toEqual(key)
    }
  })

  it("does not restart a resolved event read when the window regains focus", async () => {
    const client = new QueryClient()
    let reads = 0
    const observer = new QueryObserver(
      client,
      eventCatalogQueryOptions(
        client,
        collectionCoordinate,
        scope,
        () => true,
        async () => {
          reads++
          return raw()
        }
      )
    )
    const release = observer.subscribe(() => {})

    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(reads).toBe(1)

      client.getQueryCache().onFocus()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(reads).toBe(1)
      expect(observer.getCurrentResult().data?.complete).toBe(true)
    } finally {
      release()
      client.clear()
    }
  })

  it("shows organizer-only cached cards without inventing acceptance or pickup authority", () => {
    const resolution = market("stale")
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    const projected = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [commerceRecord(product())],
      complete: false,
    })
    expect(projected.collection?.title).toBe("Summer Market")
    expect(projected.products).toHaveLength(1)
    expect(projected.products[0]?.participation.accepted).toBe(false)
    expect(projected.products[0]?.pickupFulfillment).toBeNull()
    expect(projected.purchaseReady).toBe(false)
    expect(projected.acceptedProductCount).toBe(0)
    const withdrawn = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [commerceRecord(product({ collectionRefs: [] }))],
      complete: false,
    })
    expect(withdrawn.products).toHaveLength(0)
  })

  it("strips completed pickup authorization during refresh or after failure", () => {
    expect(
      projectRawEventCatalog(raw()).products[0]?.pickupFulfillment
    ).not.toBeNull()
    const projected = projectRawEventCatalog(raw(), null, false)
    expect(projected.products).toHaveLength(1)
    expect(projected.purchaseReady).toBe(false)
    expect(projected.products[0]?.participation.purchaseReady).toBe(false)
    expect(projected.products[0]?.pickupFulfillment).toBeNull()
  })

  it("keeps progressive authorization opt-in and preserves browse-only siblings", () => {
    const slowCoordinate = `30402:${"c".repeat(64)}:slow-product`
    const resolution = market("partial")
    resolution.organizerProductCoordinates = [productCoordinate, slowCoordinate]
    resolution.acceptedProductCoordinates = [productCoordinate, slowCoordinate]
    resolution.acceptedProductEvidence = [
      ...resolution.acceptedProductEvidence,
      {
        productCoordinate: slowCoordinate,
        eventId: "5".repeat(64),
        createdAt: 103_000,
        shippingOptionCoordinates: [pickupCoordinate],
        merchantPubkey: "c".repeat(64),
      },
    ]
    resolution.participationRequests.push({
      productCoordinate: slowCoordinate,
      merchantPubkey: "c".repeat(64),
    })
    const fastRecord = commerceRecord(product())
    const slowRecord = commerceRecord(
      product({
        id: slowCoordinate,
        pubkey: "c".repeat(64),
        title: "Slow product",
      }),
      { eventId: "5".repeat(64) }
    )
    const progressive: RawEventCatalog = {
      reference: collectionCoordinate,
      resolution,
      result: productRead(),
      previewRecords: [fastRecord, slowRecord],
      actionableProductCoordinates: [productCoordinate],
      complete: false,
    }

    const failClosed = projectRawEventCatalog(progressive)
    expect(failClosed.products.map((entry) => entry.product.id).sort()).toEqual(
      [productCoordinate, slowCoordinate].sort()
    )
    expect(failClosed.purchaseReady).toBe(false)
    expect(failClosed.products.every((entry) => !entry.pickupFulfillment)).toBe(
      true
    )

    const currentRun = projectRawEventCatalog(progressive, null, true)
    expect(currentRun.products.map((entry) => entry.product.id).sort()).toEqual(
      [productCoordinate, slowCoordinate].sort()
    )
    expect(
      currentRun.products.find(
        (entry) => entry.product.id === productCoordinate
      )?.pickupFulfillment
    ).not.toBeNull()
    expect(
      currentRun.products.find((entry) => entry.product.id === slowCoordinate)
        ?.pickupFulfillment
    ).toBeNull()
  })

  it("publishes a browse-only header before completion and retains no authority after failure", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    const loader: typeof loadRawEventCatalog = async (_reference, options) => {
      options?.onProgress?.({ ...raw(), complete: true })
      return pending.promise
    }
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      loader
    )
    const observer = new QueryObserver(client, options)
    const release = observer.subscribe(() => {})
    expect(observer.getCurrentResult().data?.complete).toBe(false)
    expect(
      projectRawEventCatalog(observer.getCurrentResult().data!).purchaseReady
    ).toBe(false)
    pending.reject(new Error("relay unavailable"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(observer.getCurrentResult().isError).toBe(true)
    expect(
      projectRawEventCatalog(observer.getCurrentResult().data!).purchaseReady
    ).toBe(false)
    release()
    client.clear()
  })

  it("does not restart the expensive catalog read when window focus returns", () => {
    const client = new QueryClient()
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true
    )

    expect(options.refetchOnWindowFocus).toBe(false)
    client.clear()
  })

  it("ignores late progress and rejects final results after the auth scope changes", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    let emit: ((snapshot: RawEventCatalog) => void) | undefined
    let active = true
    const loader: typeof loadRawEventCatalog = async (_reference, options) => {
      emit = options?.onProgress
      return pending.promise
    }
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => active,
      loader
    )
    const running = client.fetchQuery(options)
    active = false
    emit?.(raw())
    expect(client.getQueryData(options.queryKey)).toBeUndefined()
    pending.resolve(raw())
    await expect(running).rejects.toThrow("cancelled")
    expect(client.getQueryData(options.queryKey)).toBeUndefined()
    client.clear()
  })

  it("cancels the shared transport only after its last observer leaves", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    let signal: AbortSignal | undefined
    const loader: typeof loadRawEventCatalog = async (_reference, options) => {
      signal = options?.signal
      return pending.promise
    }
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      loader
    )
    const detail = new QueryObserver(client, options)
    const card = new QueryObserver(client, options)
    const stopDetail = detail.subscribe(() => {})
    const stopCard = card.subscribe(() => {})
    stopDetail()
    expect(signal?.aborted).toBe(false)
    stopCard()
    expect(signal?.aborted).toBe(true)
    pending.resolve(raw())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.getQueryData(options.queryKey)).toBeUndefined()
    client.clear()
  })

  it("does not carry interrupted partial authority into a remounted read", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const replacement = deferred<RawEventCatalog>()
    let reads = 0
    const loader: typeof loadRawEventCatalog = async (_reference, options) => {
      reads++
      if (reads === 1) {
        options?.onProgress?.({
          ...raw(),
          actionableProductCoordinates: [productCoordinate],
          complete: false,
        })
        await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true }
          )
        })
      }
      return replacement.promise
    }
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      loader
    )
    const first = new QueryObserver(client, options)
    const stopFirst = first.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      projectRawEventCatalog(
        client.getQueryData<RawEventCatalog>(options.queryKey)!,
        null,
        true
      ).purchaseReady
    ).toBe(true)

    stopFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = new QueryObserver(client, options)
    const stopSecond = second.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    const remounted = client.getQueryData<RawEventCatalog>(options.queryKey)!
    expect(reads).toBe(2)
    expect(remounted.complete).toBe(false)
    expect(remounted.actionableProductCoordinates ?? []).toEqual([])
    expect(projectRawEventCatalog(remounted, null, true).purchaseReady).toBe(
      false
    )

    replacement.resolve(raw())
    await new Promise((resolve) => setTimeout(resolve, 0))
    stopSecond()
    client.clear()
  })
  it("preserves a stale completed browse catalog and a hidden signed cache entry", () => {
    const resolution = market("stale")
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    const projected = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [commerceRecord(product({ visibility: "private" }))],
      complete: true,
    })
    expect(projected.products).toHaveLength(1)
    expect(projected.purchaseReady).toBe(false)
    expect(projected.productReadState).toBe("unavailable")
  })

  it("retains safe hidden family choices while excluding unsafe and organizer-unlisted children", () => {
    const parent = product({
      type: "variable",
      visibility: "private",
      images: [],
    })
    const child = (
      suffix: string,
      visibility: Product["visibility"] = "private"
    ) =>
      product({
        id: `30402:${merchant}:${suffix}`,
        type: "variation",
        visibility,
        parentProductId: parent.id,
        specifications: [{ key: "size", value: suffix }],
      })
    const good = child("good")
    const unsafe = child("unsafe", "public")
    const unlisted = child("unlisted", "public")
    const records = [parent, good, unsafe, unlisted].map((entry) =>
      commerceRecord(entry)
    )
    const prepared = prepareProductCatalog(records, {
      source: "local_cache",
      stale: true,
      degraded: true,
      capped: false,
      fetchedAt: 1,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected fixture family")
    const unsafeRecord = prepared.family.children.find(
      (entry) => entry.product.id === unsafe.id
    )!
    unsafeRecord.safety = {
      ...unsafeRecord.safety,
      state: "blocked",
      source: "external_decision",
    }
    const resolution = market("stale")
    resolution.organizerProductCoordinates = [parent.id, good.id, unsafe.id]
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    const rawFamily = { ...prepared.family.parent, family: prepared.family }
    const projected = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [rawFamily],
      complete: false,
    })
    expect(projected.products).toHaveLength(1)
    expect(
      projected.products[0]?.family?.children.map((entry) => entry.product.id)
    ).toEqual([good.id])
    expect(projected.products[0]?.pickupFulfillment).toBeNull()
    expect(projected.products[0]?.familyPickupFulfillments).toBeUndefined()
    expect(projected.unresolvedProductCoordinates).toEqual([unsafe.id])
    expect(projected.purchaseReady).toBe(false)

    // The same eligible child remains selectable when exact live acceptance
    // arrives; unsafe and organizer-unlisted children still stay excluded.
    const liveResolution = {
      ...resolution,
      state: "active" as const,
      acceptedProductCoordinates: [parent.id, good.id, unsafe.id],
      acceptedProductEvidence: records
        .filter((entry) => entry.product.id !== unlisted.id)
        .map((entry) => ({
          productCoordinate: entry.product.id,
          eventId: entry.eventId,
          createdAt: entry.eventCreatedAt * 1_000,
          shippingOptionCoordinates: [pickupCoordinate],
          merchantPubkey: merchant,
        })),
    }
    const result = productRead()
    result.data = [rawFamily, ...prepared.family.children]
    result.diagnostics = result.data.map((entry) => ({
      productId: entry.product.id,
      addressId: entry.product.id,
      issue: null,
      coverage: { listing: "complete", deletion: "complete" },
    }))
    const live = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution: liveResolution,
      result,
      complete: true,
    })
    expect(
      live.products[0]?.family?.children.map((entry) => entry.product.id)
    ).toEqual([good.id])
  })

  it("retains an atomic contextual child even when its parent is not organizer-listed", () => {
    const atomic = commerceRecord(
      product({
        id: `30402:${merchant}:atomic`,
        type: "variation",
        parentProductId: productCoordinate,
        specifications: [{ key: "size", value: "Atomic" }],
      })
    )
    atomic.safety = evaluateListingSafety(atomic.product, undefined, {
      variationGroupRole: "variation",
      hasGroupImage: true,
    })
    const resolution = market("stale")
    resolution.organizerProductCoordinates = [atomic.product.id]
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    const projected = projectRawEventCatalog({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [atomic],
      complete: false,
    })
    expect(projected.products.map((entry) => entry.product.id)).toEqual([
      atomic.product.id,
    ])
    expect(projected.products[0]?.pickupFulfillment).toBeNull()
  })
  it("waits for reconciled cache records before restoring cards and retracts stronger negative evidence", async () => {
    const client = new QueryClient()
    const pending = deferred<RawEventCatalog>()
    let emit: ((snapshot: RawEventCatalog) => void) | undefined
    const loader: typeof loadRawEventCatalog = async (_reference, options) => {
      emit = options?.onProgress
      return pending.promise
    }
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      loader
    )
    client.setQueryData(options.queryKey, raw())
    const refresh = client.fetchQuery(options)
    const resolution = market("stale")
    resolution.acceptedProductCoordinates = []
    resolution.acceptedProductEvidence = []
    emit?.({ reference: collectionCoordinate, resolution, complete: false })
    const header = projectRawEventCatalog(
      client.getQueryData(options.queryKey)!
    )
    expect(header.products).toHaveLength(0)
    expect(header.collection?.title).toBe("Summer Market")
    emit?.({
      reference: collectionCoordinate,
      resolution,
      previewRecords: [commerceRecord(product())],
      complete: false,
    })
    const retained = projectRawEventCatalog(
      client.getQueryData(options.queryKey)!
    )
    expect(retained.products).toHaveLength(1)
    expect(retained.purchaseReady).toBe(false)
    const withdrawn = {
      ...resolution,
      browseExcludedProductCoordinates: [productCoordinate],
    }
    emit?.({
      reference: collectionCoordinate,
      resolution: withdrawn,
      complete: false,
    })
    const removed = projectRawEventCatalog(
      client.getQueryData(options.queryKey)!
    )
    expect(removed.products).toHaveLength(0)
    expect(removed.unresolvedProductCoordinates).toHaveLength(0)
    pending.resolve({
      reference: collectionCoordinate,
      resolution: withdrawn,
      complete: true,
    })
    await refresh
    client.clear()
  })
  it("blocks an older shared catalog when the product surface observes a newer signed revision", () => {
    const current = projectRawEventCatalog(raw())
    const newer = product({ createdAt: 104_000, updatedAt: 104_000 })
    const candidates = getProductEventMarketCandidates(newer)
    const blocked = resolveProductCartFulfillmentFromCatalogs(
      newer,
      candidates.map((candidate) => ({ candidate, catalog: current }))
    )
    expect(blocked.status).toBe("blocked")
    if (blocked.status === "blocked")
      expect(blocked.reason).toContain("newer product revision")
    const refreshedRaw = raw()
    refreshedRaw.resolution!.acceptedProductEvidence[0]!.createdAt = 104_000
    refreshedRaw.result = productRead({ product: newer, eventCreatedAt: 104 })
    const refreshed = resolveProductCartFulfillmentFromCatalogs(
      newer,
      candidates.map((candidate) => ({
        candidate,
        catalog: projectRawEventCatalog(refreshedRaw),
      }))
    )
    expect(refreshed.status).toBe("pickup")
    expect(refreshed.product.createdAt).toBe(104_000)
  })
  it("reconciles equal-timestamp price and reference changes once without treating quote values as source changes", () => {
    const catalog = projectRawEventCatalog(raw())
    const attempted = new Set<string>()
    const changedPrice = product({ price: 9_000, priceSats: 9_000 })
    const changedRefs = product({
      shippingOptionRefs: [
        {
          coordinate: pickupCoordinate,
          extraCost: {
            amount: 500,
            currency: "SATS",
            normalizedCurrency: "SATS",
          },
        },
      ],
    })
    const changedCollections = product({
      collectionRefs: [collectionCoordinate, `30405:${organizer}:another`],
    })
    for (const changed of [changedPrice, changedRefs, changedCollections]) {
      expect(eventCatalogNeedsProductRefresh(changed, catalog)).toBe(true)
      const blocked = resolveProductCartFulfillmentFromCatalogs(
        changed,
        getProductEventMarketCandidates(changed).map((candidate) => ({
          candidate,
          catalog,
        }))
      )
      expect(blocked.status).toBe("blocked")
      expect(
        takeEventCatalogProductRefreshObservations(
          [changed],
          catalog,
          "account-a",
          attempted
        )
      ).toEqual([changed])
      expect(
        takeEventCatalogProductRefreshObservations(
          [changed],
          catalog,
          "account-a",
          attempted
        )
      ).toEqual([])
    }
    const converted = product({ priceSats: 987_654, shippingCostSats: 123_456 })
    expect(getEventCatalogProductSourceObservation(converted)).toBe(
      getEventCatalogProductSourceObservation(product())
    )
    expect(eventCatalogNeedsProductRefresh(converted, catalog)).toBe(false)
    expect(
      takeEventCatalogProductRefreshObservations(
        [converted],
        catalog,
        "account-a",
        attempted
      )
    ).toEqual([])
    expect(
      takeEventCatalogProductRefreshObservations(
        [changedPrice],
        catalog,
        "account-b",
        attempted
      )
    ).toEqual([changedPrice])
    const reconciled = raw()
    reconciled.result = productRead({ product: changedPrice })
    const settled = projectRawEventCatalog(reconciled)
    expect(eventCatalogNeedsProductRefresh(changedPrice, settled)).toBe(false)
    expect(
      resolveProductCartFulfillmentFromCatalogs(
        changedPrice,
        getProductEventMarketCandidates(changedPrice).map((candidate) => ({
          candidate,
          catalog: settled,
        }))
      ).status
    ).toBe("pickup")
  })

  it("rereads an absent product once per scoped source observation and never grants stale pickup", async () => {
    const client = new QueryClient()
    const absent = raw()
    absent.result = productRead({ includeRecord: false })
    const attempted = new Set<string>()
    let reads = 0
    const options = eventCatalogQueryOptions(
      client,
      collectionCoordinate,
      scope,
      () => true,
      async () => {
        reads++
        return absent
      }
    )
    client.setQueryData(options.queryKey, absent)
    for (let render = 0; render < 3; render++) {
      const catalog = projectRawEventCatalog(
        client.getQueryData(options.queryKey)!
      )
      const pending = takeEventCatalogProductRefreshObservations(
        [product()],
        catalog,
        "account-a",
        attempted
      )
      if (pending.length > 0) await client.fetchQuery(options)
      expect(
        resolveProductCartFulfillmentFromCatalogs(
          product(),
          getProductEventMarketCandidates(product()).map((candidate) => ({
            candidate,
            catalog,
          }))
        ).status
      ).toBe("blocked")
    }
    expect(reads).toBe(1)
    const changed = product({ stock: 4 })
    expect(
      takeEventCatalogProductRefreshObservations(
        [changed],
        projectRawEventCatalog(absent),
        "account-a",
        attempted
      )
    ).toEqual([changed])
    expect(
      takeEventCatalogProductRefreshObservations(
        [changed],
        projectRawEventCatalog(absent),
        "account-a",
        attempted
      )
    ).toEqual([])
    client.clear()
  })

  it("accepts a newer authoritative catalog revision without refreshing for an older source observation", () => {
    const newerProduct = product({
      price: 5_000,
      priceSats: 5_000,
      createdAt: 104_000,
      updatedAt: 104_000,
    })
    const newer = raw()
    newer.resolution!.acceptedProductEvidence[0]!.createdAt = 104_000
    newer.result = productRead({ product: newerProduct, eventCreatedAt: 104 })
    const catalog = projectRawEventCatalog(newer)
    expect(eventCatalogNeedsProductRefresh(product(), catalog)).toBe(false)
    expect(
      takeEventCatalogProductRefreshObservations(
        [product()],
        catalog,
        "account-a",
        new Set()
      )
    ).toEqual([])
    const resolution = resolveProductCartFulfillmentFromCatalogs(
      product(),
      getProductEventMarketCandidates(product()).map((candidate) => ({
        candidate,
        catalog,
      }))
    )
    expect(resolution.status).toBe("pickup")
    expect(resolution.product.price).toBe(5_000)
    expect(resolution.product.createdAt).toBe(104_000)
  })

  it("compares folded children against exact child terms and never borrows parent authorization", () => {
    const parent = product({ type: "variable" })
    const child = product({
      id: `30402:${merchant}:child`,
      type: "variation",
      parentProductId: parent.id,
      specifications: [{ key: "Size", value: "Small" }],
    })
    const records = [commerceRecord(parent), commerceRecord(child)]
    const prepared = prepareProductCatalog(records, {
      source: "commerce",
      stale: false,
      degraded: false,
      capped: false,
      fetchedAt: 1,
    }).items[0]
    if (prepared?.kind !== "family") throw new Error("Expected fixture family")
    const snapshot = raw()
    snapshot.resolution!.organizerProductCoordinates = [parent.id, child.id]
    snapshot.resolution!.acceptedProductCoordinates = [parent.id, child.id]
    snapshot.resolution!.acceptedProductEvidence.push({
      ...snapshot.resolution!.acceptedProductEvidence[0]!,
      productCoordinate: child.id,
    })
    snapshot.result!.data = [
      { ...prepared.family.parent, family: prepared.family },
      ...prepared.family.children,
    ]
    snapshot.result!.diagnostics = snapshot.result!.data.map((record) => ({
      productId: record.product.id,
      addressId: record.product.id,
      issue: null,
      coverage: { listing: "complete", deletion: "complete" },
    }))
    const catalog = projectRawEventCatalog(snapshot)
    const resolve = (candidateProduct: Product) =>
      resolveProductCartFulfillmentFromCatalogs(
        candidateProduct,
        getProductEventMarketCandidates(candidateProduct).map((candidate) => ({
          candidate,
          catalog,
        }))
      )
    expect(catalog.products).toHaveLength(1)
    expect(eventCatalogNeedsProductRefresh(child, catalog)).toBe(false)
    expect(resolve(child).status).toBe("pickup")
    const changed = { ...child, price: 9_000, priceSats: 9_000 }
    expect(eventCatalogNeedsProductRefresh(changed, catalog)).toBe(true)
    expect(resolve(changed).status).toBe("blocked")
    const attempted = new Set<string>()
    expect(
      takeEventCatalogProductRefreshObservations(
        [changed],
        catalog,
        "account-a",
        attempted
      )
    ).toEqual([changed])
    expect(
      takeEventCatalogProductRefreshObservations(
        [changed],
        catalog,
        "account-a",
        attempted
      )
    ).toEqual([])
    catalog.products[0]!.familyPickupFulfillments![child.id] = null
    expect(resolve(child).status).toBe("blocked")
  })
})

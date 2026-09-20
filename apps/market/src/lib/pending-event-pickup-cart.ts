import {
  compareReplaceableEventFrontiers,
  getProductsByIds,
  type PricingRateInput,
  type Product,
  type ProductAvailabilityIssue,
} from "@conduit/core"
import {
  getPendingEventPickupCartItems,
  type CartEventPickupUpgradeInput,
  type CartItem,
  type CartItemIdentity,
  type PendingEventPickupCartItem,
} from "./cart-model"
import {
  eventCatalogNeedsProductRefresh,
  getProductEventMarketCandidates,
  loadRawEventCatalog,
  projectRawEventCatalog,
  resolveProductCartFulfillmentFromCatalogs,
  type EventCatalog,
  type ProductEventMarketCandidate,
} from "./event-market-adapter"
import { cartItemInputFromProductSelection } from "./productVariations"

export type PendingEventPickupCartUpgrade = {
  identity: CartItemIdentity & { cartLineId: string }
  item: CartEventPickupUpgradeInput
}

export type PendingEventPickupCartResolution = {
  upgrades: PendingEventPickupCartUpgrade[]
  /** At least one unresolved line may gain stronger evidence on a later read. */
  retryable: boolean
}

type PreparedSelection = {
  root: Product
  selected: Product
}

type SelectedCatalogRead = {
  candidate: ProductEventMarketCandidate
  productIds: Set<string>
}

type PendingEventPickupCatalogReadOptions = {
  selectedProductCoordinates: readonly string[]
  authenticatedPubkey?: string | null
  shouldContinue: () => boolean
  signal?: AbortSignal
}

export type PendingEventPickupCartDependencies = {
  getProductsByIds: typeof getProductsByIds
  loadCatalog: (
    reference: string,
    rateInput: PricingRateInput,
    options: PendingEventPickupCatalogReadOptions
  ) => Promise<EventCatalog>
}

const DEFAULT_DEPENDENCIES: PendingEventPickupCartDependencies = {
  getProductsByIds,
  async loadCatalog(reference, rateInput, options) {
    const raw = await loadRawEventCatalog(reference, options)
    return projectRawEventCatalog(raw, rateInput)
  },
}

const RETRYABLE_PRODUCT_ISSUES = new Set<ProductAvailabilityIssue>([
  "lookup_unavailable",
  "lookup_partial",
  // Completed configured-relay absence is not a signed withdrawal. Keep the
  // retry bounded, but allow a late listing to provide positive evidence.
  "product_missing",
  "cached_only",
  "pending",
])

function catalogResolutionMayAdvance(
  product: Product,
  catalog: EventCatalog
): boolean {
  if (
    ["ended", "deleted", "malformed", "conflicting", "unsupported"].includes(
      catalog.state
    )
  ) {
    return false
  }
  return (
    ["unavailable", "partial", "stale", "missing"].includes(catalog.state) ||
    catalog.productReadState !== "ready" ||
    eventCatalogNeedsProductRefresh(product, catalog)
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function compareProductSignedRevision(
  product: Product,
  pendingItem: PendingEventPickupCartItem
): -1 | 0 | 1 | undefined {
  if (!Number.isSafeInteger(product.updatedAt) || !product.sourceEventId) {
    return undefined
  }
  return compareReplaceableEventFrontiers(
    {
      createdAt: product.updatedAt,
      eventId: product.sourceEventId,
    },
    {
      createdAt: pendingItem.productUpdatedAt,
      eventId: pendingItem.productEventId,
    }
  )
}

function productProvesCurrentSignedRevision(
  product: Product,
  pendingItem: PendingEventPickupCartItem
): boolean {
  const comparison = compareProductSignedRevision(product, pendingItem)
  return comparison !== undefined && comparison >= 0
}

/**
 * Resolve only the exact event coordinates represented by pending cart intent.
 * Unrelated merchants and products never participate in this read.
 */
export async function resolvePendingEventPickupCartUpgrades(
  items: readonly CartItem[],
  rateInput: PricingRateInput = null,
  options: {
    authenticatedPubkey?: string | null
    shouldContinue?: () => boolean
    signal?: AbortSignal
  } = {},
  dependencies: PendingEventPickupCartDependencies = DEFAULT_DEPENDENCIES
): Promise<PendingEventPickupCartResolution> {
  const pendingItems = getPendingEventPickupCartItems(items).filter(
    (item): item is PendingEventPickupCartItem & { cartLineId: string } =>
      !!item.cartLineId
  )
  if (pendingItems.length === 0) return { upgrades: [], retryable: false }

  const active = () =>
    !options.signal?.aborted && (options.shouldContinue?.() ?? true)
  const productIds = [...new Set(pendingItems.map((item) => item.productId))]
  const productResult = await dependencies.getProductsByIds(productIds, {
    includeMerchantHiddenProductIds: productIds,
    authenticatedPubkey: options.authenticatedPubkey,
    shouldContinue: active,
  })
  if (!active()) return { upgrades: [], retryable: false }

  const retryableProductIds = new Set(
    productResult.diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.issue !== null &&
          RETRYABLE_PRODUCT_ISSUES.has(diagnostic.issue)
      )
      .map((diagnostic) => diagnostic.productId)
  )

  const selections = new Map<string, PreparedSelection>()
  for (const record of productResult.data) {
    selections.set(record.product.id, {
      root: record.product,
      selected: record.product,
    })
    for (const child of record.family?.children ?? []) {
      selections.set(child.product.id, {
        root: record.product,
        selected: child.product,
      })
    }
  }

  const reads = new Map<string, SelectedCatalogRead>()
  const candidateByLineId = new Map<string, ProductEventMarketCandidate>()
  let retryable = false
  for (const item of pendingItems) {
    const selection = selections.get(item.productId)
    if (!selection) {
      retryable ||= retryableProductIds.has(item.productId)
      continue
    }
    if (compareProductSignedRevision(selection.selected, item) === -1) {
      retryable = true
      continue
    }
    const candidates = getProductEventMarketCandidates(
      selection.selected
    ).filter(
      (candidate) =>
        candidate.collectionCoordinate === item.fulfillment.collectionCoordinate
    )
    if (candidates.length !== 1) {
      if (
        retryableProductIds.has(item.productId) &&
        !productProvesCurrentSignedRevision(selection.selected, item)
      ) {
        retryable = true
      }
      continue
    }
    const candidate = candidates[0]!
    candidateByLineId.set(item.cartLineId, candidate)
    const read = reads.get(candidate.canonicalNaddr) ?? {
      candidate,
      productIds: new Set<string>(),
    }
    read.productIds.add(item.productId)
    reads.set(candidate.canonicalNaddr, read)
  }

  const readEntries = [...reads.entries()]
  const catalogOutcomes = await Promise.allSettled(
    readEntries.map(([reference, read]) =>
      dependencies.loadCatalog(reference, rateInput, {
        selectedProductCoordinates: [...read.productIds],
        authenticatedPubkey: options.authenticatedPubkey,
        shouldContinue: active,
        signal: options.signal,
      })
    )
  )
  const catalogs = new Map<string, EventCatalog>()
  for (const [index, outcome] of catalogOutcomes.entries()) {
    if (outcome.status === "fulfilled") {
      catalogs.set(readEntries[index]![0], outcome.value)
      continue
    }
    if (isAbortError(outcome.reason)) throw outcome.reason
    retryable = true
  }
  if (!active()) return { upgrades: [], retryable: false }

  const upgrades = pendingItems.flatMap((pendingItem) => {
    const selection = selections.get(pendingItem.productId)
    const candidate = candidateByLineId.get(pendingItem.cartLineId)
    const catalog = candidate
      ? catalogs.get(candidate.canonicalNaddr)
      : undefined
    if (!selection || !candidate || !catalog) return []

    const resolution = resolveProductCartFulfillmentFromCatalogs(
      selection.selected,
      [{ candidate, catalog }]
    )
    if (
      resolution.status !== "pickup" ||
      !Number.isSafeInteger(resolution.product.updatedAt) ||
      !resolution.product.sourceEventId
    ) {
      retryable ||= catalogResolutionMayAdvance(selection.selected, catalog)
      return []
    }

    const snapshot = cartItemInputFromProductSelection(
      selection.root,
      resolution.product,
      resolution.fulfillment
    )
    const item: CartEventPickupUpgradeInput = {
      ...snapshot,
      fulfillment: resolution.fulfillment,
      productUpdatedAt: resolution.product.updatedAt,
      productEventId: resolution.product.sourceEventId,
    }
    return [
      {
        identity: {
          cartLineId: pendingItem.cartLineId,
          merchantPubkey: pendingItem.merchantPubkey,
          productId: pendingItem.productId,
        },
        item,
      },
    ]
  })

  return { upgrades, retryable }
}

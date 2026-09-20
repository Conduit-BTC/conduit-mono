import {
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
  } = {}
): Promise<PendingEventPickupCartResolution> {
  const pendingItems = getPendingEventPickupCartItems(items).filter(
    (item): item is PendingEventPickupCartItem & { cartLineId: string } =>
      !!item.cartLineId
  )
  if (pendingItems.length === 0) return { upgrades: [], retryable: false }

  const active = () =>
    !options.signal?.aborted && (options.shouldContinue?.() ?? true)
  const productIds = [...new Set(pendingItems.map((item) => item.productId))]
  const productResult = await getProductsByIds(productIds, {
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
    const candidates = getProductEventMarketCandidates(
      selection.selected
    ).filter(
      (candidate) =>
        candidate.collectionCoordinate === item.fulfillment.collectionCoordinate
    )
    if (candidates.length !== 1) continue
    const candidate = candidates[0]!
    candidateByLineId.set(item.cartLineId, candidate)
    const read = reads.get(candidate.canonicalNaddr) ?? {
      candidate,
      productIds: new Set<string>(),
    }
    read.productIds.add(item.productId)
    reads.set(candidate.canonicalNaddr, read)
  }

  const catalogs = new Map(
    await Promise.all(
      [...reads.entries()].map(async ([reference, read]) => {
        const raw = await loadRawEventCatalog(reference, {
          selectedProductCoordinates: [...read.productIds],
          authenticatedPubkey: options.authenticatedPubkey,
          shouldContinue: active,
          signal: options.signal,
        })
        return [reference, projectRawEventCatalog(raw, rateInput)] as const
      })
    )
  )
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

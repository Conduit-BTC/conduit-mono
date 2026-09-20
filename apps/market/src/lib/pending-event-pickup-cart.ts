import {
  getProductsByIds,
  type PricingRateInput,
  type Product,
} from "@conduit/core"
import {
  getPendingEventPickupCartItems,
  type CartEventPickupUpgradeInput,
  type CartItem,
  type CartItemIdentity,
  type PendingEventPickupCartItem,
} from "./cart-model"
import {
  getProductEventMarketCandidates,
  loadRawEventCatalog,
  projectRawEventCatalog,
  resolveProductCartFulfillmentFromCatalogs,
  type ProductEventMarketCandidate,
} from "./event-market-adapter"
import { cartItemInputFromProductSelection } from "./productVariations"

export type PendingEventPickupCartUpgrade = {
  identity: CartItemIdentity & { cartLineId: string }
  item: CartEventPickupUpgradeInput
}

type PreparedSelection = {
  root: Product
  selected: Product
}

type SelectedCatalogRead = {
  candidate: ProductEventMarketCandidate
  productIds: Set<string>
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
): Promise<PendingEventPickupCartUpgrade[]> {
  const pendingItems = getPendingEventPickupCartItems(items).filter(
    (item): item is PendingEventPickupCartItem & { cartLineId: string } =>
      !!item.cartLineId
  )
  if (pendingItems.length === 0) return []

  const active = () =>
    !options.signal?.aborted && (options.shouldContinue?.() ?? true)
  const productIds = [...new Set(pendingItems.map((item) => item.productId))]
  const productResult = await getProductsByIds(productIds, {
    includeMerchantHiddenProductIds: productIds,
    authenticatedPubkey: options.authenticatedPubkey,
    shouldContinue: active,
  })
  if (!active()) return []

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
  for (const item of pendingItems) {
    const selection = selections.get(item.productId)
    if (!selection) continue
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
  if (!active()) return []

  return pendingItems.flatMap((pendingItem) => {
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
}

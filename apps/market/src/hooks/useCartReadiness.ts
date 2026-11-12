import { useLayoutEffect, useMemo, useRef } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import {
  fetchLnurlPayMetadata,
  getProductsByIds,
  isValidLud16Address,
  useAuth,
  useConduitSession,
} from "@conduit/core"
import {
  CART_READINESS_LEASE_MS,
  CART_READINESS_MAX_CONCURRENT_READS,
  LNURL_METADATA_LEASE_MS,
  LNURL_PREFLIGHT_TIMEOUT_MS,
  createBoundedLimiter,
  deriveMerchantCartReadinessState,
  type MerchantCartReadinessState,
  type MerchantLnurlPreflight,
} from "../lib/cart-readiness"
import {
  getCartAvailabilityBlockingMessage,
  getCartAvailabilityReadDecision,
  getCartProductAvailability,
  groupCartPurchases,
  isCartAvailabilityReadComplete,
  type CartItem,
  type CartAvailabilityReadDecision,
  type CartProductAvailability,
} from "../lib/cart-model"

type CommerceReadResult = Awaited<ReturnType<typeof getProductsByIds>>
type PreparedProduct = CommerceReadResult["data"][number]["product"]

export type MerchantCartRefreshResult = {
  availability: CartProductAvailability[]
  products: PreparedProduct[]
  decision: CartAvailabilityReadDecision
}

export type MerchantCartReadiness = {
  merchantPubkey: string
  state: MerchantCartReadinessState
  availabilityByProductId: ReadonlyMap<string, CartProductAvailability>
  products: PreparedProduct[]
  readDecision: CartAvailabilityReadDecision
  /** Initial read with no usable evidence yet. */
  isChecking: boolean
  /** Nonblocking background revalidation while evidence stays actionable. */
  isRefreshing: boolean
  blockingMessage: string | null
  hasInsufficientStockItems: boolean
  hasUnavailableItems: boolean
  refresh: () => Promise<MerchantCartRefreshResult>
}

export type CartReadiness = {
  byPurchase: ReadonlyMap<string, MerchantCartReadiness>
  hasUnavailableItems: boolean
  hasInsufficientStockItems: boolean
  /** True while any purchase is still in its initial no-evidence read. */
  anyChecking: boolean
  refreshAll: () => Promise<MerchantCartRefreshResult[]>
}

const readinessReadLimiter = createBoundedLimiter(
  CART_READINESS_MAX_CONCURRENT_READS
)
const lnurlPreflightLimiter = createBoundedLimiter(
  CART_READINESS_MAX_CONCURRENT_READS
)

export function merchantCartAvailabilityQueryKey(
  merchantPubkey: string,
  productIds: readonly string[],
  merchantHiddenProductIds: readonly string[] = [],
  relayScope?: string | null,
  lifecycleKey?: string
): readonly unknown[] {
  return [
    "merchant-cart-availability",
    merchantPubkey,
    productIds,
    merchantHiddenProductIds,
    ...(relayScope ? [relayScope] : []),
    ...(lifecycleKey ? ["lifecycle", lifecycleKey] : []),
  ]
}

export function getCartMerchantHiddenProductIds(
  items: readonly CartItem[]
): string[] {
  return Array.from(
    new Set(
      items
        .filter((item) => item.fulfillment?.type === "event_market_pickup")
        .map((item) => item.productId)
    )
  ).sort()
}

export type CartAvailabilityReadScope = {
  purchaseId: string
  merchantPubkey: string
  productIds: string[]
  merchantHiddenProductIds: string[]
}

export function getCartAvailabilityReadScopes(
  items: CartItem[]
): CartAvailabilityReadScope[] {
  return groupCartPurchases(items).map((group) => ({
    purchaseId: group.id,
    merchantPubkey: group.merchantPubkey,
    productIds: Array.from(
      new Set(group.items.map((item) => item.productId))
    ).sort(),
    merchantHiddenProductIds: getCartMerchantHiddenProductIds(group.items),
  }))
}

/**
 * Per-purchase prepared cart readiness.
 *
 * The network fetch is keyed by merchant pubkey, the sorted full product
 * coordinates, and the exact event-pickup coordinates allowed to use the
 * merchant-hidden exception. Quantities, shipping, totals, wallet state, and
 * authorization fingerprints never invalidate the fetch; they are evaluated
 * locally against the prepared stock in the derived layer. The purchase scope
 * is deliberate: a pickup purchase may admit an exact merchant-hidden listing,
 * while a delivery purchase for the same coordinate must still observe the
 * ordinary listing filter. Each purchase resolves independently.
 */
export function useCartReadiness(
  items: CartItem[],
  options: {
    enabled?: boolean
    shouldContinue?: () => boolean
    lifecycleKey?: string
  } = {}
): CartReadiness {
  const enabled = options.enabled ?? true
  const enabledRef = useRef(enabled)
  const continueRef = useRef(options.shouldContinue)
  useLayoutEffect(() => {
    enabledRef.current = enabled
    continueRef.current = options.shouldContinue
  }, [enabled, options.shouldContinue])
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const purchaseGroups = useMemo(
    () => (enabled ? groupCartPurchases(items) : []),
    [items, enabled]
  )
  const readScopes = useMemo(
    () => (enabled ? getCartAvailabilityReadScopes(items) : []),
    [items, enabled]
  )
  const queries = useQueries({
    queries: readScopes.map((scope) => {
      const readAuthGeneration = authGeneration
      return {
        queryKey: merchantCartAvailabilityQueryKey(
          scope.merchantPubkey,
          scope.productIds,
          scope.merchantHiddenProductIds,
          session.relayScope,
          options.lifecycleKey
        ),
        queryFn: (context: { signal: AbortSignal }) => {
          const signal =
            options.enabled !== undefined || options.shouldContinue
              ? context.signal
              : undefined
          return readinessReadLimiter(() =>
            getProductsByIds(scope.productIds, {
              signal,
              includeMerchantHiddenProductIds: scope.merchantHiddenProductIds,
              authenticatedPubkey,
              shouldContinue: () =>
                enabledRef.current &&
                continueRef.current?.() !== false &&
                !signal?.aborted &&
                authGenerationRef.current === readAuthGeneration,
            })
          )
        },
        enabled: scope.productIds.length > 0,
        staleTime: CART_READINESS_LEASE_MS,
        gcTime: 5 * 60_000,
      }
    }),
  })

  return useMemo(() => {
    const byPurchase = new Map<string, MerchantCartReadiness>()
    for (const [index, group] of purchaseGroups.entries()) {
      const query = queries[index]
      if (!query) continue
      const products = query.data?.data.map((record) => record.product) ?? []
      const availability = getCartProductAvailability(group.items, products)
      const availabilityByProductId = new Map(
        availability.map((entry) => [entry.productId, entry])
      )
      const productIds = Array.from(
        new Set(group.items.map((item) => item.productId))
      ).sort()
      const productIdSet = new Set(productIds)
      const diagnostics = (query.data?.diagnostics ?? []).filter((diagnostic) =>
        productIdSet.has(diagnostic.productId)
      )
      const readDecision = getCartAvailabilityReadDecision({
        productIds,
        availability,
        meta: query.data?.meta,
        diagnostics,
        querySucceeded: query.isSuccess,
      })
      const fresh = isCartAvailabilityReadComplete(readDecision)
      const hasEvidence = query.data !== undefined
      const blockingMessage = hasEvidence
        ? getCartAvailabilityBlockingMessage(
            group.items,
            availabilityByProductId
          )
        : null
      const hasInsufficientStockItems = availability.some(
        (entry) => entry.status === "insufficient_stock"
      )
      const hasUnavailableItems = Boolean(blockingMessage)
      const state = deriveMerchantCartReadinessState({
        enabled: group.items.length > 0,
        hasEvidence,
        initialLoading: query.isLoading,
        backgroundRefreshing: query.isFetching && hasEvidence,
        fresh,
        blocked: hasUnavailableItems,
        evidenceAgeMs: hasEvidence ? Date.now() - query.dataUpdatedAt : null,
      })
      const refresh = async (): Promise<MerchantCartRefreshResult> => {
        const result = await query.refetch()
        const commerceResult = result.isSuccess ? result.data : undefined
        const refreshedProducts =
          commerceResult?.data
            .map((record) => record.product)
            .filter((product) => productIdSet.has(product.id)) ?? []
        const refreshedAvailability = getCartProductAvailability(
          group.items,
          refreshedProducts
        )
        const refreshedDiagnostics = (commerceResult?.diagnostics ?? []).filter(
          (diagnostic) => productIdSet.has(diagnostic.productId)
        )
        return {
          availability: refreshedAvailability,
          products: refreshedProducts,
          decision: getCartAvailabilityReadDecision({
            productIds,
            availability: refreshedAvailability,
            meta: commerceResult?.meta,
            diagnostics: refreshedDiagnostics,
            querySucceeded: result.isSuccess,
          }),
        }
      }
      byPurchase.set(group.id, {
        merchantPubkey: group.merchantPubkey,
        state,
        availabilityByProductId,
        products,
        readDecision,
        isChecking: state === "checking",
        isRefreshing: state === "refreshing",
        blockingMessage,
        hasInsufficientStockItems,
        hasUnavailableItems,
        refresh,
      })
    }

    const entries = Array.from(byPurchase.values())
    return {
      byPurchase,
      hasUnavailableItems: entries.some((entry) => entry.hasUnavailableItems),
      hasInsufficientStockItems: entries.some(
        (entry) => entry.hasInsufficientStockItems
      ),
      anyChecking: entries.some((entry) => entry.isChecking),
      refreshAll: () => Promise.all(entries.map((entry) => entry.refresh())),
    }
  }, [purchaseGroups, queries])
}

export function merchantLnurlPreflightQueryKey(
  normalizedLud16: string | null
): readonly unknown[] {
  return ["merchant-lnurl-pay-metadata", normalizedLud16]
}

export function normalizeMerchantLnurlAddress(
  lud16: string | null | undefined
): string | null {
  const normalized = lud16?.trim().toLowerCase() ?? null
  return normalized && isValidLud16Address(normalized) ? normalized : null
}

/**
 * Single owner of the LNURL-pay metadata query: key, request, and freshness
 * lease. Background surfaces bound their requests and retry once; the payment
 * path reuses the same cache entry with a direct request and no retry.
 */
export function merchantLnurlPreflightQueryOptions(
  normalizedLud16: string | null,
  options: {
    bounded?: boolean
    retry?: number | boolean
    shouldContinue?: () => boolean
    lifecycleKey?: string
  } = {}
) {
  const bounded = options.bounded ?? true
  const request = (context?: { signal?: AbortSignal }) => {
    const signal = options.shouldContinue ? context?.signal : undefined
    const fetchMetadata = () => {
      if (
        options.shouldContinue &&
        (signal?.aborted || !options.shouldContinue())
      )
        throw new DOMException("Read canceled", "AbortError")
      return fetchLnurlPayMetadata(
        normalizedLud16 as string,
        bounded ? { timeoutMs: LNURL_PREFLIGHT_TIMEOUT_MS } : undefined
      )
    }
    return bounded ? lnurlPreflightLimiter(fetchMetadata) : fetchMetadata()
  }
  return {
    queryKey: [
      ...merchantLnurlPreflightQueryKey(normalizedLud16),
      ...(options.lifecycleKey ? ["lifecycle", options.lifecycleKey] : []),
    ],
    queryFn: request,
    staleTime: LNURL_METADATA_LEASE_MS,
    gcTime: 5 * 60_000,
    retry: options.retry ?? 1,
  }
}

/**
 * Background LNURL-pay metadata preflight for a merchant with items in the
 * cart. Cart presence is sufficient shopper intent for this capability read.
 * The request carries no address, cart contents, invoice, order, buyer
 * identifier, or payment data; invoices are only requested after an explicit
 * payment action. Keyed by the normalized Lightning address, so an address
 * change refetches and every surface shares one request/result. A slow or
 * failed endpoint is isolated by timeout and only affects its own merchant.
 */
export function useMerchantLnurlPreflight(
  lud16: string | null | undefined,
  options: {
    enabled?: boolean
    shouldContinue?: () => boolean
    lifecycleKey?: string
  } = {}
): MerchantLnurlPreflight {
  const normalized = normalizeMerchantLnurlAddress(lud16)
  const enabled = Boolean(normalized) && (options.enabled ?? true)
  const query = useQuery({
    ...merchantLnurlPreflightQueryOptions(normalized, {
      shouldContinue: options.shouldContinue,
      lifecycleKey: options.lifecycleKey,
    }),
    enabled,
  })

  if (!normalized) {
    return { status: "no_address", metadata: null }
  }
  if (query.data) {
    return { status: "ready", metadata: query.data }
  }
  if (!enabled || query.isLoading || query.isFetching) {
    return { status: "pending", metadata: null }
  }
  return { status: "unavailable", metadata: null }
}

/**
 * Warms LNURL metadata for every merchant currently in the cart. Consumers
 * read the same query keys per merchant.
 */
export function useCartLnurlPreflights(
  lud16ByMerchant: ReadonlyMap<string, string | undefined>,
  options: { shouldContinue?: () => boolean; lifecycleKey?: string } = {}
): void {
  const normalizedAddresses = useMemo(
    () =>
      Array.from(
        new Set(
          Array.from(lud16ByMerchant.values())
            .map((lud16) => normalizeMerchantLnurlAddress(lud16))
            .filter((value): value is string => value !== null)
        )
      ).sort(),
    [lud16ByMerchant]
  )
  useQueries({
    queries: normalizedAddresses.map((address) =>
      merchantLnurlPreflightQueryOptions(address, options)
    ),
  })
}

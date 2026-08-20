import { useMemo } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import {
  fetchLnurlPayMetadata,
  getProductsByIds,
  isValidLud16Address,
  type ProductAvailabilityDiagnostic,
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
  groupCartItems,
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
  fresh: boolean
  diagnostics: ProductAvailabilityDiagnostic[]
  decision: CartAvailabilityReadDecision
}

export type MerchantCartReadiness = {
  merchantPubkey: string
  state: MerchantCartReadinessState
  availabilityByProductId: ReadonlyMap<string, CartProductAvailability>
  products: PreparedProduct[]
  fresh: boolean
  readDecision: CartAvailabilityReadDecision
  /** Initial read with no usable evidence yet. */
  isChecking: boolean
  /** Nonblocking background revalidation while evidence stays actionable. */
  isRefreshing: boolean
  blockingMessage: string | null
  hasInsufficientStockItems: boolean
  hasUnavailableItems: boolean
  diagnostics: ProductAvailabilityDiagnostic[]
  refresh: () => Promise<MerchantCartRefreshResult>
}

export type CartReadiness = {
  byMerchant: ReadonlyMap<string, MerchantCartReadiness>
  hasUnavailableItems: boolean
  hasInsufficientStockItems: boolean
  /** True while any merchant is still in its initial no-evidence read. */
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
  productIds: readonly string[]
): readonly unknown[] {
  return ["merchant-cart-availability", merchantPubkey, productIds]
}

/**
 * Per-merchant prepared cart readiness.
 *
 * The network fetch is keyed by merchant pubkey plus the sorted full product
 * coordinates only. Quantities, shipping, totals, wallet state, and
 * authorization fingerprints never invalidate the fetch; they are evaluated
 * locally against the prepared stock in the derived layer. Each merchant
 * resolves independently: a slow merchant/relay stays `checking` or
 * `refreshing` without holding other merchants behind a global barrier.
 */
export function useCartReadiness(items: CartItem[]): CartReadiness {
  const groups = useMemo(() => groupCartItems(items), [items])
  const queries = useQueries({
    queries: groups.map((group) => {
      const productIds = Array.from(
        new Set(group.items.map((item) => item.productId))
      ).sort()
      return {
        queryKey: merchantCartAvailabilityQueryKey(
          group.merchantPubkey,
          productIds
        ),
        queryFn: () => readinessReadLimiter(() => getProductsByIds(productIds)),
        enabled: productIds.length > 0,
        staleTime: CART_READINESS_LEASE_MS,
        gcTime: 5 * 60_000,
      }
    }),
  })

  return useMemo(() => {
    const byMerchant = new Map<string, MerchantCartReadiness>()
    for (const [index, group] of groups.entries()) {
      const query = queries[index]
      if (!query) continue
      const records = query.data?.data
      const products = records?.map((record) => record.product) ?? []
      const availability = getCartProductAvailability(group.items, products)
      const availabilityByProductId = new Map(
        availability.map((entry) => [entry.productId, entry])
      )
      const diagnostics = query.data?.diagnostics ?? []
      const hasEvidence = query.data !== undefined
      const productIds = Array.from(
        new Set(group.items.map((item) => item.productId))
      ).sort()
      const readDecision = getCartAvailabilityReadDecision({
        productIds,
        availability,
        meta: query.data?.meta,
        diagnostics,
        querySucceeded: query.isSuccess,
      })
      const fresh = isCartAvailabilityReadComplete(readDecision)
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
          commerceResult?.data.map((record) => record.product) ?? []
        const refreshedAvailability = getCartProductAvailability(
          group.items,
          refreshedProducts
        )
        const refreshedDiagnostics = commerceResult?.diagnostics ?? []
        const decision = getCartAvailabilityReadDecision({
          productIds,
          availability: refreshedAvailability,
          meta: commerceResult?.meta,
          diagnostics: refreshedDiagnostics,
          querySucceeded: result.isSuccess,
        })
        return {
          availability: refreshedAvailability,
          products: refreshedProducts,
          fresh: isCartAvailabilityReadComplete(decision),
          diagnostics: refreshedDiagnostics,
          decision,
        }
      }
      byMerchant.set(group.merchantPubkey, {
        merchantPubkey: group.merchantPubkey,
        state,
        availabilityByProductId,
        products,
        fresh,
        readDecision,
        isChecking: state === "checking",
        isRefreshing: state === "refreshing",
        blockingMessage,
        hasInsufficientStockItems,
        hasUnavailableItems,
        diagnostics,
        refresh,
      })
    }

    const entries = Array.from(byMerchant.values())
    return {
      byMerchant,
      hasUnavailableItems: entries.some((entry) => entry.hasUnavailableItems),
      hasInsufficientStockItems: entries.some(
        (entry) => entry.hasInsufficientStockItems
      ),
      anyChecking: entries.some((entry) => entry.isChecking),
      refreshAll: () => Promise.all(entries.map((entry) => entry.refresh())),
    }
  }, [groups, queries])
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
  options: { bounded?: boolean; retry?: number | boolean } = {}
) {
  const bounded = options.bounded ?? true
  const request = () =>
    bounded
      ? lnurlPreflightLimiter(() =>
          fetchLnurlPayMetadata(normalizedLud16 as string, {
            timeoutMs: LNURL_PREFLIGHT_TIMEOUT_MS,
          })
        )
      : fetchLnurlPayMetadata(normalizedLud16 as string)
  return {
    queryKey: merchantLnurlPreflightQueryKey(normalizedLud16),
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
  options: { enabled?: boolean } = {}
): MerchantLnurlPreflight {
  const normalized = normalizeMerchantLnurlAddress(lud16)
  const enabled = Boolean(normalized) && (options.enabled ?? true)
  const query = useQuery({
    ...merchantLnurlPreflightQueryOptions(normalized),
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
  lud16ByMerchant: ReadonlyMap<string, string | undefined>
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
      merchantLnurlPreflightQueryOptions(address)
    ),
  })
}

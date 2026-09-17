import { useLayoutEffect, useMemo, useRef } from "react"
import { useQueries, useQuery, type QueryClient } from "@tanstack/react-query"
import {
  fetchLnurlPayMetadata,
  getProductsByIds,
  isValidLud16Address,
  resolveInboxDeclaration,
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
const orderRoutePreflightLimiter = createBoundedLimiter(
  CART_READINESS_MAX_CONCURRENT_READS
)
const merchantOrderRoutePreflightQueryPrefix = [
  "merchant-order-route-preflight",
] as const

export function merchantCartAvailabilityQueryKey(
  merchantPubkey: string,
  productIds: readonly string[],
  merchantHiddenProductIds: readonly string[] = [],
  relayScope?: string | null
): readonly unknown[] {
  return [
    "merchant-cart-availability",
    merchantPubkey,
    productIds,
    merchantHiddenProductIds,
    ...(relayScope ? [relayScope] : []),
  ]
}

export function getCartMerchantHiddenProductIds(
  items: readonly CartItem[]
): string[] {
  return Array.from(
    new Set(
      items
        .filter((item) => item.fulfillment?.type === "pickup")
        .map((item) => item.productId)
    )
  ).sort()
}

/**
 * Per-merchant prepared cart readiness.
 *
 * The network fetch is keyed by merchant pubkey, the sorted full product
 * coordinates, and the exact event-pickup coordinates allowed to use the
 * merchant-hidden exception. Quantities, shipping, totals, wallet state, and
 * authorization fingerprints never invalidate the fetch; they are evaluated
 * locally against the prepared stock in the derived layer. Each merchant
 * resolves independently: a slow merchant/relay stays `checking` or
 * `refreshing` without holding other merchants behind a global barrier.
 */
export function useCartReadiness(items: CartItem[]): CartReadiness {
  const session = useConduitSession()
  const { authGeneration } = useAuth()
  const authGenerationRef = useRef(authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = authGeneration
  }, [authGeneration])
  const authenticatedPubkey =
    session.mode === "signed_in" ? session.pubkey : null
  const groups = useMemo(() => groupCartItems(items), [items])
  const queries = useQueries({
    queries: groups.map((group) => {
      const productIds = Array.from(
        new Set(group.items.map((item) => item.productId))
      ).sort()
      const merchantHiddenProductIds = getCartMerchantHiddenProductIds(
        group.items
      )
      const readAuthGeneration = authGeneration
      return {
        queryKey: merchantCartAvailabilityQueryKey(
          group.merchantPubkey,
          productIds,
          merchantHiddenProductIds,
          session.relayScope
        ),
        queryFn: () =>
          readinessReadLimiter(() =>
            getProductsByIds(productIds, {
              includeMerchantHiddenProductIds: merchantHiddenProductIds,
              authenticatedPubkey,
              shouldContinue: () =>
                authGenerationRef.current === readAuthGeneration,
            })
          ),
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
          decision,
        }
      }
      byMerchant.set(group.merchantPubkey, {
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

export type MerchantOrderRoutePreflightOptions = {
  accountPubkey: string | null
  authenticatedPubkey: string | null
  relayScope?: string | null
  authGeneration: number
  bounded?: boolean
  shouldContinue?: () => boolean
}

function normalizeOrderRoutePreflightKeyPart(
  value: string | null | undefined,
  fallback: string
): string {
  return value?.trim().toLowerCase() || fallback
}

export function merchantOrderRoutePreflightQueryKey(
  merchantPubkey: string,
  options: Pick<
    MerchantOrderRoutePreflightOptions,
    "accountPubkey" | "authenticatedPubkey" | "relayScope" | "authGeneration"
  >
): readonly unknown[] {
  return [
    ...merchantOrderRoutePreflightQueryPrefix,
    normalizeOrderRoutePreflightKeyPart(merchantPubkey, "no-merchant"),
    normalizeOrderRoutePreflightKeyPart(options.accountPubkey, "guest"),
    normalizeOrderRoutePreflightKeyPart(options.authenticatedPubkey, "guest"),
    options.relayScope?.trim() || "no-relay-scope",
    options.authGeneration,
  ]
}

export function merchantOrderRoutePreflightQueryOptions(
  merchantPubkey: string,
  options: MerchantOrderRoutePreflightOptions
) {
  const normalizedMerchant = merchantPubkey.trim().toLowerCase()
  return {
    queryKey: merchantOrderRoutePreflightQueryKey(normalizedMerchant, options),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      const read = () =>
        resolveInboxDeclaration(normalizedMerchant, {
          requestingAccountPubkey: options.accountPubkey,
          authenticatedPubkey: options.authenticatedPubkey,
          freshnessMs: CART_READINESS_LEASE_MS,
          signal,
          shouldContinue: () =>
            !signal.aborted && (options.shouldContinue?.() ?? true),
        })
      return options.bounded === false
        ? read()
        : orderRoutePreflightLimiter(read)
    },
    staleTime: CART_READINESS_LEASE_MS,
    gcTime: 5 * 60_000,
    retry: false,
  }
}

/**
 * Starts a submit-time route warm without extending the foreground checkout
 * boundary. Failure stays advisory because the send path always performs the
 * final typed declaration resolution before it stages an immutable route.
 */
export function startMerchantOrderRoutePreflight(
  queryClient: Pick<QueryClient, "fetchQuery">,
  merchantPubkey: string,
  options: MerchantOrderRoutePreflightOptions
): void {
  void queryClient
    .fetchQuery({
      ...merchantOrderRoutePreflightQueryOptions(merchantPubkey, options),
      staleTime: 0,
    })
    .catch(() => undefined)
}

/**
 * Releases relay-read capacity held by speculative merchant route reads before
 * the authoritative send-time resolver runs. Completed signed evidence stays
 * in the Core cache; cancellation neither supplies nor removes send authority.
 */
export async function cancelMerchantOrderRoutePreflights(
  queryClient: Pick<QueryClient, "cancelQueries">
): Promise<void> {
  await queryClient.cancelQueries({
    queryKey: merchantOrderRoutePreflightQueryPrefix,
  })
}

/**
 * Warms typed kind-10050 evidence for merchants with cart intent. The read is
 * content-free: it carries only the public merchant key and current account
 * network authority. Checkout still re-resolves typed evidence before staging
 * an immutable delivery route.
 */
export function useCartOrderRoutePreflights(
  merchantPubkeys: readonly string[],
  options: { enabled?: boolean } = {}
): void {
  const auth = useAuth()
  const session = useConduitSession()
  const authGenerationRef = useRef(auth.authGeneration)
  useLayoutEffect(() => {
    authGenerationRef.current = auth.authGeneration
  }, [auth.authGeneration])
  const accountPubkey = session.mode === "signed_in" ? session.pubkey : null
  const authenticatedPubkey =
    auth.status === "connected" && auth.pubkey === accountPubkey
      ? accountPubkey
      : null
  const uniqueMerchantPubkeys = useMemo(
    () =>
      Array.from(
        new Set(
          merchantPubkeys
            .map((pubkey) => pubkey.trim().toLowerCase())
            .filter(Boolean)
        )
      ).sort(),
    [merchantPubkeys]
  )
  const readAuthGeneration = auth.authGeneration

  useQueries({
    queries: uniqueMerchantPubkeys.map((merchantPubkey) => ({
      ...merchantOrderRoutePreflightQueryOptions(merchantPubkey, {
        accountPubkey,
        authenticatedPubkey,
        relayScope: session.relayScope,
        authGeneration: readAuthGeneration,
        shouldContinue: () => authGenerationRef.current === readAuthGeneration,
      }),
      enabled: options.enabled ?? true,
    })),
  })
}

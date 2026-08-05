import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { getProductsByIds } from "@conduit/core"
import {
  getCartProductAvailability,
  isCartAvailabilityReadFresh,
  isCartProductAvailabilityBlocking,
  type CartItem,
  type CartProductAvailability,
} from "../lib/cart-model"

function getRefreshedAvailability(
  items: CartItem[],
  records: Awaited<ReturnType<typeof getProductsByIds>>["data"] | undefined
): CartProductAvailability[] {
  return getCartProductAvailability(
    items,
    records?.map((record) => record.product) ?? []
  )
}

export function useCartProductAvailability(items: CartItem[]) {
  const productIds = useMemo(
    () => Array.from(new Set(items.map((item) => item.productId))).sort(),
    [items]
  )
  const query = useQuery({
    queryKey: ["cart-product-availability", productIds],
    queryFn: () => getProductsByIds(productIds),
    enabled: productIds.length > 0,
    staleTime: 0,
    refetchOnMount: "always",
  })
  const availability = useMemo(
    () => getRefreshedAvailability(items, query.data?.data),
    [items, query.data?.data]
  )
  const availabilityByProductId = useMemo(
    () => new Map(availability.map((entry) => [entry.productId, entry])),
    [availability]
  )
  const hasInsufficientStockItems = availability.some(
    (entry) => entry.status === "insufficient_stock"
  )
  const hasUnavailableItems = availability.some(
    isCartProductAvailabilityBlocking
  )
  async function refresh(): Promise<{
    availability: CartProductAvailability[]
    fresh: boolean
  }> {
    const result = await query.refetch()
    const commerceResult = result.isSuccess ? result.data : undefined
    const refreshedAvailability = getRefreshedAvailability(
      items,
      commerceResult?.data
    )

    return {
      availability: refreshedAvailability,
      fresh: isCartAvailabilityReadFresh(
        refreshedAvailability,
        commerceResult?.meta
      ),
    }
  }

  return {
    availabilityByProductId,
    hasInsufficientStockItems,
    hasUnavailableItems,
    isChecking: query.isLoading || query.isFetching,
    refresh,
  }
}

import { type MerchantConversationSummary } from "@conduit/core"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useMemo } from "react"
import { projectCheckoutSparkOrderSettlements } from "../lib/checkout-spark-order-overlay"
import {
  checkoutSparkOrderSettlementQueryOptions,
  NO_CHECKOUT_SPARK_ORDER_BINDINGS,
} from "../lib/checkout-spark-order-query"

/** Local provider facts only: this hook never opens a wallet or reads a relay. */
export function useCheckoutSparkOrderSettlements({
  enabled,
  pubkey,
  authGeneration,
  isAuthGenerationCurrent,
  conversations,
}: {
  enabled: boolean
  pubkey: string | null
  authGeneration: number
  isAuthGenerationCurrent: (generation: number) => boolean
  conversations: readonly MerchantConversationSummary[]
}) {
  const queryClient = useQueryClient()
  const orderIds = useMemo(
    () => conversations.map(({ orderId }) => orderId),
    [conversations]
  )
  const options = checkoutSparkOrderSettlementQueryOptions({
    enabled,
    pubkey,
    authGeneration,
    isAuthGenerationCurrent,
    orderIds,
  })
  const active = options.enabled
  const query = useQuery(options)
  // Disabled queries can retain data. Never expose another session's facts
  // while signed out, gated off, or waiting for this session's local read.
  const bindings = active
    ? (query.data ?? NO_CHECKOUT_SPARK_ORDER_BINDINGS)
    : NO_CHECKOUT_SPARK_ORDER_BINDINGS
  const settlements = useMemo(
    () => projectCheckoutSparkOrderSettlements(conversations, bindings),
    [conversations, bindings]
  )
  const getOrderSettlement = useCallback(
    (conversation: MerchantConversationSummary) =>
      active && isAuthGenerationCurrent(authGeneration)
        ? (settlements.get(conversation.id) ?? null)
        : null,
    [active, authGeneration, isAuthGenerationCurrent, settlements]
  )
  const refresh = useCallback(() => {
    if (!active || !pubkey || !isAuthGenerationCurrent(authGeneration)) return
    void queryClient.invalidateQueries({
      queryKey: ["merchant-spark-order-settlements", pubkey, authGeneration],
    })
  }, [active, pubkey, authGeneration, isAuthGenerationCurrent, queryClient])

  return {
    bindings,
    getOrderSettlement,
    refresh,
    // Local-read presentation only. Missing data while loading is not an
    // invalid recipient or a change to the durable payment facts.
    isRefreshing: active && (query.isFetching || query.isPlaceholderData),
    unavailable: active && query.isError,
  }
}

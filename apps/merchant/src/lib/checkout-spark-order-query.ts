import { DexieCheckoutSparkSettledRepository } from "@conduit/core"
import type { MerchantOrderSettlementBinding } from "./checkout-spark-order-overlay"

export const NO_CHECKOUT_SPARK_ORDER_BINDINGS: readonly MerchantOrderSettlementBinding[] =
  []

type ReadBindings = (
  pubkey: string,
  orderIds: readonly string[]
) => Promise<readonly MerchantOrderSettlementBinding[]>

const readLocalBindings: ReadBindings = async (pubkey, orderIds) => {
  const repository = new DexieCheckoutSparkSettledRepository()
  const [financial, receivers] = await Promise.all([
    repository.loadMerchantOrderSettlements(pubkey, orderIds),
    repository.loadMerchantOrderRecipientSettlements(pubkey, orderIds),
  ])
  // Join only the same authenticated witness. Conflicting duplicate order
  // bindings remain separate so the presentation overlay rejects ambiguity.
  const byWitness = new Map(
    financial.map((binding) => [JSON.stringify(binding.witness), binding])
  )
  for (const binding of receivers) {
    const key = JSON.stringify(binding.witness)
    byWitness.set(key, {
      ...binding,
      // A receiver read's empty display default cannot replace independently
      // recorded financial facts from the other local-read transaction.
      settlement: byWitness.get(key)?.settlement ?? binding.settlement,
    })
  }
  return [...byWitness.values()]
}

/** Account/session-scoped local reads, never provider or relay work. */
export function checkoutSparkOrderSettlementQueryOptions(
  input: {
    enabled: boolean
    pubkey: string | null
    authGeneration: number
    isAuthGenerationCurrent: (generation: number) => boolean
    orderIds: readonly string[]
  },
  readBindings: ReadBindings = readLocalBindings
) {
  const { pubkey, authGeneration } = input
  const orderIds = [...new Set(input.orderIds)].sort()
  const isCurrent = () => input.isAuthGenerationCurrent(authGeneration)
  const enabled =
    input.enabled && !!pubkey && orderIds.length > 0 && isCurrent()
  return {
    queryKey: [
      "merchant-spark-order-settlements",
      pubkey ?? "none",
      authGeneration,
      orderIds,
    ] as const,
    enabled,
    // An unrelated order can change the list key while this order's verified
    // facts remain unchanged. Retain raw bindings only within this session;
    // callers still validate each binding against the current order witness.
    placeholderData: (
      previous: readonly MerchantOrderSettlementBinding[] | undefined,
      previousQuery: { queryKey: readonly unknown[] } | undefined
    ) =>
      enabled &&
      isCurrent() &&
      previousQuery?.queryKey[0] === "merchant-spark-order-settlements" &&
      previousQuery.queryKey[1] === pubkey &&
      previousQuery.queryKey[2] === authGeneration
        ? previous
        : undefined,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (!enabled || !pubkey || signal.aborted || !isCurrent()) {
        return NO_CHECKOUT_SPARK_ORDER_BINDINGS
      }
      const bindings = await readBindings(pubkey, orderIds)
      return signal.aborted || !isCurrent()
        ? NO_CHECKOUT_SPARK_ORDER_BINDINGS
        : bindings
    },
    staleTime: 5_000,
    gcTime: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  }
}

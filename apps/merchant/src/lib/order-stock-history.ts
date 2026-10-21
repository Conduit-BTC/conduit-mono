import {
  getLegacyNumericStockOrderId,
  getLocalProductStockRecoveryForOrder,
  type ParsedOrderMessage,
} from "@conduit/core"
import {
  PendingProductStockDeliveryStore,
  ProductStockDecisionStore,
} from "./productStock"

/** Keep both namespaces intact. Unbound history is a blocker, never stock credit. */
export async function readMerchantOrderStockHistory(input: {
  merchantPubkey: string
  orderId: string
  original?: Extract<ParsedOrderMessage, { type: "order" }>
  decisions: ProductStockDecisionStore
  pending: PendingProductStockDeliveryStore
}) {
  const raw = getLegacyNumericStockOrderId(input.merchantPubkey, input.original)
  const legacyOrderId = raw && raw !== input.orderId ? raw : null
  const [current, legacy] = await Promise.all([
    getLocalProductStockRecoveryForOrder(input.merchantPubkey, input.orderId),
    legacyOrderId
      ? getLocalProductStockRecoveryForOrder(
          input.merchantPubkey,
          legacyOrderId
        )
      : [],
  ])
  const legacyPending = legacyOrderId
    ? input.pending
        .getPersistedForMerchant(input.merchantPubkey)
        .filter((row) => {
          if (row.orderId !== legacyOrderId) return false
          const decision = input.decisions.getPersisted(
            input.merchantPubkey,
            legacyOrderId,
            row.adjustment.addressId
          )
          return (
            decision?.kind !== "applied" &&
            !(
              decision?.kind === "unpublished" &&
              decision.localEventId === row.signedEvent.id
            )
          )
        })
    : []
  const legacyDecision =
    legacyOrderId &&
    input.original?.payload.items.some((item) =>
      input.decisions.getPersisted(
        input.merchantPubkey,
        legacyOrderId,
        item.productId
      )
    )
  return {
    current,
    legacy,
    legacyOrderId,
    legacyPending,
    hasUnboundLegacyHistory:
      legacy.length > 0 || legacyPending.length > 0 || !!legacyDecision,
  }
}

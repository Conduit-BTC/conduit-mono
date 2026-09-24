import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { OrderStockPanel } from "../apps/merchant/src/components/OrderStockPanel"
import type { OrderStockAdjustment } from "../apps/merchant/src/lib/productStock"

function adjustment(
  overrides: Partial<OrderStockAdjustment> = {}
): OrderStockAdjustment {
  return {
    key: "order-1:product-1",
    addressId: "30402:merchant:pocket-relay",
    sourceEventId: "event-1",
    title: "Pocket Relay",
    quantity: 2,
    currentStock: 12,
    nextStock: 10,
    shortfall: 0,
    ...overrides,
  }
}

const handlers = {
  onUpdate: () => undefined,
  onRetry: () => undefined,
  onRepublish: () => undefined,
  onDismissDelivery: () => undefined,
}

describe("merchant order stock UI", () => {
  it("shows the calculated publish action and a custom stock field", () => {
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[adjustment()]}
        delivery={null}
        deliveryNeedsAttention={false}
        pending={false}
        updatePending={false}
        errorMessage={null}
        canMessageBuyer
        onMessageBuyer={() => undefined}
        {...handlers}
      />
    )

    expect(markup).toContain("Inventory")
    expect(markup).toContain("Mark 2 ×")
    expect(markup).toContain("Pocket Relay")
    expect(markup).toContain("sold. Update stock")
    expect(markup).toContain("12 → 10")
    expect(markup).toContain("Publish stock 10")
    expect(markup).toContain("Custom updated stock")
    expect(markup).toContain("Publish custom stock")
    expect(markup).toContain('inputMode="numeric"')
    expect(markup).toContain('aria-describedby="custom-stock-help-')
    expect(markup).not.toContain("Keep 12")
    expect(markup).not.toContain("Message buyer")
    expect(markup).toContain('aria-labelledby="order-stock-heading"')
  })

  it("warns when order quantity would take tracked stock below zero", () => {
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[
          adjustment({
            quantity: 5,
            currentStock: 2,
            nextStock: 0,
            shortfall: 3,
          }),
        ]}
        delivery={null}
        deliveryNeedsAttention={false}
        pending={false}
        updatePending={false}
        errorMessage={null}
        {...handlers}
      />
    )

    expect(markup).toContain("Restocking required")
    expect(markup).toContain("exceeds tracked stock by 3")
    expect(markup).toContain("Publish stock 0")
    expect(markup).not.toContain("Keep 2")
    expect(markup).not.toContain("Message buyer")
  })

  it("shows merchant resolution options when tracked stock is already zero", () => {
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[
          adjustment({
            quantity: 1,
            currentStock: 0,
            nextStock: 0,
            shortfall: 1,
          }),
        ]}
        delivery={null}
        deliveryNeedsAttention={false}
        pending={false}
        updatePending={false}
        errorMessage={null}
        canMessageBuyer
        onMessageBuyer={() => undefined}
        {...handlers}
      />
    )

    expect(markup).toContain("Restocking required")
    expect(markup).toContain("tracked stock is already 0")
    expect(markup).toContain("fulfill it after restocking")
    expect(markup).toContain("if they are first in line")
    expect(markup).toContain("coordinate a refund")
    expect(markup).toContain("Message buyer")
    expect(markup).not.toContain("Keep stock at 0")
    expect(markup).not.toContain("Publish stock 0")
  })

  it("keeps restocking guidance without offering an already-applied update", () => {
    const applied = adjustment({
      quantity: 5,
      currentStock: 2,
      nextStock: 0,
      shortfall: 3,
    })
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[applied]}
        stockMutationDisabledKeys={new Set([applied.key])}
        delivery={null}
        deliveryNeedsAttention={false}
        pending={false}
        updatePending={false}
        errorMessage={null}
        canMessageBuyer
        onMessageBuyer={() => undefined}
        {...handlers}
      />
    )

    expect(markup).toContain("Restocking required")
    expect(markup).toContain("exceeds tracked stock by 3")
    expect(markup).toContain("Message buyer")
    expect(markup).not.toContain("Publish stock 0")
  })

  it("publishes from the latest local listing without a blocking relay read", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).not.toContain("getAtomicProductDetail")
    expect(source).not.toContain("latest.meta.degraded || latest.meta.stale")
    expect(source).toContain("await getCachedMerchantStorefront")
    expect(source).not.toContain("orderProductsQuery.data?.data.find")
    expect(source).toContain(
      "(candidate) => candidate.addressId === payload.adjustment.addressId"
    )
    expect(source).toContain("stock: effectiveAdjustment.nextStock")
    expect(source).not.toContain("stock: payload.stock")
  })

  it("keeps organizer and shipping authorization outside the stock mutation", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const mutation = source.slice(
      source.indexOf("const stockUpdateMutation ="),
      source.indexOf("const confirmPaymentMutation =")
    )
    expect(mutation).toContain("prepareOrderStockUpdate({")
    expect(mutation).not.toContain("verifyMerchantPickupOrderAuthorization({")
    expect(mutation).not.toContain("resolveStockUpdateFulfillmentIntent")
    expect(mutation).toContain("isOrderStockAdjustmentMutationDisabled({")
    expect(source).toContain("verifyMerchantPickupOrderAuthorization({")
  })

  it("clears transient blockers only after a stock decision is durable", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain(
      "next.delete(`${merchantPubkey}:${result.adjustment.key}`)"
    )
    expect(source).toContain("hasSessionDecision: sessionStockDecisionKeys.has")
    expect(source).toContain('stockDelivery.notice.state !== "delivered"')
    expect(source).toContain('stockDelivery.notice.state !== "rejected"')
    expect(source).toContain(
      'notice.state === "delivered" || notice.state === "rejected"'
    )
    expect(source).toContain(
      "stockDecisionHydratedSelectionId !== selectedStockDecisionId"
    )
    const settledDecision = source.slice(
      source.indexOf('let settlement: "saved" | "retry" | "stale"'),
      source.indexOf("const nextPendingDelivery =")
    )
    expect(settledDecision).toContain("settleLocalProductStockRecovery({")
    expect(settledDecision).toContain("settleSignedOrderStockDelivery({")
    expect(settledDecision).toContain(
      'const decisionPersisted = settlement === "saved"'
    )
    expect(settledDecision).toMatch(
      /if \(decisionPersisted\) \{[\s\S]*setSessionStockDecisionKeys\(/
    )
    expect(
      source.indexOf("pendingStockDeliveryStoreRef.current.getForOrder")
    ).toBeLessThan(
      source.indexOf("setStockDecisionHydratedSelectionId(selectedId)")
    )
  })

  it("keeps a pending oversold snapshot retryable without another update", () => {
    const item = adjustment({
      quantity: 5,
      currentStock: 2,
      nextStock: 0,
      shortfall: 3,
    })
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[item]}
        stockMutationDisabledKeys={new Set([item.key])}
        delivery={{
          adjustment: item,
          notice: {
            action: "publish",
            state: "retry_needed",
            title: "Publish saved locally",
            detail:
              "The signed listing remains visible locally. Use Retry delivery to try the relays again.",
            attemptedRelayUrls: [],
            successfulRelayUrls: [],
            failedRelayUrls: [],
            rejectedRelayUrls: [],
          },
        }}
        deliveryNeedsAttention
        pending={false}
        updatePending={false}
        errorMessage={null}
        {...handlers}
      />
    )

    expect(markup).toContain("Retry needed")
    expect(markup).toContain("Retry delivery")
    expect(markup).toContain("Hide for now")
    expect(markup).toContain("exceeds tracked stock by 3")
    expect(markup).not.toContain("Publish stock 0")
  })

  it("offers a new signature, not a second decrement or rejected-byte retry, after zero ACKs", () => {
    const item = adjustment()
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[item]}
        stockMutationDisabledKeys={new Set([item.key])}
        unpublishedStockKeys={new Set([item.key])}
        delivery={null}
        deliveryNeedsAttention={false}
        pending={false}
        updatePending={false}
        errorMessage={null}
        {...handlers}
      />
    )

    expect(markup).toContain("Not published")
    expect(markup).toContain("no relay accepted it")
    expect(markup).toContain("will not subtract stock again")
    expect(markup).toContain("Sign new listing for stock 10")
    expect(markup).not.toContain("Publish stock 10")
    expect(markup).not.toContain("Retry delivery")
  })

  it("keeps the Orders route on durable exact-byte retry and a separate fresh-sign path", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    expect(source).toContain("ensureSignedProductListingsQueued({")
    expect(source).toContain("deliverQueuedProductListings(queued.id")
    expect(source).toContain('payload.action === "republish"')
    expect(source).toContain("getUnpublishedOrderStockRepublishAdjustment({")
    expect(source).toContain(
      'notice.state === "rejected" ? "unpublished" : "applied"'
    )
    expect(source).toContain("onRepublish={republishStock}")
  })

  it("binds fresh stock to the journal and old republish to held-lock recovery", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const mutation = source.slice(
      source.indexOf("const stockUpdateMutation ="),
      source.indexOf("const confirmPaymentMutation =")
    )
    expect(mutation).toContain('payload.action === "republish"')
    expect(mutation).toContain("captureOrderStockRevision(record)")
    expect(mutation).toContain("assertOrderStockRevisionCurrent({")
    expect(mutation).toContain("signAndPublishProductWriteBundle({")
    expect(mutation).toContain("assertCurrentWriteBaseline,")
    expect(mutation).toContain("durableCommit: {")
    expect(mutation).toContain("legacyCommit: {")
    expect(mutation).toContain('kind: "stock_republish" as const')
    expect(mutation).toContain("reserveSignedUnderLock: async (bundle) => {")
    expect(mutation).toContain(
      "return checkpointSignedOrderStockDeliveryWithHeldLock({"
    )
    expect(mutation).toContain("expectedUnpublishedEventId:")
    expect(mutation).toContain("assertCurrentWriteBaseline,")
    expect(mutation).toContain("settleSignedOrderStockDelivery({")
    expect(mutation.indexOf("reserveSignedUnderLock:")).toBeLessThan(
      mutation.indexOf("onSignedLocal:")
    )
    expect(mutation).toContain("onSignedLocal: async (bundle) => {")
    expect(mutation).not.toContain("onSignedEvent:")
  })

  it("rehydrates the exact pending stock retry when outbox staging fails before the UI callback", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const stockMutation = source.slice(
      source.indexOf("const stockUpdateMutation ="),
      source.indexOf("const confirmPaymentMutation =")
    )
    const errorHandler = stockMutation.slice(
      stockMutation.indexOf("onError: async (error, payload) => {"),
      stockMutation.indexOf("onSettled:")
    )
    expect(errorHandler).toContain("getPersistedForMerchant(pubkey)")
    expect(errorHandler).toContain("pending.orderId !== payload.orderId")
    expect(errorHandler).toContain(
      "pending.adjustment.key !== payload.adjustment.key"
    )
    expect(errorHandler).toContain('decision?.kind !== "applied"')
    expect(errorHandler).toContain("signedEvent: recoveredPending.signedEvent")
    expect(errorHandler).toContain('buildLocalProductRetryNotice("publish")')
    expect(errorHandler).not.toContain("signAndPublishProductWriteBundle(")
  })

  it("fences Products deletion against an outstanding signed stock update", async () => {
    const source = await Bun.file(
      "apps/merchant/src/routes/products.tsx"
    ).text()
    const deletion = source.slice(
      source.indexOf("async function deleteProduct("),
      source.indexOf("function ProductsPage()")
    )
    expect(deletion).toContain("signAndPublishProductWriteBundle({")
    expect(deletion).toContain("durableCommit: {}")
    const writer = await Bun.file(
      "apps/merchant/src/lib/product-publishing.ts"
    ).text()
    const atomicPath = writer.slice(
      writer.indexOf("if (input.durableCommit) {"),
      writer.indexOf("// A new 30406 can only leave")
    )
    expect(atomicPath).toContain("withMerchantStockLock(")
    expect(atomicPath).toContain("getPersistedForMerchant(")
    expect(atomicPath.indexOf("getPersistedForMerchant(")).toBeLessThan(
      atomicPath.indexOf("commitLocalProductWrite(")
    )
  })
})

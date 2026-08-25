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
    expect(source).toContain("stock: payload.adjustment.nextStock")
    expect(source).not.toContain("stock: payload.stock")
  })

  it("clears transient blockers only after a stock decision is durable", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain(
      "next.delete(`${merchantPubkey}:${payload.adjustment.key}`)"
    )
    expect(source).toContain("hasSessionDecision: sessionStockDecisionKeys.has")
    expect(source).toContain('stockDelivery.notice.state !== "delivered"')
    expect(source).toContain(
      "stockDecisionHydratedSelectionId !== selectedStockDecisionId"
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
})

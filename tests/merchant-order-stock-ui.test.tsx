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
  onDecline: () => undefined,
  onRetry: () => undefined,
  onDismissDelivery: () => undefined,
}

describe("merchant order stock UI", () => {
  it("shows explicit update math and a decline action", () => {
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[adjustment()]}
        delivery={null}
        deliveryNeedsAttention={false}
        pending={false}
        updatePending={false}
        errorMessage={null}
        {...handlers}
      />
    )

    expect(markup).toContain("Inventory")
    expect(markup).toContain("Mark 2 ×")
    expect(markup).toContain("Pocket Relay")
    expect(markup).toContain("sold. Update stock")
    expect(markup).toContain("12 → 10")
    expect(markup).toContain("Update to 10")
    expect(markup).toContain("Keep 12")
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

    expect(markup).toContain("exceeds tracked stock by 3")
    expect(markup).toContain("Update to 0")
  })

  it("keeps signed relay delivery status and retry visible", () => {
    const item = adjustment()
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[]}
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
  })
})

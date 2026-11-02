import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { OrderStockPanel } from "../apps/merchant/src/components/OrderStockPanel"
import { getOrderStockUpdateErrorMessage } from "../apps/merchant/src/lib/order-stock-feedback"
import { buildLocalProductRetryNotice } from "../apps/merchant/src/lib/product-delivery"
import { SignedProductDeliveryError } from "../apps/merchant/src/lib/product-publishing"
import type { OrderStockAdjustment } from "../apps/merchant/src/lib/productStock"

const adjustment: OrderStockAdjustment = {
  key: "order-1:product-1",
  addressId: "30402:merchant:product-1",
  sourceEventId: "event-1",
  title: "Test product",
  quantity: 1,
  currentStock: 4,
  nextStock: 3,
  shortfall: 0,
}

describe("merchant order stock feedback", () => {
  it("shows a visible error when a stock update was not safely queued", () => {
    const error = new SignedProductDeliveryError(
      new Error("Local product commit did not complete"),
      false
    )
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[adjustment]}
        newStockActionsAuthorized
        delivery={null}
        deliveryNeedsAttention={false}
        pending={false}
        updatePending={false}
        errorMessage={getOrderStockUpdateErrorMessage(error)}
        onUpdate={() => undefined}
        onRetry={() => undefined}
        onRepublish={() => undefined}
        onDismissDelivery={() => undefined}
      />
    )

    expect(markup).toContain('role="alert"')
    expect(markup).toContain("Stock update could not be queued safely")
    expect(markup).not.toContain("Retry delivery")
    expect(markup).not.toContain("saved locally")
  })

  it("retains the exact saved retry notice without offering another stock update", () => {
    const savedDelivery = {
      orderId: "order-1",
      adjustment,
      notice: buildLocalProductRetryNotice("publish"),
    }
    const error = new SignedProductDeliveryError(
      new Error("Delivery did not complete")
    )
    const markup = renderToStaticMarkup(
      <OrderStockPanel
        adjustments={[adjustment]}
        newStockActionsAuthorized
        stockMutationDisabledKeys={new Set([adjustment.key])}
        delivery={savedDelivery}
        deliveryNeedsAttention
        pending={false}
        updatePending={false}
        errorMessage={getOrderStockUpdateErrorMessage(
          error,
          { orderId: "order-1", adjustment },
          savedDelivery
        )}
        onUpdate={() => undefined}
        onRetry={() => undefined}
        onRepublish={() => undefined}
        onDismissDelivery={() => undefined}
      />
    )

    expect(markup).toContain(savedDelivery.notice.detail)
    expect(markup).toContain("Retry delivery")
    expect(markup).not.toContain('role="alert"')
    expect(markup).not.toContain("Publish stock 3")
    expect(markup).not.toContain("Publish custom stock")
  })

  it("does not hide a queue failure behind another order or adjustment notice", () => {
    const error = new SignedProductDeliveryError(
      new Error("Commit failed"),
      false
    )
    const action = { orderId: "order-1", adjustment }

    expect(
      getOrderStockUpdateErrorMessage(error, action, {
        orderId: "order-2",
        adjustment,
      })
    ).toContain("Stock update could not be queued safely")
    expect(
      getOrderStockUpdateErrorMessage(error, action, {
        orderId: "order-1",
        adjustment: { key: "other-adjustment" },
      })
    ).toContain("Stock update could not be queued safely")
  })

  it("does not claim a saved update when delivery evidence is unavailable", () => {
    const message = getOrderStockUpdateErrorMessage(
      new SignedProductDeliveryError(new Error("Delivery unavailable"))
    )

    expect(message).toContain("Stock update delivery could not be confirmed")
    expect(message).toContain("check its saved status")
    expect(message).not.toContain("saved locally")
  })

  it("preserves ordinary validation errors and the empty state", () => {
    expect(
      getOrderStockUpdateErrorMessage(new Error("Refresh the listing"))
    ).toBe("Refresh the listing")
    expect(getOrderStockUpdateErrorMessage("unavailable")).toBe(
      "Failed to update listing stock"
    )
    expect(getOrderStockUpdateErrorMessage(null)).toBeNull()
  })
})

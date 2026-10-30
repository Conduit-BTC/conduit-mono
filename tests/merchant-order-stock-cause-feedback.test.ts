import { describe, expect, it } from "bun:test"
import { getOrderStockUpdateErrorMessage } from "../apps/merchant/src/lib/order-stock-feedback"
import { SignedProductDeliveryError } from "../apps/merchant/src/lib/product-publishing"

describe("ordinary stock queue failure guidance", () => {
  it("explains an event allocation conflict without claiming publication", () => {
    const error = new SignedProductDeliveryError(
      new Error("Reconcile occurrence allocations before changing stock"),
      false
    )

    expect(getOrderStockUpdateErrorMessage(error)).toBe(
      "This stock change conflicts with the product's event allocations. Review those allocations, then refresh Orders to check the saved status before trying again."
    )
  })

  it("explains that accepted stock must not be subtracted again", () => {
    const error = new SignedProductDeliveryError(
      new Error("This order already consumed inventory at acceptance"),
      false
    )

    expect(getOrderStockUpdateErrorMessage(error)).toBe(
      "Stock was already counted when this order was accepted. Refresh Orders to check its saved status; don't subtract it again."
    )
  })

  it("asks for a fresh stock review after a listing or inventory change", () => {
    for (const cause of [
      "Product changed before the signed local commit",
      "Committed inventory changed before the product edit",
      "The listing changed while preparing the stock update. Refresh orders and try again.",
    ]) {
      expect(
        getOrderStockUpdateErrorMessage(
          new SignedProductDeliveryError(new Error(cause), false)
        )
      ).toBe(
        "The listing or inventory changed while this update was being prepared. Refresh Orders and review the current stock and saved update before trying again."
      )
    }
  })

  it("keeps saved stock information intact when it cannot be read", () => {
    for (const cause of [
      "Browser storage is unavailable for stock recovery",
      "Stored stock checkpoints are unreadable",
    ]) {
      expect(
        getOrderStockUpdateErrorMessage(
          new SignedProductDeliveryError(new Error(cause), false)
        )
      ).toBe(
        "Saved stock information is unavailable or unreadable in this browser. Check its saved status before continuing; don't clear browser data or repeat the stock update."
      )
    }
  })

  it("retains delivery uncertainty for a retryable error with a known cause", () => {
    const error = new SignedProductDeliveryError(
      new Error("Reconcile occurrence allocations before changing stock")
    )

    expect(getOrderStockUpdateErrorMessage(error)).toBe(
      "Stock update delivery could not be confirmed. Refresh orders to check its saved status before trying again."
    )
  })

  it("keeps a matching saved delivery notice ahead of cause guidance", () => {
    const error = new SignedProductDeliveryError(
      new Error("Reconcile occurrence allocations before changing stock"),
      false
    )
    const action = { orderId: "order-1", adjustment: { key: "stock-1" } }

    expect(getOrderStockUpdateErrorMessage(error, action, action)).toBeNull()
    expect(
      getOrderStockUpdateErrorMessage(error, action, {
        ...action,
        adjustment: { key: "previous-stock-update" },
      })
    ).toContain("conflicts with the product's event allocations")
  })

  it("retains generic wording for unknown or nonexact causes", () => {
    const namedStorageError = new Error("The local operation did not finish")
    namedStorageError.name = "QuotaExceededError"
    for (const cause of [
      new Error("The local operation did not finish"),
      new Error("Reconcile occurrence allocations before changing stock."),
      namedStorageError,
      { message: "Stored stock checkpoints are unreadable" },
      "Browser storage is unavailable for stock recovery",
      null,
    ]) {
      expect(
        getOrderStockUpdateErrorMessage(
          new SignedProductDeliveryError(cause, false)
        )
      ).toBe(
        "Stock update could not be queued safely. Refresh orders to check its saved status before trying again."
      )
    }
  })

  it("preserves existing ordinary error and empty-state handling", () => {
    expect(
      getOrderStockUpdateErrorMessage(new Error("Refresh the listing"))
    ).toBe("Refresh the listing")
    expect(getOrderStockUpdateErrorMessage("unavailable")).toBe(
      "Failed to update listing stock"
    )
    expect(getOrderStockUpdateErrorMessage(null)).toBeNull()
  })
})

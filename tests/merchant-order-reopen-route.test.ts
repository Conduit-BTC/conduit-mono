import { describe, expect, it } from "bun:test"

async function loadMerchantOrdersRoute(): Promise<string> {
  return Bun.file("apps/merchant/src/routes/orders.tsx").text()
}

describe("Merchant order reopen confirmation", () => {
  it("stops a frozen reopen when the effective cancellation changed", async () => {
    const source = await loadMerchantOrdersRoute()
    const guardStart = source.indexOf("const frozenCancellationId =")
    const publishStart = source.indexOf(
      "reopenOrderMutation.mutate(reopenConfirmation)",
      guardStart
    )

    expect(guardStart).toBeGreaterThan(-1)
    expect(publishStart).toBeGreaterThan(guardStart)

    const guard = source.slice(guardStart, publishStart)
    expect(guard).toContain("currentReopenInput?.transition.payload.reopens")
    expect(guard).toContain("frozenCancellationId !== currentCancellationId")
    expect(guard).toContain("setReopenConfirmationError(")
    expect(guard).toContain("return")
    expect(source).toContain(
      "This order changed while the confirmation was open. Close this dialog and refresh Orders"
    )
  })

  it("reports delivery submission without claiming semantic reopen", async () => {
    const source = await loadMerchantOrdersRoute()

    expect(source).toContain("Reopen update submitted for buyer delivery")
    expect(source).toContain(
      "Reopen update recorded in your encrypted order history"
    )
    expect(source).not.toContain("Order reopened; buyer update submitted")
    expect(source).not.toContain(
      "Order reopened in your encrypted order history"
    )
  })
})

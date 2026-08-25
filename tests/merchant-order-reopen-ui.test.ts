import { describe, expect, it } from "bun:test"

describe("merchant order reopen UI", () => {
  it("publishes the explicit correction marker behind a confirmation", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("getMerchantOrderReopenTransition")
    expect(source).toContain("tags: transition.tags")
    expect(source).toContain("payload: transition.payload")
    expect(source.match(/inboundOrder: selectedOrderMessage/g)).toHaveLength(6)
    expect(source).toContain(
      "The original order is missing. Refresh the order history before recording an update."
    )
    expect(source).toContain("selected?.lifecycleWriteReady !== true")
    expect(source).toContain(
      "const { pubkey, status, authGeneration } = useAuth()"
    )
    expect(source).toContain(
      "Recover the original order from authenticated history before recording an update."
    )
    expect(source).toContain(
      "authenticated order history recovers the original"
    )
    expect(source).toContain("Order actions are unavailable until the original")
    expect(source).toContain(
      "<AlertDialogTitle>Reopen this order?</AlertDialogTitle>"
    )
    expect(source).toContain(
      "Payment, shipping, refund, and inventory history stay unchanged"
    )
    expect(source).toContain("It does not notify the guest")
    expect(source).toContain(
      "This partial history has no confirmed reply inbox, so the buyer is not notified."
    )
    expect(source).toContain(
      "This partial history identifies a buyer but does not"
    )
    expect(source).toContain("Keep cancelled")
    expect(source).toMatch(
      /\{\(advanceStatusMutation\.error \|\|\s+reopenOrderMutation\.error \|\|/
    )
    expect(source.indexOf("{successFlash && (")).toBeLessThan(
      source.indexOf("{showOrderWorkspace && (")
    )
    expect(source.match(/\{successFlash && \(/g)).toHaveLength(1)
    expect(source.match(/role="status"/g)).toHaveLength(1)
    expect(source.match(/setSuccessFlash\(null\)/g)).toHaveLength(1)
  })
})

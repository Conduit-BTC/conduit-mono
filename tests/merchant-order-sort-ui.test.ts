import { describe, expect, it } from "bun:test"

describe("merchant order sort UI", () => {
  it("defaults the operational queue to needs-action ordering and retains recent activity", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain(
      'useState<ConversationListSortMode>("merchant_priority")'
    )
    expect(source).toContain("sort: orderSort")
    expect(source).toContain(
      '<SelectItem value="merchant_priority">Needs action</SelectItem>'
    )
    expect(source).toContain(
      '<SelectItem value="recent_activity">Recent activity</SelectItem>'
    )
    expect(source).toContain(
      "const selectedMerchantQueue: MerchantOrderPriorityBucket | undefined ="
    )
    expect(source.match(/queue: selectedMerchantQueue/g)).toHaveLength(2)
    expect(source).not.toContain("getMerchantConversationQueue(conversation)")
    expect(source).toContain(
      "Paid and payment-review orders first; oldest tasks first."
    )
    expect(source).toContain("(!!selectedOrdersResult && !canClaimEmptyOrders)")
    expect(source).toContain("{showOrderWorkspace && (")
    expect(source).toContain('label: "Unpaid / waiting"')
    expect(source).toContain(
      "Showing up to 200 orders in {selectedQueueLabel}."
    )
    expect(source).toContain("Loaded orders")
    expect(source).not.toContain("Open threads")
  })

  it("distinguishes loading, stale, bounded, interrupted, and authoritative-empty reads", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("const canClaimEmptyOrders =")
    expect(source).toContain(
      "Showing saved orders while checking for the latest updates."
    )
    expect(source).toContain(
      "Needs-action ordering uses the loaded history. Older orders may be missing."
    )
    expect(source).toContain(
      "Order history sync was interrupted. Refresh to retry."
    )
    expect(source).toContain(
      "Showing recent history only. Older orders may not be loaded."
    )
    expect(source).toContain("{signerConnected && canClaimEmptyOrders && (")
    expect(source).toContain("No orders found in your connected inboxes")
    expect(source).not.toContain(
      "No orders yet. Place an order from the Market app"
    )
  })

  it("keeps refresh status manual and exposes only the current label", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("const handleRefresh = useCallback(async () =>")
    expect(source).toContain('aria-busy={refreshButtonState === "refreshing"}')
    expect(source).toContain('<span aria-live="polite">')
    expect(source).not.toContain("const isOrdersFetching")
    expect(source).not.toContain("if (isOrdersFetching)")
    expect(source).not.toContain("opacity-0 text-[var(--success)]")
  })
})

import { describe, expect, it } from "bun:test"

describe("merchant invoice route contract", () => {
  it("keeps the profile destination default and wallet sources explicit", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("createDefaultMerchantInvoiceModule")
    expect(source).toContain(
      'useState<MerchantInvoiceActionSource>("profile_lud16")'
    )
    expect(source).toMatch(/<SelectItem\s+value="profile_lud16"/)
    expect(source).toMatch(/<SelectItem\s+value="webln"/)
    expect(source).toMatch(/<SelectItem\s+value="nwc"/)
    expect(source).toMatch(/<SelectItem\s+value="manual"/)
    expect(source).not.toContain("else if (weblnAvailable)")
  })

  it("keeps saved-invoice retry local and manual paste available", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("merchantInvoiceModule.getStatus")
    expect(source).toContain("merchantInvoiceModule.retryDelivery")
    expect(source).toContain("Retry saved invoice")
    expect(source).toContain("Resend same invoice")
    expect(source).toContain("BOLT11 (paste manually)")
    expect(source).toContain("throw safeInvoiceActionError(source)")
    expect(source).not.toContain("Invoice history is incomplete")
  })

  it("keeps private order identity out of the invoice query cache key", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain(
      'queryKey: ["merchant-pending-invoice", pendingInvoiceQueryToken]'
    )
    expect(source).not.toMatch(
      /queryKey:\s*\[\s*"merchant-pending-invoice",\s*pubkey/
    )
  })

  it("guards every merchant payment confirmation before publishing", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain('if (action.action === "confirm_payment")')
    expect(source).toContain("setConfirmingPayment(true)")
    expect(source).toContain("open={confirmingPayment}")
    expect(source).toContain("checking your wallet")
    expect(source).toContain("notifies the buyer")
    expect(source).not.toMatch(
      /action\.action === "confirm_payment"\s*&&\s*canRequestPaymentOutOfBand/
    )
  })
})

import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("Market order history public zap note contract", () => {
  it("renders local and observed receipt truth without exposing private order fields", async () => {
    const route = await readFile("apps/market/src/routes/orders.tsx", "utf8")
    const componentStart = route.indexOf("function PublicZapNoteCard")
    const componentEnd = route.indexOf(
      "/** External-wallet QR fallback",
      componentStart
    )
    const component = route.slice(componentStart, componentEnd)

    expect(componentStart).toBeGreaterThanOrEqual(0)
    expect(componentEnd).toBeGreaterThan(componentStart)
    expect(component).toContain('vm.publicZapSigner === "shopper"')
    expect(component).toContain('vm.zapReceiptStatus === "observed"')
    expect(component).toContain("Public receipt observed")
    expect(component).toContain('role="status"')
    expect(component).toContain('aria-live="polite"')
    expect(component).toContain('aria-atomic="true"')
    expect(component).toContain("Saved locally")
    expect(component).toContain("Receipt not observed")
    expect(component).toContain("becomes public only")
    expect(component).toContain("vm.publicZapNote")
    expect(component).toContain("whitespace-pre-wrap")
    expect(component).toContain("break-words")
    expect(component).toContain("vm.publicZapProductNaddr")
    expect(component).toContain('to="/products/$productId"')
    expect(component).toContain("View zapped product")
    expect(component).not.toContain("contactNote")
    expect(component).not.toContain("shippingAddress")
    expect(component).not.toContain("invoice")
    expect(component).not.toContain("zapRequestId")
    expect(component).not.toContain("zapReceiptId")
  })

  it("preserves the zap target when an order payment context is reconstructed", async () => {
    const route = await readFile("apps/market/src/routes/orders.tsx", "utf8")

    expect(route).toContain("zapTargetAddress: lc.zapTargetAddress")
  })

  it("automatically observes shopper-signed public receipts", async () => {
    const route = await readFile("apps/market/src/routes/orders.tsx", "utf8")

    expect(route).toContain("supportsPublicReceiptObservation")
    expect(route).toContain('vm.publicZapSigner === "shopper"')
  })
})

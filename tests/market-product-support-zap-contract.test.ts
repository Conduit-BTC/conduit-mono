import { describe, expect, it } from "bun:test"

describe("Market product support zap contracts", () => {
  it("mounts the support flow on the canonical product detail page", async () => {
    const productRoute = await Bun.file(
      "apps/market/src/routes/products/$productId.tsx"
    ).text()

    expect(productRoute).toContain("import { ProductSupportZap }")
    expect(productRoute).toContain("<ProductSupportZap")
    expect(productRoute).toContain("productAddress={selectedProduct.id}")
    expect(productRoute).toContain("merchantPubkey={selectedProduct.pubkey}")
    expect(productRoute).toContain("lud16={merchantProfile.data?.lud16}")
  })

  it("keeps support separate from commerce and does not auto-pay", async () => {
    const supportUi = await Bun.file(
      "apps/market/src/components/ProductSupportZap.tsx"
    ).text()
    const normalizedUi = supportUi.replace(/\s+/g, " ")

    expect(supportUi).toContain("prepareProductSupportZapInvoice({")
    expect(supportUi).toContain("createNdkNostrEventSigner(")
    expect(supportUi).toContain("relayUrls: config.zapRelayUrls")
    expect(normalizedUi).toContain(
      "This is separate from buying the product and never changes cart or order status."
    )
    expect(supportUi).toContain(
      "Invoice ready. Conduit has not sent or confirmed a payment."
    )
    expect(supportUi).toContain("href={`lightning:${bolt11}`}")
    expect(supportUi).not.toContain("payCheckoutInvoice")
    expect(supportUi).not.toContain("sendPayment(")
    expect(supportUi).not.toContain("recordBrowserTelemetryEvent")
  })

  it("labels the optional note and states its exact public boundary", async () => {
    const supportUi = await Bun.file(
      "apps/market/src/components/ProductSupportZap.tsx"
    ).text()
    const normalizedUi = supportUi.replace(/\s+/g, " ")

    expect(supportUi).toContain("Public note (optional)")
    expect(supportUi).toContain("PRODUCT_SUPPORT_ZAP_NOTE_MAX_CODE_POINTS")
    expect(supportUi).toContain("The public zap request includes this note")
    expect(normalizedUi).toContain(
      "It never includes cart, order, shipping, or customer details."
    )
  })
})

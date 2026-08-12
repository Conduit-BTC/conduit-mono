import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { OrderItemsCard } from "../apps/merchant/src/components/OrderItemsCard"

const productLookup = new Map<
  string,
  {
    title: string
    imageUrl?: string
    format: "physical" | "digital"
  }
>()

describe("merchant order items card", () => {
  it("shows quantity-extended lines and the explicit shipping breakdown", () => {
    const markup = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "honey",
            title: "Cretan Wildflower Honey",
            format: "physical",
            quantity: 2,
            priceAtPurchase: 7_724,
            currency: "SATS",
          },
          {
            productId: "olive-oil",
            title: "Costos Extra Virgin Olive Oil",
            format: "physical",
            quantity: 2,
            priceAtPurchase: 32_441,
            currency: "SATS",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={80_330}
        shippingCostSats={58_394}
        shippingCostStatus="priced"
        total={138_724}
        currency="SATS"
      />
    )

    expect(markup).toContain("Cretan Wildflower Honey")
    expect(markup).toContain("Costos Extra Virgin Olive Oil")
    expect(markup.match(/each × 2/g)).toHaveLength(2)
    expect(markup).toContain("7,724 sats each × 2")
    expect(markup).toContain("32,441 sats each × 2")
    expect(markup.match(/Line total/g)).toHaveLength(2)
    expect(markup).toContain("15,448 sats")
    expect(markup).toContain("64,882 sats")
    expect(markup).toContain("Items subtotal (4 items)")
    expect(markup).toContain("80,330 sats")
    expect(markup).toContain("58,394 sats")
    expect(markup).toContain("Order total")
    expect(markup).toContain("138,724 sats")

    expect(markup).toMatch(/<section[^>]+aria-labelledby=/)
    expect(markup).toContain("<h3")
    expect(markup).toContain("<ul")
    expect(markup.match(/<li/g)).toHaveLength(2)
    expect(markup).toContain("<dl")
    expect(markup).toContain("<dt>Items subtotal (4 items)</dt>")
    expect(markup).toContain("<dt>Shipping</dt>")
  })

  it("preserves the selected variation details from the signed order snapshot", () => {
    const markup = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "shirt-blue-large",
            familyProductId: "shirt",
            selectedSpecifications: [
              { key: "Color", value: "Blue" },
              { key: "Size", value: "Large" },
            ],
            title: "Market Shirt",
            format: "physical",
            quantity: 1,
            priceAtPurchase: 12_000,
            currency: "SATS",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={12_000}
        shippingCostSats={0}
        shippingCostStatus="included"
        total={12_000}
        currency="SATS"
      />
    )

    expect(markup).toContain("Market Shirt")
    expect(markup).toContain("Color: Blue · Size: Large")
  })

  it("labels a legacy order without shipping metadata instead of inferring zero", () => {
    const markup = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "legacy-item",
            title: "Legacy Item",
            format: "physical",
            quantity: 3,
            priceAtPurchase: 250,
            currency: "SATS",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={750}
        shippingCostSats={null}
        shippingCostStatus={null}
        total={900}
        currency="SATS"
      />
    )

    expect(markup).toContain("750 sats")
    expect(markup).toContain("Not recorded")
    expect(markup).toContain("This order has no shipping breakdown.")
    expect(markup).toContain("Recorded total")
    expect(markup).not.toContain("Order total")
    expect(markup).toContain("900 sats")
    expect(markup).not.toContain("150 sats")
    expect(markup).not.toContain("<div>0 sats</div>")
  })

  it("keeps manually arranged shipping visibly unpriced", () => {
    const markup = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "manual-shipping-item",
            title: "Manual Shipping Item",
            format: "physical",
            quantity: 1,
            priceAtPurchase: 750,
            currency: "SATS",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={750}
        shippingCostSats={null}
        shippingCostStatus="manual"
        total={750}
        currency="SATS"
      />
    )

    expect(markup).toContain("Not included")
    expect(markup).toContain("Shipping will be arranged separately.")
    expect(markup).toContain("Items total (shipping pending)")
    expect(markup).not.toContain("Order total")
    expect(markup).not.toContain("<div>0 sats</div>")
  })

  it("flags contradictory shipping statuses and recorded amounts", () => {
    const manualWithAmount = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "manual-conflict-item",
            title: "Manual Conflict Item",
            format: "physical",
            quantity: 1,
            priceAtPurchase: 750,
            currency: "SATS",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={750}
        shippingCostSats={100}
        shippingCostStatus="manual"
        total={850}
        currency="SATS"
      />
    )
    const notRequiredWithAmount = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "not-required-conflict-item",
            title: "Not Required Conflict Item",
            format: "digital",
            quantity: 1,
            priceAtPurchase: 750,
            currency: "SATS",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={750}
        shippingCostSats={100}
        shippingCostStatus="not_required"
        total={850}
        currency="SATS"
      />
    )

    expect(manualWithAmount).toContain("Conflicting shipping data")
    expect(notRequiredWithAmount).toContain("Conflicting shipping data")
  })

  it("keeps included shipping explicit when the amount was not recorded", () => {
    const markup = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "included-shipping-item",
            title: "Included Shipping Item",
            format: "physical",
            quantity: 1,
            priceAtPurchase: 750,
            currency: "SATS",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={750}
        shippingCostSats={null}
        shippingCostStatus="included"
        total={750}
        currency="SATS"
      />
    )

    expect(markup).toContain("Included")
    expect(markup).not.toContain("Not recorded")
  })

  it("warns when a known sats breakdown differs from the order total", () => {
    const markup = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "mismatched-item",
            title: "Mismatched Item",
            format: "physical",
            quantity: 2,
            priceAtPurchase: 500,
            currency: "SATS",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={1_000}
        shippingCostSats={250}
        shippingCostStatus="priced"
        total={1_300}
        currency="SATS"
      />
    )
    const text = markup
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")

    expect(markup).toContain('role="alert"')
    expect(text).toContain(
      "This recorded breakdown differs from the order total by 50 sats. Review the recorded amounts."
    )
    expect(text).not.toContain("before invoicing")
  })

  it("shows an unavailable mixed-currency subtotal without a false mismatch", () => {
    const markup = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "sats-item",
            title: "Sats Item",
            format: "physical",
            quantity: 2,
            priceAtPurchase: 500,
            currency: "SATS",
          },
          {
            productId: "usd-item",
            title: "USD Item",
            format: "physical",
            quantity: 1,
            priceAtPurchase: 10,
            currency: "USD",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={null}
        shippingCostSats={0}
        shippingCostStatus="priced"
        total={1_000}
        currency="SATS"
      />
    )

    expect(markup).toContain("Not available")
    expect(markup).not.toContain('role="alert"')
    expect(markup).not.toContain(
      "This recorded breakdown differs from the order total"
    )
  })

  it("explains why sats shipping cannot reconcile with a non-sats order", () => {
    const markup = renderToStaticMarkup(
      <OrderItemsCard
        items={[
          {
            productId: "usd-item-with-sats-shipping",
            title: "USD Item With Sats Shipping",
            format: "physical",
            quantity: 1,
            priceAtPurchase: 10,
            currency: "USD",
          },
        ]}
        productLookup={productLookup}
        itemSubtotal={10}
        shippingCostSats={500}
        shippingCostStatus="priced"
        total={10}
        currency="USD"
      />
    )

    expect(markup).toContain("recorded separately in sats")
    expect(markup).toContain("cannot be reconciled")
    expect(markup).not.toContain('role="alert"')
  })
})

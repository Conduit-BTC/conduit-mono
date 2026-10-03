import { expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { calculateCheckoutSparkBuyerPrice } from "@conduit/core"
import { CheckoutCoordinationSummary } from "../apps/market/src/components/CheckoutCoordinationSummary"

it("shows the four buyer totals inline without exposing splits or adding a click", () => {
  const html = renderToStaticMarkup(
    <CheckoutCoordinationSummary
      price={calculateCheckoutSparkBuyerPrice({
        itemSubtotalSats: 1_000,
        shippingSubtotalSats: 0,
      })}
    />
  )
  for (const text of [
    "Item subtotal",
    "Shipping subtotal",
    "Coordination fee",
    "Order total",
    "1,000 sats",
    "113 sats",
    "1,113 sats",
    "111-sat minimum + network estimate",
  ]) {
    expect(html).toContain(text)
  }
  for (const text of [
    "Supplier",
    "Merchant",
    "weight",
    "allocation",
    "@",
    "dialog",
    "<button",
  ])
    expect(html).not.toContain(text)
})

it("labels the percentage separately from the added network estimate", () => {
  const html = renderToStaticMarkup(
    <CheckoutCoordinationSummary
      price={calculateCheckoutSparkBuyerPrice({
        itemSubtotalSats: 90_000,
        shippingSubtotalSats: 10_000,
      })}
    />
  )
  expect(html).toContain("2.1% + network estimate")
  expect(html).toContain("2,250 sats")
  expect(html).toContain("10,000 sats")
  expect(html).toContain("102,250 sats")
  expect(html).not.toContain("111-sat minimum")
})

it("preserves the frozen historical funding total instead of adding today's allowance", () => {
  const price = calculateCheckoutSparkBuyerPrice({
    itemSubtotalSats: 1_000,
    shippingSubtotalSats: 0,
  })
  const html = renderToStaticMarkup(
    <CheckoutCoordinationSummary
      price={{
        ...price,
        networkAllowanceSats: 0,
        coordinationFeeSats: 111,
        totalSats: 1_111,
      }}
    />
  )
  expect(html).toContain("1,111 sats")
  expect(html).not.toContain("1,113 sats")
  expect(html).not.toContain("+ network estimate")
})

it("clearly marks checkout estimates while saved order totals stay exact", () => {
  const price = calculateCheckoutSparkBuyerPrice({
    itemSubtotalSats: 1_000,
    shippingSubtotalSats: 0,
  })
  expect(
    renderToStaticMarkup(<CheckoutCoordinationSummary price={price} estimate />)
  ).toContain("Estimated order total")
  expect(
    renderToStaticMarkup(<CheckoutCoordinationSummary price={price} />)
  ).not.toContain("Estimated order total")
})

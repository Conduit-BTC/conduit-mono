import { expect, it } from "bun:test"
import { projectEventMarketOrganizerMerchandise } from "@conduit/core/protocol/event-market-organizer-merchandise"
import { checkoutSparkEventMarketFixture } from "./support/checkout-spark-event-market-fixture"

it("shows the exact frozen variation rather than a later signed listing revision", () => {
  const f = checkoutSparkEventMarketFixture({ variation: true })
  const current = f.signMerchant({
    ...f.events.product,
    created_at: f.events.product.created_at + 5,
    tags: f.events.product.tags.map((tag) =>
      tag[0] === "title"
        ? ["title", "Later changed product"]
        : tag[0] === "spec"
          ? ["spec", "size", "small"]
          : tag
    ),
  })
  const projected = projectEventMarketOrganizerMerchandise({
    merchantPubkey: f.merchantPubkey,
    eventMarket: f.eventMarket,
    commerceQuote: f.plan.commerceQuote,
    sourceEvents: [current, ...f.sourceEvents],
  })
  expect(projected).toEqual({
    state: "ready",
    lines: [
      {
        productCoordinate: f.eventMarket.lines[0]!.productCoordinate,
        title: "Fixture apples",
        familyTitle: "Fixture fruit",
        quantity: 1,
        specifications: [{ key: "size", value: "large" }],
      },
    ],
  })
})

it("does not substitute missing, altered or mismatched merchandise and variation evidence", () => {
  const f = checkoutSparkEventMarketFixture({ variation: true })
  const input = {
    merchantPubkey: f.merchantPubkey,
    eventMarket: f.eventMarket,
    commerceQuote: f.plan.commerceQuote,
    sourceEvents: f.sourceEvents,
  }
  const missingProduct = f.sourceEvents.filter(
    (event) => event.id !== f.events.product.id
  )
  const missingParent = f.sourceEvents.filter(
    (event) => event.id !== f.events.parentProduct!.id
  )
  const alteredProduct = f.sourceEvents.map((event) =>
    event.id === f.events.product.id
      ? { ...event, content: "Altered after signing" }
      : event
  )
  const conflictingProduct = [
    ...f.sourceEvents,
    { ...f.events.product, content: "Conflicting same-id details" },
  ]
  for (const sourceEvents of [
    missingProduct,
    missingParent,
    alteredProduct,
    conflictingProduct,
  ])
    expect(
      projectEventMarketOrganizerMerchandise({ ...input, sourceEvents }).state
    ).toBe("unavailable")
  const changedQuote = {
    ...f.plan.commerceQuote,
    lines: f.plan.commerceQuote.lines.map((line) => ({
      ...line,
      variation: {
        ...line.variation!,
        specifications: [{ key: "size", value: "small" }],
      },
    })),
  }
  expect(
    projectEventMarketOrganizerMerchandise({
      ...input,
      commerceQuote: changedQuote,
    }).state
  ).toBe("unavailable")
  expect(
    projectEventMarketOrganizerMerchandise({
      ...input,
      eventMarket: {
        ...f.eventMarket,
        lines: f.eventMarket.lines.map((line) => ({ ...line, quantity: 2 })),
      },
    }).state
  ).toBe("unavailable")
})

it("retains the established signed-product display fallback when no explicit title tag exists", () => {
  const f = checkoutSparkEventMarketFixture()
  const product = f.signMerchant({
    ...f.events.product,
    tags: f.events.product.tags.filter((tag) => tag[0] !== "title"),
  })
  const projected = projectEventMarketOrganizerMerchandise({
    merchantPubkey: f.merchantPubkey,
    eventMarket: {
      ...f.eventMarket,
      lines: f.eventMarket.lines.map((line) => ({
        ...line,
        productEventId: product.id,
      })),
    },
    commerceQuote: {
      ...f.plan.commerceQuote,
      lines: f.plan.commerceQuote.lines.map((line) => ({
        ...line,
        productEventId: product.id,
      })),
    },
    sourceEvents: f.sourceEvents.map((event) =>
      event.id === f.events.product.id ? product : event
    ),
  })
  expect(projected.state).toBe("ready")
  if (projected.state !== "ready")
    throw new Error("Expected signed item details")
  expect(projected.lines[0]!.title).toBe("Fixture apples")
})

import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return Bun.file(path).text()
}

describe("Market event product layout", () => {
  it("shares the standard responsive product grid with the main catalog", async () => {
    const [card, products, event, browser] = await Promise.all([
      source("apps/market/src/components/ProductGridCard.tsx"),
      source("apps/market/src/routes/products/index.tsx"),
      source("apps/market/src/routes/events/$collectionRef.tsx"),
      source("apps/market/src/components/EventCatalogBrowser.tsx"),
    ])

    expect(card).toContain("export const PRODUCT_GRID_CLASS_NAME")
    expect(card).toContain(
      "grid list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4"
    )
    expect(products.match(/className={PRODUCT_GRID_CLASS_NAME}/g)?.length).toBe(
      2
    )
    expect(event).toContain("<EventCatalogBrowser")
    expect(browser).toContain(
      'import { PRODUCT_GRID_CLASS_NAME } from "./ProductGridCard"'
    )
    expect(browser).toContain(
      "<ul className={`${PRODUCT_GRID_CLASS_NAME} items-start`}>"
    )
    expect(browser).not.toContain(
      'className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3"'
    )
  })

  it("keeps pickup notices and clarification boxes outside the product grid", async () => {
    const [card, event] = await Promise.all([
      source("apps/market/src/components/ProductGridCard.tsx"),
      source("apps/market/src/routes/events/$collectionRef.tsx"),
    ])

    expect(card).toContain('className ?? "h-full"')
    expect(event).toContain('className="h-auto"')
    expect(event).not.toContain('<details className="group/pickup')
    expect(event).not.toContain("Current pickup terms are being verified")
    expect(event).toContain("cartActionDisabled={!cartAction.enabled}")
  })

  it("allows floating variation panels outside the event catalog on hover-capable desktops", async () => {
    const browser = await source(
      "apps/market/src/components/EventCatalogBrowser.tsx"
    )

    expect(browser).toContain(
      "<ul className={`${PRODUCT_GRID_CLASS_NAME} items-start`}>"
    )
    expect(browser).not.toContain("overflow-hidden")
  })

  it("shows the pickup handler in checkout review", async () => {
    const checkout = await source("apps/market/src/routes/checkout.tsx")
    expect(checkout).toContain("{pickupHandoff.label}")
    expect(checkout).toContain("Handled by <EventActorName")
  })
})

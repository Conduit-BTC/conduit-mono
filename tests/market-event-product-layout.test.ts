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

  it("keeps pickup disclosure from stretching the standard product card", async () => {
    const [card, event] = await Promise.all([
      source("apps/market/src/components/ProductGridCard.tsx"),
      source("apps/market/src/routes/events/$collectionRef.tsx"),
    ])

    expect(card).toContain('className ?? "h-full"')
    expect(event).toContain('className="h-auto"')
    expect(event).toContain('<details className="group/pickup')
    expect(event).toContain("[&::-webkit-details-marker]:hidden")
    expect(event).toContain("getPickupHandoffPrivacyCopy(handoff)")
    expect(event).toContain("<EventActorName")
    expect(event).toContain("<EventActorProvenance")
    expect(event).toContain('copyLabel="Copy pickup handler npub"')
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

  it("keeps long handler names compact while Details reveals the full identity", async () => {
    const event = await source(
      "apps/market/src/routes/events/$collectionRef.tsx"
    )
    const pickupStart = event.indexOf('<details className="group/pickup')
    const pickupEnd = event.indexOf("</details>", pickupStart)
    const pickupDetails = event.slice(pickupStart, pickupEnd)

    expect(pickupStart).toBeGreaterThan(-1)
    expect(pickupEnd).toBeGreaterThan(pickupStart)
    expect(pickupDetails).toContain('className="min-w-0 flex-1"')
    expect(pickupDetails).toContain('className="block truncate"')
    expect(pickupDetails).toContain(
      "title={`Handled by ${handlerIdentity.displayName}`}"
    )
    expect(
      pickupDetails.match(/<EventActorName identity=\{handlerIdentity\}\s*\/>/g)
    ).toHaveLength(2)
  })
})

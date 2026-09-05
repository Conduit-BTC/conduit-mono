import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return Bun.file(path).text()
}

describe("Market event product layout", () => {
  it("shares the standard responsive product grid with the main catalog", async () => {
    const [card, products, event] = await Promise.all([
      source("apps/market/src/components/ProductGridCard.tsx"),
      source("apps/market/src/routes/products/index.tsx"),
      source("apps/market/src/routes/events/$collectionRef.tsx"),
    ])

    expect(card).toContain("export const PRODUCT_GRID_CLASS_NAME")
    expect(card).toContain(
      "grid list-none grid-cols-2 gap-3 p-0 sm:gap-4 md:grid-cols-3 lg:grid-cols-4"
    )
    expect(products.match(/className={PRODUCT_GRID_CLASS_NAME}/g)?.length).toBe(
      2
    )
    expect(event).toContain(
      "className={`mt-6 ${PRODUCT_GRID_CLASS_NAME} items-start`}"
    )
    expect(event).not.toContain(
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
    expect(event).toContain('label="Copy pickup handler npub"')
  })

  it("allows floating variation panels outside the event catalog on hover-capable desktops", async () => {
    const event = await source(
      "apps/market/src/routes/events/$collectionRef.tsx"
    )

    expect(event).toContain(
      'className="overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)] [@media(min-width:768px)_and_(hover:hover)]:overflow-visible"'
    )
    expect(event).toContain(
      'className="h-48 w-full rounded-t-3xl border-b border-[var(--border)] object-cover sm:h-64"'
    )
  })
})

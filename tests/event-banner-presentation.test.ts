import { describe, expect, it } from "bun:test"

const eventBannerSurfaces = [
  {
    label: "shopper event catalog",
    path: "apps/market/src/routes/events/$collectionRef.tsx",
    imageSource: "src={calendar.image ?? collection.image}",
  },
  {
    label: "merchant participation view",
    path: "apps/merchant/src/components/MerchantEventMarketPanel.tsx",
    imageSource: "src={market.imageUrl}",
  },
  {
    label: "organizer event view",
    path: "apps/merchant/src/components/OrganizerEventMarketPanel.tsx",
    imageSource: "src={market.imageUrl}",
  },
] as const

describe("event banner presentation", () => {
  it("fits the complete banner without cropping on every event surface", async () => {
    for (const surface of eventBannerSurfaces) {
      const source = await Bun.file(surface.path).text()
      const imageStart = source.indexOf(surface.imageSource)

      expect(imageStart, surface.label).toBeGreaterThanOrEqual(0)

      const imageMarkup = source.slice(imageStart, imageStart + 320)
      expect(imageMarkup, surface.label).toContain("object-contain")
      expect(imageMarkup, surface.label).not.toContain("object-cover")
      expect(imageMarkup, surface.label).toContain(
        "bg-[var(--surface-elevated)]"
      )
    }
  })

  it("gives organizers dimensions and safe-area guidance", async () => {
    const editor = await Bun.file(
      "apps/merchant/src/components/OrganizerEventMarketEditor.tsx"
    ).text()

    expect(editor).toContain("3:1")
    expect(editor).toMatch(/outer\s+edges/)
    expect(editor).toMatch(/without\s+cropping/)
  })
})

import { describe, expect, it } from "bun:test"

const eventBannerConsumers = [
  {
    label: "shopper event catalog",
    path: "apps/market/src/routes/events/$collectionRef.tsx",
    imageSource: "imageUrl={calendar.image ?? collection.image}",
  },
  {
    label: "merchant participation view",
    path: "apps/merchant/src/components/MerchantEventMarketPanel.tsx",
    imageSource: "imageUrl={market.imageUrl}",
  },
  {
    label: "organizer event view",
    path: "apps/merchant/src/components/OrganizerEventMarketPanel.tsx",
    imageSource: "imageUrl={market.imageUrl}",
  },
] as const

describe("event banner presentation", () => {
  it("fits the complete banner without cropping on every event surface", async () => {
    const sharedHeader = await Bun.file(
      "packages/ui/src/components/EventPageHeader.tsx"
    ).text()
    const imageStart = sharedHeader.indexOf("src={normalizedImageUrl}")

    expect(imageStart).toBeGreaterThanOrEqual(0)

    const imageMarkup = sharedHeader.slice(imageStart, imageStart + 320)
    expect(imageMarkup).toContain("object-contain")
    expect(imageMarkup).not.toContain("object-cover")
    expect(imageMarkup).toContain("bg-[var(--surface-elevated)]")

    for (const surface of eventBannerConsumers) {
      const source = await Bun.file(surface.path).text()
      expect(source, surface.label).toContain("<EventPageHeader")
      expect(source, surface.label).toContain(surface.imageSource)
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

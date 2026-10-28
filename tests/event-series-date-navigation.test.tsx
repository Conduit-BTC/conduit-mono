import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { EventSeriesDateNavigation } from "../packages/ui/src/components/EventSeriesDateNavigation"

const dates = [
  {
    coordinate: "first",
    label: "October 27",
    href: "/events/fair?occurrence=first",
  },
  {
    coordinate: "second",
    label: "November 3",
    href: "/events/fair?occurrence=second",
  },
]

describe("Event series date navigation", () => {
  it("links to other dates without asking buyers to choose the date they already opened", () => {
    const html = renderToStaticMarkup(
      <EventSeriesDateNavigation dates={dates} currentCoordinate="first" />
    )
    expect(html).toContain('aria-label="Other dates in this series"')
    expect(html).toContain('href="/events/fair?occurrence=second"')
    expect(html).toContain("November 3")
    expect(html).not.toContain('href="/events/fair?occurrence=first"')
    expect(html).not.toContain("Choose date")
    expect(html).not.toContain("<select")
  })

  it("omits a redundant navigation control for a selected single-date series", () => {
    expect(
      renderToStaticMarkup(
        <EventSeriesDateNavigation
          dates={dates.slice(0, 1)}
          currentCoordinate="first"
        />
      )
    ).toBe("")
    expect(renderToStaticMarkup(<EventSeriesDateNavigation dates={[]} />)).toBe(
      ""
    )
  })

  it("retains explicit date navigation when a shared series link has no selected occurrence", () => {
    const html = renderToStaticMarkup(
      <EventSeriesDateNavigation dates={dates.slice(0, 1)} />
    )
    expect(html).toContain('aria-label="Dates in this series"')
    expect(html).toContain('href="/events/fair?occurrence=first"')
  })

  it("keeps unresolved signed members visible without inventing a destination", () => {
    const html = renderToStaticMarkup(
      <EventSeriesDateNavigation
        currentCoordinate="first"
        dates={[
          dates[0]!,
          {
            coordinate: "missing",
            label: "Date details unavailable",
            unavailableReason: "Refresh the event to check this date.",
          },
        ]}
      />
    )
    expect(html).toContain("Other dates in this series")
    expect(html).toContain("Date details unavailable")
    expect(html).toContain("Refresh the event to check this date.")
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain("href=")
  })

  it("does not turn unavailable or ended dates into navigation links", () => {
    const html = renderToStaticMarkup(
      <EventSeriesDateNavigation
        currentCoordinate="first"
        dates={[
          dates[0]!,
          { ...dates[1]!, unavailableReason: "This date has ended." },
        ]}
      />
    )
    expect(html).toContain("November 3")
    expect(html).toContain("This date has ended.")
    expect(html).not.toContain("href=")
  })

  it("wires both event views to canonical series members while preserving route ownership", async () => {
    const shop = await Bun.file(
      "apps/market/src/components/FutureEventMarketPage.tsx"
    ).text()
    const merchant = await Bun.file(
      "apps/merchant/src/components/FutureEventMarketManager.tsx"
    ).text()
    expect(shop).toContain("<EventSeriesDateNavigation")
    expect(shop).toContain("series.series.memberCoordinates.map(")
    expect(shop).toContain("onNavigate={onOccurrenceChange}")
    expect(shop).not.toContain('aria-label="Choose date"')
    expect(merchant).toContain("<EventSeriesDateNavigation")
    expect(merchant).toContain("series.series.memberCoordinates.map(")
    expect(merchant).toContain("onNavigate={onSelectOccurrence}")
    expect(merchant).toContain("Choose date to edit")
  })
})

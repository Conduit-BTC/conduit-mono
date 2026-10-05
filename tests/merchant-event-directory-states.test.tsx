import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MerchantEventTimelineEmptyState } from "../apps/merchant/src/components/MerchantEventsTimeline"

describe("Merchant event discovery presentation", () => {
  it.each([false, true])(
    "shows scoped absence without a retry prompt when limited=%s",
    (limited) => {
      const html = renderToStaticMarkup(
        <MerchantEventTimelineEmptyState relationship="all" limited={limited} />
      )
      expect(html).toContain("No events found on your relays")
      expect(html).not.toContain('role="alert"')
      expect(html).not.toContain("Retry")
      expect(html.includes("Some relay checks did not finish.")).toBe(limited)
    }
  )
  it("preserves actual connection failure and known unreadable dates as distinct states", () => {
    const offline = renderToStaticMarkup(
      <MerchantEventTimelineEmptyState relationship="all" unavailable />
    )
    const missingDates = renderToStaticMarkup(
      <MerchantEventTimelineEmptyState
        relationship="all"
        datesUnavailable
        unavailable
      />
    )
    expect(offline).toContain("Couldn’t connect to your relays")
    expect(missingDates).toContain("Event dates are unavailable")
    for (const html of [offline, missingDates])
      expect(html).not.toContain("No events found")
  })
})

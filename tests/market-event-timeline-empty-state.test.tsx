import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { EventTimelineEmptyState } from "../apps/market/src/components/EventTimelineEmptyState"

function renderState(
  discoveryState: Parameters<
    typeof EventTimelineEmptyState
  >[0]["discoveryState"],
  overrides: Partial<Parameters<typeof EventTimelineEmptyState>[0]> = {}
) {
  return renderToStaticMarkup(
    <EventTimelineEmptyState
      discoveryState={discoveryState}
      hasError={false}
      refreshIncomplete={false}
      {...overrides}
    />
  )
}

describe("Market event timeline empty state", () => {
  it("reports ordinary absence only after a completed empty read", () => {
    const markup = renderState("complete_empty")

    expect(markup).toContain("No events found.")
    expect(markup).not.toContain('role="alert"')
    expect(markup).not.toContain("couldn&#x27;t be loaded")
  })

  it.each(["partial", "unavailable"] as const)(
    "offers refresh instead of claiming absence for %s discovery",
    (state) => {
      const markup = renderState(state)

      expect(markup).toContain('role="alert"')
      expect(markup).toContain(
        "Events couldn&#x27;t be loaded. Refresh to try again."
      )
      expect(markup).not.toContain("No events found.")
    }
  )

  it("does not claim absence after a stale or failed refresh", () => {
    for (const markup of [
      renderState("complete_empty", { refreshIncomplete: true }),
      renderState("complete_empty", { hasError: true }),
    ]) {
      expect(markup).toContain('role="alert"')
      expect(markup).toContain("Events couldn&#x27;t be loaded")
      expect(markup).not.toContain("No events found.")
    }
  })
})

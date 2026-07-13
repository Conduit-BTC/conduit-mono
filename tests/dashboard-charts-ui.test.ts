import { describe, expect, it } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  OrdersOverTimeChart,
  RevenueOverTimeChart,
} from "../apps/merchant/src/components/DashboardCharts"
import type { TimeBucketPoint } from "../apps/merchant/src/lib/dashboard-charts"

function chartPoints(): TimeBucketPoint[] {
  return Array.from({ length: 30 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    label:
      index === 0 ? "Jun 13" : index === 29 ? "Jul 12" : `Jun ${index + 13}`,
    value: index === 14 ? 3 : 0,
  }))
}

describe("dashboard chart presentation", () => {
  it("renders x-axis labels outside the non-uniformly scaled SVG", () => {
    const markup = renderToStaticMarkup(
      createElement(OrdersOverTimeChart, { points: chartPoints() })
    )
    const svgEnd = markup.indexOf("</svg>")

    expect(svgEnd).toBeGreaterThan(0)
    expect(markup.slice(0, svgEnd)).not.toContain("<text")
    expect(markup.indexOf("Jun 13")).toBeGreaterThan(svgEnd)
    expect(markup.indexOf("Jul 12")).toBeGreaterThan(svgEnd)
  })

  it("gives the revenue plot its own accessible name", () => {
    const markup = renderToStaticMarkup(
      createElement(RevenueOverTimeChart, {
        points: chartPoints(),
        hasRevenue: true,
      })
    )

    expect(markup).toContain('aria-label="Paid revenue over time"')
  })
})

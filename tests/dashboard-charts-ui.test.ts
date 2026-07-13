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
    date: index,
    label:
      index === 0 ? "Jun 13" : index === 29 ? "Jul 12" : `Jun ${index + 13}`,
    value: index === 14 ? 3 : 0,
  }))
}

describe("dashboard chart presentation", () => {
  it("renders x-axis labels outside the non-uniformly scaled SVG", () => {
    const markup = renderToStaticMarkup(
      createElement(OrdersOverTimeChart, {
        points: chartPoints(),
        range: "30d",
        onRangeChange: () => {},
      })
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
        range: "30d",
        onRangeChange: () => {},
      })
    )

    expect(markup).toContain(
      'aria-label="Paid revenue over time, Past 30 days"'
    )
  })

  it("labels each chart range selector and shows the active preset", () => {
    const markup = renderToStaticMarkup(
      createElement(OrdersOverTimeChart, {
        points: chartPoints(),
        range: "30d",
        onRangeChange: () => {},
      })
    )

    expect(markup).toContain('aria-label="Time range for Orders over time"')
    expect(markup).toContain("Past 30 days")
  })

  it("renders every daily label in the past-week preset", () => {
    const points = Array.from({ length: 7 }, (_, index) => ({
      date: index,
      label: `Day ${index + 1}`,
      axisLabel: `D${index + 1}`,
      value: index + 1,
    }))
    const markup = renderToStaticMarkup(
      createElement(RevenueOverTimeChart, {
        points,
        hasRevenue: true,
        range: "week",
        onRangeChange: () => {},
      })
    )

    for (const point of points) {
      expect(markup).toContain(point.axisLabel)
    }
  })

  it("renders only explicitly selected labels for dense daily bars", () => {
    const points = Array.from({ length: 30 }, (_, index) => ({
      date: index,
      label: `Day ${index + 1}`,
      axisLabel: `Axis ${index + 1}`,
      showAxisLabel: index % 3 === 0,
      value: index + 1,
    }))
    const markup = renderToStaticMarkup(
      createElement(OrdersOverTimeChart, {
        points,
        range: "30d",
        onRangeChange: () => {},
      })
    )

    expect(markup).toContain("Axis 1")
    expect(markup).toContain("Axis 4")
    expect(markup).not.toContain(">Axis 2</span>")
  })
})

import { describe, expect, it } from "bun:test"
import { buildOrderStatusTimeline, getOrderStatusDisplay } from "@conduit/core"

describe("getOrderStatusDisplay", () => {
  it("maps known statuses to a tone + label", () => {
    expect(getOrderStatusDisplay("pending")).toEqual({
      tone: "warning",
      label: "Pending",
    })
    expect(getOrderStatusDisplay("delivered")).toEqual({
      tone: "success",
      label: "Delivered",
    })
    expect(getOrderStatusDisplay("cancelled")).toEqual({
      tone: "neutral",
      label: "Cancelled",
    })
  })

  it("defaults empty status to pending and title-cases unknown ones", () => {
    expect(getOrderStatusDisplay(null)).toEqual({
      tone: "warning",
      label: "Pending",
    })
    expect(getOrderStatusDisplay("awaiting_fulfillment")).toEqual({
      tone: "neutral",
      label: "Awaiting Fulfillment",
    })
  })
})

describe("buildOrderStatusTimeline", () => {
  const stepStatuses = (status: string) =>
    buildOrderStatusTimeline(status).map((row) => row.status)

  it("completes stages up to the current status and marks the next in progress", () => {
    expect(stepStatuses("pending")).toEqual([
      "complete",
      "in_progress",
      "waiting",
      "waiting",
      "waiting",
    ])
    expect(stepStatuses("shipped")).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "in_progress",
    ])
    expect(stepStatuses("delivered")).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "complete",
    ])
  })

  it("marks the payment stage failed when cancelled", () => {
    const rows = buildOrderStatusTimeline("cancelled")
    expect(rows.map((row) => row.status)).toEqual([
      "complete",
      "failed",
      "waiting",
      "waiting",
      "waiting",
    ])
    expect(rows[1]?.label).toBe("Cancelled")
  })
})

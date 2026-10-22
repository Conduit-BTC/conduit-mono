import { expect, it } from "bun:test"
import { formatEventAssignmentDate } from "../apps/merchant/src/components/EventAssignmentPanel"

it("keeps a date-only event on its signed day in a negative-offset timezone", () => {
  const previousTimezone = process.env.TZ
  try {
    process.env.TZ = "America/New_York"
    expect(
      formatEventAssignmentDate({
        kind: 31922,
        start: Date.parse("2026-10-22T00:00:00.000Z"),
        startDate: "2026-10-22",
      })
    ).toBe("2026-10-22")
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
})

it.each(["America/New_York", "Pacific/Auckland"])(
  "preserves date-only fallback and existing timed labels in %s",
  (timezone) => {
    const previousTimezone = process.env.TZ
    try {
      process.env.TZ = timezone
      const start = Date.parse("2026-10-22T00:00:00.000Z")
      expect(formatEventAssignmentDate({ kind: 31922, start })).toBe(
        "2026-10-22"
      )
      expect(formatEventAssignmentDate({ kind: 31923, start })).toBe(
        new Date(start).toLocaleDateString()
      )
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  }
)

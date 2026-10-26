import { expect, it } from "bun:test"

const componentUrl = new URL(
  "../apps/merchant/src/components/EventAssignmentPanel.tsx",
  import.meta.url
).href

function readDateLabelsInTimezone(timezone: string): {
  signedDay: string
  fallbackDay: string
  timedLabel: string
  expectedTimedLabel: string
  timezone: string
} {
  const parentTimezone = process.env.TZ
  const parentIntlTimezone = new Intl.DateTimeFormat().resolvedOptions()
    .timeZone
  // Changing TZ in this process leaves already-created Intl formatters behind.
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `const { formatEventAssignmentDate } = await import(${JSON.stringify(componentUrl)});
       const start = Date.parse("2026-10-22T00:00:00.000Z");
       process.stdout.write(JSON.stringify({
         signedDay: formatEventAssignmentDate({kind: 31922, start, startDate: "2026-10-22"}),
         fallbackDay: formatEventAssignmentDate({kind: 31922, start}),
         timedLabel: formatEventAssignmentDate({kind: 31923, start}),
         expectedTimedLabel: new Date(start).toLocaleDateString(),
         timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
       }));`,
    ],
    env: { ...process.env, TZ: timezone },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode).toBe(0)
  expect(process.env.TZ).toBe(parentTimezone)
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
    parentIntlTimezone
  )
  return JSON.parse(child.stdout.toString())
}

it("keeps a date-only event on its signed day in a negative-offset timezone", () => {
  const labels = readDateLabelsInTimezone("America/New_York")
  expect(labels.timezone).toBe("America/New_York")
  expect(labels.signedDay).toBe("2026-10-22")
})

it.each(["America/New_York", "Pacific/Auckland"])(
  "preserves date-only fallback and existing timed labels in %s",
  (timezone) => {
    const labels = readDateLabelsInTimezone(timezone)
    expect(labels.timezone).toBe(timezone)
    expect(labels.fallbackDay).toBe("2026-10-22")
    expect(labels.timedLabel).toBe(labels.expectedTimedLabel)
  }
)

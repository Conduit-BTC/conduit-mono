import { describe, expect, it } from "bun:test"

import {
  checkTelemetryPolicy,
  parseTelemetryEventMarkers,
  validateTelemetryEvents,
  validateTelemetrySourceUsage,
} from "../scripts/ci/check_telemetry_policy"

describe("telemetry policy", () => {
  it("parses telemetry event markers", () => {
    const events = parseTelemetryEventMarkers(
      "<!-- telemetry-event: relay_publish_result properties=event_name,app,network,status,count,time_bucket -->"
    )

    expect(events).toEqual([
      {
        eventName: "relay_publish_result",
        properties: [
          "event_name",
          "app",
          "network",
          "status",
          "count",
          "time_bucket",
        ],
      },
    ])
  })

  it("rejects properties outside the public privacy allowlist", () => {
    const errors = validateTelemetryEvents([
      {
        eventName: "checkout_result",
        properties: ["event_name", "app", "pubkey"],
      },
    ])

    expect(errors).toContain(
      "Telemetry event checkout_result uses disallowed property: pubkey"
    )
  })

  it("validates the repo telemetry allowlist", () => {
    expect(checkTelemetryPolicy(process.cwd()).errors).toEqual([])
  })

  it("rejects source telemetry calls outside the allowlist", () => {
    const errors = validateTelemetrySourceUsage({
      source: 'posthog.capture("merchant_pubkey_seen", { app: "market" })',
      relativePath: "apps/market/src/analytics.ts",
      allowedEventNames: new Set(["relay_publish_result"]),
    })

    expect(errors).toContain(
      "apps/market/src/analytics.ts uses telemetry event merchant_pubkey_seen outside docs/analytics/events.md"
    )
  })

  it("rejects sensitive source telemetry payload fields", () => {
    const errors = validateTelemetrySourceUsage({
      source: 'trackTelemetry("checkout_result", { app: "market", pubkey })',
      relativePath: "apps/market/src/analytics.ts",
      allowedEventNames: new Set(["checkout_result"]),
    })

    expect(errors).toContain(
      "apps/market/src/analytics.ts includes sensitive telemetry property pubkey"
    )
  })
})

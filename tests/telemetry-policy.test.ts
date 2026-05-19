import { describe, expect, it } from "bun:test"

import {
  checkTelemetryPolicy,
  parseTelemetryEventMarkers,
  validateTelemetryEvents,
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
})

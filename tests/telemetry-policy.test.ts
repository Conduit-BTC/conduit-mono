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

  it("allows provider pageview events without adding product analytics events", () => {
    const errors = validateTelemetrySourceUsage({
      source:
        'window.plausible?.("pageview", { url: "/" }); client?.capture("$pageview", { app: "merchant" })',
      relativePath: "packages/core/src/telemetry.ts",
      allowedEventNames: new Set(["relay_publish_result"]),
    })

    expect(errors).toEqual([])
  })

  it("rejects provider pageview events outside the shared wrapper", () => {
    const errors = validateTelemetrySourceUsage({
      source:
        'posthog.capture("$pageview", { app: "market", $pathname: window.location.pathname })',
      relativePath: "apps/market/src/analytics.ts",
      allowedEventNames: new Set(["relay_publish_result"]),
    })

    expect(errors).toContain(
      "apps/market/src/analytics.ts uses provider telemetry event $pageview outside the shared telemetry wrapper"
    )
  })

  it("allows literal browser telemetry events from the shared wrapper", () => {
    const errors = validateTelemetrySourceUsage({
      source:
        'recordBrowserTelemetryEvent({ app: "market", eventName: "cart_add", properties: { app: "market", status: "success", count_bucket: "1" } })',
      relativePath: "apps/market/src/hooks/useCart.ts",
      allowedEventNames: new Set(["cart_add"]),
    })

    expect(errors).toEqual([])
  })

  it("rejects browser telemetry wrapper calls without a literal event", () => {
    const errors = validateTelemetrySourceUsage({
      source:
        'recordBrowserTelemetryEvent({ app: "market", eventName, properties: { app: "market" } })',
      relativePath: "apps/market/src/hooks/useCart.ts",
      allowedEventNames: new Set(["cart_add"]),
    })

    expect(errors).toContain(
      "apps/market/src/hooks/useCart.ts includes a telemetry call without a literal allowlisted event name"
    )
  })

  it("rejects a nonliteral browser telemetry event before a later literal call", () => {
    const errors = validateTelemetrySourceUsage({
      source:
        'recordBrowserTelemetryEvent({ app: "market", eventName, properties: { app: "market" } }); recordBrowserTelemetryEvent({ app: "market", eventName: "cart_add", properties: { status: "success" } })',
      relativePath: "apps/market/src/hooks/useCart.ts",
      allowedEventNames: new Set(["cart_add"]),
    })

    expect(errors).toContain(
      "apps/market/src/hooks/useCart.ts includes a telemetry call without a literal allowlisted event name"
    )
  })

  it("rejects PostHog identity APIs and unsafe capture config", () => {
    const errors = validateTelemetrySourceUsage({
      source:
        'posthog.identify(pubkey); client?.identify(pubkey); client.register({ merchant: true }); posthog.init("key", { autocapture: true, disable_session_recording: false })',
      relativePath: "apps/market/src/analytics.ts",
      allowedEventNames: new Set(["checkout_result"]),
    })

    expect(errors).toContain(
      "apps/market/src/analytics.ts uses forbidden PostHog identity/profile API posthog.identify("
    )
    expect(errors).toContain(
      "apps/market/src/analytics.ts uses forbidden PostHog identity/profile API client?.identify("
    )
    expect(errors).toContain(
      "apps/market/src/analytics.ts uses forbidden PostHog identity/profile API client.register("
    )
    expect(errors).toContain(
      "apps/market/src/analytics.ts has unsafe telemetry config: autocapture must stay disabled"
    )
    expect(errors).toContain(
      "apps/market/src/analytics.ts has unsafe telemetry config: PostHog session recording must stay disabled"
    )
  })
})

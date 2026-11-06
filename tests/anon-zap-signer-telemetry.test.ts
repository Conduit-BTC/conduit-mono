import { describe, expect, it } from "bun:test"

import {
  getAnonZapSignerLatencyBucket,
  recordTelemetryEvent,
  type AnonZapSignerTelemetryProperties,
} from "../apps/anon-zap-signer/src/telemetry"

const PROJECT_KEY = `phc_${"a".repeat(40)}`
const EVENT_PROPERTIES: AnonZapSignerTelemetryProperties = {
  event_name: "anon_zap_signer_request_result",
  app: "anon_zap_signer",
  surface: "worker",
  action: "sign",
  status: "success",
  latency_bucket: "100_499ms",
}

describe("anon zap signer telemetry", () => {
  it("does not send even with a valid project token and properties", async () => {
    let requests = 0
    await recordTelemetryEvent(
      "anon_zap_signer_request_result",
      EVENT_PROPERTIES,
      { POSTHOG_PROJECT_TOKEN: PROJECT_KEY },
      {
        fetchImpl: async () => {
          requests += 1
          throw new Error("must not send")
        },
      }
    )
    expect(requests).toBe(0)
  })

  it("does not send without a valid project key or approved ingest host", async () => {
    let requests = 0
    const fetchImpl = async () => {
      requests += 1
      return new Response(null, { status: 200 })
    }

    await recordTelemetryEvent(
      "anon_zap_signer_request_result",
      EVENT_PROPERTIES,
      { POSTHOG_PROJECT_TOKEN: "invalid" },
      { fetchImpl }
    )
    await recordTelemetryEvent(
      "anon_zap_signer_request_result",
      EVENT_PROPERTIES,
      {
        POSTHOG_PROJECT_TOKEN: PROJECT_KEY,
        POSTHOG_HOST: "https://analytics.example.com",
      },
      { fetchImpl }
    )
    await recordTelemetryEvent(
      "unexpected_event" as "anon_zap_signer_request_result",
      EVENT_PROPERTIES,
      { POSTHOG_PROJECT_TOKEN: PROJECT_KEY },
      { fetchImpl }
    )

    expect(requests).toBe(0)
  })

  it("keeps provider failures out of the signer request path", async () => {
    await expect(
      recordTelemetryEvent(
        "anon_zap_signer_request_result",
        EVENT_PROPERTIES,
        { POSTHOG_PROJECT_TOKEN: PROJECT_KEY },
        {
          async fetchImpl() {
            throw new Error("provider unavailable")
          },
        }
      )
    ).resolves.toBeUndefined()
  })

  it("uses bounded latency buckets", () => {
    expect(getAnonZapSignerLatencyBucket(99)).toBe("lt_100ms")
    expect(getAnonZapSignerLatencyBucket(100)).toBe("100_499ms")
    expect(getAnonZapSignerLatencyBucket(499)).toBe("100_499ms")
    expect(getAnonZapSignerLatencyBucket(500)).toBe("500_1999ms")
    expect(getAnonZapSignerLatencyBucket(1_999)).toBe("500_1999ms")
    expect(getAnonZapSignerLatencyBucket(2_000)).toBe("2s_plus")
  })
})

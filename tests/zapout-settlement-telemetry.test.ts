import { describe, expect, it } from "bun:test"
import type { OmfZapoutReceipt } from "@conduit/core/protocol/lightning"

import { recordZapoutSettlement } from "../apps/market/functions/_lib/zapout-settlement-telemetry"

const PROJECT_TOKEN = `phc_${"a".repeat(40)}`
const HMAC_SECRET = "settlement-telemetry-test-secret-32-bytes-minimum"

function receipt(overrides: Partial<OmfZapoutReceipt> = {}): OmfZapoutReceipt {
  return {
    id: "a".repeat(64),
    createdAt: Date.parse("2026-09-16T17:24:31.000Z") / 1_000,
    receiptPubkey: "b".repeat(64),
    zapRequestId: "c".repeat(64),
    zapRequestCreatedAt: Date.parse("2026-09-16T17:24:25.000Z") / 1_000,
    senderPubkey: "d".repeat(64),
    recipientPubkey: "e".repeat(64),
    amountMsats: 42_000,
    comment: "public comment",
    sourceRelayUrls: ["wss://relay.example"],
    ...overrides,
  }
}

describe("zapout settlement telemetry", () => {
  it("captures only settled sats with a static identity and opaque stable UUID", async () => {
    const payloads: Array<Record<string, unknown>> = []
    const urls: string[] = []
    const fetchImpl = async (input: string, init: RequestInit) => {
      urls.push(input)
      payloads.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(null, { status: 200 })
    }
    const env = {
      POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN,
      ZAPOUT_SETTLEMENT_TELEMETRY_HMAC_SECRET: HMAC_SECRET,
    }

    await recordZapoutSettlement(receipt(), env, { fetchImpl })
    await recordZapoutSettlement(receipt(), env, { fetchImpl })

    expect(urls).toEqual([
      "https://us.i.posthog.com/capture/?ip=0",
      "https://us.i.posthog.com/capture/?ip=0",
    ])
    expect(payloads).toHaveLength(2)
    expect(payloads[0]).toEqual(payloads[1])
    expect(payloads[0]).toEqual({
      token: PROJECT_TOKEN,
      distinct_id: "conduit-zapout-settlement",
      event: "zapout_settled",
      timestamp: "2026-09-16T00:00:00.000Z",
      uuid: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      properties: {
        $process_person_profile: false,
        settled_amount_sats: 42,
      },
    })
    expect(JSON.stringify(payloads[0])).not.toContain("public comment")
    expect(JSON.stringify(payloads[0])).not.toContain("relay.example")
    expect(JSON.stringify(payloads[0])).not.toContain(receipt().id)
  })

  it("uses a different opaque UUID for a different receipt", async () => {
    const uuids: string[] = []
    const fetchImpl = async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { uuid: string }
      uuids.push(body.uuid)
      return new Response(null, { status: 200 })
    }
    const env = {
      POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN,
      ZAPOUT_SETTLEMENT_TELEMETRY_HMAC_SECRET: HMAC_SECRET,
    }

    await recordZapoutSettlement(receipt(), env, { fetchImpl })
    await recordZapoutSettlement(receipt({ id: "f".repeat(64) }), env, {
      fetchImpl,
    })

    expect(new Set(uuids).size).toBe(2)
  })

  it("drops unconfigured, malformed, fractional-sat, and invalid-host events", async () => {
    let requests = 0
    const fetchImpl = async () => {
      requests += 1
      return new Response(null, { status: 200 })
    }

    await recordZapoutSettlement(receipt(), {}, { fetchImpl })
    await recordZapoutSettlement(
      receipt({ amountMsats: 42_001 }),
      {
        POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN,
        ZAPOUT_SETTLEMENT_TELEMETRY_HMAC_SECRET: HMAC_SECRET,
      },
      { fetchImpl }
    )
    await recordZapoutSettlement(
      receipt(),
      {
        POSTHOG_HOST: "https://analytics.example.com",
        POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN,
        ZAPOUT_SETTLEMENT_TELEMETRY_HMAC_SECRET: HMAC_SECRET,
      },
      { fetchImpl }
    )
    await recordZapoutSettlement(
      receipt({ id: "not-a-receipt-id" }),
      {
        POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN,
        ZAPOUT_SETTLEMENT_TELEMETRY_HMAC_SECRET: HMAC_SECRET,
      },
      { fetchImpl }
    )

    expect(requests).toBe(0)
  })

  it("keeps provider and crypto failures out of settlement authority", async () => {
    const env = {
      POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN,
      ZAPOUT_SETTLEMENT_TELEMETRY_HMAC_SECRET: HMAC_SECRET,
    }

    await expect(
      recordZapoutSettlement(receipt(), env, {
        async fetchImpl() {
          throw new Error("provider unavailable")
        },
      })
    ).resolves.toBeUndefined()
    await expect(
      recordZapoutSettlement(receipt(), env, {
        subtleCrypto: {
          importKey: async () => {
            throw new Error("crypto unavailable")
          },
        } as unknown as SubtleCrypto,
      })
    ).resolves.toBeUndefined()
  })
})

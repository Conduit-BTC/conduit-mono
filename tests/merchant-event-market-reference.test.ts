import { describe, expect, it } from "bun:test"
import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
} from "@conduit/core"
import {
  parseMerchantAuthHandoffSearch,
  parseMerchantEventsSearch,
} from "../apps/merchant/src/lib/market-links"
const ORGANIZER = "a".repeat(64)
const COORDINATE = `30409:${ORGANIZER}:community-market`
const NADDR = encodeEventMarketNaddr(COORDINATE, ["wss://relay.example/events"])

describe("current Merchant event references", () => {
  it("accepts an exact current naddr and preserves occurrence and relationship context", () => {
    const occurrence = `31923:${ORGANIZER}:community-market-day`
    expect(
      parseMerchantEventsSearch({
        event: NADDR,
        relation: "selling",
        occurrence,
      })
    ).toEqual({ event: NADDR, relation: "selling", occurrence })
    expect(decodeEventMarketReference(NADDR, [30409])?.coordinate).toBe(
      COORDINATE
    )
    expect(decodeEventMarketReference(NADDR, [30409])?.relayHints).toEqual([
      "wss://relay.example/events",
    ])
  })

  it("rejects old formats, bare coordinates and unrelated search fields", () => {
    for (const event of [
      COORDINATE,
      "not-an-event",
      encodeEventMarketNaddr(`30405:${ORGANIZER}:old-market`),
      encodeEventMarketNaddr(`30402:${ORGANIZER}:product`),
    ])
      expect(parseMerchantEventsSearch({ event })).toEqual({})
    expect(
      parseMerchantEventsSearch({
        event: NADDR,
        relation: "unknown",
        occurrence: `30409:${ORGANIZER}:wrong-kind`,
      })
    ).toEqual({ event: NADDR })
  })

  it("preserves the validated event in signed-out handoff without copying unvalidated query data", () => {
    expect(
      parseMerchantAuthHandoffSearch({
        event: NADDR,
        authRequired: "true",
        injected: "payload",
      })
    ).toEqual({ event: NADDR, authRequired: true })
    expect(
      parseMerchantAuthHandoffSearch({ event: "invalid", authRequired: false })
    ).toEqual({})
  })
})

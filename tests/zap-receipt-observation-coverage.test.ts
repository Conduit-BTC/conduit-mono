import { describe, expect, it } from "bun:test"
import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools"

import {
  waitForZapReceiptDetailed,
  type FetchEventsFanoutResult,
} from "@conduit/core"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const REQUEST_SIGNER_SECRET = Uint8Array.from([...new Uint8Array(31), 21])
const MERCHANT_SECRET = Uint8Array.from([...new Uint8Array(31), 22])
const PROVIDER_SECRET = Uint8Array.from([...new Uint8Array(31), 23])
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const PROVIDER_PUBKEY = getPublicKey(PROVIDER_SECRET)
const REQUEST_CREATED_AT = 1_800_000_000
const AMOUNT_MSATS = 50_000
const LNURL = "lnurl1receiptcoverage"

const request = finalizeEvent(
  {
    kind: 9734,
    created_at: REQUEST_CREATED_AT,
    content: "Receipt coverage test",
    tags: [
      ["p", MERCHANT_PUBKEY],
      ["amount", String(AMOUNT_MSATS)],
      ["lnurl", LNURL],
      ["relays", "wss://relay-one.example", "wss://relay-two.example"],
      ["client", "conduit-market"],
    ],
  },
  REQUEST_SIGNER_SECRET
)
const requestJson = JSON.stringify(request)
const invoice = makeBolt11Fixture({
  hrp: "lnbc500n",
  createdAt: REQUEST_CREATED_AT,
  fields: [bolt11PaymentHashField(), bolt11DescriptionHashField(requestJson)],
})
const receipt = finalizeEvent(
  {
    kind: 9735,
    created_at: REQUEST_CREATED_AT + 2,
    content: "",
    tags: [
      ["p", MERCHANT_PUBKEY],
      ["P", request.pubkey],
      ["bolt11", invoice],
      ["description", requestJson],
    ],
  },
  PROVIDER_SECRET
)

const input = {
  zapRequestId: request.id,
  requestCreatedAt: REQUEST_CREATED_AT,
  recipientPubkey: MERCHANT_PUBKEY,
  expectedAmountMsats: AMOUNT_MSATS,
  expectedLnurl: LNURL,
  expectedInvoice: invoice,
  lnurlNostrPubkey: PROVIDER_PUBKEY,
  relayUrls: ["wss://relay-one.example", "wss://relay-two.example"],
  receiptNotAfterSeconds: REQUEST_CREATED_AT + 600,
  timeoutMs: 0,
}

function fanout(
  statuses: Array<"success" | "partial" | "failed">,
  events: Event[] = []
): FetchEventsFanoutResult {
  return {
    events: events as unknown as NDKEvent[],
    relays: statuses.map((status, index) => ({
      relayUrl: input.relayUrls[index]!,
      status,
      eventCount: events.length,
    })),
    eventsVerified: true,
  }
}

describe("zap receipt relay coverage", () => {
  it.each([
    [[], "unavailable"],
    [["failed", "failed"], "unavailable"],
    [["success"], "partial"],
    [["success", "failed"], "partial"],
    [["partial", "failed"], "partial"],
    [["success", "success"], "complete"],
  ] as const)(
    "preserves %j fanout as %s instead of a false empty receipt set",
    async (statuses, coverage) => {
      let reads = 0
      const result = await waitForZapReceiptDetailed(input, {
        fetchEventsFanoutDetailed: async () => {
          reads += 1
          return fanout([...statuses])
        },
      })

      expect(reads).toBe(1)
      expect(result).toEqual({ receipt: null, coverage })
    }
  )

  it("accepts exact positive receipt evidence from a partial read", async () => {
    const result = await waitForZapReceiptDetailed(input, {
      fetchEventsFanoutDetailed: async () =>
        fanout(["partial", "failed"], [receipt]),
    })

    expect(result.coverage).toBe("partial")
    expect(result.receipt?.id).toBe(receipt.id)
  })

  it("continues past an unavailable poll and accepts a late exact receipt", async () => {
    let nowMs = 0
    let reads = 0
    const result = await waitForZapReceiptDetailed(
      { ...input, timeoutMs: 1_600 },
      {
        now: () => nowMs,
        sleep: async (delayMs) => {
          nowMs += delayMs
        },
        fetchEventsFanoutDetailed: async () => {
          reads += 1
          return reads === 1
            ? fanout(["failed", "failed"])
            : fanout(["partial", "failed"], [receipt])
        },
      }
    )

    expect(reads).toBe(2)
    expect(result.receipt?.id).toBe(receipt.id)
    expect(result.coverage).toBe("partial")
  })

  it.each(["complete", "partial"] as const)(
    "does not carry stale %s coverage across a later unavailable poll",
    async (firstCoverage) => {
      let nowMs = 0
      let reads = 0
      const firstStatuses =
        firstCoverage === "complete"
          ? (["success", "success"] as const)
          : (["partial", "failed"] as const)

      const result = await waitForZapReceiptDetailed(
        { ...input, timeoutMs: 1_600 },
        {
          now: () => nowMs,
          sleep: async (delayMs) => {
            nowMs += delayMs
          },
          fetchEventsFanoutDetailed: async () => {
            reads += 1
            return reads === 1
              ? fanout([...firstStatuses])
              : fanout(["failed", "failed"])
          },
        }
      )

      expect(reads).toBe(2)
      expect(result).toEqual({ receipt: null, coverage: "unavailable" })
    }
  )
})

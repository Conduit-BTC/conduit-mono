import { describe, expect, it } from "bun:test"

import { waitForZapReceipt } from "@conduit/core/protocol/lightning"

describe("Lightning relay-read authority", () => {
  it("stops a public zap receipt read before opening a relay after account change", async () => {
    await expect(
      waitForZapReceipt({
        zapRequestId: "f".repeat(64),
        requestCreatedAt: 1,
        recipientPubkey: "a".repeat(64),
        expectedAmountMsats: 1_000,
        expectedLnurl: "lnurl1test",
        expectedInvoice: "lnbc1test",
        lnurlNostrPubkey: "b".repeat(64),
        relayUrls: ["wss://relay.example"],
        shouldContinue: () => false,
        timeoutMs: 0,
      })
    ).rejects.toMatchObject({ code: "authority_changed" })
  })
})

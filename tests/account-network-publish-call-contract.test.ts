import { describe, expect, it } from "bun:test"

const contracts = [
  {
    path: "packages/core/src/protocol/profiles.ts",
    calls: [{ intent: "author_event", identity: "pubkey", count: 1 }],
  },
  {
    path: "packages/core/src/protocol/follows.ts",
    calls: [
      {
        intent: "author_event",
        identity: "normalizedOwnerPubkey",
        count: 1,
      },
    ],
  },
  {
    path: "packages/core/src/protocol/shopper-presets.ts",
    calls: [{ intent: "author_event", identity: "owner", count: 1 }],
  },
  {
    path: "packages/core/src/protocol/event-market.ts",
    calls: [
      {
        intent: "author_event",
        identity: "input.organizerPubkey",
        count: 1,
      },
    ],
  },
  {
    path: "packages/core/src/protocol/event-market-handoff.ts",
    calls: [
      {
        intent: "recipient_event",
        identity: "input.record.senderPubkey",
        count: 2,
      },
    ],
    privateMessageIdentity: "expectedSender(input.payload)",
  },
  {
    path: "apps/merchant/src/lib/product-publishing.ts",
    calls: [
      { intent: "author_event", identity: "merchantPubkey", count: 1 },
      { intent: "author_event", identity: "signerPubkey", count: 1 },
    ],
  },
] as const

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("account network publish call contract", () => {
  it("passes the same explicit authenticated account to last-mile filtering", async () => {
    for (const contract of contracts) {
      const source = await Bun.file(contract.path).text()

      for (const { intent, identity, count } of contract.calls) {
        const escapedIntent = escapeRegExp(intent)
        const escapedIdentity = escapeRegExp(identity)
        const matchingPublishCall = new RegExp(
          `intent: "${escapedIntent}",\\s+authorPubkey: ${escapedIdentity},\\s+authenticatedPubkey: ${escapedIdentity},\\s+accountPubkey: ${escapedIdentity},`,
          "g"
        )
        expect(source.match(matchingPublishCall) ?? []).toHaveLength(count)
      }

      if ("privateMessageIdentity" in contract) {
        const escapedIdentity = escapeRegExp(contract.privateMessageIdentity)
        const matchingPrivateMessageCall = new RegExp(
          `senderPubkey: ${escapedIdentity},\\s+accountPubkey: ${escapedIdentity},\\s+recipientPubkey:`,
          "g"
        )
        expect(
          source.match(matchingPrivateMessageCall) ?? []
        ).toHaveLength(1)
      }
    }
  })
})

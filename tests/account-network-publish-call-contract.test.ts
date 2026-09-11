import { describe, expect, it } from "bun:test"

const contracts = [
  {
    path: "packages/core/src/protocol/profiles.ts",
    calls: [
      {
        intent: "author_event",
        authorIdentity: "pubkey",
        authenticatedIdentity: "authenticatedPubkey",
        authenticatedPropertyPattern: "authenticatedPubkey",
        accountIdentity: "authenticatedPubkey",
        count: 1,
      },
    ],
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
        authorIdentity: "input.organizerPubkey",
        authenticatedPattern:
          "authenticatedPubkey\\s*===\\s*input\\.organizerPubkey\\s*\\?\\s*authenticatedPubkey\\s*:\\s*null",
        accountIdentity: "input.organizerPubkey",
        count: 1,
      },
    ],
    guards: [
      "signerPubkey\\s*!==\\s*input\\.organizerPubkey",
      "return\\s*\\{\\s*signedEvent:\\s*signed,\\s*authenticatedPubkey:\\s*signerPubkey\\s*\\}",
    ],
  },
  {
    path: "packages/core/src/protocol/event-market-handoff.ts",
    calls: [
      {
        intent: "recipient_event",
        authorIdentity: "input.record.senderPubkey",
        authenticatedIdentity: "authenticatedOwnerPubkey",
        accountIdentity: "accountPubkey",
        accountPropertyPattern: "accountPubkey",
        count: 2,
      },
    ],
    guards: [
      "const\\s+accountPubkey\\s*=\\s*input\\.record\\.senderPubkey\\.trim\\(\\)\\.toLowerCase\\(\\)",
      "const\\s+authenticatedOwnerPubkey\\s*=\\s*matchingAuthenticatedDeliveryOwner\\(\\s*input\\.record\\.senderPubkey,\\s*input\\.authenticatedOwnerPubkey\\s*\\)",
    ],
    privateMessageIdentity: "expectedSender(input.payload)",
  },
  {
    path: "apps/merchant/src/lib/product-publishing.ts",
    calls: [
      {
        intent: "author_event",
        authorIdentity: "merchantPubkey",
        authenticatedPattern:
          "authenticatedPubkey\\s*===\\s*merchantPubkey\\.toLowerCase\\(\\)\\s*\\?\\s*authenticatedPubkey\\s*:\\s*null",
        accountIdentity: "merchantPubkey",
        count: 1,
      },
      {
        intent: "author_event",
        authorIdentity: "signerPubkey",
        authenticatedIdentity: "authenticatedPubkey",
        authenticatedPropertyPattern: "authenticatedPubkey",
        accountIdentity: "signerPubkey",
        count: 1,
      },
    ],
    guards: [
      "const\\s+authenticatedPubkey\\s*=\\s*input\\.authenticatedPubkey\\s*===\\s*undefined\\s*\\|\\|\\s*suppliedAuthenticatedPubkey\\s*===\\s*signerPubkey\\s*\\?\\s*signerPubkey\\s*:\\s*null",
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

      for (const call of contract.calls) {
        const { intent, count } = call
        const authorIdentity =
          "authorIdentity" in call ? call.authorIdentity : call.identity
        const accountIdentity =
          "accountIdentity" in call ? call.accountIdentity : call.identity
        const authenticatedPattern =
          "authenticatedPattern" in call
            ? call.authenticatedPattern
            : escapeRegExp(
                "authenticatedIdentity" in call
                  ? call.authenticatedIdentity
                  : accountIdentity
              )
        const authenticatedPropertyPattern =
          "authenticatedPropertyPattern" in call
            ? call.authenticatedPropertyPattern
            : `authenticatedPubkey:\\s*(?:${authenticatedPattern})`
        const escapedIntent = escapeRegExp(intent)
        const escapedAuthorIdentity = escapeRegExp(authorIdentity)
        const escapedAccountIdentity = escapeRegExp(accountIdentity)
        const accountPropertyPattern =
          "accountPropertyPattern" in call
            ? call.accountPropertyPattern
            : `accountPubkey: ${escapedAccountIdentity}`
        const matchingPublishCall = new RegExp(
          `intent: "${escapedIntent}",\\s+authorPubkey: ${escapedAuthorIdentity},\\s+(?:${authenticatedPropertyPattern}),\\s+(?:${accountPropertyPattern}),`,
          "g"
        )
        expect(source.match(matchingPublishCall) ?? []).toHaveLength(count)
      }

      if ("guards" in contract) {
        for (const guard of contract.guards) {
          expect(source).toMatch(new RegExp(guard))
        }
      }

      if ("privateMessageIdentity" in contract) {
        const escapedIdentity = escapeRegExp(contract.privateMessageIdentity)
        const matchingPrivateMessageCall = new RegExp(
          `senderPubkey: ${escapedIdentity},\\s+accountPubkey: ${escapedIdentity},\\s+authenticatedPubkey: input\\.transport\\?\\.authenticatedPubkey,\\s+recipientPubkey:`,
          "g"
        )
        expect(source.match(matchingPrivateMessageCall) ?? []).toHaveLength(1)
      }
    }
  })
})

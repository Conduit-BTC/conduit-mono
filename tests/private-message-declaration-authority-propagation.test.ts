import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("private-message declaration authority propagation", () => {
  it("carries live authority through send and exact-replay declaration reads", async () => {
    const messaging = await source(
      "packages/core/src/protocol/private-message-delivery.ts"
    )

    expect(messaging).toContain(
      'shouldContinue?: PublicRelayReadOptions["shouldContinue"]'
    )
    expect(
      messaging.match(
        /input\.accountNetworkLocalStateRepository,\s*input\.shouldContinue/g
      )
    ).toHaveLength(3)
    expect(messaging).toMatch(
      /return resolveInboxDeclaration\(pubkey, \{[\s\S]*?shouldContinue,\s*\}\)/
    )
  })

  it("binds owner readiness and app sends to their live sessions", async () => {
    const [hook, marketMessages, merchantMessages] = await Promise.all([
      source("packages/core/src/hooks/useInboxDeclaration.ts"),
      source("apps/market/src/routes/messages.tsx"),
      source("apps/merchant/src/routes/messages.tsx"),
    ])

    expect(hook).toContain("queryFn: ({ signal })")
    expect(hook).toContain("signal,")
    expect(hook).toContain("!signal.aborted")
    expect(hook).toContain("sameAccountReadAuthority(")
    expect(hook).toContain(
      "useLayoutEffect(() => {\n    authorityRef.current = {"
    )
    expect(
      marketMessages.match(
        /shouldContinue:\s*\(\) =>\s*isCurrentMessagingAuthority\(/g
      )
    ).toHaveLength(1)
    for (const messages of [marketMessages, merchantMessages]) {
      // The adapter and route fences must both survive shared send delegation.
      expect(messages).toMatch(
        /shouldContinue:\s*\(\) => \{\s*if \(prepared\.shouldContinue\?\.\(\) === false\) return false\s*return isCurrentMessagingAuthority\(\s*input\.accountPubkey,\s*input\.authGeneration\s*\)/
      )
    }
  })

  it("binds merchant order sends to the live account generation", async () => {
    const [merchantOrders, paymentAutomation] = await Promise.all([
      source("apps/merchant/src/routes/orders.tsx"),
      source("apps/merchant/src/hooks/useMerchantPaymentAutomation.tsx"),
    ])

    expect(
      merchantOrders.match(
        /signerInteraction: "external",\s*authenticatedPubkey,\s*shouldContinue: \(\) => isCurrentOrderAction\(authority\)/g
      )
    ).toHaveLength(4)
    expect(paymentAutomation).toMatch(
      /shouldContinue: \(\) => authGenerationRef\.current === authGeneration/
    )
  })
})

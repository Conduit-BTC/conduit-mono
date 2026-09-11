import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("private-message declaration authority propagation", () => {
  it("carries live authority through both send-time declaration reads", async () => {
    const messaging = await source("packages/core/src/protocol/messaging.ts")

    expect(messaging).toContain(
      'shouldContinue?: FetchEventsFanoutOptions["shouldContinue"]'
    )
    expect(
      messaging.match(
        /input\.accountNetworkLocalStateRepository,\s*input\.shouldContinue/g
      )
    ).toHaveLength(2)
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
    expect(hook).toContain("sameAccountMutationAuthority(")
    expect(hook).toContain(
      "useLayoutEffect(() => {\n    authorityRef.current = {"
    )
    expect(
      marketMessages.match(
        /shouldContinue:\s*\(\) =>\s*authGenerationRef\.current === authGeneration/g
      )
    ).toHaveLength(2)
    expect(
      merchantMessages.match(
        /shouldContinue:\s*\(\) =>\s*authGenerationRef\.current === authGeneration/g
      )
    ).toHaveLength(2)
  })

  it("binds merchant order sends to the live account generation", async () => {
    const [merchantOrders, paymentAutomation] = await Promise.all([
      source("apps/merchant/src/routes/orders.tsx"),
      source("apps/merchant/src/hooks/useMerchantPaymentAutomation.tsx"),
    ])

    expect(
      merchantOrders.match(
        /signerInteraction: "external",\s*authenticatedPubkey: signerConnected \? pubkey : null,\s*shouldContinue: \(\) => authGenerationRef\.current === authGeneration/g
      )
    ).toHaveLength(4)
    expect(paymentAutomation).toMatch(
      /shouldContinue: \(\) => authGenerationRef\.current === authGeneration/
    )
  })
})

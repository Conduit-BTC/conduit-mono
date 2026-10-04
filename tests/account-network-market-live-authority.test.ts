import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

function profileCallSources(contents: string): string[] {
  const calls: string[] = []
  const matcher = /\b(?:useProfiles?|useMerchantIdentities)\(/g
  let match: RegExpExecArray | null

  while ((match = matcher.exec(contents))) {
    let depth = 1
    let index = matcher.lastIndex
    while (index < contents.length && depth > 0) {
      if (contents[index] === "(") depth += 1
      if (contents[index] === ")") depth -= 1
      index += 1
    }
    calls.push(contents.slice(match.index, index))
    matcher.lastIndex = index
  }

  return calls
}

describe("Market live account authority", () => {
  it("composes query cancellation with caller authority for profile reads", async () => {
    const hook = await source("packages/core/src/hooks/useProfiles.ts")

    expect(hook).toContain("shouldContinue?: () => boolean")
    expect(hook).toContain(
      "!signal.aborted && (options.shouldContinue?.() ?? true)"
    )
    expect(hook).toMatch(
      /getProfiles\(\{[\s\S]{0,180}?accountPubkey: options\.accountPubkey,[\s\S]{0,80}?shouldContinue,[\s\S]{0,40}?signal,/
    )
  })

  it("binds every Market profile caller to a live account predicate", async () => {
    const paths = [
      "apps/market/src/components/MarketCartHud.tsx",
      "apps/market/src/components/MarketHeader.tsx",
      "apps/market/src/hooks/useMerchantIdentities.ts",
      "apps/market/src/hooks/useEventActorIdentity.ts",
      "apps/market/src/hooks/useMerchantTrustContext.ts",
      "apps/market/src/routes/cart.tsx",
      "apps/market/src/routes/checkout.tsx",
      "apps/market/src/components/FutureEventMarketPage.tsx",
      "apps/market/src/components/MarketEventsTimeline.tsx",
      "apps/market/src/routes/messages.tsx",
      "apps/market/src/routes/orders.tsx",
      "apps/market/src/routes/products/$productId.tsx",
      "apps/market/src/routes/profile.tsx",
    ]

    for (const path of paths) {
      const calls = profileCallSources(await source(path))
      expect(
        calls.length,
        `${path} should contain profile hooks`
      ).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call, `${path} profile call must carry live authority`).toMatch(
          /\bshouldContinue\b/
        )
      }
    }
  })

  it("combines account generation with cancellation across Market relay reads", async () => {
    const [browse, progressive, cart, orders, publicProfile, trust, checkout] =
      await Promise.all([
        source("apps/market/src/hooks/useMarketBrowseModel.ts"),
        source("apps/market/src/hooks/useProgressiveProducts.ts"),
        source("apps/market/src/routes/cart.tsx"),
        source("apps/market/src/routes/orders.tsx"),
        source("apps/market/src/routes/$identityRef.tsx"),
        source("apps/market/src/hooks/useMerchantTrustContext.ts"),
        source("apps/market/src/routes/checkout.tsx"),
      ])

    expect(browse).toContain("!signal.aborted && shouldContinueAccountRead()")
    expect(progressive).toMatch(
      /const controller = new AbortController\(\)\s+const \{ signal \} = controller\s+const shouldContinue = \(\) =>\s+!signal\.aborted && authGenerationRef\.current === authGeneration/
    )
    expect(progressive).toMatch(
      /getMarketplaceProductsProgressive\([\s\S]{0,600}accountPubkey: finalIoAccountPubkey,\s+shouldContinue,\s+signal,/
    )
    expect(progressive).toMatch(
      /return \(\) => \{\s+controller\.abort\(\)\s+cancelScheduledFlush\(\)/
    )
    expect(
      progressive.match(
        /!signal\.aborted && authGenerationRef\.current === authGeneration/g
      )?.length
    ).toBeGreaterThanOrEqual(3)
    expect(publicProfile).toContain("useMerchantTrustContext({")
    for (const route of [cart, orders, trust]) {
      expect(route).toContain("!signal.aborted && shouldContinueAccountRead()")
    }
    expect(checkout).toMatch(
      /authorizeCurrentCheckoutItems\([\s\S]{0,900}shouldContinue: shouldContinueBuyerSession/
    )
    expect(checkout).toMatch(
      /const shouldContinueBuyerSession = \(\) =>[\s\S]{0,100}isAuthGenerationCurrent\(authGeneration\)[\s\S]{0,100}isGuestGenerationCurrent\(authGeneration\)/
    )
  })
})

import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("event-market private-delivery authority propagation", () => {
  it("carries the transport predicate through exact retry reads and writes", async () => {
    const [core, merchantHandoff] = await Promise.all([
      source("packages/core/src/protocol/event-market-handoff.ts"),
      source("apps/merchant/src/lib/event-market-handoff.ts"),
    ])

    expect(core).toContain('| "shouldContinue"')
    expect(core).toContain(
      'shouldContinue?: EventMarketPrivateTransportOptions["shouldContinue"]'
    )
    expect(core).toContain("options: inboxDeclarationOptions,")
    expect(
      core.match(/shouldContinue,\n/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(3)
    expect(merchantHandoff).toContain(
      "shouldContinue: transport?.shouldContinue,"
    )
    expect(
      merchantHandoff.match(
        /input\.transport\?\.shouldContinue\?\.\(\) !== false/g
      )
    ).toHaveLength(3)
  })

  it("binds every Merchant handoff action to its existing auth generation", async () => {
    const [orders, paymentRelease, events] = await Promise.all([
      source("apps/merchant/src/routes/orders.tsx"),
      source("apps/merchant/src/lib/order-payment-release.ts"),
      source("apps/merchant/src/routes/events.tsx"),
    ])

    expect(
      orders.match(
        /transport:\s*\{\s*authenticatedPubkey:[\s\S]{0,160}?shouldContinue:\s*\(\) =>\s*authGenerationRef\.current === authGeneration/g
      )
    ).toHaveLength(3)
    expect(paymentRelease).toContain(
      "authenticatedPubkey: input.authenticatedPubkey,\n        shouldContinue: input.shouldContinue,"
    )
    expect(events).toContain(
      "transport: { authenticatedPubkey, shouldContinue }"
    )
  })
})

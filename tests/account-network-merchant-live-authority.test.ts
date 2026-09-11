import { describe, expect, it } from "bun:test"
import {
  getShopperTrustEvidence,
  type ShopperTrustFetchEvents,
} from "@conduit/core"

const MERCHANT = "a".repeat(64)
const SHOPPER = "b".repeat(64)
const RELAY = "wss://merchant-live-authority.test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("Merchant live account authority", () => {
  it("combines query cancellation with the mounted account generation", async () => {
    const [dashboard, orders, products, events, shipping, readiness] =
      await Promise.all([
        source("apps/merchant/src/routes/index.tsx"),
        source("apps/merchant/src/routes/orders.tsx"),
        source("apps/merchant/src/routes/products.tsx"),
        source("apps/merchant/src/routes/events.tsx"),
        source("apps/merchant/src/routes/shipping.tsx"),
        source("apps/merchant/src/hooks/useMerchantReadiness.ts"),
      ])

    const generationGuard =
      /!signal\.aborted && authGenerationRef\.current === authGeneration/g
    expect(dashboard.match(generationGuard)).toHaveLength(1)
    expect(orders.match(generationGuard)).toHaveLength(2)
    expect(products.match(generationGuard)).toHaveLength(5)
    expect(
      events.match(/!signal\.aborted && shouldContinue\(\)/g)
    ).toHaveLength(5)
    expect(shipping.match(generationGuard)).toHaveLength(1)
    expect(readiness.match(generationGuard)).toHaveLength(1)
  })

  it("binds every authenticated Merchant profile and trust read to that generation", async () => {
    const paths = [
      "apps/merchant/src/components/MerchantHeader.tsx",
      "apps/merchant/src/components/OrganizerEventMarketPanel.tsx",
      "apps/merchant/src/components/ProductPaymentSetupNotice.tsx",
      "apps/merchant/src/hooks/useMerchantPaymentAutomation.tsx",
      "apps/merchant/src/hooks/useMerchantReadiness.ts",
      "apps/merchant/src/routes/index.tsx",
      "apps/merchant/src/routes/messages.tsx",
      "apps/merchant/src/routes/orders.tsx",
      "apps/merchant/src/routes/payments.tsx",
      "apps/merchant/src/routes/profile.tsx",
      "apps/merchant/src/components/MerchantEventsTimeline.tsx",
    ]
    const sources = await Promise.all(paths.map(source))

    for (const contents of sources) {
      expect(contents).toContain("shouldContinue:")
    }
    expect(sources[7]).toContain(
      "shouldContinue: () => authGenerationRef.current === authGeneration"
    )
    expect(sources[7]).toMatch(
      /useShopperTrustEvidence\([\s\S]{0,520}shouldContinue:/
    )
  })

  it("threads the same live predicate through shopper-trust final I/O", async () => {
    let live = true
    let fanoutCalls = 0
    const shouldContinue = () => live
    const fetchEvents: ShopperTrustFetchEvents = async (_filter, options) => {
      fanoutCalls += 1
      expect(options?.shouldContinue).toBe(shouldContinue)
      live = false
      return {
        events: [],
        relays: [
          {
            relayUrl: RELAY,
            status: "success",
            eventCount: 0,
          },
        ],
      }
    }

    const read = getShopperTrustEvidence(
      { merchantPubkey: MERCHANT, shopperPubkey: SHOPPER },
      {
        cache: null,
        fetchEvents,
        relayUrls: [RELAY],
        shouldContinue,
      }
    )

    await expect(read).rejects.toMatchObject({ name: "AbortError" })
    expect(fanoutCalls).toBe(1)
  })

  it("propagates live authority through followed-event discovery", async () => {
    const [merchantAdapter, discovery] = await Promise.all([
      source("apps/merchant/src/lib/event-market.ts"),
      source("packages/core/src/protocol/event-market-discovery.ts"),
    ])

    expect(merchantAdapter).toContain("shouldContinue: options.shouldContinue")
    expect(discovery).toContain("shouldContinue: input.shouldContinue")
    expect(
      discovery.match(/throwIfAborted\(input\.signal, input\.shouldContinue\)/g)
        ?.length ?? 0
    ).toBeGreaterThanOrEqual(4)
  })
})

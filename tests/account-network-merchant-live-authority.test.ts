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
    const [
      dashboard,
      orders,
      products,
      manager,
      eventTimeline,
      shipping,
      readiness,
    ] = await Promise.all([
      source("apps/merchant/src/routes/index.tsx"),
      source("apps/merchant/src/routes/orders.tsx"),
      source("apps/merchant/src/routes/products.tsx"),
      source("apps/merchant/src/components/FutureEventMarketManager.tsx"),
      source("apps/merchant/src/hooks/useMerchantEventTimeline.ts"),
      source("apps/merchant/src/routes/shipping.tsx"),
      source("apps/merchant/src/hooks/useMerchantReadiness.ts"),
    ])

    const generationGuard =
      /!signal\.aborted && authGenerationRef\.current === authGeneration/g
    const orderGenerationGuard =
      /!signal\.aborted &&\s+!!pubkey &&\s+isCurrentOrderOwner\(pubkey, authGeneration\)/g
    expect(dashboard.match(generationGuard)).toHaveLength(1)
    expect(orders.match(orderGenerationGuard)).toHaveLength(4)
    expect(products.match(generationGuard)).toHaveLength(1)
    const eventGenerationGuard =
      /!signal\.aborted && isAuthGenerationCurrent\(authGeneration\)/g
    expect(manager.match(eventGenerationGuard)).toHaveLength(2)
    expect(manager.match(generationGuard)).toHaveLength(1)
    for (const contents of [manager]) {
      expect(contents).toMatch(
        /session.relayScope,[\s\S]{0,80}authenticatedPubkey,[\s\S]{0,80}authGeneration/
      )
    }
    expect(eventTimeline.match(generationGuard)).toHaveLength(2)
    expect(shipping.match(generationGuard)).toHaveLength(1)
    expect(readiness.match(generationGuard)).toHaveLength(1)
  })

  it("binds every authenticated Merchant profile and trust read to that generation", async () => {
    const paths = [
      "apps/merchant/src/components/MerchantHeader.tsx",
      "apps/merchant/src/components/FutureEventMarketManager.tsx",
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
    expect(sources[7]).toMatch(
      /shouldContinue: \(\) =>\s+!!pubkey && isCurrentOrderOwner\(pubkey, authGeneration\)/
    )
    expect(sources[7]).toMatch(
      /useShopperTrustEvidence\([\s\S]{0,520}shouldContinue:/
    )
  })

  it("binds timeline discovery, relationships, and profiles to the signed-in account", async () => {
    const hook = await source(
      "apps/merchant/src/hooks/useMerchantEventTimeline.ts"
    )
    const component = await source(
      "apps/merchant/src/components/MerchantEventsTimeline.tsx"
    )
    expect(hook).toContain(
      'const authenticatedPubkey = status === "connected" ? pubkey : null'
    )
    expect(hook).not.toContain("authenticatedPubkey: merchantPubkey")
    expect(
      hook.match(
        /!signal.aborted && authGenerationRef.current === authGeneration/g
      )
    ).toHaveLength(2)
    expect(hook).toMatch(
      /session.relayScope[\s\S]{0,80}authenticatedPubkey,[\s\S]{0,30}authGeneration/
    )
    expect(component).toContain("useProgressiveEventMarketDiscovery")
    expect(component).toContain("authenticatedPubkey,")
    expect(component).toContain("isAuthGenerationCurrent(authGeneration)")
    expect(component).toMatch(
      /useProfiles\([\s\S]{0,100}accountPubkey,[\s\S]{0,50}authenticatedPubkey,[\s\S]{0,100}shouldContinue: \(\) =>[\s\S]{0,80}authGenerationRef\.current === authGeneration &&[\s\S]{0,80}isAuthGenerationCurrent\(authGeneration\)/
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
    const [merchantHook, progressive, discovery, enrollment] =
      await Promise.all([
        source("apps/merchant/src/hooks/useMerchantEventTimeline.ts"),
        source("packages/core/src/hooks/useProgressiveEventMarketDiscovery.ts"),
        source("packages/core/src/protocol/event-market-roster-read.ts"),
        source("apps/merchant/src/hooks/useEventMarketEnrollment.ts"),
      ])
    expect(merchantHook).toContain("shouldContinue:")
    expect(progressive).toContain("shouldContinue:")
    expect(discovery).toContain("shouldContinue: input.shouldContinue")
    expect(
      enrollment.match(
        /shouldContinue: \(\) => isAuthGenerationCurrent\(authGeneration\)/g
      )
    ).toHaveLength(3)
  })
})

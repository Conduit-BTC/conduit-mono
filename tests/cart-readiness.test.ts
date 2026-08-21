import { describe, expect, it } from "bun:test"
import {
  CART_READINESS_LEASE_MS,
  createBoundedLimiter,
  deriveMerchantCartReadinessState,
  deriveMerchantCheckoutCapability,
  getMerchantCapabilityFallbackMessage,
  type MerchantCheckoutCapabilityInput,
} from "../apps/market/src/lib/cart-readiness"

const baseStateInput = {
  enabled: true,
  hasEvidence: true,
  initialLoading: false,
  backgroundRefreshing: false,
  fresh: true,
  blocked: false,
  evidenceAgeMs: 0,
}

describe("merchant cart readiness state", () => {
  it("separates initial loading from background refresh", () => {
    expect(
      deriveMerchantCartReadinessState({
        ...baseStateInput,
        hasEvidence: false,
        initialLoading: true,
        evidenceAgeMs: null,
      })
    ).toBe("checking")
    expect(
      deriveMerchantCartReadinessState({
        ...baseStateInput,
        backgroundRefreshing: true,
      })
    ).toBe("refreshing")
    expect(deriveMerchantCartReadinessState(baseStateInput)).toBe("ready")
  })

  it("keeps blocked evidence blocked even while refreshing", () => {
    expect(
      deriveMerchantCartReadinessState({
        ...baseStateInput,
        blocked: true,
        backgroundRefreshing: true,
      })
    ).toBe("blocked")
  })

  it("reports degraded and stale evidence distinctly", () => {
    expect(
      deriveMerchantCartReadinessState({ ...baseStateInput, fresh: false })
    ).toBe("degraded")
    expect(
      deriveMerchantCartReadinessState({
        ...baseStateInput,
        evidenceAgeMs: CART_READINESS_LEASE_MS + 1,
      })
    ).toBe("stale")
    expect(
      deriveMerchantCartReadinessState({
        ...baseStateInput,
        hasEvidence: false,
        initialLoading: false,
        evidenceAgeMs: null,
      })
    ).toBe("degraded")
    expect(
      deriveMerchantCartReadinessState({
        ...baseStateInput,
        enabled: false,
      })
    ).toBe("not_started")
  })
})

const readyCapabilityInput: MerchantCheckoutCapabilityInput = {
  readiness: "ready",
  blockingMessage: null,
  listingTermsCurrent: true,
  shopperPresetReady: true,
  walletReady: true,
  itemPricesAvailable: true,
  shippingReady: true,
  lnurl: {
    status: "ready",
    metadata: {
      callback: "https://pay.example/cb",
      minSendable: 1_000,
      maxSendable: 100_000_000,
      tag: "payRequest",
      allowsNostr: true,
      metadata: "[]",
    },
  },
  totalMsats: 1_000_000,
}

describe("shared merchant checkout capability", () => {
  it("derives zap_candidate from an empty blocker list", () => {
    const capability = deriveMerchantCheckoutCapability(readyCapabilityInput)
    expect(capability).toEqual({
      outcome: "zap_candidate",
      blockers: [],
      blockedReason: null,
    })
  })

  it("keeps incomplete listing evidence checkout-only during a refetch", () => {
    const readiness = deriveMerchantCartReadinessState({
      ...baseStateInput,
      backgroundRefreshing: true,
      fresh: false,
    })

    expect(readiness).toBe("degraded")
    expect(
      deriveMerchantCheckoutCapability({
        ...readyCapabilityInput,
        readiness,
      })
    ).toEqual({
      outcome: "checkout_required",
      blockers: ["listing_freshness_unavailable"],
      blockedReason: null,
    })
  })

  it("stays a candidate during a nonblocking background refresh", () => {
    expect(
      deriveMerchantCheckoutCapability({
        ...readyCapabilityInput,
        readiness: "refreshing",
      }).outcome
    ).toBe("zap_candidate")
  })

  it("prepares while availability or LNURL evidence is pending", () => {
    expect(
      deriveMerchantCheckoutCapability({
        ...readyCapabilityInput,
        readiness: "checking",
      }).outcome
    ).toBe("preparing")
    expect(
      deriveMerchantCheckoutCapability({
        ...readyCapabilityInput,
        lnurl: { status: "pending", metadata: null },
      }).outcome
    ).toBe("preparing")
  })

  it("blocks with a concrete reason on hard availability failures", () => {
    const capability = deriveMerchantCheckoutCapability({
      ...readyCapabilityInput,
      readiness: "blocked",
      blockingMessage: "Sold out: Field Notebook",
    })
    expect(capability.outcome).toBe("blocked")
    expect(capability.blockedReason).toBe("Sold out: Field Notebook")
    expect(getMerchantCapabilityFallbackMessage(capability)).toBe(
      "Sold out: Field Notebook"
    )
  })

  it("names every degraded gate instead of silently disagreeing", () => {
    const capability = deriveMerchantCheckoutCapability({
      ...readyCapabilityInput,
      readiness: "stale",
      listingTermsCurrent: false,
      shopperPresetReady: false,
      walletReady: false,
      itemPricesAvailable: false,
      shippingReady: false,
      lnurl: { status: "unavailable", metadata: null },
    })
    expect(capability.outcome).toBe("checkout_required")
    expect(capability.blockers).toEqual([
      "listing_freshness_unavailable",
      "shopper_preset_unavailable",
      "wallet_unavailable",
      "price_unavailable",
      "shipping_unavailable",
      "lnurl_metadata_unavailable",
    ])
  })

  it("recomputes amount-range eligibility locally against the metadata", () => {
    expect(
      deriveMerchantCheckoutCapability({
        ...readyCapabilityInput,
        totalMsats: 100,
      }).blockers
    ).toEqual(["amount_out_of_range"])
    expect(
      deriveMerchantCheckoutCapability({
        ...readyCapabilityInput,
        lnurl: { status: "no_address", metadata: null },
      }).blockers
    ).toEqual(["merchant_lightning_unavailable"])
  })
})

describe("bounded readiness limiter", () => {
  it("caps concurrency and preserves FIFO completion", async () => {
    const limiter = createBoundedLimiter(2)
    let active = 0
    let peak = 0
    const gate: Array<() => void> = []
    const run = () =>
      limiter(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => gate.push(resolve))
        active -= 1
      })
    const tasks = [run(), run(), run(), run()]
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(peak).toBe(2)
    const drain = setInterval(() => gate.shift()?.(), 0)
    await Promise.all(tasks)
    clearInterval(drain)
    expect(peak).toBe(2)
    expect(active).toBe(0)
  })
})

import { beforeEach, describe, expect, it } from "bun:test"

import {
  __resetCommerceGmvEstimateSessionForTests,
  getCommerceGmvEstimateFromOrder,
  reportCommerceGmvEstimate,
} from "../packages/core/src/commerce-gmv"

const ORDER_ID = "018f4a00-1111-4abc-8def-0123456789ab"
const ESTIMATE = {
  orderId: ORDER_ID,
  orderCreatedAt: Date.parse("2026-09-17T18:24:31.000Z"),
  invoicedAmountSats: 42,
}

describe("commerce GMV estimate client", () => {
  beforeEach(() => {
    __resetCommerceGmvEstimateSessionForTests()
  })

  it("admits only the exact sats order snapshot for a conversation", () => {
    const order = {
      id: ORDER_ID,
      buyerPubkey: "buyer",
      merchantPubkey: "merchant",
      createdAt: ESTIMATE.orderCreatedAt,
      subtotal: 42,
      currency: "SATS",
    }
    expect(
      getCommerceGmvEstimateFromOrder({
        orderId: ORDER_ID,
        buyerPubkey: "buyer",
        merchantPubkey: "merchant",
        order,
      })
    ).toEqual(ESTIMATE)

    for (const invalid of [
      { ...order, id: "018f4a00-2222-4abc-8def-0123456789ab" },
      { ...order, buyerPubkey: "other-buyer" },
      { ...order, merchantPubkey: "other-merchant" },
      { ...order, currency: "USD" },
      { ...order, subtotal: 0 },
      { ...order, subtotal: 1.5 },
    ]) {
      expect(
        getCommerceGmvEstimateFromOrder({
          orderId: ORDER_ID,
          buyerPubkey: "buyer",
          merchantPubkey: "merchant",
          order: invalid,
        })
      ).toBeNull()
    }
  })

  it.each(["shop.conduit.market", "sell.conduit.market"])(
    "reports from the official %s surface with only the order estimate fields",
    async (hostname) => {
      const requests: Array<{ input: string; init: RequestInit }> = []
      const accepted = await reportCommerceGmvEstimate(ESTIMATE, {
        hostname,
        fetchImpl: async (input, init) => {
          requests.push({ input, init })
          return new Response(null, { status: 200 })
        },
      })

      expect(accepted).toBe(true)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.input).toBe("https://e.conduit.market/gmv")
      expect(requests[0]?.init).toMatchObject({
        cache: "no-store",
        credentials: "omit",
        keepalive: true,
        method: "POST",
        referrerPolicy: "no-referrer",
      })
      expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
        orderId: ORDER_ID,
        orderDate: "2026-09-17",
        invoicedAmountSats: 42,
      })
      expect(String(requests[0]?.init.body)).not.toContain(
        String(ESTIMATE.orderCreatedAt)
      )
    }
  )

  it("keeps first-party GMV measurement independent from optional analytics and GPC", async () => {
    const previousNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator"
    )
    const previousTelemetryFlag = process.env.VITE_ENABLE_TELEMETRY
    let requests = 0

    try {
      process.env.VITE_ENABLE_TELEMETRY = "false"
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { globalPrivacyControl: true },
      })

      await expect(
        reportCommerceGmvEstimate(ESTIMATE, {
          hostname: "shop.conduit.market",
          fetchImpl: async () => {
            requests += 1
            return new Response(null, { status: 200 })
          },
        })
      ).resolves.toBe(true)
      expect(requests).toBe(1)
    } finally {
      if (previousNavigator) {
        Object.defineProperty(globalThis, "navigator", previousNavigator)
      } else {
        Reflect.deleteProperty(globalThis, "navigator")
      }
      if (previousTelemetryFlag === undefined) {
        delete process.env.VITE_ENABLE_TELEMETRY
      } else {
        process.env.VITE_ENABLE_TELEMETRY = previousTelemetryFlag
      }
    }
  })

  it("coalesces concurrent signals and suppresses later successful repeats", async () => {
    let requests = 0
    let release: (() => void) | null = null
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = async () => {
      requests += 1
      await pending
      return new Response(null, { status: 200 })
    }

    const first = reportCommerceGmvEstimate(ESTIMATE, {
      hostname: "shop.conduit.market",
      fetchImpl,
    })
    const second = reportCommerceGmvEstimate(ESTIMATE, {
      hostname: "shop.conduit.market",
      fetchImpl,
    })
    expect(requests).toBe(1)
    release?.()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])

    await expect(
      reportCommerceGmvEstimate(ESTIMATE, {
        hostname: "sell.conduit.market",
        fetchImpl,
      })
    ).resolves.toBe(true)
    expect(requests).toBe(1)
  })

  it("allows a later signal to retry after transport failure", async () => {
    let requests = 0
    const fetchImpl = async () => {
      requests += 1
      if (requests === 1) throw new Error("offline")
      return new Response(null, { status: 200 })
    }

    await expect(
      reportCommerceGmvEstimate(ESTIMATE, {
        hostname: "shop.conduit.market",
        fetchImpl,
      })
    ).resolves.toBe(false)
    await expect(
      reportCommerceGmvEstimate(ESTIMATE, {
        hostname: "shop.conduit.market",
        fetchImpl,
      })
    ).resolves.toBe(true)
    expect(requests).toBe(2)
  })

  it("drops previews, malformed UUIDs, zero amounts, and fractional sats", async () => {
    let requests = 0
    const fetchImpl = async () => {
      requests += 1
      return new Response(null, { status: 200 })
    }

    for (const [hostname, estimate] of [
      ["branch.conduit-market-coo.pages.dev", ESTIMATE],
      ["shop.conduit.market", { ...ESTIMATE, orderId: "not-an-order" }],
      ["shop.conduit.market", { ...ESTIMATE, invoicedAmountSats: 0 }],
      ["shop.conduit.market", { ...ESTIMATE, invoicedAmountSats: 1.5 }],
      [
        "shop.conduit.market",
        { ...ESTIMATE, orderCreatedAt: Number.MAX_SAFE_INTEGER },
      ],
    ] as const) {
      await expect(
        reportCommerceGmvEstimate(estimate, { hostname, fetchImpl })
      ).resolves.toBe(false)
    }
    expect(requests).toBe(0)
  })
})

import { describe, expect, it } from "bun:test"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import {
  cancelMerchantOrderRoutePreflights,
  getCartMerchantHiddenProductIds,
  merchantCartAvailabilityQueryKey,
  merchantOrderRoutePreflightQueryKey,
  merchantOrderRoutePreflightQueryOptions,
  startMerchantOrderRoutePreflight,
} from "../apps/market/src/hooks/useCartReadiness"
import { CART_READINESS_LEASE_MS } from "../apps/market/src/lib/cart-readiness"

const merchantPubkey = "a".repeat(64)
const productId = `30402:${merchantPubkey}:event-product`
const ordinaryProductId = `30402:${merchantPubkey}:ordinary-product`

function item(fulfillment: CartItem["fulfillment"], id = productId): CartItem {
  return {
    productId: id,
    merchantPubkey,
    title: "Event product",
    price: 10,
    currency: "SATS",
    quantity: 1,
    fulfillment,
  }
}

describe("cart readiness hidden product scope", () => {
  it("opts only explicit event pickup coordinates into exact hidden reads", () => {
    const ordinary = item({ type: "shipping" }, ordinaryProductId)
    const eventPickup = item({ type: "pickup" } as CartItem["fulfillment"])

    expect(getCartMerchantHiddenProductIds([ordinary])).toEqual([])
    expect(getCartMerchantHiddenProductIds([ordinary, eventPickup])).toEqual([
      productId,
    ])
  })

  it("separates ordinary and event-pickup readiness query caches", () => {
    expect(
      merchantCartAvailabilityQueryKey(merchantPubkey, [productId])
    ).toEqual(["merchant-cart-availability", merchantPubkey, [productId], []])
    expect(
      merchantCartAvailabilityQueryKey(merchantPubkey, [productId], [productId])
    ).toEqual([
      "merchant-cart-availability",
      merchantPubkey,
      [productId],
      [productId],
    ])
  })

  it("separates signed-in relay scopes while preserving the guest key", () => {
    const guest = merchantCartAvailabilityQueryKey(merchantPubkey, [productId])
    const accountA = merchantCartAvailabilityQueryKey(
      merchantPubkey,
      [productId],
      [],
      "account:a"
    )
    const accountB = merchantCartAvailabilityQueryKey(
      merchantPubkey,
      [productId],
      [],
      "account:b"
    )

    expect(accountA).not.toEqual(guest)
    expect(accountB).not.toEqual(guest)
    expect(accountA).not.toEqual(accountB)
  })

  it("separates route preflight authority and keeps the cart readiness lease", () => {
    const guest = {
      accountPubkey: null,
      authenticatedPubkey: null,
      relayScope: null,
      authGeneration: 1,
    }
    const account = {
      accountPubkey: "B".repeat(64),
      authenticatedPubkey: "B".repeat(64),
      relayScope: "account:b",
      authGeneration: 2,
    }

    expect(merchantOrderRoutePreflightQueryKey(merchantPubkey, guest)).toEqual([
      "merchant-order-route-preflight",
      merchantPubkey,
      "guest",
      "guest",
      "no-relay-scope",
      1,
    ])
    expect(
      merchantOrderRoutePreflightQueryKey(merchantPubkey, account)
    ).not.toEqual(merchantOrderRoutePreflightQueryKey(merchantPubkey, guest))

    const options = merchantOrderRoutePreflightQueryOptions(
      merchantPubkey,
      guest
    )
    expect(options.staleTime).toBe(CART_READINESS_LEASE_MS)
    expect(options.gcTime).toBe(5 * 60_000)
    expect(options.retry).toBe(false)
  })

  it("starts submit-time route warming without awaiting advisory failure", async () => {
    let rejectWarm: ((reason?: unknown) => void) | null = null
    let receivedOptions: Record<string, unknown> | null = null
    const pendingWarm = new Promise<never>((_resolve, reject) => {
      rejectWarm = reject
    })
    const queryClient = {
      fetchQuery: (options: Record<string, unknown>) => {
        receivedOptions = options
        return pendingWarm
      },
    }

    expect(
      startMerchantOrderRoutePreflight(
        queryClient as unknown as Parameters<
          typeof startMerchantOrderRoutePreflight
        >[0],
        merchantPubkey,
        {
          accountPubkey: null,
          authenticatedPubkey: null,
          relayScope: null,
          authGeneration: 1,
          bounded: false,
        }
      )
    ).toBeUndefined()
    expect(receivedOptions?.staleTime).toBe(0)

    rejectWarm?.(new Error("advisory warm failed"))
    await Promise.resolve()
  })

  it("awaits cancellation of only the speculative route query family", async () => {
    let releaseCancellation: (() => void) | null = null
    let receivedFilters: Record<string, unknown> | null = null
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve
    })
    const queryClient = {
      cancelQueries: (filters: Record<string, unknown>) => {
        receivedFilters = filters
        return cancellation
      },
    }
    let settled = false
    const result = cancelMerchantOrderRoutePreflights(
      queryClient as unknown as Parameters<
        typeof cancelMerchantOrderRoutePreflights
      >[0]
    ).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(receivedFilters).toEqual({
      queryKey: ["merchant-order-route-preflight"],
    })
    expect(settled).toBe(false)

    releaseCancellation?.()
    await result
    expect(settled).toBe(true)
  })
})

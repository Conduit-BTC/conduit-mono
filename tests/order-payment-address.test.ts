import { describe, expect, it } from "bun:test"
import type { getProfiles, OrderLifecycle } from "@conduit/core"
import { checkOrderPaymentAddressUpdate } from "../apps/market/src/lib/order-payment-address"

const MERCHANT = "a".repeat(64)
const BUYER = "b".repeat(64)
const OTHER = "c".repeat(64)

function lifecycle(overrides: Partial<OrderLifecycle> = {}): OrderLifecycle {
  return {
    orderId: "updated-payment-address-fixture",
    buyerPubkey: BUYER,
    merchantPubkey: MERCHANT,
    merchantLightningAddress: "old@wallet.example",
    checkoutMode: "public_zap_as_shopper",
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    invoiceStatus: "failed",
    paymentStatus: "failed",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "in_progress",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

type ProfileResult = Awaited<ReturnType<typeof getProfiles>>

function profileResult(
  lud16: string | undefined = "new@wallet.example",
  meta: Partial<ProfileResult["meta"]> = {}
): ProfileResult {
  return {
    data: { [MERCHANT]: { pubkey: MERCHANT, lud16 } },
    meta: {
      source: "public",
      stale: false,
      degraded: false,
      fetchedAt: 3_000,
      capabilities: {
        sortModes: [],
        textSearch: false,
        protectedSummaries: false,
        canonicalFreshness: false,
        cursorPagination: false,
      },
      ...meta,
    },
  }
}

describe("checking an updated order payment address", () => {
  it("discovers an updated address for checkout-persisted private manual orders", async () => {
    const result = await checkOrderPaymentAddressUpdate(
      lifecycle({
        checkoutMode: "external_wallet",
        paymentTarget: { type: "manual" },
      }),
      {},
      { getProfiles: async () => profileResult() }
    )
    expect(result.status).toBe("updated")
  })

  it("checks fresh payment evidence with account authority and preserves the review snapshot", async () => {
    const stored = lifecycle({
      merchantLightningAddress: " Old@wallet.example ",
    })
    const before = structuredClone(stored)
    const queries: Parameters<typeof getProfiles>[0][] = []
    const shouldContinue = () => true
    const result = await checkOrderPaymentAddressUpdate(
      stored,
      {
        accountPubkey: BUYER,
        authenticatedPubkey: BUYER.toUpperCase(),
        shouldContinue,
      },
      {
        getProfiles: async (query) => {
          queries.push(query)
          return profileResult(" New@wallet.example ")
        },
      }
    )

    expect(queries).toEqual([
      {
        pubkeys: [MERCHANT],
        accountPubkey: BUYER,
        authenticatedPubkey: BUYER,
        shouldContinue,
        skipCache: true,
        requireCompleteEvidence: true,
        evidenceScope: "payment",
        priority: "visible",
      },
    ])
    expect(result).toEqual({
      status: "updated",
      update: {
        orderId: stored.orderId,
        merchantPubkey: MERCHANT,
        previousAddress: " Old@wallet.example ",
        newAddress: "new@wallet.example",
        expectedUpdatedAt: 2_000,
      },
    })
    expect(stored).toEqual(before)
  })

  it("accepts positive live address evidence despite partial or capped relay coverage", async () => {
    const result = await checkOrderPaymentAddressUpdate(
      lifecycle(),
      {},
      {
        getProfiles: async () =>
          profileResult("new@wallet.example", { degraded: true, capped: true }),
      }
    )
    expect(result.status).toBe("updated")
  })

  it("does not inherit authenticated relay authority for a guest read", async () => {
    let query: Parameters<typeof getProfiles>[0] | undefined
    await checkOrderPaymentAddressUpdate(
      lifecycle(),
      { accountPubkey: null, authenticatedPubkey: null },
      {
        getProfiles: async (input) => {
          query = input
          return profileResult()
        },
      }
    )
    expect(query?.accountPubkey).toBeNull()
    expect(query?.authenticatedPubkey).toBeUndefined()
  })

  it("reports unchanged for the same normalized Lightning address", async () => {
    expect(
      await checkOrderPaymentAddressUpdate(
        lifecycle(),
        {},
        {
          getProfiles: async () => profileResult(" OLD@wallet.example "),
        }
      )
    ).toEqual({ status: "unchanged" })
  })

  it("rejects cached, stale, and conflicting retained payment evidence", async () => {
    for (const meta of [
      { source: "local_cache" as const, stale: false },
      { source: "public" as const, stale: true },
      { source: "local_cache" as const, stale: true, degraded: true },
      { source: "commerce" as const, stale: false },
    ]) {
      expect(
        await checkOrderPaymentAddressUpdate(
          lifecycle(),
          {},
          {
            getProfiles: async () => profileResult("new@wallet.example", meta),
          }
        )
      ).toEqual({ status: "unavailable" })
    }
  })

  it("requires a present valid address on the exact requested merchant profile", async () => {
    const missingAddress = profileResult()
    delete missingAddress.data[MERCHANT]!.lud16
    const wrongMerchant = profileResult()
    wrongMerchant.data[MERCHANT]!.pubkey = OTHER
    const absentMerchant = profileResult()
    absentMerchant.data = {
      [OTHER]: { pubkey: OTHER, lud16: "new@wallet.example" },
    }
    for (const result of [
      missingAddress,
      profileResult(""),
      profileResult("not-a-lightning-address"),
      wrongMerchant,
      absentMerchant,
    ]) {
      expect(
        await checkOrderPaymentAddressUpdate(
          lifecycle(),
          {},
          {
            getProfiles: async () => result,
          }
        )
      ).toEqual({ status: "unavailable" })
    }
  })

  it("does no profile lookup when payment evidence exists or no saved address can be replaced", async () => {
    let calls = 0
    for (const stored of [
      lifecycle({ invoice: "synthetic-existing-invoice" }),
      lifecycle({ paymentStatus: "ambiguous" }),
      lifecycle({ merchantLightningAddress: undefined }),
    ]) {
      expect(
        await checkOrderPaymentAddressUpdate(
          stored,
          {},
          {
            getProfiles: async () => {
              calls += 1
              return profileResult()
            },
          }
        )
      ).toEqual({ status: "not_eligible" })
    }
    expect(calls).toBe(0)
  })

  it("does no profile lookup for an invalid merchant identity", async () => {
    let calls = 0
    expect(
      await checkOrderPaymentAddressUpdate(
        lifecycle({ merchantPubkey: "invalid-merchant" }),
        {},
        {
          getProfiles: async () => {
            calls += 1
            return profileResult()
          },
        }
      )
    ).toEqual({ status: "unavailable" })
    expect(calls).toBe(0)
  })

  it("returns unavailable without exposing an unexpected lookup error", async () => {
    expect(
      await checkOrderPaymentAddressUpdate(
        lifecycle(),
        {},
        {
          getProfiles: async () => {
            throw new Error("synthetic provider details must not reach the UI")
          },
        }
      )
    ).toEqual({ status: "unavailable" })
  })

  it("rejects a cancelled account session before any lookup", async () => {
    let calls = 0
    await expect(
      checkOrderPaymentAddressUpdate(
        lifecycle(),
        { shouldContinue: () => false },
        {
          getProfiles: async () => {
            calls += 1
            return profileResult()
          },
        }
      )
    ).rejects.toThrow("The connected account changed.")
    expect(calls).toBe(0)
  })

  it("rejects account changes during either a successful or failed lookup", async () => {
    for (const fails of [false, true]) {
      let currentSession = true
      await expect(
        checkOrderPaymentAddressUpdate(
          lifecycle(),
          { shouldContinue: () => currentSession },
          {
            getProfiles: async () => {
              currentSession = false
              if (fails) throw new Error("synthetic transport cancellation")
              return profileResult()
            },
          }
        )
      ).rejects.toThrow("The connected account changed.")
    }
  })

  it("retains the pre-lookup snapshot if the caller's lifecycle changes while waiting", async () => {
    const stored = lifecycle()
    const result = await checkOrderPaymentAddressUpdate(
      stored,
      {},
      {
        getProfiles: async () => {
          stored.merchantLightningAddress =
            "changed-while-waiting@wallet.example"
          stored.updatedAt = 4_000
          return profileResult()
        },
      }
    )
    expect(result).toEqual({
      status: "updated",
      update: {
        orderId: stored.orderId,
        merchantPubkey: MERCHANT,
        previousAddress: "old@wallet.example",
        newAddress: "new@wallet.example",
        expectedUpdatedAt: 2_000,
      },
    })
  })
})

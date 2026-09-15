import { describe, expect, it } from "bun:test"
import {
  isValidLud16Address,
  type getProfiles,
  type OrderLifecycle,
  type SelectedProfileContext,
} from "@conduit/core"
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
    profileContexts: {
      [MERCHANT]: context(
        lud16,
        meta.source === undefined || meta.source === "public"
          ? !meta.stale
          : false
      ),
    },
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

function context(
  lud16: string | undefined,
  observed = true
): SelectedProfileContext {
  const known = observed && isValidLud16Address(lud16?.trim() ?? "")
  return {
    profile: { pubkey: MERCHANT, lud16 },
    frontier: known
      ? {
          eventId: "d".repeat(64),
          eventCreatedAt: 3,
          rawContent: JSON.stringify({ lud16 }),
          validity: "valid",
        }
      : undefined,
    freshness: known ? "observed" : "unobserved",
    persistence: known ? "durable" : "unknown",
    readComplete: true,
  }
}

function setFrontier(
  result: ProfileResult,
  state:
    | "observed_valid"
    | "observed_malformed"
    | "retained_valid"
    | "retained_malformed"
    | "not_observed"
) {
  const selected = result.profileContexts[MERCHANT]!
  const malformed = state.endsWith("malformed")
  result.profileContexts[MERCHANT] = {
    ...selected,
    freshness:
      state === "not_observed"
        ? "unobserved"
        : state.startsWith("retained")
          ? "retained"
          : "observed",
    frontier:
      state === "not_observed"
        ? undefined
        : {
            eventId: "d".repeat(64),
            eventCreatedAt: 3,
            rawContent: malformed
              ? "invalid-json"
              : JSON.stringify({ lud16: selected.profile.lud16 }),
            validity: malformed ? "malformed" : "valid",
          },
  }
}

function observedProfileResult(
  lud16: string | undefined,
  frontierState: "observed_valid" | "observed_malformed" = "observed_valid"
): ProfileResult {
  const result = profileResult(lud16 ?? "")
  if (lud16 === undefined) delete result.data[MERCHANT]!.lud16
  result.profileContexts[MERCHANT]!.profile.lud16 = lud16
  setFrontier(result, frontierState)
  return result
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

  it("distinguishes an observed signed removal or unusable address from unavailable evidence", async () => {
    const partialObservedRemoval = observedProfileResult(undefined)
    partialObservedRemoval.meta.degraded = true
    partialObservedRemoval.meta.capped = true
    for (const result of [
      observedProfileResult(undefined),
      observedProfileResult(""),
      observedProfileResult("not-a-lightning-address"),
      observedProfileResult(undefined, "observed_malformed"),
      partialObservedRemoval,
    ]) {
      expect(
        await checkOrderPaymentAddressUpdate(
          lifecycle(),
          {},
          { getProfiles: async () => result }
        )
      ).toEqual({ status: "current_address_unusable" })
    }
  })

  it("keeps unobserved complete and partial reads in the saved-address retry lane", async () => {
    for (const freshness of [
      { degraded: false, capped: false },
      { degraded: true, capped: true },
    ]) {
      const result = profileResult("")
      delete result.data[MERCHANT]!.lud16
      Object.assign(result.meta, freshness)
      setFrontier(result, "not_observed")

      expect(
        await checkOrderPaymentAddressUpdate(
          lifecycle(),
          {},
          { getProfiles: async () => result }
        )
      ).toEqual({ status: "unavailable" })
    }
  })

  it("preserves known unusable payment authority through stale or failed reads", async () => {
    for (const state of [
      "retained_valid",
      "retained_malformed",
      "observed_valid",
      "observed_malformed",
    ] as const) {
      for (const lud16 of [undefined, "invalid"]) {
        const result = observedProfileResult(lud16)
        Object.assign(result.meta, {
          source: "local_cache",
          stale: true,
          degraded: true,
          profileFrontierStates: { [MERCHANT]: state },
        })
        setFrontier(result, state)
        expect(
          await checkOrderPaymentAddressUpdate(
            lifecycle(),
            {},
            {
              getProfiles: async () => result,
            }
          )
        ).toEqual({ status: "current_address_unusable" })
      }
    }
  })

  it("uses retained valid authority only to veto a contradicted destination", async () => {
    for (const [address, status] of [
      ["new@wallet.example", "current_address_changed"],
      [" OLD@wallet.example ", "unavailable"],
    ]) {
      const result = profileResult(address, {
        source: "local_cache",
        stale: true,
        degraded: true,
      })
      setFrontier(result, "retained_valid")
      expect(
        await checkOrderPaymentAddressUpdate(
          lifecycle(),
          {},
          {
            getProfiles: async () => result,
          }
        )
      ).toEqual({ status })
    }
  })

  it("does not mistake retained authority for fresh positive evidence", async () => {
    const result = profileResult("new@wallet.example")
    setFrontier(result, "retained_valid")
    expect(
      await checkOrderPaymentAddressUpdate(
        lifecycle(),
        {},
        {
          getProfiles: async () => result,
        }
      )
    ).toEqual({ status: "current_address_changed" })
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
    missingAddress.profileContexts[MERCHANT] = context(undefined)
    const wrongMerchant = profileResult()
    wrongMerchant.profileContexts[MERCHANT]!.profile.pubkey = OTHER
    const absentMerchant = profileResult()
    absentMerchant.profileContexts = {}
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

  it("checks current authority for retryable states that cannot replace their address", async () => {
    for (const overrides of [
      { invoice: "synthetic-existing-invoice" },
      { paymentHash: "d".repeat(64) },
      { invoiceExpiresAt: 4_000 },
      { proofDeliveryStatus: "sent" as const },
      {
        paymentStatus: "not_started" as const,
        invoiceStatus: "not_requested" as const,
      },
    ]) {
      const stored = lifecycle(overrides)
      const before = structuredClone(stored)
      for (const [profile, status] of [
        [observedProfileResult(undefined), "current_address_unusable"],
        [observedProfileResult("invalid"), "current_address_unusable"],
        [
          observedProfileResult("new@wallet.example"),
          "current_address_changed",
        ],
        [observedProfileResult(" OLD@wallet.example "), "unchanged"],
        [profileResult("", { degraded: true }), "unavailable"],
        [profileResult("new@wallet.example", { stale: true }), "unavailable"],
      ] as const) {
        let calls = 0
        expect(
          await checkOrderPaymentAddressUpdate(
            stored,
            {},
            {
              getProfiles: async () => {
                calls += 1
                return profile
              },
            }
          )
        ).toEqual({ status })
        expect(calls).toBe(1)
        expect(stored).toEqual(before)
      }
    }
  })

  it("keeps unavailable reads retryable when an invoice is retained", async () => {
    expect(
      await checkOrderPaymentAddressUpdate(
        lifecycle({ invoice: "synthetic-existing-invoice" }),
        {},
        {
          getProfiles: async () => {
            throw new Error("Synthetic outage")
          },
        }
      )
    ).toEqual({ status: "unavailable" })
  })

  it("does no profile lookup when ordinary retry is unsafe or no saved address exists", async () => {
    let calls = 0
    for (const stored of [
      lifecycle({ paymentStatus: "ambiguous" }),
      lifecycle({ paymentStatus: "paid" }),
      lifecycle({ phase: "completed" }),
      lifecycle({ phase: "cancelled" }),
      lifecycle({ orderDeliveryStatus: "pending" }),
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

import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  calculateCheckoutSparkInboundNetworkAllowanceSats,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeeRecipient,
  getNdk,
} from "@conduit/core"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  canRetryCheckoutSparkSettledPreparation,
  canRetryCheckoutSparkSettledPayoutPreflight,
  CheckoutSparkSettledPayoutPreflightError,
  prepareCheckoutSparkSettledDigitalOrder,
} from "../apps/market/src/lib/checkout-spark-settled-entry"
import type { PrepareCheckoutSparkSettledDigitalOrderInput } from "../apps/market/src/lib/checkout-spark-settled-entry"
import {
  CheckoutSparkSettledFundingMetadataPreflightError,
  type PreparedCheckoutSparkSettledFunding,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import type { PublishedCheckoutSparkBoundOrder } from "../apps/market/src/lib/checkout-spark-bound-order"
import { checkoutSparkQuoteFixture } from "./support/checkout-spark-quote-fixture"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import { plainTestSigner } from "./helpers/plain-signer"

const NOW = 1_800_000_000_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const MERCHANT_PROFILE = finalizeEvent(
  {
    kind: 0,
    created_at: NOW / 1_000,
    tags: [],
    content: JSON.stringify({ lud16: "merchant@example.com" }),
  },
  MERCHANT_SECRET
)
const BUYER = plainTestSigner(NDKPrivateKeySigner.generate())

function request(): PrepareCheckoutSparkSettledDigitalOrderInput {
  const quote = checkoutSparkQuoteFixture(MERCHANT_SECRET)
  return {
    checkoutId: "settled-entry-checkout",
    orderId: "settled-entry-order",
    buyer: { kind: "signed_in", pubkey: BUYER.pubkey, signer: BUYER },
    network: "mainnet",
    nowMs: NOW,
    shouldContinue: () => true,
    quoteAuthority: {
      ...quote,
      pricing: {
        ...quote.pricing,
        itemSubtotalSats: 1_000,
        totalMsats: 1_000_000,
        paymentRequired: true,
        approximate: false,
        shippingCost: {
          status: "not_required",
          totalSats: 0,
          missingProductIds: [],
        },
        items: [
          {
            ...quote.pricing.items[0]!,
            format: "digital",
            currency: "SATS",
            shippingCostSats: undefined,
          },
        ],
      },
    },
  }
}

describe("settled Spark checkout entry", () => {
  function guestRequest() {
    const input = request()
    input.buyer = createSessionGuestOrderSigningIdentity(
      input.orderId,
      MERCHANT,
      {
        nowMs: NOW,
        storage: null,
      }
    )
    input.guestContact = { email: "guest@example.com", phone: "+15555550100" }
    input.note = "Private delivery instructions"
    return input
  }

  it("prepares a scoped guest router with no account authority and contact only in the private order", async () => {
    const input = guestRequest()
    let preparedCalls = 0
    let publishedCalls = 0
    await prepareCheckoutSparkSettledDigitalOrder(input, {
      now: () => NOW + 1_000,
      ndk: getNdk(),
      readRecipientPayout: async (read) => {
        expect(read.accountPubkey).toBeNull()
        expect(read.authenticatedPubkey).toBeNull()
        expect(read.shouldContinue()).toBe(true)
        return {
          state: "ready",
          recipientPubkey: MERCHANT,
          lud16: "merchant@example.com",
          profileEventId: MERCHANT_PROFILE.id,
          profileEventCreatedAt: NOW / 1_000,
          signedEvent: MERCHANT_PROFILE,
        }
      },
      prepareFunding: async (terms) => {
        preparedCalls++
        expect(terms.identity).toEqual(input.buyer)
        expect(terms.shouldContinue?.()).toBe(true)
        expect(terms).not.toHaveProperty("guestContact")
        expect(terms).not.toHaveProperty("note")
        return {
          plan: { createdAt: NOW + 500 },
        } as PreparedCheckoutSparkSettledFunding
      },
      publishOrder: async (publish) => {
        publishedCalls++
        expect(publish.authenticatedPubkey).toBeNull()
        expect(publish.buyer).toEqual(input.buyer)
        expect(publish.order.buyerIdentityKind).toBe("guest_ephemeral")
        expect(publish.order.guestContact).toEqual(input.guestContact)
        expect(publish.order.note).toBe(input.note)
        expect(publish.order.createdAt).toBe(NOW + 500)
        expect(publish.order).not.toHaveProperty("guestSessionExpiresAt")
        return { orderId: input.orderId } as PublishedCheckoutSparkBoundOrder
      },
    })
    expect(preparedCalls).toBe(1)
    expect(publishedCalls).toBe(1)
  })

  it.each([
    "missing_contact",
    "missing_phone",
    "wrong_order",
    "wrong_merchant",
    "expired",
    "wrong_signer",
  ])(
    "rejects invalid guest checkout before network or wallet work: %s",
    async (mode) => {
      const input = guestRequest()
      if (input.buyer.kind !== "guest_ephemeral")
        throw new Error("Expected guest")
      if (mode === "missing_contact") input.guestContact = undefined
      if (mode === "missing_phone")
        input.guestContact = { email: "guest@example.com" }
      if (mode === "wrong_order") input.buyer.orderId = "other-order"
      if (mode === "wrong_merchant") input.buyer.merchantPubkey = "f".repeat(64)
      if (mode === "wrong_signer")
        input.buyer.signer = plainTestSigner(NDKPrivateKeySigner.generate())
      let calls = 0
      await expect(
        prepareCheckoutSparkSettledDigitalOrder(input, {
          now: () =>
            mode === "expired" && input.buyer.kind === "guest_ephemeral"
              ? input.buyer.expiresAt
              : NOW,
          readRecipientPayout: async () => {
            calls++
            throw new Error("must not read")
          },
          prepareFunding: async () => {
            calls++
            throw new Error("must not prepare")
          },
          publishOrder: async () => {
            calls++
            throw new Error("must not publish")
          },
        })
      ).rejects.toThrow()
      expect(calls).toBe(0)
    }
  )

  it.each(["profile", "preparation"])(
    "rechecks the guest lifetime after %s settles",
    async (step) => {
      const input = guestRequest()
      if (input.buyer.kind !== "guest_ephemeral")
        throw new Error("Expected guest")
      const expiresAt = input.buyer.expiresAt
      let now = NOW
      let preparedCalls = 0
      let publishedCalls = 0
      await expect(
        prepareCheckoutSparkSettledDigitalOrder(input, {
          now: () => now,
          readRecipientPayout: async () => {
            if (step === "profile") now = expiresAt
            return {
              state: "ready",
              recipientPubkey: MERCHANT,
              lud16: "merchant@example.com",
              profileEventId: MERCHANT_PROFILE.id,
              profileEventCreatedAt: NOW / 1_000,
              signedEvent: MERCHANT_PROFILE,
            }
          },
          prepareFunding: async () => {
            preparedCalls++
            now = expiresAt
            return {
              plan: { createdAt: NOW },
            } as PreparedCheckoutSparkSettledFunding
          },
          publishOrder: async () => {
            publishedCalls++
            throw new Error("must not publish")
          },
        })
      ).rejects.toThrow("buyer session changed")
      expect(preparedCalls).toBe(step === "profile" ? 0 : 1)
      expect(publishedCalls).toBe(0)
    }
  )

  it("freezes only the signed merchant endpoint and Conduit allowlist before gross funding", async () => {
    const input = request()
    const conduitFee = calculateConduitCheckoutFeeSats(1_000)
    const gross =
      1_000 +
      conduitFee +
      calculateCheckoutSparkInboundNetworkAllowanceSats(1_000)
    const prepared = {
      plan: { createdAt: NOW },
    } as PreparedCheckoutSparkSettledFunding
    const published = {
      orderId: input.orderId,
      delivery: {},
    } as PublishedCheckoutSparkBoundOrder
    let preparedCalls = 0
    let publishedCalls = 0
    const result = await prepareCheckoutSparkSettledDigitalOrder(input, {
      readRecipientPayout: async (read) => {
        expect(read.recipientPubkey).toBe(MERCHANT)
        return {
          state: "ready",
          recipientPubkey: MERCHANT,
          lud16: "merchant@example.com",
          profileEventId: MERCHANT_PROFILE.id,
          profileEventCreatedAt: NOW / 1_000,
          signedEvent: MERCHANT_PROFILE,
        }
      },
      prepareFunding: async (terms) => {
        preparedCalls += 1
        expect(terms.sourceEvents).toHaveLength(2)
        expect(terms.sourceEvents).toContainEqual(
          structuredClone(MERCHANT_PROFILE)
        )
        expect(terms.sourceEvents).toContainEqual(
          input.quoteAuthority.products[0]!.supplierAllocation!.revisionEvent
        )
        expect(terms.grossFundingSats).toBe(gross)
        expect(terms.grossFundingSats).toBe(1_113)
        expect(terms.fundingExpirySecs).toBe(15 * 60)
        expect(terms.takeoverAt).toBe(NOW + 45 * 60_000)
        expect(terms.recipients).toEqual([
          {
            kind: "merchant",
            recipientId: MERCHANT,
            destination: {
              type: "lightning_address",
              value: "merchant@example.com",
              source: {
                type: "signed_profile",
                profileEventId: MERCHANT_PROFILE.id,
                profileEventCreatedAt: NOW / 1_000,
              },
            },
            weightSats: 1_000,
          },
          {
            kind: "conduit",
            recipientId: checkoutSparkConduitFeeRecipient("production"),
            destination: {
              type: "lightning_address",
              value: checkoutSparkConduitFeeRecipient("production"),
              source: { type: "conduit_allowlist", policy: "production" },
            },
            weightSats: conduitFee,
          },
        ])
        expect(terms).not.toHaveProperty("invoiceWitnesses")
        return prepared
      },
      publishOrder: async (order) => {
        publishedCalls += 1
        expect(order.order.items).toHaveLength(1)
        expect(order.order).not.toHaveProperty("funding")
        expect(order.order).not.toHaveProperty("zap")
        return published
      },
      ndk: {} as ReturnType<typeof getNdk>,
    })
    expect(result).toEqual({ prepared, published })
    expect(preparedCalls).toBe(1)
    expect(publishedCalls).toBe(1)
  })

  it("fails before wallet creation if the merchant has no complete signed payout profile", async () => {
    let preparedCalls = 0
    let publishedCalls = 0
    let failure: unknown
    try {
      await prepareCheckoutSparkSettledDigitalOrder(request(), {
        readRecipientPayout: async () => ({
          state: "unavailable",
          reason: "read_incomplete",
        }),
        prepareFunding: async () => {
          preparedCalls += 1
          throw new Error("must not prepare")
        },
        publishOrder: async () => {
          publishedCalls += 1
          throw new Error("must not publish")
        },
      })
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeInstanceOf(CheckoutSparkSettledPayoutPreflightError)
    expect(failure).toHaveProperty("reason", "read_incomplete")
    expect(failure).toHaveProperty(
      "message",
      "Checkout Spark recipient payout address is not verified (read_incomplete)."
    )
    expect(preparedCalls).toBe(0)
    expect(publishedCalls).toBe(0)
    expect(
      canRetryCheckoutSparkSettledPayoutPreflight({
        cause: failure,
        recoveryState: "absent",
      })
    ).toBe(true)
    for (const recoveryState of ["present", "unreadable"] as const) {
      expect(
        canRetryCheckoutSparkSettledPayoutPreflight({
          cause: failure,
          recoveryState,
        })
      ).toBe(false)
    }
    expect(
      canRetryCheckoutSparkSettledPayoutPreflight({
        cause: new Error("A wallet may already exist."),
        recoveryState: "absent",
      })
    ).toBe(false)
  })

  it("allows metadata preflight retry only when no recovery is present", () => {
    const cause = new CheckoutSparkSettledFundingMetadataPreflightError()
    expect(
      canRetryCheckoutSparkSettledPayoutPreflight({
        cause,
        recoveryState: "absent",
      })
    ).toBe(true)
    for (const recoveryState of ["present", "unreadable"] as const) {
      expect(
        canRetryCheckoutSparkSettledPayoutPreflight({
          cause,
          recoveryState,
        })
      ).toBe(false)
    }
    expect(
      canRetryCheckoutSparkSettledPayoutPreflight({
        cause: new Error("Provider work may have started."),
        recoveryState: "absent",
      })
    ).toBe(false)
  })

  it("retries a failed admission before wallet preparation but not uncertain wallet work", () => {
    const cause = new Error("The cart changed during checkout preparation.")
    expect(
      canRetryCheckoutSparkSettledPreparation({
        cause,
        recoveryState: "absent",
        preparationStarted: false,
      })
    ).toBe(true)
    expect(
      canRetryCheckoutSparkSettledPreparation({
        cause,
        recoveryState: "absent",
        preparationStarted: true,
      })
    ).toBe(false)
    for (const recoveryState of ["present", "unreadable"] as const) {
      expect(
        canRetryCheckoutSparkSettledPreparation({
          cause,
          recoveryState,
          preparationStarted: false,
        })
      ).toBe(false)
    }
  })

  it("rechecks the signed payout profile and prepares exactly once after a safe preflight failure", async () => {
    const input = request()
    let profileReads = 0
    let preparedCalls = 0
    let publishedCalls = 0
    const dependencies = {
      readRecipientPayout: async () => {
        profileReads += 1
        return profileReads === 1
          ? ({ state: "unavailable", reason: "read_incomplete" } as const)
          : ({
              state: "ready",
              recipientPubkey: MERCHANT,
              lud16: "merchant@example.com",
              profileEventId: MERCHANT_PROFILE.id,
              profileEventCreatedAt: NOW / 1_000,
              signedEvent: MERCHANT_PROFILE,
            } as const)
      },
      prepareFunding: async () => {
        preparedCalls += 1
        return {
          plan: { createdAt: NOW },
        } as PreparedCheckoutSparkSettledFunding
      },
      publishOrder: async () => {
        publishedCalls += 1
        return { orderId: input.orderId } as PublishedCheckoutSparkBoundOrder
      },
    }
    await expect(
      prepareCheckoutSparkSettledDigitalOrder(input, dependencies)
    ).rejects.toBeInstanceOf(CheckoutSparkSettledPayoutPreflightError)
    expect(preparedCalls).toBe(0)
    expect(publishedCalls).toBe(0)

    await expect(
      prepareCheckoutSparkSettledDigitalOrder(input, dependencies)
    ).resolves.toMatchObject({ published: { orderId: input.orderId } })
    expect(profileReads).toBe(2)
    expect(preparedCalls).toBe(1)
    expect(publishedCalls).toBe(1)
  })

  it("distinguishes a missing signed payout address without exposing its value", async () => {
    await expect(
      prepareCheckoutSparkSettledDigitalOrder(request(), {
        readRecipientPayout: async () => ({
          state: "unavailable",
          reason: "payment_address_missing",
        }),
        prepareFunding: async () => {
          throw new Error("must not prepare")
        },
      })
    ).rejects.toThrow(
      "Checkout Spark recipient payout address is not verified (payment_address_missing)."
    )
  })

  it("does not reconstruct a missing signed profile from its payment projection", async () => {
    let prepared = false
    await expect(
      prepareCheckoutSparkSettledDigitalOrder(request(), {
        readRecipientPayout: async () => ({
          state: "ready",
          recipientPubkey: MERCHANT,
          lud16: "merchant@example.com",
          profileEventId: MERCHANT_PROFILE.id,
          profileEventCreatedAt: NOW / 1_000,
        }),
        prepareFunding: async () => {
          prepared = true
          throw new Error("must not prepare")
        },
      })
    ).rejects.toHaveProperty("reason", "profile_source_unavailable")
    expect(prepared).toBe(false)
  })
})

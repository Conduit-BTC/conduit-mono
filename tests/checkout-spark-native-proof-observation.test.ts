import { describe, expect, it } from "bun:test"
import {
  proveCheckoutSparkNativeTreasuryHistory,
  type CheckoutSparkNativeRetirementObservation,
  type CheckoutSparkNativeRetirementReader,
} from "../packages/core/src/protocol/checkout-spark-native-retirement"
import {
  proveMerchantCheckoutSparkNativeCommerce,
  type MerchantSparkRecoveryWallet,
} from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import {
  AT,
  nativeTreasuryFixture,
} from "./support/checkout-spark-native-treasury-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

function residualFixture() {
  const calls: string[] = []
  const transfers = ["funding-transfer", "commerce-transfer"].map((id) => ({
    id,
    type: 0,
    status: 5,
    network: 1,
    totalValue: 100,
  }))
  const reader: CheckoutSparkNativeRetirementReader = {
    getTransfers: async () => {
      calls.push("history")
      return { transfers: structuredClone(transfers), offset: -1 }
    },
    getAvailableBalance: async () => {
      calls.push("available")
      return 111n
    },
    getOwnedBalance: async () => {
      calls.push("owned")
      return 111n
    },
    getPendingTransfers: async () => {
      calls.push("pending")
      return []
    },
  }
  const input = {
    authenticatedReader: reader,
    walletId: "synthetic-wallet",
    network: "mainnet" as const,
    sparkAddress: "synthetic-checkout-address",
    stateUpdatedAt: 1,
    expectedTransferIds: transfers.map(({ id }) => id),
    authorizedDebitSats: 112,
    now: () => 2,
  }
  return { input, reader, transfers, calls }
}

async function merchantFixture() {
  const f = nativeTreasuryFixture()
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(32).fill(7))
  )
  const paymentHash = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  const leg = f.state.legs[0]!
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: `lnbc${leg.intent!.invoiceAmountSats * 10}n`,
    createdAt: AT / 1000,
    fields: [
      bolt11PaymentHashField(hash),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const state = {
    ...f.state,
    legs: f.state.legs.map((item, index) =>
      index
        ? item
        : { ...item, intent: { ...item.intent!, paymentRequest, paymentHash } }
    ),
  }
  const request = {
    typename: "LightningSendRequest",
    id: "exact-commerce-request",
    status: "LIGHTNING_PAYMENT_SUCCEEDED",
    fee: { originalValue: 4, originalUnit: "SATOSHI" },
    encodedInvoice: paymentRequest,
    idempotencyKey: leg.intent!.transferId,
    paymentPreimage: "07".repeat(32),
  }
  const residual = residualFixture()
  residual.transfers.splice(
    0,
    residual.transfers.length,
    ...["attributed-credit", leg.intent!.transferId].map((id) => ({
      id,
      type: 0,
      status: 5,
      network: 1,
      totalValue: 100,
    }))
  )
  const calls = residual.calls
  const wallet: MerchantSparkRecoveryWallet = {
    ensurePrivateReady: async () => {},
    cleanup: async () => {},
    getIdentityPublicKey: async () => {
      calls.push("identity")
      return f.plan.funding.receiverIdentityPublicKey
    },
    getLightningReceiveRequest: async () => {
      calls.push("funding")
      return {
        id: f.plan.funding.requestId,
        status: "TRANSFER_COMPLETED",
        network: "MAINNET",
        invoice: {
          encodedInvoice: f.plan.funding.paymentRequest,
          paymentHash: f.plan.funding.paymentHash,
          bitcoinNetwork: "MAINNET",
          amount: { originalValue: 1113, originalUnit: "SATOSHI" },
        },
        transfer: {
          sparkId: "attributed-credit",
          userRequestId: f.plan.funding.requestId,
          totalAmount: { originalValue: 1111, originalUnit: "SATOSHI" },
        },
      }
    },
    getTransfer: async (id) => ({
      id,
      status: "TRANSFER_STATUS_COMPLETED",
      totalValue: 1111,
      transferDirection: "INCOMING",
      receiverIdentityPublicKey: f.plan.funding.receiverIdentityPublicKey,
      userRequest: { id: f.plan.funding.requestId },
    }),
    getTransferFromSsp: async (id) => ({
      sparkId: id,
      totalAmount: { originalValue: 999, originalUnit: "SATOSHI" },
      userRequest: request,
    }),
    getLightningSendRequest: async () => request,
    openRetirementReader: async () => ({
      sparkAddress: residual.input.sparkAddress,
      reader: residual.reader,
    }),
  }
  const repository: Parameters<
    typeof proveMerchantCheckoutSparkNativeCommerce
  >[0]["repository"] = {
    recordMerchantCredit: async () => {
      calls.push("credit")
      return f.record
    },
    recordMerchantPayout: async () => {
      calls.push("commerce")
      return f.record
    },
    loadMerchantSettlement: async () => f.record,
    assertLocalInvoiceOrigin: async () => {
      calls.push("recipient")
    },
  }
  const input = {
    state,
    wallet,
    repository,
    now: () => AT + 100_000,
    assertCurrent: () => {},
  }
  return { ...f, ...residual, input, wallet, repository }
}

describe("native preparation proof observations", () => {
  it("distinguishes residual fund mismatch using only existing reads and finite comparisons", async () => {
    const f = residualFixture()
    const observations: CheckoutSparkNativeRetirementObservation[] = []
    expect(
      await proveCheckoutSparkNativeTreasuryHistory({
        ...f.input,
        onObservation: (observation) => observations.push(observation),
      })
    ).toBe(false)
    expect(f.calls).toEqual([
      "history",
      "history",
      "available",
      "owned",
      "pending",
    ])
    expect(observations.at(-1)).toEqual({
      phase: "funds_read",
      status: "not_verified",
      availableMatchesAuthorized: false,
      ownedMatchesAvailable: true,
      pendingEmpty: true,
    })
  })

  it("distinguishes the funding proof failure before commerce or residual reads", async () => {
    const f = await merchantFixture()
    f.wallet.getLightningReceiveRequest = async () => {
      f.calls.push("funding")
      return null
    }
    const observations: CheckoutSparkNativeRetirementObservation[] = []
    await expect(
      proveMerchantCheckoutSparkNativeCommerce({
        ...f.input,
        onObservation: (observation) => observations.push(observation),
      })
    ).rejects.toThrow("Checkout Spark funding proof is unavailable.")
    expect(f.calls).toEqual(["identity", "funding"])
    expect(observations.at(-1)).toEqual({
      phase: "funding_proof",
      status: "not_verified",
    })
  })

  it("keeps incomplete exact history distinct from unread residual funds", async () => {
    const f = residualFixture()
    f.transfers.pop()
    const observations: CheckoutSparkNativeRetirementObservation[] = []
    expect(
      await proveCheckoutSparkNativeTreasuryHistory({
        ...f.input,
        onObservation: (observation) => observations.push(observation),
      })
    ).toBe(false)
    expect(f.calls).toEqual(["history"])
    expect(observations.at(-1)).toEqual({
      phase: "history_first_read",
      status: "not_verified",
    })
  })

  it.each([
    {
      available: 111n,
      owned: 112n,
      pending: [],
      matches: [false, false, true],
    },
    { available: 112n, owned: 111n, pending: [], matches: [true, false, true] },
    {
      available: 112n,
      owned: 112n,
      pending: [{ id: "pending-transfer" }],
      matches: [true, true, false],
    },
  ])("reports only comparisons for residual mismatch %#", async (sample) => {
    const f = residualFixture()
    f.reader.getAvailableBalance = async () => sample.available
    f.reader.getOwnedBalance = async () => sample.owned
    f.reader.getPendingTransfers = async () =>
      sample.pending as Awaited<
        ReturnType<CheckoutSparkNativeRetirementReader["getPendingTransfers"]>
      >
    const observations: CheckoutSparkNativeRetirementObservation[] = []
    expect(
      await proveCheckoutSparkNativeTreasuryHistory({
        ...f.input,
        onObservation: (observation) => observations.push(observation),
      })
    ).toBe(false)
    expect(observations.at(-1)).toEqual({
      phase: "funds_read",
      status: "not_verified",
      availableMatchesAuthorized: sample.matches[0],
      ownedMatchesAvailable: sample.matches[1],
      pendingEmpty: sample.matches[2],
    })
  })

  it("retains the last completed comparison if a later read is unavailable", async () => {
    const f = residualFixture()
    f.reader.getOwnedBalance = async () => {
      throw new Error("Provider detail must not reach observations")
    }
    const observations: CheckoutSparkNativeRetirementObservation[] = []
    expect(
      await proveCheckoutSparkNativeTreasuryHistory({
        ...f.input,
        onObservation: (observation) => observations.push(observation),
      })
    ).toBe(false)
    expect(observations.at(-1)).toEqual({
      phase: "funds_read",
      status: "not_verified",
      availableMatchesAuthorized: false,
    })
  })

  it("distinguishes wallet identity and commerce proof failures before residual reads", async () => {
    const wallet = await merchantFixture()
    wallet.wallet.getIdentityPublicKey = async () => "invalid-identity"
    const observations: CheckoutSparkNativeRetirementObservation[] = []
    await expect(
      proveMerchantCheckoutSparkNativeCommerce({
        ...wallet.input,
        onObservation: (observation) => observations.push(observation),
      })
    ).rejects.toThrow("Checkout Spark wallet identity changed.")
    expect(observations.at(-1)).toEqual({
      phase: "wallet_validation",
      status: "not_verified",
    })
    expect(wallet.calls).toEqual([])

    const commerce = await merchantFixture()
    commerce.repository.assertLocalInvoiceOrigin = async () => {
      throw new Error("Recipient proof unavailable")
    }
    observations.length = 0
    await expect(
      proveMerchantCheckoutSparkNativeCommerce({
        ...commerce.input,
        onObservation: (observation) => observations.push(observation),
      })
    ).rejects.toThrow("Recipient proof unavailable")
    expect(observations.at(-1)).toEqual({
      phase: "commerce_proof",
      status: "not_verified",
    })
    expect(commerce.calls).toEqual(["identity", "funding", "credit"])
  })

  it("forwards residual observations through the actual Merchant proof seam", async () => {
    const f = await merchantFixture()
    const observations: CheckoutSparkNativeRetirementObservation[] = []
    await expect(
      proveMerchantCheckoutSparkNativeCommerce({
        ...f.input,
        onObservation: (observation) => observations.push(observation),
      })
    ).rejects.toThrow("Checkout Spark native residual history is unavailable.")
    expect(observations).toContainEqual({
      phase: "funding_proof",
      status: "verified",
    })
    expect(observations).toContainEqual({
      phase: "commerce_proof",
      status: "verified",
    })
    expect(observations.at(-1)).toEqual({
      phase: "funds_read",
      status: "not_verified",
      availableMatchesAuthorized: false,
      ownedMatchesAvailable: true,
      pendingEmpty: true,
    })
    expect(f.calls).toEqual([
      "identity",
      "funding",
      "credit",
      "recipient",
      "commerce",
      "history",
      "history",
      "available",
      "owned",
      "pending",
    ])
    expect(
      observations.every((observation) =>
        Object.entries(observation).every(([key, value]) =>
          key === "phase" || key === "status"
            ? typeof value === "string"
            : [
                "availableMatchesAuthorized",
                "ownedMatchesAvailable",
                "pendingEmpty",
              ].includes(key) && typeof value === "boolean"
        )
      )
    ).toBe(true)
  })

  it.each(["throw", "reject"])(
    "ignores observer %s without changing proof verdict or provider reads",
    async (failure) => {
      const observed = await merchantFixture()
      observed.reader.getAvailableBalance = async () => {
        observed.calls.push("available")
        return 112n
      }
      observed.reader.getOwnedBalance = async () => {
        observed.calls.push("owned")
        return 112n
      }
      const expected = await proveMerchantCheckoutSparkNativeCommerce(
        observed.input
      )
      const expectedCalls = [...observed.calls]
      observed.calls.length = 0
      expect(
        await proveMerchantCheckoutSparkNativeCommerce({
          ...observed.input,
          onObservation: () => {
            if (failure === "reject")
              return Promise.reject(new Error("Observer"))
            throw new Error("Observer")
          },
        })
      ).toEqual(expected)
      expect(observed.calls).toEqual(expectedCalls)
    }
  )

  it("preserves receipt-only proof without opening a residual reader", async () => {
    const f = await merchantFixture()
    f.wallet.openRetirementReader = async () => {
      throw new Error("Receipt mode must not open this reader")
    }
    const observations: CheckoutSparkNativeRetirementObservation[] = []
    expect(
      await proveMerchantCheckoutSparkNativeCommerce({
        ...f.input,
        proofMode: "receipt",
        onObservation: (observation) => observations.push(observation),
      })
    ).toEqual(f.record)
    expect(observations.at(-1)).toEqual({
      phase: "commerce_proof",
      status: "verified",
    })
    expect(f.calls).toEqual([
      "identity",
      "funding",
      "credit",
      "recipient",
      "commerce",
    ])
  })
})

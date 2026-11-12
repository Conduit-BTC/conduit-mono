import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  freezeCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledPlan,
  deriveCheckoutSparkSettledTransferId,
  deriveCheckoutSparkSettledRenewalTransferId,
  restoreCheckoutSparkSettledReconciliation,
  renewCheckoutSparkSettledLeg,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { checkoutSparkCommerceQuoteDigestValue } from "../packages/core/src/protocol/checkout-spark-commerce-pricing"
import {
  deriveCheckoutSparkNativeTreasuryBudget,
  prepareCheckoutSparkNativeTreasury,
  recordCheckoutSparkNativeTreasuryStatus,
} from "../packages/core/src/protocol/checkout-spark-treasury-finalization"
import {
  restoreCheckoutSparkMerchantSettlementRecord,
  projectCheckoutSparkMerchantSettlement,
  recordCheckoutSparkMerchantTreasury,
} from "../packages/core/src/protocol/checkout-spark-merchant-settlement"
import {
  proveCheckoutSparkSettledReturnedTransfer,
  assertCheckoutSparkSettledReturnedProof,
} from "../packages/core/src/protocol/checkout-spark-settled-returned"
import { classifyCheckoutSparkSettledPayment } from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import {
  classifyCheckoutSparkSettledExactOutgoingHistory,
  requireCheckoutSparkSettledExactOutgoingRequest,
} from "../packages/core/src/protocol/checkout-spark-settled-outgoing-history"
import {
  preparedSettledLegState,
  outgoingTargetFor,
  LEG_FIXTURE_CREATED_AT as AT,
} from "./support/checkout-spark-settled-leg-fixture"
import {
  settlementModelPlan,
  paidSettlementModel,
  settlementInvoice,
} from "./support/checkout-spark-settlement-model-fixture"

describe("settlement model extraction characterization", () => {
  const vectors = {
    3: [
      "e98e6603e084fedfea2c2f8cbf3112d00b5f10024cfbb1a9a6cf4b86feec3611",
      "05e52873-695d-559a-b9b9-0923069cf015",
      "11979599-948f-586c-915d-fc8ae960ea54",
    ],
    4: [
      "02f0ed14a663c775f983a948136cf1d805d38a9bb1c6d0575d5a5141fb548bf1",
      "a8e34ba6-7806-521c-b239-eec7517e4cfc",
      "2b53a5de-fb58-52d5-8054-63538f111799",
    ],
    5: [
      "5304cf32226a2a053f23ffdcb6ba2f9b63c03f87109564f18596a242b0404cd9",
      "7bd227cb-b5b7-5ea3-959e-5e45097f329e",
      "4eca7e46-654e-553b-9ef2-ef9db6c8f9f3",
    ],
  }
  for (const version of [3, 4, 5] as const) {
    it(`restores frozen v${version} terms and rejects tampering at ID derivation`, () => {
      const plan = settlementModelPlan(version)
      const restored = restoreCheckoutSparkSettledPlan(structuredClone(plan))
      expect(restored).toEqual(plan)
      for (const value of [
        restored,
        restored.funding,
        restored.recipients,
        restored.recipients[0],
        restored.recipients[0]!.destination,
      ])
        expect(Object.isFrozen(value)).toBe(true)
      const id = deriveCheckoutSparkSettledTransferId(
        plan,
        plan.recipients[0]!.legId
      )
      expect([
        plan.planDigest,
        id,
        deriveCheckoutSparkSettledRenewalTransferId(
          plan,
          plan.recipients[0]!.legId
        ),
      ]).toEqual(vectors[version])
      expect(
        deriveCheckoutSparkSettledTransferId(
          restored,
          restored.recipients[0]!.legId
        )
      ).toBe(id)
      expect(
        deriveCheckoutSparkSettledRenewalTransferId(
          plan,
          plan.recipients[0]!.legId
        )
      ).not.toBe(id)
      for (const tampered of [
        { ...plan, planDigest: "0".repeat(64) },
        { ...plan, orderId: "other-order" },
        { ...plan, recipients: [...plan.recipients].reverse() },
        {
          ...plan,
          recipients: plan.recipients.map((r, i) =>
            i ? r : { ...r, weightSats: r.weightSats + 1 }
          ),
        },
      ])
        expect(() =>
          deriveCheckoutSparkSettledTransferId(
            tampered,
            plan.recipients[0]!.legId
          )
        ).toThrow()
      if (version !== 3) {
        expect(() =>
          deriveCheckoutSparkSettledTransferId(
            {
              ...plan,
              nativeTreasury: { ...plan.nativeTreasury!, invoiceId: "wrong" },
            },
            plan.recipients[0]!.legId
          )
        ).toThrow()
        expect(() =>
          deriveCheckoutSparkSettledTransferId(plan, plan.recipients[1]!.legId)
        ).toThrow("no local provider transfer ID")
      }
    })
  }

  it("restores a historical pre-allowance v3 invoice without allowing a new one", () => {
    const base = settlementModelPlan(3)
    const funding = {
      ...base.funding,
      grossFundingSats: 1_111,
      paymentRequest: settlementInvoice(1_111, new Uint8Array(32).fill(3)),
    }
    const legacy = { ...base, funding }
    const tuple = [
      "conduit:checkout-spark-settled-plan:v3",
      3,
      base.checkoutId,
      base.orderId,
      base.merchantPubkey,
      base.walletId,
      base.network,
      base.createdAt,
      base.takeoverAt,
      checkoutSparkCommerceQuoteDigestValue(base.commerceQuote),
      [
        funding.requestId,
        funding.paymentRequest,
        funding.paymentHash,
        funding.receiverIdentityPublicKey,
        funding.grossFundingSats,
        funding.createdAt,
        funding.expiresAt,
      ],
      base.recipients.map((r) => [
        r.position,
        r.legId,
        r.kind,
        r.recipientId,
        r.destination.type,
        r.destination.value,
        r.destination.source.type === "signed_profile"
          ? [
              r.destination.source.type,
              r.destination.source.profileEventId,
              r.destination.source.profileEventCreatedAt,
            ]
          : [r.destination.source.type, "production"],
        r.weightSats,
      ]),
    ]
    legacy.planDigest = createHash("sha256")
      .update(JSON.stringify(tuple))
      .digest("hex")
    expect(restoreCheckoutSparkSettledPlan(legacy)).toEqual(legacy)
    expect(() => freezeCheckoutSparkSettledPlan(legacy)).toThrow(
      "gross funding differs"
    )
  })

  for (const version of [4, 5] as const) {
    it(`preserves v${version} exact paid accounting and recipient attribution`, () => {
      const { state, record } = paidSettlementModel(version)
      const budget = deriveCheckoutSparkNativeTreasuryBudget(state, record)
      expect(budget).toMatchObject({
        baseConduitAllocationSats: 111,
        unusedCommerceReserveSats: 1,
        authorizedDebitSats: 112,
      })
      expect(Object.isFrozen(budget)).toBe(true)
      if (version === 4)
        expect(budget.accountingDigest).toBe(
          "57a2c0949e9c704649f09adc7181211c9de4275a10d5c719d98f56c31396a5d5"
        )
      expect(projectCheckoutSparkMerchantSettlement(record)).toMatchObject({
        creditVerified: true,
        merchantVerified: true,
        commerceVerified: true,
        feePending: true,
      })
      expect(() =>
        deriveCheckoutSparkNativeTreasuryBudget(state, {
          ...record,
          paidLegs: record.paidLegs.map(({ recipientVerified, ...leg }) => {
            expect(recipientVerified).toBe(true)
            return leg
          }),
        })
      ).toThrow()
      expect(() =>
        deriveCheckoutSparkNativeTreasuryBudget(
          {
            ...state,
            legs: state.legs.map((leg, i) =>
              i
                ? leg
                : {
                    ...leg,
                    status: "submitted",
                    finalFeeSats: null,
                    finalDebitSats: null,
                  }
            ),
          },
          record
        )
      ).toThrow()
      const copy = restoreCheckoutSparkMerchantSettlementRecord(
        record,
        state.plan
      )
      expect(copy).toEqual(record)
      expect(copy.paidLegs).not.toBe(record.paidLegs)
      expect(copy.credit).not.toBe(record.credit)
      expect(() =>
        restoreCheckoutSparkMerchantSettlementRecord({
          ...record,
          extra: true,
        } as typeof record)
      ).toThrow()
      expect(() =>
        restoreCheckoutSparkMerchantSettlementRecord({
          ...record,
          paidLegs: [...record.paidLegs, ...record.paidLegs],
        })
      ).toThrow()
    })
  }

  it("validates native accounting, chronology and the mirrored leg after commerce", () => {
    const { state, record } = paidSettlementModel()
    const prepared = prepareCheckoutSparkNativeTreasury(state, {
      settlement: record,
      preparedAt: AT + 4,
    })
    expect(restoreCheckoutSparkSettledReconciliation(prepared)).toEqual(
      prepared
    )
    expect(Object.isFrozen(prepared.treasuryFinalization!.intent)).toBe(true)
    const evidence = {
      invoiceId: prepared.treasuryFinalization!.intent!.invoiceId,
      status: "paid" as const,
      providerTransferId: "native-provider-transfer",
      observedAt: AT + 5,
      finalFeeSats: 0,
      finalDebitSats: 112,
    }
    const paid = recordCheckoutSparkNativeTreasuryStatus(prepared, evidence)
    const collected = recordCheckoutSparkMerchantTreasury(
      record,
      paid,
      evidence
    )
    expect(projectCheckoutSparkMerchantSettlement(collected).feePending).toBe(
      false
    )
    expect(Object.isFrozen(collected.nativeTreasury)).toBe(true)
    for (const change of [{ finalFeeSats: 1 }, { finalDebitSats: 111 }]) {
      expect(() =>
        recordCheckoutSparkNativeTreasuryStatus(prepared, {
          ...evidence,
          ...change,
        })
      ).toThrow()
      expect(() =>
        restoreCheckoutSparkMerchantSettlementRecord({
          ...collected,
          nativeTreasury: { ...collected.nativeTreasury!, ...change },
        } as typeof collected)
      ).toThrow()
    }
    for (const change of [
      { accountingDigest: "0".repeat(64) },
      { preparedAt: AT },
      { amountSats: 113 },
    ])
      expect(() =>
        restoreCheckoutSparkSettledReconciliation({
          ...prepared,
          treasuryFinalization: {
            ...prepared.treasuryFinalization!,
            intent: { ...prepared.treasuryFinalization!.intent!, ...change },
          },
        })
      ).toThrow("native treasury evidence is invalid")
    expect(() =>
      restoreCheckoutSparkSettledReconciliation({
        ...prepared,
        legs: prepared.legs.map((leg, i) =>
          i ? { ...leg, observedAt: AT + 5 } : leg
        ),
        updatedAt: AT + 5,
      })
    ).toThrow("mirror is invalid")
    expect(() =>
      restoreCheckoutSparkSettledReconciliation({
        ...prepared,
        updatedAt: AT,
        treasuryFinalization: null as never,
      })
    ).toThrow("timestamp is stale")
  })

  it("retains exact returned-proof object identity, freshness and renewal ancestry", () => {
    const state = preparedSettledLegState()
    const target = { ...outgoingTargetFor(state), unpaidAllocationSats: 1_111 }
    const nowMs = AT + 3_600_000
    const proof = proveCheckoutSparkSettledReturnedTransfer({
      plan: state.plan,
      target,
      evidence: {
        network: target.network,
        walletIdentityPublicKey: state.plan.funding.receiverIdentityPublicKey,
        transferId: target.intent.transferId,
        requestId: "returned-request",
        paymentRequest: target.intent.paymentRequest,
        paymentHash: target.intent.paymentHash,
        invoiceAmountSats: 995,
        maxFeeSats: 5,
        debitedSats: 999,
        returnedSats: 999,
        availableSats: 1_111,
        sspStatus: "USER_SWAP_RETURNED",
        operatorStatus: "RETURNED",
        htlcStatus: "RETURNED",
        preimage: null,
        returnedLeaves: [{ id: "returned", valueSats: 999 }],
        availableLeaves: [
          { id: "returned", valueSats: 999 },
          { id: "reserve", valueSats: 112 },
        ],
        observedAt: nowMs,
      },
    })
    const input = { plan: state.plan, target, nowMs }
    expect(
      assertCheckoutSparkSettledReturnedProof(proof, input).netDebitSats
    ).toBe(0)
    for (const copied of [
      { ...proof },
      structuredClone(proof),
      JSON.parse(JSON.stringify(proof)),
    ])
      expect(() =>
        assertCheckoutSparkSettledReturnedProof(copied, input)
      ).toThrow()
    for (const at of [nowMs - 1, nowMs + 5_001])
      expect(() =>
        assertCheckoutSparkSettledReturnedProof(proof, { ...input, nowMs: at })
      ).toThrow()
    expect(() =>
      assertCheckoutSparkSettledReturnedProof(proof, {
        ...input,
        target: { ...target, walletId: "other" },
      })
    ).toThrow()
    expect(
      requireCheckoutSparkSettledExactOutgoingRequest(state.plan, target)
        .transferId
    ).toBe(target.intent.transferId)
    const intent = {
      ...target.intent,
      transferId: deriveCheckoutSparkSettledRenewalTransferId(
        state.plan,
        target.legId
      ),
      paymentRequest: settlementInvoice(995, new Uint8Array(32).fill(5), nowMs),
      paymentHash: "05".repeat(32),
      preparedAt: nowMs,
    }
    const renewed = renewCheckoutSparkSettledLeg(state, {
      legId: target.legId,
      intent,
      proof,
      nowMs,
    })
    expect(renewed.legs[0]!.generation).toBe(1)
    expect(renewed.legs[0]!.closedGenerations![0]!.intent).toEqual(
      target.intent
    )
    expect(renewed.legs[0]!.closedGenerations![0]!.closure.netDebitSats).toBe(0)
    expect(() =>
      renewCheckoutSparkSettledLeg(state, {
        legId: target.legId,
        intent,
        proof: structuredClone(proof),
        nowMs,
      })
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkSettledReconciliation({
        ...renewed,
        legs: renewed.legs.map((leg, i) =>
          i
            ? leg
            : {
                ...leg,
                closedGenerations: [
                  {
                    ...leg.closedGenerations![0]!,
                    closure: {
                      ...leg.closedGenerations![0]!.closure,
                      netDebitSats: 1 as 0,
                    },
                  },
                ],
              }
        ),
      })
    ).toThrow()
  })

  it("requires exact debit and cryptographic preimage while retaining history outcomes", async () => {
    const original = outgoingTargetFor(preparedSettledLegState())
    const preimage = new Uint8Array(32).fill(7)
    const hash = createHash("sha256").update(preimage).digest("hex")
    const target = {
      ...original,
      intent: {
        ...original.intent,
        paymentHash: hash,
        paymentRequest: settlementInvoice(995, hashBytes(hash)),
      },
    }
    const payment = {
      status: "completed",
      fees: 4n,
      details: {
        type: "lightning",
        htlcDetails: { paymentHash: hash, preimage: bytesToHex(preimage) },
      },
    }
    expect(
      await classifyCheckoutSparkSettledPayment(payment, target, 999)
    ).toMatchObject({ status: "paid", finalFeeSats: 4, finalDebitSats: 999 })
    for (const bad of [
      { ...payment, fees: 4 },
      { ...payment, fees: 6n },
      {
        ...payment,
        details: {
          ...payment.details,
          htlcDetails: { paymentHash: hash, preimage: "invalid" },
        },
      },
      {
        ...payment,
        details: {
          ...payment.details,
          htlcDetails: {
            paymentHash: "0".repeat(64),
            preimage: bytesToHex(preimage),
          },
        },
      },
    ])
      expect(
        (await classifyCheckoutSparkSettledPayment(bad, target, 999)).status
      ).toBe("conflicting_evidence")
    expect(
      (await classifyCheckoutSparkSettledPayment(payment, target, 998)).status
    ).toBe("conflicting_evidence")
    for (const [status, expected] of [
      ["pending", "pending"],
      ["failed", "terminal_failure"],
    ])
      expect(
        (
          await classifyCheckoutSparkSettledPayment(
            { ...payment, status: status! },
            target
          )
        ).status
      ).toBe(expected)
    for (const status of [
      "not_found",
      "lookup_unavailable",
      "conflicting_evidence",
    ] as const)
      expect(
        (
          await classifyCheckoutSparkSettledExactOutgoingHistory(target, {
            status,
          })
        ).status
      ).toBe(status)
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!
    try {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: undefined,
      })
      expect(
        (await classifyCheckoutSparkSettledPayment(payment, target, 999)).status
      ).toBe("conflicting_evidence")
    } finally {
      Object.defineProperty(globalThis, "crypto", descriptor)
    }
  })
})

function hashBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, (value) =>
    Number.parseInt(value, 16)
  )
}
function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex")
}

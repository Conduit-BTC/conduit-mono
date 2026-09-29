import { describe, expect, it } from "bun:test"

import {
  applyCheckoutSparkEvidence,
  assessCheckoutSparkRetirement,
  createCheckoutSparkReconciliation,
  freezeCheckoutSparkPlan,
  getCheckoutSparkNextAction,
  retireCheckoutSparkReconciliation,
  restoreCheckoutSparkReconciliation,
  runWithCheckoutSparkMerchantRecoveryLock,
  type CheckoutSparkEvidence,
} from "@conduit/core"

const CHECKOUT_ID = "checkout-router-1"
const ORDER_ID = "order-router-1"
const MERCHANT_PUBKEY = "a".repeat(64)
const PAYMENT_HASH = "b".repeat(64)
const CREATED_AT = 1_800_000_000_000

function planInput() {
  return {
    checkoutId: CHECKOUT_ID,
    orderId: ORDER_ID,
    merchantPubkey: MERCHANT_PUBKEY,
    walletId: "checkout-wallet-1",
    network: "mainnet" as const,
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    funding: {
      requestId: "receive-request-1",
      paymentRequest: "lnbc-funding-request",
      paymentHash: PAYMENT_HASH,
      requiredNetSats: 1_235,
      grossFundingSats: 1_240,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 60_000,
    },
    obligations: [
      {
        kind: "merchant" as const,
        recipientId: MERCHANT_PUBKEY,
        paymentRequest: "lnbc-merchant-request",
        amountSats: 1_000,
        maxFeeSats: 100,
      },
      {
        kind: "conduit" as const,
        recipientId: "conduithodlings@strike.me",
        paymentRequest: "lnbc-conduit-request",
        amountSats: 111,
        maxFeeSats: 24,
      },
    ],
  }
}

describe("checkout Spark reconciliation", () => {
  it("freezes one deterministic plan with stable obligation and outgoing IDs", () => {
    const first = freezeCheckoutSparkPlan(planInput())
    const restored = freezeCheckoutSparkPlan(planInput())

    expect(first).toEqual(restored)
    expect(first.planDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(
      first.obligations.map((obligation) => obligation.obligationId)
    ).toEqual(restored.obligations.map((obligation) => obligation.obligationId))
    expect(
      first.obligations.map((obligation) => obligation.outgoingId)
    ).toEqual(restored.obligations.map((obligation) => obligation.outgoingId))
    expect(
      first.obligations.every((obligation) => Object.isFrozen(obligation))
    ).toBe(true)
    expect(Object.isFrozen(first.obligations)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
  })

  it("restores a semantically identical plan without depending on JSON key order", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const reordered = {
      obligations: plan.obligations.map((obligation) => ({
        maxFeeSats: obligation.maxFeeSats,
        amountSats: obligation.amountSats,
        paymentRequest: obligation.paymentRequest,
        recipientId: obligation.recipientId,
        kind: obligation.kind,
        outgoingId: obligation.outgoingId,
        obligationId: obligation.obligationId,
        position: obligation.position,
      })),
      funding: {
        expiresAt: plan.funding.expiresAt,
        createdAt: plan.funding.createdAt,
        grossFundingSats: plan.funding.grossFundingSats,
        requiredNetSats: plan.funding.requiredNetSats,
        paymentHash: plan.funding.paymentHash,
        paymentRequest: plan.funding.paymentRequest,
        requestId: plan.funding.requestId,
      },
      takeoverAt: plan.takeoverAt,
      createdAt: plan.createdAt,
      network: plan.network,
      walletId: plan.walletId,
      merchantPubkey: plan.merchantPubkey,
      orderId: plan.orderId,
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      schemaVersion: 1 as const,
    }

    expect(createCheckoutSparkReconciliation(reordered).plan).toEqual(plan)
  })

  it("reconciles exact funding and proves an outgoing obligation unpaid before send", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    let state = createCheckoutSparkReconciliation(plan)

    expect(
      getCheckoutSparkNextAction(state, {
        actor: "shopper",
        now: CREATED_AT + 1,
      })
    ).toEqual({ type: "reconcile_funding" })

    state = applyCheckoutSparkEvidence(state, {
      type: "funding",
      requestId: plan.funding.requestId,
      paymentRequest: plan.funding.paymentRequest,
      paymentHash: plan.funding.paymentHash,
      walletId: plan.walletId,
      network: plan.network,
      requiredNetSats: plan.funding.requiredNetSats,
      grossFundingSats: plan.funding.grossFundingSats,
      state: "spendable",
      observedAt: CREATED_AT + 10,
    })
    expect(
      getCheckoutSparkNextAction(state, {
        actor: "shopper",
        now: CREATED_AT + 11,
      })
    ).toEqual({
      type: "reconcile_obligation",
      obligationId: plan.obligations[0]!.obligationId,
    })

    const merchant = plan.obligations[0]!
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: merchant.obligationId,
      outgoingId: merchant.outgoingId,
      paymentRequest: merchant.paymentRequest,
      amountSats: merchant.amountSats,
      maxFeeSats: merchant.maxFeeSats,
      state: "not_found",
      observedAt: CREATED_AT + 20,
    })
    expect(
      getCheckoutSparkNextAction(state, {
        actor: "shopper",
        now: CREATED_AT + 21,
      })
    ).toEqual({ type: "send_obligation", obligation: merchant })
  })

  it("transfers send authority at the frozen deadline without reopening paid commerce", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    let state = createCheckoutSparkReconciliation(plan)
    state = applyCheckoutSparkEvidence(state, {
      type: "funding",
      requestId: plan.funding.requestId,
      paymentRequest: plan.funding.paymentRequest,
      paymentHash: plan.funding.paymentHash,
      walletId: plan.walletId,
      network: plan.network,
      requiredNetSats: plan.funding.requiredNetSats,
      grossFundingSats: plan.funding.grossFundingSats,
      state: "spendable",
      observedAt: CREATED_AT + 10,
    })

    const merchant = plan.obligations[0]!
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: merchant.obligationId,
      outgoingId: merchant.outgoingId,
      paymentRequest: merchant.paymentRequest,
      amountSats: merchant.amountSats,
      maxFeeSats: merchant.maxFeeSats,
      state: "paid",
      observedAt: CREATED_AT + 20,
    })
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: merchant.obligationId,
      outgoingId: merchant.outgoingId,
      paymentRequest: merchant.paymentRequest,
      amountSats: merchant.amountSats,
      maxFeeSats: merchant.maxFeeSats,
      state: "not_found",
      observedAt: CREATED_AT + 30,
    })

    const conduit = plan.obligations[1]!
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: conduit.obligationId,
      outgoingId: conduit.outgoingId,
      paymentRequest: conduit.paymentRequest,
      amountSats: conduit.amountSats,
      maxFeeSats: conduit.maxFeeSats,
      state: "not_found",
      observedAt: CREATED_AT + 40,
    })

    expect(state.obligations[0]!.state).toBe("paid")
    expect(
      getCheckoutSparkNextAction(state, {
        actor: "shopper",
        now: plan.takeoverAt,
      })
    ).toEqual({ type: "wait", reason: "execution_authority_transferred" })
    expect(
      getCheckoutSparkNextAction(state, {
        actor: "merchant",
        now: plan.takeoverAt - 1,
      })
    ).toEqual({ type: "wait", reason: "execution_authority_not_started" })
    expect(
      getCheckoutSparkNextAction(state, {
        actor: "merchant",
        now: plan.takeoverAt,
      })
    ).toEqual({ type: "send_obligation", obligation: conduit })
  })

  it("never downgrades paid evidence after a later failed or missing lookup", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const merchant = plan.obligations[0]!
    let state = createCheckoutSparkReconciliation(plan)
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: merchant.obligationId,
      outgoingId: merchant.outgoingId,
      paymentRequest: merchant.paymentRequest,
      amountSats: merchant.amountSats,
      maxFeeSats: merchant.maxFeeSats,
      state: "paid",
      observedAt: CREATED_AT + 10,
    })
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: merchant.obligationId,
      outgoingId: merchant.outgoingId,
      paymentRequest: merchant.paymentRequest,
      amountSats: merchant.amountSats,
      maxFeeSats: merchant.maxFeeSats,
      state: "terminal_failure",
      observedAt: CREATED_AT + 20,
    })

    expect(state.obligations[0]).toEqual({
      obligationId: merchant.obligationId,
      state: "paid",
      observedAt: CREATED_AT + 20,
    })
  })

  it("preserves paid commerce when the later Conduit fee reaches terminal failure", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const merchant = plan.obligations[0]!
    const conduit = plan.obligations[1]!
    let state = createCheckoutSparkReconciliation(plan)
    state = applyCheckoutSparkEvidence(state, {
      type: "funding",
      requestId: plan.funding.requestId,
      paymentRequest: plan.funding.paymentRequest,
      paymentHash: plan.funding.paymentHash,
      walletId: plan.walletId,
      network: plan.network,
      requiredNetSats: plan.funding.requiredNetSats,
      grossFundingSats: plan.funding.grossFundingSats,
      state: "spendable",
      observedAt: CREATED_AT + 10,
    })
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: merchant.obligationId,
      outgoingId: merchant.outgoingId,
      paymentRequest: merchant.paymentRequest,
      amountSats: merchant.amountSats,
      maxFeeSats: merchant.maxFeeSats,
      state: "paid",
      observedAt: CREATED_AT + 20,
    })
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: conduit.obligationId,
      outgoingId: conduit.outgoingId,
      paymentRequest: conduit.paymentRequest,
      amountSats: conduit.amountSats,
      maxFeeSats: conduit.maxFeeSats,
      state: "terminal_failure",
      observedAt: CREATED_AT + 30,
    })

    expect(state.obligations[0]).toEqual({
      obligationId: merchant.obligationId,
      state: "paid",
      observedAt: CREATED_AT + 20,
    })
    expect(
      getCheckoutSparkNextAction(state, {
        actor: "merchant",
        now: plan.takeoverAt,
      })
    ).toEqual({ type: "wait", reason: "obligation_failed" })
  })

  it("keeps paid evidence dominant when same-time terminal observations arrive in either order", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const merchant = plan.obligations[0]!
    let state = createCheckoutSparkReconciliation(plan)
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: merchant.obligationId,
      outgoingId: merchant.outgoingId,
      paymentRequest: merchant.paymentRequest,
      amountSats: merchant.amountSats,
      maxFeeSats: merchant.maxFeeSats,
      state: "terminal_failure",
      observedAt: CREATED_AT + 10,
    })
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: merchant.obligationId,
      outgoingId: merchant.outgoingId,
      paymentRequest: merchant.paymentRequest,
      amountSats: merchant.amountSats,
      maxFeeSats: merchant.maxFeeSats,
      state: "paid",
      observedAt: CREATED_AT + 10,
    })

    expect(state.obligations[0]).toEqual({
      obligationId: merchant.obligationId,
      state: "paid",
      observedAt: CREATED_AT + 10,
    })
  })

  it("rejects funding evidence with different invoice or amount bindings", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const state = createCheckoutSparkReconciliation(plan)

    expect(() =>
      applyCheckoutSparkEvidence(state, {
        type: "funding",
        requestId: plan.funding.requestId,
        paymentRequest: plan.funding.paymentRequest,
        paymentHash: plan.funding.paymentHash,
        walletId: plan.walletId,
        network: plan.network,
        requiredNetSats: plan.funding.requiredNetSats,
        grossFundingSats: plan.funding.grossFundingSats + 1,
        state: "spendable",
        observedAt: CREATED_AT + 1,
      })
    ).toThrow("out of scope")
  })

  it("rejects unknown provider evidence states at the merge boundary", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const state = createCheckoutSparkReconciliation(plan)

    expect(() =>
      applyCheckoutSparkEvidence(state, {
        type: "funding",
        requestId: plan.funding.requestId,
        paymentRequest: plan.funding.paymentRequest,
        paymentHash: plan.funding.paymentHash,
        walletId: plan.walletId,
        network: plan.network,
        requiredNetSats: plan.funding.requiredNetSats,
        grossFundingSats: plan.funding.grossFundingSats,
        state: "provider_guess",
        observedAt: CREATED_AT + 1,
      } as unknown as CheckoutSparkEvidence)
    ).toThrow("evidence state is invalid")
  })

  it("restores interruption state without replaying a settled obligation", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    let state = createCheckoutSparkReconciliation(plan)
    state = applyCheckoutSparkEvidence(state, {
      type: "funding",
      requestId: plan.funding.requestId,
      paymentRequest: plan.funding.paymentRequest,
      paymentHash: plan.funding.paymentHash,
      walletId: plan.walletId,
      network: plan.network,
      requiredNetSats: plan.funding.requiredNetSats,
      grossFundingSats: plan.funding.grossFundingSats,
      state: "spendable",
      observedAt: CREATED_AT + 10,
    })
    const merchant = plan.obligations[0]!
    state = applyCheckoutSparkEvidence(state, {
      type: "obligation",
      obligationId: merchant.obligationId,
      outgoingId: merchant.outgoingId,
      paymentRequest: merchant.paymentRequest,
      amountSats: merchant.amountSats,
      maxFeeSats: merchant.maxFeeSats,
      state: "paid",
      observedAt: CREATED_AT + 20,
    })

    const restored = restoreCheckoutSparkReconciliation(
      JSON.parse(JSON.stringify(state))
    )
    expect(restored.obligations[0]!.state).toBe("paid")
    expect(
      getCheckoutSparkNextAction(restored, {
        actor: "merchant",
        now: plan.takeoverAt,
      })
    ).toEqual({
      type: "reconcile_obligation",
      obligationId: plan.obligations[1]!.obligationId,
    })
  })

  it("rejects restored progress that claims a result without observation evidence", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const serialized = JSON.parse(
      JSON.stringify(createCheckoutSparkReconciliation(plan))
    )
    serialized.funding = { state: "spendable", observedAt: null }

    expect(() => restoreCheckoutSparkReconciliation(serialized)).toThrow(
      "reconciliation state is invalid"
    )
  })

  it("rejects restored plan and outgoing-id tampering", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const serialized = JSON.parse(
      JSON.stringify(createCheckoutSparkReconciliation(plan))
    )
    serialized.plan.obligations[0].outgoingId =
      "00000000-0000-5000-8000-000000000000"
    expect(() => restoreCheckoutSparkReconciliation(serialized)).toThrow(
      "plan integrity check failed"
    )

    const digestTamper = JSON.parse(
      JSON.stringify(createCheckoutSparkReconciliation(plan))
    )
    digestTamper.plan.planDigest = "0".repeat(64)
    expect(() => restoreCheckoutSparkReconciliation(digestTamper)).toThrow(
      "plan integrity check failed"
    )
  })

  it("halts on every inconclusive outgoing state instead of sending", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const merchant = plan.obligations[0]!
    const cases = [
      ["pending", "obligation_pending"],
      ["ambiguous", "obligation_ambiguous"],
      ["lookup_unavailable", "evidence_unavailable"],
      ["conflicting_evidence", "evidence_conflicting"],
      ["terminal_failure", "obligation_failed"],
    ] as const

    for (const [outgoingState, reason] of cases) {
      let state = createCheckoutSparkReconciliation(plan)
      state = applyCheckoutSparkEvidence(state, {
        type: "funding",
        requestId: plan.funding.requestId,
        paymentRequest: plan.funding.paymentRequest,
        paymentHash: plan.funding.paymentHash,
        walletId: plan.walletId,
        network: plan.network,
        requiredNetSats: plan.funding.requiredNetSats,
        grossFundingSats: plan.funding.grossFundingSats,
        state: "spendable",
        observedAt: CREATED_AT + 1,
      })
      state = applyCheckoutSparkEvidence(state, {
        type: "obligation",
        obligationId: merchant.obligationId,
        outgoingId: merchant.outgoingId,
        paymentRequest: merchant.paymentRequest,
        amountSats: merchant.amountSats,
        maxFeeSats: merchant.maxFeeSats,
        state: outgoingState,
        observedAt: CREATED_AT + 2,
      })

      expect(
        getCheckoutSparkNextAction(state, {
          actor: "shopper",
          now: CREATED_AT + 3,
        })
      ).toEqual({ type: "wait", reason })
    }
  })

  it("halts on every non-spendable funding state", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    const cases = [
      ["pending", "funding_not_spendable"],
      ["funded_pending_claim", "funding_not_spendable"],
      ["unresolved_failure", "funding_not_spendable"],
      ["lookup_unavailable", "evidence_unavailable"],
      ["conflicting_evidence", "evidence_conflicting"],
    ] as const

    for (const [fundingState, reason] of cases) {
      let state = createCheckoutSparkReconciliation(plan)
      state = applyCheckoutSparkEvidence(state, {
        type: "funding",
        requestId: plan.funding.requestId,
        paymentRequest: plan.funding.paymentRequest,
        paymentHash: plan.funding.paymentHash,
        walletId: plan.walletId,
        network: plan.network,
        requiredNetSats: plan.funding.requiredNetSats,
        grossFundingSats: plan.funding.grossFundingSats,
        state: fundingState,
        observedAt: CREATED_AT + 1,
      })

      expect(
        getCheckoutSparkNextAction(state, {
          actor: "shopper",
          now: CREATED_AT + 2,
        })
      ).toEqual({ type: "wait", reason })
    }
  })

  it("binds retirement evidence to the exact checkout wallet and network", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    let state = createCheckoutSparkReconciliation(plan)
    for (const [index, obligation] of plan.obligations.entries()) {
      state = applyCheckoutSparkEvidence(state, {
        type: "obligation",
        obligationId: obligation.obligationId,
        outgoingId: obligation.outgoingId,
        paymentRequest: obligation.paymentRequest,
        amountSats: obligation.amountSats,
        maxFeeSats: obligation.maxFeeSats,
        state: "paid",
        observedAt: CREATED_AT + 20 + index,
      })
    }
    const evidence = {
      walletId: "different-wallet",
      network: plan.network,
      observedAt: CREATED_AT + 30,
      availableSats: 0,
      ownedSats: 0,
      incomingSats: 0,
      fundingReceiveTerminal: true,
      sendHistoryTerminal: true,
      claimsTerminal: true,
      refundsTerminal: true,
    } as const

    expect(() => assessCheckoutSparkRetirement(state, evidence)).toThrow(
      "retirement evidence is out of scope"
    )
  })

  it("retires only on fresh terminal zero-funds evidence and leaves a replay tombstone", () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    let state = createCheckoutSparkReconciliation(plan)
    state = applyCheckoutSparkEvidence(state, {
      type: "funding",
      requestId: plan.funding.requestId,
      paymentRequest: plan.funding.paymentRequest,
      paymentHash: plan.funding.paymentHash,
      walletId: plan.walletId,
      network: plan.network,
      requiredNetSats: plan.funding.requiredNetSats,
      grossFundingSats: plan.funding.grossFundingSats,
      state: "spendable",
      observedAt: CREATED_AT + 10,
    })
    for (const [index, obligation] of plan.obligations.entries()) {
      state = applyCheckoutSparkEvidence(state, {
        type: "obligation",
        obligationId: obligation.obligationId,
        outgoingId: obligation.outgoingId,
        paymentRequest: obligation.paymentRequest,
        amountSats: obligation.amountSats,
        maxFeeSats: obligation.maxFeeSats,
        state: "paid",
        observedAt: CREATED_AT + 20 + index,
      })
    }

    const pending = assessCheckoutSparkRetirement(state, {
      walletId: plan.walletId,
      network: plan.network,
      observedAt: CREATED_AT + 30,
      availableSats: 1,
      ownedSats: 1,
      incomingSats: 0,
      fundingReceiveTerminal: true,
      sendHistoryTerminal: true,
      claimsTerminal: true,
      refundsTerminal: true,
    })
    expect(pending).toEqual({
      state: "retirement_pending",
      reasons: ["funds_remaining"],
    })

    const retired = retireCheckoutSparkReconciliation(state, {
      walletId: plan.walletId,
      network: plan.network,
      observedAt: CREATED_AT + 31,
      availableSats: 0,
      ownedSats: 0,
      incomingSats: 0,
      fundingReceiveTerminal: true,
      sendHistoryTerminal: true,
      claimsTerminal: true,
      refundsTerminal: true,
    })
    expect(retired).toEqual({
      schemaVersion: 1,
      planDigest: plan.planDigest,
      retiredAt: CREATED_AT + 31,
    })
    expect(JSON.stringify(retired)).not.toContain(plan.merchantPubkey)
    expect(JSON.stringify(retired)).not.toContain(
      plan.obligations[0]!.paymentRequest
    )
    expect(() =>
      createCheckoutSparkReconciliation(plan, { tombstones: [retired] })
    ).toThrow("already retired")
  })

  it("uses one local non-waiting lock to prevent duplicate Merchant execution", async () => {
    const plan = freezeCheckoutSparkPlan(planInput())
    let ran = false
    const unavailable = {
      async request<T>(
        _name: string,
        _options: { mode: "exclusive"; ifAvailable: true },
        callback: (lock: { name: string } | null) => T | Promise<T>
      ): Promise<T> {
        return callback(null)
      },
    }

    await expect(
      runWithCheckoutSparkMerchantRecoveryLock(
        plan.planDigest,
        async () => {
          ran = true
        },
        unavailable
      )
    ).rejects.toThrow("already active in another tab")
    expect(ran).toBe(false)

    let lockName = ""
    const available = {
      async request<T>(
        name: string,
        options: { mode: "exclusive"; ifAvailable: true },
        callback: (lock: { name: string } | null) => T | Promise<T>
      ): Promise<T> {
        expect(options).toEqual({ mode: "exclusive", ifAvailable: true })
        lockName = name
        return callback({ name })
      },
    }
    await expect(
      runWithCheckoutSparkMerchantRecoveryLock(
        plan.planDigest,
        async () => "completed",
        available
      )
    ).resolves.toBe("completed")
    expect(lockName).toContain(plan.planDigest)
    expect(lockName).not.toContain(plan.merchantPubkey)
  })
})

import { describe, expect, it } from "bun:test"
import {
  createCheckoutSparkMerchantProgress,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkMerchantOrderWitness,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRepositorySnapshot,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import {
  selectMerchantCheckoutSparkSignedNextPayout,
  type MerchantCheckoutSparkSignedNextPayoutDependencies,
} from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const CREATED_AT = 1_800_000_000_000
const TAKEOVER_AT = CREATED_AT + 120_000
const MERCHANT = "a".repeat(64)
const BUYER = "b".repeat(64)
const SECRET = "synthetic test-only automatic selection material"

function invoice(amountSats: number, hashByte: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function prepare(state: CheckoutSparkSettledReconciliation, index: number) {
  const leg = state.legs[index]!
  return prepareCheckoutSparkSettledLeg(state, {
    legId: leg.legId,
    transferId: deriveCheckoutSparkSettledTransferId(state.plan, leg.legId),
    paymentRequest: invoice(leg.allocationSats! - 1, index + 4),
    paymentHash: (index + 4).toString(16).padStart(2, "0").repeat(32),
    invoiceAmountSats: leg.allocationSats! - 1,
    maxFeeSats: 1,
    preparedAt: Math.max(TAKEOVER_AT, state.updatedAt + 1),
  })
}

function paid(state: CheckoutSparkSettledReconciliation, index: number) {
  const leg = state.legs[index]!
  return recordCheckoutSparkSettledLegStatus(state, {
    legId: leg.legId,
    transferId: leg.intent!.transferId,
    paymentHash: leg.intent!.paymentHash,
    status: "paid",
    finalFeeSats: 1,
    finalDebitSats: leg.allocationSats!,
    observedAt: state.updatedAt + 1,
  })
}

function fixture() {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "automatic-selection-checkout",
    orderId: "automatic-selection-order",
    merchantPubkey: MERCHANT,
    walletId: "automatic-selection-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: TAKEOVER_AT,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:selection-fixture`,
          productEventId: "e".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "automatic-selection-receive",
      paymentRequest: invoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"d".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        weightSats: 1_000,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "f".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
          },
        },
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        weightSats: 111,
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
      },
    ],
  })
  const credited = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "automatic-selection-funding",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: CREATED_AT + 1_000,
    }
  )
  const initial = createCheckoutSparkSettledRecoveryPayload({
    state: credited,
    senderPubkey: BUYER,
    mnemonic: SECRET,
    accountNumber: 0,
    preparedAt: CREATED_AT + 2_000,
  })
  let signed = prepare(credited, 0)
  let progress = createCheckoutSparkMerchantProgress({
    initialHandoffId: initial.handoffId,
    state: signed,
  })
  let snapshot: CheckoutSparkSettledRepositorySnapshot = {
    status: "active",
    revision: 1,
    state: signed,
  }
  let witness: CheckoutSparkMerchantOrderWitness | null = {
    schemaVersion: 1,
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    orderId: plan.orderId,
    rumorId: "1".repeat(64),
    contentHash: "2".repeat(64),
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
  }
  const selected: MerchantCheckoutSparkRecoveryCandidate = {
    wrapId: "9".repeat(64),
    schemaVersion: 2,
    checkoutId: plan.checkoutId,
    orderId: plan.orderId,
    planDigest: plan.planDigest,
    takeoverAt: TAKEOVER_AT,
    preparedAt: initial.preparedAt,
    merchantProgress: {
      wrapId: "8".repeat(64),
      snapshotId: progress.snapshotId,
      recordedAt: progress.recordedAt,
    },
  }
  let active = true
  let privateActive = true
  let recoveryCalls = 0
  const assertActive = () => {
    if (!active) throw new Error("Fixture account changed")
  }
  const assertPrivate = () => {
    if (!privateActive) throw new Error("Fixture signer changed")
  }
  const dependencies: MerchantCheckoutSparkSignedNextPayoutDependencies = {
    now: () => TAKEOVER_AT + 10_000,
    repository: {
      async load() {
        return snapshot
      },
      async loadMerchantOrderWitness() {
        return witness
      },
    },
    async consumeRecovery(principal, candidate, adapter) {
      recoveryCalls += 1
      expect(principal).toBe(MERCHANT)
      if (candidate.merchantProgress) {
        await adapter.consumeMerchantProgress!(
          initial,
          initial,
          progress,
          assertPrivate
        )
      } else {
        await adapter.consume(initial, assertPrivate)
      }
      return {
        status: "consumed",
        coverage: "complete",
        discoveryCoverage: "complete",
        declarationState: "declared",
        candidate,
      }
    },
  }
  return {
    plan,
    credited,
    initial,
    selected,
    dependencies,
    assertActive,
    run: () =>
      selectMerchantCheckoutSparkSignedNextPayout(
        MERCHANT,
        selected,
        assertActive,
        dependencies
      ),
    signed: () => signed,
    setState(state: CheckoutSparkSettledReconciliation) {
      snapshot = { status: "active", revision: 1, state }
    },
    setSigned(state: CheckoutSparkSettledReconciliation) {
      signed = state
      progress = createCheckoutSparkMerchantProgress({
        initialHandoffId: initial.handoffId,
        state,
      })
      selected.merchantProgress = {
        wrapId: "8".repeat(64),
        snapshotId: progress.snapshotId,
        recordedAt: progress.recordedAt,
      }
    },
    setSnapshot(value: CheckoutSparkSettledRepositorySnapshot) {
      snapshot = value
    },
    setWitness(value: CheckoutSparkMerchantOrderWitness | null) {
      witness = value
    },
    witness: () => witness!,
    deactivate() {
      active = false
    },
    revokePrivate() {
      privateActive = false
    },
    recoveryCalls: () => recoveryCalls,
  }
}

describe("Merchant automatic exact-signed-next-intent selection", () => {
  it("returns only the exact signed next review, never private wallet material", async () => {
    const test = fixture()
    const result = await test.run()
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("Expected exact review")
    expect(Object.keys(result).sort()).toEqual(["review", "status"])
    expect(result.review.intent).toEqual(test.signed().legs[0]!.intent)
    expect(result.review.intent).not.toBe(test.signed().legs[0]!.intent)
    expect(result.review.legId).toBe(test.signed().legs[0]!.legId)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result).not.toHaveProperty("wallet")
    expect(test.recoveryCalls()).toBe(1)
  })

  it("requires Merchant progress rather than a buyer-only recovery", async () => {
    const test = fixture()
    delete test.selected.merchantProgress
    expect(await test.run()).toEqual({ status: "preparation_needed" })
  })

  it("does not authorize a buyer callback just because a pointer was selected", async () => {
    const test = fixture()
    test.dependencies.consumeRecovery = async (
      _principal,
      candidate,
      adapter
    ) => {
      await adapter.consume(test.initial, () => {})
      return {
        status: "consumed",
        coverage: "complete",
        discoveryCoverage: "complete",
        declarationState: "declared",
        candidate,
      }
    }
    expect(await test.run()).toEqual({ status: "preparation_needed" })
  })

  it("requires preparation for an unsigned local next intent or a missing intent", async () => {
    const test = fixture()
    const merchantPaid = paid(test.signed(), 0)
    test.setSigned(merchantPaid)
    test.setState(merchantPaid)
    expect(await test.run()).toEqual({ status: "preparation_needed" })
    const feePrepared = prepare(merchantPaid, 1)
    test.setState(feePrepared)
    expect(await test.run()).toEqual({ status: "preparation_needed" })
    test.setSigned(feePrepared)
    const result = await test.run()
    expect(result.status === "ready" && result.review.legId).toBe(
      test.plan.recipients[1]!.legId
    )
  })

  it("does not mistake saved all-paid state for settlement or retirement", async () => {
    const test = fixture()
    const allPaid = paid(prepare(paid(test.signed(), 0), 1), 1)
    test.setSigned(allPaid)
    test.setState(allPaid)
    expect(await test.run()).toEqual({ status: "no_unpaid_leg" })
  })

  it("fails closed for a selected plan, order, merchant, or takeover mismatch", async () => {
    for (const field of [
      "checkoutId",
      "orderId",
      "planDigest",
      "takeoverAt",
    ] as const) {
      const test = fixture()
      if (field === "takeoverAt") test.selected.takeoverAt += 1
      else test.selected[field] = "changed"
      await expect(test.run()).rejects.toThrow()
      expect(test.recoveryCalls()).toBe(0)
    }
    const test = fixture()
    await expect(
      selectMerchantCheckoutSparkSignedNextPayout(
        BUYER,
        test.selected,
        test.assertActive,
        test.dependencies
      )
    ).rejects.toThrow()
  })

  it("requires the exact authenticated order witness and buyer", async () => {
    for (const changed of ["missing", "buyer", "order", "merchant"] as const) {
      const test = fixture()
      const witness = { ...test.witness() }
      if (changed === "missing") test.setWitness(null)
      else {
        if (changed === "buyer") witness.buyerPubkey = "c".repeat(64)
        if (changed === "order") witness.orderId = "other-order"
        if (changed === "merchant") witness.merchantPubkey = "c".repeat(64)
        test.setWitness(witness)
      }
      await expect(test.run()).rejects.toThrow()
    }
  })

  it("does not open private recovery before takeover or without active saved state", async () => {
    const test = fixture()
    test.dependencies.now = () => TAKEOVER_AT - 1
    expect(await test.run()).toEqual({ status: "handoff_wait" })
    test.dependencies.now = () => TAKEOVER_AT
    test.setSnapshot({ status: "missing" })
    expect(await test.run()).toEqual({ status: "save_required" })
    test.setSnapshot({
      status: "retired",
      planDigest: test.plan.planDigest,
      retiredAt: TAKEOVER_AT,
    })
    expect(await test.run()).toEqual({ status: "retired" })
    expect(test.recoveryCalls()).toBe(0)
  })

  it("rechecks account and private authority after every relevant awaited boundary", async () => {
    for (const boundary of [
      "first_load",
      "witness",
      "second_load",
      "recovery",
      "private",
    ] as const) {
      const test = fixture()
      const repository = test.dependencies.repository!
      const load = repository.load
      const witness = repository.loadMerchantOrderWitness
      const consume = test.dependencies.consumeRecovery!
      let loads = 0
      repository.load = async (...args) => {
        const result = await load(...args)
        loads += 1
        if (
          (boundary === "first_load" && loads === 1) ||
          (boundary === "second_load" && loads === 2)
        )
          test.deactivate()
        return result
      }
      repository.loadMerchantOrderWitness = async (...args) => {
        const result = await witness(...args)
        if (boundary === "witness") test.deactivate()
        if (boundary === "private") test.revokePrivate()
        return result
      }
      test.dependencies.consumeRecovery = async (...args) => {
        const result = await consume(...args)
        if (boundary === "recovery") test.deactivate()
        return result
      }
      await expect(test.run()).rejects.toThrow()
    }
  })

  it("pins the selected candidate including its nested progress pointer across awaits", async () => {
    const test = fixture()
    const load = test.dependencies.repository!.load
    let loads = 0
    test.dependencies.repository!.load = async (...args) => {
      const result = await load(...args)
      if (++loads === 1) {
        test.selected.orderId = "changed-after-start"
        test.selected.merchantProgress!.snapshotId = "0".repeat(64)
      }
      return result
    }
    expect((await test.run()).status).toBe("ready")
  })

  it("does not return a review after incomplete recovery, even if a callback ran", async () => {
    const test = fixture()
    const consume = test.dependencies.consumeRecovery!
    test.dependencies.consumeRecovery = async (...args) => ({
      ...(await consume(...args)),
      status: "incomplete",
      candidate: null,
    })
    expect(await test.run()).toEqual({ status: "recovery_unavailable" })
  })

  it("rejects a changed progress pointer and local regression", async () => {
    const test = fixture()
    test.selected.merchantProgress!.snapshotId = "0".repeat(64)
    await expect(test.run()).rejects.toThrow()
    test.setSigned(test.signed())
    test.setState(test.credited)
    await expect(test.run()).rejects.toThrow()
  })
})

import { expect, it } from "bun:test"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { DexieCheckoutSparkSettledRepository } from "../packages/core/src/protocol/checkout-spark-settled-router-repository"
import {
  activateCheckoutSparkBuyer,
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledEventPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
  restoreCheckoutSparkSettledPlan,
  projectCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledCredit,
  prepareCheckoutSparkSettledLeg,
  deriveCheckoutSparkSettledTransferId,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { getCheckoutSparkBuyerTakeoverAt } from "../packages/core/src/protocol/checkout-spark-buyer-activation"
import {
  assertCheckoutSparkSettledBuyerPreparationWindow,
  assertCheckoutSparkSettledMerchantPreparationWindow,
} from "../packages/core/src/protocol/checkout-spark-settled-leg-preparation"
import {
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
} from "../packages/core/src/protocol/checkout-spark-recovery"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { checkoutSparkEventMarketFixture } from "./support/checkout-spark-event-market-fixture"
import { createCheckoutSparkMerchantSettlementRecord } from "../packages/core/src/protocol/checkout-spark-merchant-settlement"
import { validateCheckoutSparkPlanSources } from "../packages/core/src/protocol/checkout-spark-plan-sources"
import { nativeTreasuryFixture } from "./support/checkout-spark-native-treasury-fixture"
import { createCheckoutSparkMerchantProgress } from "../packages/core/src/protocol/checkout-spark-merchant-progress"
import { selectCheckoutSparkMerchantProgress } from "../packages/core/src/protocol/checkout-spark-merchant-progress-selection"

it("preserves historical v3/v4/v5 canonical plan bytes and keeps exact credit facts separate from activation", () => {
  const native = nativeTreasuryFixture()
  for (const plan of [
    native.legacy,
    native.plan,
    checkoutSparkEventMarketFixture().plan,
  ]) {
    expect(
      JSON.stringify(restoreCheckoutSparkSettledPlan(plan)) ===
        JSON.stringify(plan)
    ).toBe(true)
  }
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...native.plan,
    takeoverAt: undefined,
    executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
  })
  const inactive = createCheckoutSparkSettledReconciliation(plan)
  const facts = projectCheckoutSparkSettledCredit(plan, native.state.credit!)
  expect(facts.credit.creditedSats).toBe(native.state.credit!.creditedSats)
  expect(facts.allocations[0]!.allocationSats).toBe(
    native.state.legs[0]!.allocationSats!
  )
  expect(inactive.buyerActivation).toBeNull()
  expect(inactive.credit).toBeNull()
  expect(() => {
    recordCheckoutSparkSettledCredit(inactive, native.state.credit!)
  }).toThrow("activation")
})

it("never accepts an activation introduced by Merchant progress instead of authenticated Buyer progress", () => {
  const fixture = nativeTreasuryFixture()
  const prepared = { ...fixture.plan, takeoverAt: undefined }
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...prepared,
    executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
  })
  const buyerPubkey = "f".repeat(64)
  const initialState = createCheckoutSparkSettledReconciliation(plan)
  const initial = createCheckoutSparkSettledRecoveryPayload({
    state: initialState,
    senderPubkey: buyerPubkey,
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 0,
    preparedAt: plan.createdAt + 1,
  })
  const activatedAt = plan.createdAt + 300_000
  const active = activateCheckoutSparkBuyer(initialState, {
    buyerPubkey,
    activatedAt,
  })
  const credited = recordCheckoutSparkSettledCredit(active, {
    ...fixture.state.credit!,
    observedAt: activatedAt + 1,
  })
  const intent = fixture.state.legs[0]!.intent!
  const progressed = prepareCheckoutSparkSettledLeg(credited, {
    ...intent,
    legId: credited.legs[0]!.legId,
    transferId: deriveCheckoutSparkSettledTransferId(
      plan,
      credited.legs[0]!.legId
    ),
    preparedAt: activatedAt + 120_000,
  })
  const payload = createCheckoutSparkMerchantProgress({
    initialHandoffId: initial.handoffId,
    state: progressed,
  })
  expect(payload.schemaVersion).toBe(5)
  expect(
    selectCheckoutSparkMerchantProgress({
      initial,
      latestBuyerState: initialState,
      entries: [{ wrapId: "1".repeat(64), payload }],
    }).status
  ).toBe("conflict")
  expect(
    selectCheckoutSparkMerchantProgress({
      initial,
      latestBuyerState: active,
      entries: [{ wrapId: "1".repeat(64), payload }],
    }).status
  ).toBe("selected")
})

it("keeps a new prepared checkout inactive until Pay without rewriting historical plan deadlines", () => {
  const fixture = nativeTreasuryFixture()
  const oldPlan = fixture.plan
  const oldBytes = JSON.stringify(oldPlan)
  const prepared = { ...oldPlan, takeoverAt: undefined }
  const newPlan = freezeCheckoutSparkSettledTreasuryPlan({
    ...prepared,
    executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
  })

  expect(newPlan.schemaVersion).toBe(6)
  expect(Object.hasOwn(newPlan, "takeoverAt")).toBe(false)
  expect(newPlan.schemaVersion === 6 ? newPlan.executionTiming : null).toEqual({
    type: "pay_activation_v1",
    windowMs: 120_000,
  })
  expect(newPlan.checkoutId === oldPlan.checkoutId).toBe(true)
  expect(newPlan.orderId === oldPlan.orderId).toBe(true)
  expect(newPlan.walletId === oldPlan.walletId).toBe(true)
  expect(
    JSON.stringify(newPlan.funding) === JSON.stringify(oldPlan.funding)
  ).toBe(true)
  expect(newPlan.planDigest !== oldPlan.planDigest).toBe(true)
  const initial = createCheckoutSparkSettledReconciliation(newPlan)
  expect(initial.schemaVersion).toBe(7)
  expect(initial.buyerActivation).toBeNull()
  expect(
    JSON.stringify(restoreCheckoutSparkSettledPlan(oldPlan)) === oldBytes
  ).toBe(true)
})

it("retains exact Event sources and distinct organizer settlement obligations under the new timing version", () => {
  const fixture = checkoutSparkEventMarketFixture()
  const prepared = { ...fixture.input, takeoverAt: undefined }
  const plan = freezeCheckoutSparkSettledEventPlan({
    ...prepared,
    executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
  })
  expect(plan.schemaVersion).toBe(6)
  expect(plan.checkoutKind).toBe("event_market")
  expect(
    validateCheckoutSparkPlanSources(plan, fixture.sourceEvents).planDigest ===
      plan.planDigest
  ).toBe(true)
  const record = createCheckoutSparkMerchantSettlementRecord(plan)
  expect(record.schemaVersion).toBe(3)
  expect(
    record.organizerLegId ===
      fixture.plan.recipients.find((leg) => leg.kind === "organizer")?.legId
  ).toBe(true)
  expect(record.requiredCommerceLegIds.includes(record.organizerLegId!)).toBe(
    false
  )
  expect(() => {
    restoreCheckoutSparkSettledPlan({ ...plan, eventMarket: undefined })
  }).toThrow()
  expect(() => {
    restoreCheckoutSparkSettledPlan({
      ...plan,
      checkoutKind: "ordinary",
    } as typeof plan)
  }).toThrow()
})

it("carries activation only in the original Buyer's later recovery progress, not a replacement initial handoff", () => {
  const old = nativeTreasuryFixture().plan
  const prepared = { ...old, takeoverAt: undefined }
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...prepared,
    executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
  })
  const initial = createCheckoutSparkSettledReconciliation(plan)
  const senderPubkey = "f".repeat(64)
  const wallet = { mnemonic: createRuntimeMnemonic(), accountNumber: 0 }
  const initialPayload = createCheckoutSparkSettledRecoveryPayload({
    state: initial,
    senderPubkey,
    ...wallet,
    preparedAt: plan.createdAt + 1,
  })
  const activatedAt = plan.createdAt + 300_000
  const active = activateCheckoutSparkBuyer(initial, {
    buyerPubkey: senderPubkey,
    activatedAt,
  })
  const progressInput = {
    state: active,
    senderPubkey,
    initialHandoffId: initialPayload.handoffId,
    preparedAt: activatedAt,
  }
  const progress =
    createCheckoutSparkSettledRecoveryProgressPayload(progressInput)
  expect(
    progress.state.buyerActivation?.activationId ===
      active.buyerActivation?.activationId
  ).toBe(true)
  expect(progress.initialHandoffId === initialPayload.handoffId).toBe(true)
  expect(() => {
    createCheckoutSparkSettledRecoveryPayload({
      state: active,
      senderPubkey,
      ...wallet,
      preparedAt: activatedAt,
    })
  }).toThrow()
  expect(() => {
    createCheckoutSparkSettledRecoveryProgressPayload({
      ...progressInput,
      senderPubkey: "e".repeat(64),
    })
  }).toThrow()
})

it("admits neither actor before Pay, then switches dispatch at the exact immutable cutoff", () => {
  const old = nativeTreasuryFixture().plan
  const prepared = { ...old, takeoverAt: undefined }
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...prepared,
    executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
  })
  const initial = createCheckoutSparkSettledReconciliation(plan)
  const activatedAt = plan.createdAt + 300_000
  expect(() =>
    assertCheckoutSparkSettledBuyerPreparationWindow(initial, activatedAt)
  ).toThrow()
  expect(() =>
    assertCheckoutSparkSettledMerchantPreparationWindow(initial, activatedAt)
  ).toThrow()
  const state = activateCheckoutSparkBuyer(initial, {
    buyerPubkey: "f".repeat(64),
    activatedAt,
  })
  expect(() =>
    assertCheckoutSparkSettledBuyerPreparationWindow(state, activatedAt - 1)
  ).toThrow()
  expect(() =>
    assertCheckoutSparkSettledBuyerPreparationWindow(
      state,
      activatedAt + 119_999
    )
  ).not.toThrow()
  expect(() =>
    assertCheckoutSparkSettledMerchantPreparationWindow(
      state,
      activatedAt + 119_999
    )
  ).toThrow()
  expect(() =>
    assertCheckoutSparkSettledBuyerPreparationWindow(
      state,
      activatedAt + 120_000
    )
  ).toThrow()
  expect(() =>
    assertCheckoutSparkSettledMerchantPreparationWindow(
      state,
      activatedAt + 120_000
    )
  ).not.toThrow()
})

it("persists the first Pay marker atomically and rejects a competing or renewed activation", async () => {
  const old = nativeTreasuryFixture().plan
  const prepared = { ...old, takeoverAt: undefined }
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...prepared,
    executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
  })
  const database = new ConduitDB(`pay-activation-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const repository = new DexieCheckoutSparkSettledRepository(database)
  try {
    const initial = await repository.create(plan)
    if (initial.status !== "active")
      throw new Error("Expected active preparation")
    const buyerPubkey = "f".repeat(64)
    const first = activateCheckoutSparkBuyer(initial.state, {
      buyerPubkey,
      activatedAt: plan.createdAt + 300_000,
    })
    const competing = activateCheckoutSparkBuyer(initial.state, {
      buyerPubkey,
      activatedAt: plan.createdAt + 330_000,
    })
    const saved = await repository.save(first, initial.revision)
    if (saved.status !== "active") throw new Error("Expected saved activation")
    expect(
      saved.state.buyerActivation?.activationId ===
        first.buyerActivation?.activationId
    ).toBe(true)
    await expect(repository.save(competing, initial.revision)).rejects.toThrow(
      "changed"
    )
    await expect(repository.save(competing, saved.revision)).rejects.toThrow(
      "changed"
    )
    const restored = await repository.load(plan.checkoutId, plan.planDigest)
    expect(
      restored.status === "active" &&
        restored.state.buyerActivation?.activationId ===
          first.buyerActivation?.activationId
    ).toBe(true)
  } finally {
    await database.delete()
  }
})

it("starts one immutable two-minute window on Pay, without replacing the prepared plan or funding", () => {
  const old = nativeTreasuryFixture().plan
  const prepared = { ...old, takeoverAt: undefined }
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...prepared,
    executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
  })
  const initial = createCheckoutSparkSettledReconciliation(plan)
  const planBytes = JSON.stringify(plan)
  const activatedAt = plan.createdAt + 5 * 60_000
  const buyerPubkey = "f".repeat(64)
  expect(
    getCheckoutSparkBuyerTakeoverAt(plan, initial.buyerActivation)
  ).toBeNull()
  const active = activateCheckoutSparkBuyer(initial, {
    buyerPubkey,
    activatedAt,
  })
  expect(getCheckoutSparkBuyerTakeoverAt(plan, active.buyerActivation)).toBe(
    activatedAt + 120_000
  )
  expect(JSON.stringify(active.plan) === planBytes).toBe(true)
  expect(active.credit).toBeNull()
  const retried = activateCheckoutSparkBuyer(active, {
    buyerPubkey,
    activatedAt: activatedAt + 60_000,
  })
  expect(JSON.stringify(retried) === JSON.stringify(active)).toBe(true)
  expect(() =>
    activateCheckoutSparkBuyer(active, {
      buyerPubkey: "e".repeat(64),
      activatedAt,
    })
  ).toThrow("Buyer")
})

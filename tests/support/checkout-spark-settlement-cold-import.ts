import assert from "node:assert/strict"

// Install before the first settlement import. No provider or network initializer
// may be needed to construct or restore these local records.
globalThis.fetch = (() => {
  throw new Error("Unexpected network access during cold settlement import")
}) as typeof fetch
globalThis.WebSocket = class {
  constructor() {
    throw new Error("Unexpected socket during cold settlement import")
  }
} as unknown as typeof WebSocket

const entrypoints = [
  "settled-router",
  "settled-outgoing",
  "settled-outgoing-history",
  "settled-returned",
  "treasury-finalization",
  "merchant-settlement",
  "invoice-origin",
  "invoice-recipient",
  "settled-plan",
  "settled-validation",
  "treasury-model",
  "merchant-settlement-model",
] as const
const first = process.argv[2]!
assert(entrypoints.some((name) => name === first))
const load = (name: string) =>
  import(`../../packages/core/src/protocol/checkout-spark-${name}.ts`)
await load(first)

const router = await load("settled-router")
const plan = await load("settled-plan")
const treasury = await load("treasury-finalization")
const treasuryModel = await load("treasury-model")
const merchant = await load("merchant-settlement")
const merchantModel = await load("merchant-settlement-model")
const outgoing = await load("settled-outgoing")
const history = await load("settled-outgoing-history")
const returned = await load("settled-returned")
for (const [facade, owner, names] of [
  [
    router,
    plan,
    [
      "freezeCheckoutSparkSettledPlan",
      "freezeCheckoutSparkSettledTreasuryPlan",
      "freezeCheckoutSparkSettledEventPlan",
      "restoreCheckoutSparkSettledPlan",
      "deriveCheckoutSparkSettledTransferId",
      "deriveCheckoutSparkSettledRenewalTransferId",
    ],
  ],
  [router, treasuryModel, ["isCheckoutSparkNativeTreasuryPlan"]],
  [
    treasury,
    treasuryModel,
    [
      "deriveCheckoutSparkNativeTreasuryInvoiceId",
      "restoreCheckoutSparkNativeTreasuryPlan",
      "createCheckoutSparkNativeTreasuryFinalization",
      "restoreCheckoutSparkNativeTreasuryFinalization",
    ],
  ],
  [
    merchant,
    merchantModel,
    [
      "restoreCheckoutSparkNativeTreasurySettlement",
      "createCheckoutSparkMerchantSettlementRecord",
      "restoreCheckoutSparkMerchantSettlementRecord",
      "projectCheckoutSparkMerchantSettlement",
    ],
  ],
  [outgoing, history, ["classifyCheckoutSparkSettledPayment"]],
] as const) {
  for (const name of names)
    assert.equal(facade[name], owner[name], `${first}: ${name} binding`)
}
for (const facade of [router, treasury, merchant, outgoing]) {
  for (const name of [
    "digest",
    "invalid",
    "id",
    "budgetFromExactState",
    "validTime",
    "normalizeInvoice",
    "paymentObservation",
  ])
    assert.equal(facade[name], undefined)
}

const { settlementModelPlan, paidSettlementModel } =
  await import("./checkout-spark-settlement-model-fixture")
for (const version of [3, 4, 5] as const) {
  const frozen = settlementModelPlan(version)
  const restored = router.restoreCheckoutSparkSettledPlan(
    structuredClone(frozen)
  )
  assert.deepEqual(restored, frozen)
  assert(Object.isFrozen(restored.funding))
  assert.throws(() =>
    plan.deriveCheckoutSparkSettledTransferId(
      { ...frozen, orderId: "tampered" },
      frozen.recipients[0]!.legId
    )
  )
}
const { state, record } = paidSettlementModel()
const budget = treasury.deriveCheckoutSparkNativeTreasuryBudget(state, record)
assert.equal(budget.authorizedDebitSats, 112)
const prepared = treasury.prepareCheckoutSparkNativeTreasury(state, {
  settlement: record,
  preparedAt: state.updatedAt + 1,
})
assert.deepEqual(
  router.restoreCheckoutSparkSettledReconciliation(prepared),
  prepared
)
assert.deepEqual(
  merchant.restoreCheckoutSparkMerchantSettlementRecord(record, state.plan),
  record
)
assert.equal(
  merchant.projectCheckoutSparkMerchantSettlement(record).commerceVerified,
  true
)

const { preparedSettledLegState, outgoingTargetFor } =
  await import("./checkout-spark-settled-leg-fixture")
const unpaid = preparedSettledLegState()
const target = outgoingTargetFor(unpaid)
const observedAt = unpaid.updatedAt + 1
const proof = returned.proveCheckoutSparkSettledReturnedTransfer({
  plan: unpaid.plan,
  target,
  evidence: {
    network: target.network,
    walletIdentityPublicKey: unpaid.plan.funding.receiverIdentityPublicKey,
    transferId: target.intent.transferId,
    requestId: "cold-return",
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    debitedSats: 1_000,
    returnedSats: 1_000,
    availableSats: 1_000,
    sspStatus: "USER_SWAP_RETURNED",
    operatorStatus: "RETURNED",
    htlcStatus: "RETURNED",
    preimage: null,
    returnedLeaves: [{ id: "returned", valueSats: 1_000 }],
    availableLeaves: [{ id: "returned", valueSats: 1_000 }],
    observedAt,
  },
})
assert.equal(
  returned.assertCheckoutSparkSettledReturnedProof(proof, {
    plan: unpaid.plan,
    target,
    nowMs: observedAt,
  }).netDebitSats,
  0
)
assert.throws(() =>
  returned.assertCheckoutSparkSettledReturnedProof(structuredClone(proof), {
    plan: unpaid.plan,
    target,
    nowMs: observedAt,
  })
)
assert.equal(
  (
    await history.classifyCheckoutSparkSettledExactOutgoingHistory(target, {
      status: "not_found",
    })
  ).status,
  "not_found"
)
assert.equal(
  (
    await outgoing.classifyCheckoutSparkSettledPayment(
      { status: "pending", fees: 1n, details: { type: "lightning" } },
      target
    )
  ).status,
  "pending"
)
console.log(`cold settlement: ${first}`)

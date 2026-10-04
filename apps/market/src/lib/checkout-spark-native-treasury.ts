import {
  assertCheckoutSparkSettledClosedReturnedProof,
  classifyCheckoutSparkSettledExactOutgoingHistory,
  deriveCheckoutSparkNativeTreasuryBudget,
  proveCheckoutSparkNativeTreasuryHistory,
  proveCheckoutSparkSettledClosedReturnedTransfer,
  requireCheckoutSparkSettledExactOutgoingRequest,
  type CheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkNativeTreasuryProvider,
  type CheckoutSparkNativeTreasuryTarget,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledClosedReturnedProof,
  type DexieCheckoutSparkSettledRepository,
} from "@conduit/core"
import type { SparkWalletManager } from "./spark-wallet"

export type CheckoutSparkTreasuryRepository = Pick<
  DexieCheckoutSparkSettledRepository,
  | "load"
  | "recordMerchantCredit"
  | "recordMerchantPayout"
  | "assertLocalInvoiceOrigin"
  | "loadMerchantSettlement"
  | "recordMerchantTreasury"
>

export type CheckoutSparkTreasuryManager = Pick<
  SparkWalletManager,
  | "attestCheckoutReceiveCredit"
  | "reconcileInvoiceAttempt"
  | "inspectCheckoutLightningClosedReturnedAttempt"
  | "openCheckoutRetirementReader"
  | "inspectCheckoutTreasury"
  | "preflightCheckoutTreasury"
  | "sendCheckoutTreasury"
>

export type CheckoutSparkTreasuryInspectionManager = Pick<
  CheckoutSparkTreasuryManager,
  | "attestCheckoutReceiveCredit"
  | "reconcileInvoiceAttempt"
  | "inspectCheckoutLightningClosedReturnedAttempt"
  | "openCheckoutRetirementReader"
>

export interface CheckoutSparkTreasuryCommerceInspection {
  settlement: CheckoutSparkMerchantSettlementRecord
  expectedTransferIds: string[]
  closedReturnedProofs: CheckoutSparkSettledClosedReturnedProof[]
}

/** Fresh authenticated facts only: signed recovery progress is never authority. */
export async function inspectBuyerCheckoutSparkTreasuryCommerce(input: {
  state: CheckoutSparkSettledReconciliation
  manager: CheckoutSparkTreasuryInspectionManager
  repository: CheckoutSparkTreasuryRepository
  now: () => number
  assertAuthority: () => Promise<void>
  assertCurrent: () => void
}): Promise<CheckoutSparkTreasuryCommerceInspection> {
  const { state, manager, repository, now, assertAuthority, assertCurrent } =
    input
  const { plan } = state
  if ((plan.schemaVersion !== 3 && plan.schemaVersion !== 4) || !state.credit) {
    throw new Error("Checkout Spark final payment is not funded.")
  }
  await assertAuthority()
  const proof = await manager.attestCheckoutReceiveCredit(plan.walletId, {
    walletId: plan.walletId,
    network: plan.network,
    id: plan.funding.requestId,
    paymentRequest: plan.funding.paymentRequest,
    paymentHash: plan.funding.paymentHash,
    providerStatus: "PERSISTED",
    requiredNetSats: plan.funding.grossFundingSats,
    grossFundingSats: plan.funding.grossFundingSats,
    expirySecs: (plan.funding.expiresAt - plan.funding.createdAt) / 1000,
    createdAt: plan.funding.createdAt,
    expiresAt: plan.funding.expiresAt,
    receiveSettledPolicy: "ordinary-exact-credit-v3",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
  })
  await assertAuthority()
  if (
    !proof ||
    proof.transferId !== state.credit.transferId ||
    proof.creditedSats !== state.credit.creditedSats
  ) {
    throw new Error("Checkout Spark exact funding proof is unavailable.")
  }
  await repository.recordMerchantCredit(plan, proof, now(), assertCurrent)
  const expectedTransferIds = [proof.transferId]
  const closedReturnedProofs: CheckoutSparkSettledClosedReturnedProof[] = []
  for (const recipient of plan.recipients) {
    if (plan.nativeTreasury && recipient.kind === "conduit") continue
    const leg = state.legs.find(
      (candidate) => candidate.legId === recipient.legId
    )
    if (
      !leg ||
      leg.status !== "paid" ||
      !leg.intent ||
      leg.allocationSats === null
    ) {
      throw new Error("Checkout Spark commerce payment is not settled.")
    }
    const target: CheckoutSparkSettledOutgoingTarget = {
      walletId: plan.walletId,
      network: plan.network,
      legId: leg.legId,
      recipientId: recipient.recipientId,
      allocationSats: leg.allocationSats,
      unpaidAllocationSats: leg.allocationSats,
      intent: leg.intent,
      ...(leg.generation === 1
        ? { generation: 1, closedGenerations: leg.closedGenerations }
        : {}),
    }
    // Historical returns cannot be inferred from expiry, balance, or a message.
    for (const closed of leg.closedGenerations ?? []) {
      const closedTarget = {
        ...target,
        intent: closed.intent,
        generation: 0 as const,
      }
      const request = requireCheckoutSparkSettledExactOutgoingRequest(
        plan,
        closedTarget
      )
      await assertAuthority()
      const returned =
        await manager.inspectCheckoutLightningClosedReturnedAttempt(
          plan.walletId,
          {
            ...request,
            paymentHash: closed.intent.paymentHash,
            receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
          },
          assertCurrent
        )
      await assertAuthority()
      if (returned.status !== "closed_returned") {
        throw new Error("Checkout Spark old payment closure is unavailable.")
      }
      const closedProof = proveCheckoutSparkSettledClosedReturnedTransfer({
        plan,
        target: closedTarget,
        evidence: returned.evidence,
      })
      const fresh = assertCheckoutSparkSettledClosedReturnedProof(closedProof, {
        walletId: plan.walletId,
        network: plan.network,
        nowMs: now(),
      })
      if (
        Object.entries(closed.closure).some(
          ([key, value]) =>
            key !== "observedAt" && fresh[key as keyof typeof fresh] !== value
        )
      )
        throw new Error("Checkout Spark old payment closure changed.")
      closedReturnedProofs.push(closedProof)
    }
    await repository.assertLocalInvoiceOrigin(plan, target, assertCurrent)
    await assertAuthority()
    const request = requireCheckoutSparkSettledExactOutgoingRequest(
      plan,
      target
    )
    const history = await manager.reconcileInvoiceAttempt(plan.walletId, {
      schemaVersion: 1,
      walletId: plan.walletId,
      ...request,
      createdAt: leg.intent.preparedAt,
    })
    await assertAuthority()
    const observation = await classifyCheckoutSparkSettledExactOutgoingHistory(
      target,
      history
    )
    if (
      observation.status !== "paid" ||
      observation.finalDebitSats !== leg.finalDebitSats ||
      observation.finalFeeSats !== leg.finalFeeSats
    ) {
      throw new Error("Checkout Spark exact commerce history is unavailable.")
    }
    await repository.recordMerchantPayout(
      plan,
      target,
      observation,
      now(),
      assertCurrent
    )
    expectedTransferIds.push(leg.intent.transferId)
    await assertAuthority()
  }
  const record = await repository.loadMerchantSettlement(
    plan.merchantPubkey,
    plan.checkoutId,
    plan.planDigest
  )
  await assertAuthority()
  if (!record)
    throw new Error("Checkout Spark local commerce proof is unavailable.")
  if (plan.nativeTreasury)
    deriveCheckoutSparkNativeTreasuryBudget(state, record)
  return { settlement: record, expectedTransferIds, closedReturnedProofs }
}

/** No unknown outgoing, extra deposit, pending receive, or unavailable scope. */
export async function proveBuyerCheckoutSparkTreasuryCommerce(
  input: Parameters<typeof inspectBuyerCheckoutSparkTreasuryCommerce>[0]
): Promise<CheckoutSparkMerchantSettlementRecord> {
  const inspection = await inspectBuyerCheckoutSparkTreasuryCommerce(input)
  const budget = deriveCheckoutSparkNativeTreasuryBudget(
    input.state,
    inspection.settlement
  )
  await input.assertAuthority()
  const session = await input.manager.openCheckoutRetirementReader(
    input.state.plan.walletId,
    {
      network: input.state.plan.network,
      receiverIdentityPublicKey:
        input.state.plan.funding.receiverIdentityPublicKey,
    }
  )
  let scoped: boolean
  try {
    scoped = await proveCheckoutSparkNativeTreasuryHistory({
      authenticatedReader: session.reader,
      sparkAddress: session.sparkAddress,
      walletId: input.state.plan.walletId,
      network: input.state.plan.network,
      stateUpdatedAt: input.state.updatedAt,
      authorizedDebitSats: budget.authorizedDebitSats,
      expectedTransferIds: inspection.expectedTransferIds,
      closedReturnedProofs: inspection.closedReturnedProofs,
      now: input.now,
      assertCurrent: input.assertCurrent,
    })
  } finally {
    await session.cleanup()
  }
  await input.assertAuthority()
  if (!scoped)
    throw new Error(
      "Checkout Spark final payment history is not fully attributed."
    )
  return inspection.settlement
}

/** Native rail is separate from the immutable historical Lightning fee rail. */
export function createBuyerCheckoutSparkNativeTreasuryProvider(input: {
  checkoutId: string
  manager: CheckoutSparkTreasuryManager
  repository: CheckoutSparkTreasuryRepository
  assertAuthority: () => Promise<void>
  assertCurrent: () => void
  now: () => number
}): CheckoutSparkNativeTreasuryProvider {
  const { manager, repository, assertAuthority, assertCurrent, now } = input
  // Only this engine run's prepared -> submitted transition may invoke send.
  // A fresh provider restoring submitted progress can query, never re-admit it.
  const preparedAdmissions = new Set<string>()
  const admissionKey = (target: CheckoutSparkNativeTreasuryTarget) =>
    JSON.stringify(target)
  async function request(target: CheckoutSparkNativeTreasuryTarget) {
    await assertAuthority()
    const saved = await repository.load(input.checkoutId, target.planDigest)
    await assertAuthority()
    if (
      saved.status !== "active" ||
      !saved.state.treasuryFinalization?.intent ||
      saved.state.plan.checkoutId !== input.checkoutId ||
      saved.state.plan.planDigest !== target.planDigest ||
      saved.state.plan.schemaVersion !== 4 ||
      saved.state.plan.walletId !== target.walletId ||
      saved.state.plan.network !== target.network ||
      saved.state.plan.recipients.find((leg) => leg.legId === target.legId)
        ?.kind !== "conduit" ||
      JSON.stringify(saved.state.plan.nativeTreasury) !==
        JSON.stringify(target.nativeTreasury) ||
      JSON.stringify(saved.state.treasuryFinalization?.intent) !==
        JSON.stringify(target.intent)
    ) {
      throw new Error("Checkout Spark native payment authority changed.")
    }
    return {
      saved,
      request: {
        network: target.network,
        nativeTreasury: target.nativeTreasury,
        amountSats: target.intent.amountSats,
        authorizedDebitSats: target.intent.authorizedDebitSats,
        providerTransferId: saved.state.treasuryFinalization.providerTransferId,
      },
    }
  }
  return {
    async reconcile(target) {
      const { request: value } = await request(target)
      const observation = await manager.inspectCheckoutTreasury(
        target.walletId,
        value
      )
      await assertAuthority()
      if (observation.status === "paid") {
        // A restored native receipt does not make cached commerce facts fresh.
        // Re-prove exact funding and recipient payments without the pre-send
        // balance guard: this transfer has already spent its attributed funds.
        const fresh = await request(target)
        await inspectBuyerCheckoutSparkTreasuryCommerce({
          state: fresh.saved.state,
          manager,
          repository,
          now,
          assertAuthority,
          assertCurrent,
        })
        const current = await request(target)
        await repository.recordMerchantTreasury(
          current.saved.state,
          {
            ...observation,
            status: "paid",
            observedAt: now(),
          },
          assertCurrent
        )
      }
      return observation
    },
    async preflight(target) {
      const { saved, request: value } = await request(target)
      if (saved.state.treasuryFinalization?.status !== "prepared")
        return "unavailable"
      const status = await manager.preflightCheckoutTreasury(
        target.walletId,
        value
      )
      const current = await request(target)
      if (current.saved.state.treasuryFinalization?.status !== "prepared")
        return "unavailable"
      if (status === "ready") preparedAdmissions.add(admissionKey(target))
      return status
    },
    async send(target) {
      const { saved, request: value } = await request(target)
      if (
        saved.state.treasuryFinalization?.status !== "submitted" ||
        !preparedAdmissions.delete(admissionKey(target))
      )
        throw new Error("Checkout Spark native payment was not admitted.")
      const result = await manager.sendCheckoutTreasury(target.walletId, {
        ...value,
        priorSendMayHaveOccurred: false,
        assertBeforeSend: async () => {
          const fresh = await request(target)
          const record = await proveBuyerCheckoutSparkTreasuryCommerce({
            state: fresh.saved.state,
            manager,
            repository,
            now,
            assertAuthority,
            assertCurrent,
          })
          if (
            deriveCheckoutSparkNativeTreasuryBudget(fresh.saved.state, record)
              .accountingDigest !== target.intent.accountingDigest
          )
            throw new Error("Checkout Spark final amount changed.")
        },
      })
      return { status: result.status === "not_sent" ? "not_sent" : "submitted" }
    },
  }
}

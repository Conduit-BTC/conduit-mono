// Synthetic provider-port census: no network, credentials or real wallets.
// Run from the repository root: bun run scripts/dev/measure_checkout_spark_workflow.ts
import { generateSecretKey, getPublicKey } from "nostr-tools"
import {
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledTreasuryPlan,
  prepareCheckoutSparkSettledLeg,
  deriveCheckoutSparkSettledTransferId,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  createCheckoutSparkMerchantSettlementRecord,
  runCheckoutSparkFinancialWorkflow,
  restoreCheckoutSparkSettledReconciliation,
  classifyCheckoutSparkSettledExactOutgoingHistory,
  type CheckoutSparkFinancialWorkflowPorts,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledRepositorySnapshot,
} from "../../packages/core/src/index"
import {
  nativeTreasuryFixture,
  AT,
} from "../../tests/support/checkout-spark-native-treasury-fixture"
import {
  makeSignedBolt11Fixture,
  bolt11PaymentSecretField,
} from "../../tests/support/signed-bolt11-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "../../tests/support/bolt11-fixture"
import {
  createBuyerCheckoutSparkNativeTreasuryProvider,
  proveBuyerCheckoutSparkTreasuryCommerce,
  inspectBuyerCheckoutSparkTreasuryCommerce,
  type CheckoutSparkTreasuryManager,
  type CheckoutSparkTreasuryRepository,
} from "../../apps/market/src/lib/checkout-spark-native-treasury"

const PROVIDER_DELAY_MS = 10
const SAMPLE_COUNT = 3

interface PhaseSample {
  phase: string
  elapsedVirtualMs: number
  elapsedWallMs: number
  counters: Record<string, number>
}

async function createFixture(count: number) {
  let clock = AT + 100
  const now = () => clock
  const base = nativeTreasuryFixture(
    undefined,
    undefined,
    getPublicKey(generateSecretKey())
  )
  const recipients = Array.from({ length: count }, (_, index) => ({
    ...base.legacy.recipients[0],
    kind: index === 0 ? ("merchant" as const) : ("supplier" as const),
    recipientId:
      index === 0
        ? base.plan.merchantPubkey
        : getPublicKey(generateSecretKey()),
    weightSats: Math.floor(1000 / count) + (index === 0 ? 1000 % count : 0),
    destination: {
      ...base.legacy.recipients[0].destination,
      value: `receiver-${index}@example.test`,
    },
  }))
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...base.plan,
    recipients: [...recipients, base.legacy.recipients[1]],
    nativeTreasury: base.plan.nativeTreasury!,
  })
  const credit = {
    mode: "ordinary_v3" as const,
    requestId: plan.funding.requestId,
    transferId: "attributed-credit",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: 1113,
    creditedSats: 1111,
  }
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    { ...credit, paymentHash: plan.funding.paymentHash, observedAt: AT + 1 }
  )
  const preimages = new Map<string, string>()
  for (let index = 0; index < count; index++) {
    const leg = state.legs[index]
    const preimage = new Uint8Array(32).fill(index + 20)
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage))
    const paymentHash = Array.from(hash, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
    const preimageHex = Array.from(preimage, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
    const amount = leg.allocationSats! - 5
    const paymentRequest = makeSignedBolt11Fixture({
      hrp: `lnbc${amount * 10}n`,
      createdAt: AT / 1000,
      fields: [
        bolt11PaymentHashField(hash),
        bolt11PaymentSecretField(),
        bolt11PlainDescriptionField(),
      ],
    })
    state = prepareCheckoutSparkSettledLeg(state, {
      legId: leg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, leg.legId),
      paymentRequest,
      paymentHash,
      invoiceAmountSats: amount,
      maxFeeSats: 5,
      preparedAt: AT + 2 + index,
    })
    preimages.set(leg.legId, preimageHex)
  }
  const prepared = structuredClone(state)
  for (const leg of state.legs.slice(0, count))
    state = recordCheckoutSparkSettledLegStatus(state, {
      legId: leg.legId,
      transferId: leg.intent!.transferId,
      paymentHash: leg.intent!.paymentHash,
      status: "paid",
      finalFeeSats: 4,
      finalDebitSats: leg.intent!.invoiceAmountSats + 4,
      observedAt: AT + 20,
    })
  let revision = 1
  let nativePaid = false
  let retired = false
  const calls: Record<string, number> = {}
  const hit = (key: string) => {
    calls[key] = (calls[key] ?? 0) + 1
  }
  const providerHit = async (key: string) => {
    hit(key)
    clock += PROVIDER_DELAY_MS
  }
  const record = {
    ...createCheckoutSparkMerchantSettlementRecord(plan),
    credit: {
      transferId: credit.transferId,
      creditedSats: credit.creditedSats,
      observedAt: AT + 1,
    },
    paidLegs: state.legs.slice(0, count).map((leg) => ({
      legId: leg.legId,
      transferId: leg.intent!.transferId,
      allocationSats: leg.allocationSats!,
      finalDebitSats: leg.finalDebitSats!,
      finalFeeSats: leg.finalFeeSats!,
      observedAt: AT + 20,
      recipientVerified: true,
    })),
  }
  const snapshot = (): CheckoutSparkSettledRepositorySnapshot =>
    retired
      ? { status: "retired", planDigest: plan.planDigest, retiredAt: now() }
      : { status: "active", state: structuredClone(state), revision }
  const save = async (next: typeof state, expected: number) => {
    if (revision !== expected) throw new Error("Synthetic CAS conflict")
    state = restoreCheckoutSparkSettledReconciliation(next)
    revision++
    return snapshot()
  }
  const repository = {
    load: async () => snapshot(),
    recordMerchantCredit: async () => {
      hit("creditFact")
    },
    recordMerchantPayout: async () => {
      hit("payoutFact")
    },
    assertLocalInvoiceOrigin: async () => {
      hit("localOrigin")
    },
    loadMerchantSettlement: async () => record,
    recordMerchantTreasury: async () => {
      hit("nativeFact")
    },
  }
  const history = async (_wallet: string, attempt: { transferId: string }) => {
    await providerHit("exactLightningHistory")
    const leg = state.legs.find(
      (row) => row.intent?.transferId === attempt.transferId
    )!
    return {
      status: "resolved" as const,
      verifiedTransferTotalSats: leg.intent!.invoiceAmountSats + 4,
      payment: {
        status: "completed",
        fees: 4n,
        details: {
          type: "lightning",
          htlcDetails: {
            paymentHash: leg.intent!.paymentHash,
            preimage: preimages.get(leg.legId)!,
          },
        },
      },
    }
  }
  const remaining = () =>
    1111 - record.paidLegs.reduce((sum, leg) => sum + leg.finalDebitSats, 0)
  const manager = {
    attestCheckoutReceiveCredit: async () => {
      await providerHit("exactCredit")
      return credit
    },
    reconcileInvoiceAttempt: history,
    inspectCheckoutLightningClosedReturnedAttempt: async () => {
      throw new Error("No synthetic archived returns")
    },
    openCheckoutRetirementReader: async () => {
      hit("readerOpen")
      return {
        sparkAddress: "synthetic-checkout-address",
        reader: {
          getTransfers: async () => {
            await providerHit("fullHistoryPage")
            return {
              offset: -1,
              transfers: [
                {
                  id: credit.transferId,
                  type: 0,
                  status: 5,
                  network: 1,
                  totalValue: 1111,
                },
                ...(nativePaid
                  ? [
                      {
                        id: "synthetic-native-transfer",
                        type: 0,
                        status: 5,
                        network: 1,
                        totalValue: remaining(),
                      },
                    ]
                  : []),
                ...state.legs.slice(0, count).map((leg) => ({
                  id: leg.intent!.transferId,
                  type: 0,
                  status: 5,
                  network: 1,
                  totalValue: leg.finalDebitSats!,
                })),
              ],
            }
          },
          getAvailableBalance: async () => {
            await providerHit("availableBalance")
            return nativePaid ? 0n : BigInt(remaining())
          },
          getOwnedBalance: async () => {
            await providerHit("ownedBalance")
            return nativePaid ? 0n : BigInt(remaining())
          },
          getPendingTransfers: async () => {
            await providerHit("pendingTransfers")
            return []
          },
        },
        cleanup: async () => {
          hit("readerCleanup")
        },
      }
    },
    inspectCheckoutTreasury: async () => {
      await providerHit("nativeInspect")
      return nativePaid
        ? {
            status: "paid" as const,
            invoiceId: plan.nativeTreasury!.invoiceId,
            providerTransferId: "synthetic-native-transfer",
            finalFeeSats: 0,
            finalDebitSats: remaining(),
          }
        : {
            status: "not_found" as const,
            invoiceId: plan.nativeTreasury!.invoiceId,
          }
    },
    preflightCheckoutTreasury: async () => {
      await providerHit("nativePreflight")
      return "ready" as const
    },
    sendCheckoutTreasury: async (
      _wallet: string,
      request: Parameters<
        CheckoutSparkTreasuryManager["sendCheckoutTreasury"]
      >[1]
    ) => {
      await request.assertBeforeSend?.()
      await providerHit("nativeSend")
      nativePaid = true
      return { status: "paid" as const }
    },
  }
  const authority = async () => {}
  const native = createBuyerCheckoutSparkNativeTreasuryProvider({
    checkoutId: plan.checkoutId,
    manager: manager as unknown as CheckoutSparkTreasuryManager,
    repository: repository as unknown as CheckoutSparkTreasuryRepository,
    assertAuthority: authority,
    assertCurrent: () => {},
    now,
  })
  const prove = (fresh: typeof state) => {
    hit("coreProveCommerceCalls")
    return proveBuyerCheckoutSparkTreasuryCommerce({
      state: fresh,
      manager: manager as unknown as CheckoutSparkTreasuryManager,
      repository: repository as unknown as CheckoutSparkTreasuryRepository,
      assertAuthority: authority,
      assertCurrent: () => {},
      now,
    })
  }
  const store = { load: repository.load, save, savePrepared: save }
  // Independent Core-only total for n preprepared commerce legs, without native.
  const sent = new Set<string>()
  const observation = (
    target: CheckoutSparkSettledOutgoingTarget,
    paid: boolean
  ) => ({
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
    ...(paid
      ? {
          status: "paid" as const,
          finalFeeSats: 4,
          finalDebitSats: target.intent.invoiceAmountSats + 4,
        }
      : { status: "not_found" as const }),
  })
  const ports: CheckoutSparkFinancialWorkflowPorts = {
    store,
    assertCurrent: authority,
    now,
    outgoing: {
      reconcile: async (target) => {
        await providerHit("reconcile")
        return observation(target, sent.has(target.legId))
      },
      preflight: async () => {
        await providerHit("preflight")
        return "ready" as const
      },
      send: async (target) => {
        await providerHit("send")
        sent.add(target.legId)
        return observation(target, true)
      },
    },
    recordPaid: async () => {
      hit("recordPaid")
    },
    acknowledgeRecoverySnapshot: async () => {
      await providerHit("ack")
    },
  }

  async function runSample(): Promise<PhaseSample[]> {
    state = createCheckoutSparkSettledReconciliation(plan)
    revision = 1
    retired = false
    nativePaid = false
    sent.clear()
    clock = AT + 100
    for (const key of Object.keys(calls)) delete calls[key]
    const phases: PhaseSample[] = []
    async function phase(name: string, operation: () => Promise<void>) {
      const startedAt = now()
      const startedWallAt = performance.now()
      const before = { ...calls }
      await operation()
      phases.push({
        phase: name,
        elapsedVirtualMs: now() - startedAt,
        elapsedWallMs: performance.now() - startedWallAt,
        counters: Object.fromEntries(
          Object.entries(calls)
            .map(([key, value]) => [key, value - (before[key] ?? 0)])
            .filter(([, value]) => value !== 0)
        ),
      })
    }
    await phase("funding-observation-and-core-credit-admission", async () => {
      const proof = await manager.attestCheckoutReceiveCredit()
      const result = await runCheckoutSparkFinancialWorkflow(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          actor: "shopper",
          mode: "credit",
        },
        {
          store,
          assertCurrent: authority,
          now,
          credit: {
            proof,
            record: async () => {
              hit("creditFact")
            },
          },
          acknowledgeRecoverySnapshot: async () => {},
        }
      )
      if (result.status !== "credited")
        throw new Error("Synthetic credit did not admit")
    })
    // Invoice creation is fixture assembly, not measured app preparation.
    state = structuredClone(prepared)
    await phase("preprepared-core-commerce-completion", async () => {
      for (let index = 0; index < count; index++) {
        const step = await runCheckoutSparkFinancialWorkflow(
          {
            checkoutId: plan.checkoutId,
            planDigest: plan.planDigest,
            actor: "shopper",
            mode: "advance",
          },
          ports
        )
        if (step.status !== "outgoing_step" || step.step.outcome !== "paid")
          throw new Error("Synthetic commerce did not pay")
      }
    })
    await phase("buyer-native-commitment", async () => {
      const result = await runCheckoutSparkFinancialWorkflow(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          actor: "shopper",
          mode: "advance",
          legId: plan.recipients.at(-1)!.legId,
        },
        {
          store,
          assertCurrent: authority,
          now,
          outgoing: {
            reconcile: async (target) =>
              classifyCheckoutSparkSettledExactOutgoingHistory(
                target,
                await history(plan.walletId, target.intent)
              ),
            preflight: async () => "ready",
            send: async () => {
              throw new Error("Commerce was already paid")
            },
          },
          recordPaid: async () => {
            hit("paidFactCallback")
          },
          native: { store, provider: native, proveCommerce: prove },
          acknowledgeRecoverySnapshot: async () => {
            await providerHit("recoveryAck")
          },
        }
      )
      if (result.status !== "outgoing_step" || result.step.outcome !== "paid")
        throw new Error("Synthetic native finalization did not pay")
    })
    // Align to the frozen Merchant boundary without counting it as provider work.
    clock = plan.takeoverAt + 1
    await phase("core-terminal-retirement-inspection", async () => {
      const result = await runCheckoutSparkFinancialWorkflow(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          actor: "merchant",
          mode: "retire",
        },
        {
          store,
          assertCurrent: authority,
          now,
          acknowledgeRecoverySnapshot: async () => {},
          retirement: {
            proveSettlement: async (fresh) => {
              const inspection =
                await inspectBuyerCheckoutSparkTreasuryCommerce({
                  state: fresh,
                  manager: manager as unknown as CheckoutSparkTreasuryManager,
                  repository:
                    repository as unknown as CheckoutSparkTreasuryRepository,
                  assertAuthority: authority,
                  assertCurrent: () => {},
                  now,
                })
              const native = await manager.inspectCheckoutTreasury()
              if (native.status !== "paid") return null
              return {
                expectedTransferIds: [
                  ...inspection.expectedTransferIds,
                  native.providerTransferId,
                ],
                closedReturnedProofs: inspection.closedReturnedProofs,
              }
            },
            openReader: () => manager.openCheckoutRetirementReader(),
            commit: async () => {
              hit("retirementCommit")
              retired = true
            },
          },
        }
      )
      if (result.status !== "retired")
        throw new Error("Synthetic retirement did not complete")
    })
    return phases
  }
  return { runSample }
}

function summary(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    samples: values.length,
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
  }
}

for (const commerceLegs of [1, 3, 8]) {
  for (const sessionModel of [
    "fresh-synthetic-ports",
    "repeated-same-synthetic-ports",
  ] as const) {
    const samples: PhaseSample[][] = []
    const fixtureAcquisitionWallMs: number[] = []
    let warm: Awaited<ReturnType<typeof createFixture>> | undefined
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      const startedAt = performance.now()
      const fixture =
        sessionModel === "repeated-same-synthetic-ports"
          ? (warm ??= await createFixture(commerceLegs))
          : await createFixture(commerceLegs)
      fixtureAcquisitionWallMs.push(performance.now() - startedAt)
      samples.push(await fixture.runSample())
    }
    console.log(
      JSON.stringify({
        scenario: "controlled-workflow-phase-sampler",
        outcome: "retired",
        commerceLegs,
        sessionModel,
        injectedProviderDelayMs: PROVIDER_DELAY_MS,
        externalUserWait: "not-sampled",
        fixtureConstructions:
          sessionModel === "fresh-synthetic-ports" ? SAMPLE_COUNT : 1,
        fixtureAcquisitionWallMs: summary(fixtureAcquisitionWallMs),
        phases: samples[0].map((phase, index) => ({
          phase: phase.phase,
          elapsedVirtualMs: summary(
            samples.map((sample) => sample[index].elapsedVirtualMs)
          ),
          elapsedWallMs: summary(
            samples.map((sample) => sample[index].elapsedWallMs)
          ),
          counterSamples: samples.map((sample) => sample[index].counters),
        })),
      })
    )
  }
}

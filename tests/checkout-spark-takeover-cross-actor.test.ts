import { describe, expect, it } from "bun:test"
import {
  decodeSparkAddress,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
  UUID,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"

import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkSettledReconciliation,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { runCheckoutSparkSettledOutgoingStep } from "../packages/core/src/protocol/checkout-spark-settled-outgoing"
import { checkoutSparkSettledOutgoingStatusObservation } from "../packages/core/src/protocol/checkout-spark-settled-outgoing-history"
import { createCheckoutSparkSettledNativeOutgoingProvider } from "../packages/core/src/protocol/checkout-spark-settled-native-outgoing"
import { createCheckoutSparkMerchantSettlementRecord } from "../packages/core/src/protocol/checkout-spark-merchant-settlement"
import {
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  prepareCheckoutSparkNativeTreasury,
  runCheckoutSparkNativeTreasuryStep,
  type CheckoutSparkNativeTreasuryProvider,
  type CheckoutSparkNativeTreasuryStateStore,
} from "../packages/core/src/protocol/checkout-spark-treasury-finalization"
import {
  CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  createCheckoutSparkNativeTreasurySdkAdapter,
  prepareCheckoutSparkNativeTreasuryRequest,
  type CheckoutSparkNativeTreasurySdkWallet,
} from "../packages/core/src/protocol/checkout-spark-treasury-sdk"
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

function fundingInvoice() {
  return makeSignedBolt11Fixture({
    hrp: "lnbc11130n",
    createdAt: AT / 1000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(1)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      { tag: "x", words: [28, 4] }, // 900 seconds; the handoff is not invoice expiry.
    ],
  })
}

function boundary() {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    started,
    release,
    async wait() {
      entered()
      await held
    },
  }
}

/** Separate browser stores intentionally have no shared CAS or cross-origin lease. */
function localStore(initial: CheckoutSparkSettledReconciliation) {
  let state = structuredClone(initial)
  let revision = 1
  const store: CheckoutSparkNativeTreasuryStateStore = {
    async load() {
      return { status: "active", revision, state }
    },
    async save(next, expectedRevision) {
      if (expectedRevision !== revision) throw new Error("Local CAS conflict")
      state = next
      revision++
      return { status: "active", revision, state }
    },
    async savePrepared(next, expectedRevision) {
      return store.save(next, expectedRevision)
    },
  }
  return { store, state: () => state }
}

// Public curve points and pure SDK codecs only; no SDK wallet is initialized.
const SENDER =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const RECEIVER = `03${SENDER.slice(2)}`
const NATIVE_TRANSFER_ID = "0197f9a0-0000-7000-8000-000000000002"
const codec = {
  nativeTreasuryPolicy: CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  parseTransferId: UUID.parse,
  encodeSparkAddress,
  decodeSparkAddress,
  isValidSparkAddress,
  getNetworkFromSparkAddress,
}

function nativeFixture() {
  const source = commerceFixture()
  const sparkAddress = encodeSparkAddress({
    identityPublicKey: RECEIVER,
    network: "MAINNET",
  })
  const legacy = freezeCheckoutSparkSettledPlan({
    ...source.plan,
    funding: { ...source.plan.funding, receiverIdentityPublicKey: SENDER },
  })
  const identity = {
    ...legacy,
    sparkAddress,
    senderIdentityPublicKey: SENDER,
    receiverIdentityPublicKey: RECEIVER,
  }
  const nativeTreasury = prepareCheckoutSparkNativeTreasuryRequest(codec, {
    ...identity,
    invoiceId: deriveCheckoutSparkNativeTreasuryInvoiceId(identity),
  })
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...legacy,
    nativeTreasury,
  })
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    { ...source.state.credit!, receiverIdentityPublicKey: SENDER }
  )
  const legId = plan.recipients[0]!.legId
  const transferId = deriveCheckoutSparkSettledTransferId(plan, legId)
  state = prepareCheckoutSparkSettledLeg(state, {
    ...source.state.legs[0]!.intent!,
    legId,
    transferId,
  })
  state = recordCheckoutSparkSettledLegStatus(state, {
    legId,
    transferId,
    paymentHash: state.legs[0]!.intent!.paymentHash,
    status: "paid",
    observedAt: AT + 3,
    finalFeeSats: 4,
    finalDebitSats: 999,
  })
  const settlement = {
    ...createCheckoutSparkMerchantSettlementRecord(plan),
    credit: {
      transferId: state.credit!.transferId,
      creditedSats: 1_111,
      observedAt: AT + 1,
    },
    paidLegs: [
      {
        legId,
        transferId,
        allocationSats: 1_000,
        finalFeeSats: 4,
        finalDebitSats: 999,
        observedAt: AT + 3,
        recipientVerified: true as const,
      },
    ],
  }
  state = prepareCheckoutSparkNativeTreasury(state, {
    settlement,
    preparedAt: AT + 4,
  })
  return { plan, state, settlement, legId: plan.recipients[1]!.legId }
}

function commerceFixture() {
  const source = nativeTreasuryFixture()
  const plan = freezeCheckoutSparkSettledPlan({
    ...source.legacy,
    takeoverAt: AT + 120_000,
    funding: {
      ...source.legacy.funding,
      paymentRequest: fundingInvoice(),
      expiresAt: AT + 900_000,
    },
  })
  const credited = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "synthetic-cross-actor-funding",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: plan.funding.grossFundingSats,
      creditedSats: 1_111,
      observedAt: AT + 1,
    }
  )
  const legId = plan.recipients[0]!.legId
  const state = prepareCheckoutSparkSettledLeg(credited, {
    ...source.state.legs[0]!.intent!,
    legId,
    transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
  })
  return { plan, state, legId }
}

describe("two-minute checkout takeover across independent actor stores", () => {
  it.each(["preflight", "send"] as const)(
    "revokes buyer authority after an awaited %s fee read before any commerce SDK entry",
    async (stage: "preflight" | "send") => {
      const { plan, state, legId } = commerceFixture()
      const buyer = localStore(state)
      const feeRead = boundary()
      let now = plan.takeoverAt - 1
      let feeReads = 0
      let sdkEntries = 0
      const provider = createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        now: () => now,
        assertBeforeSend() {
          if (now >= plan.takeoverAt) throw new Error("Buyer authority ended")
        },
        reconcile: async (target) =>
          checkoutSparkSettledOutgoingStatusObservation(target, "not_found"),
        wallet: {
          getAvailableSats: async () => 1_111n,
          async estimateFee() {
            feeReads++
            if (feeReads === (stage === "preflight" ? 1 : 2))
              await feeRead.wait()
            return 4
          },
          sendFrozen: async () => {
            sdkEntries++
          },
        },
      })
      const running = runCheckoutSparkSettledOutgoingStep({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        legId,
        actor: "shopper",
        now: () => now,
        store: buyer.store,
        provider,
        acknowledgeRecoverySnapshot: async () => {},
      })
      try {
        await feeRead.started
        now = plan.takeoverAt
        feeRead.release()
        const result = await running
        expect(result.outcome).toBe(
          stage === "preflight" ? "wait" : "send_ambiguous"
        )
        expect(sdkEntries).toBe(0)
        expect(buyer.state().legs[0]!.status).toBe(
          stage === "preflight" ? "prepared" : "submitted"
        )
      } finally {
        feeRead.release()
        await running
      }
    }
  )

  it("preserves one commerce debit under an atomic transfer-ID guard despite two SDK entries", async () => {
    const { plan, state, legId } = commerceFixture()
    const buyer = localStore(state)
    const merchant = localStore(state)
    const admittedBuyer = boundary()
    const atomicTransfers = new Map<string, string>()
    const sspHistory = new Map<string, string>()
    const sdkEntries: Array<{ transferId: string; invoice: string }> = []
    let now = plan.takeoverAt - 1
    let historyVisible = false
    let successfulDebits = 0
    let totalDebitSats = 0
    const acks: Record<"shopper" | "merchant", string[]> = {
      shopper: [],
      merchant: [],
    }

    // This fixture supplies an atomic SO transfer-ID guard and exact SSP history.
    // It does not independently exercise SSP deduplication or prove deployment.
    const providerFor = (actor: "shopper" | "merchant") =>
      createCheckoutSparkSettledNativeOutgoingProvider({
        plan,
        now: () => now,
        assertBeforeSend() {
          if (actor === "shopper" && now >= plan.takeoverAt)
            throw new Error("Buyer authority ended")
        },
        reconcile: async (target) => {
          if (!historyVisible || !sspHistory.has(target.intent.transferId))
            return checkoutSparkSettledOutgoingStatusObservation(
              target,
              "not_found"
            )
          return {
            ...checkoutSparkSettledOutgoingStatusObservation(
              target,
              "not_found"
            ),
            status: "paid" as const,
            finalFeeSats: 4,
            finalDebitSats: 999,
          }
        },
        wallet: {
          getAvailableSats: async () => 1_111n,
          estimateFee: async () => 4,
          async sendFrozen(request) {
            expect(acks[actor].at(-1)).toBe("submitted")
            sdkEntries.push({
              transferId: request.transferId,
              invoice: request.paymentRequest,
            })
            if (actor === "shopper") await admittedBuyer.wait()
            const existing = atomicTransfers.get(request.transferId)
            if (existing) {
              if (existing !== request.paymentRequest)
                throw new Error("Conflicting SO transfer parameters")
              throw new Error("SO transfer already exists")
            }
            atomicTransfers.set(request.transferId, request.paymentRequest)
            sspHistory.set(request.transferId, request.paymentRequest)
            successfulDebits++
            totalDebitSats += 999
          },
        },
      })

    const run = (actor: "shopper" | "merchant", inspectionOnly = false) =>
      runCheckoutSparkSettledOutgoingStep({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        legId,
        actor,
        inspectionOnly,
        now: () => now,
        store: actor === "shopper" ? buyer.store : merchant.store,
        provider: providerFor(actor),
        acknowledgeRecoverySnapshot: async (snapshot) => {
          acks[actor].push(snapshot.legs[0]!.status)
        },
      })

    const runningBuyer = run("shopper")
    try {
      await admittedBuyer.started
      expect(buyer.state().legs[0]!.status).toBe("submitted")
      expect(merchant.state().legs[0]!.status).toBe("prepared")
      now = plan.takeoverAt
      expect((await run("merchant")).outcome).toBe("send_ambiguous")
      admittedBuyer.release()
      expect((await runningBuyer).outcome).toBe("send_ambiguous")
      expect(sdkEntries).toHaveLength(2)
      expect(new Set(sdkEntries.map((entry) => entry.transferId)).size).toBe(1)
      expect(new Set(sdkEntries.map((entry) => entry.invoice)).size).toBe(1)
      expect(
        sdkEntries.every(
          (entry) =>
            entry.transferId ===
            deriveCheckoutSparkSettledTransferId(plan, legId)
        )
      ).toBe(true)
      expect(successfulDebits).toBe(1)
      expect(totalDebitSats).toBe(999)
      expect(atomicTransfers.size).toBe(1)
      expect(sspHistory.size).toBe(1)

      // Neither actor re-enters a payer when exact history is still absent.
      expect((await run("merchant")).reason).toBe("prior_possible_send")
      expect((await run("shopper", true)).reason).toBe("prior_possible_send")
      expect(sdkEntries).toHaveLength(2)
      historyVisible = true
      expect((await run("merchant")).outcome).toBe("paid")
      expect((await run("shopper", true)).outcome).toBe("paid")
      expect(sdkEntries).toHaveLength(2)
      expect(totalDebitSats).toBe(999)
    } finally {
      admittedBuyer.release()
      await runningBuyer
    }
  })

  it("revokes buyer authority after a native balance await before any fulfillment SDK entry", async () => {
    const { plan, state } = nativeFixture()
    const balanceRead = boundary()
    let now = plan.takeoverAt - 1
    let sdkEntries = 0
    const adapter = createCheckoutSparkNativeTreasurySdkAdapter({
      codec,
      network: "MAINNET",
      read: (read) => read(),
      wallet: {
        getIdentityPublicKey: async () => SENDER,
        querySparkInvoices: async (invoices) => ({
          invoiceStatuses: [{ invoice: invoices[0]!, status: 0 }],
        }),
        getTransfer: async () => {
          throw new Error("Unexpected transfer read")
        },
        async getBalance() {
          await balanceRead.wait()
          return { satsBalance: { available: 112n, owned: 112n, incoming: 0n } }
        },
        fulfillSparkInvoice: async () => {
          sdkEntries++
        },
      },
    })
    const intent = state.treasuryFinalization!.intent!
    const running = adapter.sendCheckoutTreasury({
      network: plan.network,
      nativeTreasury: plan.nativeTreasury!,
      amountSats: intent.amountSats,
      authorizedDebitSats: intent.authorizedDebitSats,
      priorSendMayHaveOccurred: false,
      assertBeforeSend: async () => {
        if (now >= plan.takeoverAt) throw new Error("Buyer authority ended")
      },
    })
    try {
      await balanceRead.started
      now = plan.takeoverAt
      balanceRead.release()
      expect((await running).status).toBe("not_sent")
      expect(sdkEntries).toBe(0)
    } finally {
      balanceRead.release()
      await running
    }
  })

  it("preserves one native debit under atomic invoice and leaf guards despite two independent SDK adapters", async () => {
    const { plan, state, settlement, legId } = nativeFixture()
    const buyer = localStore(state)
    const merchant = localStore(state)
    const admittedBuyer = boundary()
    let now = plan.takeoverAt - 1
    let historyVisible = false
    let invoiceActive = false
    let leafConsumed = false
    let successfulDebits = 0
    let totalDebitSats = 0
    const sdkEntries: Array<{ invoice: string; amount: bigint }> = []
    const acks: Record<"shopper" | "merchant", string[]> = {
      shopper: [],
      merchant: [],
    }
    const providerFor = (actor: "shopper" | "merchant") => {
      const wallet: CheckoutSparkNativeTreasurySdkWallet = {
        getIdentityPublicKey: async () => SENDER,
        // Deliberately stale reads let both actors pass preflight. Atomic leaf
        // consumption belongs to the provider, not this advisory balance read.
        getBalance: async () => ({
          satsBalance: { available: 112n, owned: 112n, incoming: 0n },
        }),
        querySparkInvoices: async (invoices) => ({
          invoiceStatuses: [
            {
              invoice: invoices[0]!,
              status: historyVisible && invoiceActive ? 2 : 0,
              ...(historyVisible && invoiceActive
                ? {
                    transferType: {
                      $case: "satsTransfer" as const,
                      satsTransfer: {
                        transferId: UUID.parse(NATIVE_TRANSFER_ID).bytes,
                      },
                    },
                  }
                : {}),
            },
          ],
        }),
        getTransfer: async () => ({
          id: NATIVE_TRANSFER_ID,
          type: "TRANSFER",
          transferDirection: "OUTGOING",
          status: "TRANSFER_STATUS_COMPLETED",
          totalValue: 112,
          valueSentByWallet: 112,
          valueReceivedByWallet: 0,
          sparkInvoice: plan.nativeTreasury!.invoiceRequest,
          senderIdentityPublicKey: SENDER,
          receiverIdentityPublicKey: RECEIVER,
          senders: [{ identityPublicKey: SENDER }],
          receivers: [
            {
              identityPublicKey: RECEIVER,
              amountSats: 112,
              status: "TRANSFER_RECEIVER_STATUS_COMPLETED",
            },
          ],
        }),
        async fulfillSparkInvoice(invoices) {
          expect(acks[actor].at(-1)).toBe("submitted")
          expect(invoices).toHaveLength(1)
          const request = invoices[0]!
          sdkEntries.push(request)
          if (actor === "shopper") await admittedBuyer.wait()
          // An explicit atomic provider transaction, not an application lease.
          if (invoiceActive || leafConsumed)
            throw new Error("Invoice or leaf already consumed")
          invoiceActive = true
          leafConsumed = true
          successfulDebits++
          totalDebitSats += Number(request.amount)
        },
      }
      const adapter = createCheckoutSparkNativeTreasurySdkAdapter({
        wallet,
        codec,
        network: "MAINNET",
        read: (read) => read(),
      })
      const request = (
        target: Parameters<CheckoutSparkNativeTreasuryProvider["send"]>[0]
      ) => ({
        network: target.network,
        nativeTreasury: target.nativeTreasury,
        amountSats: target.intent.amountSats,
        authorizedDebitSats: target.intent.authorizedDebitSats,
      })
      const provider: CheckoutSparkNativeTreasuryProvider = {
        reconcile: (target) => adapter.inspectCheckoutTreasury(request(target)),
        preflight: (target) =>
          adapter.preflightCheckoutTreasury(request(target)),
        async send(target) {
          const result = await adapter.sendCheckoutTreasury({
            ...request(target),
            priorSendMayHaveOccurred: false,
            assertBeforeSend: async () => {
              if (actor === "shopper" && now >= plan.takeoverAt)
                throw new Error("Buyer authority ended")
            },
          })
          return {
            status: result.status === "not_sent" ? "not_sent" : "submitted",
          }
        },
      }
      return provider
    }
    // Distinct production SDK adapter instances intentionally do not share
    // their local admitted-invoice sets.
    const providers = {
      shopper: providerFor("shopper"),
      merchant: providerFor("merchant"),
    }
    const run = (actor: "shopper" | "merchant", inspectionOnly = false) =>
      runCheckoutSparkNativeTreasuryStep({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        legId,
        actor,
        inspectionOnly,
        now: () => now,
        store: actor === "shopper" ? buyer.store : merchant.store,
        provider: providers[actor],
        proveCommerce: async () => settlement,
        acknowledgeRecoverySnapshot: async (snapshot) => {
          acks[actor].push(snapshot.treasuryFinalization!.status)
        },
      })
    const runningBuyer = run("shopper")
    try {
      await admittedBuyer.started
      expect(buyer.state().treasuryFinalization!.status).toBe("submitted")
      expect(merchant.state().treasuryFinalization!.status).toBe("prepared")
      now = plan.takeoverAt
      expect((await run("merchant")).outcome).toBe("send_ambiguous")
      admittedBuyer.release()
      expect((await runningBuyer).outcome).toBe("send_ambiguous")
      expect(sdkEntries).toHaveLength(2)
      expect(
        sdkEntries.every(
          (entry) =>
            entry.invoice === plan.nativeTreasury!.invoiceRequest &&
            entry.amount === 112n
        )
      ).toBe(true)
      expect(successfulDebits).toBe(1)
      expect(totalDebitSats).toBe(112)
      expect(invoiceActive && leafConsumed).toBe(true)
      expect((await run("merchant")).reason).toBe("prior_possible_send")
      expect((await run("shopper", true)).reason).toBe("prior_possible_send")
      expect(sdkEntries).toHaveLength(2)
      historyVisible = true
      expect((await run("merchant")).outcome).toBe("paid")
      expect((await run("shopper", true)).outcome).toBe("paid")
      expect(sdkEntries).toHaveLength(2)
      expect(totalDebitSats).toBe(112)
    } finally {
      admittedBuyer.release()
      await runningBuyer
    }
  })
})

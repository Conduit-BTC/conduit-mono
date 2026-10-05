import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  decodeSparkAddress,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
  UUID,
} from "../apps/market/node_modules/@buildonspark/spark-sdk/dist/index.browser.js"
import { ConduitDB } from "@conduit/core/db"
import {
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  deriveCheckoutSparkSettledRenewalTransferId,
  freezeCheckoutSparkSettledTreasuryPlan,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  runCheckoutSparkNativeTreasuryStep,
  prepareCheckoutSparkNativeTreasury,
  recordCheckoutSparkNativeTreasuryStatus,
  deriveCheckoutSparkNativeTreasuryBudget,
  createCheckoutSparkSettledRecoveryPayload,
  publishCheckoutSparkRecovery,
  openCheckoutSparkRecoveryDelivery,
  createCheckoutSparkMerchantProgress,
  parseCheckoutSparkMerchantProgress,
  buildCheckoutSparkMerchantProgressRumor,
  parseCheckoutSparkMerchantProgressRumor,
  proveCheckoutSparkSettledReturnedTransfer,
  renewCheckoutSparkSettledLeg,
  collectCheckoutSparkNativeRetirementEvidence,
  type CheckoutSparkRecoveryDeliveryRecord,
  type CheckoutSparkNativeTreasuryTarget,
  type CheckoutSparkSettledOutgoingTarget,
  type OrderLifecycle,
} from "@conduit/core"
import {
  FirstPartySparkSdkFactory,
  type SparkNativeWallet,
} from "../apps/market/src/lib/spark-sdk"
import { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import {
  proveBuyerCheckoutSparkTreasuryCommerce,
  inspectBuyerCheckoutSparkTreasuryCommerce,
  createBuyerCheckoutSparkNativeTreasuryProvider,
} from "../apps/market/src/lib/checkout-spark-native-treasury"
import { retireCheckoutSparkSettledShopper } from "../apps/market/src/lib/checkout-spark-settled-retirement"
import { createCheckoutSparkSettledShopperRunner } from "../apps/market/src/lib/checkout-spark-settled-shopper-runner"
import {
  canContinueCheckoutSparkSettledRouteSession,
  type CheckoutSparkSettledRouteSession,
} from "../apps/market/src/lib/checkout-spark-settled-route-session"
import { getCheckoutSparkSettledOutcomeMessage } from "../apps/market/src/lib/checkout-spark-settled-outcome-message"
import { deriveMerchantCheckoutSparkRecoveryIdentity } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { plainTestSigner } from "./helpers/plain-signer"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

// All credentials, native history and BOLT11s are synthetic and in memory.
// The real first-party adapter and local repository are not mocked.
const AT = Math.floor(Date.now() / 1000) * 1000 - 1000
const RECEIVER =
  "0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
const ADDRESS = encodeSparkAddress({
  identityPublicKey: RECEIVER,
  network: "MAINNET",
})
const codec = {
  parseTransferId: UUID.parse,
  encodeSparkAddress,
  decodeSparkAddress,
  getNetworkFromSparkAddress,
  isValidSparkAddress,
}

function invoice(amount: number, byte: number, createdAt = AT, expiry = 900) {
  const preimage = new Uint8Array(32).fill(byte)
  const paymentHash = createHash("sha256").update(preimage).digest("hex")
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: `lnbc${amount * 10}n`,
    createdAt: Math.floor(createdAt / 1000),
    fields: [
      bolt11PaymentHashField(Uint8Array.from(Buffer.from(paymentHash, "hex"))),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField("Offline native finalization"),
      {
        tag: "x",
        words: expiry
          .toString(2)
          .padStart(Math.ceil(expiry.toString(2).length / 5) * 5, "0")
          .match(/.{5}/g)!
          .map((word) => parseInt(word, 2)),
      },
    ],
  })
  return {
    paymentRequest,
    paymentHash,
    preimage: Buffer.from(preimage).toString("hex"),
  }
}

async function fixture(
  options: { closed?: boolean; commercePaid?: boolean } = {}
) {
  const mnemonic = createRuntimeMnemonic()
  const merchant = plainTestSigner(NDKPrivateKeySigner.generate())
  const buyer = plainTestSigner(NDKPrivateKeySigner.generate())
  const walletId = `native-app-wallet-${crypto.randomUUID()}`
  const sender = await deriveMerchantCheckoutSparkRecoveryIdentity(mnemonic, 0)
  const database = new ConduitDB(`native-app-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const repository = new DexieCheckoutSparkSettledRepository(database)
  const native = createHermeticSparkNative({
    network: "mainnet",
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    encodeAddress: (identityPublicKey) =>
      encodeSparkAddress({ identityPublicKey, network: "MAINNET" }),
    nativeInvoiceCodec: codec,
    issueFundingInvoice: async ({ amountSats }) =>
      invoice(amountSats, 71).paymentRequest,
  })
  const reads = { credit: 0, winner: 0, history: 0, cleaned: 0, closed: 0 }
  const hooks: {
    fundingMissing?: boolean
    winnerMissing?: boolean
    incompleteHistory?: boolean
    unavailableHistory?: boolean
    mutateTransfer?: (
      transfer: NonNullable<
        Awaited<ReturnType<SparkNativeWallet["getTransfer"]>>
      >
    ) => void
    mutateSsp?: (
      transfer: NonNullable<
        Awaited<ReturnType<SparkNativeWallet["getTransferFromSsp"]>>
      >
    ) => void
    beforeNativeQuery?: () => void
    hideNativeQueries?: boolean
  } = {}
  let now = AT + 100
  const makeFactory = () =>
    new FirstPartySparkSdkFactory({
      network: "mainnet",
      now: () => now,
      wait: async () => {},
      loadModule: async () => ({
        ...native.module,
        async initialize(input) {
          const { wallet } = await native.module.initialize(input)
          return {
            wallet: {
              ...wallet,
              async getLightningReceiveRequest(id) {
                reads.credit++
                return hooks.fundingMissing
                  ? null
                  : wallet.getLightningReceiveRequest(id)
              },
              async getTransferFromSsp(id) {
                reads.winner++
                if (hooks.winnerMissing) return undefined
                const transfer = await wallet.getTransferFromSsp(id)
                if (transfer) hooks.mutateSsp?.(transfer)
                return transfer
              },
              async getTransfer(id) {
                const transfer = await wallet.getTransfer(id)
                if (transfer) hooks.mutateTransfer?.(transfer)
                return transfer
              },
              async querySparkInvoices(invoices) {
                hooks.beforeNativeQuery?.()
                if (hooks.hideNativeQueries)
                  return {
                    invoiceStatuses: invoices.map((invoice) => ({
                      invoice,
                      status: 0,
                    })),
                  }
                return wallet.querySparkInvoices!(invoices)
              },
              async queryHTLC(request) {
                reads.closed++
                return wallet.queryHTLC!(request)
              },
              async openRetirementReader() {
                const session = await native.openAuthenticatedRetirementReader({
                  mnemonic,
                  accountNumber: 0,
                  network: "mainnet",
                })
                return {
                  reader: {
                    ...session.reader,
                    async getTransfers(request) {
                      reads.history++
                      if (hooks.unavailableHistory)
                        throw new Error("Synthetic history unavailable")
                      const result = await session.reader.getTransfers(request)
                      return hooks.incompleteHistory
                        ? {
                            ...result,
                            transfers: result.transfers.slice(0, -1),
                          }
                        : result
                    },
                  },
                  async cleanup() {
                    reads.cleaned++
                    await session.cleanup()
                  },
                }
              },
            },
          }
        },
      }),
    })
  let manager = new SparkWalletManager(
    makeFactory(),
    async () => ({ release: async () => {} }),
    undefined,
    () => now
  )
  await manager.openWithMnemonic({ walletId, mnemonic, accountNumber: 0 })
  const receive = await manager.createCheckoutReceive(walletId, {
    receiveMode: "ordinary_settled_v3",
    description: "Offline fixture",
    requiredNetSats: 1113,
    grossFundingSats: 1113,
    expirySecs: 900,
  })
  const identity = {
    checkoutId: "native-app-checkout",
    orderId: "native-app-order",
    walletId,
    network: "mainnet" as const,
    createdAt: AT,
    sparkAddress: ADDRESS,
    receiverIdentityPublicKey: RECEIVER,
    senderIdentityPublicKey: sender,
  }
  const nativeTreasury = await manager.prepareCheckoutTreasuryRequest({
    ...identity,
    invoiceId: deriveCheckoutSparkNativeTreasuryInvoiceId(identity),
  })
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    ...identity,
    merchantPubkey: merchant.pubkey,
    takeoverAt: AT + 120_000,
    nativeTreasury,
    funding: {
      requestId: receive.id,
      paymentRequest: receive.paymentRequest,
      paymentHash: receive.paymentHash,
      receiverIdentityPublicKey: sender,
      grossFundingSats: receive.grossFundingSats,
      createdAt: receive.createdAt,
      expiresAt: receive.expiresAt,
    },
    commerceQuote: {
      commerceTotalSats: 1000,
      lines: [
        {
          productCoordinate: `30402:${merchant.pubkey}:synthetic`,
          productEventId: "c".repeat(64),
          merchantPubkey: merchant.pubkey,
          quantity: 1,
          unitMerchandiseSats: 1000,
          unitShippingSats: 0,
        },
      ],
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: merchant.pubkey,
        weightSats: 1000,
        destination: {
          type: "lightning_address",
          value: "merchant@wallet.conduit.market",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: AT / 1000,
          },
        },
      },
      {
        kind: "conduit",
        recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
        weightSats: 111,
        destination: {
          type: "lightning_address",
          value: CONDUIT_CHECKOUT_FEE_RECIPIENT,
          source: { type: "conduit_allowlist", policy: "production" },
        },
      },
    ],
  })
  await repository.create(plan)
  const control = native.control.forIdentity(sender)
  control.completeFunding()
  const credit = await manager.attestCheckoutReceiveCredit(walletId, receive)
  if (!credit) throw new Error("Synthetic funding must attest")
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    { ...credit, paymentHash: plan.funding.paymentHash, observedAt: AT + 1 }
  )
  let revision = 1
  await repository.save(state, revision++)
  const leg = state.legs[0]!
  let payout = invoice(leg.allocationSats! - 5, 72)
  const prepare = (generation = 0 as 0 | 1, preparedAt = AT + 2) => ({
    legId: leg.legId,
    transferId:
      generation === 1
        ? deriveCheckoutSparkSettledRenewalTransferId(plan, leg.legId)
        : deriveCheckoutSparkSettledTransferId(plan, leg.legId),
    ...payout,
    invoiceAmountSats: leg.allocationSats! - 5,
    maxFeeSats: 5,
    preparedAt,
  })
  let intent = prepare()
  if (options.closed) {
    payout = invoice(leg.allocationSats! - 5, 73, AT - 1_000, 2)
    intent = prepare()
  }
  state = prepareCheckoutSparkSettledLeg(state, intent)
  const origin = async () =>
    (
      await resolveCheckoutSparkFixtureInvoice(
        {
          lud16: plan.recipients[0]!.destination.value,
          amountSats: intent.invoiceAmountSats,
          network: "mainnet",
          nowSeconds: Math.floor(now / 1000),
          shouldContinue: () => true,
        },
        intent.paymentRequest
      )
    ).origin!
  if (!options.closed)
    await repository.savePreparedWithInvoiceOrigin(state, revision++, {
      legId: leg.legId,
      origin: await origin(),
    })
  if (options.closed) {
    await repository.save(state, revision++)
    control.registerReturnedLightning({
      transferId: intent.transferId,
      paymentRequest: intent.paymentRequest,
      feeSats: 4,
    })
    now = plan.takeoverAt + 1
    const returned =
      await manager.inspectCheckoutLightningClosedReturnedAttempt(walletId, {
        network: "mainnet",
        transferId: intent.transferId,
        paymentRequest: intent.paymentRequest,
        paymentHash: intent.paymentHash,
        amountSats: intent.invoiceAmountSats,
        maxFeeSats: intent.maxFeeSats,
        receiverIdentityPublicKey: sender,
      })
    if (returned.status !== "closed_returned")
      throw new Error("Synthetic closure must attest")
    const target: CheckoutSparkSettledOutgoingTarget = {
      walletId,
      network: "mainnet",
      legId: leg.legId,
      recipientId: merchant.pubkey,
      allocationSats: leg.allocationSats!,
      unpaidAllocationSats: credit.creditedSats,
      intent,
    }
    const proof = proveCheckoutSparkSettledReturnedTransfer({
      plan,
      target,
      evidence: {
        ...returned.evidence,
        availableSats: credit.creditedSats,
        availableLeaves: [
          ...returned.evidence.returnedLeaves,
          {
            id: "synthetic-other-reserve",
            valueSats: credit.creditedSats - returned.evidence.returnedSats,
          },
        ],
      },
    })
    payout = invoice(leg.allocationSats! - 5, 74, now)
    intent = prepare(1, now)
    state = renewCheckoutSparkSettledLeg(state, {
      legId: leg.legId,
      intent,
      proof,
      nowMs: now,
    })
    await repository.saveRenewedWithInvoiceOrigin(state, revision++, {
      legId: leg.legId,
      origin: await origin(),
      proof,
      nowMs: now,
      now: () => now,
    })
  }
  control.registerPayout({ ...payout, feeSats: 4 })
  if (options.commercePaid !== false) {
    const paid = await manager.sendCheckoutLightningObligation(walletId, {
      network: "mainnet",
      transferId: intent.transferId,
      paymentRequest: intent.paymentRequest,
      amountSats: intent.invoiceAmountSats,
      maxFeeSats: 5,
    })
    if (paid.status !== "paid")
      throw new Error("Synthetic commerce must settle")
    state = recordCheckoutSparkSettledLegStatus(state, {
      legId: leg.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "paid",
      finalFeeSats: 4,
      finalDebitSats: intent.invoiceAmountSats + 4,
      observedAt: now + 1,
    })
    await repository.save(state, revision)
  }
  now += 20
  const order: OrderLifecycle = {
    orderId: plan.orderId,
    buyerPubkey: buyer.pubkey,
    buyerIdentityKind: "signed_in",
    merchantPubkey: merchant.pubkey,
    checkoutMode: "private_checkout",
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId,
    },
    items: [],
    itemSubtotalSats: 1000,
    shippingCostSats: 0,
    totalSats: 1000,
    totalMsats: 1_000_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    invoiceStatus: "received",
    paymentStatus: "paid",
    proofDeliveryStatus: "sent",
    zapReceiptStatus: "not_applicable",
    phase: "in_progress",
    createdAt: AT,
    updatedAt: now,
  }
  await database.orderLifecycles.put(order)
  await repository.bindBuyerOrder(plan, buyer.pubkey, () => {})
  const assertCurrent = () => {}
  const assertAuthority = async () => {}
  const proofInput = () => ({
    state,
    manager,
    repository,
    now: () => ++now,
    assertCurrent,
    assertAuthority,
  })
  const provider = () =>
    createBuyerCheckoutSparkNativeTreasuryProvider({
      checkoutId: plan.checkoutId,
      manager,
      repository,
      now: () => ++now,
      assertCurrent,
      assertAuthority,
    })
  const loadState = async () => {
    const saved = await repository.load(plan.checkoutId, plan.planDigest)
    if (saved.status !== "active") throw new Error("Expected active state")
    state = saved.state
    revision = saved.revision
    return saved
  }
  const acknowledgements: string[] = []
  const step = async (inspectionOnly = false) => {
    const result = await runCheckoutSparkNativeTreasuryStep({
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      legId: plan.recipients[1]!.legId,
      actor: options.closed ? "merchant" : "shopper",
      inspectionOnly,
      now: () => ++now,
      store: {
        load: repository.load.bind(repository),
        save: repository.save.bind(repository),
        savePrepared: repository.saveTreasuryPrepared.bind(repository),
      },
      provider: provider(),
      proveCommerce: (fresh) =>
        proveBuyerCheckoutSparkTreasuryCommerce({
          ...proofInput(),
          state: fresh,
        }),
      acknowledgeRecoverySnapshot: async (fresh) => {
        acknowledgements.push(fresh.treasuryFinalization!.status)
      },
    })
    await loadState()
    return result
  }
  return {
    database,
    repository,
    native,
    control,
    plan,
    receive,
    buyer,
    merchant,
    mnemonic,
    hooks,
    reads,
    acknowledgements,
    manager: () => manager,
    state: () => state,
    now: () => now,
    setNow: (value: number) => {
      now = value
    },
    proofInput,
    provider,
    step,
    loadState,
    async restart() {
      await manager.close(walletId)
      manager = new SparkWalletManager(
        makeFactory(),
        async () => ({ release: async () => {} }),
        undefined,
        () => now
      )
      await manager.openWithMnemonic({ walletId, mnemonic, accountNumber: 0 })
    },
    retire: () =>
      retireCheckoutSparkSettledShopper(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          orderId: plan.orderId,
          merchantPubkey: merchant.pubkey,
          network: "mainnet",
          buyerPubkey: buyer.pubkey,
          currentBuyerPubkey: () => buyer.pubkey,
          shouldContinue: () => true,
        },
        {
          repository,
          readOrder: (id) => database.orderLifecycles.get(id),
          sparkManager: () => manager,
          now: () => ++now,
        }
      ),
    async cleanup() {
      await manager.close(walletId)
      database.close()
      await database.delete()
    },
  }
}

async function run(
  test: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  options: Parameters<typeof fixture>[0] = {}
) {
  const f = await fixture(options)
  try {
    await test(f)
  } finally {
    await f.cleanup()
  }
}

describe("Market native treasury composed provider evidence", () => {
  it(
    "re-reads exact funding, invoice origin, winner and two complete scoped histories before preparing",
    async () =>
      run(async (f) => {
        const before = { ...f.reads }
        const record = await proveBuyerCheckoutSparkTreasuryCommerce(
          f.proofInput()
        )
        expect(record.credit!.transferId).toBe(f.state().credit!.transferId)
        expect(record.paidLegs[0]!.transferId).toBe(
          f.state().legs[0]!.intent!.transferId
        )
        expect(record.paidLegs[0]!.recipientVerified).toBe(true)
        expect(f.reads.credit).toBeGreaterThan(before.credit)
        expect(f.reads.winner).toBeGreaterThan(before.winner)
        expect(f.reads.history - before.history).toBe(2)
        expect(f.reads.cleaned - before.cleaned).toBe(1)
        expect(
          deriveCheckoutSparkNativeTreasuryBudget(f.state(), record)
            .unusedCommerceReserveSats
        ).toBe(1)
        expect(f.control.nativeSnapshot().nativePaymentCount).toBe(0)
      }),
    15_000
  )
  it.each([
    "funding",
    "winner",
    "origin",
    "recipient",
    "winner_debit",
    "incomplete",
    "unavailable",
    "unknown",
    "extra_deposit",
    "pending",
    "owned",
  ])("rejects fresh commerce evidence: %s", async (change) =>
    run(async (f) => {
      if (change === "funding") f.hooks.fundingMissing = true
      if (change === "winner") f.hooks.winnerMissing = true
      if (change === "origin")
        await f.database.checkoutSparkPlanBindings.update(f.plan.checkoutId, {
          invoiceOrigins: {},
        })
      if (change === "recipient")
        f.hooks.mutateSsp = (transfer) => {
          ;(transfer.userRequest as { encodedInvoice: string }).encodedInvoice =
            invoice(997, 99).paymentRequest
        }
      if (change === "winner_debit")
        f.hooks.mutateSsp = (transfer) => {
          transfer.totalAmount!.originalValue -= 1
        }
      if (change === "incomplete") f.hooks.incompleteHistory = true
      if (change === "unavailable") f.hooks.unavailableHistory = true
      if (change === "unknown")
        f.control.setExtraHistory([
          {
            id: "unknown-native-outgoing",
            type: 1,
            status: 5,
            network: 1,
            totalValue: 1,
          },
        ])
      if (change === "extra_deposit") f.control.addUnattributedAvailableSats(1)
      if (change === "pending")
        f.control.setPendingTransfers([
          {
            id: "pending-credit",
            type: 0,
            status: 1,
            network: 1,
            totalValue: 1,
          },
        ])
      if (change === "owned") f.control.setAdditionalOwnedSats(1)
      await expect(
        proveBuyerCheckoutSparkTreasuryCommerce(f.proofInput())
      ).rejects.toThrow()
      expect((await f.step()).reason).toBe("provider_evidence_unavailable")
      expect(f.state().treasuryFinalization!.intent).toBeNull()
      expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(0)
    })
  )
  it(
    "ACKs frozen prepared/submitted snapshots and performs exactly one native payment, then retires actual ID",
    async () =>
      run(async (f) => {
        const result = await f.step()
        expect(result.reason).toBeUndefined()
        expect(result.outcome).toBe("paid")
        expect(f.acknowledgements).toEqual(["prepared", "submitted", "paid"])
        const native = f.control.nativeSnapshot()
        expect(native.nativeSendInvocationCount).toBe(1)
        expect(native.nativePaymentCount).toBe(1)
        const actualId = native.transfers[0]!.id
        expect(actualId).not.toBe(f.plan.nativeTreasury!.invoiceId)
        expect(f.state().treasuryFinalization).toMatchObject({
          providerTransferId: actualId,
          finalFeeSats: 0,
          finalDebitSats: f.state().treasuryFinalization!.intent!.amountSats,
          status: "paid",
        })
        expect(f.state().legs[1]!.intent).toBeNull()
        expect(await f.manager().getFundsState(f.plan.walletId)).toMatchObject({
          availableSats: 0,
          ownedSats: 0,
          incomingSats: 0,
        })
        expect((await f.step()).outcome).toBe("already_paid")
        expect(await f.retire()).toEqual({ status: "retired" })
        const retired = await f.repository.loadBuyerSettlement(
          f.plan.checkoutId,
          f.plan.planDigest,
          f.buyer.pubkey
        )
        expect(retired.status).toBe("retired")
        if (retired.status !== "retired") throw new Error("Expected retirement")
        expect(retired.settlement.nativeTreasury).toMatchObject({
          providerTransferId: actualId,
          finalFeeSats: 0,
        })
        expect(
          await f.database.checkoutSparkReconciliations.get(f.plan.checkoutId)
        ).toBeUndefined()
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
      }),
    15_000
  )
  it(
    "does not treat FINALIZED or fulfill response as receiver completion, and recovers query-only after restart",
    async () =>
      run(async (f) => {
        f.control.setNativeCompletion(false)
        expect((await f.step()).outcome).toBe("wait")
        expect(f.state().treasuryFinalization!.status).toBe("ambiguous")
        expect(f.state().treasuryFinalization!.finalDebitSats).toBeNull()
        expect(await f.retire()).toEqual({ status: "retirement_pending" })
        await f.restart()
        expect((await f.step()).reason).toBe("prior_possible_send")
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
        f.control.setNativeCompletion(true)
        expect((await f.step(true)).outcome).toBe("paid")
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
        expect(await f.retire()).toEqual({ status: "retired" })
      }),
    15_000
  )
  it(
    "recovers a lost response through exact invoice/transfer history without a second native invocation",
    async () =>
      run(async (f) => {
        f.control.setNativeLostResponse(true)
        expect((await f.step()).outcome).toBe("paid")
        await f.restart()
        expect((await f.step(true)).outcome).toBe("already_paid")
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
      }),
    15_000
  )
  it(
    "never resends a durable possible-send after empty invoice lookup on a cold restart",
    async () =>
      run(async (f) => {
        let queries = 0
        f.hooks.beforeNativeQuery = () => {
          if (++queries >= 3) f.hooks.hideNativeQueries = true
        }
        f.control.setNativeLostResponse(true)
        expect((await f.step()).outcome).toBe("send_ambiguous")
        expect(f.state().treasuryFinalization!.status).toBe("submitted")
        expect(f.state().treasuryFinalization!.providerTransferId).toBeNull()
        await f.restart()
        expect((await f.step()).reason).toBe("prior_possible_send")
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
        f.hooks.beforeNativeQuery = undefined
        f.hooks.hideNativeQueries = false
        expect((await f.step(true)).outcome).toBe("paid")
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
      }),
    15_000
  )
  it.each(["funding", "origin", "winner"])(
    "does not persist a completed native receipt after restart when fresh %s proof is missing",
    async (change) =>
      run(async (f) => {
        f.control.setNativeCompletion(false)
        expect((await f.step()).reason).toBe("prior_possible_send")
        const nativeId = f.state().treasuryFinalization!.providerTransferId
        await f.restart()
        f.control.setNativeCompletion(true)
        let origins: unknown
        if (change === "funding") f.hooks.fundingMissing = true
        if (change === "winner") f.hooks.winnerMissing = true
        if (change === "origin") {
          const binding = await f.database.checkoutSparkPlanBindings.get(
            f.plan.checkoutId
          )
          origins = binding!.invoiceOrigins
          await f.database.checkoutSparkPlanBindings.update(f.plan.checkoutId, {
            invoiceOrigins: {},
          })
        }
        expect((await f.step(true)).reason).toBe(
          "provider_evidence_unavailable"
        )
        expect(f.state().treasuryFinalization!.status).toBe("ambiguous")
        expect(f.state().treasuryFinalization!.finalDebitSats).toBeNull()
        expect(
          (await f.repository.loadMerchantSettlement(
            f.merchant.pubkey,
            f.plan.checkoutId,
            f.plan.planDigest
          ))!.nativeTreasury
        ).toBeNull()
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
        f.hooks.fundingMissing = false
        f.hooks.winnerMissing = false
        if (change === "origin")
          await f.database.checkoutSparkPlanBindings.update(f.plan.checkoutId, {
            invoiceOrigins: origins,
          })
        expect((await f.step(true)).outcome).toBe("paid")
        expect(f.state().treasuryFinalization!.providerTransferId).toBe(
          nativeId
        )
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
      }),
    15_000
  )
  const foregroundScenarios = [
    "in_progress",
    "completed",
    "cancelled",
    "completed_commerce_unpaid",
    "completed_hidden",
    "completed_unmounted",
    "completed_changed_identity",
    "completed_wrong_order",
    "completed_changed_approval",
    "completed_closed_wallet",
    "completed_changed_plan",
  ] as const
  it.each(foregroundScenarios)(
    "the foreground route and buyer runner respect commerce-paid presentation: %s",
    async (scenario: (typeof foregroundScenarios)[number]) =>
      run(
        async (f) => {
          const phase =
            scenario === "in_progress"
              ? "in_progress"
              : scenario === "cancelled"
                ? "cancelled"
                : "completed"
          await f.database.orderLifecycles.update(f.plan.orderId, { phase })
          const previousAddress =
            process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
          process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = ADDRESS
          try {
            const clock = () => {
              f.setNow(f.now() + 1)
              return f.now()
            }
            const initial = createCheckoutSparkSettledRecoveryPayload({
              state: f.state(),
              senderPubkey: f.buyer.pubkey,
              mnemonic: f.mnemonic,
              accountNumber: 0,
              preparedAt: clock(),
            })
            let record: CheckoutSparkRecoveryDeliveryRecord | undefined
            const relays = ["wss://relay.conduit.market"]
            const delivered = await publishCheckoutSparkRecovery({
              payload: initial,
              signer: f.buyer,
              persistExactWrap: async (saved) => {
                record = saved
              },
              transport: {
                recipientInboxRelays: relays,
                publishFn: async () => ({
                  attemptedRelayUrls: relays,
                  successfulRelayUrls: relays,
                  failedRelayUrls: [],
                  relayFailureMessages: {},
                }),
              },
            })
            if (!record) throw new Error("Expected initial recovery")
            const exactRecord = record
            const runner = createCheckoutSparkSettledShopperRunner({
              repository: f.repository,
              readOrder: (id) => f.database.orderLifecycles.get(id),
              readPreparation: () => ({
                schemaVersion: 3,
                checkoutId: f.plan.checkoutId,
                planDigest: f.plan.planDigest,
                recoveryHandoffId: initial.handoffId,
                fundingInvoiceExposedAt: AT,
                fundingSubmissionState: "provisional",
                savedAt: AT,
              }),
              readInitialRecovery: () => ({
                record: exactRecord,
                deliveryProgress: delivered.deliveryProgress,
                savedAt: AT,
              }),
              loadAuthorized: async () => ({
                plan: f.plan,
                state: f.state(),
                fundingReceive: f.receive,
                fundingInvoice: f.receive.paymentRequest,
                recoveryHandoffId: initial.handoffId,
              }),
              sparkConfiguration: () => ({
                status: "ready",
                network: "mainnet",
              }),
              sparkManager: () => f.manager(),
              now: clock,
              wait: async () => {},
            })
            const acknowledged: string[] = []
            const routeView: CheckoutSparkSettledRouteSession["view"] = {
              orderId: f.plan.orderId,
              phase,
              merchantStatus: null,
              checkoutSparkRouted: true,
            }
            const routeSession = {
              enabled: true,
              mounted: true,
              visible: true,
              actionsReady: true,
              identityCurrent: true,
              orderId: f.plan.orderId,
              view: routeView,
            }
            let routeApprovalGeneration = 0
            const approvalGeneration = routeApprovalGeneration
            if (scenario === "completed_hidden") routeSession.visible = false
            if (scenario === "completed_unmounted") routeSession.mounted = false
            if (scenario === "completed_changed_identity")
              routeSession.identityCurrent = false
            if (scenario === "completed_wrong_order")
              routeSession.view.orderId = "another-order"
            if (scenario === "completed_changed_approval")
              routeApprovalGeneration += 1
            if (scenario === "completed_closed_wallet")
              await f.manager().close(f.plan.walletId)
            const approvedSessionIsCurrent = () =>
              approvalGeneration === routeApprovalGeneration &&
              canContinueCheckoutSparkSettledRouteSession(routeSession)
            const input = {
              checkoutId: f.plan.checkoutId,
              planDigest: f.plan.planDigest,
              orderId: f.plan.orderId,
              merchantPubkey: f.merchant.pubkey,
              network: "mainnet" as const,
              buyerPubkey: f.buyer.pubkey,
              currentBuyerPubkey: () => f.buyer.pubkey,
              shouldContinue: approvedSessionIsCurrent,
              fundingPayment: {
                buyerPubkey: f.buyer.pubkey,
                shouldContinue: approvedSessionIsCurrent,
                paymentTarget: { type: "manual" as const },
                timeoutMs: 1000,
                appId: "market" as const,
              },
              acknowledgeRecoverySnapshot: async (
                state: ReturnType<typeof f.state>
              ) => {
                acknowledged.push(state.treasuryFinalization!.status)
                if (
                  scenario === "in_progress" &&
                  state.treasuryFinalization!.status === "prepared"
                ) {
                  routeView.phase = "completed"
                  await f.database.orderLifecycles.update(f.plan.orderId, {
                    phase: "completed",
                  })
                }
              },
              authorization: {
                planDigest: f.plan.planDigest,
                walletId: f.plan.walletId,
                grossFundingSats: f.plan.funding.grossFundingSats,
              },
              fundingMode: "inspect" as const,
            }
            if (scenario === "completed_changed_plan")
              input.authorization.planDigest = "different-plan"
            if (!approvedSessionIsCurrent()) {
              const result = await runner.run(input)
              expect(result).toEqual({
                status: "paused",
                reason: "paused",
              })
              expect(getCheckoutSparkSettledOutcomeMessage(result)).toContain(
                "active buyer session stopped"
              )
              expect(getCheckoutSparkSettledOutcomeMessage(result)).toContain(
                "do not pay again"
              )
              expect(acknowledged).toEqual([])
              expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(
                0
              )
              return
            }
            if (
              scenario === "completed_commerce_unpaid" ||
              scenario === "completed_closed_wallet" ||
              scenario === "completed_changed_plan"
            ) {
              expect(approvedSessionIsCurrent()).toBe(true)
              expect(await runner.run(input)).toEqual({
                status: "paused",
                reason: "authorization_changed",
              })
              expect(acknowledged).toEqual([])
              expect(f.control.snapshot().sendInvocationCount).toBe(
                scenario === "completed_commerce_unpaid" ? 0 : 1
              )
              expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(
                0
              )
              return
            }
            expect(await runner.run(input)).toEqual({ status: "complete" })
            await f.loadState()
            expect(acknowledged).toEqual(["prepared", "submitted", "paid"])
            expect(f.state().treasuryFinalization!.status).toBe("paid")
            expect(await runner.run(input)).toEqual({ status: "complete" })
            expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
            expect(f.control.snapshot().sendInvocationCount).toBe(1)
            routeApprovalGeneration += 1
            expect(await runner.run(input)).toEqual({
              status: "paused",
              reason: "paused",
            })
            expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
          } finally {
            if (previousAddress === undefined)
              delete process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS
            else
              process.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS = previousAddress
          }
        },
        { commercePaid: scenario !== "completed_commerce_unpaid" }
      ),
    15_000
  )
  it(
    "vetoes a new unknown transfer at the final guarded provider boundary",
    async () =>
      run(async (f) => {
        let queries = 0
        f.hooks.beforeNativeQuery = () => {
          if (++queries === 2)
            f.control.setExtraHistory([
              {
                id: "last-moment-unknown",
                type: 1,
                status: 5,
                network: 1,
                totalValue: 1,
              },
            ])
        }
        expect((await f.step()).reason).toBe("terminal_failure")
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(0)
      }),
    15_000
  )
  // Each case composes signed recovery, two payments and retirement inspection.
  // Bound the test harness separately from unchanged provider deadlines.
  it.each(["owned", "pending", "unknown", "incomplete"])(
    "cannot retire a paid native transfer with unsafe reader evidence: %s",
    async (change) =>
      run(async (f) => {
        expect((await f.step()).outcome).toBe("paid")
        if (change === "owned") f.control.setAdditionalOwnedSats(1)
        if (change === "pending")
          f.control.setPendingTransfers([
            {
              id: "pending-after-native",
              type: 1,
              status: 1,
              network: 1,
              totalValue: 1,
            },
          ])
        if (change === "unknown")
          f.control.setExtraHistory([
            {
              id: "unknown-after-native",
              type: 1,
              status: 5,
              network: 1,
              totalValue: 1,
            },
          ])
        if (change === "incomplete") f.hooks.incompleteHistory = true
        expect(await f.retire()).toEqual({ status: "retirement_pending" })
        expect(
          (await f.repository.load(f.plan.checkoutId, f.plan.planDigest)).status
        ).toBe("active")
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
      }),
    15_000
  )
  it(
    "includes exact old returned IDs after successor spending, without requiring still-available returned leaves",
    async () =>
      run(
        async (f) => {
          const inspected = await inspectBuyerCheckoutSparkTreasuryCommerce(
            f.proofInput()
          )
          expect(inspected.closedReturnedProofs).toHaveLength(1)
          expect(inspected.expectedTransferIds).toEqual([
            f.state().credit!.transferId,
            f.state().legs[0]!.intent!.transferId,
          ])
          expect((await f.step()).outcome).toBe("paid")
          const before = f.reads.closed
          expect(await f.retire()).toEqual({ status: "unavailable" })
          const fresh = await inspectBuyerCheckoutSparkTreasuryCommerce(
            f.proofInput()
          )
          const reader = await f
            .manager()
            .openCheckoutRetirementReader(f.plan.walletId, {
              network: "mainnet",
              receiverIdentityPublicKey:
                f.plan.funding.receiverIdentityPublicKey,
            })
          try {
            const saved = await f.loadState()
            const evidence = await collectCheckoutSparkNativeRetirementEvidence(
              {
                authenticatedReader: reader.reader,
                sparkAddress: reader.sparkAddress,
                walletId: f.plan.walletId,
                network: "mainnet",
                stateUpdatedAt: saved.state.updatedAt,
                expectedTransferIds: [
                  ...fresh.expectedTransferIds,
                  saved.state.treasuryFinalization!.providerTransferId!,
                ],
                closedReturnedProofs: fresh.closedReturnedProofs,
                requireExactHistoryScope: true,
                now: () => f.now() + 1,
              }
            )
            expect(evidence).not.toBeNull()
            if (!evidence) throw new Error("Expected exact zero-owned closure")
            await f.repository.retire({
              checkoutId: f.plan.checkoutId,
              planDigest: f.plan.planDigest,
              expectedRevision: saved.revision,
              evidence,
            })
            expect(
              (
                await f.repository.loadBuyerSettlement(
                  f.plan.checkoutId,
                  f.plan.planDigest,
                  f.buyer.pubkey
                )
              ).status
            ).toBe("retired")
          } finally {
            await reader.cleanup()
          }
          expect(f.reads.closed).toBeGreaterThan(before)
          expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(1)
        },
        { closed: true }
      ),
    15_000
  )
  it(
    "round-trips v4/state5 recovery and merchant progress without promoting progress into provider authority",
    async () =>
      run(async (f) => {
        const payload = createCheckoutSparkSettledRecoveryPayload({
          state: f.state(),
          senderPubkey: f.buyer.pubkey,
          mnemonic: f.mnemonic,
          accountNumber: 0,
          preparedAt: f.now(),
        })
        let record: CheckoutSparkRecoveryDeliveryRecord | undefined
        const relays = ["wss://relay.conduit.market"]
        await publishCheckoutSparkRecovery({
          payload,
          signer: f.buyer,
          persistExactWrap: async (saved) => {
            record = saved
          },
          transport: {
            recipientInboxRelays: relays,
            publishFn: async () => ({
              attemptedRelayUrls: relays,
              successfulRelayUrls: relays,
              failedRelayUrls: [],
              relayFailureMessages: {},
            }),
          },
        })
        if (!record) throw new Error("Expected exact wrap")
        const opened = await openCheckoutSparkRecoveryDelivery({
          record,
          signer: f.merchant,
        })
        expect(opened.schemaVersion).toBe(2)
        if (opened.schemaVersion !== 2)
          throw new Error("Expected settled payload")
        expect(opened.plan.schemaVersion).toBe(4)
        expect(opened.state.schemaVersion).toBe(5)
        expect(opened.plan.nativeTreasury).toEqual(f.plan.nativeTreasury)
        expect(opened.state).toEqual(f.state())
        expect((await f.step()).outcome).toBe("paid")
        const paid = f.state()
        const postHandoff = recordCheckoutSparkNativeTreasuryStatus(paid, {
          invoiceId: f.plan.nativeTreasury!.invoiceId,
          providerTransferId: paid.treasuryFinalization!.providerTransferId!,
          status: "paid",
          observedAt: f.plan.takeoverAt,
          finalFeeSats: 0,
          finalDebitSats: paid.treasuryFinalization!.finalDebitSats!,
        })
        const progress = createCheckoutSparkMerchantProgress({
          initialHandoffId: payload.handoffId,
          state: postHandoff,
        })
        expect(progress.schemaVersion).toBe(3)
        expect(
          parseCheckoutSparkMerchantProgress(structuredClone(progress))
        ).toEqual(progress)
        expect(
          parseCheckoutSparkMerchantProgressRumor(
            buildCheckoutSparkMerchantProgressRumor(progress)
          )
        ).toEqual(progress)
        expect(JSON.stringify(progress)).not.toContain(f.mnemonic)
        f.hooks.fundingMissing = true
        await expect(
          inspectBuyerCheckoutSparkTreasuryCommerce({
            ...f.proofInput(),
            state: progress.state,
          })
        ).rejects.toThrow()
      }),
    15_000
  )
  it.each(["submitted", "ambiguous"] as const)(
    "the exported provider cannot directly re-admit restored %s progress",
    async (status) =>
      run(async (f) => {
        const settlement = await proveBuyerCheckoutSparkTreasuryCommerce(
          f.proofInput()
        )
        const saved = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        if (saved.status !== "active") throw new Error("Expected active")
        const prepared = prepareCheckoutSparkNativeTreasury(saved.state, {
          settlement,
          preparedAt: f.now(),
        })
        const admitted = await f.repository.saveTreasuryPrepared(
          prepared,
          saved.revision,
          settlement
        )
        if (admitted.status !== "active") throw new Error("Expected active")
        const restored = recordCheckoutSparkNativeTreasuryStatus(prepared, {
          invoiceId: f.plan.nativeTreasury!.invoiceId,
          status,
          observedAt: f.now() + 1,
        })
        await f.repository.save(restored, admitted.revision)
        await f.loadState()
        await f.restart()
        const target: CheckoutSparkNativeTreasuryTarget = {
          walletId: f.plan.walletId,
          network: "mainnet",
          planDigest: f.plan.planDigest,
          legId: f.plan.recipients[1]!.legId,
          nativeTreasury: f.plan.nativeTreasury!,
          intent: f.state().treasuryFinalization!.intent!,
        }
        const provider = f.provider()
        expect(await provider.reconcile(target)).toEqual({
          invoiceId: target.intent.invoiceId,
          status: "not_found",
        })
        expect(await provider.preflight(target)).toBe("unavailable")
        await expect(provider.send(target)).rejects.toThrow("not admitted")
        await expect(provider.send(target)).rejects.toThrow("not admitted")
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(0)
        expect(f.control.nativeSnapshot().nativePaymentCount).toBe(0)
        expect(await f.manager().getFundsState(f.plan.walletId)).toMatchObject({
          availableSats: target.intent.authorizedDebitSats,
          ownedSats: target.intent.authorizedDebitSats,
          incomingSats: 0,
        })
        expect((await f.loadState()).state.treasuryFinalization!.status).toBe(
          status
        )
      }),
    15_000
  )
  it.each(["amount", "invoice", "network", "leg"])(
    "binds the exported provider to its exact saved target: %s",
    async (change) =>
      run(async (f) => {
        const settlement = await proveBuyerCheckoutSparkTreasuryCommerce(
          f.proofInput()
        )
        const saved = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        if (saved.status !== "active") throw new Error("Expected active")
        const prepared = prepareCheckoutSparkNativeTreasury(saved.state, {
          settlement,
          preparedAt: f.now(),
        })
        await f.repository.saveTreasuryPrepared(
          prepared,
          saved.revision,
          settlement
        )
        await f.loadState()
        const target: CheckoutSparkNativeTreasuryTarget = {
          walletId: f.plan.walletId,
          network: "mainnet",
          planDigest: f.plan.planDigest,
          legId: f.plan.recipients[1]!.legId,
          nativeTreasury: f.plan.nativeTreasury!,
          intent: f.state().treasuryFinalization!.intent!,
        }
        const changed = structuredClone(target)
        if (change === "amount")
          changed.intent = {
            ...changed.intent,
            amountSats: changed.intent.amountSats - 1,
            authorizedDebitSats: changed.intent.authorizedDebitSats - 1,
          }
        if (change === "invoice")
          changed.nativeTreasury = {
            ...changed.nativeTreasury,
            invoiceId: crypto.randomUUID(),
          }
        if (change === "network") changed.network = "regtest"
        if (change === "leg") changed.legId = f.plan.recipients[0]!.legId
        await expect(f.provider().preflight(changed)).rejects.toThrow()
        expect(f.control.nativeSnapshot().nativeSendInvocationCount).toBe(0)
      })
  )
})

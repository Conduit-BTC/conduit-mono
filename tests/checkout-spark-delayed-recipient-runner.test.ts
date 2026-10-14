import { expect, it, spyOn } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  DexieCheckoutSparkSettledRepository,
  config,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  projectCheckoutSparkMerchantSettlement,
  recordCheckoutSparkSettledCredit,
  resolveCheckoutSparkLnurlInvoice,
  type CheckoutSparkSettledOutgoingObservation,
  type OrderLifecycle,
} from "@conduit/core"
import {
  getCheckoutSparkSettledPreparation,
  saveCheckoutSparkSettledPreparation,
  type PreparedCheckoutSparkSettledFunding,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  createCheckoutSparkSettledShopperRunner,
  type CheckoutSparkSettledShopperRunnerDependencies,
} from "../apps/market/src/lib/checkout-spark-settled-shopper-runner"
import {
  qualifiedReceiverFixture,
  qualifiedReceiverInvoiceFixture,
} from "./support/checkout-spark-qualified-receiver-fixture"

const NOW = 1_800_000_000_000
const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)

it("automatically rechecks delayed receiver settlement for the same SDK-paid intent without another send", async () => {
  const receiver = qualifiedReceiverFixture({
    lud16: "merchant@receiver.conduit.cash",
    amountSats: 995,
  })
  const funding = qualifiedReceiverFixture({ amountSats: 1_113 })
  const fundingInvoice = qualifiedReceiverInvoiceFixture({
    lud16: funding.lud16,
    amountSats: 1_113,
    paymentHash: funding.paymentHash,
    createdAt: NOW / 1_000,
    expiresSeconds: 900,
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "delayed-recipient-checkout",
    orderId: "delayed-recipient-order",
    merchantPubkey: MERCHANT,
    walletId: "delayed-recipient-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:fixture`,
          productEventId: "d".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "delayed-recipient-receive",
      paymentRequest: fundingInvoice,
      paymentHash: funding.paymentHash,
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: NOW,
      expiresAt: NOW + 900_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        weightSats: 1_000,
        destination: {
          type: "lightning_address",
          value: receiver.lud16,
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
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
  const database = new ConduitDB(`delayed-receiver-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const repository = new DexieCheckoutSparkSettledRepository(database)
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const previousContracts = config.checkoutSparkReceiverContracts
  let clock = NOW + 1_000
  let active = true
  let sdkPaid = false
  let receiverSettled = false
  let sends = 0
  let waits = 0
  let receiverReads = 0
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const requested = String(url)
    if (requested === receiver.metadata.payRequestUrl) {
      return Response.json(receiver.metadata)
    }
    if (requested === receiver.receiverBinding.verifyUrl) {
      receiverReads += 1
      expect(sdkPaid).toBe(true)
      return Response.json(receiver.verifier(receiverSettled))
    }
    throw new Error("Unexpected synthetic receiver transport")
  })
  try {
    // Only the HTTP/provider/configuration boundaries are synthetic. The runner,
    // one-step engine, credit workflow and local durable proof writes are real.
    config.checkoutSparkReceiverContracts = JSON.stringify(receiver.contracts)
    await repository.create(plan)
    const proof = {
      mode: "ordinary_v3" as const,
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "delayed-recipient-credit",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
    }
    await repository.recordMerchantCredit(plan, proof, NOW + 1)
    const credited = recordCheckoutSparkSettledCredit(
      createCheckoutSparkSettledReconciliation(plan),
      { ...proof, observedAt: NOW + 1 }
    )
    const credit = await repository.save(credited, 1)
    if (credit.status !== "active") throw new Error("Fixture unavailable")
    const merchantLeg = plan.recipients[0]!
    const issued = await resolveCheckoutSparkLnurlInvoice(
      {
        lud16: receiver.lud16,
        amountSats: 995,
        network: "mainnet",
        receiverMode: "private",
        nowSeconds: NOW / 1_000,
        shouldContinue: () => active,
      },
      {
        receiverContracts: receiver.contracts,
        fetchMetadata: async () => receiver.metadata,
        fetchInvoice: async () => ({
          invoice: receiver.paymentRequest,
          verifyUrl: receiver.receiverBinding.verifyUrl,
        }),
        fetchReceiverVerify: async () => receiver.verifier(false),
      }
    )
    const prepared = prepareCheckoutSparkSettledLeg(credited, {
      legId: merchantLeg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, merchantLeg.legId),
      paymentRequest: issued.paymentRequest,
      paymentHash: issued.paymentHash,
      invoiceAmountSats: 995,
      maxFeeSats: 5,
      preparedAt: NOW + 500,
      receiverBinding: issued.receiverBinding,
    })
    await repository.savePreparedWithInvoiceOrigin(prepared, credit.revision, {
      legId: merchantLeg.legId,
      origin: issued.origin,
    })
    saveCheckoutSparkSettledPreparation(
      {
        schemaVersion: 3,
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        recoveryHandoffId: "delayed-recipient-handoff",
        fundingInvoiceExposedAt: NOW + 1,
        fundingSubmissionState: "provisional",
        savedAt: NOW + 1,
      },
      storage
    )
    const lifecycle = {
      orderId: plan.orderId,
      merchantPubkey: MERCHANT,
      buyerPubkey: BUYER,
      buyerIdentityKind: "signed_in",
      orderDeliveryStatus: "sent",
      phase: "placed",
      paymentStatus: "unpaid",
      currency: "SATS",
      totalSats: 1_000,
      checkoutSparkRouterBinding: {
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        walletId: plan.walletId,
      },
    } as OrderLifecycle
    const dependencies = {
      repository,
      now: () => clock,
      readOrder: async () => lifecycle,
      readPreparation: (id: string) =>
        getCheckoutSparkSettledPreparation(id, storage),
      readInitialRecovery: () =>
        ({
          record: { senderPubkey: BUYER },
          deliveryProgress: { acknowledgedRelayRefs: ["fixture-relay"] },
        }) as ReturnType<
          NonNullable<
            CheckoutSparkSettledShopperRunnerDependencies["readInitialRecovery"]
          >
        >,
      loadAuthorized: async () => {
        const saved = await repository.load(plan.checkoutId, plan.planDigest)
        if (saved.status !== "active") throw new Error("Fixture unavailable")
        return {
          plan,
          state: saved.state,
          fundingInvoice: plan.funding.paymentRequest,
          recoveryHandoffId: "delayed-recipient-handoff",
        } as PreparedCheckoutSparkSettledFunding
      },
      sparkConfiguration: () => ({ status: "ready", network: "mainnet" }),
      sparkManager: () =>
        ({ isOpen: () => true }) as ReturnType<
          NonNullable<
            CheckoutSparkSettledShopperRunnerDependencies["sparkManager"]
          >
        >,
      outgoingProvider: ({ assertBeforeSend }) => {
        const observe = (target: Parameters<typeof assertBeforeSend>[0]) =>
          ({
            legId: target.legId,
            transferId: target.intent.transferId,
            paymentRequest: target.intent.paymentRequest,
            paymentHash: target.intent.paymentHash,
            invoiceAmountSats: target.intent.invoiceAmountSats,
            maxFeeSats: target.intent.maxFeeSats,
            status: sdkPaid ? "paid" : "not_found",
            ...(sdkPaid ? { finalFeeSats: 1, finalDebitSats: 996 } : {}),
          }) as CheckoutSparkSettledOutgoingObservation
        return {
          reconcile: async (target) => observe(target),
          preflight: async (target) => {
            await assertBeforeSend(target)
            return "ready" as const
          },
          send: async (target) => {
            await assertBeforeSend(target)
            sends += 1
            sdkPaid = true
            return observe(target)
          },
        }
      },
      wait: async (milliseconds: number) => {
        waits += 1
        expect(sends).toBe(1)
        expect(receiverSettled).toBe(false)
        clock += milliseconds
        receiverSettled = true
      },
    } satisfies CheckoutSparkSettledShopperRunnerDependencies
    const runner = createCheckoutSparkSettledShopperRunner(dependencies)
    const result = await runner.run({
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      orderId: plan.orderId,
      merchantPubkey: MERCHANT,
      network: "mainnet",
      buyerPubkey: BUYER,
      currentBuyerPubkey: () => BUYER,
      shouldContinue: () => active,
      authorization: {
        planDigest: plan.planDigest,
        walletId: plan.walletId,
        grossFundingSats: 1_113,
      },
      fundingMode: "inspect",
      fundingPoll: { attempts: 3, intervalMs: 2_000 },
      fundingPayment: {
        buyerPubkey: BUYER,
        shouldContinue: () => active,
        paymentTarget: { type: "manual" },
        inspectionOnly: true,
        timeoutMs: 60_000,
        appId: "market",
      },
      acknowledgeRecoverySnapshot: async () => {},
      onProgress: (progress) => {
        // End this focused test once the commerce leg is positively paid. The
        // remaining fee leg is not exercised or silently dispatched here.
        if (progress.paidLegs === 1) active = false
      },
    })
    expect(result).toEqual({ status: "paused", reason: "paused" })
    expect(waits).toBe(1)
    expect(sends).toBe(1)
    expect(receiverReads).toBe(2)
    const saved = await repository.load(plan.checkoutId, plan.planDigest)
    expect(saved.status === "active" && saved.state.legs[0]!.status).toBe(
      "paid"
    )
    expect(saved.status === "active" && saved.state.legs[1]!.status).toBe(
      "unprepared"
    )
    const receipt = await repository.loadMerchantSettlement(
      MERCHANT,
      plan.checkoutId,
      plan.planDigest
    )
    expect(
      projectCheckoutSparkMerchantSettlement(receipt!).merchantVerified
    ).toBe(true)
  } finally {
    fetch.mockRestore()
    config.checkoutSparkReceiverContracts = previousContracts
    database.close()
    await database.delete()
  }
})

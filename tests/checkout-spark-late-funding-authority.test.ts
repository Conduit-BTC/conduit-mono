import { expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  DexieCheckoutSparkSettledRepository,
  freezeCheckoutSparkSettledPlan,
  type OrderLifecycle,
} from "@conduit/core"
import {
  assessCheckoutSparkSettledOrderControl,
  matchesCheckoutSparkSettledOrderControl,
} from "../apps/market/src/lib/checkout-spark-settled-order-control"
import { createCheckoutSparkSettledFundingBridge } from "../apps/market/src/lib/checkout-spark-settled-funding"
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
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const RECEIVER = `02${"c".repeat(64)}`

it.each([
  "merchant_takeover",
  "approval_mismatch",
  "history_unavailable",
] as const)(
  "keeps late funding and payout authority distinct for %s",
  async (scenario) => {
    const invoice = makeSignedBolt11Fixture({
      hrp: "lnbc11130n",
      createdAt: NOW / 1_000,
      fields: [
        bolt11PaymentHashField(new Uint8Array(32).fill(3)),
        bolt11PaymentSecretField(),
        bolt11PlainDescriptionField(),
        { tag: "x", words: [28, 4] },
      ],
    })
    const plan = freezeCheckoutSparkSettledPlan({
      checkoutId: "late-funding-checkout",
      orderId: "late-funding-order",
      merchantPubkey: MERCHANT,
      walletId: "late-funding-wallet",
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
        requestId: "late-funding-receive",
        paymentRequest: invoice,
        paymentHash: "03".repeat(32),
        receiverIdentityPublicKey: RECEIVER,
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
            value: "merchant@example.test",
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
    const database = new ConduitDB(`late-funding-${crypto.randomUUID()}`, {
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
    let time = NOW + 1_000
    let providerPaid = false
    let payerCalls = 0
    let payoutCalls = 0
    const loadAuthorized: NonNullable<
      CheckoutSparkSettledShopperRunnerDependencies["loadAuthorized"]
    > = async () => {
      const snapshot = await repository.load(plan.checkoutId, plan.planDigest)
      if (snapshot.status !== "active") throw new Error("Fixture unavailable")
      return {
        plan,
        state: snapshot.state,
        fundingInvoice: invoice,
        recoveryHandoffId: "late-funding-handoff",
        fundingReceive: {
          id: plan.funding.requestId,
          walletId: plan.walletId,
          network: plan.network,
          paymentRequest: invoice,
          paymentHash: plan.funding.paymentHash,
          providerStatus: "PERSISTED",
          requiredNetSats: 1_113,
          grossFundingSats: 1_113,
          expirySecs: 900,
          createdAt: NOW,
          expiresAt: plan.funding.expiresAt,
          receiveSettledPolicy: "ordinary-exact-credit-v3",
          receiverIdentityPublicKey: RECEIVER,
        },
      } satisfies PreparedCheckoutSparkSettledFunding
    }
    try {
      await repository.create(plan)
      saveCheckoutSparkSettledPreparation(
        {
          schemaVersion: 3,
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          recoveryHandoffId: "late-funding-handoff",
          fundingInvoiceExposedAt: time,
          fundingSubmissionState: "not_started",
          savedAt: time,
        },
        storage
      )
      const assess = async () =>
        assessCheckoutSparkSettledOrderControl({
          lifecycle,
          preparation: getCheckoutSparkSettledPreparation(
            plan.checkoutId,
            storage
          ),
          snapshot: await repository.load(plan.checkoutId, plan.planDigest),
          buyerPubkey: BUYER,
          initialRecoverySenderPubkey: BUYER,
          initialRecoveryAcked: true,
          routerWalletOpen: true,
          now: time,
        })
      const displayed = await assess()
      time = plan.takeoverAt + 1
      const current = await assess()
      expect(current.status).toBe("pay_funding")
      expect(
        matchesCheckoutSparkSettledOrderControl({
          displayed,
          current,
          bindingPlanDigest: plan.planDigest,
        })
      ).toBe(true)
      const dependencies = {
        repository,
        now: () => time,
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
        loadAuthorized,
        sparkConfiguration: () => ({ status: "ready", network: "mainnet" }),
        sparkManager: () =>
          ({ isOpen: () => true }) as ReturnType<
            NonNullable<
              CheckoutSparkSettledShopperRunnerDependencies["sparkManager"]
            >
          >,
        fundingBridge: (id: string) =>
          createCheckoutSparkSettledFundingBridge(id, {
            repository,
            storage,
            loadAuthorized,
            now: () => time,
            verifyBuyerAuthority: () => true,
            requireCrossTabLock: false,
            withStoreWriteLock: async (operation) => operation(),
            attestCredit: async () => {
              if (scenario === "history_unavailable") {
                throw new Error("Synthetic exact receive history unavailable")
              }
              return providerPaid
                ? {
                    mode: "ordinary_v3",
                    requestId: plan.funding.requestId,
                    transferId: "late-funding-transfer",
                    receiverIdentityPublicKey: RECEIVER,
                    grossSats: 1_113,
                    creditedSats: 1_113,
                  }
                : null
            },
            payInvoice: async (request) => {
              expect(request.invoice).toBe(invoice)
              await request.beforeSend?.()
              payerCalls += 1
              providerPaid = true
              return { status: "paid", rail: "webln", preimage: "f".repeat(64) }
            },
          }),
        outgoingStep: async () => {
          payoutCalls += 1
          throw new Error("Late shopper must not initiate payouts")
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
        shouldContinue: () => true,
        authorization: {
          planDigest: plan.planDigest,
          walletId:
            scenario === "approval_mismatch"
              ? "different-approved-wallet"
              : plan.walletId,
          grossFundingSats: 1_113,
        },
        fundingMode: "pay_once",
        fundingPoll: { attempts: 1, intervalMs: 1 },
        fundingPayment: {
          buyerPubkey: BUYER,
          shouldContinue: () => true,
          paymentTarget: { type: "webln" },
          timeoutMs: 60_000,
          appId: "market",
        },
        acknowledgeRecoverySnapshot: async () => {},
      })
      expect(payerCalls).toBe(scenario === "merchant_takeover" ? 1 : 0)
      expect(payoutCalls).toBe(0)
      const snapshot = await repository.load(plan.checkoutId, plan.planDigest)
      expect(snapshot.status).toBe("active")
      if (snapshot.status !== "active") throw new Error("Fixture unavailable")
      expect(snapshot.state.credit?.transferId).toBe(
        scenario === "merchant_takeover" ? "late-funding-transfer" : undefined
      )
      expect(
        snapshot.state.legs.every((leg) => leg.status === "unprepared")
      ).toBe(true)
      if (scenario === "merchant_takeover") {
        expect(await assess()).toMatchObject({
          status: "blocked",
          cause: "authority_transferred",
        })
      }
      expect(result).toEqual(
        scenario === "history_unavailable"
          ? { status: "funding_pending" }
          : {
              status: "paused",
              reason:
                scenario === "merchant_takeover"
                  ? "authority_transferred"
                  : "authorization_changed",
            }
      )
    } finally {
      database.close()
      await database.delete()
    }
  }
)

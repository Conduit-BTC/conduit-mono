import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"

import {
  applyCheckoutSparkEvidence,
  createCheckoutSparkReconciliation,
  DexieCheckoutSparkRepository,
  freezeCheckoutSparkPlan,
  type CheckoutSparkOutgoingObservation,
  type CheckoutSparkOutgoingProvider,
  type CheckoutSparkOutgoingTarget,
  type CheckoutSparkPlan,
  type OrderLifecycle,
} from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"

import { advanceCheckoutSparkShopper } from "../apps/market/src/lib/checkout-spark-shopper-advance"
import type { StoredCheckoutSparkRouterPreparation } from "../apps/market/src/lib/checkout-spark-router-preparation"
import type { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const CREATED_AT = 1_800_000_000_000
const BUYER = "b".repeat(64)
const MERCHANT = "a".repeat(64)

function invoice(amountSats: number, hashByte: number): string {
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

function plan(): CheckoutSparkPlan {
  return freezeCheckoutSparkPlan({
    checkoutId: "checkout-shopper-1",
    orderId: "order-shopper-1",
    merchantPubkey: MERCHANT,
    walletId: "spark-wallet-1",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    funding: {
      requestId: "spark-receive-1",
      paymentRequest: "lnbc-router-funding",
      paymentHash: "c".repeat(64),
      requiredNetSats: 1_235,
      grossFundingSats: 1_240,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 600_000,
    },
    obligations: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        paymentRequest: invoice(1_000, 1),
        amountSats: 1_000,
        maxFeeSats: 100,
      },
      {
        kind: "conduit",
        recipientId: "conduit-test-recipient",
        paymentRequest: invoice(111, 2),
        amountSats: 111,
        maxFeeSats: 24,
      },
    ],
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:shopper-fixture`,
          productEventId: "d".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
  })
}

function preparation(
  frozen: CheckoutSparkPlan
): StoredCheckoutSparkRouterPreparation {
  return {
    schemaVersion: 1,
    reconciliation: createCheckoutSparkReconciliation(frozen),
    fundingReceive: {
      walletId: frozen.walletId,
      network: frozen.network,
      id: frozen.funding.requestId,
      paymentRequest: frozen.funding.paymentRequest,
      paymentHash: frozen.funding.paymentHash,
      providerStatus: "PENDING",
      requiredNetSats: frozen.funding.requiredNetSats,
      grossFundingSats: frozen.funding.grossFundingSats,
      expirySecs: 600,
      createdAt: frozen.funding.createdAt,
      expiresAt: frozen.funding.expiresAt,
    },
    recoveryHandoffId: "recovery-handoff-1",
    fundingInvoiceExposedAt: CREATED_AT,
    fundingSubmissionState: "not_started",
    savedAt: CREATED_AT,
  }
}

function lifecycle(frozen: CheckoutSparkPlan): OrderLifecycle {
  return {
    orderId: frozen.orderId,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    merchantPubkey: frozen.merchantPubkey,
    checkoutSparkRouterBinding: {
      checkoutId: frozen.checkoutId,
      planDigest: frozen.planDigest,
      walletId: frozen.walletId,
    },
    orderDeliveryStatus: "sent",
    phase: "in_progress",
    paymentStatus: "not_started",
  } as OrderLifecycle
}

function observation(
  target: CheckoutSparkOutgoingTarget,
  state: CheckoutSparkOutgoingObservation["state"]
): CheckoutSparkOutgoingObservation {
  return {
    obligationId: target.obligation.obligationId,
    outgoingId: target.obligation.outgoingId,
    paymentRequest: target.obligation.paymentRequest,
    amountSats: target.obligation.amountSats,
    maxFeeSats: target.obligation.maxFeeSats,
    state,
  }
}

function paymentInput() {
  return {
    grossFundingSats: 1_240,
    paymentTarget: { type: "manual" as const },
    timeoutMs: 60_000,
    appId: "market" as const,
  }
}

async function withRepository(
  run: (repository: DexieCheckoutSparkRepository) => Promise<void>
): Promise<void> {
  const database = new ConduitDB(
    `checkout-spark-shopper-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  try {
    await run(new DexieCheckoutSparkRepository(database))
  } finally {
    database.close()
    await database.delete()
  }
}

describe("explicit checkout Spark shopper advancement", () => {
  it("sends at most one leg per call and never treats funding alone as merchant payment", async () => {
    await withRepository(async (repository) => {
      const frozen = plan()
      const stored = preparation(frozen)
      let fundingCalls = 0
      const sends: string[] = []
      const provider: CheckoutSparkOutgoingProvider = {
        reconcile: async (target) => observation(target, "not_found"),
        preflight: async () => "ready",
        send: async (target) => {
          sends.push(target.obligation.kind)
          return observation(target, "paid")
        },
      }
      const dependencies = {
        readOrder: async () => lifecycle(frozen),
        readPreparation: () => stored,
        repository,
        sparkConfiguration: () => ({
          status: "ready" as const,
          network: "mainnet" as const,
        }),
        sparkManager: () => ({}) as SparkWalletManager,
        fundingBridge: () => ({
          fund: async () => {
            fundingCalls += 1
            return {
              status: "funded" as const,
              reconciliation: applyCheckoutSparkEvidence(
                stored.reconciliation,
                {
                  type: "funding",
                  requestId: frozen.funding.requestId,
                  paymentRequest: frozen.funding.paymentRequest,
                  paymentHash: frozen.funding.paymentHash,
                  walletId: frozen.walletId,
                  network: frozen.network,
                  requiredNetSats: frozen.funding.requiredNetSats,
                  grossFundingSats: frozen.funding.grossFundingSats,
                  state: "spendable",
                  observedAt: CREATED_AT + 1,
                }
              ),
            }
          },
        }),
        outgoingProvider: () => provider,
        now: () => CREATED_AT + 2,
      }
      const input = {
        checkoutId: frozen.checkoutId,
        orderId: frozen.orderId,
        merchantPubkey: frozen.merchantPubkey,
        network: frozen.network,
        buyerPubkey: BUYER,
        currentBuyerPubkey: () => BUYER,
        shouldContinue: () => true,
        fundingPayment: paymentInput(),
      }

      const first = await advanceCheckoutSparkShopper(input, dependencies)
      expect(first.status).toBe("outgoing_step")
      if (first.status !== "outgoing_step") throw new Error("Expected step")
      expect(first.step.state.obligations.map((item) => item.state)).toEqual([
        "paid",
        "unreconciled",
      ])
      expect(sends).toEqual(["merchant"])
      expect(fundingCalls).toBe(1)

      const second = await advanceCheckoutSparkShopper(input, dependencies)
      expect(second.status).toBe("outgoing_step")
      expect(sends).toEqual(["merchant", "conduit"])
      expect(fundingCalls).toBe(1)
      const reloaded = await repository.load(
        frozen.checkoutId,
        frozen.planDigest
      )
      expect(reloaded.status).toBe("active")
      if (reloaded.status === "active") {
        expect(reloaded.state.obligations.map((item) => item.state)).toEqual([
          "paid",
          "paid",
        ])
      }
    })
  })

  it("rejects a mismatched binding before funding or provider work", async () => {
    await withRepository(async (repository) => {
      const frozen = plan()
      let fundingCalls = 0
      const wrongOrder = lifecycle(frozen)
      wrongOrder.checkoutSparkRouterBinding = {
        ...wrongOrder.checkoutSparkRouterBinding!,
        walletId: "different-wallet",
      }
      await expect(
        advanceCheckoutSparkShopper(
          {
            checkoutId: frozen.checkoutId,
            orderId: frozen.orderId,
            merchantPubkey: frozen.merchantPubkey,
            network: frozen.network,
            buyerPubkey: BUYER,
            currentBuyerPubkey: () => BUYER,
            shouldContinue: () => true,
            fundingPayment: paymentInput(),
          },
          {
            readOrder: async () => wrongOrder,
            readPreparation: () => preparation(frozen),
            repository,
            sparkConfiguration: () => ({
              status: "ready",
              network: "mainnet",
            }),
            sparkManager: () => ({}) as SparkWalletManager,
            fundingBridge: () => {
              fundingCalls += 1
              throw new Error("Funding must not start")
            },
          }
        )
      ).rejects.toThrow("order binding changed")
      expect(fundingCalls).toBe(0)
      expect(
        (await repository.load(frozen.checkoutId, frozen.planDigest)).status
      ).toBe("absent")
    })
  })

  it("does not send when funding evidence cannot be durably saved", async () => {
    await withRepository(async (repository) => {
      const frozen = plan()
      const stored = preparation(frozen)
      let sends = 0
      await expect(
        advanceCheckoutSparkShopper(
          {
            checkoutId: frozen.checkoutId,
            orderId: frozen.orderId,
            merchantPubkey: frozen.merchantPubkey,
            network: frozen.network,
            buyerPubkey: BUYER,
            currentBuyerPubkey: () => BUYER,
            shouldContinue: () => true,
            fundingPayment: paymentInput(),
          },
          {
            readOrder: async () => lifecycle(frozen),
            readPreparation: () => stored,
            repository: {
              create: (plan) => repository.create(plan),
              load: (checkoutId, digest) => repository.load(checkoutId, digest),
              save: async () => {
                throw new Error("CAS changed")
              },
            },
            sparkConfiguration: () => ({
              status: "ready",
              network: "mainnet",
            }),
            sparkManager: () => ({}) as SparkWalletManager,
            fundingBridge: () => ({
              fund: async () => ({
                status: "funded",
                reconciliation: applyCheckoutSparkEvidence(
                  stored.reconciliation,
                  {
                    type: "funding",
                    requestId: frozen.funding.requestId,
                    paymentRequest: frozen.funding.paymentRequest,
                    paymentHash: frozen.funding.paymentHash,
                    walletId: frozen.walletId,
                    network: frozen.network,
                    requiredNetSats: frozen.funding.requiredNetSats,
                    grossFundingSats: frozen.funding.grossFundingSats,
                    state: "spendable",
                    observedAt: CREATED_AT + 1,
                  }
                ),
              }),
            }),
            outgoingProvider: () => ({
              reconcile: async (target) => observation(target, "not_found"),
              preflight: async () => "ready",
              send: async (target) => {
                sends += 1
                return observation(target, "paid")
              },
            }),
            now: () => CREATED_AT + 2,
          }
        )
      ).rejects.toThrow("CAS changed")
      expect(sends).toBe(0)
    })
  })

  it("leaves the merchant unpaid when funding settles but the outgoing fee check is unavailable", async () => {
    await withRepository(async (repository) => {
      const frozen = plan()
      const stored = preparation(frozen)
      let sends = 0
      const result = await advanceCheckoutSparkShopper(
        {
          checkoutId: frozen.checkoutId,
          orderId: frozen.orderId,
          merchantPubkey: frozen.merchantPubkey,
          network: frozen.network,
          buyerPubkey: BUYER,
          currentBuyerPubkey: () => BUYER,
          shouldContinue: () => true,
          fundingPayment: paymentInput(),
        },
        {
          readOrder: async () => lifecycle(frozen),
          readPreparation: () => stored,
          repository,
          sparkConfiguration: () => ({
            status: "ready",
            network: "mainnet",
          }),
          sparkManager: () => ({}) as SparkWalletManager,
          fundingBridge: () => ({
            fund: async () => ({
              status: "funded",
              reconciliation: applyCheckoutSparkEvidence(
                stored.reconciliation,
                {
                  type: "funding",
                  requestId: frozen.funding.requestId,
                  paymentRequest: frozen.funding.paymentRequest,
                  paymentHash: frozen.funding.paymentHash,
                  walletId: frozen.walletId,
                  network: frozen.network,
                  requiredNetSats: frozen.funding.requiredNetSats,
                  grossFundingSats: frozen.funding.grossFundingSats,
                  state: "spendable",
                  observedAt: CREATED_AT + 1,
                }
              ),
            }),
          }),
          outgoingProvider: () => ({
            reconcile: async (target) => observation(target, "not_found"),
            preflight: async () => "unavailable",
            send: async (target) => {
              sends += 1
              return observation(target, "paid")
            },
          }),
          now: () => CREATED_AT + 2,
        }
      )
      expect(result.status).toBe("outgoing_step")
      if (result.status !== "outgoing_step") throw new Error("Expected step")
      expect(result.step.state.funding.state).toBe("spendable")
      expect(result.step.state.obligations[0]?.state).toBe("not_found")
      expect(result.step.nextAction).toEqual({
        type: "wait",
        reason: "fee_preflight_unavailable",
      })
      expect(sends).toBe(0)
    })
  })

  it("does not invoke the provider send after the buyer session changes", async () => {
    await withRepository(async (repository) => {
      const frozen = plan()
      const stored = preparation(frozen)
      const funded = applyCheckoutSparkEvidence(stored.reconciliation, {
        type: "funding",
        requestId: frozen.funding.requestId,
        paymentRequest: frozen.funding.paymentRequest,
        paymentHash: frozen.funding.paymentHash,
        walletId: frozen.walletId,
        network: frozen.network,
        requiredNetSats: frozen.funding.requiredNetSats,
        grossFundingSats: frozen.funding.grossFundingSats,
        state: "spendable",
        observedAt: CREATED_AT + 1,
      })
      const created = await repository.create(frozen)
      if (created.status !== "active") throw new Error("Expected active")
      await repository.save(funded, created.revision)
      let currentBuyer = BUYER
      let sends = 0
      await expect(
        advanceCheckoutSparkShopper(
          {
            checkoutId: frozen.checkoutId,
            orderId: frozen.orderId,
            merchantPubkey: frozen.merchantPubkey,
            network: frozen.network,
            buyerPubkey: BUYER,
            currentBuyerPubkey: () => currentBuyer,
            shouldContinue: () => true,
            fundingPayment: paymentInput(),
          },
          {
            readOrder: async () => lifecycle(frozen),
            readPreparation: () => stored,
            repository,
            sparkConfiguration: () => ({
              status: "ready",
              network: "mainnet",
            }),
            sparkManager: () => ({}) as SparkWalletManager,
            fundingBridge: () => {
              throw new Error("Funding must not repeat")
            },
            outgoingProvider: () => ({
              reconcile: async (target) => observation(target, "not_found"),
              preflight: async () => {
                currentBuyer = "e".repeat(64)
                return "ready"
              },
              send: async (target) => {
                sends += 1
                return observation(target, "paid")
              },
            }),
            now: () => CREATED_AT + 2,
          }
        )
      ).rejects.toThrow("session changed")
      expect(sends).toBe(0)
      const reloaded = await repository.load(
        frozen.checkoutId,
        frozen.planDigest
      )
      expect(reloaded.status).toBe("active")
      if (reloaded.status === "active") {
        expect(reloaded.state.obligations[0]?.state).toBe("ambiguous")
      }
    })
  })

  it("preserves an ambiguous outgoing send across another explicit call", async () => {
    await withRepository(async (repository) => {
      const frozen = plan()
      const stored = preparation(frozen)
      const funded = applyCheckoutSparkEvidence(stored.reconciliation, {
        type: "funding",
        requestId: frozen.funding.requestId,
        paymentRequest: frozen.funding.paymentRequest,
        paymentHash: frozen.funding.paymentHash,
        walletId: frozen.walletId,
        network: frozen.network,
        requiredNetSats: frozen.funding.requiredNetSats,
        grossFundingSats: frozen.funding.grossFundingSats,
        state: "spendable",
        observedAt: CREATED_AT + 1,
      })
      const created = await repository.create(frozen)
      if (created.status !== "active") throw new Error("Expected active")
      await repository.save(funded, created.revision)
      let sends = 0
      const dependencies = {
        readOrder: async () => lifecycle(frozen),
        readPreparation: () => stored,
        repository,
        sparkConfiguration: () => ({
          status: "ready" as const,
          network: "mainnet" as const,
        }),
        sparkManager: () => ({}) as SparkWalletManager,
        fundingBridge: () => {
          throw new Error("Funding must not repeat")
        },
        outgoingProvider: (): CheckoutSparkOutgoingProvider => ({
          reconcile: async (target) => observation(target, "not_found"),
          preflight: async () => "ready",
          send: async () => {
            sends += 1
            throw new Error("Unknown provider result")
          },
        }),
        now: () => CREATED_AT + 2,
      }
      const input = {
        checkoutId: frozen.checkoutId,
        orderId: frozen.orderId,
        merchantPubkey: frozen.merchantPubkey,
        network: frozen.network,
        buyerPubkey: BUYER,
        currentBuyerPubkey: () => BUYER,
        shouldContinue: () => true,
        fundingPayment: paymentInput(),
      }
      const first = await advanceCheckoutSparkShopper(input, dependencies)
      expect(first.status).toBe("outgoing_step")
      if (first.status !== "outgoing_step") throw new Error("Expected step")
      expect(first.step.state.obligations[0]?.state).toBe("ambiguous")
      const second = await advanceCheckoutSparkShopper(input, dependencies)
      expect(second.status).toBe("outgoing_step")
      expect(sends).toBe(1)
      const reloaded = await repository.load(
        frozen.checkoutId,
        frozen.planDigest
      )
      expect(reloaded.status).toBe("active")
      if (reloaded.status === "active") {
        expect(reloaded.state.obligations[0]?.state).toBe("ambiguous")
      }
    })
  })
})

import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  calculateCheckoutSparkInboundNetworkAllowanceSats,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeeRecipient,
  DexieCheckoutSparkSettledRepository,
  fetchLnurlPayMetadata,
  stageOrderRelayDelivery,
  retryOrderRelayDelivery,
  wrapPrivateMessage,
  type SignedPublicNostrEvent,
  type PreparedOrderRelayDelivery,
  proveSparkCheckoutReceiveCredit,
  type OrderRelayDeliveryRepository,
  type CheckoutSparkSettledPlan,
} from "@conduit/core"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  listCheckoutSparkSettledPreparations,
  CheckoutSparkSettledPreparationAbandonedError,
  CheckoutSparkSettledFundingExpiredError,
  getCheckoutSparkSettledPreparation,
  loadAuthorizedCheckoutSparkSettledFunding,
  resumeCheckoutSparkSettledFunding,
  prepareCheckoutSparkSettledFunding,
  type PrepareCheckoutSparkSettledFundingInput,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  listCheckoutSparkRecoveryDeliveries,
  getCheckoutSparkRecoveryDelivery,
  publishCheckoutSparkSettledRecoveryHandoff,
  retryStoredCheckoutSparkRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import { findBlockingCheckoutSparkPreparation } from "../apps/market/src/lib/checkout-spark-router-purchase-claim"
import {
  prepareCheckoutSparkSettledOrder,
  resumeCheckoutSparkSettledOrder,
  CheckoutSparkSettledContinuationManualRecoveryError,
} from "../apps/market/src/lib/checkout-spark-settled-entry"
import { listCheckoutSparkSettledContinuations } from "../apps/market/src/lib/checkout-spark-settled-continuation"
import { createCheckoutSparkSettledFundingBridge } from "../apps/market/src/lib/checkout-spark-settled-funding"
import { advanceCheckoutSparkSettledShopper } from "../apps/market/src/lib/checkout-spark-settled-shopper-advance"
import { assessCheckoutSparkSettledOrderControl } from "../apps/market/src/lib/checkout-spark-settled-order-control"
import { publishCheckoutSparkSettledBoundOrder } from "../apps/market/src/lib/checkout-spark-bound-order"
import { prepareBuyerRumor } from "../apps/market/src/lib/order-publish"
import type { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import { plainTestSigner } from "./helpers/plain-signer"
import { checkoutSparkQuoteFixture } from "./support/checkout-spark-quote-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { qualifiedReceiverMetadataFixture } from "./support/checkout-spark-qualified-receiver-fixture"

const NOW = 1_800_000_000_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const PROFILE = finalizeEvent(
  {
    kind: 0,
    created_at: NOW / 1_000,
    tags: [],
    content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
  },
  MERCHANT_SECRET
)
const CLAIM = "12".repeat(32)
const GROSS =
  1_000 +
  calculateConduitCheckoutFeeSats(1_000) +
  calculateCheckoutSparkInboundNetworkAllowanceSats(1_000)
const INVOICE = makeSignedBolt11Fixture({
  hrp: `lnbc${GROSS * 10}n`,
  createdAt: NOW / 1_000,
  fields: [
    bolt11PaymentHashField(new Uint8Array(32).fill(0x44)),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
    { tag: "x", words: [28, 4] },
  ],
})

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function fixture(storage: MemoryStorage) {
  const signer = plainTestSigner(NDKPrivateKeySigner.generate())
  const quoteAuthority = checkoutSparkQuoteFixture(MERCHANT_SECRET)
  const conduit = checkoutSparkConduitFeeRecipient("production")
  const input: PrepareCheckoutSparkSettledFundingInput = {
    checkoutId: "preparation-recovery-checkout",
    orderId: "preparation-recovery-order",
    purchaseClaimDigest: CLAIM,
    merchantPubkey: MERCHANT,
    network: "mainnet",
    takeoverAt: NOW + 120_000,
    grossFundingSats: GROSS,
    fundingExpirySecs: 900,
    identity: { kind: "signed_in", pubkey: signer.pubkey, signer },
    quoteAuthority,
    sourceEvents: [
      quoteAuthority.products[0]!.supplierAllocation!.revisionEvent!,
      PROFILE,
    ],
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@wallet.conduit.market",
          source: {
            type: "signed_profile",
            profileEventId: PROFILE.id,
            profileEventCreatedAt: PROFILE.created_at,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: conduit,
        destination: {
          type: "lightning_address",
          value: conduit,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: calculateConduitCheckoutFeeSats(1_000),
      },
    ],
    storage,
    recoveryStorage: storage,
  }
  const calls = { open: 0, close: 0, invoice: 0, transport: 0 }
  const controls = { ack: true }
  return {
    input,
    signer,
    calls,
    controls,
    options: {
      now: () => NOW,
      receiverContracts: qualifiedReceiverMetadataFixture(
        "merchant@wallet.conduit.market"
      ).contracts,
      fetchPayoutMetadata: (address: string) =>
        fetchLnurlPayMetadata(address, {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                tag: "payRequest",
                callback: "https://wallet.conduit.market/callback",
                minSendable: 1_000,
                maxSendable: 10_000_000,
                allowsNostr: false,
                metadata:
                  qualifiedReceiverMetadataFixture(address).metadata.metadata,
              }),
              { status: 200 }
            ),
        }),
      createWalletMaterial: () => ({
        walletId: "preparation-recovery-wallet",
        network: "mainnet" as const,
        mnemonic: createRuntimeMnemonic(),
        accountNumber: 1,
      }),
      openWallet: async () => {
        calls.open += 1
      },
      closeWallet: async () => {
        calls.close += 1
      },
      createFundingReceive: async () => {
        calls.invoice += 1
        return {
          walletId: "preparation-recovery-wallet",
          network: "mainnet" as const,
          id: "preparation-recovery-receive",
          paymentRequest: INVOICE,
          paymentHash: "44".repeat(32),
          providerStatus: "INVOICE_CREATED",
          requiredNetSats: GROSS,
          grossFundingSats: GROSS,
          expirySecs: 900,
          createdAt: NOW,
          expiresAt: NOW + 900_000,
          receiveSettledPolicy: "ordinary-exact-credit-v3" as const,
          receiverIdentityPublicKey: `02${"a".repeat(64)}`,
        }
      },
      publishRecoveryHandoff: (
        request: Parameters<
          typeof publishCheckoutSparkSettledRecoveryHandoff
        >[0]
      ) =>
        publishCheckoutSparkSettledRecoveryHandoff({
          ...request,
          now: () => NOW,
          transport: {
            ...request.transport,
            recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
            publishFn: async (_event, plan) => {
              calls.transport += 1
              return {
                attemptedRelayUrls: plan.exclusiveRelayUrls ?? [],
                successfulRelayUrls: controls.ack
                  ? (plan.exclusiveRelayUrls ?? [])
                  : [],
                failedRelayUrls: controls.ack
                  ? []
                  : (plan.exclusiveRelayUrls ?? []),
                relayFailureMessages: {},
              }
            },
          },
        }),
    },
  }
}

function orderRepository(database: ConduitDB): OrderRelayDeliveryRepository {
  return {
    get: (id) => database.orderLifecycles.get(id),
    list: (buyer) =>
      database.orderLifecycles.where("buyerPubkey").equals(buyer).toArray(),
    update: (id, updater) =>
      database.transaction("rw", database.orderLifecycles, async () => {
        const current = await database.orderLifecycles.get(id)
        if (!current) return undefined
        const next = updater(current)
        await database.orderLifecycles.put(next)
        return next
      }),
    stage: (record, assertCompatible) =>
      database.transaction("rw", database.orderLifecycles, async () => {
        const current = await database.orderLifecycles.get(record.orderId)
        if (current) {
          assertCompatible(current)
          return { lifecycle: current, inserted: false }
        }
        await database.orderLifecycles.put(record)
        return { lifecycle: record, inserted: true }
      }),
  }
}

function entryRequest(input: PrepareCheckoutSparkSettledFundingInput) {
  const quote = input.quoteAuthority
  return {
    checkoutId: input.checkoutId,
    orderId: input.orderId,
    purchaseClaimDigest: CLAIM,
    buyer: input.identity,
    network: input.network,
    nowMs: NOW,
    shouldContinue: () => true,
    note: "Original synthetic draft",
    quoteAuthority: {
      ...quote,
      pricing: {
        ...quote.pricing,
        itemSubtotalSats: 1_000,
        totalMsats: 1_000_000,
        paymentRequired: true,
        approximate: false,
        shippingCost: {
          status: "not_required" as const,
          totalSats: 0,
          missingProductIds: [],
        },
        items: quote.pricing.items.map((item) => ({
          ...item,
          format: "digital" as const,
          currency: "SATS" as const,
          shippingCostSats: undefined,
        })),
      },
    },
  }
}

describe("settled preparation phase recovery", () => {
  it.each([
    "before_write",
    "after_write",
    "revision_progress",
    "session_revoked",
  ] as const)(
    "resolves a real repository creation failure only with pristine evidence: %s",
    async (phase) => {
      const database = new ConduitDB(
        `preparation-recovery-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        const storage = new MemoryStorage()
        const f = fixture(storage)
        let current = true
        const attempt = prepareCheckoutSparkSettledFunding(
          { ...f.input, shouldContinue: () => current },
          {
            ...f.options,
            repository: {
              load: repository.load.bind(repository),
              abandonPristine: repository.abandonPristine.bind(repository),
              create: async (plan) => {
                if (phase !== "before_write") {
                  const snapshot = await repository.create(plan)
                  if (
                    phase === "revision_progress" &&
                    snapshot.status === "active"
                  )
                    await repository.save(snapshot.state, snapshot.revision)
                }
                if (phase === "session_revoked") current = false
                throw new Error("Synthetic repository creation interrupted")
              },
            },
          }
        )
        const pristine = phase === "before_write" || phase === "after_write"
        if (pristine)
          await expect(attempt).rejects.toBeInstanceOf(
            CheckoutSparkSettledPreparationAbandonedError
          )
        else await expect(attempt).rejects.toThrow()
        expect(f.calls.close).toBe(pristine ? 1 : 0)
        expect(f.calls.transport).toBe(0)
        expect(
          findBlockingCheckoutSparkPreparation(
            listCheckoutSparkSettledPreparations(storage),
            CLAIM,
            NOW
          )
        ).toBe(!pristine)
        expect(await database.checkoutSparkReconciliations.count()).toBe(
          pristine ? 0 : 1
        )
        expect(listCheckoutSparkRecoveryDeliveries(storage)).toHaveLength(0)
      } finally {
        database.close()
        await database.delete()
      }
    }
  )
  it("retains the claim on bounded close timeout, with no second preparation admitted", async () => {
    const database = new ConduitDB(
      `preparation-recovery-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const storage = new MemoryStorage()
      const f = fixture(storage)
      f.signer.signEvent = async () => {
        throw new Error("Synthetic pre-wrap refusal")
      }
      await expect(
        prepareCheckoutSparkSettledFunding(f.input, {
          ...f.options,
          repository,
          closeWallet: async () => {
            f.calls.close += 1
            await new Promise<void>(() => undefined)
          },
        })
      ).rejects.toThrow()
      expect(f.calls.close).toBe(1)
      expect(f.calls.transport).toBe(0)
      expect(
        findBlockingCheckoutSparkPreparation(
          listCheckoutSparkSettledPreparations(storage),
          CLAIM,
          NOW
        )
      ).toBe(true)
      expect(await database.checkoutSparkReconciliations.count()).toBe(1)
      await expect(
        prepareCheckoutSparkSettledFunding(f.input, {
          ...f.options,
          repository,
        })
      ).rejects.toThrow("already")
      expect(f.calls.open).toBe(1)
      expect(f.calls.invoice).toBe(1)
    } finally {
      database.close()
      await database.delete()
    }
  }, 15_000)

  it("makes a definitely unexposed pre-plan receive failure retryable only after successful close", async () => {
    const database = new ConduitDB(
      `preparation-recovery-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const storage = new MemoryStorage()
      const f = fixture(storage)
      await expect(
        prepareCheckoutSparkSettledFunding(f.input, {
          ...f.options,
          repository,
          createFundingReceive: async () => {
            throw new Error("Synthetic receive refusal before exposure")
          },
        })
      ).rejects.toBeInstanceOf(CheckoutSparkSettledPreparationAbandonedError)
      expect(f.calls).toEqual({ open: 1, close: 1, invoice: 0, transport: 0 })
      expect(listCheckoutSparkSettledPreparations(storage)).toHaveLength(0)
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
      const retried = await prepareCheckoutSparkSettledFunding(f.input, {
        ...f.options,
        repository,
      })
      expect(retried.plan.checkoutId === f.input.checkoutId).toBe(true)
      expect(f.calls).toEqual({ open: 2, close: 1, invoice: 1, transport: 1 })
    } finally {
      database.close()
      await database.delete()
    }
  })
  it.each([
    "late_exact_credit",
    "unavailable_inspector",
    "invoice_expired",
  ] as const)(
    "composes first exposure after handoff, preserving %s funding authority",
    async (mode) => {
      const database = new ConduitDB(
        `preparation-recovery-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        const orders = orderRepository(database)
        const storage = new MemoryStorage()
        const f = fixture(storage)
        let time = NOW
        let funded = false
        let payerCalls = 0
        let payoutCalls = 0
        const loadAuthorized: typeof loadAuthorizedCheckoutSparkSettledFunding =
          (id, options) =>
            loadAuthorizedCheckoutSparkSettledFunding(id, {
              ...options,
              repository,
              storage,
              recoveryStorage: storage,
              now: () => time,
            })
        const result = await prepareCheckoutSparkSettledOrder(
          entryRequest(f.input),
          {
            now: () => time,
            continuationStorage: new MemoryStorage(),
            readRecipientPayout: async () => ({
              state: "ready",
              lud16: "merchant@wallet.conduit.market",
              profileEventId: PROFILE.id,
              profileEventCreatedAt: PROFILE.created_at,
              signedEvent: PROFILE,
            }),
            prepareFunding: (value) =>
              prepareCheckoutSparkSettledFunding(
                { ...value, storage, recoveryStorage: storage },
                {
                  ...f.options,
                  repository,
                  now: () => time,
                  publishRecoveryHandoff: async (request) => {
                    const handoff =
                      await f.options.publishRecoveryHandoff(request)
                    time = NOW + 180_000
                    return handoff
                  },
                }
              ),
            publishOrder: (value) =>
              publishCheckoutSparkSettledBoundOrder(
                { ...value, storage },
                {
                  now: () => time,
                  loadSettledFunding: loadAuthorized,
                  bindBuyerOrder: repository.bindBuyerOrder.bind(repository),
                  publishOrder: async (
                    rumor,
                    _ndk,
                    recipient,
                    _buyer,
                    options
                  ) => {
                    prepareBuyerRumor(rumor, f.signer.pubkey)
                    const wrap = await wrapPrivateMessage(
                      rumor,
                      new NDKUser({ pubkey: recipient }),
                      f.signer
                    )
                    const declaration = finalizeEvent(
                      {
                        kind: 10_050,
                        created_at: NOW / 1_000,
                        tags: [["relay", "wss://merchant.inbox.relay.dev"]],
                        content: "",
                      },
                      MERCHANT_SECRET
                    )
                    await stageOrderRelayDelivery(
                      {
                        lifecycle: options!.orderLifecycle!,
                        leaseOwner: "synthetic-late-funding",
                        prepared: {
                          rumorId: rumor.id,
                          signedRecipientWrap:
                            wrap.rawEvent() as SignedPublicNostrEvent,
                          route: "declared_inbox",
                          routingAuthority: {
                            eventId: declaration.id,
                            eventCreatedAt: declaration.created_at,
                            pubkey: MERCHANT,
                            kind: 10_050,
                            relayUrls: ["wss://merchant.inbox.relay.dev"],
                          },
                          relayPlan: [
                            {
                              relayUrl: "wss://merchant.inbox.relay.dev",
                              source: "declared",
                            },
                          ],
                        },
                      },
                      { repository: orders, now: () => time }
                    )
                    await retryOrderRelayDelivery(
                      f.input.orderId,
                      f.signer.pubkey,
                      {
                        repository: orders,
                        now: () => time,
                        leaseOwner: "synthetic-late-funding",
                        accountNetworkLocalStateRepository: {
                          get: async () => null,
                        },
                        publisher: async () => "acked",
                      }
                    )
                    expect(
                      (await orders.get(f.input.orderId))?.orderDeliveryStatus
                    ).toBe("sent")
                    return {
                      buyerSelfCopyError: null,
                      localCacheError: null,
                      deliveryRoute: "declared_inbox",
                      companionNotification: Promise.resolve("sent"),
                    }
                  },
                }
              ),
          }
        )
        const plan = result.prepared.plan
        expect(plan.takeoverAt).toBe(NOW + 120_000)
        expect(plan.funding.expiresAt).toBe(NOW + 900_000)
        expect(
          getCheckoutSparkSettledPreparation(plan.checkoutId, storage)
            ?.fundingInvoiceExposedAt
        ).toBe(time)
        const bridge = createCheckoutSparkSettledFundingBridge(
          plan.checkoutId,
          {
            repository,
            storage,
            recoveryStorage: storage,
            loadAuthorized,
            now: () => time,
            requireCrossTabLock: false,
            withStoreWriteLock: async (operation) => operation(),
            payInvoice: async () => {
              payerCalls += 1
              throw new Error("External disclosure must not enter a payer")
            },
            attestCredit: async () => {
              if (mode === "unavailable_inspector")
                throw new Error("Synthetic exact receive read unavailable")
              return funded
                ? proveSparkCheckoutReceiveCredit({
                    expectedRequest: {
                      network: plan.network,
                      id: plan.funding.requestId,
                      paymentRequest: plan.funding.paymentRequest,
                      paymentHash: plan.funding.paymentHash,
                      grossFundingSats: plan.funding.grossFundingSats,
                    },
                    expectedReceive: { mode: "ordinary_v3" },
                    walletIdentityPublicKey:
                      plan.funding.receiverIdentityPublicKey,
                    receive: {
                      id: plan.funding.requestId,
                      status: "TRANSFER_COMPLETED",
                      network: "MAINNET",
                      invoice: {
                        encodedInvoice: plan.funding.paymentRequest,
                        bitcoinNetwork: "MAINNET",
                        paymentHash: plan.funding.paymentHash,
                        amount: {
                          originalUnit: "SATOSHI",
                          originalValue: GROSS,
                        },
                      },
                      transfer: {
                        sparkId: "0197f9a0-0000-7000-8000-000000000001",
                        userRequestId: plan.funding.requestId,
                        totalAmount: {
                          originalUnit: "SATOSHI",
                          originalValue: GROSS,
                        },
                      },
                    },
                    transfer: {
                      id: "0197f9a0-0000-7000-8000-000000000001",
                      status: "TRANSFER_STATUS_COMPLETED",
                      totalValue: GROSS,
                      transferDirection: "INCOMING",
                      receiverIdentityPublicKey:
                        plan.funding.receiverIdentityPublicKey,
                      userRequest: { id: plan.funding.requestId },
                    },
                  })
                : null
            },
          }
        )
        const dependencies = {
          repository,
          loadAuthorized,
          now: () => time,
          readOrder: orders.get,
          readPreparation: (id: string) =>
            getCheckoutSparkSettledPreparation(id, storage),
          readInitialRecovery: (id: string) =>
            getCheckoutSparkRecoveryDelivery(id, storage),
          sparkConfiguration: () => ({
            status: "ready" as const,
            network: "mainnet" as const,
          }),
          sparkManager: () => ({ isOpen: () => true }) as SparkWalletManager,
          fundingBridge: () => bridge,
          prepareLeg: async () => {
            payoutCalls += 1
            throw new Error("No late buyer preparation")
          },
          outgoingStep: async () => {
            payoutCalls += 1
            throw new Error("No late buyer send")
          },
        }
        const step = {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          orderId: plan.orderId,
          merchantPubkey: MERCHANT,
          network: plan.network,
          buyerPubkey: f.signer.pubkey,
          currentBuyerPubkey: () => f.signer.pubkey,
          shouldContinue: () => true,
          legId: null,
          fundingPayment: {
            buyerPubkey: f.signer.pubkey,
            shouldContinue: () => true,
            exposeExternalInvoice: true,
            paymentTarget: { type: "manual" as const },
            timeoutMs: 5_000,
            appId: "market" as const,
          },
          acknowledgeRecoverySnapshot: async () => undefined,
        }
        if (mode === "invoice_expired") time = plan.funding.expiresAt
        const external = await advanceCheckoutSparkSettledShopper(
          step,
          dependencies
        )
        if (mode !== "late_exact_credit") {
          expect(
            external.status === "funding" &&
              external.funding.status ===
                (mode === "invoice_expired"
                  ? "manual_required"
                  : "awaiting_reconciliation")
          ).toBe(true)
          expect(
            getCheckoutSparkSettledPreparation(plan.checkoutId, storage)
              ?.externalFundingExposedAt
          ).toBeUndefined()
          expect(
            getCheckoutSparkSettledPreparation(plan.checkoutId, storage)
              ?.fundingSubmissionState
          ).toBe("not_started")
          expect(
            await repository.loadMerchantSettlement(
              MERCHANT,
              plan.checkoutId,
              plan.planDigest
            )
          ).toBeNull()
          expect(payerCalls).toBe(0)
          expect(payoutCalls).toBe(0)
          return
        }
        expect(
          external.status === "funding" &&
            external.funding.status === "external_ready"
        ).toBe(true)
        funded = true
        const credited = await advanceCheckoutSparkSettledShopper(
          {
            ...step,
            fundingPayment: {
              ...step.fundingPayment,
              exposeExternalInvoice: false,
              inspectionOnly: true,
            },
          },
          dependencies
        )
        expect(
          credited.status === "funding" && credited.funding.status === "funded"
        ).toBe(true)
        const merchant = await repository.loadMerchantSettlement(
          MERCHANT,
          plan.checkoutId,
          plan.planDigest
        )
        expect(merchant?.credit?.creditedSats).toBe(GROSS)
        const snapshot = await repository.load(plan.checkoutId, plan.planDigest)
        const control = assessCheckoutSparkSettledOrderControl({
          lifecycle: await orders.get(plan.orderId),
          preparation: getCheckoutSparkSettledPreparation(
            plan.checkoutId,
            storage
          ),
          snapshot,
          buyerPubkey: f.signer.pubkey,
          initialRecoverySenderPubkey: f.signer.pubkey,
          initialRecoveryAcked: true,
          now: time,
          routerWalletOpen: true,
        })
        expect(control.status).toBe("blocked")
        await expect(
          advanceCheckoutSparkSettledShopper(
            { ...step, legId: plan.recipients[0]!.legId },
            dependencies
          )
        ).rejects.toThrow("order authority changed")
        expect(payoutCalls).toBe(0)
        expect(payerCalls).toBe(0)
        expect(f.calls).toEqual({ open: 1, close: 0, invoice: 1, transport: 1 })
      } finally {
        database.close()
        await database.delete()
      }
    }
  )
  it.each([
    "signed_identity",
    "default_signed_identity",
    "expired_invoice",
    "changed_staged_order",
  ] as const)(
    "continues only the exact staged private order on reload: %s",
    async (mode) => {
      const database = new ConduitDB(
        `preparation-recovery-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        const orders = orderRepository(database)
        const storage = new MemoryStorage()
        const draftStorage = new MemoryStorage()
        const f = fixture(storage)
        const request = entryRequest(f.input)
        let signedOrder: SignedPublicNostrEvent | null = null
        let orderSends = 0
        await expect(
          prepareCheckoutSparkSettledOrder(request, {
            now: () => NOW,
            continuationStorage: draftStorage,
            readRecipientPayout: async () => ({
              state: "ready",
              lud16: "merchant@wallet.conduit.market",
              profileEventId: PROFILE.id,
              profileEventCreatedAt: PROFILE.created_at,
              signedEvent: PROFILE,
            }),
            prepareFunding: (value) =>
              prepareCheckoutSparkSettledFunding(
                { ...value, storage, recoveryStorage: storage },
                { ...f.options, repository }
              ),
            publishOrder: (value) =>
              publishCheckoutSparkSettledBoundOrder(
                { ...value, storage },
                {
                  now: () => NOW,
                  loadSettledFunding: (id, options) =>
                    loadAuthorizedCheckoutSparkSettledFunding(id, {
                      ...options,
                      storage,
                      recoveryStorage: storage,
                      repository,
                    }),
                  publishOrder: async (
                    rumor,
                    _ndk,
                    recipient,
                    buyer,
                    options
                  ) => {
                    prepareBuyerRumor(rumor, f.signer.pubkey)
                    const wrap = await wrapPrivateMessage(
                      rumor,
                      new NDKUser({ pubkey: recipient }),
                      f.signer
                    )
                    signedOrder = wrap.rawEvent() as SignedPublicNostrEvent
                    const declaration = finalizeEvent(
                      {
                        kind: 10_050,
                        created_at: NOW / 1_000,
                        tags: [["relay", "wss://merchant.inbox.relay.dev"]],
                        content: "",
                      },
                      MERCHANT_SECRET
                    )
                    const prepared: PreparedOrderRelayDelivery = {
                      rumorId: rumor.id,
                      signedRecipientWrap: signedOrder,
                      route: "declared_inbox",
                      routingAuthority: {
                        eventId: declaration.id,
                        eventCreatedAt: declaration.created_at,
                        pubkey: MERCHANT,
                        kind: 10_050,
                        relayUrls: ["wss://merchant.inbox.relay.dev"],
                      },
                      relayPlan: [
                        {
                          relayUrl: "wss://merchant.inbox.relay.dev",
                          source: "declared",
                        },
                      ],
                    }
                    expect(
                      typeof buyer === "object" &&
                        buyer.pubkey === f.signer.pubkey
                    ).toBe(true)
                    await stageOrderRelayDelivery(
                      {
                        lifecycle: options!.orderLifecycle!,
                        prepared,
                        leaseOwner: "initial-synthetic-owner",
                      },
                      { repository: orders, now: () => NOW }
                    )
                    throw new Error("Synthetic private order ACK interrupted")
                  },
                }
              ),
          })
        ).rejects.toThrow("Synthetic private order ACK interrupted")
        expect(signedOrder !== null).toBe(true)
        expect((await orders.get(f.input.orderId))?.orderDeliveryStatus).toBe(
          "pending"
        )
        if (mode === "default_signed_identity")
          await orders.update(f.input.orderId, (row) => ({
            ...row,
            buyerIdentityKind: undefined,
          }))
        if (mode === "changed_staged_order")
          await orders.update(f.input.orderId, (row) => ({
            ...row,
            contactNote: "Different synthetic note",
          }))
        request.note = "Changed current cart"
        request.quoteAuthority.pricing.items[0]!.quantity = 9
        const time = mode === "expired_invoice" ? NOW + 900_000 : NOW + 180_000
        const resume = resumeCheckoutSparkSettledOrder(
          {
            checkoutId: f.input.checkoutId,
            buyer: f.input.identity,
            shouldContinue: () => true,
          },
          {
            now: () => time,
            continuationStorage: draftStorage,
            isWalletOpen: () => false,
            resumeFunding: (value) =>
              resumeCheckoutSparkSettledFunding(
                { ...value, storage, recoveryStorage: storage },
                { repository, now: () => time }
              ),
            readOrder: orders.get,
            retryOrder: (id, buyer, options) =>
              retryOrderRelayDelivery(id, buyer, {
                ...options,
                repository: orders,
                now: () => time,
                accountNetworkLocalStateRepository: { get: async () => null },
                publisher: async ({ signedEvent }) => {
                  orderSends += 1
                  expect(
                    JSON.stringify(signedEvent) === JSON.stringify(signedOrder)
                  ).toBe(true)
                  return "acked"
                },
              }),
            publishOrder: async () => {
              throw new Error("A staged order must never be rebuilt")
            },
            bindBuyerOrder: repository.bindBuyerOrder.bind(repository),
          }
        )
        if (mode === "expired_invoice")
          await expect(resume).rejects.toBeInstanceOf(
            CheckoutSparkSettledFundingExpiredError
          )
        else if (
          mode === "changed_staged_order" ||
          mode === "default_signed_identity"
        )
          await expect(resume).rejects.toBeInstanceOf(
            CheckoutSparkSettledContinuationManualRecoveryError
          )
        else {
          const result = await resume
          expect(result.nextStep).toBe("merchant_recovery")
          expect((await orders.get(f.input.orderId))?.orderDeliveryStatus).toBe(
            "sent"
          )
          expect(
            (await orders.get(f.input.orderId))?.contactNote ===
              "Original synthetic draft"
          ).toBe(true)
          expect(
            (await database.checkoutSparkPlanBindings.get(f.input.checkoutId))
              ?.buyerOrderBinding?.orderId === f.input.orderId
          ).toBe(true)
        }
        expect(orderSends).toBe(mode === "signed_identity" ? 1 : 0)
        expect(
          listCheckoutSparkSettledContinuations(
            f.signer.pubkey,
            time,
            draftStorage
          )
        ).toHaveLength(mode === "signed_identity" ? 0 : 1)
        expect(
          (await database.checkoutSparkPlanBindings.get(f.input.checkoutId))
            ?.buyerOrderBinding?.buyerPubkey !== undefined
        ).toBe(mode === "signed_identity")
        expect(f.calls).toEqual({ open: 1, close: 0, invoice: 1, transport: 1 })
        expect(
          findBlockingCheckoutSparkPreparation(
            listCheckoutSparkSettledPreparations(storage),
            CLAIM,
            time
          )
        ).toBe(true)
      } finally {
        database.close()
        await database.delete()
      }
    }
  )
  it.each(["revoked_during_close", "close_failure"] as const)(
    "finishes only an admitted pristine cleanup for %s",
    async (mode) => {
      const database = new ConduitDB(
        `preparation-recovery-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        const storage = new MemoryStorage()
        const { input, calls, options, signer } = fixture(storage)
        let current = true
        signer.signEvent = async () => {
          throw new Error("Synthetic pre-wrap signer refusal")
        }
        const attempt = prepareCheckoutSparkSettledFunding(
          { ...input, shouldContinue: () => current },
          {
            ...options,
            repository,
            closeWallet: async () => {
              calls.close += 1
              if (mode === "close_failure")
                throw new Error("Synthetic close failure")
              current = false
            },
          }
        )
        if (mode === "close_failure")
          await expect(attempt).rejects.toBeInstanceOf(AggregateError)
        else
          await expect(attempt).rejects.toBeInstanceOf(
            CheckoutSparkSettledPreparationAbandonedError
          )
        expect(calls.close).toBe(1)
        expect(calls.transport).toBe(0)
        expect(
          findBlockingCheckoutSparkPreparation(
            listCheckoutSparkSettledPreparations(storage),
            CLAIM,
            NOW
          )
        ).toBe(mode === "close_failure")
        expect(await database.checkoutSparkReconciliations.count()).toBe(
          mode === "close_failure" ? 1 : 0
        )
        expect(await database.checkoutSparkPlanBindings.count()).toBe(
          mode === "close_failure" ? 1 : 0
        )
        expect(listCheckoutSparkRecoveryDeliveries(storage)).toHaveLength(0)
      } finally {
        database.close()
        await database.delete()
      }
    }
  )

  it.each(["revision", "session"] as const)(
    "retains the only RAM credential when %s changed before pristine cleanup",
    async (change) => {
      const database = new ConduitDB(
        `preparation-recovery-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        const storage = new MemoryStorage()
        const { input, calls, options } = fixture(storage)
        let current = true
        let digest: string | null = null
        await expect(
          prepareCheckoutSparkSettledFunding(
            {
              ...input,
              shouldContinue: () => current,
              onPlanPrepared: async ({ plan }) => {
                digest = plan.planDigest
                if (change === "revision") {
                  const initial = await repository.load(
                    plan.checkoutId,
                    plan.planDigest
                  )
                  if (initial.status !== "active")
                    throw new Error("Synthetic initial state absent")
                  await repository.save(initial.state, initial.revision)
                } else current = false
                throw new Error("Synthetic phase failure")
              },
            },
            { ...options, repository }
          )
        ).rejects.toThrow()
        expect(calls.close).toBe(0)
        expect(calls.open).toBe(1)
        expect(calls.transport).toBe(0)
        expect(listCheckoutSparkRecoveryDeliveries(storage)).toHaveLength(0)
        expect(digest !== null).toBe(true)
        expect((await repository.load(input.checkoutId, digest!)).status).toBe(
          "active"
        )
        expect(
          findBlockingCheckoutSparkPreparation(
            listCheckoutSparkSettledPreparations(storage),
            CLAIM,
            NOW
          )
        ).toBe(true)
      } finally {
        database.close()
        await database.delete()
      }
    }
  )

  it("retains the original draft through lost recovery ACK and seedless reload; a changed cart cannot replace it", async () => {
    const database = new ConduitDB(
      `preparation-recovery-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const storage = new MemoryStorage()
      const draftStorage = new MemoryStorage()
      const { input, calls, controls, options } = fixture(storage)
      controls.ack = false
      const quote = input.quoteAuthority
      const entryInput = {
        checkoutId: input.checkoutId,
        orderId: input.orderId,
        purchaseClaimDigest: CLAIM,
        buyer: input.identity,
        network: input.network,
        nowMs: NOW,
        shouldContinue: () => true,
        note: "Original synthetic draft",
        quoteAuthority: {
          ...quote,
          pricing: {
            ...quote.pricing,
            itemSubtotalSats: 1_000,
            totalMsats: 1_000_000,
            paymentRequired: true,
            approximate: false,
            shippingCost: {
              status: "not_required" as const,
              totalSats: 0,
              missingProductIds: [],
            },
            items: quote.pricing.items.map((item) => ({
              ...item,
              format: "digital" as const,
              currency: "SATS" as const,
              shippingCostSats: undefined,
            })),
          },
        },
      }
      let orderPublications = 0
      await expect(
        prepareCheckoutSparkSettledOrder(entryInput, {
          now: () => NOW,
          continuationStorage: draftStorage,
          readRecipientPayout: async () => ({
            state: "ready",
            lud16: "merchant@wallet.conduit.market",
            profileEventId: PROFILE.id,
            profileEventCreatedAt: PROFILE.created_at,
            signedEvent: PROFILE,
          }),
          prepareFunding: (request) =>
            prepareCheckoutSparkSettledFunding(
              { ...request, storage, recoveryStorage: storage },
              { ...options, repository }
            ),
          publishOrder: async () => {
            orderPublications += 1
            throw new Error("No publication before recovery ACK")
          },
        })
      ).rejects.toThrow("without a relay ACK")
      expect(orderPublications).toBe(0)
      const saved = listCheckoutSparkSettledContinuations(
        input.identity.pubkey,
        NOW + 180_000,
        draftStorage
      )[0]!
      expect(saved.order.note === "Original synthetic draft").toBe(true)
      const original = listCheckoutSparkRecoveryDeliveries(storage)[0]!
      controls.ack = true
      // A new render/cart is deliberately different; no new cart enters the
      // continuation interface. The saved payload remains the only source.
      entryInput.note = "Changed synthetic draft"
      entryInput.quoteAuthority.pricing.items[0]!.quantity = 9
      let sameDraft = false
      const result = await resumeCheckoutSparkSettledOrder(
        {
          checkoutId: input.checkoutId,
          buyer: input.identity,
          shouldContinue: () => true,
        },
        {
          now: () => NOW + 180_000,
          continuationStorage: draftStorage,
          isWalletOpen: () => false,
          readOrder: async () => undefined,
          resumeFunding: (request) =>
            resumeCheckoutSparkSettledFunding(
              { ...request, storage, recoveryStorage: storage },
              {
                repository,
                now: () => NOW + 180_000,
                retryRecovery: (retry) =>
                  retryStoredCheckoutSparkRecoveryHandoff({
                    ...retry,
                    recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
                    publishFn: async (event, plan) => {
                      expect(
                        JSON.stringify(event) ===
                          JSON.stringify(original.record.signedRecipientWrap)
                      ).toBe(true)
                      calls.transport += 1
                      return {
                        attemptedRelayUrls: plan.exclusiveRelayUrls ?? [],
                        successfulRelayUrls: plan.exclusiveRelayUrls ?? [],
                        failedRelayUrls: [],
                        relayFailureMessages: {},
                      }
                    },
                  }),
              }
            ),
          publishOrder: async (request) => {
            sameDraft =
              request.order.note === "Original synthetic draft" &&
              request.order.items[0]!.quantity === 1
            orderPublications += 1
            return {
              orderId: request.order.id,
              delivery: {
                buyerSelfCopyError: null,
                localCacheError: null,
                deliveryRoute: "declared_inbox",
                companionNotification: Promise.resolve("sent"),
              },
            }
          },
        }
      )
      expect(sameDraft).toBe(true)
      expect(orderPublications).toBe(1)
      expect(result.nextStep).toBe("merchant_recovery")
      expect(result.buyerWalletAvailable).toBe(false)
      expect(calls).toEqual({ open: 1, close: 0, invoice: 1, transport: 2 })
      expect(
        listCheckoutSparkSettledContinuations(
          input.identity.pubkey,
          NOW + 180_000,
          draftStorage
        )
      ).toHaveLength(0)
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("preserves an exact wrap after outbox readback failure and resumes it after handoff without a second wallet or receive", async () => {
    const database = new ConduitDB(
      `preparation-recovery-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      class ReadbackFailureStorage extends MemoryStorage {
        failReadback = false
        override setItem(key: string, value: string): void {
          super.setItem(key, value)
          if (key.includes("recovery-outbox")) this.failReadback = true
        }
        override getItem(key: string): string | null {
          if (key.includes("recovery-outbox") && this.failReadback) {
            this.failReadback = false
            throw new Error("Synthetic outbox readback failure")
          }
          return super.getItem(key)
        }
      }
      const storage = new ReadbackFailureStorage()
      const { input, calls, options } = fixture(storage)
      await expect(
        prepareCheckoutSparkSettledFunding(input, { ...options, repository })
      ).rejects.toThrow("Synthetic outbox readback failure")
      expect(calls.close).toBe(0)
      expect(calls.transport).toBe(0)
      const original = listCheckoutSparkRecoveryDeliveries(storage)[0]!
      expect(original !== undefined).toBe(true)
      expect(original.deliveryProgress.acknowledgedRelayRefs).toHaveLength(0)
      const originalSet = storage.setItem.bind(storage)
      storage.setItem = (key, value) => {
        originalSet(key, value)
        storage.failReadback = false
      }
      let publishedExact = false
      const resumed = await resumeCheckoutSparkSettledFunding(
        {
          checkoutId: input.checkoutId,
          orderId: input.orderId,
          planDigest: original.record.planDigest,
          merchantPubkey: input.merchantPubkey,
          buyerPubkey: input.identity.pubkey,
          shouldContinue: () => true,
          storage,
          recoveryStorage: storage,
        },
        {
          repository,
          now: () => NOW + 180_000,
          retryRecovery: (request) =>
            retryStoredCheckoutSparkRecoveryHandoff({
              ...request,
              recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
              publishFn: async (event, plan) => {
                publishedExact =
                  JSON.stringify(event) ===
                  JSON.stringify(original.record.signedRecipientWrap)
                calls.transport += 1
                return {
                  attemptedRelayUrls: plan.exclusiveRelayUrls ?? [],
                  successfulRelayUrls: plan.exclusiveRelayUrls ?? [],
                  failedRelayUrls: [],
                  relayFailureMessages: {},
                }
              },
            }),
        }
      )
      expect(publishedExact).toBe(true)
      expect(resumed.plan.planDigest === original.record.planDigest).toBe(true)
      expect(resumed.fundingInvoice === INVOICE).toBe(true)
      expect(calls).toEqual({ open: 1, close: 0, invoice: 1, transport: 1 })
      expect(listCheckoutSparkRecoveryDeliveries(storage)).toHaveLength(1)
      expect(
        findBlockingCheckoutSparkPreparation(
          listCheckoutSparkSettledPreparations(storage),
          CLAIM,
          NOW + 180_000
        )
      ).toBe(true)
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("releases the exact cart claim only after a real pre-wrap signer refusal and pristine repository cleanup", async () => {
    const database = new ConduitDB(
      `preparation-recovery-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const storage = new MemoryStorage()
      const { input, signer, calls, options } = fixture(storage)
      const sign = signer.signEvent.bind(signer)
      signer.signEvent = async (event) => {
        if (event.kind === 13)
          throw new Error("Synthetic signer refusal before wrap")
        return sign(event)
      }
      let created: CheckoutSparkSettledPlan | null = null
      await expect(
        prepareCheckoutSparkSettledFunding(input, {
          ...options,
          repository: {
            create: async (plan) => {
              created = plan
              return repository.create(plan)
            },
            load: repository.load.bind(repository),
            abandonPristine: repository.abandonPristine.bind(repository),
          },
        })
      ).rejects.toBeInstanceOf(CheckoutSparkSettledPreparationAbandonedError)
      expect(calls.transport).toBe(0)
      expect(listCheckoutSparkRecoveryDeliveries(storage)).toHaveLength(0)
      expect(calls.close).toBe(1)
      expect(
        findBlockingCheckoutSparkPreparation(
          listCheckoutSparkSettledPreparations(storage),
          CLAIM,
          NOW
        )
      ).toBe(false)
      expect(created !== null).toBe(true)
      if (!created) throw new Error("Synthetic plan was not created")
      const plan = created as CheckoutSparkSettledPlan
      expect(
        (await repository.load(plan.checkoutId, plan.planDigest)).status
      ).toBe("absent")
    } finally {
      database.close()
      await database.delete()
    }
  })
})

import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools/pure"
import { ConduitDB } from "@conduit/core/db"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  projectCheckoutSparkMerchantSettlement,
  readCheckoutSparkMerchantOrderEvidence,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkInvoiceRecipientRecord,
} from "@conduit/core/protocol"
import { verifySavedMerchantCheckoutSparkRecipients } from "../apps/merchant/src/lib/checkout-spark-invoice-recipient"
import {
  createCheckoutSparkInvoiceRecipientRecord,
  verifyCheckoutSparkInvoiceRecipient,
  projectCheckoutSparkMerchantRecipientSettlement,
} from "../packages/core/src/protocol/checkout-spark-invoice-recipient"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import { observeMerchantCheckoutSparkOrder } from "../apps/merchant/src/lib/checkout-spark-order-observation"
import { reconcileMerchantCheckoutSparkOrder } from "../apps/merchant/src/lib/checkout-spark-order-reconciliation"
import type { MerchantSparkObservationWallet } from "../apps/merchant/src/lib/checkout-spark-observation-wallet"

const NOW = 1_800_000_000_000

function fixture(
  suffix = "",
  identities = {
    merchantSecret: generateSecretKey(),
    supplierSecret: generateSecretKey(),
    buyer: getPublicKey(generateSecretKey()),
  },
  fundingPreimageByte = 33,
  reusedReceivers?: ReturnType<typeof qualifiedReceiverFixture>[]
) {
  const { merchantSecret, supplierSecret } = identities
  const merchant = getPublicKey(merchantSecret)
  const supplier = getPublicKey(supplierSecret)
  const buyer = identities.buyer
  const receivers = reusedReceivers ?? [
    qualifiedReceiverFixture({
      amountSats: 745,
      lud16: "merchant@receiver.conduit.cash",
      preimageByte: 31,
    }),
    qualifiedReceiverFixture({
      amountSats: 245,
      lud16: "supplier@receiver.conduit.cash",
      preimageByte: 32,
    }),
  ]
  const product = finalizeEvent(
    {
      kind: 30_402,
      created_at: NOW / 1_000 - 1,
      tags: [
        ["d", "digital-item"],
        ["title", "Synthetic commerce observation"],
        ["price", "1000", "SAT"],
        ["type", "simple", "digital"],
        ["conduit_supplier_allocation", "1"],
        ["zap", merchant, "wss://relay.conduit.market", "3"],
        ["zap", supplier, "wss://relay.conduit.market", "1"],
      ],
      content: "Synthetic digital listing",
    },
    merchantSecret
  )
  const profiles = [merchantSecret, supplierSecret].map((secret, index) =>
    finalizeEvent(
      {
        kind: 0,
        created_at: NOW / 1_000 - 1,
        tags: [],
        content: JSON.stringify({ lud16: receivers[index]!.lud16 }),
      },
      secret
    )
  )
  const funding = qualifiedReceiverFixture({
    amountSats: 1_113,
    preimageByte: fundingPreimageByte,
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: `immediate-observation-checkout${suffix}`,
    orderId: `immediate-observation-order${suffix}`,
    merchantPubkey: merchant,
    walletId: `immediate-observation-wallet${suffix}`,
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${merchant}:digital-item`,
          productEventId: product.id,
          merchantPubkey: merchant,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: `immediate-observation-receive${suffix}`,
      paymentRequest: funding.paymentRequest,
      paymentHash: funding.paymentHash,
      receiverIdentityPublicKey: `02${merchant}`,
      grossFundingSats: 1_113,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
    },
    recipients: [
      ...profiles.map((profile, index) => ({
        kind: index === 0 ? ("merchant" as const) : ("supplier" as const),
        recipientId: profile.pubkey,
        weightSats: index === 0 ? 750 : 250,
        destination: {
          type: "lightning_address" as const,
          value: receivers[index]!.lud16,
          source: {
            type: "signed_profile" as const,
            profileEventId: profile.id,
            profileEventCreatedAt: profile.created_at,
          },
        },
      })),
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
  const payload = {
    id: plan.orderId,
    buyerPubkey: buyer,
    buyerIdentityKind: "signed_in",
    merchantPubkey: merchant,
    items: [
      {
        productId: `30402:${merchant}:digital-item`,
        quantity: 1,
        priceAtPurchase: 1_000,
        currency: "SATS",
        format: "digital",
        fulfillment: { type: "digital" },
        shippingCostSats: 0,
      },
    ],
    subtotal: 1_000,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt: NOW + 1,
  }
  const event = {
    kind: 16,
    pubkey: buyer,
    created_at: NOW / 1_000,
    content: JSON.stringify(payload),
    tags: [
      ["p", merchant],
      ["type", "order"],
      ["order", plan.orderId],
      ["amount", "1000"],
      ["currency", "SATS"],
      ["item", `30402:${merchant}:digital-item`, "1"],
      [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
    ],
  }
  const evidence = readCheckoutSparkMerchantOrderEvidence({
    ...event,
    id: getEventHash(event),
  })!
  expect(evidence).not.toBeNull()
  const sources = [product, ...profiles]
  const witness = createCheckoutSparkMerchantOrderWitness(
    plan,
    evidence,
    buyer,
    sources
  )!
  expect(witness).not.toBeNull()
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: `buyer-claimed-funding${suffix}`,
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: NOW + 1,
    }
  )
  for (const [index, receiver] of receivers.entries()) {
    const legId = plan.recipients[index]!.legId
    state = prepareCheckoutSparkSettledLeg(state, {
      legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
      paymentRequest: receiver.paymentRequest,
      paymentHash: receiver.paymentHash,
      invoiceAmountSats: index === 0 ? 745 : 245,
      maxFeeSats: 5,
      preparedAt: NOW + 2,
      receiverBinding: receiver.receiverBinding,
    })
    state = recordCheckoutSparkSettledLegStatus(state, {
      legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
      paymentHash: receiver.paymentHash,
      status: "paid",
      finalFeeSats: 5,
      finalDebitSats: index === 0 ? 750 : 250,
      observedAt: NOW + 3,
    })
  }
  return { merchant, buyer, plan, state, witness, sources, receivers }
}

function observationHandoff(context: ReturnType<typeof fixture>) {
  const payload = createCheckoutSparkSettledRecoveryPayload({
    state: context.state,
    senderPubkey: context.buyer,
    mnemonic: crypto.randomUUID(),
    accountNumber: 0,
    preparedAt: NOW + 4,
  })
  const candidate = {
    schemaVersion: 2 as const,
    wrapId: "7".repeat(64),
    checkoutId: context.plan.checkoutId,
    orderId: context.plan.orderId,
    planDigest: context.plan.planDigest,
    takeoverAt: context.plan.takeoverAt,
    preparedAt: payload.preparedAt,
  }
  const consumeRecovery: NonNullable<
    Parameters<typeof observeMerchantCheckoutSparkOrder>[3]
  >["consumeRecovery"] = async (_principal, selected, adapter) => {
    await adapter.consume(payload, () => {})
    return {
      status: "consumed",
      coverage: "complete",
      discoveryCoverage: "complete",
      declarationState: "declared",
      candidate: selected,
    }
  }
  return { candidate, consumeRecovery }
}

describe("immediate read-only Merchant receiver observation", () => {
  it.each(["open", "receive"] as const)(
    "expires a hung %s and rejects late results without financial writes",
    async (hung) => {
      const context = fixture()
      const database = new ConduitDB(
        `hung-observation-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        await repository.importMerchantOrderRecovery(
          context.state,
          context.witness,
          () => {}
        )
        await repository.recordMerchantPlanSources(
          context.plan,
          context.sources,
          () => {}
        )
        const original = await repository.load(
          context.plan.checkoutId,
          context.plan.planDigest
        )
        const handoff = observationHandoff(context)
        let resolveOpen!: (wallet: MerchantSparkObservationWallet) => void
        let resolveReceive!: (
          receive: Awaited<
            ReturnType<
              MerchantSparkObservationWallet["getLightningReceiveRequest"]
            >
          >
        ) => void
        const openPending = new Promise<MerchantSparkObservationWallet>(
          (resolve) => {
            resolveOpen = resolve
          }
        )
        const receivePending = new Promise<
          Awaited<
            ReturnType<
              MerchantSparkObservationWallet["getLightningReceiveRequest"]
            >
          >
        >((resolve) => {
          resolveReceive = resolve
        })
        let cleanups = 0
        let transfers = 0
        const wallet: MerchantSparkObservationWallet = {
          getIdentityPublicKey: async () =>
            context.plan.funding.receiverIdentityPublicKey,
          getLightningReceiveRequest: async () => receivePending,
          getTransfer: async () => {
            transfers += 1
            return undefined
          },
          cleanup: async () => {
            cleanups += 1
          },
        }
        const result = await observeMerchantCheckoutSparkOrder(
          context.merchant,
          handoff.candidate,
          () => {},
          {
            repository,
            consumeRecovery: handoff.consumeRecovery,
            readTimeoutMs: 1_000,
            now: () => NOW + 5,
            openObservationWallet: async () =>
              hung === "open" ? openPending : wallet,
          }
        )
        expect(result).toBe("unavailable")
        expect(cleanups).toBe(hung === "open" ? 0 : 1)
        resolveOpen(wallet)
        resolveReceive({
          id: context.plan.funding.requestId,
          status: "TRANSFER_COMPLETED",
          transfer: { sparkId: "late-credit" },
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(cleanups).toBe(1)
        expect(transfers).toBe(0)
        expect(
          await repository.loadMerchantSettlement(
            context.merchant,
            context.plan.checkoutId,
            context.plan.planDigest
          )
        ).toBeNull()
        expect(
          await repository.load(
            context.plan.checkoutId,
            context.plan.planDigest
          )
        ).toEqual(original)
        // A later fresh observation owns new authority after release. The old
        // callback cannot resume into this retry or block the handoff boundary.
        expect(
          await observeMerchantCheckoutSparkOrder(
            context.merchant,
            handoff.candidate,
            () => {},
            {
              repository,
              consumeRecovery: handoff.consumeRecovery,
              now: () => context.plan.takeoverAt,
              openObservationWallet: async () => ({
                ...wallet,
                getLightningReceiveRequest: async () => null,
              }),
            }
          )
        ).toBe("pending")
        expect(cleanups).toBe(2)
      } finally {
        await database.delete()
      }
    }
  )

  it("does not open an observation wallet without exact locally validated sources", async () => {
    const context = fixture()
    const database = new ConduitDB(
      `source-gated-observation-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.importMerchantOrderRecovery(
        context.state,
        context.witness,
        () => {}
      )
      const handoff = observationHandoff(context)
      let opened = false
      expect(
        await observeMerchantCheckoutSparkOrder(
          context.merchant,
          handoff.candidate,
          () => {},
          {
            repository,
            consumeRecovery: handoff.consumeRecovery,
            now: () => NOW + 5,
            openObservationWallet: async () => {
              opened = true
              throw new Error("No wallet authority without sources")
            },
          }
        )
      ).toBe("unavailable")
      expect(opened).toBe(false)
      expect(
        await repository.loadMerchantSettlement(
          context.merchant,
          context.plan.checkoutId,
          context.plan.planDigest
        )
      ).toBeNull()
    } finally {
      await database.delete()
    }
  })

  it.each([
    { missingSupplierDebit: false, afterTakeover: false },
    { missingSupplierDebit: true, afterTakeover: false },
    { missingSupplierDebit: false, afterTakeover: true },
    { missingSupplierDebit: true, afterTakeover: true },
  ])(
    "requires exact query-only credit and every debit without advancing saved state (scenario=%j)",
    async ({ missingSupplierDebit, afterTakeover }) => {
      const context = fixture()
      const database = new ConduitDB(
        `native-observation-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        await repository.importMerchantOrderRecovery(
          context.state,
          context.witness,
          () => {}
        )
        await repository.recordMerchantPlanSources(
          context.plan,
          context.sources,
          () => {}
        )
        await verifySavedMerchantCheckoutSparkRecipients({
          state: context.state,
          repository,
          assertCurrent: () => {},
          now: () => NOW + 4,
          verifyInvoice: (input) => {
            const index = context.plan.recipients.findIndex(
              (leg) => leg.legId === input.target.legId
            )
            const receiver = context.receivers[index]!
            return verifyCheckoutSparkInvoiceRecipient(input, {
              contracts: receiver.contracts,
              fetchMetadata: async () => receiver.metadata,
              fetchVerify: async () => receiver.verifier(),
            })
          },
        })
        const original = await repository.load(
          context.plan.checkoutId,
          context.plan.planDigest
        )
        const payload = createCheckoutSparkSettledRecoveryPayload({
          state: context.state,
          senderPubkey: context.buyer,
          mnemonic: crypto.randomUUID(),
          accountNumber: 0,
          preparedAt: NOW + 4,
        })
        const candidate = {
          schemaVersion: 2 as const,
          wrapId: "7".repeat(64),
          checkoutId: context.plan.checkoutId,
          orderId: context.plan.orderId,
          planDigest: context.plan.planDigest,
          takeoverAt: context.plan.takeoverAt,
          preparedAt: payload.preparedAt,
        }
        const requests = context.receivers.map((receiver, index) => ({
          typename: "LightningSendRequest",
          id: `native-observed-request-${index}`,
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 5, originalUnit: "SATOSHI" },
          encodedInvoice: receiver.paymentRequest,
          idempotencyKey: context.state.legs[index]!.intent!.transferId,
          paymentPreimage: receiver.preimage,
        }))
        let cleaned = 0
        let claimingOperations = 0
        const observationTime = afterTakeover
          ? context.plan.takeoverAt + 1
          : NOW + 5
        const noClaim = async () => {
          claimingOperations += 1
          throw new Error(
            "Read-only recovery cannot initialize a claiming wallet"
          )
        }
        const status = await reconcileMerchantCheckoutSparkOrder(
          context.merchant,
          candidate,
          () => {},
          {
            repository,
            observationOnly: true,
            now: () => observationTime,
            checkCredit: noClaim,
            inspectPayouts: noClaim,
            observeNative: (principal, selected, assertCurrent, options) =>
              observeMerchantCheckoutSparkOrder(
                principal,
                selected,
                assertCurrent,
                {
                  ...options,
                  consumeRecovery: async (_principal, selected, adapter) => {
                    await adapter.consume(payload, () => {})
                    return {
                      status: "consumed",
                      coverage: "complete",
                      discoveryCoverage: "complete",
                      declarationState: "declared",
                      candidate: selected,
                    }
                  },
                  openObservationWallet: async (input) => {
                    expect(input.expectedWalletIdentityPubkey).toBe(
                      context.plan.funding.receiverIdentityPublicKey
                    )
                    expect(input.expectedWalletIdentityPubkey).toBe(
                      context.plan.funding.receiverIdentityPublicKey
                    )
                    return {
                      getIdentityPublicKey: async () =>
                        input.expectedWalletIdentityPubkey,
                      getLightningReceiveRequest: async (id) => ({
                        id,
                        status: "TRANSFER_COMPLETED",
                        network: "MAINNET",
                        invoice: {
                          encodedInvoice: context.plan.funding.paymentRequest,
                          bitcoinNetwork: "MAINNET",
                          paymentHash: context.plan.funding.paymentHash,
                          amount: {
                            originalValue: 1_113,
                            originalUnit: "SATOSHI",
                          },
                        },
                        transfer: {
                          sparkId: context.state.credit!.transferId,
                          userRequestId: id,
                          totalAmount: {
                            originalValue: 1_111,
                            originalUnit: "SATOSHI",
                          },
                        },
                      }),
                      getTransfer: async (id) => ({
                        id,
                        status: "TRANSFER_STATUS_COMPLETED",
                        totalValue: 1_111,
                        transferDirection: "INCOMING",
                        receiverIdentityPublicKey:
                          input.expectedWalletIdentityPubkey,
                        userRequest: { id: context.plan.funding.requestId },
                      }),
                      getTransferFromSsp: async (id) => {
                        const index = requests.findIndex(
                          (request) => request.idempotencyKey === id
                        )
                        if (index < 0 || (missingSupplierDebit && index === 1))
                          return undefined
                        return {
                          sparkId: id,
                          totalAmount: {
                            originalValue: index === 0 ? 750 : 250,
                            originalUnit: "SATOSHI",
                          },
                          userRequest: requests[index]!,
                        }
                      },
                      getLightningSendRequest: async (id) =>
                        requests.find((request) => request.id === id) ?? null,
                      cleanup: async () => {
                        cleaned += 1
                      },
                    }
                  },
                }
              ),
          }
        )
        expect(status).toBe(missingSupplierDebit ? "pending" : "verified")
        expect(cleaned).toBe(1)
        expect(claimingOperations).toBe(0)
        expect(
          await repository.load(
            context.plan.checkoutId,
            context.plan.planDigest
          )
        ).toEqual(original)
        const settlement = await repository.loadMerchantSettlement(
          context.merchant,
          context.plan.checkoutId,
          context.plan.planDigest
        )
        expect(
          projectCheckoutSparkMerchantSettlement(settlement!)
        ).toMatchObject({
          creditVerified: true,
          merchantVerified: true,
          commerceVerified: !missingSupplierDebit,
          feePending: true,
        })
        expect(settlement!.paidLegs).toHaveLength(missingSupplierDebit ? 1 : 2)
      } finally {
        await database.delete()
      }
    }
  )

  it("requires every exact commerce recipient, independently of buyer paid/funding labels", async () => {
    const context = fixture()
    const records: CheckoutSparkInvoiceRecipientRecord[] = []
    const observe = async (supplierSettled: boolean) => {
      await verifySavedMerchantCheckoutSparkRecipients({
        state: context.state,
        assertCurrent: () => {},
        now: () => NOW + 4,
        repository: {
          hasInvoiceRecipient: async () => false,
          recordInvoiceRecipientVerification: async (plan, target, proof) => {
            records.push(
              createCheckoutSparkInvoiceRecipientRecord(plan, target, proof)
            )
          },
        },
        verifyInvoice: (input) => {
          const index = context.plan.recipients.findIndex(
            (leg) => leg.legId === input.target.legId
          )
          const receiver = context.receivers[index]!
          return verifyCheckoutSparkInvoiceRecipient(input, {
            contracts: receiver.contracts,
            fetchMetadata: async () => receiver.metadata,
            fetchVerify: async () =>
              receiver.verifier(index === 0 || supplierSettled),
          })
        },
      })
    }
    expect(
      projectCheckoutSparkMerchantRecipientSettlement(context.state, [])
        .commerceVerified
    ).toBe(false)
    await observe(false)
    expect(
      projectCheckoutSparkMerchantRecipientSettlement(context.state, records)
    ).toMatchObject({
      merchantVerified: false,
      commerceVerified: false,
      creditVerified: false,
      receiverSettlementObserved: true,
      receiverCommerceObserved: false,
    })
    await observe(true)
    expect(
      projectCheckoutSparkMerchantRecipientSettlement(context.state, records)
    ).toMatchObject({
      merchantVerified: false,
      commerceVerified: false,
      creditVerified: false,
      receiverSettlementObserved: true,
      receiverCommerceObserved: true,
    })
  })

  it("persists immediate receipts only with exact order/source authority and keeps the financial ledger empty", async () => {
    const context = fixture()
    const database = new ConduitDB(
      `immediate-observation-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.importMerchantOrderRecovery(
        context.state,
        context.witness,
        () => {}
      )
      await verifySavedMerchantCheckoutSparkRecipients({
        state: context.state,
        repository,
        assertCurrent: () => {},
        now: () => NOW + 4,
        verifyInvoice: (input) => {
          const index = context.plan.recipients.findIndex(
            (leg) => leg.legId === input.target.legId
          )
          const receiver = context.receivers[index]!
          return verifyCheckoutSparkInvoiceRecipient(input, {
            contracts: receiver.contracts,
            fetchMetadata: async () => receiver.metadata,
            fetchVerify: async () => receiver.verifier(),
          })
        },
      })
      expect(
        await repository.loadMerchantOrderRecipientSettlements(context.merchant)
      ).toEqual([])
      await repository.recordMerchantPlanSources(
        context.plan,
        context.sources,
        () => {}
      )
      const stored = (await database.checkoutSparkPlanBindings.get(
        context.plan.checkoutId
      ))!
      expect(stored.invoiceRecipients?.length).toBe(2)
      expect(
        projectCheckoutSparkMerchantRecipientSettlement(
          context.state,
          stored.invoiceRecipients ?? []
        )
      ).toMatchObject({
        receiverCommerceObserved: true,
        commerceVerified: false,
      })
      const rows = await repository.loadMerchantOrderRecipientSettlements(
        context.merchant,
        [context.plan.orderId]
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.receiverSettlement).toMatchObject({
        receiverCommerceObserved: true,
        commerceVerified: false,
      })
      expect(rows[0]!.settlement.credit).toBeNull()
      expect(rows[0]!.settlement.paidLegs).toEqual([])
      expect(
        await repository.loadMerchantSettlement(
          context.merchant,
          context.plan.checkoutId,
          context.plan.planDigest
        )
      ).toBeNull()
      expect(
        await repository.loadMerchantOrderRecipientSettlements(context.buyer)
      ).toEqual([])
      expect(
        await repository.loadMerchantOrderRecipientSettlements(
          context.merchant,
          ["another-order"]
        )
      ).toEqual([])
      const binding = (await database.checkoutSparkPlanBindings.get(
        context.plan.checkoutId
      ))!
      await database.checkoutSparkPlanBindings.put({
        ...binding,
        orderWitness: {
          ...binding.orderWitness!,
          checkoutId: "another-checkout",
        },
      })
      expect(
        await repository.loadMerchantOrderRecipientSettlements(context.merchant)
      ).toEqual([])
      await database.checkoutSparkPlanBindings.put({
        ...binding,
        sourceValidation: undefined,
      })
      expect(
        await repository.loadMerchantOrderRecipientSettlements(context.merchant)
      ).toEqual([])
    } finally {
      await database.delete()
    }
  })

  it("does not confirm a forged checkout reusing prior-paid invoices even on a fresh device", async () => {
    const identities = {
      merchantSecret: generateSecretKey(),
      supplierSecret: generateSecretKey(),
      buyer: getPublicKey(generateSecretKey()),
    }
    const previous = fixture("-previous", identities, 33)
    const forged = fixture("-forged", identities, 34, previous.receivers)
    expect(forged.plan.planDigest).not.toBe(previous.plan.planDigest)
    expect(forged.plan.funding.paymentHash).not.toBe(
      previous.plan.funding.paymentHash
    )
    expect(forged.receivers.map((receiver) => receiver.paymentRequest)).toEqual(
      previous.receivers.map((receiver) => receiver.paymentRequest)
    )
    const database = new ConduitDB(
      `prior-receipt-replay-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      // The fresh device has never seen the old plan, so local hash exclusion
      // cannot distinguish an old recipient receipt from this checkout's debit.
      await repository.importMerchantOrderRecovery(
        forged.state,
        forged.witness,
        () => {}
      )
      await repository.recordMerchantPlanSources(
        forged.plan,
        forged.sources,
        () => {}
      )
      await verifySavedMerchantCheckoutSparkRecipients({
        state: forged.state,
        repository,
        assertCurrent: () => {},
        now: () => NOW + 4,
        verifyInvoice: (input) => {
          const index = forged.plan.recipients.findIndex(
            (leg) => leg.legId === input.target.legId
          )
          const priorPaidInvoice = previous.receivers[index]!
          return verifyCheckoutSparkInvoiceRecipient(input, {
            contracts: priorPaidInvoice.contracts,
            fetchMetadata: async () => priorPaidInvoice.metadata,
            fetchVerify: async () => priorPaidInvoice.verifier(),
          })
        },
      })
      expect(await database.checkoutSparkPlanBindings.count()).toBe(1)
      const observed = await repository.loadMerchantOrderRecipientSettlements(
        forged.merchant,
        [forged.plan.orderId]
      )
      expect(observed).toHaveLength(1)
      expect(observed[0]!.receiverSettlement).toMatchObject({
        receiverSettlementObserved: true,
        receiverCommerceObserved: true,
        creditVerified: false,
        merchantVerified: false,
        commerceVerified: false,
      })
      expect(observed[0]!.settlement.credit).toBeNull()
      expect(observed[0]!.settlement.paidLegs).toEqual([])
      expect(
        await repository.loadMerchantSettlement(
          forged.merchant,
          forged.plan.checkoutId,
          forged.plan.planDigest
        )
      ).toBeNull()
      const handoff = observationHandoff(forged)
      expect(
        await observeMerchantCheckoutSparkOrder(
          forged.merchant,
          handoff.candidate,
          () => {},
          {
            repository,
            consumeRecovery: handoff.consumeRecovery,
            now: () => NOW + 5,
            openObservationWallet: async () => ({
              getIdentityPublicKey: async () =>
                forged.plan.funding.receiverIdentityPublicKey,
              getLightningReceiveRequest: async (id) => ({
                id,
                status: "TRANSFER_COMPLETED",
                network: "MAINNET",
                invoice: {
                  encodedInvoice: forged.plan.funding.paymentRequest,
                  paymentHash: forged.plan.funding.paymentHash,
                  bitcoinNetwork: "MAINNET",
                  amount: { originalValue: 1_113, originalUnit: "SATOSHI" },
                },
                transfer: {
                  sparkId: forged.state.credit!.transferId,
                  userRequestId: id,
                  totalAmount: {
                    originalValue: 1_111,
                    originalUnit: "SATOSHI",
                  },
                },
              }),
              getTransfer: async (id) => ({
                id,
                status: "TRANSFER_STATUS_COMPLETED",
                totalValue: 1_111,
                transferDirection: "INCOMING",
                receiverIdentityPublicKey:
                  forged.plan.funding.receiverIdentityPublicKey,
                userRequest: { id: forged.plan.funding.requestId },
              }),
              getTransferFromSsp: async (id) => {
                const index = forged.state.legs.findIndex(
                  (leg) => leg.intent?.transferId === id
                )
                const prior = previous.state.legs[index]!.intent!
                return {
                  sparkId: prior.transferId,
                  totalAmount: {
                    originalValue: index === 0 ? 750 : 250,
                    originalUnit: "SATOSHI",
                  },
                  userRequest: {
                    typename: "LightningSendRequest",
                    id: `prior-request-${index}`,
                    status: "LIGHTNING_PAYMENT_SUCCEEDED",
                    fee: { originalValue: 5, originalUnit: "SATOSHI" },
                    encodedInvoice: prior.paymentRequest,
                    idempotencyKey: prior.transferId,
                    paymentPreimage: previous.receivers[index]!.preimage,
                  },
                }
              },
              getLightningSendRequest: async () => {
                throw new Error(
                  "Prior checkout's transfer cannot authorize a fresh request read"
                )
              },
              cleanup: async () => {},
            }),
          }
        )
      ).toBe("pending")
      const freshFundingOnly = await repository.loadMerchantSettlement(
        forged.merchant,
        forged.plan.checkoutId,
        forged.plan.planDigest
      )
      expect(
        projectCheckoutSparkMerchantSettlement(freshFundingOnly!)
      ).toMatchObject({
        creditVerified: true,
        merchantVerified: false,
        commerceVerified: false,
      })
      expect(freshFundingOnly!.paidLegs).toEqual([])
    } finally {
      await database.delete()
    }
  })
})

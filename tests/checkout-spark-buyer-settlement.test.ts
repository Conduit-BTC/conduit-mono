import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { ConduitDB } from "@conduit/core/db"
import {
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  createCheckoutSparkRetiredSettlementSummary,
  createCheckoutSparkSettledReconciliation,
  DexieCheckoutSparkSettledRepository,
  freezeCheckoutSparkSettledPlan,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledReconciliation,
  type OrderLifecycle,
} from "@conduit/core"
import {
  assessCheckoutSparkBuyerSettlement,
  assessCheckoutSparkRetiredBuyerSettlement,
  getCheckoutSparkBuyerSettlementQueryOptions,
} from "../apps/market/src/lib/checkout-spark-buyer-settlement"
import { prepareCheckoutSparkSettledOutgoingLeg } from "../apps/market/src/lib/checkout-spark-settled-leg-preparation"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import { verifyCheckoutSparkInvoiceRecipient } from "../packages/core/src/protocol/checkout-spark-invoice-recipient"

const NOW = Math.floor(Date.now() / 1_000) * 1_000 - 60_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = getPublicKey(generateSecretKey())

function invoice(amountSats: number, hashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function fixture(guest = false) {
  const product = finalizeEvent(
    {
      kind: 30_402,
      created_at: NOW / 1_000 - 10,
      tags: [
        ["d", "buyer-settlement"],
        ["title", "Digital download"],
        ["price", "1000", "SAT"],
        ["type", "simple", "digital"],
      ],
      content: "A normal signed digital download.",
    },
    MERCHANT_SECRET
  )
  const profile = finalizeEvent(
    {
      kind: 0,
      created_at: NOW / 1_000 - 5,
      tags: [],
      content: JSON.stringify({ lud16: "merchant@example.test" }),
    },
    MERCHANT_SECRET
  )
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "buyer-origin-checkout",
    orderId: "buyer-origin-order",
    merchantPubkey: MERCHANT,
    walletId: "buyer-origin-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 45 * 60_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:buyer-settlement`,
          productEventId: product.id,
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "buyer-origin-receive",
      paymentRequest: invoice(1_113, 1),
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${MERCHANT}`,
      grossFundingSats: 1_113,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: profile.id,
            profileEventCreatedAt: profile.created_at,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
        destination: {
          type: "lightning_address",
          value: CONDUIT_CHECKOUT_FEE_RECIPIENT,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  const identity = guest
    ? createSessionGuestOrderSigningIdentity(plan.orderId, MERCHANT, {
        storage: null,
        nowMs: NOW,
      })
    : null
  const buyerPubkey = identity?.pubkey ?? BUYER
  const lifecycle: OrderLifecycle = {
    orderId: plan.orderId,
    merchantPubkey: MERCHANT,
    buyerPubkey,
    buyerIdentityKind: guest ? "guest_ephemeral" : "signed_in",
    ...(identity ? { guestSessionExpiresAt: identity.expiresAt } : {}),
    checkoutMode: "private_checkout",
    orderDeliveryStatus: "sent",
    items: [],
    currency: "SATS",
    itemSubtotalSats: 1_000,
    shippingCostSats: 0,
    totalSats: 1_000,
    totalMsats: 1_000_000,
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "in_progress",
    createdAt: NOW + 1_000,
    updatedAt: NOW + 1_000,
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId: plan.walletId,
    },
  }
  const credit = {
    mode: "ordinary_v3" as const,
    requestId: plan.funding.requestId,
    transferId: "buyer-origin-credit",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: 1_113,
    creditedSats: 1_113,
  }
  const credited = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      ...credit,
      paymentHash: plan.funding.paymentHash,
      observedAt: NOW + 2_000,
    }
  )
  return { plan, lifecycle, identity, buyerPubkey, credit, credited }
}

async function withRepository<T>(
  run: (
    database: ConduitDB,
    repository: DexieCheckoutSparkSettledRepository
  ) => Promise<T>
): Promise<T> {
  const database = new ConduitDB(`buyer-origin-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  try {
    return await run(
      database,
      new DexieCheckoutSparkSettledRepository(database)
    )
  } finally {
    database.close()
    await database.delete()
  }
}

function merchantPayout(
  state: CheckoutSparkSettledReconciliation,
  feeSats = 1
) {
  const recipient = state.plan.recipients.find(
    (leg) => leg.kind === "merchant"
  )!
  const leg = state.legs.find(
    (candidate) => candidate.legId === recipient.legId
  )!
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: state.plan.walletId,
    network: state.plan.network,
    legId: leg.legId,
    recipientId: recipient.recipientId,
    allocationSats: leg.allocationSats!,
    unpaidAllocationSats: state.credit!.creditedSats,
    intent: leg.intent!,
  }
  const observation: CheckoutSparkSettledOutgoingObservation = {
    ...target.intent,
    status: "paid",
    finalFeeSats: feeSats,
    finalDebitSats: target.intent.invoiceAmountSats + feeSats,
  }
  return { target, observation }
}

describe("buyer local invoice-origin settlement", () => {
  it.each([false, true])(
    "preserves locally resolved commerce verification for guest=%s",
    async (guest) => {
      const input = fixture(guest)
      await withRepository(async (database, repository) => {
        await repository.create(input.plan)
        await repository.save(input.credited, 1)
        await repository.recordMerchantCredit(
          input.plan,
          input.credit,
          NOW + 2_000
        )
        await database.orderLifecycles.put(input.lifecycle)
        const buyerBinding = await repository.bindBuyerOrder(
          input.plan,
          input.buyerPubkey,
          () => {}
        )
        const receiverInvoices = new Map<
          string,
          ReturnType<typeof qualifiedReceiverFixture>
        >()
        const prepared = await prepareCheckoutSparkSettledOutgoingLeg(
          {
            checkoutId: input.plan.checkoutId,
            planDigest: input.plan.planDigest,
            legId: input.plan.recipients[0]!.legId,
            shouldContinue: () => true,
          },
          {
            repository,
            walletManager: { estimateCheckoutLightningFee: async () => 1 },
            resolveInvoice: (request) => {
              const receiver = qualifiedReceiverFixture({
                lud16: request.lud16,
                amountSats: request.amountSats,
                nowSeconds: NOW / 1_000,
                preimageByte: 2,
              })
              receiverInvoices.set(receiver.paymentRequest, receiver)
              return resolveCheckoutSparkFixtureInvoice(
                request,
                receiver.paymentRequest
              )
            },
            acknowledgeRecoverySnapshot: async () => {},
            nowMs: () => NOW + 3_000,
          }
        )
        const paidFeeSats = guest ? 0 : 1
        const { target, observation } = merchantPayout(
          prepared.state,
          paidFeeSats
        )
        await repository.assertLocalInvoiceOrigin(input.plan, target)
        const receiver = receiverInvoices.get(target.intent.paymentRequest)!
        const recipient = await verifyCheckoutSparkInvoiceRecipient(
          {
            plan: input.plan,
            target,
            now: NOW + 4_000,
            assertCurrent: () => {},
          },
          {
            contracts: receiver.contracts,
            fetchMetadata: async () => receiver.metadata,
            fetchVerify: async () =>
              receiver.verifier(observation.status === "paid"),
          }
        )
        if (recipient.status !== "verified" || !recipient.settled)
          throw new Error("Expected independent ordinary recipient settlement")
        await repository.recordInvoiceRecipientVerification(
          input.plan,
          target,
          recipient.proof,
          () => {}
        )
        const settlement = await repository.recordMerchantPayout(
          input.plan,
          target,
          observation,
          NOW + 4_000
        )
        expect(settlement.paidLegs[0]?.recipientVerified).toBe(true)
        const snapshot = await repository.load(
          input.plan.checkoutId,
          input.plan.planDigest
        )
        const projection = assessCheckoutSparkBuyerSettlement({
          ...input,
          guestIdentity: input.identity,
          now: NOW + 5_000,
          snapshot,
          settlement,
        })
        // Provider-recorded payout facts can lead the saved reconciliation phase.
        expect(
          snapshot.status === "active" && snapshot.state.legs[0]?.status
        ).toBe("prepared")
        expect(projection).toMatchObject({
          commerceVerified: true,
          merchantVerified: true,
          feePending: true,
          recipientUnverified: false,
        })
        expect(projection?.receipt).toEqual({
          creditedSats: input.credit.creditedSats,
          rows: prepared.state.plan.recipients.map((recipient) => ({
            legId: recipient.legId,
            kind: recipient.kind,
            allocationSats: prepared.state.legs.find(
              (leg) => leg.legId === recipient.legId
            )!.allocationSats,
            payment:
              recipient.kind === "merchant"
                ? {
                    invoiceAmountSats: target.intent.invoiceAmountSats,
                    feeSats: paidFeeSats,
                    debitSats: target.intent.invoiceAmountSats + paidFeeSats,
                    recipientVerified: true,
                    observedAt: NOW + 4_000,
                  }
                : null,
          })),
          recordedPaidSats: target.intent.invoiceAmountSats,
          recordedFeeSats: paidFeeSats,
          recordedDebitSats: target.intent.invoiceAmountSats + paidFeeSats,
          recordedUnspentSats: null,
          allPayoutsRecorded: false,
        })
        expect(
          assessCheckoutSparkRetiredBuyerSettlement({
            ...input,
            guestIdentity: input.identity,
            now: NOW + 5_000,
            buyerBinding,
            summary: createCheckoutSparkRetiredSettlementSummary(
              prepared.state
            ),
            settlement,
          })
        ).toEqual(projection)

        const paidLooking = recordCheckoutSparkSettledLegStatus(
          prepared.state,
          {
            legId: target.legId,
            transferId: target.intent.transferId,
            paymentHash: target.intent.paymentHash,
            status: "paid",
            observedAt: NOW + 4_000,
            finalFeeSats: paidFeeSats,
            finalDebitSats: target.intent.invoiceAmountSats + paidFeeSats,
          }
        )
        const unrecorded = assessCheckoutSparkBuyerSettlement({
          ...input,
          guestIdentity: input.identity,
          now: NOW + 5_000,
          snapshot: { status: "active", state: paidLooking, revision: 1 },
          settlement: { ...settlement, paidLegs: [] },
        })
        expect(unrecorded?.receipt).toMatchObject({
          recordedPaidSats: 0,
          recordedFeeSats: 0,
          recordedDebitSats: 0,
          recordedUnspentSats: null,
          allPayoutsRecorded: false,
        })
        expect(
          unrecorded?.receipt?.rows.every((row) => row.payment === null)
        ).toBe(true)

        for (const changed of [
          {
            ...settlement,
            paidLegs: [
              { ...settlement.paidLegs[0]!, transferId: "different-transfer" },
            ],
          },
          {
            ...settlement,
            paidLegs: [
              {
                ...settlement.paidLegs[0]!,
                allocationSats: target.allocationSats + 1,
              },
            ],
          },
        ]) {
          expect(
            assessCheckoutSparkBuyerSettlement({
              ...input,
              guestIdentity: input.identity,
              now: NOW + 5_000,
              snapshot,
              settlement: changed,
            })
          ).toBeNull()
          expect(
            assessCheckoutSparkRetiredBuyerSettlement({
              ...input,
              guestIdentity: input.identity,
              now: NOW + 5_000,
              buyerBinding,
              summary: createCheckoutSparkRetiredSettlementSummary(
                prepared.state
              ),
              settlement: changed,
            })
          ).toBeNull()
        }
        const otherBuyer = getPublicKey(generateSecretKey())
        expect(
          assessCheckoutSparkBuyerSettlement({
            ...input,
            buyerPubkey: otherBuyer,
            guestIdentity: input.identity,
            now: NOW + 5_000,
            snapshot,
            settlement,
          })
        ).toBeNull()
        expect(
          assessCheckoutSparkRetiredBuyerSettlement({
            ...input,
            buyerPubkey: otherBuyer,
            guestIdentity: input.identity,
            now: NOW + 5_000,
            buyerBinding,
            summary: createCheckoutSparkRetiredSettlementSummary(
              prepared.state
            ),
            settlement,
          })
        ).toBeNull()

        const options = getCheckoutSparkBuyerSettlementQueryOptions({
          enabled: true,
          lifecycles: [input.lifecycle],
          buyerPubkey: input.buyerPubkey,
          guestIdentity: input.identity,
          currentGuestIdentity: () => input.identity,
          now: () => NOW + 5_000,
          authGeneration: 1,
          isAuthGenerationCurrent: () => true,
          repository,
        })
        const query = options.queryFn as (context: {
          signal: AbortSignal
        }) => Promise<ReadonlyMap<string, unknown>>
        expect(
          (await query({ signal: new AbortController().signal })).get(
            input.plan.orderId
          )
        ).toEqual(projection)

        // A second device can import the exact state and independently observe
        // its provider debit, but cannot import the first device's LNURL origin.
        await withRepository(async (otherDatabase, importedRepository) => {
          await importedRepository.create(input.plan)
          const importedState = recordCheckoutSparkSettledLegStatus(
            prepared.state,
            {
              legId: target.legId,
              transferId: target.intent.transferId,
              paymentHash: target.intent.paymentHash,
              status: "paid",
              observedAt: NOW + 4_000,
              finalFeeSats: paidFeeSats,
              finalDebitSats: target.intent.invoiceAmountSats + paidFeeSats,
            }
          )
          await importedRepository.save(importedState, 1)
          await importedRepository.recordMerchantCredit(
            input.plan,
            input.credit,
            NOW + 4_000
          )
          await otherDatabase.orderLifecycles.put(input.lifecycle)
          const importedBuyerBinding = await importedRepository.bindBuyerOrder(
            input.plan,
            input.buyerPubkey,
            () => {}
          )
          const importedFacts = await importedRepository.recordMerchantPayout(
            input.plan,
            target,
            observation,
            NOW + 5_000
          )
          expect(importedFacts.paidLegs).toHaveLength(1)
          expect(importedFacts.paidLegs[0]?.recipientVerified).toBeUndefined()
          const unverified = assessCheckoutSparkBuyerSettlement({
            ...input,
            guestIdentity: input.identity,
            now: NOW + 6_000,
            snapshot: await importedRepository.load(
              input.plan.checkoutId,
              input.plan.planDigest
            ),
            settlement: importedFacts,
          })
          expect(unverified).toMatchObject({
            commerceVerified: false,
            merchantVerified: false,
            feePending: true,
            recipientUnverified: true,
          })
          expect(unverified?.receipt?.rows[0]?.payment).toMatchObject({
            invoiceAmountSats: target.intent.invoiceAmountSats,
            recipientVerified: false,
          })
          expect(
            assessCheckoutSparkRetiredBuyerSettlement({
              ...input,
              guestIdentity: input.identity,
              now: NOW + 6_000,
              buyerBinding: importedBuyerBinding,
              summary:
                createCheckoutSparkRetiredSettlementSummary(importedState),
              settlement: importedFacts,
            })
          ).toEqual(unverified)
        })
      })
    }
  )

  it.each([
    "auth_generation",
    "aborted",
    "guest_removed",
    "guest_replaced",
  ] as const)(
    "discards a receipt lookup after %s changes while storage resolves",
    async (change) => {
      const input = fixture(change.startsWith("guest_"))
      await withRepository(async (database, repository) => {
        await repository.create(input.plan)
        await repository.save(input.credited, 1)
        await repository.recordMerchantCredit(
          input.plan,
          input.credit,
          NOW + 2_000
        )
        await database.orderLifecycles.put(input.lifecycle)
        await repository.bindBuyerOrder(input.plan, input.buyerPubkey, () => {})
        let currentGuest = input.identity
        let currentAuth = true
        const controller = new AbortController()
        const options = getCheckoutSparkBuyerSettlementQueryOptions({
          enabled: true,
          lifecycles: [input.lifecycle],
          buyerPubkey: input.buyerPubkey,
          guestIdentity: input.identity,
          currentGuestIdentity: () => currentGuest,
          now: () => NOW + 5_000,
          authGeneration: 1,
          isAuthGenerationCurrent: () => currentAuth,
          repository: {
            async loadBuyerSettlement(...args) {
              const saved = await repository.loadBuyerSettlement(...args)
              if (change === "auth_generation") currentAuth = false
              if (change === "aborted") controller.abort()
              if (change === "guest_removed") currentGuest = null
              if (change === "guest_replaced")
                currentGuest = {
                  ...currentGuest!,
                  createdAt: currentGuest!.createdAt + 1,
                  expiresAt: currentGuest!.expiresAt + 1,
                }
              return saved
            },
          },
        })
        const query = options.queryFn as (context: {
          signal: AbortSignal
        }) => Promise<ReadonlyMap<string, unknown>>
        await expect(
          query({ signal: controller.signal })
        ).rejects.toMatchObject({ name: "AbortError" })
      })
    }
  )
})

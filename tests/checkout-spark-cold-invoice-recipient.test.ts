import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { ConduitDB } from "@conduit/core/db"
import {
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  deriveCheckoutSparkSettledTransferId,
  DexieCheckoutSparkSettledRepository,
  freezeCheckoutSparkSettledPlan,
  getCheckoutSparkSupplierNotifications,
  prepareCheckoutSparkSettledLeg,
  projectCheckoutSparkMerchantSettlement,
  recordCheckoutSparkSettledCredit,
  type CheckoutSparkSettledOutgoingTarget,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import {
  continueMerchantCheckoutSparkSettledPayout,
  reviewMerchantCheckoutSparkSettledPayout,
  type MerchantCheckoutSparkContinuationDependencies,
} from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
import { verifyCheckoutSparkInvoiceRecipient } from "../packages/core/src/protocol/checkout-spark-invoice-recipient"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const CREATED_AT = 1_800_000_000_000
const PREIMAGE = "07".repeat(32)
const PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(PREIMAGE, "hex"))
  .digest("hex")

function invoice(amountSats: number, paymentHash: string) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(Buffer.from(paymentHash, "hex")),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

describe("cold Merchant recovery of an independently attributed saved invoice", () => {
  // Each case signs, delivers and restores multiple private progress snapshots.
  // This test-only budget does not extend provider or product deadlines.
  it.each([
    ["unpaid merchant", false, false],
    ["already-paid merchant", true, false],
    ["unpaid supplier", false, true],
    ["already-paid supplier", true, true],
  ] as const)(
    "reconciles the same %s intent only with independent attribution",
    async (_name, alreadyPaid, supplierMode) => {
      const merchantKey = generateSecretKey()
      const merchant = getPublicKey(merchantKey)
      const recipientKey = supplierMode ? generateSecretKey() : merchantKey
      const recipient = getPublicKey(recipientKey)
      const recipientUsername = supplierMode ? "supplier" : "merchant"
      const buyer = getPublicKey(generateSecretKey())
      const product = finalizeEvent(
        {
          kind: 30402,
          created_at: CREATED_AT / 1_000,
          content: "Synthetic digital item",
          tags: [
            ["d", "cold-recipient"],
            ["price", "1000", "SAT"],
            ["type", "simple", "digital"],
            ...(supplierMode
              ? [
                  ["conduit_supplier_allocation", "1"],
                  ["zap", merchant, "wss://relay.conduit.market", "3"],
                  ["zap", recipient, "wss://relay.conduit.market", "1"],
                ]
              : []),
          ],
        },
        merchantKey
      )
      const profile = finalizeEvent(
        {
          kind: 0,
          created_at: CREATED_AT / 1_000,
          content: JSON.stringify({ lud16: `${recipientUsername}@coinos.io` }),
          tags: [],
        },
        recipientKey
      )
      const merchantProfile = supplierMode
        ? finalizeEvent(
            {
              kind: 0,
              created_at: CREATED_AT / 1_000,
              content: JSON.stringify({ lud16: "merchant@coinos.io" }),
              tags: [],
            },
            merchantKey
          )
        : profile
      const plan = freezeCheckoutSparkSettledPlan({
        checkoutId: "cold-recipient-checkout",
        orderId: "cold-recipient-order",
        merchantPubkey: merchant,
        walletId: "cold-recipient-wallet",
        network: "mainnet",
        createdAt: CREATED_AT,
        takeoverAt: CREATED_AT + 120_000,
        commerceQuote: {
          commerceTotalSats: 1_000,
          lines: [
            {
              productCoordinate: `30402:${merchant}:cold-recipient`,
              productEventId: product.id,
              merchantPubkey: merchant,
              quantity: 1,
              unitMerchandiseSats: 1_000,
              unitShippingSats: 0,
            },
          ],
        },
        funding: {
          requestId: "cold-recipient-receive",
          paymentRequest: invoice(1_113, "03".repeat(32)),
          paymentHash: "03".repeat(32),
          receiverIdentityPublicKey: `02${"f".repeat(64)}`,
          grossFundingSats: 1_113,
          createdAt: CREATED_AT,
          expiresAt: CREATED_AT + 3_600_000,
        },
        recipients: [
          {
            kind: supplierMode ? "supplier" : "merchant",
            recipientId: recipient,
            weightSats: supplierMode ? 250 : 1_000,
            destination: {
              type: "lightning_address",
              value: `${recipientUsername}@coinos.io`,
              source: {
                type: "signed_profile",
                profileEventId: profile.id,
                profileEventCreatedAt: profile.created_at,
              },
            },
          },
          ...(supplierMode
            ? [
                {
                  kind: "merchant" as const,
                  recipientId: merchant,
                  weightSats: 750,
                  destination: {
                    type: "lightning_address" as const,
                    value: "merchant@coinos.io",
                    source: {
                      type: "signed_profile" as const,
                      profileEventId: merchantProfile.id,
                      profileEventCreatedAt: merchantProfile.created_at,
                    },
                  },
                },
              ]
            : []),
          {
            kind: "conduit",
            recipientId: "conduithodlings@strike.me",
            weightSats: 111,
            destination: {
              type: "lightning_address",
              value: "conduithodlings@strike.me",
              source: { type: "conduit_allowlist", policy: "production" },
            },
          },
        ],
      })
      const initial = createCheckoutSparkSettledRecoveryPayload({
        state: createCheckoutSparkSettledReconciliation(plan),
        senderPubkey: buyer,
        mnemonic: createRuntimeMnemonic(),
        accountNumber: 1,
        preparedAt: CREATED_AT + 1_000,
        sourceEvents: supplierMode
          ? [product, profile, merchantProfile]
          : [product, profile],
      })
      const credited = recordCheckoutSparkSettledCredit(initial.state, {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: "cold-recipient-credit",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: 1_113,
        creditedSats: 1_113,
        observedAt: CREATED_AT + 2_000,
      })
      const leg = credited.legs[0]!
      const amountSats = leg.allocationSats! - 1
      const intent = {
        legId: leg.legId,
        transferId: deriveCheckoutSparkSettledTransferId(plan, leg.legId),
        paymentRequest: invoice(amountSats, PAYMENT_HASH),
        paymentHash: PAYMENT_HASH,
        invoiceAmountSats: amountSats,
        maxFeeSats: 1,
        preparedAt: CREATED_AT + 3_000,
      }
      const prepared = prepareCheckoutSparkSettledLeg(credited, intent)
      const latest = createCheckoutSparkSettledRecoveryProgressPayload({
        initialHandoffId: initial.handoffId,
        state: prepared,
        senderPubkey: buyer,
        preparedAt: CREATED_AT + 4_000,
      })
      const selected: MerchantCheckoutSparkRecoveryCandidate = {
        wrapId: "1".repeat(64),
        schemaVersion: 3,
        checkoutId: plan.checkoutId,
        orderId: plan.orderId,
        planDigest: plan.planDigest,
        takeoverAt: plan.takeoverAt,
        preparedAt: latest.preparedAt,
        initialWrapId: "2".repeat(64),
        initialHandoffId: initial.handoffId,
      }
      const database = new ConduitDB(`cold-recipient-${crypto.randomUUID()}`, {
        indexedDB,
        IDBKeyRange,
      })
      let repository = new DexieCheckoutSparkSettledRepository(database)
      const now = plan.takeoverAt + 1_000
      const calls = { sends: 0, cleanups: 0, lookups: 0 }
      let sent = alreadyPaid
      const request = {
        typename: "LightningSendRequest",
        id: "cold-recipient-send",
        status: "LIGHTNING_PAYMENT_SUCCEEDED",
        fee: { originalValue: 1, originalUnit: "SATOSHI" },
        encodedInvoice: intent.paymentRequest,
        idempotencyKey: intent.transferId,
        paymentPreimage: PREIMAGE,
      }
      try {
        // Genuine state restoration and Dexie persistence; only authenticated
        // transport/provider boundaries below are offline deterministic doubles.
        await repository.importMerchantOrderRecovery(
          prepared,
          {
            schemaVersion: 1,
            merchantPubkey: merchant,
            buyerPubkey: buyer,
            orderId: plan.orderId,
            rumorId: "a".repeat(64),
            contentHash: "b".repeat(64),
            checkoutId: plan.checkoutId,
            planDigest: plan.planDigest,
          },
          () => {}
        )
        repository = new DexieCheckoutSparkSettledRepository(database)
        const review = await reviewMerchantCheckoutSparkSettledPayout(
          merchant,
          selected,
          repository
        )
        if (!review) throw new Error("Expected preserved saved intent")
        const target: CheckoutSparkSettledOutgoingTarget = {
          walletId: plan.walletId,
          network: plan.network,
          legId: leg.legId,
          recipientId: recipient,
          allocationSats: leg.allocationSats!,
          unpaidAllocationSats: 1_113,
          intent,
        }
        const dependencies: MerchantCheckoutSparkContinuationDependencies = {
          repository,
          now: () => now,
          lockManager: null,
          requireCrossTabLock: false,
          deriveIdentity: async () => plan.funding.receiverIdentityPublicKey,
          consumeRecovery: async (_principal, candidate, adapter) => {
            await adapter.consumeSettled!(initial, latest, () => {})
            return {
              status: "consumed",
              candidate,
              coverage: "complete",
              discoveryCoverage: "complete",
              declarationState: "declared",
            }
          },
          openWallet: async () => ({
            ensurePrivateReady: async () => {},
            getIdentityPublicKey: async () =>
              plan.funding.receiverIdentityPublicKey,
            getLightningReceiveRequest: async () => ({
              id: plan.funding.requestId,
              status: "TRANSFER_COMPLETED",
              network: "MAINNET",
              invoice: {
                encodedInvoice: plan.funding.paymentRequest,
                bitcoinNetwork: "MAINNET",
                paymentHash: plan.funding.paymentHash,
                amount: { originalValue: 1_113, originalUnit: "SATOSHI" },
              },
              transfer: {
                sparkId: "cold-recipient-credit",
                userRequestId: plan.funding.requestId,
                totalAmount: { originalValue: 1_113, originalUnit: "SATOSHI" },
              },
            }),
            getTransfer: async () => ({
              id: "cold-recipient-credit",
              status: "TRANSFER_STATUS_COMPLETED",
              totalValue: 1_113,
              transferDirection: "INCOMING",
              receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
              userRequest: { id: plan.funding.requestId },
            }),
            getTransferFromSsp: async () =>
              sent
                ? {
                    sparkId: intent.transferId,
                    totalAmount: {
                      originalValue: leg.allocationSats!,
                      originalUnit: "SATOSHI",
                    },
                    userRequest: request,
                  }
                : undefined,
            getLightningSendRequest: async () => (sent ? request : null),
            cleanup: async () => {
              calls.cleanups += 1
            },
            outgoing: {
              getAvailableSats: async () => 1_113n,
              estimateFee: async () => 1,
              sendFrozen: async (parameters) => {
                expect(parameters).toEqual({
                  paymentRequest: intent.paymentRequest,
                  maxFeeSats: intent.maxFeeSats,
                  transferId: intent.transferId,
                })
                calls.sends += 1
                sent = true
                return undefined
              },
            },
          }),
        }
        const run = () =>
          continueMerchantCheckoutSparkSettledPayout(
            merchant,
            selected,
            review,
            dependencies
          )
        expect(await repository.hasInvoiceOrigin(plan, target)).toBe(false)
        const beforeAttribution = (await run()).payout
        if (alreadyPaid) {
          expect(beforeAttribution).toMatchObject({
            outcome: "already_paid",
            sendAttempted: false,
          })
          const facts = await repository.loadMerchantSettlement(
            merchant,
            plan.checkoutId,
            plan.planDigest
          )
          expect(facts?.paidLegs).toHaveLength(1)
          expect(facts?.paidLegs[0]?.recipientVerified).not.toBe(true)
          expect(getCheckoutSparkSupplierNotifications(plan, facts!)).toEqual(
            []
          )
          expect(
            (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
              ?.supplierNotificationIntents ?? []
          ).toEqual([])
        } else {
          expect(beforeAttribution).toEqual({
            outcome: "wait",
            reason: "recipient_unverified",
            sendAttempted: false,
          })
        }
        expect(calls.sends).toBe(0)

        const attribution = await verifyCheckoutSparkInvoiceRecipient(
          { plan, target, now, assertCurrent: () => {} },
          {
            fetchInvoiceRecord: async (url) => {
              expect(new URL(url).origin).toBe("https://coinos.io")
              calls.lookups += 1
              return {
                type: "lightning",
                text: intent.paymentRequest,
                hash: intent.paymentRequest,
                paymentHash: PAYMENT_HASH,
                amount: amountSats,
                uid: "synthetic-merchant-account",
                user: {
                  id: "synthetic-merchant-account",
                  username: recipientUsername,
                  lud16: `${recipientUsername}@coinos.io`,
                },
              }
            },
          }
        )
        expect(attribution.status).toBe("verified")
        if (attribution.status !== "verified")
          throw new Error("Expected independent recipient attribution")
        // This must not manufacture buyer-local LNURL evidence or rewrite the
        // imported intent. The separate provider proof is independently durable.
        await repository.recordInvoiceRecipientVerification(
          plan,
          target,
          attribution.proof,
          () => {}
        )
        repository = new DexieCheckoutSparkSettledRepository(database)
        dependencies.repository = repository
        expect(await repository.hasInvoiceOrigin(plan, target)).toBe(false)
        // A provider-paid row is upgraded by attribution alone, without another
        // provider call or send; notices become eligible in the same transaction.
        if (alreadyPaid) {
          const facts = await repository.loadMerchantSettlement(
            merchant,
            plan.checkoutId,
            plan.planDigest
          )
          expect(facts?.paidLegs[0]?.recipientVerified).toBe(true)
          expect(calls.sends).toBe(0)
          const notices = getCheckoutSparkSupplierNotifications(plan, facts!)
          expect(notices).toHaveLength(supplierMode ? 1 : 0)
          expect(
            (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
              ?.supplierNotificationIntents
          ).toEqual(notices)
          if (supplierMode)
            expect(notices[0]).toMatchObject({
              supplierPubkey: recipient,
              amountSats,
            })
        } else {
          const facts = await repository.loadMerchantSettlement(
            merchant,
            plan.checkoutId,
            plan.planDigest
          )
          expect(facts?.paidLegs).toEqual([])
          expect(getCheckoutSparkSupplierNotifications(plan, facts!)).toEqual(
            []
          )
        }
        expect((await run()).payout).toMatchObject({
          outcome: alreadyPaid ? "already_paid" : "paid",
          sendAttempted: !alreadyPaid,
        })
        expect(calls.sends).toBe(alreadyPaid ? 0 : 1)
        expect(calls.lookups).toBe(1)
        const saved = await repository.load(plan.checkoutId, plan.planDigest)
        expect(saved.status === "active" && saved.state.legs[0]).toMatchObject({
          status: "paid",
          intent,
        })
        const facts = await repository.loadMerchantSettlement(
          merchant,
          plan.checkoutId,
          plan.planDigest
        )
        expect(projectCheckoutSparkMerchantSettlement(facts!)).toMatchObject({
          merchantVerified: !supplierMode,
          commerceVerified: !supplierMode,
        })
        expect((await run()).payout?.outcome).toBe("already_paid")
        expect(calls.sends).toBe(alreadyPaid ? 0 : 1)
        const finalFacts = await repository.loadMerchantSettlement(
          merchant,
          plan.checkoutId,
          plan.planDigest
        )
        const finalNotices = getCheckoutSparkSupplierNotifications(
          plan,
          finalFacts!
        )
        expect(finalNotices).toHaveLength(supplierMode ? 1 : 0)
        expect(
          (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
            ?.supplierNotificationIntents
        ).toEqual(finalNotices)
      } finally {
        database.close()
        await database.delete()
      }
    },
    15_000
  )
})

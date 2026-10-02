import { describe, expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { createHash } from "node:crypto"
import { NDKEvent, NDKUser } from "@nostr-dev-kit/ndk"
import {
  clearTestAccountSigner,
  setTestAccountSigner,
} from "./helpers/plain-signer"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  calculateCheckoutSparkSettledGrossFundingSats,
  calculateConduitCheckoutFeeSats,
  createCheckoutSparkSettledReconciliation,
  createMerchantCheckoutSparkRecoveryDiscovery,
  deriveCheckoutSparkSignedCommerceObligations,
  DexieCheckoutSparkSettledRepository,
  DexieMerchantCheckoutSparkProgressRepository,
  freezeCheckoutSparkSettledPlan,
  getMerchantCheckoutSparkRecoveryList,
  getNdk,
  openCheckoutSparkMerchantProgressWrap,
  orderSchema,
  projectCheckoutSparkMerchantSettlement,
  wrapPrivateMessage,
  type MerchantCheckoutSparkProgressTransport,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  __resetProtectedReadSigner,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type { ProtectedInboxReadResult } from "../packages/core/src/protocol/protected-inbox-read"
import { buildCheckoutSparkCommerceEvidence } from "../apps/market/src/lib/checkout-spark-commerce-evidence"
import {
  getCheckoutSparkRecoveryDelivery,
  publishCheckoutSparkSettledRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import {
  continueMerchantCheckoutSparkSettledPayout,
  selectMerchantCheckoutSparkSignedNextPayout,
} from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
import { prepareNextMerchantCheckoutSparkSettledPayout } from "../apps/merchant/src/lib/checkout-spark-settled-leg-preparation"
import { advanceMerchantCheckoutSparkOrder } from "../apps/merchant/src/lib/checkout-spark-order-reconciliation"
import {
  deriveMerchantCheckoutSparkRecoveryIdentity,
  retireMerchantCheckoutSparkSettledRecovery,
  type MerchantSparkRecoveryWallet,
} from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import { createCheckoutSparkGuestSupplierFixture } from "./support/checkout-spark-guest-supplier-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const INBOX = "wss://merchant.inbox.relay.dev"
const MNEMONIC = createRuntimeMnemonic()

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

function invoice(
  amountSats: number,
  hash: Uint8Array,
  now: number,
  funding = false
) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: Math.floor(now / 1_000),
    fields: [
      bolt11PaymentHashField(hash),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      ...(funding ? [{ tag: "x", words: [28, 4] }] : []),
    ],
  })
}

function protectedRead(
  events: SignedPublicNostrEvent[]
): ProtectedInboxReadResult {
  return {
    events,
    coverage: "complete",
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status: "success",
      observations: [],
      relays: [
        {
          relayIndex: 0,
          status: "success",
          auth: "not_challenged",
          eventCount: events.length,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
        },
      ],
      attemptedCount: 1,
      completedCount: 1,
      failedCount: 0,
      authoritativeEmpty: events.length === 0,
    },
  }
}

describe("offline cold Merchant guest supplier recovery", () => {
  it.each([false, true])(
    "restores before any buyer payout and completes commerce before Conduit without replay (physical=%s)",
    async (physical) => {
      const createdAt = Math.floor(Date.now() / 1_000) * 1_000 - 46 * 60_000
      let now = createdAt + 1_000
      const fixture = createCheckoutSparkGuestSupplierFixture(
        createdAt,
        physical
      )
      const session = new MemoryStorage()
      const buyerStorage = new MemoryStorage()
      const guest = createSessionGuestOrderSigningIdentity(
        "cold-merchant-order",
        fixture.merchantPubkey,
        { storage: session, nowMs: createdAt }
      )
      const quote = buildCheckoutSparkCommerceEvidence(fixture.quoteAuthority)
      const obligations = deriveCheckoutSparkSignedCommerceObligations({
        quote,
        products: fixture.products,
        shippingEvents: fixture.quoteAuthority.shippingSourceEvents,
        merchantPubkey: fixture.merchantPubkey,
      })
      const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
        MNEMONIC,
        1
      )
      const grossSats = calculateCheckoutSparkSettledGrossFundingSats(
        quote.commerceTotalSats
      )
      const plan = freezeCheckoutSparkSettledPlan({
        checkoutId: "cold-merchant-checkout",
        orderId: guest.orderId,
        merchantPubkey: fixture.merchantPubkey,
        walletId: "cold-merchant-wallet",
        network: "mainnet",
        createdAt,
        takeoverAt: createdAt + 45 * 60_000,
        commerceQuote: quote,
        funding: {
          requestId: "cold-merchant-receive",
          paymentRequest: invoice(
            grossSats,
            new Uint8Array(32).fill(3),
            createdAt,
            true
          ),
          paymentHash: "03".repeat(32),
          receiverIdentityPublicKey: identity,
          grossFundingSats: grossSats,
          createdAt,
          expiresAt: createdAt + 900_000,
        },
        recipients: [
          ...obligations.map((obligation) => {
            const profile =
              obligation.kind === "merchant"
                ? fixture.merchantProfile
                : fixture.supplierProfile
            return {
              kind: obligation.kind,
              recipientId: obligation.recipientId,
              weightSats: obligation.amountSats,
              destination: {
                type: "lightning_address" as const,
                value:
                  fixture.profileContexts[obligation.recipientId]!.profile
                    .lud16!,
                source: {
                  type: "signed_profile" as const,
                  profileEventId: profile.id,
                  profileEventCreatedAt: profile.created_at,
                },
              },
            }
          }),
          {
            kind: "conduit",
            recipientId: "conduithodlings@strike.me",
            weightSats: calculateConduitCheckoutFeeSats(
              quote.commerceTotalSats
            ),
            destination: {
              type: "lightning_address",
              value: "conduithodlings@strike.me",
              source: { type: "conduit_allowlist", policy: "production" },
            },
          },
        ],
      })
      const initialState = createCheckoutSparkSettledReconciliation(plan)
      const relayEvents = new Map<string, SignedPublicNostrEvent>()
      const relayAccepted = {
        attemptedRelayUrls: [INBOX],
        successfulRelayUrls: [INBOX],
        failedRelayUrls: [],
        relayFailureMessages: {},
      }
      const database = new ConduitDB(`cold-merchant-${crypto.randomUUID()}`, {
        indexedDB,
        IDBKeyRange,
      })
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const progressStore = new DexieMerchantCheckoutSparkProgressRepository(
        database
      )
      const calls = {
        opens: 0,
        cleanups: 0,
        receives: 0,
        resolutions: [] as string[],
        sends: [] as string[],
        snapshots: 0,
      }

      try {
        const merchantSigner = setTestAccountSigner(fixture.merchantSigner)
        const handoff = await publishCheckoutSparkSettledRecoveryHandoff({
          state: initialState,
          sourceEvents: fixture.sourceEvents,
          recovery: {
            mnemonic: MNEMONIC,
            accountNumber: 1,
            network: "mainnet",
          },
          identity: guest,
          preparedAt: now,
          now: () => now,
          storage: buyerStorage,
          transport: {
            recipientInboxRelays: [INBOX],
            accountNetworkLocalStateRepository: { get: async () => undefined },
            publishFn: async (event) => {
              relayEvents.set(
                event.id,
                event.rawEvent() as SignedPublicNostrEvent
              )
              return relayAccepted
            },
          },
        })
        expect(
          getCheckoutSparkRecoveryDelivery(handoff.handoffId, buyerStorage)!
            .deliveryProgress.acknowledgedRelayRefs
        ).toHaveLength(1)
        const order = orderSchema.parse({
          id: plan.orderId,
          buyerPubkey: guest.pubkey,
          buyerIdentityKind: "guest_ephemeral",
          merchantPubkey: plan.merchantPubkey,
          items: fixture.quoteAuthority.pricing.items,
          subtotal: quote.commerceTotalSats,
          currency: "SATS",
          shippingCostSats:
            fixture.quoteAuthority.pricing.shippingCost.totalSats,
          shippingCostStatus:
            fixture.quoteAuthority.pricing.shippingCost.status,
          ...(physical
            ? {
                shippingAddress: {
                  name: "Synthetic Buyer",
                  street: "123 Main Street",
                  city: "New York",
                  state: "NY",
                  postalCode: "10001",
                  country: "US",
                },
              }
            : {}),
          guestContact: { email: "guest@example.test", phone: "+12025550123" },
          createdAt: now,
        })
        const orderRumor = new NDKEvent(getNdk())
        orderRumor.kind = 16
        orderRumor.pubkey = guest.pubkey
        orderRumor.created_at = Math.floor(now / 1_000)
        orderRumor.tags = [
          ["p", plan.merchantPubkey],
          ["type", "order"],
          ["order", plan.orderId],
          ["amount", String(order.subtotal)],
          ["currency", "SATS"],
          [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
          ...order.items.flatMap((item) => [
            ["item", item.productId, String(item.quantity)],
            ...(item.shippingOptionId
              ? [["shipping", item.shippingOptionId]]
              : []),
          ]),
        ]
        orderRumor.content = JSON.stringify(order)
        orderRumor.id = orderRumor.getEventHash()
        const orderWrap = await wrapPrivateMessage(
          orderRumor,
          new NDKUser({ pubkey: plan.merchantPubkey }),
          guest.signer
        )
        relayEvents.set(
          orderWrap.id,
          orderWrap.rawEvent() as SignedPublicNostrEvent
        )

        // The external funding is visible only in provider history. No buyer
        // progress, prepared invoice, local origin or browser storage is restored.
        session.values.clear()
        buyerStorage.values.clear()
        now = plan.takeoverAt + 1_000
        expect(await database.checkoutSparkPlanBindings.count()).toBe(0)
        installProtectedReadSigner(
          merchantSigner,
          plan.merchantPubkey,
          () => true
        )
        __setCommerceTestOverrides({
          getAccountSigner: () => merchantSigner,
          now: () => now,
          checkoutSparkSettledRepository: repository,
          resolveInboxRelayUrls: async () => [INBOX],
          readProtectedInbox: async (options) =>
            protectedRead(
              [...relayEvents.values()].filter(
                (event) => !options.eventId || event.id === options.eventId
              )
            ),
          readCheckoutSparkPlanSourceEvents: async () => {
            throw new Error(
              "Original signed sources must come from the encrypted initial bundle"
            )
          },
        })
        const discovery = await createMerchantCheckoutSparkRecoveryDiscovery(
          plan.merchantPubkey,
          {
            async onOrderRecovery({
              state,
              witness,
              sourceEvents,
              assertCurrent,
            }) {
              expect(state).toEqual(initialState)
              expect(sourceEvents).toEqual(fixture.sourceEvents)
              expect(witness.buyerPubkey).toBe(guest.pubkey)
              await repository.importMerchantOrderRecovery(
                state,
                witness,
                assertCurrent
              )
              await repository.recordMerchantPlanSources(
                state.plan,
                sourceEvents,
                assertCurrent
              )
            },
          }
        )
        try {
          const found = await discovery.nextPage()
          expect(found.candidates).toHaveLength(1)
          expect(found.orderBindingFailureCount ?? 0).toBe(0)
          expect(found.decryptFailureCount).toBe(0)
        } finally {
          discovery.dispose()
        }
        const imported = await repository.load(plan.checkoutId, plan.planDigest)
        expect(imported.status).toBe("active")
        if (imported.status !== "active")
          throw new Error("Expected cold import")
        expect(imported.state.credit).toBeNull()
        expect(imported.state.legs.every((leg) => leg.intent === null)).toBe(
          true
        )
        expect(
          (await database.checkoutSparkPlanBindings.get(plan.checkoutId))
            ?.invoiceOrigins
        ).toBeUndefined()
        expect(calls.opens).toBe(0)

        const details = new Map<
          string,
          { preimage: string; amountSats: number }
        >()
        type SendRequest = NonNullable<
          Awaited<
            ReturnType<
              NonNullable<
                MerchantSparkRecoveryWallet["getLightningSendRequest"]
              >
            >
          >
        >
        const sent = new Map<string, SendRequest>()
        let availableSats = grossSats
        const progressTransport: MerchantCheckoutSparkProgressTransport = {
          recipientInboxRelays: [INBOX],
          accountNetworkLocalStateRepository: { get: async () => undefined },
          publishFn: async (event, options) => {
            expect(options.exclusiveRelayUrls).toEqual([INBOX])
            expect(options.appRelayUrls).toEqual([])
            const staged = await progressStore.list(
              plan.merchantPubkey,
              plan.checkoutId,
              plan.planDigest
            )
            expect(
              staged.some(
                (entry) => entry.record.signedRecipientWrap.id === event.id
              )
            ).toBe(true)
            const raw = event.rawEvent() as SignedPublicNostrEvent
            const opened = await openCheckoutSparkMerchantProgressWrap({
              signedRecipientWrap: raw,
              signer: merchantSigner,
            })
            expect(opened.payload.initialHandoffId).toBe(handoff.handoffId)
            expect(opened.payload.merchantPubkey).toBe(plan.merchantPubkey)
            const text = JSON.stringify(opened.payload)
            expect(text).not.toContain(MNEMONIC)
            expect(text).not.toContain("guest@example.test")
            expect(text).not.toContain("invoiceOrigins")
            relayEvents.set(event.id, raw)
            calls.snapshots += 1
            return relayAccepted
          },
        }
        const wallet: MerchantSparkRecoveryWallet = {
          ensurePrivateReady: async () => {},
          getIdentityPublicKey: async () => identity,
          getLightningReceiveRequest: async (id) => {
            expect(id).toBe(plan.funding.requestId)
            calls.receives += 1
            return {
              id,
              status: "TRANSFER_COMPLETED",
              network: "MAINNET",
              invoice: {
                encodedInvoice: plan.funding.paymentRequest,
                bitcoinNetwork: "MAINNET",
                paymentHash: plan.funding.paymentHash,
                amount: { originalValue: grossSats, originalUnit: "SATOSHI" },
              },
              transfer: {
                sparkId: "cold-merchant-credit",
                userRequestId: id,
                totalAmount: {
                  originalValue: grossSats,
                  originalUnit: "SATOSHI",
                },
              },
            }
          },
          getTransfer: async (id) => ({
            id,
            status: "TRANSFER_STATUS_COMPLETED",
            totalValue: grossSats,
            transferDirection: "INCOMING",
            receiverIdentityPublicKey: identity,
            userRequest: { id: plan.funding.requestId },
          }),
          getTransferFromSsp: async (id) => {
            const request = sent.get(id)
            return request
              ? {
                  sparkId: id,
                  totalAmount: {
                    originalValue:
                      details.get(request.encodedInvoice)!.amountSats + 1,
                    originalUnit: "SATOSHI",
                  },
                  userRequest: request,
                }
              : undefined
          },
          getLightningSendRequest: async (id) =>
            [...sent.values()].find((request) => request.id === id) ?? null,
          openRetirementReader: async () => ({
            sparkAddress: "synthetic-owned-address",
            reader: {
              getTransfers: async () => ({
                transfers: ["cold-merchant-credit", ...sent.keys()].map(
                  (id) => ({
                    id,
                    status: 5,
                    type: 1,
                    network: 1,
                    totalValue: grossSats,
                  })
                ),
                offset: -1,
              }),
              getAvailableBalance: async () => BigInt(availableSats),
              getOwnedBalance: async () => BigInt(availableSats),
              getPendingTransfers: async () => [],
            },
          }),
          estimateLightningFee: async () => 1,
          cleanup: async () => {
            calls.cleanups += 1
          },
          outgoing: {
            getAvailableSats: async () => BigInt(availableSats),
            estimateFee: async () => 1,
            sendFrozen: async (request) => {
              const saved = await repository.load(
                plan.checkoutId,
                plan.planDigest
              )
              if (saved.status !== "active")
                throw new Error("Expected durable payout")
              const leg = saved.state.legs.find(
                (candidate) =>
                  candidate.intent?.transferId === request.transferId
              )!
              expect(leg.status).toBe("submitted")
              expect(sent.has(request.transferId)).toBe(false)
              expect(request.paymentRequest).toBe(leg.intent!.paymentRequest)
              expect(request.maxFeeSats).toBe(leg.intent!.maxFeeSats)
              const info = details.get(request.paymentRequest)!
              expect(info.amountSats + 1).toBeLessThanOrEqual(
                leg.allocationSats!
              )
              const retained = await progressStore.list(
                plan.merchantPubkey,
                plan.checkoutId,
                plan.planDigest
              )
              expect(
                retained.some(
                  (entry) =>
                    entry.relayAccepted &&
                    entry.record.recordedAt === saved.state.updatedAt
                )
              ).toBe(true)
              if (leg.legId === plan.recipients[2]!.legId) {
                expect(calls.sends).toEqual(
                  plan.recipients
                    .slice(0, 2)
                    .map((recipient) => recipient.legId)
                )
                const facts = await repository.loadMerchantSettlement(
                  plan.merchantPubkey,
                  plan.checkoutId,
                  plan.planDigest
                )
                expect(
                  projectCheckoutSparkMerchantSettlement(facts!)
                    .commerceVerified
                ).toBe(true)
              }
              calls.sends.push(leg.legId)
              sent.set(request.transferId, {
                typename: "LightningSendRequest",
                id: `send-${calls.sends.length}`,
                status: "LIGHTNING_PAYMENT_SUCCEEDED",
                fee: { originalValue: 1, originalUnit: "SATOSHI" },
                encodedInvoice: request.paymentRequest,
                idempotencyKey: request.transferId,
                paymentPreimage: info.preimage,
              })
              availableSats -= info.amountSats + 1
              return undefined
            },
          },
        }
        const dependencies = {
          repository,
          progressStore,
          progressTransport,
          signer: merchantSigner,
          now: () => now,
          shouldContinue: () => true,
          lockManager: null,
          requireCrossTabLock: false,
          openWallet: async (
            input: Parameters<
              typeof import("../apps/merchant/src/lib/checkout-spark-settled-recovery").openMerchantCheckoutSparkRecoveryWallet
            >[0]
          ) => {
            expect(input.mnemonic).toBe(MNEMONIC)
            expect(input.accountNumber).toBe(1)
            expect(input.network).toBe("mainnet")
            calls.opens += 1
            return input.outgoing ? wallet : { ...wallet, outgoing: undefined }
          },
        }
        const discover = async () => {
          const found = await getMerchantCheckoutSparkRecoveryList(
            plan.merchantPubkey
          )
          expect(found.conflictCount).toBe(0)
          expect(found.decryptFailureCount).toBe(0)
          expect(found.candidates).toHaveLength(1)
          return found.candidates[0]!
        }
        for (const [index, recipient] of plan.recipients.entries()) {
          now += 1_000
          const prepared = await prepareNextMerchantCheckoutSparkSettledPayout(
            plan.merchantPubkey,
            await discover(),
            { shouldContinue: () => true },
            {
              ...dependencies,
              resolveInvoice: async (input) => {
                expect(input.lud16).toBe(recipient.destination.value)
                calls.resolutions.push(input.lud16)
                const preimage = new Uint8Array(32).fill(index + 10)
                const hash = createHash("sha256").update(preimage).digest()
                const paymentRequest = invoice(input.amountSats, hash, now)
                details.set(paymentRequest, {
                  preimage: Buffer.from(preimage).toString("hex"),
                  amountSats: input.amountSats,
                })
                return resolveCheckoutSparkFixtureInvoice(input, paymentRequest)
              },
            }
          )
          expect(prepared.status).toBe("attempted")
          if (prepared.status !== "attempted")
            throw new Error("Expected Merchant preparation attempt")
          expect(prepared.recovery.preparation?.status).toBe("prepared")
          expect(calls.sends).toHaveLength(index)
          const selected = await discover()
          expect(selected.merchantProgress).toBeDefined()
          const selection = await selectMerchantCheckoutSparkSignedNextPayout(
            plan.merchantPubkey,
            selected,
            () => {},
            { repository, now: () => now }
          )
          expect(selection.status).toBe("ready")
          if (selection.status !== "ready")
            throw new Error("Expected restored Merchant intent")
          const payout = await continueMerchantCheckoutSparkSettledPayout(
            plan.merchantPubkey,
            selected,
            selection.review,
            dependencies
          )
          expect(payout.payout).toEqual({
            outcome: "paid",
            reason: undefined,
            sendAttempted: true,
          })
          expect(calls.sends).toHaveLength(index + 1)
          const facts = await repository.loadMerchantSettlement(
            plan.merchantPubkey,
            plan.checkoutId,
            plan.planDigest
          )
          expect(projectCheckoutSparkMerchantSettlement(facts!)).toEqual({
            creditVerified: true,
            merchantVerified: true,
            commerceVerified: index >= 1,
            feePending: index < 2,
            recipientUnverified: false,
          })
          expect(
            facts!.paidLegs.every((leg) => leg.recipientVerified === true)
          ).toBe(true)
          const replay = await continueMerchantCheckoutSparkSettledPayout(
            plan.merchantPubkey,
            await discover(),
            selection.review,
            dependencies
          )
          expect(replay.payout?.sendAttempted).toBe(false)
          expect(calls.sends).toHaveLength(index + 1)
        }
        expect(calls.resolutions).toEqual(
          plan.recipients.map((recipient) => recipient.destination.value)
        )
        expect(calls.sends).toEqual(
          plan.recipients.map((recipient) => recipient.legId)
        )
        expect(calls.opens).toBe(calls.cleanups)
        expect(calls.receives).toBeGreaterThan(0)
        expect(calls.snapshots).toBeGreaterThanOrEqual(9)
        expect(availableSats).toBe(0)
        expect(
          (await repository.load(plan.checkoutId, plan.planDigest)).status
        ).toBe("active")
        expect(await database.checkoutSparkRetirements.count()).toBe(0)
        expect(await database.orderLifecycles.count()).toBe(0)
        expect(await database.wallets.count()).toBe(0)
        // Zero balance alone does not establish complete claim/refund terminality.
        now += 1_000
        const incompleteHistory =
          await retireMerchantCheckoutSparkSettledRecovery(
            plan.merchantPubkey,
            await discover(),
            {
              ...dependencies,
              openWallet: async (input) => ({
                ...(await dependencies.openWallet(input)),
                getLightningSendRequest: async () => null,
              }),
            }
          )
        expect(incompleteHistory.status).toBe("consumed")
        expect(incompleteHistory.retirementStatus).toBe("pending")
        expect(
          (await repository.load(plan.checkoutId, plan.planDigest)).status
        ).toBe("active")
        expect(calls.sends).toHaveLength(3)
        now += 1_000
        const retireCandidate = await discover()
        const retired = await advanceMerchantCheckoutSparkOrder(
          plan.merchantPubkey,
          retireCandidate,
          () => {},
          {
            repository,
            now: () => now,
            requestRescan: () => {
              throw new Error("Retirement must not start another phase")
            },
            retireWallet: (principal, selected, options) =>
              retireMerchantCheckoutSparkSettledRecovery(principal, selected, {
                ...dependencies,
                ...options,
              }),
          }
        )
        expect(retired).toBe("retired")
        expect(
          (await repository.load(plan.checkoutId, plan.planDigest)).status
        ).toBe("retired")
        const retained = await repository.loadMerchantSettlement(
          plan.merchantPubkey,
          plan.checkoutId,
          plan.planDigest
        )
        expect(
          projectCheckoutSparkMerchantSettlement(retained!).commerceVerified
        ).toBe(true)
        expect(calls.sends).toHaveLength(3)
        expect(calls.opens).toBe(calls.cleanups)
        const opensAfterRetirement = calls.opens
        expect(
          await advanceMerchantCheckoutSparkOrder(
            plan.merchantPubkey,
            retireCandidate,
            () => {},
            {
              repository,
              now: () => now,
              requestRescan: () => {
                throw new Error("Retired checkout cannot request execution")
              },
              retireWallet: async () => {
                throw new Error("Retired checkout cannot reopen its wallet")
              },
            }
          )
        ).toBe("retired")
        expect(calls.opens).toBe(opensAfterRetirement)
      } finally {
        clearTestAccountSigner()
        __resetCommerceTestOverrides()
        __resetProtectedReadSigner()
        database.close()
        await database.delete()
      }
    },
    45_000
  )
})

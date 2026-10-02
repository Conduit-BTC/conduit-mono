import { describe, expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { createHash } from "node:crypto"
import { NDKEvent, NDKUser } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { wrapPrivateMessage } from "../packages/core/src/protocol/messaging"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  createCheckoutSparkMerchantOrderWitness,
  DexieCheckoutSparkSettledRepository,
  fetchLnurlPayMetadata,
  getNdk,
  openCheckoutSparkRecoveryDelivery,
  parseOrderMessageRumorEvent,
  projectCheckoutSparkMerchantSettlement,
  readCheckoutSparkMerchantOrderEvidence,
  unwrapGiftWrap,
  validateCheckoutSparkPlanSources,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledReconciliation,
  type OrderRelayDeliveryRepository,
} from "@conduit/core"
import { publishCheckoutSparkSettledBoundOrder } from "../apps/market/src/lib/checkout-spark-bound-order"
import { readCheckoutSparkRecipientPayoutAddress } from "../apps/market/src/lib/checkout-spark-recipient-profile"
import {
  acknowledgeOrRetryCheckoutSparkSettledSnapshot,
  getCheckoutSparkRecoveryDelivery,
  listCheckoutSparkRecoveryDeliveries,
  publishCheckoutSparkSettledRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import { prepareCheckoutSparkSettledDigitalOrder } from "../apps/market/src/lib/checkout-spark-settled-entry"
import { createCheckoutSparkSettledFundingBridge } from "../apps/market/src/lib/checkout-spark-settled-funding"
import { prepareCheckoutSparkSettledOutgoingLeg } from "../apps/market/src/lib/checkout-spark-settled-leg-preparation"
import { createCheckoutSparkSettledOutgoingProvider } from "../apps/market/src/lib/checkout-spark-settled-outgoing-provider"
import {
  getCheckoutSparkSettledPreparation,
  loadAuthorizedCheckoutSparkSettledFunding,
  prepareCheckoutSparkSettledFunding,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import { advanceCheckoutSparkSettledShopper } from "../apps/market/src/lib/checkout-spark-settled-shopper-advance"
import {
  createSessionGuestOrderSigningIdentity,
  getSessionGuestOrderSigningIdentity,
} from "../apps/market/src/lib/guest-order-identity"
import { publishBuyerOrderMessage } from "../apps/market/src/lib/order-publish"
import type { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
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

const RELAYS = ["wss://merchant.inbox.relay.dev"]
const MNEMONIC = createRuntimeMnemonic()

class MemoryStorage {
  private readonly values = new Map<string, string>()
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
  paymentHash: Uint8Array,
  now: number,
  funding = false
) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: Math.floor(now / 1_000),
    fields: [
      bolt11PaymentHashField(paymentHash),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      ...(funding ? [{ tag: "x", words: [28, 4] }] : []),
    ],
  })
}

/** Same durable order adapter contract as production, isolated to this test DB. */
function orderRepository(database: ConduitDB): OrderRelayDeliveryRepository {
  return {
    get: (id) => database.orderLifecycles.get(id),
    list: (buyer) =>
      database.orderLifecycles.where("buyerPubkey").equals(buyer).toArray(),
    update: (id, update) =>
      database.transaction("rw", database.orderLifecycles, async () => {
        const current = await database.orderLifecycles.get(id)
        if (!current) return undefined
        const next = update(current)
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

describe("offline guest supplier settled checkout composition", () => {
  it("uses one funding invoice, aggregated signed shares and private guest recovery; remote paid evidence remains unattributed", async () => {
    const createdAt = Math.floor(Date.now() / 1_000) * 1_000 - 60_000
    let now = createdAt + 1_000
    const f = createCheckoutSparkGuestSupplierFixture(createdAt)
    const database = new ConduitDB(`guest-supplier-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    const merchantDatabase = new ConduitDB(
      `guest-supplier-import-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    const repository = new DexieCheckoutSparkSettledRepository(database)
    const merchantRepository = new DexieCheckoutSparkSettledRepository(
      merchantDatabase
    )
    const storage = new MemoryStorage()
    const sessionStorage = new MemoryStorage()
    const checkoutId = "guest-supplier-checkout"
    const orderId = "guest-supplier-order"
    const walletId = "guest-supplier-wallet"
    const guest = createSessionGuestOrderSigningIdentity(
      orderId,
      f.merchantPubkey,
      { storage: sessionStorage, nowMs: createdAt }
    )
    const currentGuest = () =>
      getSessionGuestOrderSigningIdentity(orderId, sessionStorage, now)
    const shouldContinue = () => currentGuest()?.pubkey === guest.pubkey
    const calls = {
      material: 0,
      wallet: 0,
      receive: 0,
      order: 0,
      payer: 0,
      profiles: [] as string[],
      metadata: [] as string[],
      sends: [] as string[],
    }
    let supplierEndpointAvailable = false
    const requiredAddresses = [
      "merchant@wallet.conduit.market",
      "supplier@wallet.conduit.market",
    ]
    let orderWrap: NDKEvent | undefined
    let lastProgressId: string | undefined
    let lastAcknowledgedState: string | undefined
    const declaration = new NDKEvent(getNdk())
    declaration.kind = 10_050
    declaration.created_at = createdAt / 1_000
    declaration.tags = RELAYS.map((relay) => ["relay", relay])
    declaration.content = ""
    await declaration.sign(f.merchantSigner)
    const relayAccepted = {
      attemptedRelayUrls: RELAYS,
      successfulRelayUrls: RELAYS,
      failedRelayUrls: [],
      relayFailureMessages: {},
    }
    const transport = {
      recipientInboxRelays: RELAYS,
      shouldContinue,
      publishFn: async (event: NDKEvent) => {
        const saved = listCheckoutSparkRecoveryDeliveries(storage).find(
          (entry) => entry.record.signedRecipientWrap.id === event.id
        )
        expect(saved).toBeDefined()
        expect(saved!.deliveryProgress.acknowledgedRelayRefs).toHaveLength(0)
        expect(event.pubkey).not.toBe(guest.pubkey)
        expect(event.tags).toEqual([["p", f.merchantPubkey]])
        expect(JSON.stringify(saved)).not.toContain(MNEMONIC)
        expect(JSON.stringify(saved)).not.toContain("guest@example.test")
        return relayAccepted
      },
    }
    const loadAuthorized: typeof loadAuthorizedCheckoutSparkSettledFunding = (
      id,
      options
    ) =>
      loadAuthorizedCheckoutSparkSettledFunding(id, {
        ...options,
        repository,
        storage,
        recoveryStorage: storage,
        now: () => now,
      })

    try {
      const prepare = () =>
        prepareCheckoutSparkSettledDigitalOrder(
          {
            checkoutId,
            orderId,
            quoteAuthority: f.quoteAuthority,
            buyer: guest,
            network: "mainnet",
            nowMs: createdAt,
            shouldContinue,
            note: "Please deliver my synthetic digital files.",
            guestContact: {
              email: "guest@example.test",
              phone: "+12025550123",
            },
          },
          {
            now: () => now,
            ndk: getNdk(),
            readRecipientPayout: (input) =>
              readCheckoutSparkRecipientPayoutAddress(input, {
                readProfiles: async (query) => {
                  expect(query.accountPubkey).toBeNull()
                  expect(query.authenticatedPubkey).toBeNull()
                  expect(query.requireCompleteEvidence).toBe(true)
                  expect(query.pubkeys).toHaveLength(1)
                  const pubkey = query.pubkeys[0]!
                  calls.profiles.push(pubkey)
                  const context = f.profileContexts[pubkey]!
                  return {
                    data: { [pubkey]: context.profile },
                    profileContexts: { [pubkey]: context },
                    meta: {
                      stale: false,
                      degraded: false,
                      capped: false,
                    } as Awaited<
                      ReturnType<typeof import("@conduit/core").getProfiles>
                    >["meta"],
                  }
                },
              }),
            prepareFunding: (input) =>
              prepareCheckoutSparkSettledFunding(
                { ...input, storage, recoveryStorage: storage },
                {
                  now: () => now,
                  repository,
                  fetchPayoutMetadata: (lud16) =>
                    fetchLnurlPayMetadata(lud16, {
                      fetchImpl: async (url, options) => {
                        expect(calls.material).toBe(0)
                        expect(calls.wallet).toBe(0)
                        expect(calls.receive).toBe(0)
                        expect(calls.order).toBe(0)
                        expect(calls.sends).toHaveLength(0)
                        expect(
                          listCheckoutSparkRecoveryDeliveries(storage)
                        ).toHaveLength(0)
                        expect(requiredAddresses).toContain(lud16)
                        expect(String(url)).toBe(
                          `https://wallet.conduit.market/.well-known/lnurlp/${lud16.split("@")[0]}`
                        )
                        expect(options?.redirect).toBe("manual")
                        calls.metadata.push(lud16)
                        if (
                          lud16 === requiredAddresses[1] &&
                          !supplierEndpointAvailable
                        ) {
                          return new Response(null, { status: 503 })
                        }
                        return Response.json({
                          tag: "payRequest",
                          callback:
                            "https://wallet.conduit.market/fixture-invoice",
                          minSendable: 1_000,
                          maxSendable: 1_000_000_000,
                          allowsNostr: false,
                          metadata: "[]",
                        })
                      },
                    }),
                  createWalletMaterial: () => {
                    expect(calls.metadata).toEqual([
                      ...requiredAddresses,
                      ...requiredAddresses,
                    ])
                    calls.material += 1
                    return {
                      walletId,
                      network: "mainnet",
                      mnemonic: MNEMONIC,
                      accountNumber: 1,
                    }
                  },
                  openWallet: async () => {
                    expect(calls.material).toBe(1)
                    calls.wallet += 1
                  },
                  closeWallet: async () => {},
                  createFundingReceive: async (_wallet, request) => {
                    calls.receive += 1
                    expect(calls.profiles).toEqual([
                      f.merchantPubkey,
                      f.supplierPubkey,
                      f.merchantPubkey,
                      f.supplierPubkey,
                    ])
                    return {
                      walletId,
                      network: "mainnet",
                      id: "guest-supplier-receive",
                      paymentRequest: invoice(
                        request.grossFundingSats!,
                        new Uint8Array(32).fill(3),
                        now,
                        true
                      ),
                      paymentHash: "03".repeat(32),
                      providerStatus: "INVOICE_CREATED",
                      requiredNetSats: request.grossFundingSats!,
                      grossFundingSats: request.grossFundingSats!,
                      expirySecs: 900,
                      createdAt: now,
                      expiresAt: now + 900_000,
                      receiveSettledPolicy: "ordinary-exact-credit-v3",
                      receiverIdentityPublicKey: `02${f.merchantPubkey}`,
                    }
                  },
                  publishRecoveryHandoff: (input) =>
                    publishCheckoutSparkSettledRecoveryHandoff({
                      ...input,
                      now: () => now,
                      transport,
                    }),
                }
              ),
            publishOrder: (input) =>
              publishCheckoutSparkSettledBoundOrder(
                { ...input, storage },
                {
                  now: () => now,
                  loadSettledFunding: loadAuthorized,
                  bindBuyerOrder: repository.bindBuyerOrder.bind(repository),
                  publishOrder: (rumor, ndk, merchant, buyer, options) =>
                    publishBuyerOrderMessage(rumor, ndk, merchant, buyer, {
                      ...options,
                      orderRelayDeliveryRepository: orderRepository(database),
                      rememberCheckoutOrderAttemptFn: () => {},
                      cacheBuyerOrderRumorFn: async () => null,
                      publishPrivateMessageFn: async (message) => {
                        expect(message.selfCopy).toBe(false)
                        expect(message.accountPubkey).toBeNull()
                        expect(message.authenticatedPubkey).toBeNull()
                        expect(message.signerInteraction).toBe(
                          "application_owned"
                        )
                        expect(message.senderPubkey).toBe(guest.pubkey)
                        orderWrap = await wrapPrivateMessage(
                          message.rumor,
                          new NDKUser({ pubkey: merchant }),
                          message.signer
                        )
                        const prepared = {
                          rumorId: message.rumor.id,
                          wrappedToRecipient: orderWrap,
                          deliveryRoute: "declared_inbox" as const,
                          routingAuthority: {
                            eventId: declaration.id,
                            eventCreatedAt: declaration.created_at!,
                            pubkey: merchant,
                            kind: 10_050,
                            relayUrls: RELAYS,
                          },
                          relayPlan: RELAYS.map((relayUrl) => ({
                            relayUrl,
                            source: "declared" as const,
                          })),
                        }
                        await message.onRecipientPrepared?.(prepared)
                        await message.onRecipientPublishStarting?.(prepared)
                        expect(
                          (await database.orderLifecycles.get(orderId))
                            ?.orderRelayDelivery?.relayDelivery[0]?.attemptCount
                        ).toBe(1)
                        calls.order += 1
                        await message.onRecipientPublishAccepted?.(
                          relayAccepted
                        )
                        await message.onRecipientPublishSettled?.(relayAccepted)
                        return {
                          wrappedToRecipient: orderWrap,
                          wrappedToSelf: null,
                          selfCopyError: null,
                          deliveryRoute: "declared_inbox",
                          recipientDelivery: relayAccepted,
                        }
                      },
                    }),
                }
              ),
          }
        )
      // A normal endpoint outage must leave this guest free to retry the same
      // signed checkout without an abandoned wallet or an exposed invoice.
      await expect(prepare()).rejects.toThrow()
      expect(calls).toMatchObject({
        material: 0,
        wallet: 0,
        receive: 0,
        order: 0,
        payer: 0,
        metadata: requiredAddresses,
        sends: [],
      })
      expect(getCheckoutSparkSettledPreparation(checkoutId, storage)).toBeNull()
      expect(listCheckoutSparkRecoveryDeliveries(storage)).toHaveLength(0)
      expect(await database.checkoutSparkPlanBindings.count()).toBe(0)
      expect(await database.orderLifecycles.get(orderId)).toBeUndefined()
      expect(currentGuest()?.pubkey).toBe(guest.pubkey)
      supplierEndpointAvailable = true
      const result = await prepare()
      const { plan, recoveryHandoffId } = result.prepared
      expect(result.published.delivery.localCacheError).toBeNull()
      expect(calls).toMatchObject({
        material: 1,
        wallet: 1,
        receive: 1,
        order: 1,
        payer: 0,
        sends: [],
      })
      expect(
        plan.recipients.map(({ kind, weightSats }) => ({ kind, weightSats }))
      ).toMatchObject([
        { kind: "merchant", weightSats: 2_274 },
        { kind: "supplier", weightSats: 757 },
        { kind: "conduit" },
      ])
      expect(plan.commerceQuote.commerceTotalSats).toBe(3_031)
      expect(plan.takeoverAt).toBe(createdAt + 45 * 60_000)
      expect(plan.funding.expiresAt - plan.funding.createdAt).toBe(15 * 60_000)
      const initial = await openCheckoutSparkRecoveryDelivery({
        record: getCheckoutSparkRecoveryDelivery(recoveryHandoffId, storage)!
          .record,
        signer: plainTestSigner(f.merchantSigner),
      })
      expect(initial.schemaVersion).toBe(2)
      if (initial.schemaVersion !== 2)
        throw new Error("Expected initial settled handoff")
      expect(initial.senderPubkey).toBe(guest.pubkey)
      expect(initial.sourceEvents).toEqual(f.sourceEvents)
      expect(
        validateCheckoutSparkPlanSources(initial.plan, initial.sourceEvents!)
      ).toMatchObject({ checkoutId, planDigest: plan.planDigest })
      expect(initial.wallet.mnemonic).toBe(MNEMONIC)
      expect(JSON.stringify(initial)).not.toContain("guest@example.test")
      expect(orderWrap).toBeDefined()
      const openedOrder = await unwrapGiftWrap(
        orderWrap!,
        plainTestSigner(f.merchantSigner)
      )
      if (openedOrder.status !== "ok")
        throw new Error("Expected authenticated guest order")
      const message = parseOrderMessageRumorEvent(openedOrder.rumor)
      if (message.type !== "order")
        throw new Error("Expected one combined order")
      expect(message.payload.guestContact).toEqual({
        email: "guest@example.test",
        phone: "+12025550123",
      })
      expect(message.payload.items.map((item) => item.quantity)).toEqual([3, 2])
      const evidence = readCheckoutSparkMerchantOrderEvidence(openedOrder.rumor)
      const witness = createCheckoutSparkMerchantOrderWitness(
        plan,
        evidence!,
        guest.pubkey
      )
      expect(JSON.stringify(witness)).not.toContain("guest@example.test")
      const lifecycle = await database.orderLifecycles.get(orderId)
      expect(lifecycle).toMatchObject({
        buyerIdentityKind: "guest_ephemeral",
        guestSessionExpiresAt: guest.expiresAt,
        orderDeliveryStatus: "sent",
      })
      expect(JSON.stringify(lifecycle)).not.toContain("guest@example.test")
      expect(JSON.stringify(lifecycle)).not.toContain(MNEMONIC)
      expect(JSON.stringify(lifecycle)).not.toContain(
        plan.funding.paymentRequest
      )

      let creditAvailable = false
      const credit = {
        mode: "ordinary_v3" as const,
        requestId: plan.funding.requestId,
        transferId: "guest-supplier-credit",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: plan.funding.grossFundingSats,
        creditedSats: plan.funding.grossFundingSats,
      }
      const bridge = createCheckoutSparkSettledFundingBridge(checkoutId, {
        repository,
        storage,
        recoveryStorage: storage,
        loadAuthorized,
        now: () => now,
        requireCrossTabLock: false,
        withStoreWriteLock: (operation) => operation(),
        attestCredit: async () => (creditAvailable ? credit : null),
        payInvoice: async () => {
          calls.payer += 1
          throw new Error("No payer wallet is installed")
        },
      })
      const fundingPayment = {
        buyerPubkey: guest.pubkey,
        shouldContinue,
        paymentTarget: { type: "manual" as const },
        timeoutMs: 1_000,
        appId: "market" as const,
      }
      const external = await bridge.fund({
        ...fundingPayment,
        exposeExternalInvoice: true,
      })
      expect(external.status).toBe("external_ready")
      if (external.status !== "external_ready")
        throw new Error("Expected one external invoice")
      expect(external.externalInvoice.invoice).toBe(plan.funding.paymentRequest)
      expect(
        getCheckoutSparkSettledPreparation(checkoutId, storage)
          ?.fundingSubmissionState
      ).toBe("provisional")
      const sameExternal = await bridge.fund({
        ...fundingPayment,
        exposeExternalInvoice: true,
      })
      expect(sameExternal).toEqual(external)
      creditAvailable = true
      now += 1_000
      expect(
        (await bridge.fund({ ...fundingPayment, inspectionOnly: true })).status
      ).toBe("funded")
      expect(calls.payer).toBe(0)

      const acknowledge = async (state: CheckoutSparkSettledReconciliation) => {
        now = Math.max(now, state.updatedAt)
        const ack = await acknowledgeOrRetryCheckoutSparkSettledSnapshot({
          initialHandoffId: recoveryHandoffId,
          state,
          identity: guest,
          preparedAt: now,
          now: () => now,
          storage,
          transport,
          requireCrossTabLock: false,
        })
        lastProgressId = ack.handoffId
        lastAcknowledgedState = JSON.stringify(state)
      }
      const completed = new Set<string>()
      const paymentDetails = new Map<
        string,
        { paymentHash: string; preimage: string }
      >()
      let availableSats = credit.creditedSats
      const manager: Pick<
        SparkWalletManager,
        | "isOpen"
        | "estimateCheckoutLightningFee"
        | "getFundsState"
        | "preflightCheckoutLightningObligation"
        | "sendCheckoutLightningObligation"
        | "reconcileInvoiceAttempt"
      > = {
        isOpen: () => true,
        estimateCheckoutLightningFee: async () => 1,
        getFundsState: async () => ({
          availableSats,
          ownedSats: availableSats,
          incomingSats: 0,
          observedAt: now,
        }),
        preflightCheckoutLightningObligation: async () => "ready",
        reconcileInvoiceAttempt: async (_wallet, attempt) =>
          completed.has(attempt.transferId)
            ? {
                status: "resolved",
                payment: {
                  status: "completed",
                  fees: 1n,
                  details: {
                    type: "lightning",
                    htlcDetails: paymentDetails.get(attempt.paymentRequest)!,
                  },
                },
                verifiedTransferTotalSats: attempt.amountSats + 1,
              }
            : { status: "not_found" },
        sendCheckoutLightningObligation: async (_wallet, request) => {
          await request.assertBeforeSend?.()
          const saved = await repository.load(checkoutId, plan.planDigest)
          if (saved.status !== "active")
            throw new Error("Expected durable submitted state")
          expect(lastAcknowledgedState).toBe(JSON.stringify(saved.state))
          const leg = saved.state.legs.find(
            (candidate) => candidate.intent?.transferId === request.transferId
          )!
          expect(leg.status).toBe("submitted")
          expect(leg.intent!.paymentRequest).toBe(request.paymentRequest)
          expect(request.amountSats + request.maxFeeSats).toBe(
            leg.allocationSats!
          )
          expect(request.amountSats + 1).toBeLessThanOrEqual(
            leg.allocationSats!
          )
          calls.sends.push(leg.legId)
          completed.add(request.transferId)
          availableSats -= request.amountSats + 1
          return { status: "ambiguous" }
        },
      }
      const resolvedAddresses: string[] = []
      const advance = (legId: string) =>
        advanceCheckoutSparkSettledShopper(
          {
            checkoutId,
            planDigest: plan.planDigest,
            orderId,
            merchantPubkey: f.merchantPubkey,
            network: "mainnet",
            buyerPubkey: guest.pubkey,
            guestIdentity: guest,
            currentGuestIdentity: currentGuest,
            currentBuyerPubkey: () => null,
            shouldContinue,
            legId,
            fundingPayment,
            acknowledgeRecoverySnapshot: acknowledge,
          },
          {
            repository,
            loadAuthorized,
            now: () => now,
            readOrder: (id) => database.orderLifecycles.get(id),
            readPreparation: (id) =>
              getCheckoutSparkSettledPreparation(id, storage),
            readInitialRecovery: (id) =>
              getCheckoutSparkRecoveryDelivery(id, storage),
            sparkConfiguration: () => ({ status: "ready", network: "mainnet" }),
            sparkManager: () => manager as SparkWalletManager,
            prepareLeg: (input, dependencies) =>
              prepareCheckoutSparkSettledOutgoingLeg(input, {
                ...dependencies,
                resolveInvoice: async (input) => {
                  resolvedAddresses.push(input.lud16)
                  const preimage = new Uint8Array(32).fill(
                    resolvedAddresses.length + 10
                  )
                  const hash = createHash("sha256").update(preimage).digest()
                  const paymentRequest = invoice(input.amountSats, hash, now)
                  paymentDetails.set(paymentRequest, {
                    paymentHash: hash.toString("hex"),
                    preimage: Buffer.from(preimage).toString("hex"),
                  })
                  return resolveCheckoutSparkFixtureInvoice(
                    input,
                    paymentRequest
                  )
                },
              }),
          }
        )
      const [merchantLeg, supplierLeg, feeLeg] = plan.recipients
      for (const [index, recipient] of [merchantLeg!, supplierLeg!].entries()) {
        expect((await advance(recipient.legId)).status).toBe("payout_prepared")
        expect(calls.sends).toHaveLength(index)
        const sent = await advance(recipient.legId)
        expect(sent.status).toBe("outgoing_step")
        if (sent.status !== "outgoing_step")
          throw new Error("Expected exact outgoing step")
        expect({
          outcome: sent.step.outcome,
          reason: sent.step.reason,
          sendAttempted: sent.step.sendAttempted,
        }).toEqual({ outcome: "paid", reason: undefined, sendAttempted: true })
        expect(calls.sends).toHaveLength(index + 1)
        await expect(advance(recipient.legId)).rejects.toThrow(
          "next payout changed"
        )
        expect(calls.sends).toHaveLength(index + 1)
        const facts = await repository.loadMerchantSettlement(
          f.merchantPubkey,
          checkoutId,
          plan.planDigest
        )
        expect(projectCheckoutSparkMerchantSettlement(facts!)).toMatchObject({
          commerceVerified: index === 1,
          feePending: true,
          recipientUnverified: false,
        })
      }
      expect(resolvedAddresses).toEqual([...requiredAddresses])
      expect(calls.sends).toEqual([merchantLeg!.legId, supplierLeg!.legId])
      const localFacts = await repository.loadMerchantSettlement(
        f.merchantPubkey,
        checkoutId,
        plan.planDigest
      )
      expect(localFacts!.paidLegs).toHaveLength(2)
      expect(
        localFacts!.paidLegs.every((leg) => leg.recipientVerified === true)
      ).toBe(true)

      // An ordinary unavailable optional-fee check does not undo the commerce legs.
      expect((await advance(feeLeg!.legId)).status).toBe("payout_prepared")
      manager.preflightCheckoutLightningObligation = async () => "unavailable"
      await advance(feeLeg!.legId)
      expect(calls.sends).toHaveLength(2)
      expect(
        projectCheckoutSparkMerchantSettlement(
          (await repository.loadMerchantSettlement(
            f.merchantPubkey,
            checkoutId,
            plan.planDigest
          ))!
        )
      ).toMatchObject({ commerceVerified: true, feePending: true })

      // Only authenticated recovery crosses devices, never the local origin capability.
      const progress = await openCheckoutSparkRecoveryDelivery({
        record: getCheckoutSparkRecoveryDelivery(lastProgressId!, storage)!
          .record,
        signer: plainTestSigner(f.merchantSigner),
      })
      if (progress.schemaVersion !== 3)
        throw new Error("Expected guest progress handoff")
      expect(progress.initialHandoffId).toBe(recoveryHandoffId)
      expect(progress.senderPubkey).toBe(guest.pubkey)
      expect(progress).not.toHaveProperty("wallet")
      expect(progress).not.toHaveProperty("sourceEvents")
      expect(JSON.stringify(progress)).not.toContain("recipientVerified")
      expect(JSON.stringify(progress)).not.toContain("invoiceOrigins")
      expect(JSON.stringify(progress)).not.toContain(MNEMONIC)
      await merchantRepository.importMerchantOrderRecovery(
        progress.state,
        witness,
        () => {}
      )
      await merchantRepository.recordMerchantPlanSources(
        plan,
        initial.sourceEvents!,
        () => {
          expect(f.merchantSigner.pubkey).toBe(plan.merchantPubkey)
        }
      )
      await merchantRepository.recordMerchantCredit(plan, credit, now)
      const remoteProvider = createCheckoutSparkSettledOutgoingProvider({
        plan,
        manager,
        assertBeforeSend: async () => {
          throw new Error("Imported history is inspection-only")
        },
      })
      for (const recipient of [merchantLeg!, supplierLeg!]) {
        const leg = progress.state.legs.find(
          (candidate) => candidate.legId === recipient.legId
        )!
        const target: CheckoutSparkSettledOutgoingTarget = {
          walletId,
          network: "mainnet",
          legId: leg.legId,
          recipientId: recipient.recipientId,
          allocationSats: leg.allocationSats!,
          unpaidAllocationSats: credit.creditedSats,
          intent: leg.intent!,
        }
        const observation = await remoteProvider.reconcile(target)
        expect(observation.status).toBe("paid")
        await merchantRepository.recordMerchantPayout(
          plan,
          target,
          observation,
          now
        )
      }
      const importedFacts = await merchantRepository.loadMerchantSettlement(
        f.merchantPubkey,
        checkoutId,
        plan.planDigest
      )
      expect(importedFacts!.paidLegs).toHaveLength(2)
      expect(
        importedFacts!.paidLegs.every(
          (leg) => leg.recipientVerified === undefined
        )
      ).toBe(true)
      expect(projectCheckoutSparkMerchantSettlement(importedFacts!)).toEqual({
        creditVerified: true,
        merchantVerified: false,
        commerceVerified: false,
        feePending: true,
        recipientUnverified: true,
      })
      expect(calls).toMatchObject({
        material: 1,
        wallet: 1,
        receive: 1,
        order: 1,
        payer: 0,
        profiles: [
          f.merchantPubkey,
          f.supplierPubkey,
          f.merchantPubkey,
          f.supplierPubkey,
        ],
        metadata: [...requiredAddresses, ...requiredAddresses],
        sends: [merchantLeg!.legId, supplierLeg!.legId],
      })
    } finally {
      database.close()
      merchantDatabase.close()
      await database.delete()
      await merchantDatabase.delete()
    }
  }, 20_000)
})

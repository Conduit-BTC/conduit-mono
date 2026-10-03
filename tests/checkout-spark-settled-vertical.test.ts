import { describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import {
  calculateCheckoutSparkInboundNetworkAllowanceSats,
  calculateConduitCheckoutFeeSats,
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkInvoiceOriginRecord,
  createCheckoutSparkSettledReconciliation,
  createSelectedProfileContext,
  fetchLnurlPayMetadata,
  getNdk,
  hasCheckoutSparkInvoiceOrigin,
  projectCheckoutSparkMerchantSettlement,
  recordCheckoutSparkMerchantCredit,
  recordCheckoutSparkMerchantPayout,
  restoreCheckoutSparkSettledReconciliation,
  runCheckoutSparkSettledOutgoingStep,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkInvoiceOriginRecord,
  type CheckoutSparkLnurlInvoiceInput,
  type CheckoutSparkLnurlInvoiceOrigin,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRepositorySnapshot,
  type CheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledOutgoingObservation,
  type SparkCheckoutReceiveCreditProof,
  type SelectedProfileContext,
} from "@conduit/core"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure"

import { readCheckoutSparkRecipientPayoutAddress } from "../apps/market/src/lib/checkout-spark-recipient-profile"
import {
  prepareCheckoutSparkSettledDigitalOrder,
  type PrepareCheckoutSparkSettledDigitalOrderInput,
} from "../apps/market/src/lib/checkout-spark-settled-entry"
import { createCheckoutSparkSettledFundingBridge } from "../apps/market/src/lib/checkout-spark-settled-funding"
import { prepareCheckoutSparkSettledOutgoingLeg } from "../apps/market/src/lib/checkout-spark-settled-leg-preparation"
import {
  getCheckoutSparkSettledPreparation,
  loadAuthorizedCheckoutSparkSettledFunding,
  prepareCheckoutSparkSettledFunding,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  acknowledgeOrRetryCheckoutSparkSettledSnapshot,
  getCheckoutSparkRecoveryDelivery,
  listCheckoutSparkRecoveryDeliveries,
  publishCheckoutSparkSettledRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import type { PublishedCheckoutSparkBoundOrder } from "../apps/market/src/lib/checkout-spark-bound-order"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { checkoutSparkQuoteFixture } from "./support/checkout-spark-quote-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const NOW = 1_800_000_000_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = plainTestSigner(NDKPrivateKeySigner.generate())
const WRAP_SECRET = generateSecretKey()
const INBOX_RELAYS = ["wss://merchant.inbox.relay.dev"]
const WALLET_ID = "vertical-wallet"
const RECEIVER_IDENTITY = `02${"a".repeat(64)}`
const GROSS =
  1_000 +
  calculateConduitCheckoutFeeSats(1_000) +
  calculateCheckoutSparkInboundNetworkAllowanceSats(1_000)
const MNEMONIC = createRuntimeMnemonic()

class MemoryStorage {
  private readonly values = new Map<string, string>()

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

class MemorySettledRepository {
  private state: CheckoutSparkSettledReconciliation | null = null
  private revision = 0
  private providerFacts: CheckoutSparkMerchantSettlementRecord | null = null
  private readonly origins = new Map<string, CheckoutSparkInvoiceOriginRecord>()

  async create(
    plan: CheckoutSparkSettledPlan
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    if (this.state) throw new Error("Checkout already exists")
    this.state = createCheckoutSparkSettledReconciliation(plan)
    this.providerFacts = createCheckoutSparkMerchantSettlementRecord(plan)
    this.revision = 1
    return this.snapshot()
  }

  async load(
    checkoutId: string,
    planDigest: string
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    if (!this.state) return { status: "absent" }
    if (
      this.state.plan.checkoutId !== checkoutId ||
      this.state.plan.planDigest !== planDigest
    ) {
      throw new Error("Checkout plan changed")
    }
    return this.snapshot()
  }

  async save(
    state: CheckoutSparkSettledReconciliation,
    expectedRevision: number
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    if (
      !this.state ||
      expectedRevision !== this.revision ||
      state.plan.planDigest !== this.state.plan.planDigest
    ) {
      throw new Error("Checkout CAS conflict")
    }
    this.state = restoreCheckoutSparkSettledReconciliation(state)
    this.revision += 1
    return this.snapshot()
  }

  async savePreparedWithInvoiceOrigin(
    state: CheckoutSparkSettledReconciliation,
    expectedRevision: number,
    input: { legId: string; origin: CheckoutSparkLnurlInvoiceOrigin },
    assertCurrent?: () => void
  ): Promise<CheckoutSparkSettledRepositorySnapshot> {
    assertCurrent?.()
    const leg = state.legs.find((candidate) => candidate.legId === input.legId)!
    const recipient = state.plan.recipients.find(
      (candidate) => candidate.legId === input.legId
    )!
    const origin = createCheckoutSparkInvoiceOriginRecord(
      state.plan,
      {
        walletId: state.plan.walletId,
        network: state.plan.network,
        legId: leg.legId,
        recipientId: recipient.recipientId,
        allocationSats: leg.allocationSats!,
        unpaidAllocationSats: state.legs.reduce(
          (total, candidate) =>
            total +
            (candidate.status === "paid" ? 0 : candidate.allocationSats!),
          0
        ),
        intent: leg.intent!,
      },
      input.origin
    )
    const saved = await this.save(state, expectedRevision)
    this.origins.set(input.legId, origin)
    return saved
  }

  async assertLocalInvoiceOrigin(
    plan: CheckoutSparkSettledPlan,
    target: CheckoutSparkSettledOutgoingTarget,
    assertCurrent?: () => void
  ): Promise<void> {
    assertCurrent?.()
    if (
      !hasCheckoutSparkInvoiceOrigin(
        this.origins.get(target.legId),
        plan,
        target
      )
    ) {
      throw new Error("Local invoice origin is unavailable")
    }
    assertCurrent?.()
  }

  async recordMerchantCredit(
    plan: CheckoutSparkSettledPlan,
    proof: SparkCheckoutReceiveCreditProof,
    observedAt: number,
    assertCurrent?: () => void
  ): Promise<CheckoutSparkMerchantSettlementRecord> {
    assertCurrent?.()
    if (
      !this.providerFacts ||
      this.state?.plan.planDigest !== plan.planDigest
    ) {
      throw new Error("Provider fact plan changed")
    }
    this.providerFacts = recordCheckoutSparkMerchantCredit(
      this.providerFacts,
      plan,
      proof,
      observedAt
    )
    assertCurrent?.()
    return this.providerFacts
  }

  async recordMerchantPayout(
    plan: CheckoutSparkSettledPlan,
    target: CheckoutSparkSettledOutgoingTarget,
    observation: CheckoutSparkSettledOutgoingObservation,
    observedAt: number,
    assertCurrent?: () => void
  ): Promise<CheckoutSparkMerchantSettlementRecord> {
    assertCurrent?.()
    if (
      !this.providerFacts ||
      this.state?.plan.planDigest !== plan.planDigest
    ) {
      throw new Error("Provider fact plan changed")
    }
    this.providerFacts = recordCheckoutSparkMerchantPayout(
      this.providerFacts,
      plan,
      target,
      observation,
      observedAt,
      this.origins.get(target.legId)
    )
    assertCurrent?.()
    return this.providerFacts
  }

  settlement(): CheckoutSparkMerchantSettlementRecord | null {
    return this.providerFacts ? structuredClone(this.providerFacts) : null
  }

  snapshot(): CheckoutSparkSettledRepositorySnapshot {
    return this.state
      ? {
          status: "active",
          revision: this.revision,
          state: structuredClone(this.state),
        }
      : { status: "absent" }
  }
}

function invoice(
  amountSats: number,
  hashByte: number,
  expirySeconds = 3_600
): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      ...(expirySeconds === 900 ? [{ tag: "x", words: [28, 4] }] : []),
    ],
  })
}

function hash(hashByte: number): string {
  return hashByte.toString(16).padStart(2, "0").repeat(32)
}

function entryRequest(
  checkoutId: string
): PrepareCheckoutSparkSettledDigitalOrderInput {
  const quote = checkoutSparkQuoteFixture(MERCHANT_SECRET)
  return {
    checkoutId,
    orderId: `${checkoutId}-order`,
    buyer: { kind: "signed_in", pubkey: BUYER.pubkey, signer: BUYER },
    network: "mainnet",
    nowMs: NOW,
    shouldContinue: () => true,
    quoteAuthority: {
      ...quote,
      pricing: {
        ...quote.pricing,
        itemSubtotalSats: 1_000,
        totalMsats: 1_000_000,
        paymentRequired: true,
        approximate: false,
        shippingCost: {
          status: "not_required",
          totalSats: 0,
          missingProductIds: [],
        },
        items: [
          {
            ...quote.pricing.items[0]!,
            format: "digital",
            currency: "SATS",
            shippingCostSats: undefined,
          },
        ],
      },
    },
  }
}

function signedProfileContext(
  readComplete: boolean,
  observed = true
): SelectedProfileContext {
  const event = finalizeEvent(
    {
      kind: 0,
      created_at: NOW / 1_000,
      tags: [],
      content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
    },
    MERCHANT_SECRET
  )
  expect(verifyEvent(event)).toBe(true)
  return {
    ...createSelectedProfileContext({
      pubkey: MERCHANT,
      row: {
        pubkey: MERCHANT,
        eventId: event.id,
        eventCreatedAt: event.created_at,
        rawContent: event.content,
        cachedAt: NOW,
      },
      observed,
      readComplete,
    }),
    signedEvent: event,
  }
}

function harness(options: {
  checkoutId: string
  profileComplete?: boolean
  profileObserved?: boolean
  recoveryAck?: boolean
  metadataAvailable?: () => boolean
}) {
  const storage = new MemoryStorage()
  const repository = new MemorySettledRepository()
  const calls = {
    metadata: 0,
    material: 0,
    wallet: 0,
    receive: 0,
    recoveryPublish: 0,
    order: 0,
  }
  const preparationOrder: string[] = []
  const profileComplete = options.profileComplete ?? true
  const profileObserved = options.profileObserved ?? true
  const recoveryAck = options.recoveryAck ?? true
  let wrapSequence = 0

  const transport = {
    recipientInboxRelays: INBOX_RELAYS,
    giftWrapFn: (async (_rumor: NDKEvent, recipient: { pubkey: string }) => {
      const signed = finalizeEvent(
        {
          kind: 1059,
          created_at: NOW / 1_000,
          tags: [["p", recipient.pubkey]],
          content: `opaque-wrap-${wrapSequence++}`,
        },
        WRAP_SECRET
      )
      return new NDKEvent(getNdk(), signed)
    }) as never,
    publishFn: (async (event: NDKEvent) => {
      calls.recoveryPublish += 1
      const preparation = getCheckoutSparkSettledPreparation(
        options.checkoutId,
        storage
      )
      if (calls.recoveryPublish === 1) {
        expect(preparation?.fundingInvoiceExposedAt).toBeNull()
      }
      expect(preparation?.recoveryHandoffId).not.toBeNull()
      const saved = listCheckoutSparkRecoveryDeliveries(storage).find(
        (delivery) => delivery.record.signedRecipientWrap.id === event.id
      )
      expect(saved?.deliveryProgress.acknowledgedRelayRefs).toHaveLength(0)
      return {
        attemptedRelayUrls: INBOX_RELAYS,
        successfulRelayUrls: recoveryAck ? INBOX_RELAYS : [],
        failedRelayUrls: recoveryAck ? [] : INBOX_RELAYS,
        relayFailureMessages: {},
      }
    }) as never,
  }

  const readRecipientPayout: typeof readCheckoutSparkRecipientPayoutAddress = (
    input
  ) =>
    readCheckoutSparkRecipientPayoutAddress(input, {
      readProfiles: async (query) => {
        expect(query).toMatchObject({
          pubkeys: [MERCHANT],
          skipCache: true,
          requireCompleteEvidence: true,
          evidenceScope: "payment",
        })
        const context = signedProfileContext(profileComplete, profileObserved)
        return {
          data: { [MERCHANT]: context.profile },
          profileContexts: { [MERCHANT]: context },
          meta: {
            stale: false,
            degraded: !profileComplete,
            capped: false,
          } as Awaited<
            ReturnType<typeof import("@conduit/core").getProfiles>
          >["meta"],
        }
      },
    })

  const prepare = () =>
    prepareCheckoutSparkSettledDigitalOrder(entryRequest(options.checkoutId), {
      readRecipientPayout,
      prepareFunding: (terms) =>
        prepareCheckoutSparkSettledFunding(
          { ...terms, storage, recoveryStorage: storage },
          {
            now: () => NOW + 1_000,
            repository,
            fetchPayoutMetadata: (lud16) =>
              fetchLnurlPayMetadata(lud16, {
                fetchImpl: (async (url) => {
                  calls.metadata += 1
                  preparationOrder.push("metadata")
                  expect(lud16).toBe("merchant@wallet.conduit.market")
                  expect(String(url)).toBe(
                    "https://wallet.conduit.market/.well-known/lnurlp/merchant"
                  )
                  expect(calls).toMatchObject({
                    material: 0,
                    wallet: 0,
                    receive: 0,
                    recoveryPublish: 0,
                    order: 0,
                  })
                  if (options.metadataAvailable?.() === false) {
                    return new Response(null, { status: 503 })
                  }
                  return Response.json({
                    tag: "payRequest",
                    callback: "https://wallet.conduit.market/lnurl/callback",
                    minSendable: 1_000,
                    maxSendable: 10_000_000,
                    metadata: "[]",
                    allowsNostr: false,
                  })
                }) as typeof fetch,
              }),
            createWalletMaterial: () => {
              expect(preparationOrder.at(-1)).toBe("metadata")
              preparationOrder.push("material")
              calls.material += 1
              return {
                walletId: WALLET_ID,
                network: "mainnet",
                mnemonic: MNEMONIC,
                accountNumber: 1,
              }
            },
            openWallet: async () => {
              expect(preparationOrder.at(-1)).toBe("material")
              preparationOrder.push("open")
              calls.wallet += 1
            },
            closeWallet: async () => {},
            createFundingReceive: async (_wallet, request) => {
              expect(preparationOrder.at(-1)).toBe("open")
              preparationOrder.push("receive")
              calls.receive += 1
              expect(request).toMatchObject({
                grossFundingSats: GROSS,
                receiveMode: "ordinary_settled_v3",
              })
              return {
                walletId: WALLET_ID,
                network: "mainnet",
                id: "vertical-receive",
                paymentRequest: invoice(GROSS, 3, 900),
                paymentHash: hash(3),
                providerStatus: "INVOICE_CREATED",
                requiredNetSats: GROSS,
                grossFundingSats: GROSS,
                expirySecs: 900,
                createdAt: NOW,
                expiresAt: NOW + 900_000,
                receiveSettledPolicy: "ordinary-exact-credit-v3",
                receiverIdentityPublicKey: RECEIVER_IDENTITY,
              }
            },
            publishRecoveryHandoff: (input) =>
              publishCheckoutSparkSettledRecoveryHandoff({
                ...input,
                now: () => NOW + 1_000,
                transport,
              }),
          }
        ),
      publishOrder: async (input) => {
        calls.order += 1
        expect(input.order.merchantPubkey).toBe(MERCHANT)
        return {
          orderId: input.order.id,
          delivery: {},
        } as PublishedCheckoutSparkBoundOrder
      },
      ndk: getNdk(),
    })

  return { storage, repository, calls, preparationOrder, transport, prepare }
}

describe("settled Spark no-funds vertical flow", () => {
  it("requires a live signed profile and exact recovery ACK before invoice exposure", async () => {
    const incomplete = harness({
      checkoutId: "vertical-profile-incomplete",
      profileComplete: false,
      profileObserved: false,
    })
    await expect(incomplete.prepare()).rejects.toThrow("profile_not_observed")
    expect(incomplete.calls).toEqual({
      metadata: 0,
      material: 0,
      wallet: 0,
      receive: 0,
      recoveryPublish: 0,
      order: 0,
    })
    expect(incomplete.repository.snapshot().status).toBe("absent")

    // A selected signed profile observed from one authorized relay remains
    // positive payout evidence even if other bounded relay reads are partial.
    const partialPositive = harness({
      checkoutId: "vertical-profile-partial-positive",
      profileComplete: false,
    })
    await expect(partialPositive.prepare()).resolves.toBeDefined()
    expect(partialPositive.calls.order).toBe(1)

    const noAck = harness({
      checkoutId: "vertical-recovery-unacked",
      recoveryAck: false,
    })
    await expect(noAck.prepare()).rejects.toThrow("relay ACK")
    expect(noAck.calls).toEqual({
      metadata: 1,
      material: 1,
      wallet: 1,
      receive: 1,
      recoveryPublish: 1,
      order: 0,
    })
    expect(
      getCheckoutSparkSettledPreparation(
        "vertical-recovery-unacked",
        noAck.storage
      )
    ).toMatchObject({ fundingInvoiceExposedAt: null })
    await expect(
      loadAuthorizedCheckoutSparkSettledFunding("vertical-recovery-unacked", {
        storage: noAck.storage,
        recoveryStorage: noAck.storage,
        repository: noAck.repository,
        now: () => NOW + 2_000,
      })
    ).rejects.toThrow("not durably authorized")
  })

  it("creates no wallet for unavailable metadata and retries with one funding invoice", async () => {
    let available = false
    const checkoutId = "vertical-metadata-retry"
    const run = harness({
      checkoutId,
      metadataAvailable: () => available,
    })
    await expect(run.prepare()).rejects.toThrow()
    expect(run.calls).toEqual({
      metadata: 1,
      material: 0,
      wallet: 0,
      receive: 0,
      recoveryPublish: 0,
      order: 0,
    })
    expect(run.repository.snapshot().status).toBe("absent")
    expect(
      getCheckoutSparkSettledPreparation(checkoutId, run.storage)
    ).toBeNull()
    expect(listCheckoutSparkRecoveryDeliveries(run.storage)).toEqual([])

    available = true
    const prepared = await run.prepare()
    expect(prepared.prepared.fundingInvoice).toBe(
      prepared.prepared.plan.funding.paymentRequest
    )
    expect(run.preparationOrder).toEqual([
      "metadata",
      "metadata",
      "material",
      "open",
      "receive",
    ])
    expect(run.calls).toEqual({
      metadata: 2,
      material: 1,
      wallet: 1,
      receive: 1,
      recoveryPublish: 1,
      order: 1,
    })
    await expect(run.prepare()).rejects.toThrow("already prepared")
    expect(run.calls).toEqual({
      metadata: 2,
      material: 1,
      wallet: 1,
      receive: 1,
      recoveryPublish: 1,
      order: 1,
    })
  })

  it("serializes retry lookup and wrap creation across tabs", async () => {
    const run = harness({ checkoutId: "vertical-snapshot-lock" })
    const prepared = await run.prepare()
    const snapshot = run.repository.snapshot()
    expect(snapshot.status).toBe("active")
    if (snapshot.status !== "active") return

    const held = new Set<string>()
    const lockManager = {
      async request<T>(
        name: string,
        _options: { mode: "exclusive"; ifAvailable: true },
        callback: (lock: { name: string } | null) => T | Promise<T>
      ): Promise<T> {
        if (held.has(name)) return callback(null)
        held.add(name)
        try {
          return await callback({ name })
        } finally {
          held.delete(name)
        }
      },
    }
    let releaseFirst!: () => void
    let firstWrapReached!: () => void
    const firstWrap = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const reached = new Promise<void>((resolve) => {
      firstWrapReached = resolve
    })
    let wrapAttempts = 0
    const transport = {
      ...run.transport,
      giftWrapFn: (async (
        ...args: Parameters<typeof run.transport.giftWrapFn>
      ) => {
        wrapAttempts += 1
        if (wrapAttempts === 1) {
          firstWrapReached()
          await firstWrap
        }
        return run.transport.giftWrapFn(...args)
      }) as typeof run.transport.giftWrapFn,
    }
    const input = {
      initialHandoffId: prepared.prepared.recoveryHandoffId,
      state: snapshot.state,
      identity: entryRequest(snapshot.state.plan.checkoutId).buyer,
      preparedAt: NOW + 10_000,
      storage: run.storage,
      now: () => NOW + 10_000,
      transport,
      lockManager,
      requireCrossTabLock: true,
    }
    const first = acknowledgeOrRetryCheckoutSparkSettledSnapshot(input)
    await reached
    let secondError: unknown = null
    try {
      await acknowledgeOrRetryCheckoutSparkSettledSnapshot(input)
    } catch (error) {
      secondError = error
    } finally {
      releaseFirst()
    }
    const firstResult = await first.catch((error: unknown) => error)
    expect(secondError).toBeInstanceOf(Error)
    expect(firstResult).toMatchObject({ mode: "published" })
    expect(wrapAttempts).toBe(1)
    const reused = await acknowledgeOrRetryCheckoutSparkSettledSnapshot(input)
    expect(reused).toMatchObject({
      mode: "reused",
      handoffId: (firstResult as { handoffId: string }).handoffId,
    })
    expect(wrapAttempts).toBe(1)
    await expect(
      acknowledgeOrRetryCheckoutSparkSettledSnapshot({
        ...input,
        lockManager: null,
      })
    ).rejects.toThrow("cannot safely coordinate checkout recovery")
    expect(wrapAttempts).toBe(1)
  })

  it("funds once from exact credit, then pays Merchant before Conduit without replay", async () => {
    const run = harness({ checkoutId: "vertical-credited-checkout" })
    const prepared = await run.prepare()
    const { plan } = prepared.prepared
    const stored = getCheckoutSparkSettledPreparation(
      plan.checkoutId,
      run.storage
    )
    const initialDelivery = getCheckoutSparkRecoveryDelivery(
      prepared.prepared.recoveryHandoffId,
      run.storage
    )
    expect(stored?.fundingInvoiceExposedAt).not.toBeNull()
    expect(
      initialDelivery?.deliveryProgress.acknowledgedRelayRefs
    ).toHaveLength(1)
    expect(plan.recipients[0]!.destination.source).toMatchObject({
      type: "signed_profile",
      profileEventId: signedProfileContext(true).frontier?.eventId,
    })
    expect(run.calls).toEqual({
      metadata: 1,
      material: 1,
      wallet: 1,
      receive: 1,
      recoveryPublish: 1,
      order: 1,
    })
    expect(
      await loadAuthorizedCheckoutSparkSettledFunding(plan.checkoutId, {
        storage: run.storage,
        recoveryStorage: run.storage,
        repository: run.repository,
        expectedBuyerPubkey: BUYER.pubkey,
        now: () => NOW + 2_000,
      })
    ).toMatchObject({ fundingInvoice: plan.funding.paymentRequest })

    let payerCalls = 0
    let creditReads = 0
    let payerSubmitted = false
    const bridge = createCheckoutSparkSettledFundingBridge(plan.checkoutId, {
      storage: run.storage,
      recoveryStorage: run.storage,
      repository: run.repository,
      requireCrossTabLock: false,
      withStoreWriteLock: async <T>(operation: () => Promise<T>) => operation(),
      now: () => NOW + 2_000,
      attestCredit: async (walletId, receive) => {
        creditReads += 1
        expect(walletId).toBe(plan.walletId)
        expect(receive.id).toBe(plan.funding.requestId)
        return payerSubmitted
          ? {
              mode: "ordinary_v3",
              requestId: plan.funding.requestId,
              transferId: "exact-credited-transfer",
              receiverIdentityPublicKey: RECEIVER_IDENTITY,
              grossSats: GROSS,
              creditedSats: GROSS,
            }
          : null
      },
      payInvoice: async (request) => {
        payerCalls += 1
        expect(request.invoice).toBe(plan.funding.paymentRequest)
        expect(request.amountMsats).toBe(GROSS * 1_000)
        expect(
          getCheckoutSparkSettledPreparation(plan.checkoutId, run.storage)
        ).toMatchObject({ fundingSubmissionState: "provisional" })
        payerSubmitted = true
        return { status: "paid", rail: "wallet", preimage: "6".repeat(64) }
      },
    })
    const fundingInput = {
      buyerPubkey: BUYER.pubkey,
      shouldContinue: () => true,
      paymentTarget: {
        type: "wallet" as const,
        providerId: "spark",
        walletId: "payer",
      },
      walletPaymentAttemptId: "vertical-payer-attempt",
      timeoutMs: 10_000,
      appId: "market" as const,
    }
    expect((await bridge.fund(fundingInput)).status).toBe("funded")
    expect((await bridge.fund(fundingInput)).status).toBe("funded")
    expect(payerCalls).toBe(1)
    // Each retry reattests the receive, including when local state has credit.
    expect(creditReads).toBe(3)
    const credited = run.repository.snapshot()
    expect(credited.status).toBe("active")
    if (credited.status !== "active") return
    expect(credited.state.credit?.creditedSats).toBe(GROSS)
    expect(run.repository.settlement()?.credit?.creditedSats).toBe(GROSS)
    expect(
      projectCheckoutSparkMerchantSettlement(run.repository.settlement()!)
        .commerceVerified
    ).toBe(false)
    expect(credited.state.legs.map((leg) => leg.allocationSats)).toEqual([
      1_002, 111,
    ])

    const acknowledgeRecoverySnapshot = async (
      state: CheckoutSparkSettledReconciliation
    ) => {
      const result = await acknowledgeOrRetryCheckoutSparkSettledSnapshot({
        initialHandoffId: prepared.prepared.recoveryHandoffId,
        state,
        identity: entryRequest(plan.checkoutId).buyer,
        preparedAt: NOW + 10_000,
        storage: run.storage,
        now: () => NOW + 10_000,
        transport: run.transport,
      })
      expect(result.acknowledged).toBe(true)
    }
    const resolveInvoice = async (input: CheckoutSparkLnurlInvoiceInput) => {
      const hashByte = input.lud16 === "merchant@wallet.conduit.market" ? 4 : 5
      return resolveCheckoutSparkFixtureInvoice(
        input,
        invoice(input.amountSats, hashByte)
      )
    }
    for (const recipient of plan.recipients) {
      await prepareCheckoutSparkSettledOutgoingLeg(
        {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          legId: recipient.legId,
          shouldContinue: () => true,
        },
        {
          repository: run.repository,
          walletManager: { estimateCheckoutLightningFee: async () => 1 },
          resolveInvoice,
          acknowledgeRecoverySnapshot,
          nowMs: () => NOW + 4_000,
        }
      )
    }

    const sends: string[] = []
    let merchantHistory: CheckoutSparkSettledOutgoingObservation["status"] =
      "not_found"
    const provider = {
      reconcile: async (target: {
        legId: string
        intent: NonNullable<(typeof credited.state.legs)[number]["intent"]>
      }) => ({
        legId: target.legId,
        transferId: target.intent.transferId,
        paymentRequest: target.intent.paymentRequest,
        paymentHash: target.intent.paymentHash,
        invoiceAmountSats: target.intent.invoiceAmountSats,
        maxFeeSats: target.intent.maxFeeSats,
        status:
          target.legId === plan.recipients[0]!.legId
            ? merchantHistory
            : ("not_found" as const),
        ...(target.legId === plan.recipients[0]!.legId &&
        merchantHistory === "paid"
          ? {
              finalFeeSats: 1,
              finalDebitSats: target.intent.invoiceAmountSats + 1,
            }
          : {}),
      }),
      preflight: async () => "ready" as const,
      send: async (target: {
        legId: string
        intent: NonNullable<(typeof credited.state.legs)[number]["intent"]>
      }) => {
        sends.push(target.legId)
        const snapshot = run.repository.snapshot()
        expect(snapshot.status).toBe("active")
        if (snapshot.status !== "active") throw new Error("Missing state")
        expect(
          snapshot.state.legs.find((leg) => leg.legId === target.legId)?.status
        ).toBe("submitted")
        if (target.legId === plan.recipients[0]!.legId) {
          throw new Error("Merchant provider response lost")
        }
        expect(snapshot.state.legs[0]!.status).toBe("paid")
        return {
          legId: target.legId,
          transferId: target.intent.transferId,
          paymentRequest: target.intent.paymentRequest,
          paymentHash: target.intent.paymentHash,
          invoiceAmountSats: target.intent.invoiceAmountSats,
          maxFeeSats: target.intent.maxFeeSats,
          status: "paid" as const,
          finalFeeSats: 1,
          finalDebitSats: target.intent.invoiceAmountSats + 1,
        }
      },
    }
    const step = (legId: string) =>
      runCheckoutSparkSettledOutgoingStep({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        legId,
        actor: "shopper",
        now: () => NOW + 5_000,
        store: run.repository,
        provider,
        acknowledgeRecoverySnapshot,
      })
    const merchantLegId = plan.recipients[0]!.legId
    const conduitLegId = plan.recipients[1]!.legId
    expect((await step(conduitLegId)).reason).toBe("prerequisite_unpaid")
    expect((await step(merchantLegId)).outcome).toBe("send_ambiguous")
    expect((await step(conduitLegId)).reason).toBe("prerequisite_unpaid")
    expect((await step(merchantLegId)).reason).toBe("prior_possible_send")
    expect(sends).toEqual([merchantLegId])

    merchantHistory = "paid"
    expect((await step(merchantLegId)).outcome).toBe("paid")
    expect((await step(conduitLegId)).outcome).toBe("paid")
    expect(sends).toEqual([merchantLegId, conduitLegId])
    const final = run.repository.snapshot()
    expect(final.status).toBe("active")
    if (final.status === "active") {
      expect(final.state.legs.map((leg) => leg.status)).toEqual([
        "paid",
        "paid",
      ])
    }
    // This lower-level Core runner bypasses the Market provider-fact capture.
    // Local paid markers alone must not promote verified commerce.
    expect(run.repository.settlement()?.paidLegs).toEqual([])
    expect(
      projectCheckoutSparkMerchantSettlement(run.repository.settlement()!)
        .commerceVerified
    ).toBe(false)
  })
})

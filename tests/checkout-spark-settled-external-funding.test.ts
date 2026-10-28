import { describe, expect, it } from "bun:test"
import type { NDKSigner } from "@nostr-dev-kit/ndk"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  DexieCheckoutSparkSettledRepository,
  calculateCheckoutSparkSettledGrossFundingSats,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeeRecipient,
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
} from "@conduit/core"
import { nativeTreasuryFixture } from "./support/checkout-spark-native-treasury-fixture"
import {
  createCheckoutSparkSettledFundingBridge,
  type CheckoutSparkSettledFundingDependencies,
  type CheckoutSparkSettledFundingPaymentInput,
} from "../apps/market/src/lib/checkout-spark-settled-funding"
import {
  getCheckoutSparkSettledPreparation,
  saveCheckoutSparkSettledPreparation,
  type PreparedCheckoutSparkSettledFunding,
  type StoredCheckoutSparkSettledPreparation,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import {
  GUEST_ORDER_SESSION_TTL_MS,
  isCurrentGuestOrderSigningIdentity,
  type GuestOrderSigningIdentity,
} from "../apps/market/src/lib/guest-order-identity"

const NOW = 1_800_000_000_000
const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)
const RECEIVER = `02${"c".repeat(64)}`
const GROSS = calculateCheckoutSparkSettledGrossFundingSats(1_000)
const CONDUIT = checkoutSparkConduitFeeRecipient("production")
const INVOICE = makeSignedBolt11Fixture({
  hrp: `lnbc${GROSS * 10}n`,
  createdAt: NOW / 1_000,
  fields: [
    bolt11PaymentHashField(new Uint8Array(32).fill(3)),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
    { tag: "x", words: [9, 12] },
  ],
})

class MemoryStorage {
  readonly values = new Map<string, string>()
  writeMode: "normal" | "throw" | "drop" = "normal"
  writes = 0

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.writes += 1
    if (this.writeMode === "throw") throw new Error("Storage write failed")
    if (this.writeMode === "drop") return
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(payActivation = false) {
  const legacyPlan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-external-funding",
    orderId: "order-external-funding",
    merchantPubkey: MERCHANT,
    walletId: "temporary-router-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 45 * 60_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:offline-product`,
          productEventId: "d".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "offline-funding-request",
      paymentRequest: INVOICE,
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: RECEIVER,
      grossFundingSats: GROSS,
      createdAt: NOW,
      expiresAt: NOW + 300_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@example.invalid",
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: CONDUIT,
        destination: {
          type: "lightning_address",
          value: CONDUIT,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: calculateConduitCheckoutFeeSats(1_000),
      },
    ],
  })
  const treasury = nativeTreasuryFixture().plan.nativeTreasury!
  const { takeoverAt: _historicalCutoff, ...untimed } = legacyPlan
  void _historicalCutoff
  const plan = payActivation
    ? freezeCheckoutSparkSettledTreasuryPlan({
        ...untimed,
        executionTiming: { type: "pay_activation_v1", windowMs: 120_000 },
        nativeTreasury: {
          ...treasury,
          invoiceId: deriveCheckoutSparkNativeTreasuryInvoiceId({
            ...legacyPlan,
            sparkAddress: treasury.sparkAddress,
            receiverIdentityPublicKey: treasury.receiverIdentityPublicKey,
            senderIdentityPublicKey: RECEIVER,
          }),
        },
      })
    : legacyPlan
  let state = createCheckoutSparkSettledReconciliation(plan)
  let revision = 1
  let now = NOW + 1_000
  let active = true
  let buyerVerified = true
  let proofAvailable = false
  let historyUnavailable = false
  let authorizationError: string | null = null
  let fundingLockHeld = false
  let storeLockBusy = false
  let payerResult: "forbidden" | "accepted" | "unknown" = "forbidden"
  let beforeSendCalls = 0
  let authorizationReads = 0
  let payerCalls = 0
  let creditRecords = 0
  let hook: ((stage: string) => void | Promise<void>) | undefined
  const events: string[] = []
  const storage = new MemoryStorage()
  const metadata = () =>
    getCheckoutSparkSettledPreparation(plan.checkoutId, storage)!
  saveCheckoutSparkSettledPreparation(
    {
      schemaVersion: 3,
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      recoveryHandoffId: "offline-handoff",
      fundingInvoiceExposedAt: NOW,
      fundingSubmissionState: "not_started",
      savedAt: NOW,
    },
    storage
  )
  const prepared: PreparedCheckoutSparkSettledFunding = {
    plan,
    state,
    fundingInvoice: INVOICE,
    recoveryHandoffId: "offline-handoff",
    fundingReceive: {
      walletId: plan.walletId,
      network: plan.network,
      id: plan.funding.requestId,
      paymentRequest: INVOICE,
      paymentHash: plan.funding.paymentHash,
      providerStatus: "PERSISTED",
      requiredNetSats: GROSS,
      grossFundingSats: GROSS,
      expirySecs: 300,
      createdAt: NOW,
      expiresAt: plan.funding.expiresAt,
      receiveSettledPolicy: "ordinary-exact-credit-v3",
      receiverIdentityPublicKey: RECEIVER,
    },
  }
  const stage = async (name: string) => {
    events.push(name)
    await hook?.(name)
  }
  const dependencies: CheckoutSparkSettledFundingDependencies = {
    storage,
    recoveryStorage: storage,
    requireCrossTabLock: true,
    now: () => now,
    verifyBuyerAuthority: (_handoff, principal) =>
      buyerVerified && principal === BUYER,
    loadAuthorized: async (checkoutId, options) => {
      await stage(
        ++authorizationReads === 1 ? "authorization" : "reauthorization"
      )
      if (authorizationError) throw new Error(authorizationError)
      if (
        checkoutId !== plan.checkoutId ||
        options?.expectedBuyerPubkey !== BUYER
      ) {
        throw new Error("Frozen funding owner changed")
      }
      return { ...prepared, state }
    },
    repository: {
      create: async () => {
        throw new Error("External exposure must not create a plan")
      },
      load: async (checkoutId, planDigest) => {
        expect(checkoutId).toBe(plan.checkoutId)
        expect(planDigest).toBe(plan.planDigest)
        await stage("snapshot")
        return { status: "active", revision, state }
      },
      save: async (next, expectedRevision) => {
        expect(expectedRevision).toBe(revision)
        revision += 1
        state = next
        await stage("credit_saved")
        return { status: "active", revision, state }
      },
      recordMerchantCredit: async (
        savedPlan,
        proof,
        _observedAt,
        assertCurrent
      ) => {
        expect(assertCurrent?.()).toBeUndefined()
        expect(savedPlan.planDigest).toBe(plan.planDigest)
        expect(proof.transferId).toBe("offline-exact-credit")
        creditRecords += 1
        return createCheckoutSparkMerchantSettlementRecord(plan)
      },
    },
    attestCredit: async (walletId, receive) => {
      expect(walletId).toBe(plan.walletId)
      expect(receive.id).toBe(plan.funding.requestId)
      await stage("credit")
      if (historyUnavailable) throw new Error("Exact history unavailable")
      return proofAvailable
        ? {
            mode: "ordinary_v3",
            requestId: plan.funding.requestId,
            transferId: "offline-exact-credit",
            receiverIdentityPublicKey: RECEIVER,
            grossSats: GROSS,
            creditedSats: GROSS - 1,
          }
        : null
    },
    payInvoice: async () => {
      payerCalls += 1
      await stage("payer")
      if (payerResult !== "accepted")
        throw new Error("Offline payer response unavailable")
      return { status: "paid", rail: "wallet", preimage: "f".repeat(64) }
    },
    lockManager: {
      async request(name, options, callback) {
        expect(name).toBe(
          `conduit:checkout-spark-settled-funding:${plan.checkoutId}`
        )
        expect(options).toEqual({ mode: "exclusive", ifAvailable: true })
        if (fundingLockHeld) return callback(null)
        fundingLockHeld = true
        events.push("funding_lock")
        try {
          return await callback({ name })
        } finally {
          fundingLockHeld = false
          events.push("funding_unlock")
        }
      },
    },
    withStoreWriteLock: async <T>(operation: () => Promise<T>): Promise<T> => {
      if (storeLockBusy) throw new Error("Shared preparation store busy")
      await stage("before_store_write")
      const value = await operation()
      await stage("after_store_write")
      return value
    },
  }
  const input: CheckoutSparkSettledFundingPaymentInput = {
    buyerPubkey: BUYER,
    shouldContinue: () => active,
    exposeExternalInvoice: true,
    paymentTarget: { type: "manual" },
    beforeSend: async () => {
      await stage(`beforeSend:${++beforeSendCalls}`)
    },
    timeoutMs: 10_000,
    appId: "market",
  }
  const bridge = () =>
    createCheckoutSparkSettledFundingBridge(plan.checkoutId, dependencies)
  return {
    plan,
    prepared,
    storage,
    dependencies,
    input,
    events,
    metadata,
    bridge,
    state: () => state,
    run: (overrides: Partial<CheckoutSparkSettledFundingPaymentInput> = {}) =>
      bridge().fund({ ...input, ...overrides }),
    counts: () => ({ payerCalls, creditRecords, beforeSendCalls }),
    setNow(value: number) {
      now = value
    },
    setActive(value: boolean) {
      active = value
    },
    setBuyerVerified(value: boolean) {
      buyerVerified = value
    },
    setProofAvailable(value: boolean) {
      proofAvailable = value
    },
    setHistoryUnavailable(value: boolean) {
      historyUnavailable = value
    },
    setAuthorizationError(value: string) {
      authorizationError = value
    },
    setStoreLockBusy(value: boolean) {
      storeLockBusy = value
    },
    setPayerResult(value: typeof payerResult) {
      payerResult = value
    },
    hook(value: typeof hook) {
      hook = value
    },
    seed(patch: Partial<StoredCheckoutSparkSettledPreparation>) {
      return saveCheckoutSparkSettledPreparation(
        { ...metadata(), ...patch },
        storage
      )
    },
  }
}

describe("one-time Pay activation before funding admission", () => {
  it("does not reserve or enter the connected payer when acknowledgement outlives the invoice", async () => {
    const test = fixture(true)
    await expect(
      test.run({
        exposeExternalInvoice: false,
        paymentTarget: {
          type: "wallet",
          providerId: "nwc",
          walletId: "test-payer",
        },
        acknowledgeRecoverySnapshot: async () => {
          test.setNow(test.plan.funding.expiresAt)
        },
      })
    ).rejects.toThrow("expired")
    expect(test.state().buyerActivation).not.toBeNull()
    expect(test.metadata().fundingSubmissionState).toBe("not_started")
    expect(test.counts().payerCalls).toBe(0)
  })

  it("retains the same IndexedDB activation across competing tabs and a reopened connection", async () => {
    const test = fixture(true)
    const name = `pay-activation-funding-${crypto.randomUUID()}`
    let database = new ConduitDB(name, { indexedDB, IDBKeyRange })
    let repository = new DexieCheckoutSparkSettledRepository(database)
    const released = deferred()
    try {
      await repository.create(test.plan)
      test.dependencies.repository = repository
      test.dependencies.loadAuthorized = async () => {
        const saved = await repository.load(
          test.plan.checkoutId,
          test.plan.planDigest
        )
        if (saved.status !== "active") throw new Error("Saved plan unavailable")
        return { ...test.prepared, state: saved.state }
      }
      const entered = deferred()
      const first = test.run({
        acknowledgeRecoverySnapshot: async (state) => {
          expect(state.buyerActivation?.activatedAt).toBe(NOW + 1_000)
          entered.resolve()
          await released.promise
        },
      })
      await Promise.race([entered.promise, first])
      await expect(
        test.run({
          acknowledgeRecoverySnapshot: async () => {
            throw new Error("Competing tab must not acknowledge")
          },
        })
      ).rejects.toThrow("another tab")
      expect(test.metadata().externalFundingExposedAt).toBeUndefined()
      released.resolve()
      expect((await first).status).toBe("external_ready")
      const original = await repository.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(original.status).toBe("active")
      database.close()
      database = new ConduitDB(name, { indexedDB, IDBKeyRange })
      repository = new DexieCheckoutSparkSettledRepository(database)
      test.dependencies.repository = repository
      test.setNow(NOW + 40_000)
      const reopened = await test.run({
        acknowledgeRecoverySnapshot: async (state) => {
          if (original.status !== "active")
            throw new Error("Original plan unavailable")
          expect(state.buyerActivation).toEqual(original.state.buyerActivation)
        },
      })
      expect(reopened.status).toBe("external_ready")
      if (reopened.status === "external_ready") {
        expect(reopened.externalInvoice.takeoverAt).toBe(NOW + 121_000)
      }
      expect(test.counts().payerCalls).toBe(0)
    } finally {
      released.resolve()
      await database.delete()
    }
  })

  it("starts only at Pay and waits for saved activation ACK before external disclosure", async () => {
    const test = fixture(true)
    test.setNow(NOW + 180_000)
    const entered = deferred()
    const released = deferred()
    const pending = test.run({
      acknowledgeRecoverySnapshot: async (state) => {
        expect(test.state().buyerActivation).toEqual(state.buyerActivation)
        expect(state.buyerActivation?.activatedAt).toBe(NOW + 180_000)
        expect(test.metadata().externalFundingExposedAt).toBeUndefined()
        entered.resolve()
        await released.promise
      },
    })
    await Promise.race([entered.promise, pending])
    expect(test.state().buyerActivation?.takeoverAt).toBe(NOW + 300_000)
    expect(test.metadata().fundingSubmissionState).toBe("not_started")
    released.resolve()
    const result = await pending
    expect(result.status).toBe("external_ready")
    if (result.status === "external_ready") {
      expect(result.externalInvoice.takeoverAt).toBe(NOW + 300_000)
    }
    expect(test.counts().payerCalls).toBe(0)
  })

  it("keeps the activation fixed across failed ACK and a fresh bridge retry", async () => {
    const test = fixture(true)
    await expect(
      test.run({
        acknowledgeRecoverySnapshot: async () => {
          throw new Error("Recovery not acknowledged")
        },
      })
    ).rejects.toThrow("Recovery not acknowledged")
    const activation = test.state().buyerActivation
    expect(activation?.activatedAt).toBe(NOW + 1_000)
    expect(test.metadata().fundingSubmissionState).toBe("not_started")
    test.setNow(NOW + 40_000)
    let acknowledged = false
    const result = await test.run({
      acknowledgeRecoverySnapshot: async (state) => {
        expect(state.buyerActivation).toEqual(activation)
        acknowledged = true
      },
    })
    expect(acknowledged).toBe(true)
    expect(result.status).toBe("external_ready")
    expect(test.state().buyerActivation).toEqual(activation)
  })

  it("cannot activate from passive inspection or a manual rail without disclosure", async () => {
    const test = fixture(true)
    expect((await test.run({ inspectionOnly: true })).status).toBe(
      "manual_required"
    )
    expect(test.state().buyerActivation).toBeNull()
    test.dependencies.payInvoice = async () => ({
      status: "manual_required",
      reason: "Select a payment method",
    })
    expect((await test.run({ exposeExternalInvoice: false })).status).toBe(
      "manual_required"
    )
    expect(test.state().buyerActivation).toBeNull()
  })

  it("holds new funding without an activation delivery callback", async () => {
    const test = fixture(true)
    await expect(test.run()).rejects.toThrow("activation")
    expect(test.state().buyerActivation).toBeNull()
    expect(test.metadata().externalFundingExposedAt).toBeUndefined()
    expect(test.counts().payerCalls).toBe(0)
  })

  it("saves and ACKs before any connected payer call and never resets after a definite pre-send refusal", async () => {
    const test = fixture(true)
    let acknowledged = false
    let calls = 0
    test.dependencies.payInvoice = async (input) => {
      expect(acknowledged).toBe(true)
      expect(test.state().buyerActivation).not.toBeNull()
      await input.beforeSend?.()
      calls += 1
      return {
        status: "retryable_failure",
        reason: "Provider unavailable before submission",
        phase: "before_publish",
      }
    }
    const input = {
      exposeExternalInvoice: false,
      paymentTarget: {
        type: "wallet" as const,
        providerId: "nwc",
        walletId: "test-payer",
      },
      acknowledgeRecoverySnapshot: async () => {
        acknowledged = true
      },
    }
    expect((await test.run(input)).status).toBe("payment_retryable")
    const activation = test.state().buyerActivation
    expect(test.metadata().fundingSubmissionState).toBe("not_started")
    test.setNow(NOW + 30_000)
    expect((await test.run(input)).status).toBe("payment_retryable")
    expect(test.state().buyerActivation).toEqual(activation)
    expect(calls).toBe(2)
  })

  it("does not ACK or disclose if activation cannot be durably saved", async () => {
    const test = fixture(true)
    let acknowledged = false
    test.dependencies.repository!.save = async () => {
      throw new Error("Activation storage failed")
    }
    await expect(
      test.run({
        acknowledgeRecoverySnapshot: async () => {
          acknowledged = true
        },
      })
    ).rejects.toThrow("Activation storage failed")
    expect(acknowledged).toBe(false)
    expect(test.metadata().externalFundingExposedAt).toBeUndefined()
  })

  it("does not disclose when the Buyer session is revoked during activation ACK", async () => {
    const test = fixture(true)
    await expect(
      test.run({
        acknowledgeRecoverySnapshot: async () => {
          test.setActive(false)
        },
      })
    ).rejects.toThrow("buyer session")
    expect(test.metadata().externalFundingExposedAt).toBeUndefined()
    expect(test.counts().payerCalls).toBe(0)
  })

  it("leaves historical funding terms unchanged", async () => {
    const test = fixture()
    const result = await test.run({
      acknowledgeRecoverySnapshot: async () => {
        throw new Error("Historical funding must not activate")
      },
    })
    expect(result.status).toBe("external_ready")
    expect(test.state().buyerActivation).toBeUndefined()
  })
})

describe("settled external funding disclosure", () => {
  it.each(["sender_changed", "session_revoked"] as const)(
    "waits for asynchronous recovery authority and stops when %s",
    async (change) => {
      const test = fixture()
      const entered = deferred()
      const released = deferred()
      test.dependencies.verifyBuyerAuthority = async () => {
        entered.resolve()
        await released.promise
        return change !== "sender_changed"
      }
      const pending = test.run()
      const failure = pending.then(
        () => null,
        (error: unknown) => error
      )
      try {
        await entered.promise
        expect(test.events).toEqual(["funding_lock", "authorization"])
        expect(test.metadata().fundingSubmissionState).toBe("not_started")
        expect(test.counts().payerCalls).toBe(0)
        if (change === "session_revoked") test.setActive(false)
        released.resolve()
        const error = await failure
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("buyer session")
        expect(test.metadata().fundingSubmissionState).toBe("not_started")
        expect(test.counts().creditRecords).toBe(0)
        expect(test.counts().payerCalls).toBe(0)
      } finally {
        released.resolve()
      }
    }
  )

  it.each(["nwc", "spark"] as const)(
    "keeps ambiguous guest %s funding reserved across session loss without giving the rail account authority",
    async (providerId) => {
      const test = fixture()
      const guest: GuestOrderSigningIdentity = {
        kind: "guest_ephemeral",
        pubkey: BUYER,
        orderId: test.plan.orderId,
        merchantPubkey: MERCHANT,
        createdAt: NOW,
        expiresAt: NOW + GUEST_ORDER_SESSION_TTL_MS,
        signer: { pubkey: BUYER } as NDKSigner,
      }
      let current: GuestOrderSigningIdentity | null = guest
      const shouldContinue = () =>
        isCurrentGuestOrderSigningIdentity(
          current,
          {
            orderId: test.plan.orderId,
            merchantPubkey: MERCHANT,
            pubkey: BUYER,
          },
          NOW + 1_000
        )
      const originalPay = test.dependencies.payInvoice!
      test.dependencies.payInvoice = async (request) => {
        expect(request).not.toHaveProperty("buyerPubkey")
        expect(request).not.toHaveProperty("authenticatedPubkey")
        expect(request).not.toHaveProperty("guestIdentity")
        await request.beforeSend?.()
        return originalPay(request)
      }
      test.setPayerResult("unknown")
      test.hook((stage) => {
        if (stage === "payer") current = null
      })
      const input = {
        exposeExternalInvoice: false,
        shouldContinue,
        paymentTarget: {
          type: "wallet" as const,
          providerId,
          walletId: "device-owned-payer",
        },
      }
      await expect(test.run(input)).rejects.toThrow("buyer session")
      expect(test.metadata().fundingSubmissionState).toBe("provisional")
      expect(test.counts().payerCalls).toBe(1)
      current = { ...guest, signer: { pubkey: BUYER } as NDKSigner }
      test.hook(undefined)
      expect((await test.run(input)).status).toBe("awaiting_reconciliation")
      expect((await test.run({ shouldContinue })).status).toBe(
        "awaiting_reconciliation"
      )
      expect(test.counts().payerCalls).toBe(1)
      expect(test.metadata()).not.toHaveProperty("externalFundingExposedAt")
    }
  )

  it("durably reserves the exact frozen invoice before exposing it without a payer call", async () => {
    const test = fixture()
    const result = await test.run()
    expect(result).toMatchObject({
      status: "external_ready",
      reconciliation: { credit: null },
      externalInvoice: {
        checkoutId: test.plan.checkoutId,
        planDigest: test.plan.planDigest,
        orderId: test.plan.orderId,
        buyerPubkey: BUYER,
        invoice: INVOICE,
        amountSats: GROSS,
        expiresAt: test.plan.funding.expiresAt,
        takeoverAt: test.plan.takeoverAt,
        exposedAt: NOW + 1_000,
      },
    })
    expect(test.metadata()).toMatchObject({
      fundingSubmissionState: "provisional",
      externalFundingExposedAt: NOW + 1_000,
      fundingInvoiceExposedAt: NOW,
    })
    expect(test.counts()).toEqual({
      payerCalls: 0,
      creditRecords: 0,
      beforeSendCalls: 2,
    })
    expect(test.events.indexOf("credit")).toBeLessThan(
      test.events.indexOf("beforeSend:1")
    )
    expect(test.events.indexOf("beforeSend:1")).toBeLessThan(
      test.events.indexOf("before_store_write")
    )
    expect(test.events.indexOf("after_store_write")).toBeLessThan(
      test.events.indexOf("beforeSend:2")
    )
    expect(test.events.at(-1)).toBe("funding_unlock")
  })

  it("reopens only the same externally reserved invoice across bridge recreation", async () => {
    const test = fixture()
    const first = await test.run()
    test.setNow(NOW + 2_000)
    const reopened = await test.run()
    expect(first.status).toBe("external_ready")
    expect(reopened.status).toBe("external_ready")
    if (
      first.status !== "external_ready" ||
      reopened.status !== "external_ready"
    )
      return
    expect(reopened.externalInvoice).toEqual(first.externalInvoice)
    expect(test.metadata().externalFundingExposedAt).toBe(NOW + 1_000)
    expect(test.counts().payerCalls).toBe(0)
  })

  it.each(["spark", "nwc", "webln"] as const)(
    "blocks a later %s rail after external exposure, including a recreated bridge",
    async (rail) => {
      const test = fixture()
      await test.run()
      const result = await test.run({
        exposeExternalInvoice: false,
        paymentTarget:
          rail === "webln"
            ? { type: "webln" }
            : {
                type: "wallet",
                providerId: rail,
                walletId: "another-payer",
              },
      })
      expect(result.status).toBe("awaiting_reconciliation")
      expect(result).not.toHaveProperty("externalInvoice")
      expect(test.counts().payerCalls).toBe(0)
    }
  )

  it.each(["legacy", "accepted", "unknown"] as const)(
    "never turns %s automatic ambiguity into permission to expose an external invoice",
    async (outcome) => {
      const test = fixture()
      if (outcome === "legacy") {
        test.seed({ fundingSubmissionState: "provisional", savedAt: NOW + 1 })
      } else {
        test.setPayerResult(outcome)
        expect(
          (
            await test.run({
              exposeExternalInvoice: false,
              paymentTarget: {
                type: "wallet",
                providerId: "nwc",
                walletId: "original-payer",
              },
            })
          ).status
        ).toBe("awaiting_reconciliation")
      }
      const original = test.metadata()
      expect(original).not.toHaveProperty("externalFundingExposedAt")
      const result = await test.run()
      expect(result.status).toBe("awaiting_reconciliation")
      expect(result).not.toHaveProperty("externalInvoice")
      expect(test.metadata()).toEqual(original)
      expect(test.counts().payerCalls).toBe(outcome === "legacy" ? 0 : 1)
    }
  )

  it.each([false, true])(
    "inspection-only never discloses an invoice (already exposed: %s)",
    async (exposed) => {
      const test = fixture()
      if (exposed) await test.run()
      const before = test.metadata()
      const result = await test.run({ inspectionOnly: true })
      expect(result.status).not.toBe("external_ready")
      expect(result).not.toHaveProperty("externalInvoice")
      expect(test.metadata()).toEqual(before)
      expect(test.counts().payerCalls).toBe(0)
    }
  )

  it.each(["spark", "nwc", "webln"] as const)(
    "rejects external disclosure requested with %s",
    async (rail) => {
      const test = fixture()
      await expect(
        test.run({
          paymentTarget:
            rail === "webln"
              ? { type: "webln" }
              : {
                  type: "wallet",
                  providerId: rail,
                  walletId: "payer",
                },
        })
      ).rejects.toThrow()
      expect(test.counts().payerCalls).toBe(0)
      expect(test.metadata().fundingSubmissionState).toBe("not_started")
      expect(test.metadata()).not.toHaveProperty("externalFundingExposedAt")
    }
  )

  it.each([
    "missing recovery ACK",
    "retired frozen plan",
    "changed frozen plan",
  ])("exposes nothing when authorized loading rejects %s", async (reason) => {
    const test = fixture()
    test.setAuthorizationError(reason)
    await expect(test.run()).rejects.toThrow(reason)
    expect(test.metadata().fundingSubmissionState).toBe("not_started")
    expect(test.counts().payerCalls).toBe(0)
    expect(test.events).not.toContain("credit")
  })

  it.each(["wrong buyer", "revoked sender", "inactive page"])(
    "exposes nothing for %s",
    async (reason) => {
      const test = fixture()
      if (reason === "revoked sender") test.setBuyerVerified(false)
      if (reason === "inactive page") test.setActive(false)
      await expect(
        test.run(
          reason === "wrong buyer" ? { buyerPubkey: "f".repeat(64) } : {}
        )
      ).rejects.toThrow()
      expect(test.metadata().fundingSubmissionState).toBe("not_started")
      expect(test.counts().payerCalls).toBe(0)
    }
  )

  it.each(["throw", "drop"] as const)(
    "requires successful reservation write and readback when storage would %s",
    async (mode) => {
      const test = fixture()
      test.storage.writeMode = mode
      await expect(test.run()).rejects.toThrow()
      expect(test.metadata().fundingSubmissionState).toBe("not_started")
      expect(test.metadata()).not.toHaveProperty("externalFundingExposedAt")
      expect(test.counts().payerCalls).toBe(0)
    }
  )

  it("fails closed if the shared preparation store lock is busy", async () => {
    const test = fixture()
    test.setStoreLockBusy(true)
    await expect(test.run()).rejects.toThrow("Shared preparation store busy")
    expect(test.metadata().fundingSubmissionState).toBe("not_started")
    expect(test.counts().payerCalls).toBe(0)
  })

  it("fails closed without browser funding-lock support", async () => {
    const test = fixture()
    test.dependencies.lockManager = null
    await expect(test.run()).rejects.toThrow("cannot coordinate")
    expect(test.events).toEqual([])
    expect(test.metadata().fundingSubmissionState).toBe("not_started")
  })

  it("serializes external exposure against another tab's payer attempt", async () => {
    const test = fixture()
    const entered = deferred()
    const release = deferred()
    test.hook(async (stage) => {
      if (stage !== "credit") return
      entered.resolve()
      await release.promise
    })
    const first = test.run()
    await entered.promise
    await expect(
      test.run({
        exposeExternalInvoice: false,
        paymentTarget: { type: "webln" },
      })
    ).rejects.toThrow("another tab")
    release.resolve()
    expect((await first).status).toBe("external_ready")
    expect(test.counts().payerCalls).toBe(0)
    expect(
      test.events.filter((event) => event === "funding_lock")
    ).toHaveLength(1)
  })

  it("coalesces duplicate exposure clicks within one bridge", async () => {
    const test = fixture()
    const bridge = test.bridge()
    const entered = deferred()
    const release = deferred()
    test.hook(async (stage) => {
      if (stage !== "credit") return
      entered.resolve()
      await release.promise
    })
    const first = bridge.fund(test.input)
    await entered.promise
    const second = bridge.fund(test.input)
    expect(second).toBe(first)
    release.resolve()
    expect((await first).status).toBe("external_ready")
    expect(
      test.events.filter((event) => event === "before_store_write")
    ).toHaveLength(1)
  })

  it.each([
    "authorization",
    "snapshot",
    "credit",
    "beforeSend:1",
    "before_store_write",
    "after_store_write",
    "reauthorization",
    "beforeSend:2",
  ])(
    "invalidates external exposure when authority changes during %s",
    async (heldStage) => {
      const test = fixture()
      test.hook((stage) => {
        if (stage === heldStage) test.setActive(false)
      })
      await expect(test.run()).rejects.toThrow()
      expect(test.counts().payerCalls).toBe(0)
      if (
        ["after_store_write", "reauthorization", "beforeSend:2"].includes(
          heldStage
        )
      ) {
        expect(test.metadata().fundingSubmissionState).toBe("provisional")
      } else {
        expect(test.metadata().fundingSubmissionState).toBe("not_started")
      }
    }
  )

  it.each([
    "credit",
    "beforeSend:1",
    "before_store_write",
    "after_store_write",
    "reauthorization",
    "beforeSend:2",
  ])(
    "does not disclose an invoice that expires during %s",
    async (heldStage) => {
      const test = fixture()
      test.hook((stage) => {
        if (stage === heldStage) test.setNow(test.plan.funding.expiresAt)
      })
      if (heldStage === "credit") {
        const result = await test.run()
        expect(result.status).toBe("manual_required")
        expect(result).not.toHaveProperty("externalInvoice")
      } else {
        await expect(test.run()).rejects.toThrow("no longer payable")
      }
      expect(test.counts().payerCalls).toBe(0)
      if (
        ["after_store_write", "reauthorization", "beforeSend:2"].includes(
          heldStage
        )
      ) {
        expect(test.metadata().fundingSubmissionState).toBe("provisional")
      } else {
        expect(test.metadata().fundingSubmissionState).toBe("not_started")
      }
    }
  )

  it.each(["expiry", "handoff", "invalid clock"])(
    "does not expose at %s",
    async (boundary) => {
      const test = fixture()
      test.setNow(
        boundary === "expiry"
          ? test.plan.funding.expiresAt
          : boundary === "handoff"
            ? test.plan.takeoverAt
            : Number.NaN
      )
      const result = await test.run()
      expect(result.status).not.toBe("external_ready")
      expect(result).not.toHaveProperty("externalInvoice")
      expect(test.metadata().fundingSubmissionState).toBe("not_started")
      expect(test.counts().payerCalls).toBe(0)
    }
  )

  it.each([false, true])(
    "requires exact available credit history before disclosure (prior external: %s)",
    async (exposed) => {
      const test = fixture()
      if (exposed) await test.run()
      const before = test.metadata()
      test.setHistoryUnavailable(true)
      const result = await test.run()
      expect(result.status).toBe("awaiting_reconciliation")
      expect(result).not.toHaveProperty("externalInvoice")
      expect(test.metadata()).toEqual(before)
      expect(test.counts().payerCalls).toBe(0)
    }
  )

  it.each([false, true])(
    "records exact credit instead of exposing an invoice (late: %s)",
    async (late) => {
      const test = fixture()
      if (late) {
        await test.run()
        test.setNow(test.plan.funding.expiresAt + 1)
      }
      test.setProofAvailable(true)
      const result = await test.run()
      expect(result.status).toBe("funded")
      expect(result).not.toHaveProperty("externalInvoice")
      expect(result.reconciliation.credit?.transferId).toBe(
        "offline-exact-credit"
      )
      expect(result.reconciliation.credit?.creditedSats).toBe(GROSS - 1)
      expect(test.counts().creditRecords).toBe(1)
      expect(test.counts().payerCalls).toBe(0)
      expect(test.metadata().fundingSubmissionState).toBe(
        late ? "provisional" : "not_started"
      )
    }
  )

  it("preserves unrelated preparation metadata during external reservation", async () => {
    const test = fixture()
    const unrelated: StoredCheckoutSparkSettledPreparation = {
      ...test.metadata(),
      checkoutId: "unrelated-checkout",
      planDigest: "9".repeat(64),
      recoveryHandoffId: "unrelated-handoff",
    }
    saveCheckoutSparkSettledPreparation(unrelated, test.storage)
    await test.run()
    expect(
      getCheckoutSparkSettledPreparation(unrelated.checkoutId, test.storage)
    ).toEqual(unrelated)
  })

  it("keeps reservation but discloses nothing if the recovery ACK disappears before final readback", async () => {
    const test = fixture()
    test.hook((stage) => {
      if (stage === "reauthorization") {
        test.setAuthorizationError("Exact recovery ACK no longer available")
      }
    })
    await expect(test.run()).rejects.toThrow(
      "Exact recovery ACK no longer available"
    )
    expect(test.metadata()).toMatchObject({
      fundingSubmissionState: "provisional",
      externalFundingExposedAt: NOW + 1_000,
    })
    expect(test.counts().payerCalls).toBe(0)
  })

  it("does not let metadata writers retroactively mark an automatic attempt as external", () => {
    const test = fixture()
    test.seed({ fundingSubmissionState: "provisional", savedAt: NOW + 1 })
    const before = test.metadata()
    expect(() => test.seed({ externalFundingExposedAt: NOW + 1 })).toThrow()
    expect(test.metadata()).toEqual(before)
  })

  it("keeps external provenance immutable and prevents stale writes from clearing its reservation", async () => {
    const test = fixture()
    const stale = test.metadata()
    await test.run()
    const reserved = test.metadata()
    const withoutMarker = { ...reserved }
    delete withoutMarker.externalFundingExposedAt
    for (const changed of [
      {
        ...reserved,
        externalFundingExposedAt: reserved.externalFundingExposedAt! + 1,
      },
      withoutMarker,
      { ...stale, savedAt: reserved.savedAt + 1 },
    ]) {
      expect(() =>
        saveCheckoutSparkSettledPreparation(changed, test.storage)
      ).toThrow()
    }
    expect(() =>
      saveCheckoutSparkSettledPreparation(
        {
          ...reserved,
          fundingSubmissionState: "not_started",
        },
        test.storage,
        { allowDefinitePreSendReset: true }
      )
    ).toThrow()
    expect(test.metadata()).toEqual(reserved)
  })
})

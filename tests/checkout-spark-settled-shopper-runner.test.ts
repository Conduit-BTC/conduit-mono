import { describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { generateMnemonic } from "../apps/market/node_modules/@scure/bip39/index.js"
import { wordlist } from "../apps/market/node_modules/@scure/bip39/wordlists/english.js"
import { ConduitDB } from "@conduit/core/db"
import {
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkSettledPlan,
  projectCheckoutSparkMerchantSettlement,
  type OrderLifecycle,
} from "@conduit/core"
import { FirstPartySparkSdkFactory } from "../apps/market/src/lib/spark-sdk"
import { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import { deriveMerchantCheckoutSparkRecoveryIdentity } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { createCheckoutSparkSettledFundingBridge } from "../apps/market/src/lib/checkout-spark-settled-funding"
import { prepareCheckoutSparkSettledOutgoingLeg } from "../apps/market/src/lib/checkout-spark-settled-leg-preparation"
import {
  getCheckoutSparkSettledPreparation,
  loadAuthorizedCheckoutSparkSettledFunding,
  saveCheckoutSparkSettledPreparation,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import {
  getCheckoutSparkRecoveryDelivery,
  publishCheckoutSparkSettledRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import {
  createCheckoutSparkSettledShopperRunner,
  type CheckoutSparkSettledShopperRunInput,
  type CheckoutSparkSettledShopperRunnerDependencies,
} from "../apps/market/src/lib/checkout-spark-settled-shopper-runner"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = Math.floor(Date.now() / 1_000) * 1_000 - 1_000
const MERCHANT = new NDKPrivateKeySigner(randomBytes(32).toString("hex")).pubkey
const SUPPLIER = new NDKPrivateKeySigner(randomBytes(32).toString("hex")).pubkey

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

function invoice(amountSats: number, preimage: Uint8Array) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(createHash("sha256").update(preimage).digest()),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField("Synthetic foreground routing"),
      { tag: "x", words: [28, 4] },
    ],
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

async function fixture() {
  const database = new ConduitDB(`shopper-runner-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const repository = new DexieCheckoutSparkSettledRepository(database)
  const storage = new MemoryStorage()
  const credentials = { mnemonic: generateMnemonic(wordlist), accountNumber: 0 }
  const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
    credentials.mnemonic,
    credentials.accountNumber
  )
  const native = createHermeticSparkNative({
    network: "mainnet",
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      invoice(amountSats, randomBytes(32)),
  })
  const authority = { active: true, now: NOW + 100 }
  const hooks: {
    completeFunding?: boolean
    failSendAfterAdmission?: boolean
    hidePayoutHistory?: boolean
    beforePayoutRead?: () => Promise<void>
    beforeNativeSend?: () => Promise<void>
    beforeWait?: () => Promise<void>
    beforeAck?: () => Promise<void>
    wrongOrigin?: boolean
    feeOverCap?: boolean
  } = {}
  const manager = new SparkWalletManager(
    new FirstPartySparkSdkFactory({
      network: "mainnet",
      now: () => authority.now,
      wait: async () => {},
      loadModule: async () => ({
        ...native.module,
        async initialize(input) {
          const opened = await native.module.initialize(input)
          return {
            wallet: {
              ...opened.wallet,
              async getTransferFromSsp(id) {
                await hooks.beforePayoutRead?.()
                if (hooks.hidePayoutHistory) return null
                return opened.wallet.getTransferFromSsp(id)
              },
              async payLightningInvoice(request) {
                await hooks.beforeNativeSend?.()
                const result = await opened.wallet.payLightningInvoice(request)
                if (hooks.failSendAfterAdmission)
                  throw new Error("Synthetic provider interruption")
                return result
              },
              async getLightningSendFeeEstimate(request) {
                return hooks.feeOverCap
                  ? 10_000
                  : opened.wallet.getLightningSendFeeEstimate(request)
              },
            },
          }
        },
      }),
    }),
    async () => ({ release: async () => {} }),
    undefined,
    () => authority.now
  )
  const walletId = `runner-wallet-${crypto.randomUUID()}`
  await manager.openWithMnemonic({ walletId, ...credentials })
  const receive = await manager.createCheckoutReceive(walletId, {
    description: "Synthetic router funding",
    requiredNetSats: 1_113,
    grossFundingSats: 1_113,
    expirySecs: 900,
    receiveMode: "ordinary_settled_v3",
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: `runner-checkout-${crypto.randomUUID()}`,
    orderId: "runner-order",
    merchantPubkey: MERCHANT,
    walletId,
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 2_700_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:fixture`,
          productEventId: "c".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: receive.id,
      paymentRequest: receive.paymentRequest,
      paymentHash: receive.paymentHash,
      receiverIdentityPublicKey: identity,
      grossFundingSats: receive.grossFundingSats,
      createdAt: receive.createdAt,
      expiresAt: receive.expiresAt,
    },
    recipients: [
      ...(
        [
          ["merchant", MERCHANT, 750],
          ["supplier", SUPPLIER, 250],
        ] as const
      ).map(([kind, recipientId, weightSats]) => ({
        kind,
        recipientId,
        weightSats,
        destination: {
          type: "lightning_address" as const,
          value: `${kind}@wallet.conduit.market`,
          source: {
            type: "signed_profile" as const,
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
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
  await repository.create(plan)
  const signer = plainTestSigner(
    new NDKPrivateKeySigner(randomBytes(32).toString("hex"))
  )
  const buyer = signer.pubkey
  const recovery = await publishCheckoutSparkSettledRecoveryHandoff({
    state: createCheckoutSparkSettledReconciliation(plan),
    recovery: { ...credentials, network: "mainnet" },
    identity: { kind: "signed_in", pubkey: buyer, signer },
    storage,
    now: () => authority.now,
    transport: {
      recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
      publishFn: async () => ({
        attemptedRelayUrls: ["wss://merchant.inbox.relay.dev"],
        successfulRelayUrls: ["wss://merchant.inbox.relay.dev"],
        failedRelayUrls: [],
        relayFailureMessages: {},
      }),
    },
  })
  saveCheckoutSparkSettledPreparation(
    {
      schemaVersion: 3,
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      recoveryHandoffId: recovery.handoffId,
      fundingInvoiceExposedAt: authority.now,
      fundingSubmissionState: "not_started",
      savedAt: authority.now,
    },
    storage
  )
  const lifecycle = {
    orderId: plan.orderId,
    merchantPubkey: MERCHANT,
    buyerPubkey: buyer,
    buyerIdentityKind: "signed_in",
    orderDeliveryStatus: "sent",
    phase: "placed",
    paymentStatus: "unpaid",
    currency: "SATS",
    totalSats: 1_000,
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId,
    },
  } as OrderLifecycle
  await database.orderLifecycles.put(lifecycle)
  const control = native.control.forIdentity(identity)
  const calls = { payer: 0, invoices: [] as string[], acknowledgments: 0 }
  const loadAuthorized: typeof loadAuthorizedCheckoutSparkSettledFunding = (
    id,
    options
  ) =>
    loadAuthorizedCheckoutSparkSettledFunding(id, {
      ...options,
      storage,
      recoveryStorage: storage,
      repository,
      now: () => authority.now,
    })
  const dependencies: CheckoutSparkSettledShopperRunnerDependencies = {
    repository,
    now: () => authority.now,
    readOrder: (id) => database.orderLifecycles.get(id),
    readPreparation: (id) => getCheckoutSparkSettledPreparation(id, storage),
    readInitialRecovery: (id) => getCheckoutSparkRecoveryDelivery(id, storage),
    loadAuthorized,
    sparkConfiguration: () => ({ status: "ready", network: "mainnet" }),
    sparkManager: () => manager,
    fundingBridge: (id) =>
      createCheckoutSparkSettledFundingBridge(id, {
        repository,
        storage,
        recoveryStorage: storage,
        loadAuthorized,
        now: () => authority.now,
        attestCredit: (id, request) =>
          manager.attestCheckoutReceiveCredit(id, request),
        payInvoice: async (request) => {
          await request.beforeSend?.()
          calls.payer += 1
          if (hooks.completeFunding !== false) control.completeFunding()
          return {
            status: "paid",
            rail: "webln",
            preimage: randomBytes(32).toString("hex"),
          }
        },
        requireCrossTabLock: false,
        withStoreWriteLock: async (operation) => operation(),
      }),
    prepareLeg: (input, options) =>
      prepareCheckoutSparkSettledOutgoingLeg(input, {
        ...options,
        resolveInvoice: async (request) => {
          const preimage = randomBytes(32)
          const paymentRequest = invoice(request.amountSats, preimage)
          calls.invoices.push(request.lud16)
          control.registerPayout({
            paymentRequest,
            preimage: preimage.toString("hex"),
            feeSats: 1,
          })
          return resolveCheckoutSparkFixtureInvoice(
            hooks.wrongOrigin
              ? { ...request, lud16: "other@wallet.conduit.market" }
              : request,
            paymentRequest
          )
        },
      }),
    wait: async () => {
      await hooks.beforeWait?.()
    },
  }
  const input: CheckoutSparkSettledShopperRunInput = {
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    orderId: plan.orderId,
    merchantPubkey: MERCHANT,
    network: "mainnet",
    buyerPubkey: buyer,
    currentBuyerPubkey: () => buyer,
    shouldContinue: () => authority.active,
    authorization: {
      planDigest: plan.planDigest,
      walletId,
      grossFundingSats: 1_113,
    },
    fundingMode: "pay_once",
    fundingPoll: { attempts: 1, intervalMs: 1 },
    fundingPayment: {
      buyerPubkey: buyer,
      shouldContinue: () => authority.active,
      paymentTarget: { type: "webln" },
      timeoutMs: 60_000,
      appId: "market",
    },
    acknowledgeRecoverySnapshot: async (state) => {
      await hooks.beforeAck?.()
      const saved = await repository.load(plan.checkoutId, plan.planDigest)
      expect(
        saved.status === "active" &&
          JSON.stringify(saved.state) === JSON.stringify(state)
      ).toBe(true)
      calls.acknowledgments += 1
    },
  }
  return {
    input,
    dependencies,
    repository,
    database,
    manager,
    control,
    calls,
    plan,
    authority,
    hooks,
    async cleanup() {
      await manager.close(walletId)
      database.close()
      await database.delete()
    },
  }
}

describe("foreground settled shopper routing", () => {
  it("routes every frozen commerce leg then Conduit after one approved funding payment", async () => {
    const f = await fixture()
    try {
      const runner = createCheckoutSparkSettledShopperRunner(f.dependencies)
      expect((await runner.run(f.input)).status).toBe("complete")
      expect(f.calls.payer).toBe(1)
      expect(f.calls.invoices).toEqual(
        f.plan.recipients.map((recipient) => recipient.destination.value)
      )
      expect(f.control.snapshot().sendInvocationCount).toBe(3)
      const saved = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(
        saved.status === "active" &&
          saved.state.legs.every((leg) => leg.status === "paid")
      ).toBe(true)
      const record = await f.repository.loadMerchantSettlement(
        MERCHANT,
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(
        projectCheckoutSparkMerchantSettlement(record!).commerceVerified
      ).toBe(true)
    } finally {
      await f.cleanup()
    }
  }, 20_000)

  it("observes delayed funding and resumes without re-entering the payer", async () => {
    const f = await fixture()
    try {
      f.hooks.completeFunding = false
      const runner = createCheckoutSparkSettledShopperRunner(f.dependencies)
      expect(await runner.run(f.input)).toEqual({ status: "funding_pending" })
      expect(f.calls.payer).toBe(1)
      expect(f.control.snapshot().sendInvocationCount).toBe(0)
      f.hooks.beforeWait = async () => {
        f.control.completeFunding()
      }
      expect(
        await runner.run({
          ...f.input,
          fundingMode: "inspect",
          fundingPoll: { attempts: 2, intervalMs: 1 },
        })
      ).toEqual({ status: "complete" })
      expect(f.calls.payer).toBe(1)
      expect(f.control.snapshot().sendInvocationCount).toBe(3)
    } finally {
      await f.cleanup()
    }
  }, 20_000)

  it("reopens only the same saved external invoice without entering a payer", async () => {
    const f = await fixture()
    try {
      const runner = createCheckoutSparkSettledShopperRunner(f.dependencies)
      const disclosures: string[] = []
      const external = {
        ...f.input,
        fundingPayment: {
          ...f.input.fundingPayment,
          paymentTarget: { type: "manual" as const },
          exposeExternalInvoice: true,
        },
        onExternalInvoice: (invoice: { invoice: string }) => {
          disclosures.push(invoice.invoice)
        },
      }
      const first = await runner.run(external)
      expect(first.status).toBe("funding_pending")
      const second = await runner.run({ ...external, fundingMode: "inspect" })
      expect(second.status).toBe("funding_pending")
      expect(disclosures.length).toBe(2)
      expect(disclosures[0] === disclosures[1]).toBe(true)
      expect(f.calls.payer).toBe(0)
      expect(f.control.snapshot().sendInvocationCount).toBe(0)
    } finally {
      await f.cleanup()
    }
  }, 20_000)

  it("does not present a completed plan under a changed authorized buyer", async () => {
    const f = await fixture()
    try {
      const runner = createCheckoutSparkSettledShopperRunner(f.dependencies)
      expect((await runner.run(f.input)).status).toBe("complete")
      expect(
        (
          await runner.run({
            ...f.input,
            buyerPubkey: SUPPLIER,
            fundingMode: "inspect",
          })
        ).status
      ).toBe("paused")
      expect(f.control.snapshot().sendInvocationCount).toBe(3)
    } finally {
      await f.cleanup()
    }
  }, 20_000)

  it("revokes immediately but drains an admitted send before permitting resume", async () => {
    const f = await fixture()
    const entered = deferred()
    const release = deferred()
    try {
      f.hooks.beforeNativeSend = async () => {
        entered.resolve()
        await release.promise
      }
      const runner = createCheckoutSparkSettledShopperRunner(f.dependencies)
      const running = runner.run(f.input)
      await entered.promise
      let drained = false
      const pausing = runner.pause().then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      expect(await runner.run({ ...f.input, fundingMode: "inspect" })).toEqual({
        status: "paused",
        reason: "busy",
      })
      release.resolve()
      expect((await running).status).toBe("paused")
      await pausing
      expect(f.control.snapshot().sendInvocationCount).toBe(1)
      const snapshot = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(
        snapshot.status === "active" &&
          snapshot.state.legs[0]?.status === "submitted"
      ).toBe(true)
      f.hooks.beforeNativeSend = undefined
      expect(
        (await runner.run({ ...f.input, fundingMode: "inspect" })).status
      ).toBe("complete")
      expect(f.control.snapshot().sendInvocationCount).toBe(3)
      expect(f.calls.payer).toBe(1)
    } finally {
      release.resolve()
      await f.cleanup()
    }
  }, 20_000)

  it("keeps an ambiguous intent unchanged when resumed exact history is empty", async () => {
    const f = await fixture()
    try {
      f.hooks.failSendAfterAdmission = true
      const runner = createCheckoutSparkSettledShopperRunner(f.dependencies)
      expect((await runner.run(f.input)).status).toBe("paused")
      const first = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(f.control.snapshot().sendInvocationCount).toBe(1)
      f.hooks.hidePayoutHistory = true
      expect(await runner.run({ ...f.input, fundingMode: "inspect" })).toEqual({
        status: "paused",
        reason: "prior_possible_send",
      })
      const second = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      expect(
        first.status === "active" &&
          second.status === "active" &&
          JSON.stringify(first.state.legs[0]?.intent) ===
            JSON.stringify(second.state.legs[0]?.intent)
      ).toBe(true)
      expect(f.calls.invoices.length).toBe(1)
      expect(f.control.snapshot().sendInvocationCount).toBe(1)
      f.hooks.hidePayoutHistory = false
      f.hooks.failSendAfterAdmission = false
      const reopened = createCheckoutSparkSettledShopperRunner(f.dependencies)
      expect(
        (await reopened.run({ ...f.input, fundingMode: "inspect" })).status
      ).toBe("complete")
      expect(f.control.snapshot().sendInvocationCount).toBe(3)
      expect(
        (await reopened.run({ ...f.input, fundingMode: "inspect" })).status
      ).toBe("complete")
      expect(f.control.snapshot().sendInvocationCount).toBe(3)
      expect(f.calls.payer).toBe(1)
    } finally {
      await f.cleanup()
    }
  }, 20_000)

  it.each(["pause", "hidden", "takeover", "cancelled", "account"] as const)(
    "stops before sending after %s revokes authority during recovery acknowledgment",
    async (change) => {
      const f = await fixture()
      const entered = deferred()
      const release = deferred()
      try {
        f.hooks.beforeAck = async () => {
          entered.resolve()
          await release.promise
        }
        let buyer: string | null = f.input.buyerPubkey
        const runner = createCheckoutSparkSettledShopperRunner(f.dependencies)
        const running = runner.run({
          ...f.input,
          currentBuyerPubkey: () => buyer,
        })
        await entered.promise
        let pausing: Promise<void> | undefined
        if (change === "pause") pausing = runner.pause()
        else if (change === "hidden") f.authority.active = false
        else if (change === "takeover") f.authority.now = f.plan.takeoverAt
        else if (change === "account") buyer = SUPPLIER
        else
          await f.database.orderLifecycles.update(f.plan.orderId, {
            phase: "cancelled",
          })
        release.resolve()
        expect((await running).status).toBe("paused")
        await pausing
        expect(f.control.snapshot().sendInvocationCount).toBe(0)
        const saved = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        expect(
          saved.status === "active" &&
            saved.state.legs[0]?.status === "prepared"
        ).toBe(true)
        expect(f.calls.payer).toBe(1)
      } finally {
        release.resolve()
        await f.cleanup()
      }
    },
    20_000
  )

  it.each(["origin", "fee"] as const)(
    "does not route through a failed %s gate after funding",
    async (failure) => {
      const f = await fixture()
      try {
        f.hooks.wrongOrigin = failure === "origin"
        if (failure === "fee")
          f.hooks.beforeAck = async () => {
            f.hooks.feeOverCap = true
          }
        const runner = createCheckoutSparkSettledShopperRunner(f.dependencies)
        const result = await runner.run(f.input)
        expect(result.status).toBe("paused")
        if (failure === "fee")
          expect(result).toEqual({ status: "paused", reason: "fee_over_cap" })
        expect(f.control.snapshot().sendInvocationCount).toBe(0)
        expect(f.calls.payer).toBe(1)
      } finally {
        await f.cleanup()
      }
    },
    20_000
  )
})

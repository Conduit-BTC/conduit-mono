import { describe, expect, it } from "bun:test"
import { NDKEvent, NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { finalizeEvent } from "nostr-tools/pure"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  CheckoutSparkSettledRepositoryConflictError,
  DexieMerchantCheckoutSparkProgressRepository,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkMerchantProgress,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  checkoutSparkConduitFeeRecipient,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  parseCheckoutSparkMerchantProgressRumor,
  readCheckoutSparkMerchantOrderEvidence,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  resolveCheckoutSparkLnurlInvoice,
  type MerchantCheckoutSparkRecoveryCandidate,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkMerchantProgressPayload,
  type SignedPublicNostrEvent,
  type CheckoutSparkConduitDestinationPolicy,
} from "@conduit/core"
import { getNdk } from "../packages/core/src/protocol/ndk"
import {
  prepareMerchantCheckoutSparkSettledPayout,
  prepareNextMerchantCheckoutSparkSettledPayout,
} from "../apps/merchant/src/lib/checkout-spark-settled-leg-preparation"
import {
  retireMerchantCheckoutSparkSettledRecovery,
  type MerchantSparkRecoveryWallet,
} from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import {
  continueMerchantCheckoutSparkSettledPayout,
  reviewMerchantCheckoutSparkSettledPayout,
} from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
import { assertMerchantCheckoutSparkDispatchPlan } from "../apps/merchant/src/lib/checkout-spark-recovery-policy"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const MNEMONIC = createRuntimeMnemonic()
const OTHER_MNEMONIC = createRuntimeMnemonic()

const CREATED_AT = 1_800_000_000_000
const TAKEOVER_AT = CREATED_AT + 120_000
const MERCHANT = "a".repeat(64)
const BUYER = "b".repeat(64)
const OTHER = "c".repeat(64)
const IDENTITY = `02${"d".repeat(64)}`
const FUNDING_TRANSFER = "merchant-preparation-credit"
const INBOX = "wss://merchant-preparation.inbox.relay.dev"
type Dependencies = NonNullable<
  Parameters<typeof prepareMerchantCheckoutSparkSettledPayout>[3]
>

function invoice(
  amountSats: number,
  hashByte: number,
  createdAt = CREATED_AT / 1_000,
  network: "mainnet" | "regtest" = "mainnet"
) {
  return makeSignedBolt11Fixture({
    hrp: `ln${network === "mainnet" ? "bc" : "bcrt"}${amountSats * 10}n`,
    createdAt,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function fixture(
  destinationPolicy: CheckoutSparkConduitDestinationPolicy = "production",
  network: "mainnet" | "regtest" = "mainnet"
) {
  const product = `30402:${MERCHANT}:preparation-fixture`
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "merchant-preparation-checkout",
    orderId: "merchant-preparation-order",
    merchantPubkey: MERCHANT,
    walletId: "merchant-preparation-wallet",
    network,
    createdAt: CREATED_AT,
    takeoverAt: TAKEOVER_AT,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: product,
          productEventId: "e".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "merchant-preparation-receive",
      paymentRequest: invoice(1_113, 3, CREATED_AT / 1_000, network),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: IDENTITY,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        weightSats: 1_000,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "f".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
          },
        },
      },
      {
        kind: "conduit",
        recipientId: checkoutSparkConduitFeeRecipient(destinationPolicy),
        weightSats: 111,
        destination: {
          type: "lightning_address",
          value: checkoutSparkConduitFeeRecipient(destinationPolicy),
          source: {
            type: "conduit_allowlist",
            policy: destinationPolicy,
          },
        },
      },
    ],
  })
  const state = createCheckoutSparkSettledReconciliation(plan)
  const payload = createCheckoutSparkSettledRecoveryPayload({
    state,
    senderPubkey: BUYER,
    mnemonic: MNEMONIC,
    accountNumber: 0,
    preparedAt: CREATED_AT + 1_000,
  })
  const rumor = new NDKEvent(undefined)
  rumor.kind = 16
  rumor.pubkey = BUYER
  rumor.created_at = CREATED_AT / 1_000 + 1
  rumor.tags = [
    ["p", MERCHANT],
    ["type", "order"],
    ["order", plan.orderId],
    ["amount", "1000"],
    ["currency", "SATS"],
    ["item", product, "1"],
    [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
  ]
  rumor.content = JSON.stringify({
    id: plan.orderId,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    merchantPubkey: MERCHANT,
    items: [
      {
        productId: product,
        format: "digital",
        fulfillment: { type: "digital" },
        quantity: 1,
        priceAtPurchase: 1_000,
        currency: "SATS",
        shippingCostSats: 0,
      },
    ],
    subtotal: 1_000,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt: CREATED_AT + 1_000,
  })
  rumor.id = rumor.getEventHash()
  const evidence = readCheckoutSparkMerchantOrderEvidence(rumor)
  if (!evidence) throw new Error("Synthetic order evidence is invalid")
  const witness = createCheckoutSparkMerchantOrderWitness(plan, evidence, BUYER)
  if (!witness) throw new Error("Synthetic order witness is invalid")
  const selected: MerchantCheckoutSparkRecoveryCandidate = {
    wrapId: "9".repeat(64),
    schemaVersion: 2,
    checkoutId: plan.checkoutId,
    orderId: plan.orderId,
    planDigest: plan.planDigest,
    takeoverAt: TAKEOVER_AT,
    preparedAt: payload.preparedAt,
  }
  return { plan, state, payload, witness, selected }
}

async function harness(
  destinationPolicy: CheckoutSparkConduitDestinationPolicy = "production"
) {
  const value = fixture(destinationPolicy)
  const database = new ConduitDB(
    `merchant-preparation-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  const stored = new DexieCheckoutSparkSettledRepository(database)
  const progressStore = new DexieMerchantCheckoutSparkProgressRepository(
    database
  )
  await stored.importMerchantOrderRecovery(value.state, value.witness, () => {})
  let current = true
  let clock = TAKEOVER_AT
  let payload = value.payload
  const calls = {
    recoveries: 0,
    opens: 0,
    cleanups: 0,
    derives: 0,
    invoices: [] as number[],
    fees: [] as string[],
    history: [] as string[],
    wraps: [] as CheckoutSparkMerchantProgressPayload[],
    publishes: [] as SignedPublicNostrEvent[],
  }
  const wallet: MerchantSparkRecoveryWallet = {
    ensurePrivateReady: async () => {},
    getIdentityPublicKey: async () => IDENTITY,
    getLightningReceiveRequest: async () => ({
      id: value.plan.funding.requestId,
      status: "TRANSFER_COMPLETED",
      network: "MAINNET",
      invoice: {
        encodedInvoice: value.plan.funding.paymentRequest,
        bitcoinNetwork: "MAINNET",
        paymentHash: value.plan.funding.paymentHash,
        amount: { originalValue: 1_113, originalUnit: "SATOSHI" },
      },
      transfer: {
        sparkId: FUNDING_TRANSFER,
        userRequestId: value.plan.funding.requestId,
        totalAmount: { originalValue: 1_111, originalUnit: "SATOSHI" },
      },
    }),
    getTransfer: async (id) => ({
      id,
      status: "TRANSFER_STATUS_COMPLETED",
      totalValue: 1_111,
      transferDirection: "INCOMING",
      receiverIdentityPublicKey: IDENTITY,
      userRequest: { id: value.plan.funding.requestId },
    }),
    getTransferFromSsp: async (id) => {
      calls.history.push(id)
      return undefined
    },
    getLightningSendRequest: async () => null,
    estimateLightningFee: async ({ paymentRequest }) => {
      calls.fees.push(paymentRequest)
      return 5
    },
    cleanup: async () => {
      calls.cleanups += 1
    },
  }
  const repository: NonNullable<Dependencies["repository"]> = {
    load: stored.load.bind(stored),
    save: stored.save.bind(stored),
    savePreparedWithInvoiceOrigin:
      stored.savePreparedWithInvoiceOrigin.bind(stored),
    saveRenewedWithInvoiceOrigin:
      stored.saveRenewedWithInvoiceOrigin.bind(stored),
    loadMerchantOrderWitness: stored.loadMerchantOrderWitness.bind(stored),
    recordMerchantCredit: stored.recordMerchantCredit.bind(stored),
    recordMerchantPayout: stored.recordMerchantPayout.bind(stored),
  }
  const dependencies: Dependencies = {
    repository,
    signer: plainTestSigner({
      user: async () => new NDKUser({ pubkey: MERCHANT }),
    } as NDKSigner as never),
    progressStore,
    progressTransport: {
      recipientInboxRelays: [INBOX],
      accountNetworkLocalStateRepository: { get: async () => undefined },
      giftWrapFn: (async (rumor, recipient) => {
        expect(recipient.pubkey).toBe(MERCHANT)
        const progress = parseCheckoutSparkMerchantProgressRumor(rumor)
        const saved = await stored.load(
          value.plan.checkoutId,
          value.plan.planDigest
        )
        expect(saved.status).toBe("active")
        if (saved.status !== "active") throw new Error("Fixture missing")
        expect(progress.state).toEqual(saved.state)
        expect(progress.initialHandoffId).toBe(value.payload.handoffId)
        expect(rumor.content).not.toContain(value.payload.wallet.mnemonic)
        calls.wraps.push(progress)
        return new NDKEvent(
          getNdk(),
          finalizeEvent(
            {
              kind: 1_059,
              created_at: CREATED_AT / 1_000,
              tags: [["p", recipient.pubkey]],
              content: `synthetic-opaque-preparation-wrap-${calls.wraps.length}`,
            },
            new Uint8Array(32).fill(12)
          )
        )
      }) as NonNullable<Dependencies["progressTransport"]>["giftWrapFn"],
      publishFn: (async (event, options) => {
        const staged = await progressStore.list(
          MERCHANT,
          value.plan.checkoutId,
          value.plan.planDigest
        )
        expect(
          staged.some(
            (entry) => entry.record.signedRecipientWrap.id === event.id
          )
        ).toBe(true)
        expect(options.exclusiveRelayUrls).toEqual([INBOX])
        expect(options.appRelayUrls).toEqual([])
        expect(options.personalRelayUrls).toEqual([])
        calls.publishes.push(event.rawEvent() as SignedPublicNostrEvent)
        return {
          attemptedRelayUrls: [INBOX],
          successfulRelayUrls: [INBOX],
          failedRelayUrls: [],
          relayFailureMessages: {},
        }
      }) as NonNullable<Dependencies["progressTransport"]>["publishFn"],
    },
    now: () => clock,
    lockManager: null,
    requireCrossTabLock: false,
    deriveIdentity: async () => {
      calls.derives += 1
      return IDENTITY
    },
    openWallet: async (request) => {
      expect("outgoing" in request).toBe(false)
      calls.opens += 1
      return wallet
    },
    consumeRecovery: async (principal, selected, adapter) => {
      calls.recoveries += 1
      expect(principal).toBe(MERCHANT)
      expect(selected).toEqual(value.selected)
      const assertCurrent = () => {
        if (!current) throw new Error("Synthetic recovery session ended")
      }
      await adapter.consume(payload, assertCurrent)
      return {
        status: "consumed",
        coverage: "complete",
        discoveryCoverage: "complete",
        declarationState: "declared",
        candidate: selected,
      }
    },
    resolveInvoice: async (request) => {
      expect(request.lud16).toBe(value.plan.recipients[0]!.destination.value)
      calls.invoices.push(request.amountSats)
      const hashByte = calls.invoices.length + 3
      return resolveCheckoutSparkLnurlInvoice(request, {
        fetchMetadata: async () => ({
          payRequestUrl:
            "https://wallet.conduit.market/.well-known/lnurlp/recipient",
          lnurl: "lnurl1test",
          callback: "https://wallet.conduit.market/pay",
          minSendable: 1_000,
          maxSendable: 100_000_000,
          tag: "payRequest",
          allowsNostr: false,
          metadata: "[]",
        }),
        fetchInvoice: async () => ({
          invoice: invoice(request.amountSats, hashByte),
        }),
      })
    },
  }
  const input = {
    legId: value.plan.recipients[0]!.legId,
    shouldContinue: () => current,
  }
  const nextInput: Parameters<
    typeof prepareNextMerchantCheckoutSparkSettledPayout
  >[2] = { shouldContinue: () => current }
  return {
    ...value,
    input,
    nextInput,
    dependencies,
    repository,
    stored,
    progressStore,
    wallet,
    calls,
    run: () =>
      prepareMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        value.selected,
        input,
        dependencies
      ),
    runNext: (principal = MERCHANT, selected = value.selected) =>
      prepareNextMerchantCheckoutSparkSettledPayout(
        principal,
        selected,
        nextInput,
        dependencies
      ),
    setClock: (next: number) => {
      clock = next
    },
    revoke: () => {
      current = false
    },
    setPayload: (next: typeof payload) => {
      payload = next
    },
    close: async () => {
      database.close()
      await database.delete()
    },
  }
}

async function withHarness(
  run: (test: Awaited<ReturnType<typeof harness>>) => Promise<void>
) {
  const test = await harness()
  try {
    await run(test)
  } finally {
    await test.close()
  }
}

function credited(state: CheckoutSparkSettledReconciliation) {
  const { plan } = state
  return recordCheckoutSparkSettledCredit(state, {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    transferId: FUNDING_TRANSFER,
    receiverIdentityPublicKey: IDENTITY,
    grossSats: 1_113,
    creditedSats: 1_111,
    observedAt: CREATED_AT + 2_000,
  })
}

function prepared(state: CheckoutSparkSettledReconciliation, hashByte = 8) {
  const legId = state.legs[0]!.legId
  return prepareCheckoutSparkSettledLeg(state, {
    legId,
    transferId: deriveCheckoutSparkSettledTransferId(state.plan, legId),
    paymentRequest: invoice(995, hashByte),
    paymentHash: hashByte.toString(16).padStart(2, "0").repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: Math.max(CREATED_AT + 3_000, state.updatedAt),
  })
}

function heldBoundary() {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    started,
    release,
    wait: async () => {
      entered()
      await held
    },
  }
}

function expectNoPreparationActivity(
  test: Awaited<ReturnType<typeof harness>>
) {
  expect(test.calls).toEqual({
    recoveries: 0,
    opens: 0,
    cleanups: 0,
    derives: 0,
    invoices: [],
    fees: [],
    history: [],
    wraps: [],
    publishes: [],
  })
}

async function seedMerchantPayout(
  test: Awaited<ReturnType<typeof harness>>,
  importedPaid: boolean
) {
  const current = await test.stored.load(
    test.plan.checkoutId,
    test.plan.planDigest
  )
  if (current.status !== "active") throw new Error("Fixture missing")
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(32).fill(7))
  )
  const paymentHash = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: "lnbc9950n",
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(hash),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const legId = test.plan.recipients[0]!.legId
  const transferId = deriveCheckoutSparkSettledTransferId(test.plan, legId)
  let state = prepareCheckoutSparkSettledLeg(credited(current.state), {
    legId,
    transferId,
    paymentRequest,
    paymentHash,
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: CREATED_AT + 3_000,
  })
  if (importedPaid)
    state = recordCheckoutSparkSettledLegStatus(state, {
      legId,
      transferId,
      paymentHash,
      status: "paid",
      finalFeeSats: 1,
      finalDebitSats: 996,
      observedAt: CREATED_AT + 4_000,
    })
  await test.stored.save(state, current.revision)
  test.input.legId = test.plan.recipients[1]!.legId
  const nativeRequest = {
    typename: "LightningSendRequest",
    id: "merchant-preparation-send",
    status: "LIGHTNING_PAYMENT_SUCCEEDED",
    fee: { originalValue: 1, originalUnit: "SATOSHI" },
    encodedInvoice: paymentRequest,
    idempotencyKey: transferId,
    paymentPreimage: "07".repeat(32),
  }
  return { transferId, nativeRequest }
}

async function seedReturnedRenewal(test: Awaited<ReturnType<typeof harness>>) {
  const initial = await test.stored.load(
    test.plan.checkoutId,
    test.plan.planDigest
  )
  if (initial.status !== "active") throw new Error("Fixture missing")
  let state = prepared(credited(initial.state))
  const original = state.legs[0]!.intent!
  state = recordCheckoutSparkSettledLegStatus(state, {
    legId: original.legId,
    transferId: original.transferId,
    paymentHash: original.paymentHash,
    status: "submitted",
    observedAt: CREATED_AT + 4_000,
  })
  await test.stored.save(state, initial.revision)
  const clock = CREATED_AT + 7_200_000
  test.setClock(clock)
  const inspections: number[] = []
  test.wallet.inspectReturnedInvoiceAttempt = async (request, options) => {
    options.assertCurrent()
    inspections.push(options.now())
    return {
      status: "returned",
      evidence: {
        network: request.network,
        walletIdentityPublicKey: IDENTITY,
        transferId: request.transferId,
        requestId: "synthetic-returned-send-request",
        paymentRequest: request.paymentRequest,
        paymentHash: request.paymentHash,
        invoiceAmountSats: request.amountSats,
        maxFeeSats: request.maxFeeSats,
        debitedSats: 996,
        returnedSats: 996,
        availableSats: 1_111,
        sspStatus: "LIGHTNING_PAYMENT_FAILED",
        operatorStatus: "EXPIRED",
        htlcStatus: "RETURNED",
        preimage: null,
        returnedLeaves: [{ id: "synthetic-returned-leaf", valueSats: 996 }],
        availableLeaves: [
          { id: "synthetic-returned-leaf", valueSats: 996 },
          { id: "synthetic-unspent-leaf", valueSats: 115 },
        ],
        observedAt: options.now(),
      },
    }
  }
  const preimageBytes = new Uint8Array(32).fill(21)
  const paymentHashBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", preimageBytes)
  )
  const paymentHash = Array.from(paymentHashBytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  test.dependencies.resolveInvoice = async (request) => {
    test.calls.invoices.push(request.amountSats)
    return resolveCheckoutSparkLnurlInvoice(request, {
      fetchMetadata: async () => ({
        payRequestUrl:
          "https://wallet.conduit.market/.well-known/lnurlp/merchant",
        lnurl: "lnurl1synthetic",
        callback: "https://wallet.conduit.market/pay",
        minSendable: 1_000,
        maxSendable: 100_000_000,
        tag: "payRequest",
        allowsNostr: false,
        metadata: "[]",
      }),
      fetchInvoice: async () => ({
        invoice: makeSignedBolt11Fixture({
          hrp: `lnbc${request.amountSats * 10}n`,
          createdAt: request.nowSeconds,
          fields: [
            bolt11PaymentHashField(paymentHashBytes),
            bolt11PaymentSecretField(),
            bolt11PlainDescriptionField(),
          ],
        }),
      }),
    })
  }
  return {
    original,
    clock,
    inspections,
    paymentHash,
    preimage: "15".repeat(32),
    run: () =>
      prepareMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        test.selected,
        { ...test.input, allowRenewal: true },
        test.dependencies
      ),
  }
}

async function renewedContinuation(test: Awaited<ReturnType<typeof harness>>) {
  const returned = await seedReturnedRenewal(test)
  expect((await returned.run()).preparation?.status).toBe("prepared")
  const progress = test.calls.wraps[0]!
  const selected = {
    ...test.selected,
    merchantProgress: {
      wrapId: test.calls.publishes[0]!.id,
      snapshotId: progress.snapshotId,
      recordedAt: progress.recordedAt,
    },
  }
  const beforePreview = returned.inspections.length
  const review = await reviewMerchantCheckoutSparkSettledPayout(
    MERCHANT,
    selected,
    test.stored
  )
  expect(review !== null).toBe(true)
  expect(returned.inspections.length).toBe(beforePreview)
  if (!review) throw new Error("Fixture review missing")
  let sends = 0
  test.wallet.outgoing = {
    getAvailableSats: async () => 1_111n,
    estimateFee: async () => 5,
    sendFrozen: async () => {
      sends += 1
    },
  }
  const dependencies: NonNullable<
    Parameters<typeof continueMerchantCheckoutSparkSettledPayout>[3]
  > = {
    ...test.dependencies,
    repository: test.stored,
    shouldContinue: test.input.shouldContinue,
    openWallet: async () => test.wallet,
    consumeRecovery: async (_principal, candidate, adapter) => {
      await adapter.consumeMerchantProgress!(
        test.payload,
        test.payload,
        progress,
        () => {
          if (!test.input.shouldContinue())
            throw new Error("Synthetic current session ended")
        }
      )
      return {
        status: "consumed",
        coverage: "complete",
        discoveryCoverage: "complete",
        declarationState: "declared",
        candidate,
      }
    },
  }
  return {
    ...returned,
    selected,
    review,
    dependencies,
    sends: () => sends,
    continue: () =>
      continueMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        selected,
        review,
        dependencies
      ),
  }
}

describe("Merchant hosted recovery destination policy", () => {
  it("accepts only the canonical production destination outside a local rehearsal", () => {
    const production = fixture("production")
    expect(() =>
      assertMerchantCheckoutSparkDispatchPlan(production.plan, false)
    ).not.toThrow()
    const canary = fixture("local_router_canary")
    expect(() =>
      assertMerchantCheckoutSparkDispatchPlan(canary.plan, false)
    ).toThrow("recovery destination is unavailable")
    expect(() =>
      assertMerchantCheckoutSparkDispatchPlan(canary.plan, true)
    ).not.toThrow()
    // The rejected historical record is neither mutated nor rebound to production.
    expect(canary.plan.recipients.at(-1)?.destination.source).toEqual({
      type: "conduit_allowlist",
      policy: "local_router_canary",
    })
  })

  it("does not accept an imported canary relabeled as production", () => {
    const canary = fixture("local_router_canary")
    const changed = structuredClone(canary.plan)
    const source = changed.recipients.at(-1)!.destination.source
    if (source.type !== "conduit_allowlist") throw new Error("Fixture invalid")
    Object.assign(source, { policy: "production" })
    expect(() =>
      assertMerchantCheckoutSparkDispatchPlan(changed, false)
    ).toThrow()
  })

  it("keeps imported regtest plans read-only in hosted mainnet recovery", () => {
    const regtest = fixture("production", "regtest")
    expect(regtest.plan.network).toBe("regtest")
    expect(() =>
      assertMerchantCheckoutSparkDispatchPlan(regtest.plan, false)
    ).toThrow("recovery destination is unavailable")
    expect(() =>
      assertMerchantCheckoutSparkDispatchPlan(regtest.plan, true)
    ).not.toThrow()
    expect(regtest.plan.network).toBe("regtest")
  })

  it("rejects a hosted canary before opening a wallet, quoting fees or creating an invoice", async () => {
    const test = await harness("local_router_canary")
    try {
      await expect(test.run()).rejects.toThrow(
        "recovery destination is unavailable"
      )
      expect(test.calls.opens).toBe(0)
      expect(test.calls.derives).toBe(0)
      expect(test.calls.invoices).toHaveLength(0)
      expect(test.calls.fees).toHaveLength(0)
      expect(test.calls.publishes).toHaveLength(0)
      const retained = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(retained.status).toBe("active")
    } finally {
      await test.close()
    }
  })

  it("rejects direct saved-payout continuation of an imported canary before wallet access", async () => {
    const test = await harness("local_router_canary")
    try {
      const state = prepared(credited(test.state))
      test.setPayload(
        createCheckoutSparkSettledRecoveryPayload({
          state,
          senderPubkey: BUYER,
          mnemonic: MNEMONIC,
          accountNumber: 0,
          preparedAt: CREATED_AT + 4_000,
        })
      )
      const leg = state.legs[0]!
      const review = {
        checkoutId: test.plan.checkoutId,
        planDigest: test.plan.planDigest,
        legId: leg.legId,
        recipientId: test.plan.recipients[0]!.recipientId,
        destination: test.plan.recipients[0]!.destination.value,
        allocationSats: leg.allocationSats!,
        intent: leg.intent!,
      }
      await expect(
        continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          test.selected,
          review,
          {
            repository: test.stored,
            consumeRecovery: test.dependencies.consumeRecovery,
            openWallet: test.dependencies.openWallet,
            deriveIdentity: test.dependencies.deriveIdentity,
            now: test.dependencies.now,
            shouldContinue: () => true,
            lockManager: null,
            requireCrossTabLock: false,
          }
        )
      ).rejects.toThrow("recovery destination is unavailable")
      expect(test.calls.opens).toBe(0)
      expect(test.calls.derives).toBe(0)
      expect(test.calls.publishes).toHaveLength(0)
    } finally {
      await test.close()
    }
  })
})

describe("Merchant renewed signed-progress continuation", () => {
  it.each(["closed_returned", "unavailable", "refund_mismatch"] as const)(
    "requires exact terminal archived-return proof for Merchant retirement: %s",
    async (status) => {
      await withHarness(async (test) => {
        const context = await renewedContinuation(test)
        let saved = await test.stored.load(
          test.plan.checkoutId,
          test.plan.planDigest
        )
        if (saved.status !== "active") throw new Error("Fixture missing")
        const merchantPaid = recordCheckoutSparkSettledLegStatus(saved.state, {
          legId: context.review.legId,
          transferId: context.review.intent.transferId,
          paymentHash: context.review.intent.paymentHash,
          status: "paid",
          finalFeeSats: 5,
          finalDebitSats: 1_000,
          observedAt: context.clock + 1,
        })
        await test.stored.save(merchantPaid, saved.revision)
        saved = await test.stored.load(
          test.plan.checkoutId,
          test.plan.planDigest
        )
        if (saved.status !== "active") throw new Error("Fixture missing")
        const recipient = test.plan.recipients[1]!
        const feePreimage = new Uint8Array(32).fill(31)
        const feeHash = new Uint8Array(
          await crypto.subtle.digest("SHA-256", feePreimage)
        )
        const resolved = await resolveCheckoutSparkLnurlInvoice(
          {
            lud16: recipient.destination.value,
            amountSats: 109,
            network: test.plan.network,
            nowSeconds: Math.floor((context.clock + 2) / 1_000),
            shouldContinue: test.input.shouldContinue,
          },
          {
            fetchMetadata: async () => ({
              payRequestUrl:
                "https://wallet.conduit.market/.well-known/lnurlp/fee",
              lnurl: "lnurl1synthetic",
              callback: "https://wallet.conduit.market/pay",
              minSendable: 1_000,
              maxSendable: 100_000_000,
              tag: "payRequest",
              allowsNostr: false,
              metadata: "[]",
            }),
            fetchInvoice: async () => ({
              invoice: makeSignedBolt11Fixture({
                hrp: "lnbc1090n",
                createdAt: Math.floor((context.clock + 2) / 1_000),
                fields: [
                  bolt11PaymentHashField(feeHash),
                  bolt11PlainDescriptionField(),
                  bolt11PaymentSecretField(),
                ],
              }),
            }),
          }
        )
        const preparedFee = prepareCheckoutSparkSettledLeg(saved.state, {
          legId: recipient.legId,
          transferId: deriveCheckoutSparkSettledTransferId(
            test.plan,
            recipient.legId
          ),
          paymentRequest: resolved.paymentRequest,
          paymentHash: resolved.paymentHash,
          invoiceAmountSats: 109,
          maxFeeSats: 2,
          preparedAt: context.clock + 2,
        })
        if (!resolved.origin) throw new Error("Fixture missing invoice origin")
        await test.stored.savePreparedWithInvoiceOrigin(
          preparedFee,
          saved.revision,
          { legId: recipient.legId, origin: resolved.origin }
        )
        saved = await test.stored.load(
          test.plan.checkoutId,
          test.plan.planDigest
        )
        if (saved.status !== "active") throw new Error("Fixture missing")
        const feeIntent = saved.state.legs[1]!.intent!
        const completed = recordCheckoutSparkSettledLegStatus(saved.state, {
          legId: recipient.legId,
          transferId: feeIntent.transferId,
          paymentHash: feeIntent.paymentHash,
          status: "paid",
          finalFeeSats: 2,
          finalDebitSats: 111,
          observedAt: context.clock + 3,
        })
        await test.stored.save(completed, saved.revision)
        test.setClock(context.clock + 3)
        const returned = await test.wallet.inspectReturnedInvoiceAttempt!(
          {
            network: test.plan.network,
            transferId: context.original.transferId,
            paymentRequest: context.original.paymentRequest,
            paymentHash: context.original.paymentHash,
            amountSats: context.original.invoiceAmountSats,
            maxFeeSats: context.original.maxFeeSats,
            receiverIdentityPublicKey: IDENTITY,
            minimumAvailableSats: 1_111,
          },
          { now: test.dependencies.now!, assertCurrent() {} }
        )
        if (returned.status !== "returned")
          throw new Error("Fixture missing return")
        const { availableSats, availableLeaves, ...closedEvidence } =
          returned.evidence
        expect(availableSats > 0 && availableLeaves.length > 0).toBe(true)
        let spendableReads = 0
        let closureReads = 0
        test.wallet.inspectReturnedInvoiceAttempt = async () => {
          spendableReads += 1
          return { status: "not_closed" }
        }
        test.wallet.inspectReturnedInvoiceClosure = async (
          request,
          options
        ) => {
          closureReads += 1
          expect(request.transferId === context.original.transferId).toBe(true)
          expect("minimumAvailableSats" in request).toBe(false)
          if (status === "unavailable") return { status }
          return {
            status: "closed_returned",
            evidence: {
              ...closedEvidence,
              returnedSats: status === "refund_mismatch" ? 995 : 996,
              observedAt: options.now(),
            },
          }
        }
        const requests = [
          {
            intent: context.review.intent,
            preimage: context.preimage,
            fee: 5,
            debit: 1_000,
          },
          { intent: feeIntent, preimage: "1f".repeat(32), fee: 2, debit: 111 },
        ].map((item, index) => ({
          ...item,
          request: {
            typename: "LightningSendRequest",
            id: `synthetic-terminal-request-${index}`,
            status: "LIGHTNING_PAYMENT_SUCCEEDED",
            fee: { originalValue: item.fee, originalUnit: "SATOSHI" },
            encodedInvoice: item.intent.paymentRequest,
            idempotencyKey: item.intent.transferId,
            paymentPreimage: item.preimage,
          },
        }))
        test.wallet.getTransferFromSsp = async (id) => {
          const paid = requests.find((item) => item.intent.transferId === id)
          return paid
            ? {
                sparkId: id,
                totalAmount: {
                  originalValue: paid.debit,
                  originalUnit: "SATOSHI",
                },
                userRequest: paid.request,
              }
            : undefined
        }
        test.wallet.getLightningSendRequest = async (id) =>
          requests.find((item) => item.request.id === id)?.request ?? null
        let balanceReads = 0
        test.wallet.openRetirementReader = async () => ({
          sparkAddress: "synthetic-private-checkout-address",
          reader: {
            getTransfers: async () => ({
              transfers: [
                {
                  id: FUNDING_TRANSFER,
                  type: 1,
                  status: 5,
                  network: 1,
                  totalValue: 1_111,
                },
                {
                  id: context.original.transferId,
                  type: 0,
                  status: 7,
                  network: 1,
                  totalValue: 996,
                },
                ...requests.map((item) => ({
                  id: item.intent.transferId,
                  type: 0,
                  status: 5,
                  network: 1,
                  totalValue: item.debit,
                })),
              ],
              offset: -1,
            }),
            getPendingTransfers: async () => {
              test.setClock(context.clock + 4)
              return []
            },
            getAvailableBalance: async () => {
              balanceReads += 1
              return 0n
            },
            getOwnedBalance: async () => {
              balanceReads += 1
              return 0n
            },
          },
        })
        const result = await retireMerchantCheckoutSparkSettledRecovery(
          MERCHANT,
          context.selected,
          {
            repository: {
              ...test.repository,
              retire: test.stored.retire.bind(test.stored),
              assertLocalInvoiceOrigin:
                test.stored.assertLocalInvoiceOrigin.bind(test.stored),
            },
            deriveIdentity: test.dependencies.deriveIdentity,
            now: test.dependencies.now,
            lockManager: null,
            requireCrossTabLock: false,
            openWallet: async (input) => {
              expect(input.retirement).toBe(true)
              return test.wallet
            },
            consumeRecovery: context.dependencies.consumeRecovery,
          }
        )
        expect(closureReads).toBe(1)
        expect(spendableReads).toBe(0)
        expect(balanceReads > 0).toBe(status === "closed_returned")
        expect(result.retirementStatus).toBe(
          status === "closed_returned" ? "retired" : "pending"
        )
        expect(
          (await test.stored.load(test.plan.checkoutId, test.plan.planDigest))
            .status
        ).toBe(status === "closed_returned" ? "retired" : "active")
        expect(context.sends()).toBe(0)
      })
    },
    30_000
  )

  it("re-proves returned funds after delayed preparation work before the renewal CAS", async () => {
    await withHarness(async (test) => {
      const context = await seedReturnedRenewal(test)
      test.wallet.estimateLightningFee = async () => {
        test.setClock(context.clock + 6_000)
        return 5
      }
      expect((await context.run()).preparation?.status).toBe("prepared")
      expect(context.inspections[0]).toBe(context.clock)
      expect(context.inspections.at(-1)).toBe(context.clock + 6_000)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(
        saved.status === "active" &&
          saved.state.legs[0]!.closedGenerations?.[0]?.closure.observedAt
      ).toBe(context.clock + 6_000)
    })
  }, 15_000)

  it("cannot commit a successor after the current session ends during return inspection", async () => {
    await withHarness(async (test) => {
      const context = await seedReturnedRenewal(test)
      const inspect = test.wallet.inspectReturnedInvoiceAttempt!
      const held = heldBoundary()
      test.wallet.inspectReturnedInvoiceAttempt = async (request, options) => {
        const result = await inspect(request, options)
        await held.wait()
        return result
      }
      const pending = context.run()
      await held.started
      test.revoke()
      held.release()
      await expect(pending).rejects.toThrow()
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status === "active" && saved.state.schemaVersion).toBe(3)
      expect(test.calls.invoices.length).toBe(0)
      expect(test.calls.cleanups).toBe(1)
    })
  }, 15_000)

  it.each([
    "unavailable",
    "conflicting",
    "not_closed",
    "missing_capability",
    "refund_mismatch",
  ] as const)(
    "holds the acknowledged successor without dispatch when fresh return proof is %s",
    async (status) => {
      await withHarness(async (test) => {
        const context = await renewedContinuation(test)
        const inspect = test.wallet.inspectReturnedInvoiceAttempt!
        if (status === "missing_capability") {
          test.wallet.inspectReturnedInvoiceAttempt = undefined
        } else {
          test.wallet.inspectReturnedInvoiceAttempt = async (
            request,
            options
          ) => {
            if (status !== "refund_mismatch") return { status }
            const result = await inspect(request, options)
            if (result.status !== "returned")
              throw new Error("Fixture missing return")
            return {
              status: "returned",
              evidence: { ...result.evidence, returnedSats: 995 },
            }
          }
        }
        const result = await context.continue()
        expect(result.payout?.sendAttempted).toBe(false)
        expect(result.payout?.outcome).toBe("wait")
        expect(context.sends()).toBe(0)
      })
    },
    15_000
  )

  it("does not dispatch a successor whose submitted private progress has no relay acknowledgement", async () => {
    await withHarness(async (test) => {
      const context = await renewedContinuation(test)
      context.dependencies.progressTransport = {
        ...test.dependencies.progressTransport!,
        publishFn: async () => ({
          attemptedRelayUrls: [INBOX],
          successfulRelayUrls: [],
          failedRelayUrls: [INBOX],
          relayFailureMessages: {},
        }),
      }
      const result = await context.continue()
      expect(result.payout?.sendAttempted).toBe(false)
      expect(context.sends()).toBe(0)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status === "active" && saved.state.legs[0]!.status).toBe(
        "submitted"
      )
    })
  }, 15_000)

  it("refreshes return proof after delayed fee work before admitting the exact successor", async () => {
    await withHarness(async (test) => {
      const context = await renewedContinuation(test)
      const before = context.inspections.length
      test.wallet.outgoing!.estimateFee = async () => {
        test.setClock(context.clock + 6_000)
        return 5
      }
      const result = await context.continue()
      expect(result.payout?.sendAttempted).toBe(true)
      expect(context.sends()).toBe(1)
      expect(context.inspections.length).toBeGreaterThan(before)
      expect(context.inspections.at(-1)).toBe(context.clock + 6_000)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(
        saved.status === "active" && saved.state.legs[0]!.intent?.transferId
      ).toBe(context.review.intent.transferId)
    })
  }, 15_000)

  it.each(["returned", "unavailable"] as const)(
    "re-inspects returned funds after delayed private acknowledgement reports %s",
    async (status) => {
      await withHarness(async (test) => {
        const context = await renewedContinuation(test)
        const publish = test.dependencies.progressTransport!.publishFn!
        const inspect = test.wallet.inspectReturnedInvoiceAttempt!
        let acknowledged = false
        const freshInspections: number[] = []
        context.dependencies.progressTransport = {
          ...test.dependencies.progressTransport!,
          publishFn: async (...args) => {
            const result = await publish(...args)
            test.setClock(context.clock + 6_000)
            acknowledged = true
            return result
          },
        }
        test.wallet.inspectReturnedInvoiceAttempt = async (
          request,
          options
        ) => {
          if (acknowledged) {
            freshInspections.push(options.now())
            if (status === "unavailable") return { status }
          }
          return inspect(request, options)
        }
        const result = await context.continue()
        expect(freshInspections.length).toBeGreaterThan(0)
        expect(
          freshInspections.every(
            (observedAt) => observedAt === context.clock + 6_000
          )
        ).toBe(true)
        expect(result.payout?.sendAttempted).toBe(status === "returned")
        expect(context.sends()).toBe(status === "returned" ? 1 : 0)
      })
    },
    30_000
  )

  it("reconciles the exact paid successor without requiring returned parent leaves to remain available", async () => {
    await withHarness(async (test) => {
      const context = await renewedContinuation(test)
      let deniedInspections = 0
      test.wallet.inspectReturnedInvoiceAttempt = async () => {
        deniedInspections += 1
        return { status: "not_closed" }
      }
      const request = {
        typename: "LightningSendRequest",
        id: "synthetic-successor-send-request",
        status: "LIGHTNING_PAYMENT_SUCCEEDED",
        fee: { originalValue: 1, originalUnit: "SATOSHI" },
        encodedInvoice: context.review.intent.paymentRequest,
        idempotencyKey: context.review.intent.transferId,
        paymentPreimage: context.preimage,
      }
      test.wallet.getTransferFromSsp = async (id) => ({
        sparkId: id,
        totalAmount: {
          originalValue: context.review.intent.invoiceAmountSats + 1,
          originalUnit: "SATOSHI",
        },
        userRequest: request,
      })
      test.wallet.getLightningSendRequest = async () => request

      const result = await context.continue()
      expect(
        ["paid", "already_paid"].includes(result.payout?.outcome ?? "")
      ).toBe(true)
      expect(context.sends()).toBe(0)
      expect(deniedInspections).toBe(0)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status === "active" && saved.state.legs[0]!.status).toBe(
        "paid"
      )
    })
  }, 15_000)
})

describe("Merchant next unpaid payout preparation entry", () => {
  it("requires saved active recovery before any private or provider activity", async () => {
    for (const status of ["absent", "retired"] as const) {
      await withHarness(async (test) => {
        test.repository.load = async () =>
          status === "absent"
            ? { status }
            : {
                status,
                planDigest: test.plan.planDigest,
                retiredAt: TAKEOVER_AT,
              }
        expect(await test.runNext()).toEqual({
          status: status === "absent" ? "save_required" : "retired",
        })
        expectNoPreparationActivity(test)
      })
    }
  })

  it("rejects principal, checkout, order, plan, and takeover mismatches before recovery", async () => {
    for (const field of [
      "principal",
      "checkoutId",
      "orderId",
      "planDigest",
      "takeoverAt",
    ] as const) {
      await withHarness(async (test) => {
        const saved = await test.stored.load(
          test.plan.checkoutId,
          test.plan.planDigest
        )
        test.repository.load = async () => saved
        const selected = { ...test.selected }
        if (field === "takeoverAt") selected.takeoverAt -= 1
        else if (field !== "principal")
          selected[field] = field === "planDigest" ? "e".repeat(64) : "other"
        await expect(
          test.runNext(field === "principal" ? OTHER : MERCHANT, selected)
        ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
        expectNoPreparationActivity(test)
      })
    }
  })

  it("waits for the selected and exact saved handoff before recovery", async () => {
    await withHarness(async (test) => {
      test.setClock(TAKEOVER_AT - 1)
      expect(await test.runNext()).toEqual({ status: "handoff_wait" })
      expectNoPreparationActivity(test)
    })
    await withHarness(async (test) => {
      let reads = 0
      test.dependencies.now = () =>
        reads++ === 0 ? TAKEOVER_AT : TAKEOVER_AT - 1
      expect(await test.runNext()).toEqual({ status: "handoff_wait" })
      expectNoPreparationActivity(test)
    })
  })

  it("prepares only the first never-prepared leg through the injected existing adapter", async () => {
    await withHarness(async (test) => {
      const result = await test.runNext()
      expect(result).toMatchObject({
        status: "attempted",
        recovery: {
          status: "consumed",
          candidate: test.selected,
          preparation: {
            status: "prepared",
            recoveryDelivery: "relay_accepted",
          },
        },
      })
      expect(test.calls.recoveries).toBe(1)
      expect(test.calls.opens).toBe(1)
      expect(test.calls.cleanups).toBe(1)
      expect(test.calls.derives).toBe(1)
      expect(test.calls.invoices).toEqual([999, 995])
      expect(test.calls.history).toEqual([
        deriveCheckoutSparkSettledTransferId(
          test.plan,
          test.state.legs[0]!.legId
        ),
      ])
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (saved.status !== "active") throw new Error("Fixture missing")
      expect(saved.state.legs[0]!.intent).toMatchObject({
        invoiceAmountSats: 995,
        maxFeeSats: 5,
      })
      expect(saved.state.legs[1]!.intent).toBeNull()
      expect(test.calls.wraps).toHaveLength(1)
      expect(test.calls.wraps[0]!.state).toEqual(saved.state)
      expect(test.wallet.outgoing).toBeUndefined()
    })
  })

  it("retains the first existing or expired intent instead of skipping to an unprepared leg", async () => {
    for (const expired of [false, true]) {
      for (const status of ["prepared", "submitted", "ambiguous"] as const) {
        await withHarness(async (test) => {
          const initial = await test.stored.load(
            test.plan.checkoutId,
            test.plan.planDigest
          )
          if (initial.status !== "active") throw new Error("Fixture missing")
          let state = prepared(credited(initial.state))
          const intent = state.legs[0]!.intent!
          if (status !== "prepared") {
            state = recordCheckoutSparkSettledLegStatus(state, {
              legId: intent.legId,
              transferId: intent.transferId,
              paymentHash: intent.paymentHash,
              status,
              observedAt: CREATED_AT + 4_000,
            })
          }
          await test.stored.save(state, initial.revision)
          if (expired) test.setClock(CREATED_AT + 7_200_000)
          expect(await test.runNext()).toMatchObject({
            status: "attempted",
            recovery: {
              preparation: {
                status: "existing_intent",
                recoveryDelivery: "relay_accepted",
              },
            },
          })
          const saved = await test.stored.load(
            test.plan.checkoutId,
            test.plan.planDigest
          )
          if (saved.status !== "active") throw new Error("Fixture missing")
          expect(saved.state.legs[0]).toEqual(state.legs[0]!)
          expect(saved.state.legs[1]!.intent).toBeNull()
          expect(test.calls.recoveries).toBe(1)
          expect(test.calls.derives).toBe(0)
          expect(test.calls.opens).toBe(0)
          expect(test.calls.invoices).toEqual([])
          expect(test.calls.fees).toEqual([])
          expect(test.calls.history).toEqual([])
          expect(test.calls.wraps).toHaveLength(1)
        })
      }
    }
  })

  it("selects the next unpaid leg but re-attests a locally paid predecessor before preparing it", async () => {
    await withHarness(async (test) => {
      const { transferId } = await seedMerchantPayout(test, true)
      expect(await test.runNext()).toMatchObject({
        status: "attempted",
        recovery: { preparation: { status: "history_wait" } },
      })
      expect(test.calls.recoveries).toBe(1)
      expect(test.calls.opens).toBe(1)
      expect(test.calls.cleanups).toBe(1)
      expect(test.calls.history).toEqual([transferId])
      expect(test.calls.invoices).toEqual([])
      expect(test.calls.wraps).toEqual([])
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (saved.status !== "active") throw new Error("Fixture missing")
      expect(saved.state.legs[0]!.status).toBe("paid")
      expect(saved.state.legs[1]!.intent).toBeNull()
      expect(
        (
          await test.stored.loadMerchantSettlement(
            MERCHANT,
            test.plan.checkoutId,
            test.plan.planDigest
          )
        )?.paidLegs
      ).toEqual([])
    })
  })

  it("returns only no-unpaid-leg for imported paid state without claiming provider settlement", async () => {
    await withHarness(async (test) => {
      const initial = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (initial.status !== "active") throw new Error("Fixture missing")
      let state = credited(initial.state)
      for (const [index, leg] of state.legs.entries()) {
        const allocation = leg.allocationSats!
        const intent = {
          legId: leg.legId,
          transferId: deriveCheckoutSparkSettledTransferId(
            test.plan,
            leg.legId
          ),
          paymentRequest: invoice(allocation - 1, index + 8),
          paymentHash: (index + 8).toString(16).padStart(2, "0").repeat(32),
          invoiceAmountSats: allocation - 1,
          maxFeeSats: 1,
          preparedAt: CREATED_AT + 3_000 + index * 2_000,
        }
        state = prepareCheckoutSparkSettledLeg(state, intent)
        state = recordCheckoutSparkSettledLegStatus(state, {
          legId: leg.legId,
          transferId: intent.transferId,
          paymentHash: intent.paymentHash,
          status: "paid",
          finalFeeSats: 1,
          finalDebitSats: allocation,
          observedAt: intent.preparedAt + 1_000,
        })
      }
      await test.stored.save(state, initial.revision)
      expect(await test.runNext()).toEqual({ status: "no_unpaid_leg" })
      expectNoPreparationActivity(test)
      expect(
        await test.stored.loadMerchantSettlement(
          MERCHANT,
          test.plan.checkoutId,
          test.plan.planDigest
        )
      ).toBeNull()
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status === "active" && saved.state).toEqual(state)
    })
  })

  it("waits for the pinned worker drain before reading saved state or recovery", async () => {
    await withHarness(async (test) => {
      const drain = heldBoundary()
      let reads = 0
      let replacementDrains = 0
      const load = test.repository.load
      test.repository.load = async (...args) => {
        reads += 1
        return load(...args)
      }
      test.nextInput.stopAndDrain = drain.wait
      const pending = test.runNext()
      await drain.started
      test.nextInput.stopAndDrain = async () => {
        replacementDrains += 1
      }
      expect(reads).toBe(0)
      expectNoPreparationActivity(test)
      drain.release()
      expect((await pending).status).toBe("attempted")
      expect(reads).toBeGreaterThan(0)
      expect(replacementDrains).toBe(0)
      expect(test.calls.recoveries).toBe(1)
    })
  })

  it("stops a revoked session after drain without reading local state or recovering", async () => {
    await withHarness(async (test) => {
      const drain = heldBoundary()
      let reads = 0
      const load = test.repository.load
      test.repository.load = async (...args) => {
        reads += 1
        return load(...args)
      }
      test.nextInput.stopAndDrain = drain.wait
      const pending = test.runNext()
      await drain.started
      test.revoke()
      test.nextInput.shouldContinue = () => true
      drain.release()
      await expect(pending).rejects.toThrow("session changed")
      expect(reads).toBe(0)
      expectNoPreparationActivity(test)
    })
  })

  it("stops a revoked session after a held local read using the original guard", async () => {
    await withHarness(async (test) => {
      const read = heldBoundary()
      const load = test.repository.load
      test.repository.load = async (...args) => {
        const saved = await load(...args)
        await read.wait()
        return saved
      }
      const pending = test.runNext()
      await read.started
      test.revoke()
      test.nextInput.shouldContinue = () => true
      read.release()
      await expect(pending).rejects.toThrow("session changed")
      expectNoPreparationActivity(test)
    })
  })

  it("pins the selected recovery and guard before the first local read", async () => {
    await withHarness(async (test) => {
      test.selected.merchantProgress = {
        wrapId: "8".repeat(64),
        snapshotId: "7".repeat(64),
        recordedAt: TAKEOVER_AT,
      }
      const selected = {
        ...test.selected,
        merchantProgress: { ...test.selected.merchantProgress },
      }
      const read = heldBoundary()
      const load = test.repository.load
      let reads = 0
      test.repository.load = async (...args) => {
        const saved = await load(...args)
        if (reads++ === 0) await read.wait()
        return saved
      }
      const pending = test.runNext(MERCHANT, selected)
      await read.started
      selected.checkoutId = "changed-checkout"
      selected.orderId = "changed-order"
      selected.planDigest = "e".repeat(64)
      selected.takeoverAt += 60_000
      selected.merchantProgress.snapshotId = "6".repeat(64)
      test.nextInput.shouldContinue = () => false
      read.release()
      expect(await pending).toMatchObject({
        status: "attempted",
        recovery: {
          candidate: test.selected,
          preparation: { status: "prepared" },
        },
      })
      expect(test.calls.recoveries).toBe(1)
      expect(test.calls.wraps[0]!.state.plan).toEqual(test.plan)
    })
  })

  it("preserves pending relay delivery and retries its exact wrap without another invoice", async () => {
    await withHarness(async (test) => {
      const transport = test.dependencies.progressTransport!
      const publish = transport.publishFn!
      transport.publishFn = async (...args) => ({
        ...(await publish(...args)),
        successfulRelayUrls: [],
        failedRelayUrls: [INBOX],
      })
      expect(await test.runNext()).toMatchObject({
        status: "attempted",
        recovery: {
          preparation: {
            status: "recovery_pending",
            recoveryDelivery: "pending",
          },
        },
      })
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      const invoices = [...test.calls.invoices]
      const history = [...test.calls.history]
      expect(await test.runNext()).toMatchObject({
        status: "attempted",
        recovery: {
          preparation: {
            status: "recovery_pending",
            recoveryDelivery: "pending",
          },
        },
      })
      expect(test.calls.opens).toBe(1)
      expect(test.calls.invoices).toEqual(invoices)
      expect(test.calls.history).toEqual(history)
      expect(test.calls.wraps).toHaveLength(1)
      expect(test.calls.publishes).toHaveLength(2)
      expect(test.calls.publishes[1]).toEqual(test.calls.publishes[0])
      expect(
        await test.stored.load(test.plan.checkoutId, test.plan.planDigest)
      ).toEqual(saved)
      const outbox = await test.progressStore.list(
        MERCHANT,
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(outbox).toHaveLength(1)
      expect(outbox[0]!.relayAccepted).toBe(false)
    })
  })
})

describe("Merchant payout preparation and exact recovery delivery adapter", () => {
  it("requires the exact Merchant signer before any wallet or financial request", async () => {
    for (const signer of [
      null,
      plainTestSigner({
        user: async () => new NDKUser({ pubkey: OTHER }),
      } as NDKSigner as never),
    ]) {
      await withHarness(async (test) => {
        test.dependencies.signer = signer
        await expect(test.run()).rejects.toThrow()
        expect(test.calls.derives).toBe(0)
        expect(test.calls.opens).toBe(0)
        expect(test.calls.invoices).toEqual([])
        expect(test.calls.history).toEqual([])
        expect(test.calls.wraps).toEqual([])
        expect(test.calls.publishes).toEqual([])
      })
    }
  })

  it("retries rejected or lost relay ACKs with the exact stored wrap and no new wallet or invoice", async () => {
    for (const firstOutcome of ["rejected", "lost"] as const) {
      await withHarness(async (test) => {
        const transport = test.dependencies.progressTransport!
        const publish = transport.publishFn!
        transport.publishFn = async (...args) => {
          const result = await publish(...args)
          if (firstOutcome === "lost")
            throw new Error("Synthetic relay result lost")
          return {
            ...result,
            successfulRelayUrls: [],
            failedRelayUrls: [INBOX],
            rejectedRelayUrls: [INBOX],
          }
        }
        const pending = await test.run()
        expect(pending.preparation).toEqual({
          status: "recovery_pending",
          recoveryDelivery: "pending",
        })
        const saved = await test.stored.load(
          test.plan.checkoutId,
          test.plan.planDigest
        )
        expect(saved.status).toBe("active")
        const first = await test.progressStore.list(
          MERCHANT,
          test.plan.checkoutId,
          test.plan.planDigest
        )
        expect(first).toHaveLength(1)
        expect(first[0]!.relayAccepted).toBe(false)
        expect(test.calls.wraps).toHaveLength(1)
        expect(test.calls.publishes).toHaveLength(1)
        const financialCalls = {
          opens: test.calls.opens,
          derives: test.calls.derives,
          invoices: [...test.calls.invoices],
          fees: [...test.calls.fees],
          history: [...test.calls.history],
        }
        test.setClock(TAKEOVER_AT + 20_000)
        transport.publishFn = publish
        const retried = await test.run()
        expect(retried.preparation).toEqual({
          status: "existing_intent",
          recoveryDelivery: "relay_accepted",
        })
        expect(test.calls.wraps).toHaveLength(1)
        expect(test.calls.publishes).toHaveLength(2)
        expect(test.calls.publishes[1]).toEqual(test.calls.publishes[0])
        expect({
          opens: test.calls.opens,
          derives: test.calls.derives,
          invoices: test.calls.invoices,
          fees: test.calls.fees,
          history: test.calls.history,
        }).toEqual(financialCalls)
        expect(
          await test.stored.load(test.plan.checkoutId, test.plan.planDigest)
        ).toEqual(saved)
        const accepted = await test.progressStore.list(
          MERCHANT,
          test.plan.checkoutId,
          test.plan.planDigest
        )
        expect(accepted).toHaveLength(1)
        expect(accepted[0]!.record).toEqual(first[0]!.record)
        expect(accepted[0]!.relayAccepted).toBe(true)
      })
    }
  })

  it("keeps the immutable local intent when staging fails without claiming relay acceptance", async () => {
    await withHarness(async (test) => {
      test.dependencies.progressStore = {
        load: test.progressStore.load.bind(test.progressStore),
        list: test.progressStore.list.bind(test.progressStore),
        markAccepted: test.progressStore.markAccepted.bind(test.progressStore),
        stage: async () => {
          throw new Error("Synthetic local outbox unavailable")
        },
      }
      const result = await test.run()
      expect(result.preparation?.status).toBe("recovery_pending")
      expect(result.preparation?.recoveryDelivery).not.toBe("relay_accepted")
      expect(test.calls.publishes).toEqual([])
      expect(
        await test.progressStore.list(
          MERCHANT,
          test.plan.checkoutId,
          test.plan.planDigest
        )
      ).toEqual([])
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(
        saved.status === "active" && saved.state.legs[0]!.intent
      ).toBeTruthy()
      const invoices = [...test.calls.invoices]
      test.dependencies.progressStore = test.progressStore
      expect((await test.run()).preparation).toEqual({
        status: "existing_intent",
        recoveryDelivery: "relay_accepted",
      })
      expect(test.calls.invoices).toEqual(invoices)
      expect(test.calls.opens).toBe(1)
    })
  })

  it("promotes only an existing buyer intent's snapshot timestamp once and keeps retry bytes stable", async () => {
    await withHarness(async (test) => {
      const initial = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (initial.status !== "active") throw new Error("Fixture missing")
      const before = prepared(credited(initial.state))
      await test.stored.save(before, initial.revision)
      const transport = test.dependencies.progressTransport!
      const publish = transport.publishFn!
      transport.publishFn = async (...args) => ({
        ...(await publish(...args)),
        successfulRelayUrls: [],
        failedRelayUrls: [INBOX],
      })
      expect((await test.run()).preparation?.status).toBe("recovery_pending")
      const promoted = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (promoted.status !== "active") throw new Error("Fixture missing")
      expect(promoted.state).toEqual({ ...before, updatedAt: TAKEOVER_AT })
      test.setClock(TAKEOVER_AT + 30_000)
      transport.publishFn = publish
      expect((await test.run()).preparation).toEqual({
        status: "existing_intent",
        recoveryDelivery: "relay_accepted",
      })
      expect(
        await test.stored.load(test.plan.checkoutId, test.plan.planDigest)
      ).toEqual(promoted)
      expect(test.calls.wraps).toHaveLength(1)
      expect(test.calls.publishes).toHaveLength(2)
      expect(test.calls.publishes[1]).toEqual(test.calls.publishes[0])
      expect(test.calls.opens).toBe(0)
      expect(test.calls.derives).toBe(0)
      expect(test.calls.invoices).toEqual([])
      expect(test.calls.history).toEqual([])
    })
  })

  it("drains an earlier pending snapshot before preparing another leg or touching the wallet", async () => {
    await withHarness(async (test) => {
      const transport = test.dependencies.progressTransport!
      const publish = transport.publishFn!
      transport.publishFn = async (...args) => ({
        ...(await publish(...args)),
        successfulRelayUrls: [],
        failedRelayUrls: [INBOX],
      })
      expect((await test.run()).preparation?.status).toBe("recovery_pending")
      const financialCalls = {
        opens: test.calls.opens,
        derives: test.calls.derives,
        invoices: [...test.calls.invoices],
        fees: [...test.calls.fees],
        history: [...test.calls.history],
      }
      test.input.legId = test.plan.recipients[1]!.legId
      expect((await test.run()).preparation?.status).toBe("recovery_pending")
      expect(test.calls.wraps).toHaveLength(1)
      expect(test.calls.publishes).toHaveLength(2)
      expect(test.calls.publishes[1]).toEqual(test.calls.publishes[0])
      expect({
        opens: test.calls.opens,
        derives: test.calls.derives,
        invoices: test.calls.invoices,
        fees: test.calls.fees,
        history: test.calls.history,
      }).toEqual(financialCalls)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(
        saved.status === "active" && saved.state.legs[1]!.intent
      ).toBeNull()
    })
  })

  it("uses the authenticated Merchant sidecar callback and republishes its exact saved intent without opening a wallet", async () => {
    await withHarness(async (test) => {
      const initial = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (initial.status !== "active") throw new Error("Fixture missing")
      const state = {
        ...prepared(credited(initial.state)),
        updatedAt: TAKEOVER_AT,
      }
      await test.stored.save(state, initial.revision)
      const progress = createCheckoutSparkMerchantProgress({
        initialHandoffId: test.payload.handoffId,
        state,
      })
      test.selected.merchantProgress = {
        wrapId: "8".repeat(64),
        snapshotId: progress.snapshotId,
        recordedAt: progress.recordedAt,
      }
      test.dependencies.consumeRecovery = async (
        principal,
        selected,
        adapter
      ) => {
        expect(principal).toBe(MERCHANT)
        expect(selected.merchantProgress).toEqual(
          test.selected.merchantProgress
        )
        expect(adapter.consumeMerchantProgress).toBeDefined()
        await adapter.consumeMerchantProgress!(
          test.payload,
          test.payload,
          progress,
          () => {}
        )
        return {
          status: "consumed",
          coverage: "complete",
          discoveryCoverage: "complete",
          declarationState: "declared",
          candidate: selected,
        }
      }
      const result = await test.run()
      expect(result.preparation).toEqual({
        status: "existing_intent",
        recoveryDelivery: "relay_accepted",
      })
      expect(test.calls.wraps).toEqual([progress])
      expect(test.calls.derives).toBe(0)
      expect(test.calls.opens).toBe(0)
      expect(test.calls.invoices).toEqual([])
      expect(
        await test.stored.loadMerchantSettlement(
          MERCHANT,
          test.plan.checkoutId,
          test.plan.planDigest
        )
      ).toBeNull()
    })
  })

  it("does not treat session revocation across signer, inbox resolution, or publish awaits as a retryable ACK", async () => {
    for (const boundary of ["signer", "inbox", "publish"] as const) {
      await withHarness(async (test) => {
        let entered!: () => void
        let release!: () => void
        const started = new Promise<void>((resolve) => {
          entered = resolve
        })
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        const wait = async () => {
          entered()
          await held
        }
        if (boundary === "signer") {
          test.dependencies.signer = plainTestSigner({
            user: async () => {
              await wait()
              return new NDKUser({ pubkey: MERCHANT })
            },
          } as NDKSigner as never)
        } else if (boundary === "inbox") {
          test.dependencies.progressTransport!.recipientInboxRelays = undefined
          test.dependencies.progressTransport!.resolveInboxRelays =
            async () => {
              await wait()
              return [INBOX]
            }
        } else {
          const publish = test.dependencies.progressTransport!.publishFn!
          test.dependencies.progressTransport!.publishFn = async (...args) => {
            const result = await publish(...args)
            await wait()
            return result
          }
        }
        const pending = test.run()
        await started
        test.revoke()
        release()
        await expect(pending).rejects.toThrow()
        expect(test.calls.cleanups).toBe(boundary === "signer" ? 0 : 1)
        expect(test.calls.publishes).toHaveLength(
          boundary === "publish" ? 1 : 0
        )
        const outbox = await test.progressStore.list(
          MERCHANT,
          test.plan.checkoutId,
          test.plan.planDigest
        )
        expect(outbox.every((entry) => !entry.relayAccepted)).toBe(true)
      })
    }
  })

  it("reloads an exact intent saved during the signer await without opening a wallet or replacing it", async () => {
    await withHarness(async (test) => {
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      test.dependencies.signer = plainTestSigner({
        user: async () => {
          entered()
          await held
          return new NDKUser({ pubkey: MERCHANT })
        },
      } as NDKSigner as never)
      const pending = test.run()
      await started
      const initial = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (initial.status !== "active") throw new Error("Fixture missing")
      const winner = {
        ...prepared(credited(initial.state), 10),
        updatedAt: TAKEOVER_AT,
      }
      await test.stored.save(winner, initial.revision)
      release()
      expect((await pending).preparation).toEqual({
        status: "existing_intent",
        recoveryDelivery: "relay_accepted",
      })
      expect(test.calls.wraps[0]!.state).toEqual(winner)
      expect(test.calls.opens).toBe(0)
      expect(test.calls.derives).toBe(0)
      expect(test.calls.invoices).toEqual([])
      expect(test.calls.history).toEqual([])
    })
  })

  it("pins the selected checkout, sidecar and leg before awaiting the signer", async () => {
    await withHarness(async (test) => {
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const original = structuredClone(test.selected)
      const originalLeg = test.input.legId
      test.dependencies.signer = plainTestSigner({
        user: async () => {
          entered()
          await held
          return new NDKUser({ pubkey: MERCHANT })
        },
      } as NDKSigner as never)
      const pending = test.run()
      await started
      test.selected.checkoutId = "substituted-checkout"
      test.selected.orderId = "substituted-order"
      test.selected.planDigest = "f".repeat(64)
      test.selected.wrapId = "7".repeat(64)
      test.selected.merchantProgress = {
        wrapId: "8".repeat(64),
        snapshotId: "6".repeat(64),
        recordedAt: TAKEOVER_AT + 10_000,
      }
      test.input.legId = test.plan.recipients[1]!.legId
      test.input.shouldContinue = () => false
      release()
      const result = await pending
      expect(result.preparation).toEqual({
        status: "prepared",
        recoveryDelivery: "relay_accepted",
      })
      expect(result.candidate).toEqual(original)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (saved.status !== "active") throw new Error("Fixture missing")
      expect(
        saved.state.legs.find((leg) => leg.legId === originalLeg)?.intent
      ).not.toBeNull()
      expect(saved.state.legs[1]!.intent).toBeNull()
      expect(test.calls.wraps[0]!.state.plan.checkoutId).toBe(
        original.checkoutId
      )
    })
  })

  it("requires a saved exact authenticated order witness before opening a wallet", async () => {
    for (const witness of [
      null,
      { buyerPubkey: OTHER },
      { orderId: "other-order" },
      { planDigest: "e".repeat(64) },
    ]) {
      await withHarness(async (test) => {
        test.repository.loadMerchantOrderWitness = async () =>
          witness === null ? null : { ...test.witness, ...witness }
        await expect(test.run()).rejects.toThrow()
        expect(test.calls.opens).toBe(0)
        expect(test.calls.invoices).toHaveLength(0)
      })
    }
  })

  it("rejects a recovery sender that differs from the authenticated order buyer", async () => {
    await withHarness(async (test) => {
      test.setPayload(
        createCheckoutSparkSettledRecoveryPayload({
          state: test.state,
          senderPubkey: OTHER,
          mnemonic: OTHER_MNEMONIC,
          accountNumber: 0,
          preparedAt: CREATED_AT + 1_000,
        })
      )
      await expect(test.run()).rejects.toThrow()
      expect(test.calls.opens).toBe(0)
      expect(test.calls.invoices).toHaveLength(0)
    })
  })

  it("rejects a wrong derived identity before open and cleans a mismatched opened wallet", async () => {
    const differentIdentity = `03${"e".repeat(64)}`
    await withHarness(async (test) => {
      test.dependencies.deriveIdentity = async () => differentIdentity
      await expect(test.run()).rejects.toThrow()
      expect(test.calls.opens).toBe(0)
      expect(test.calls.cleanups).toBe(0)
      expect(test.calls.invoices).toHaveLength(0)
    })
    await withHarness(async (test) => {
      test.wallet.getIdentityPublicKey = async () => differentIdentity
      await expect(test.run()).rejects.toThrow()
      expect(test.calls.opens).toBe(1)
      expect(test.calls.cleanups).toBe(1)
      expect(test.calls.invoices).toHaveLength(0)
    })
  })

  it("waits until handoff and prepares locally from exact receive credit without a send-capable wallet", async () => {
    await withHarness(async (test) => {
      test.setClock(TAKEOVER_AT - 1)
      await expect(test.run()).rejects.toThrow()
      expect(test.calls.opens).toBe(0)
      test.setClock(TAKEOVER_AT)
      const result = await test.run()
      expect(result.status).toBe("consumed")
      expect(result.preparation?.status).toBe("prepared")
      expect(result.preparation?.recoveryDelivery).toBe("relay_accepted")
      expect(test.calls.invoices).toEqual([999, 995])
      expect(test.calls.history).toContain(
        deriveCheckoutSparkSettledTransferId(test.plan, test.input.legId)
      )
      expect(test.calls.opens).toBe(1)
      expect(test.calls.cleanups).toBe(1)
      expect(test.wallet.outgoing).toBeUndefined()
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status).toBe("active")
      if (saved.status !== "active") return
      expect(saved.state.legs[0]!.intent).toMatchObject({
        invoiceAmountSats: 995,
        maxFeeSats: 5,
      })
      expect(saved.state.legs[1]!.intent).toBeNull()
      expect(test.calls.wraps).toHaveLength(1)
      expect(test.calls.wraps[0]!.state).toEqual(saved.state)
      expect(test.calls.publishes).toHaveLength(1)
      const outbox = await test.progressStore.list(
        MERCHANT,
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(outbox).toHaveLength(1)
      expect(outbox[0]!.relayAccepted).toBe(true)
      expect(outbox[0]!.record.signedRecipientWrap).toEqual(
        test.calls.publishes[0]!
      )
      expect(JSON.stringify(outbox)).not.toContain(test.payload.wallet.mnemonic)
      expect(JSON.stringify(outbox)).not.toContain('"paymentRequest"')
      expect(
        (
          await test.stored.loadMerchantSettlement(
            MERCHANT,
            test.plan.checkoutId,
            test.plan.planDigest
          )
        )?.credit?.creditedSats
      ).toBe(1_111)
    })
  })

  it("does not treat imported credit as provider proof and waits on an incomplete receive", async () => {
    await withHarness(async (test) => {
      const initial = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (initial.status !== "active") throw new Error("Fixture missing")
      await test.stored.save(credited(initial.state), initial.revision)
      test.wallet.getLightningReceiveRequest = async () => null
      expect((await test.run()).preparation?.status).toBe("funding_wait")
      expect(test.calls.invoices).toHaveLength(0)
      expect(test.calls.cleanups).toBe(1)
      expect(
        await test.stored.loadMerchantSettlement(
          MERCHANT,
          test.plan.checkoutId,
          test.plan.planDigest
        )
      ).toBeNull()
    })
  })

  it("rejects a receive whose exact amount, hash, or receiver does not match the saved plan", async () => {
    for (const mismatch of ["amount", "hash", "receiver"] as const) {
      await withHarness(async (test) => {
        if (mismatch === "receiver") {
          const read = test.wallet.getTransfer
          test.wallet.getTransfer = async (id) => ({
            ...(await read(id))!,
            receiverIdentityPublicKey: `03${"e".repeat(64)}`,
          })
        } else {
          const read = test.wallet.getLightningReceiveRequest
          test.wallet.getLightningReceiveRequest = async (id) => {
            const original = (await read(id))!
            return {
              ...original,
              invoice: {
                ...original.invoice,
                ...(mismatch === "hash"
                  ? { paymentHash: "04".repeat(32) }
                  : {
                      amount: { originalValue: 1_112, originalUnit: "SATOSHI" },
                    }),
              },
            }
          }
        }
        await expect(test.run()).rejects.toThrow()
        expect(test.calls.invoices).toHaveLength(0)
        expect(test.calls.cleanups).toBe(1)
      })
    }
  })

  it("does not request a replacement invoice when the fixed payout ID is present or unavailable", async () => {
    for (const history of ["present", "unavailable"] as const) {
      await withHarness(async (test) => {
        test.wallet.getTransferFromSsp = async (id) => {
          expect(id).toBe(
            deriveCheckoutSparkSettledTransferId(test.plan, test.input.legId)
          )
          if (history === "unavailable")
            throw new Error("Synthetic history unavailable")
          return {
            sparkId: id,
            totalAmount: { originalValue: 996, originalUnit: "SATOSHI" },
          }
        }
        expect((await test.run()).preparation?.status).toBe("history_wait")
        expect(test.calls.invoices).toHaveLength(0)
        expect(test.calls.fees).toHaveLength(0)
        expect(test.calls.cleanups).toBe(1)
      })
    }
  })

  it("preserves an existing submitted or expired intent instead of requesting a fresh invoice", async () => {
    for (const submitted of [false, true]) {
      await withHarness(async (test) => {
        const initial = await test.stored.load(
          test.plan.checkoutId,
          test.plan.planDigest
        )
        if (initial.status !== "active") throw new Error("Fixture missing")
        let state = prepared(credited(initial.state))
        const intent = state.legs[0]!.intent!
        if (submitted)
          state = recordCheckoutSparkSettledLegStatus(state, {
            legId: intent.legId,
            transferId: intent.transferId,
            paymentHash: intent.paymentHash,
            status: "submitted",
            observedAt: CREATED_AT + 4_000,
          })
        await test.stored.save(state, initial.revision)
        test.setClock(CREATED_AT + 7_200_000)
        expect((await test.run()).preparation?.status).toBe("existing_intent")
        expect(test.calls.invoices).toHaveLength(0)
        expect(test.calls.fees).toHaveLength(0)
        const saved = await test.stored.load(
          test.plan.checkoutId,
          test.plan.planDigest
        )
        expect(
          saved.status === "active" && saved.state.legs[0]!.intent
        ).toEqual(intent)
      })
    }
  })

  it("holds an expired intent without positive returned-funds proof even when renewal is authorized", async () => {
    await withHarness(async (test) => {
      const initial = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (initial.status !== "active") throw new Error("Fixture missing")
      const state = prepared(credited(initial.state))
      await test.stored.save(state, initial.revision)
      test.setClock(CREATED_AT + 7_200_000)

      const result = await prepareMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        test.selected,
        { ...test.input, allowRenewal: true },
        test.dependencies
      )

      expect(result.preparation?.status).toBe("history_wait")
      expect(test.calls.invoices.length).toBe(0)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status).toBe("active")
      if (saved.status !== "active") throw new Error("Fixture missing")
      expect(saved.state.legs[0]!.intent?.transferId).toBe(
        state.legs[0]!.intent!.transferId
      )
    })
  })

  it("prepares and acknowledges one successor only after exact full returned-funds proof", async () => {
    await withHarness(async (test) => {
      const context = await seedReturnedRenewal(test)
      const result = await context.run()

      expect(result.preparation?.status).toBe("prepared")
      expect(result.preparation?.recoveryDelivery).toBe("relay_accepted")
      expect(context.inspections.length).toBeGreaterThanOrEqual(2)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status).toBe("active")
      if (saved.status !== "active") throw new Error("Fixture missing")
      expect(saved.state.schemaVersion).toBe(4)
      expect(saved.state.legs[0]!.generation).toBe(1)
      expect(saved.state.legs[0]!.closedGenerations?.length).toBe(1)
      expect(
        saved.state.legs[0]!.closedGenerations?.[0]?.intent.transferId
      ).toBe(context.original.transferId)
      expect(
        saved.state.legs[0]!.intent?.transferId === context.original.transferId
      ).toBe(false)
      expect(saved.state.legs[1]!.intent).toBeNull()
      expect(test.calls.wraps.length).toBe(1)
      expect(test.calls.wraps[0]!.schemaVersion).toBe(2)
      expect(test.wallet.outgoing).toBeUndefined()
      expect(test.calls.cleanups).toBe(1)
    })
  }, 15_000)

  it("never uses the optional fee allocation to pay an oversized merchant fee", async () => {
    await withHarness(async (test) => {
      test.wallet.estimateLightningFee = async () => 1_000
      await expect(test.run()).rejects.toThrow()
      expect(test.calls.cleanups).toBe(1)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(
        saved.status === "active" &&
          saved.state.legs.every((leg) => leg.intent === null)
      ).toBe(true)
    })
  })

  it("reuses the local CAS winner instead of replacing its frozen invoice", async () => {
    await withHarness(async (test) => {
      const original = test.repository.savePreparedWithInvoiceOrigin
      let winner: CheckoutSparkSettledReconciliation | null = null
      test.repository.savePreparedWithInvoiceOrigin = async (
        next,
        revision,
        origin,
        assertCurrent
      ) => {
        if (!winner && next.legs[0]!.intent) {
          const loaded = await test.stored.load(
            test.plan.checkoutId,
            test.plan.planDigest
          )
          if (loaded.status !== "active") throw new Error("Fixture missing")
          winner = prepared(loaded.state, 10)
          await test.repository.save(winner, revision, assertCurrent)
          throw new CheckoutSparkSettledRepositoryConflictError()
        }
        return original(next, revision, origin, assertCurrent)
      }
      expect((await test.run()).preparation).not.toBeNull()
      expect(winner).not.toBeNull()
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(
        saved.status === "active" && saved.state.legs[0]!.intent?.paymentHash
      ).toBe("0a".repeat(32))
      expect(test.calls.invoices).toEqual([999, 995])
      expect(test.calls.cleanups).toBe(1)
    })
  })

  it("rejects a session revoked while fee estimation is pending and cleans the read-only wallet", async () => {
    await withHarness(async (test) => {
      let started!: () => void
      let release!: () => void
      const atFee = new Promise<void>((resolve) => {
        started = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      test.wallet.estimateLightningFee = async () => {
        started()
        await held
        return 1
      }
      const pending = test.run()
      await atFee
      test.revoke()
      release()
      await expect(pending).rejects.toThrow()
      expect(test.calls.cleanups).toBe(1)
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(
        saved.status === "active" && saved.state.legs[0]!.intent
      ).toBeNull()
    })
  })

  it("rejects sibling advancement while invoice resolution is pending and preserves that sibling", async () => {
    await withHarness(async (test) => {
      let started!: () => void
      let release!: () => void
      const atInvoice = new Promise<void>((resolve) => {
        started = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const resolve = test.dependencies.resolveInvoice!
      test.dependencies.resolveInvoice = async (request) => {
        const result = await resolve(request)
        started()
        await held
        return result
      }
      const pending = test.run()
      await atInvoice
      const current = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      if (current.status !== "active") throw new Error("Fixture missing")
      const sibling = current.state.legs[1]!
      const concurrent = prepareCheckoutSparkSettledLeg(current.state, {
        legId: sibling.legId,
        transferId: deriveCheckoutSparkSettledTransferId(
          test.plan,
          sibling.legId
        ),
        paymentRequest: invoice(110, 11),
        paymentHash: "0b".repeat(32),
        invoiceAmountSats: 110,
        maxFeeSats: 1,
        preparedAt: TAKEOVER_AT,
      })
      await test.stored.save(concurrent, current.revision)
      release()
      await expect(pending).rejects.toThrow()
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status).toBe("active")
      if (saved.status !== "active") return
      expect(saved.state.legs[0]!.intent).toBeNull()
      expect(saved.state.legs[1]!.intent).toEqual(concurrent.legs[1]!.intent)
      expect(test.calls.cleanups).toBe(1)
    })
  })

  it("keeps an optional fee behind required merchant payment and missing fee capability unavailable", async () => {
    await withHarness(async (test) => {
      test.input.legId = test.plan.recipients[1]!.legId
      expect((await test.run()).preparation?.status).toBe("prerequisite_unpaid")
      expect(test.calls.invoices).toHaveLength(0)
      expect(test.calls.cleanups).toBe(1)
    })
    await withHarness(async (test) => {
      test.wallet.estimateLightningFee = undefined
      expect((await test.run()).preparation?.status).toBe(
        "allocation_unavailable"
      )
      expect(test.calls.invoices).toHaveLength(0)
      expect(test.calls.cleanups).toBe(1)
    })
  })

  it("prepares the optional fee only after exact merchant provider preimage and debit are re-attested", async () => {
    await withHarness(async (test) => {
      const { transferId, nativeRequest } = await seedMerchantPayout(
        test,
        false
      )
      const conduitTransferId = deriveCheckoutSparkSettledTransferId(
        test.plan,
        test.input.legId
      )
      test.wallet.getTransferFromSsp = async (id) => {
        test.calls.history.push(id)
        if (id === conduitTransferId) return undefined
        expect(id).toBe(transferId)
        return {
          sparkId: transferId,
          totalAmount: { originalValue: 996, originalUnit: "SATOSHI" },
          userRequest: nativeRequest,
        }
      }
      test.wallet.getLightningSendRequest = async (id) => {
        expect(id).toBe(nativeRequest.id)
        return nativeRequest
      }
      test.wallet.estimateLightningFee = async () => 1
      test.dependencies.resolveInvoice = async (request) => {
        expect(request.lud16).toBe(test.plan.recipients[1]!.destination.value)
        test.calls.invoices.push(request.amountSats)
        return resolveCheckoutSparkLnurlInvoice(request, {
          fetchMetadata: async () => ({
            payRequestUrl:
              "https://wallet.conduit.market/.well-known/lnurlp/fee",
            lnurl: "lnurl1test",
            callback: "https://wallet.conduit.market/pay",
            minSendable: 1_000,
            maxSendable: 100_000_000,
            tag: "payRequest",
            allowsNostr: false,
            metadata: "[]",
          }),
          fetchInvoice: async () => ({
            invoice: invoice(request.amountSats, 6),
          }),
        })
      }
      expect((await test.run()).preparation?.status).toBe("prepared")
      expect(test.calls.history).toEqual([transferId, conduitTransferId])
      expect(test.calls.invoices).toEqual([110])
      const saved = await test.stored.load(
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(saved.status).toBe("active")
      if (saved.status !== "active") return
      expect(saved.state.legs[0]).toMatchObject({
        status: "paid",
        finalFeeSats: 1,
        finalDebitSats: 996,
      })
      expect(saved.state.legs[1]!.intent).toMatchObject({
        invoiceAmountSats: 110,
        maxFeeSats: 1,
      })
      const facts = await test.stored.loadMerchantSettlement(
        MERCHANT,
        test.plan.checkoutId,
        test.plan.planDigest
      )
      expect(facts?.paidLegs).toHaveLength(1)
      expect(facts?.paidLegs[0]).toMatchObject({
        transferId,
        finalDebitSats: 996,
        finalFeeSats: 1,
      })
      expect(test.calls.cleanups).toBe(1)
    })
  })

  it("does not promote imported merchant-paid progress when exact history is absent, unavailable, or mismatched", async () => {
    for (const history of [
      "not_found",
      "unavailable",
      "wrong_preimage",
      "wrong_debit",
    ] as const) {
      await withHarness(async (test) => {
        const { transferId, nativeRequest } = await seedMerchantPayout(
          test,
          true
        )
        const observedRequest = {
          ...nativeRequest,
          ...(history === "wrong_preimage"
            ? { paymentPreimage: "08".repeat(32) }
            : {}),
        }
        test.wallet.getTransferFromSsp = async (id) => {
          expect(id).toBe(transferId)
          if (history === "unavailable")
            throw new Error("Synthetic history unavailable")
          if (history === "not_found") return undefined
          return {
            sparkId: transferId,
            totalAmount: {
              originalValue: history === "wrong_debit" ? 999 : 996,
              originalUnit: "SATOSHI",
            },
            userRequest: observedRequest,
          }
        }
        test.wallet.getLightningSendRequest = async () => observedRequest
        expect((await test.run()).preparation?.status).toBe("history_wait")
        expect(test.calls.invoices).toHaveLength(0)
        expect(test.calls.fees).toHaveLength(0)
        const facts = await test.stored.loadMerchantSettlement(
          MERCHANT,
          test.plan.checkoutId,
          test.plan.planDigest
        )
        expect(facts?.paidLegs).toEqual([])
        expect(test.calls.cleanups).toBe(1)
      })
    }
  })
})

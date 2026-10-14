import { expect, mock } from "bun:test"
import { NDKEvent, NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import * as core from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"
import type { MerchantSparkRecoveryWallet } from "../../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { plainTestSigner } from "../../tests/helpers/plain-signer"
import { createInboxDeclarationFixtureEvidence } from "../../tests/helpers/inbox-declaration"
import { createRuntimeMnemonic } from "../../tests/support/runtime-wallet-fixtures"
import { qualifiedReceiverFixture } from "../../tests/support/checkout-spark-qualified-receiver-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "../../tests/support/checkout-spark-invoice-origin"
import {
  makeSignedBolt11Fixture,
  bolt11PaymentSecretField,
} from "../../tests/support/signed-bolt11-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "../../tests/support/bolt11-fixture"

// Offline composed Merchant wallet-open census; no real SDK initialization.
// Run alone: bun run scripts/dev/measure_checkout_spark_merchant_lifecycle.ts
// Wallet-open sessions are measured calls. The fixed 100 ms cost is a virtual
// sensitivity model, not measured native initialization or live checkout speed.
// This covers the historical Lightning Conduit-last fee plan, not a schema-4
// native-treasury lifetime measurement. Both retain their production guards.
// Only the credential transport is substituted; production advancement, credit,
// history, preparation, continuation, recipient proof, and retirement execute.
// The module mock is isolated in this script's subprocess, never a test import.
let networkAttempts = 0
globalThis.fetch = async () => {
  networkAttempts += 1
  throw new Error("Offline measurement forbids network access.")
}
Object.defineProperty(globalThis, "WebSocket", {
  configurable: true,
  value: class {
    constructor() {
      networkAttempts += 1
      throw new Error("Offline measurement forbids network access.")
    }
  },
})
let consumeFixture: typeof core.withMerchantCheckoutSparkRecovery
const originalCore = { ...core }
mock.module("@conduit/core", () => ({
  ...originalCore,
  withMerchantCheckoutSparkRecovery: (
    ...args: Parameters<typeof core.withMerchantCheckoutSparkRecovery>
  ) => consumeFixture(...args),
}))
const { advanceMerchantCheckoutSparkOrder } =
  await import("../../apps/merchant/src/lib/checkout-spark-order-reconciliation")
const {
  reconcileMerchantCheckoutSparkSettledCredit,
  inspectMerchantCheckoutSparkSettledPayoutHistory,
  retireMerchantCheckoutSparkSettledRecovery,
} = await import("../../apps/merchant/src/lib/checkout-spark-settled-recovery")
const {
  selectMerchantCheckoutSparkSignedNextPayout,
  continueMerchantCheckoutSparkSettledPayout,
} =
  await import("../../apps/merchant/src/lib/checkout-spark-settled-continuation")
const { prepareNextMerchantCheckoutSparkSettledPayout } =
  await import("../../apps/merchant/src/lib/checkout-spark-settled-leg-preparation")
const { verifySavedMerchantCheckoutSparkRecipients } =
  await import("../../apps/merchant/src/lib/checkout-spark-invoice-recipient")
const { relayTargetsFromUrls } =
  await import("../../packages/core/src/protocol/relay-authority")

const CREATED_AT = 1_800_000_000_000
const TAKEOVER_AT = CREATED_AT + 120_000
const IDENTITY = `02${"d".repeat(64)}`
const INBOX = "wss://merchant-lifecycle.inbox.relay.dev"
const INIT_COST_MS = 100
const merchantSecret = generateSecretKey()
const MERCHANT = getPublicKey(merchantSecret)
const BUYER = getPublicKey(generateSecretKey())
const wrapSecret = generateSecretKey()
const mnemonic = createRuntimeMnemonic()

function fundingInvoice(amountSats: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(3)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

async function measure(commerceLegs: number) {
  const commerceTotalSats = commerceLegs * 1_000
  const feeSats = core.calculateConduitCheckoutFeeSats(commerceTotalSats)
  const creditedSats = commerceTotalSats + feeSats
  const grossSats =
    core.calculateCheckoutSparkSettledGrossFundingSats(commerceTotalSats)
  const product = `30402:${MERCHANT}:merchant-lifecycle-${commerceLegs}`
  const recipients: core.CheckoutSparkSettledRecipientInput[] = Array.from(
    { length: commerceLegs },
    (_, index) => ({
      kind: index === 0 ? "merchant" : "supplier",
      recipientId: index === 0 ? MERCHANT : getPublicKey(generateSecretKey()),
      weightSats: 1_000,
      destination: {
        type: "lightning_address",
        value: `recipient${index}@receiver.conduit.cash`,
        source: {
          type: "signed_profile",
          profileEventId: (index + 1).toString(16).padStart(2, "0").repeat(32),
          profileEventCreatedAt: CREATED_AT / 1_000,
        },
      },
    })
  )
  recipients.push({
    kind: "conduit",
    recipientId: core.checkoutSparkConduitFeeRecipient("production"),
    weightSats: feeSats,
    destination: {
      type: "lightning_address",
      value: core.checkoutSparkConduitFeeRecipient("production"),
      source: { type: "conduit_allowlist", policy: "production" },
    },
  })
  const plan = core.freezeCheckoutSparkSettledPlan({
    checkoutId: `merchant-lifecycle-${commerceLegs}`,
    orderId: `merchant-lifecycle-order-${commerceLegs}`,
    merchantPubkey: MERCHANT,
    walletId: `merchant-lifecycle-wallet-${commerceLegs}`,
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: TAKEOVER_AT,
    commerceQuote: {
      commerceTotalSats,
      lines: [
        {
          productCoordinate: product,
          productEventId: "e".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: commerceTotalSats,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "merchant-lifecycle-receive",
      paymentRequest: fundingInvoice(grossSats),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: IDENTITY,
      grossFundingSats: grossSats,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients,
  })
  const initial = core.createCheckoutSparkSettledReconciliation(plan)
  const payload = core.createCheckoutSparkSettledRecoveryPayload({
    state: initial,
    senderPubkey: BUYER,
    mnemonic,
    accountNumber: 0,
    preparedAt: CREATED_AT + 1_000,
  })
  const order = new NDKEvent(undefined)
  order.kind = 16
  order.pubkey = BUYER
  order.created_at = CREATED_AT / 1_000 + 1
  order.tags = [
    ["p", MERCHANT],
    ["type", "order"],
    ["order", plan.orderId],
    ["amount", String(commerceTotalSats)],
    ["currency", "SATS"],
    ["item", product, "1"],
    [...core.CHECKOUT_SPARK_ROUTER_ORDER_TAG],
  ]
  order.content = JSON.stringify({
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
        priceAtPurchase: commerceTotalSats,
        currency: "SATS",
        shippingCostSats: 0,
      },
    ],
    subtotal: commerceTotalSats,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt: CREATED_AT + 1_000,
  })
  order.id = order.getEventHash()
  const evidence = core.readCheckoutSparkMerchantOrderEvidence(order)
  if (!evidence) throw new Error("Invalid fixture order")
  const witness = core.createCheckoutSparkMerchantOrderWitness(
    plan,
    evidence,
    BUYER
  )
  if (!witness) throw new Error("Invalid fixture witness")
  const database = new ConduitDB(`merchant-lifecycle-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const repository = new core.DexieCheckoutSparkSettledRepository(database)
  const progressStore = new core.DexieMerchantCheckoutSparkProgressRepository(
    database
  )
  await repository.importMerchantOrderRecovery(initial, witness, () => {})
  const declaration = await createInboxDeclarationFixtureEvidence(
    finalizeEvent(
      {
        kind: 10_050,
        created_at: CREATED_AT / 1_000,
        tags: [["relay", INBOX]],
        content: "",
      },
      merchantSecret
    )
  )
  const signer = plainTestSigner({
    user: async () => new NDKUser({ pubkey: MERCHANT }),
  } as NDKSigner as never)
  let virtualNow = TAKEOVER_AT
  let initializedMs = 0
  let activeWallets = 0
  let maxActiveWallets = 0
  let phase = "none"
  const counts = {
    opens: 0,
    cleanups: 0,
    sends: 0,
    recoveries: 0,
    wraps: 0,
    rescans: 0,
    progress: 0,
    receives: 0,
    history: 0,
    feeReads: 0,
    invoices: 0,
  }
  const phaseOpens: Record<string, number> = {}
  const receiverInvoices = new Map<
    string,
    ReturnType<typeof qualifiedReceiverFixture>
  >()
  type SendRequest = NonNullable<
    Awaited<
      ReturnType<
        NonNullable<MerchantSparkRecoveryWallet["getLightningSendRequest"]>
      >
    >
  >
  const sent = new Map<string, SendRequest>()
  let availableSats = creditedSats
  const sendOrder: string[] = []
  const snapshots = new Map<string, core.CheckoutSparkMerchantProgressPayload>()
  let latest: {
    wrap: core.SignedPublicNostrEvent
    progress: core.CheckoutSparkMerchantProgressPayload
  } | null = null
  const candidateBase: core.MerchantCheckoutSparkRecoveryCandidate = {
    wrapId: "9".repeat(64),
    schemaVersion: 2,
    checkoutId: plan.checkoutId,
    orderId: plan.orderId,
    planDigest: plan.planDigest,
    takeoverAt: TAKEOVER_AT,
    preparedAt: payload.preparedAt,
  }
  const candidate = (): core.MerchantCheckoutSparkRecoveryCandidate =>
    latest
      ? {
          ...candidateBase,
          merchantProgress: {
            wrapId: latest.wrap.id,
            snapshotId: latest.progress.snapshotId,
            recordedAt: latest.progress.recordedAt,
          },
        }
      : { ...candidateBase }
  consumeFixture = async (principal, selected, adapter) => {
    expect(principal).toBe(MERCHANT)
    expect(selected.checkoutId).toBe(plan.checkoutId)
    counts.recoveries += 1
    if (selected.merchantProgress) {
      const progress = snapshots.get(selected.merchantProgress.wrapId)
      if (
        !progress ||
        progress.snapshotId !== selected.merchantProgress.snapshotId ||
        progress.recordedAt !== selected.merchantProgress.recordedAt ||
        !adapter.consumeMerchantProgress
      )
        throw new Error("Missing exact signed progress fixture")
      await adapter.consumeMerchantProgress(
        payload,
        payload,
        progress,
        () => {}
      )
    } else {
      await adapter.consume(payload, () => {})
    }
    return {
      status: "consumed",
      coverage: "complete",
      discoveryCoverage: "complete",
      declarationState: "declared",
      candidate: selected,
    }
  }
  const wallet: MerchantSparkRecoveryWallet = {
    ensurePrivateReady: async () => {},
    getIdentityPublicKey: async () => IDENTITY,
    getLightningReceiveRequest: async () => {
      counts.receives += 1
      return {
        id: plan.funding.requestId,
        status: "TRANSFER_COMPLETED",
        network: "MAINNET",
        invoice: {
          encodedInvoice: plan.funding.paymentRequest,
          bitcoinNetwork: "MAINNET",
          paymentHash: plan.funding.paymentHash,
          amount: { originalValue: grossSats, originalUnit: "SATOSHI" },
        },
        transfer: {
          sparkId: "merchant-lifecycle-credit",
          userRequestId: plan.funding.requestId,
          totalAmount: { originalValue: creditedSats, originalUnit: "SATOSHI" },
        },
      }
    },
    getTransfer: async (id) => ({
      id,
      status: "TRANSFER_STATUS_COMPLETED",
      totalValue: creditedSats,
      transferDirection: "INCOMING",
      receiverIdentityPublicKey: IDENTITY,
      userRequest: { id: plan.funding.requestId },
    }),
    getTransferFromSsp: async (id) => {
      counts.history += 1
      const request = sent.get(id)
      if (!request) return undefined
      const loaded = await repository.load(plan.checkoutId, plan.planDigest)
      if (loaded.status !== "active") throw new Error("Missing active fixture")
      const leg = loaded.state.legs.find(
        (entry) => entry.intent?.transferId === id
      )
      if (!leg?.intent) throw new Error("Missing exact fixture attempt")
      return {
        sparkId: id,
        totalAmount: {
          originalValue: leg.intent.invoiceAmountSats + 1,
          originalUnit: "SATOSHI",
        },
        userRequest: request,
      }
    },
    getLightningSendRequest: async (id) =>
      [...sent.values()].find((request) => request.id === id) ?? null,
    estimateLightningFee: async () => {
      counts.feeReads += 1
      return 1
    },
    openRetirementReader: async () => ({
      sparkAddress: "synthetic-owned-address",
      reader: {
        getTransfers: async () => ({
          transfers: ["merchant-lifecycle-credit", ...sent.keys()].map(
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
    cleanup: async () => {
      counts.cleanups += 1
      activeWallets -= 1
      expect(activeWallets).toBe(0)
    },
    outgoing: {
      getAvailableSats: async () => BigInt(availableSats),
      estimateFee: async () => 1,
      sendFrozen: async (request) => {
        const loaded = await repository.load(plan.checkoutId, plan.planDigest)
        if (loaded.status !== "active") throw new Error("Missing saved intent")
        const leg = loaded.state.legs.find(
          (entry) => entry.intent?.transferId === request.transferId
        )
        if (
          !leg?.intent ||
          leg.status !== "submitted" ||
          sent.has(request.transferId)
        )
          throw new Error("Replay or missing submitted intent")
        const nextPosition = sendOrder.length
        expect(leg.legId).toBe(plan.recipients[nextPosition]!.legId)
        expect(request.paymentRequest).toBe(leg.intent.paymentRequest)
        const receiver = receiverInvoices.get(request.paymentRequest)!
        counts.sends += 1
        sendOrder.push(leg.legId)
        sent.set(request.transferId, {
          typename: "LightningSendRequest",
          id: `send-${counts.sends}`,
          status: "LIGHTNING_PAYMENT_SUCCEEDED",
          fee: { originalValue: 1, originalUnit: "SATOSHI" },
          encodedInvoice: request.paymentRequest,
          idempotencyKey: request.transferId,
          paymentPreimage: receiver.preimage,
        })
        availableSats -= leg.intent.invoiceAmountSats + 1
        return undefined
      },
    },
  }
  const openWallet = async (input: {
    mnemonic: string
    accountNumber: number
    network: "mainnet" | "regtest"
    outgoing?: true
    retirement?: true
  }): Promise<MerchantSparkRecoveryWallet> => {
    expect(input.mnemonic).toBe(mnemonic)
    expect(input.accountNumber).toBe(0)
    counts.opens += 1
    phaseOpens[phase] = (phaseOpens[phase] ?? 0) + 1
    activeWallets += 1
    maxActiveWallets = Math.max(maxActiveWallets, activeWallets)
    initializedMs += INIT_COST_MS
    virtualNow += INIT_COST_MS
    return input.outgoing ? wallet : { ...wallet, outgoing: undefined }
  }
  const progressTransport: core.MerchantCheckoutSparkProgressTransport = {
    recipientInboxRelays: [INBOX],
    inboxDeclarationEvidenceRepository: declaration,
    accountNetworkLocalStateRepository: { get: async () => undefined },
    giftWrapFn: async (rumor, recipient) => {
      expect(recipient.pubkey).toBe(MERCHANT)
      const progress = core.parseCheckoutSparkMerchantProgressRumor(rumor)
      counts.wraps += 1
      const wrap = finalizeEvent(
        {
          kind: 1059,
          created_at: Math.floor(virtualNow / 1_000),
          tags: [["p", MERCHANT]],
          content: `synthetic-opaque-${counts.wraps}`,
        },
        wrapSecret
      )
      snapshots.set(wrap.id, progress)
      return wrap
    },
    publishFn: async (event) => {
      const progress = snapshots.get(event.id)
      if (!progress) throw new Error("Missing exact fixture snapshot")
      latest = { wrap: event as core.SignedPublicNostrEvent, progress }
      return {
        plan: {
          intent: "recipient_event",
          primaryRelayTargets: relayTargetsFromUrls([INBOX], {
            kind: "owner_nip17",
            operation: "write",
            ownerPubkey: MERCHANT,
          }),
          broadcastRelayTargets: [],
          primaryRelayUrls: [INBOX],
          broadcastRelayUrls: [],
          parkedRelayUrls: [],
          independentRelayUrls: [INBOX],
        },
        attemptedRelayUrls: [INBOX],
        successfulRelayUrls: [INBOX],
        failedRelayUrls: [],
        relayFailureMessages: {},
      }
    },
  }
  const common = {
    repository,
    progressStore,
    progressTransport,
    signer,
    now: () => virtualNow,
    deriveIdentity: async () => IDENTITY,
    openWallet,
    consumeRecovery: consumeFixture,
    lockManager: null,
    requireCrossTabLock: false,
  }
  const inPhase = async <T>(
    name: string,
    work: () => Promise<T>
  ): Promise<T> => {
    const previous = phase
    phase = name
    try {
      return await work()
    } finally {
      phase = previous
    }
  }
  const dependencies: Parameters<typeof advanceMerchantCheckoutSparkOrder>[3] =
    {
      repository,
      now: () => virtualNow,
      notifySuppliers: () => {},
      requestRescan: () => {
        counts.rescans += 1
      },
      onProgress: () => {
        counts.progress += 1
      },
      checkCredit: (principal, selected, options) =>
        inPhase("credit", () =>
          reconcileMerchantCheckoutSparkSettledCredit(principal, selected, {
            ...common,
            ...options,
          })
        ),
      inspectPayouts: (principal, selected, options) =>
        inPhase("history", () =>
          inspectMerchantCheckoutSparkSettledPayoutHistory(
            principal,
            selected,
            { ...common, ...options }
          )
        ),
      selectPayout: (principal, selected, assertActive, options) =>
        selectMerchantCheckoutSparkSignedNextPayout(
          principal,
          selected,
          assertActive,
          { ...common, ...options }
        ),
      preparePayout: (principal, selected, input, options) =>
        inPhase("prepare", () =>
          prepareNextMerchantCheckoutSparkSettledPayout(
            principal,
            selected,
            input,
            {
              ...common,
              ...options,
              resolveInvoice: async (request) => {
                counts.invoices += 1
                const receiver = qualifiedReceiverFixture({
                  lud16: request.lud16,
                  amountSats: request.amountSats,
                  nowSeconds: Math.floor(virtualNow / 1_000),
                  preimageByte: counts.invoices + 10,
                })
                receiverInvoices.set(receiver.paymentRequest, receiver)
                return resolveCheckoutSparkFixtureInvoice(
                  request,
                  receiver.paymentRequest
                )
              },
            }
          )
        ),
      continuePayout: (principal, selected, review, options) =>
        inPhase("continue", () =>
          continueMerchantCheckoutSparkSettledPayout(
            principal,
            selected,
            review,
            { ...common, ...options }
          )
        ),
      retireWallet: (principal, selected, options) =>
        inPhase("retire", () =>
          retireMerchantCheckoutSparkSettledRecovery(principal, selected, {
            ...common,
            ...options,
          })
        ),
      verifyRecipients: (input) =>
        verifySavedMerchantCheckoutSparkRecipients({
          ...input,
          verifyInvoice: (request) => {
            const receiver = receiverInvoices.get(
              request.target.intent.paymentRequest
            )
            if (!receiver) throw new Error("Missing exact receiver fixture")
            return core.verifyCheckoutSparkInvoiceRecipient(request, {
              contracts: receiver.contracts,
              fetchMetadata: async () => receiver.metadata,
              fetchVerify: async () =>
                receiver.verifier(sent.has(request.target.intent.transferId)),
            })
          },
        }),
    }
  const phaseRows: {
    invocation: number
    status: string
    opens: number
    sends: number
    virtualInitMs: number
  }[] = []
  try {
    for (
      let invocation = 1;
      invocation <= 2 * plan.recipients.length + 4;
      invocation += 1
    ) {
      const before = { opens: counts.opens, sends: counts.sends, initializedMs }
      const status = await advanceMerchantCheckoutSparkOrder(
        MERCHANT,
        candidate(),
        () => {},
        dependencies
      )
      phaseRows.push({
        invocation,
        status,
        opens: counts.opens - before.opens,
        sends: counts.sends - before.sends,
        virtualInitMs: initializedMs - before.initializedMs,
      })
      expect(activeWallets).toBe(0)
      if (status === "retired") break
      expect(status).toBe("progress_pending")
    }
    expect(
      (await repository.load(plan.checkoutId, plan.planDigest)).status
    ).toBe("retired")
    expect(counts.sends).toBe(commerceLegs + 1)
    expect(sendOrder).toEqual(
      plan.recipients.map((recipient) => recipient.legId)
    )
    expect(counts.opens).toBe(counts.cleanups)
    expect(maxActiveWallets).toBe(1)
    expect(availableSats).toBe(0)
    const opensAtRetirement = counts.opens
    const sendsAtRetirement = counts.sends
    expect(
      await advanceMerchantCheckoutSparkOrder(
        MERCHANT,
        candidate(),
        () => {},
        dependencies
      )
    ).toBe("retired")
    expect(counts.opens).toBe(opensAtRetirement)
    expect(counts.sends).toBe(sendsAtRetirement)
    return {
      commerceLegs,
      conduitLegs: 1,
      walletOpens: counts.opens,
      walletCleanups: counts.cleanups,
      sends: counts.sends,
      virtualInitMs: initializedMs,
      maxActiveWallets,
      advancementInvocations: phaseRows.length,
      phaseWalletOpens: phaseOpens,
      terminalReplayOpens: counts.opens - opensAtRetirement,
      terminalReplaySends: counts.sends - sendsAtRetirement,
    }
  } finally {
    database.close()
    await database.delete()
  }
}

try {
  const cases = []
  for (const commerceLegs of [1, 3, 8]) cases.push(await measure(commerceLegs))
  expect(networkAttempts).toBe(0)
  // Imported app libraries may retain background handles. All measured work and
  // database cleanup has drained; flush only the bounded result, then end this
  // deliberately isolated process instead of waiting on unrelated handles.
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      measurement: "merchant_wallet_open_lifecycle",
      finalCollection: "lightning_fee_leg",
      environment: "offline_fixture",
      timing: "controlled_virtual_wallet_open_cost",
      initCostMs: INIT_COST_MS,
      networkAttempts,
      cases,
    })}\n`,
    () => process.exit(0)
  )
} catch {
  // Never print assertions, keys, payloads, or raw provider/transport errors.
  console.error("Merchant lifecycle measurement failed.")
  process.exit(1)
}

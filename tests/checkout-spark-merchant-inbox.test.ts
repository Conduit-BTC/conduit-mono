import { plainTestSigner } from "./helpers/plain-signer"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { NDKEvent, NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildCheckoutSparkRecoveryRumor,
  buildCheckoutSparkMerchantProgressRumor,
  createCheckoutSparkMerchantProgress,
  createCheckoutSparkRecoveryPayload,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  checkoutSparkConduitFeeRecipient,
  checkoutSparkProviderSendWindowEndsAt,
  DexieMerchantCheckoutSparkProgressRepository,
  DexieCheckoutSparkSettledRepository,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkPlan,
  getMerchantCheckoutSparkRecoveryList,
  parseCheckoutSparkMerchantProgressRumor,
  parseCheckoutSparkRecoveryRumor,
  prepareCheckoutSparkSettledLeg,
  projectCheckoutSparkMerchantSettlement,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  resolveCheckoutSparkLnurlInvoice,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkMerchantProgressPayload,
  type MerchantCheckoutSparkRecoveryCandidate,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"
import type { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import type { ReadProtectedInboxOptions } from "../packages/core/src/protocol/protected-inbox-read"
import {
  deriveMerchantCheckoutSparkRecoveryIdentity,
  importMerchantCheckoutSparkSettledRecovery,
  initializeMerchantSparkWalletWithCleanup,
  inspectMerchantCheckoutSparkSettledPayoutHistory,
  isLocalCheckoutSparkRecoveryRehearsal,
  merchantCheckoutRecoveryPrincipalKey,
  reconcileMerchantCheckoutSparkSettledCredit,
  verifyMerchantCheckoutSparkSettledRecoveryKey,
} from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import {
  continueMerchantCheckoutSparkSettledPayout,
  reviewMerchantCheckoutSparkSettledPayout,
  type MerchantCheckoutSparkContinuationDependencies,
} from "../apps/merchant/src/lib/checkout-spark-settled-continuation"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import {
  readProtectedInbox,
  type ProtectedInboxReadResult,
} from "../packages/core/src/protocol/protected-inbox-read"
import type { CommerceRelayExecutor } from "../packages/core/src/protocol/relay-executor"
import { hasCheckoutSparkProviderSendWindow } from "../packages/core/src/protocol/checkout-spark-invoice-expiry"
import {
  createRuntimeMnemonic,
  createRuntimeInvalidMnemonic,
} from "./support/runtime-wallet-fixtures"

const SETTLED_MNEMONIC = createRuntimeMnemonic()
const RECOVERY_MNEMONIC = createRuntimeMnemonic()
const VALID_MNEMONIC = createRuntimeMnemonic()
const INVALID_MNEMONIC = createRuntimeInvalidMnemonic()

const MERCHANT_SECRET = generateSecretKey()
const BUYER_SECRET = generateSecretKey()
const WRAP_SECRET = generateSecretKey()
const OTHER_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = getPublicKey(BUYER_SECRET)
const OTHER = getPublicKey(OTHER_SECRET)
const INBOX = "wss://merchant-recovery.example"
const CREATED_AT = 1_800_000_000_000
const SETTLED_PRODUCT = finalizeEvent(
  {
    kind: 30_402,
    created_at: CREATED_AT / 1_000,
    tags: [
      ["d", "merchant-settled-fixture"],
      ["title", "Merchant settled fixture"],
      ["price", "10", "SAT"],
      ["type", "simple", "digital"],
    ],
    content: "Signed digital listing",
  },
  MERCHANT_SECRET
)
const SETTLED_PROFILE = finalizeEvent(
  {
    kind: 0,
    created_at: CREATED_AT / 1_000,
    tags: [],
    content: JSON.stringify({ lud16: "merchant@example.test" }),
  },
  MERCHANT_SECRET
)
let sourceDatabase: ConduitDB

function settledInitialSnapshot(
  input: {
    mnemonic?: string
    accountNumber?: number
    receiverIdentityPublicKey?: string
    withSources?: boolean
  } = {}
) {
  const fundingInvoice = makeSignedBolt11Fixture({
    hrp: "lnbc1220n",
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(3)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-merchant-settled",
    orderId: "order-merchant-settled",
    merchantPubkey: MERCHANT,
    walletId: "wallet-merchant-settled",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    commerceQuote: {
      commerceTotalSats: 10,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:merchant-settled-fixture`,
          productEventId: SETTLED_PRODUCT.id,
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 10,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-merchant-settled",
      paymentRequest: fundingInvoice,
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey:
        input.receiverIdentityPublicKey ?? `02${"f".repeat(64)}`,
      grossFundingSats: 122,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
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
            profileEventId: SETTLED_PROFILE.id,
            profileEventCreatedAt: SETTLED_PROFILE.created_at,
          },
        },
        weightSats: 10,
      },
      {
        kind: "conduit",
        recipientId: checkoutSparkConduitFeeRecipient("production"),
        destination: {
          type: "lightning_address",
          value: checkoutSparkConduitFeeRecipient("production"),
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  const state = createCheckoutSparkSettledReconciliation(plan)
  const rumor = buildCheckoutSparkRecoveryRumor(
    createCheckoutSparkSettledRecoveryPayload({
      state,
      senderPubkey: BUYER,
      mnemonic: input.mnemonic ?? SETTLED_MNEMONIC,
      accountNumber: input.accountNumber ?? 0,
      preparedAt: CREATED_AT + 1_000,
      ...(input.withSources
        ? { sourceEvents: [SETTLED_PRODUCT, SETTLED_PROFILE] }
        : {}),
    })
  )
  return { plan, state, rumor }
}

async function selectSettledBuyerProgressFixture(withSources = false) {
  const { plan, state, rumor } = settledInitialSnapshot({ withSources })
  const initial = parseCheckoutSparkRecoveryRumor(rumor)
  if (initial.schemaVersion !== 2) throw new Error("Expected settled recovery.")
  const credited = recordCheckoutSparkSettledCredit(state, {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    transferId: "received-signed-source-fixture",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: 122,
    creditedSats: 121,
    observedAt: CREATED_AT + 2_000,
  })
  const progress = buildCheckoutSparkRecoveryRumor(
    createCheckoutSparkSettledRecoveryProgressPayload({
      initialHandoffId: initial.handoffId,
      state: credited,
      senderPubkey: BUYER,
      preparedAt: CREATED_AT + 3_000,
    })
  )
  const wraps = [
    signedWrap(MERCHANT, CREATED_AT),
    signedWrap(MERCHANT, CREATED_AT + 4_000),
  ]
  const rumors = new Map([
    [wraps[0]!.id, rumor],
    [wraps[1]!.id, progress],
  ])
  __setCommerceTestOverrides({
    resolveInboxRelayUrls: async () => [INBOX],
    readProtectedInbox: async (options) =>
      protectedRead(
        options.eventId
          ? wraps.filter((wrap) => wrap.id === options.eventId)
          : wraps
      ),
    giftUnwrap: async (event) => rumors.get(event.id) ?? null,
  })
  const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
    .candidates[0]!
  expect(selected.schemaVersion).toBe(3)
  return { plan, selected }
}

function settledMerchantProgressFixture(input: { paidClaim?: boolean } = {}) {
  const snapshot = settledInitialSnapshot()
  const initial = parseCheckoutSparkRecoveryRumor(snapshot.rumor)
  if (initial.schemaVersion !== 2) throw new Error("Expected settled recovery.")
  const credited = recordCheckoutSparkSettledCredit(snapshot.state, {
    requestId: snapshot.plan.funding.requestId,
    paymentHash: snapshot.plan.funding.paymentHash,
    transferId: "0197f9a0-0000-7000-8000-000000000001",
    receiverIdentityPublicKey: snapshot.plan.funding.receiverIdentityPublicKey,
    grossSats: 122,
    creditedSats: 121,
    observedAt: CREATED_AT + 2_000,
  })
  const leg = credited.legs[0]!
  const payoutInvoice = makeSignedBolt11Fixture({
    hrp: "lnbc90n",
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(8)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const prepared = prepareCheckoutSparkSettledLeg(credited, {
    legId: leg.legId,
    transferId: deriveCheckoutSparkSettledTransferId(snapshot.plan, leg.legId),
    paymentRequest: payoutInvoice,
    paymentHash: "08".repeat(32),
    invoiceAmountSats: 9,
    maxFeeSats: 1,
    preparedAt: snapshot.plan.takeoverAt,
  })
  const state = input.paidClaim
    ? recordCheckoutSparkSettledLegStatus(prepared, {
        legId: leg.legId,
        transferId: prepared.legs[0]!.intent!.transferId,
        paymentHash: prepared.legs[0]!.intent!.paymentHash,
        status: "paid",
        observedAt: snapshot.plan.takeoverAt + 1_000,
        finalFeeSats: 1,
        finalDebitSats: 10,
      })
    : prepared
  const progress = createCheckoutSparkMerchantProgress({
    initialHandoffId: initial.handoffId,
    state,
  })
  const initialWrap = signedWrap(MERCHANT, CREATED_AT)
  const progressWrap = signedWrap(MERCHANT, CREATED_AT + 121_000)
  const wraps = [initialWrap, progressWrap]
  const rumors = new Map([
    [initialWrap.id, snapshot.rumor],
    [progressWrap.id, buildCheckoutSparkMerchantProgressRumor(progress)],
  ])
  __setCommerceTestOverrides({
    resolveInboxRelayUrls: async () => [INBOX],
    readProtectedInbox: async (options) =>
      protectedRead(
        options.eventId
          ? wraps.filter((wrap) => wrap.id === options.eventId)
          : wraps
      ),
    giftUnwrap: async (event) => rumors.get(event.id) ?? null,
  })
  return {
    snapshot,
    initial,
    prepared: state,
    progress,
    initialWrap,
    progressWrap,
  }
}

function syntheticMerchantOrderWitness(
  fixture: { snapshot: ReturnType<typeof settledInitialSnapshot> },
  buyerPubkey = BUYER
) {
  return {
    schemaVersion: 1 as const,
    merchantPubkey: MERCHANT,
    buyerPubkey,
    orderId: fixture.snapshot.plan.orderId,
    rumorId: "a".repeat(64),
    contentHash: "b".repeat(64),
    checkoutId: fixture.snapshot.plan.checkoutId,
    planDigest: fixture.snapshot.plan.planDigest,
  }
}

async function withRecoveryDatabase(
  run: (
    database: ConduitDB,
    repository: DexieCheckoutSparkSettledRepository
  ) => Promise<void>
): Promise<void> {
  const database = new ConduitDB(
    `conduit-merchant-recovery-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  const repository = new DexieCheckoutSparkSettledRepository(database)
  __setCommerceTestOverrides({ checkoutSparkSettledRepository: repository })
  try {
    await run(database, repository)
  } finally {
    __setCommerceTestOverrides({
      checkoutSparkSettledRepository: new DexieCheckoutSparkSettledRepository(
        sourceDatabase
      ),
    })
    database.close()
    await database.delete()
  }
}

function plan() {
  return freezeCheckoutSparkPlan({
    checkoutId: "checkout-merchant-discovery",
    orderId: "order-merchant-discovery",
    merchantPubkey: MERCHANT,
    walletId: "checkout-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    funding: {
      requestId: "receive-merchant-discovery",
      paymentRequest: "lnbc-private-funding-invoice",
      paymentHash: "b".repeat(64),
      requiredNetSats: 1_235,
      grossFundingSats: 1_240,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 60_000,
    },
    obligations: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        paymentRequest: "lnbc-private-merchant-invoice",
        amountSats: 1_000,
        maxFeeSats: 100,
      },
      {
        kind: "conduit",
        recipientId: "conduithodlings@strike.me",
        paymentRequest: "lnbc-private-conduit-invoice",
        amountSats: 111,
        maxFeeSats: 24,
      },
    ],
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:merchant-discovery-fixture`,
          productEventId: "d".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
  })
}

function recoveryRumor(mnemonic = RECOVERY_MNEMONIC) {
  return buildCheckoutSparkRecoveryRumor(
    createCheckoutSparkRecoveryPayload({
      plan: plan(),
      senderPubkey: BUYER,
      mnemonic,
      accountNumber: 0,
      preparedAt: CREATED_AT + 1_000,
    })
  )
}

function signedWrap(recipient = MERCHANT, createdAt = CREATED_AT) {
  return finalizeEvent(
    {
      kind: 1_059,
      created_at: Math.floor(createdAt / 1_000),
      tags: [["p", recipient]],
      content: `opaque ciphertext ${createdAt}`,
    },
    WRAP_SECRET
  )
}

function protectedRead(
  events: ReturnType<typeof signedWrap>[],
  input: {
    coverage?: "complete" | "partial" | "unavailable"
    eventCount?: number
    malformedCount?: number
  } = {}
): ProtectedInboxReadResult {
  const coverage = input.coverage ?? "complete"
  const success = coverage === "complete"
  return {
    events,
    coverage,
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status: success ? "success" : coverage,
      observations: success ? [{ type: "eose", relayIndex: 0 }] : [],
      relays: [
        {
          relayIndex: 0,
          status: success ? "success" : "partial",
          auth: "not_challenged",
          eventCount: input.eventCount ?? events.length,
          duplicateCount: 0,
          malformedCount: input.malformedCount ?? 0,
          unusableCount: 0,
        },
      ],
      attemptedCount: 1,
      completedCount: success ? 1 : 0,
      failedCount: success ? 0 : 1,
      authoritativeEmpty: success && events.length === 0,
    },
  }
}

function installMerchantSession() {
  installProtectedReadSigner(
    {
      authMethod: "nip07",
      getPublicKey: async () => MERCHANT,
      signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
    },
    MERCHANT,
    () => true
  )
}

function setMerchantSigner(pubkey = MERCHANT) {
  __setCommerceTestOverrides({
    getAccountSigner: () =>
      plainTestSigner({
        user: async () => new NDKUser({ pubkey }),
      } as NDKSigner as never),
  })
}

/** Ciphertext-only fixture owner. Real encryption/storage coverage is in durable-inbox. */
function fixtureInboxOwner(): CommerceInbox {
  let observed: ReturnType<typeof signedWrap>[] = []
  let observedRelays: string[] = []
  let clean = false
  let readCoverage: ProtectedInboxReadResult["coverage"] = "partial"
  return {
    async loadOlder(options: {
      relayUrls: string[]
      read?: (
        input: ReadProtectedInboxOptions
      ) => Promise<ProtectedInboxReadResult>
    }) {
      const read = await options.read?.({
        principalPubkey: MERCHANT,
        relayUrls: options.relayUrls,
        ownerSelectedRelayUrls: options.relayUrls,
        appRelayUrls: [],
        limit: 400,
        authorization: getProtectedReadAuthorization(MERCHANT),
      })
      observed = read?.events ?? []
      readCoverage = read?.coverage ?? "unavailable"
      observedRelays = options.relayUrls
      clean =
        read?.coverage === "complete" &&
        read.relayResult.failedCount === 0 &&
        read.relayResult.relays.every(
          (row) =>
            row.eventCount < 400 &&
            row.malformedCount === 0 &&
            row.unusableCount === 0
        ) === true
    },
    async checkoutRecoveryDescriptors() {
      return observed.map((event) => ({ wrapId: event.id }))
    },
    store: {
      key: (logical: string) => logical,
      wrappers: async () =>
        observed.map((event) => ({
          event,
          sources: observedRelays,
          state: "machine",
        })),
      database: {
        commerceInboxRanges: {
          where: () => ({
            equals: () => ({
              toArray: async () =>
                observedRelays.map((relay) => ({
                  id: `${relay}:nip17`,
                  status: clean ? "source_eose" : readCoverage,
                  pageCount: 1,
                })),
            }),
          }),
        },
      },
    },
  } as unknown as CommerceInbox
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  installMerchantSession()
  setMerchantSigner()
  sourceDatabase = new ConduitDB(
    `conduit-merchant-sources-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  __setCommerceTestOverrides({
    getCommerceInbox: () => fixtureInboxOwner(),
    checkoutSparkSettledRepository: new DexieCheckoutSparkSettledRepository(
      sourceDatabase
    ),
    readCheckoutSparkPlanSourceEvents: async () => ({
      events: [SETTLED_PRODUCT, SETTLED_PROFILE],
      coverage: "complete",
    }),
  })
})

afterEach(async () => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  sourceDatabase.close()
  await sourceDatabase.delete()
})

describe("Merchant checkout Spark recovery discovery", () => {
  it("narrows the protected relay query to one full signed wrap ID", async () => {
    const wrap = signedWrap()
    let observedFilter: unknown
    const executor = {
      query: async (request: { filters: unknown[] }) => {
        observedFilter = request.filters[0]
        const read = protectedRead([wrap])
        return { ...read.relayResult, events: read.events }
      },
    } as unknown as CommerceRelayExecutor
    const authorization = getProtectedReadAuthorization(MERCHANT)
    expect(authorization).not.toBeNull()

    const result = await readProtectedInbox({
      principalPubkey: MERCHANT,
      relayUrls: [INBOX],
      ownerSelectedRelayUrls: [INBOX],
      appRelayUrls: [],
      eventId: wrap.id,
      limit: 2,
      authorization,
      accountNetworkLocalStateRepository: { get: async () => undefined },
      executor,
    })

    expect(observedFilter).toEqual({
      kinds: [1_059],
      "#p": [MERCHANT],
      ids: [wrap.id],
      limit: 2,
    })
    expect(result.events.map((event) => event.id)).toEqual([wrap.id])
  })

  it("discovers an exact signed wrap after fresh login without using order cache", async () => {
    const wrap = signedWrap()
    const rumor = recoveryRumor()
    let orderCacheReads = 0
    let observedRelays: string[] = []
    let observedAppRelays: readonly string[] | undefined
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) => {
        observedRelays = options.relayUrls
        observedAppRelays = options.appRelayUrls
        expect(options.principalPubkey).toBe(MERCHANT)
        expect(options.ownerSelectedRelayUrls).toEqual([INBOX])
        expect(options.limit).toBe(400)
        return protectedRead([wrap])
      },
      giftUnwrap: async () => rumor,
      getCachedOrderMessages: async () => {
        orderCacheReads += 1
        return []
      },
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(result).toEqual({
      candidates: [
        {
          wrapId: wrap.id,
          schemaVersion: 1,
          checkoutId: plan().checkoutId,
          orderId: plan().orderId,
          planDigest: plan().planDigest,
          takeoverAt: plan().takeoverAt,
          preparedAt: CREATED_AT + 1_000,
        },
      ],
      coverage: "complete",
      declarationState: "declared",
      malformedCount: 0,
      decryptFailureCount: 0,
      conflictCount: 0,
    })
    expect(observedRelays).toEqual([INBOX])
    expect(observedAppRelays).toEqual([])
    expect(orderCacheReads).toBe(0)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(RECOVERY_MNEMONIC)
    expect(serialized).not.toContain("lnbc-private")
  })

  it("does not fall back to compatibility relays without a declared inbox", async () => {
    let readCalled = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [],
      readProtectedInbox: async () => {
        readCalled = true
        return protectedRead([])
      },
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(result.candidates).toEqual([])
    expect(result.coverage).toBe("unavailable")
    expect(result.declarationState).toBe("not_observed")
    expect(readCalled).toBe(false)
  })

  it("marks a capped or degraded page partial even when a recovery was found", async () => {
    const wrap = signedWrap()
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () =>
        protectedRead([wrap], { eventCount: 400 }),
      giftUnwrap: async () => recoveryRumor(),
    })

    const capped = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(capped.candidates).toHaveLength(1)
    expect(capped.coverage).toBe("partial")

    __setCommerceTestOverrides({
      readProtectedInbox: async () =>
        protectedRead([wrap], { eventCount: 399 }),
    })
    const belowCap = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(belowCap.candidates).toHaveLength(1)
    expect(belowCap.coverage).toBe("complete")

    __setCommerceTestOverrides({
      readProtectedInbox: async () =>
        protectedRead([wrap], { coverage: "partial" }),
    })
    const degraded = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(degraded.candidates).toHaveLength(1)
    expect(degraded.coverage).toBe("partial")

    __setCommerceTestOverrides({
      readProtectedInbox: async () =>
        protectedRead([], { coverage: "unavailable" }),
    })
    const unavailable = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(unavailable.candidates).toEqual([])
    expect(unavailable.coverage).toBe("unavailable")

    __setCommerceTestOverrides({
      readProtectedInbox: async () => protectedRead([], { malformedCount: 1 }),
    })
    const malformedRelay = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(malformedRelay.candidates).toEqual([])
    expect(malformedRelay.coverage).toBe("partial")
  })

  it("limits foreground inspection and reports partial coverage when more wraps are present", async () => {
    const wraps = Array.from({ length: 51 }, (_, index) =>
      signedWrap(MERCHANT, CREATED_AT + index * 1_000)
    )
    let unwrapCount = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead(wraps),
      giftUnwrap: async () => {
        unwrapCount += 1
        return recoveryRumor()
      },
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(unwrapCount).toBe(50)
    expect(result.candidates).toHaveLength(1)
    expect(result.coverage).toBe("partial")
  })

  it("returns partial coverage when one signer unwrap stalls instead of hanging the foreground", async () => {
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([signedWrap()]),
      giftUnwrap: async () => new Promise<never>(() => {}),
    })

    const startedAt = Date.now()
    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(Date.now() - startedAt).toBeLessThan(6_000)
    expect(result.candidates).toEqual([])
    expect(result.coverage).toBe("partial")
  }, 8_000)

  it("rejects a mismatched signer before reading a relay", async () => {
    setMerchantSigner(OTHER)
    let readCalled = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => {
        readCalled = true
        return protectedRead([])
      },
    })

    await expect(
      getMerchantCheckoutSparkRecoveryList(MERCHANT)
    ).rejects.toThrow("authority changed")
    expect(readCalled).toBe(false)
  })

  it("discards results when protected account authority changes during the read", async () => {
    let current = true
    installProtectedReadSigner(
      {
        authMethod: "nip07",
        getPublicKey: async () => MERCHANT,
        signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
      },
      MERCHANT,
      () => current
    )
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => {
        current = false
        return protectedRead([signedWrap()])
      },
      giftUnwrap: async () => recoveryRumor(),
    })

    await expect(
      getMerchantCheckoutSparkRecoveryList(MERCHANT)
    ).rejects.toThrow("authority changed")
  })

  it("discards decrypted recovery material when the account changes after unwrap", async () => {
    let current = true
    installProtectedReadSigner(
      {
        authMethod: "nip07",
        getPublicKey: async () => MERCHANT,
        signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
      },
      MERCHANT,
      () => current
    )
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([signedWrap()]),
      giftUnwrap: async () => {
        current = false
        return recoveryRumor()
      },
    })

    await expect(
      getMerchantCheckoutSparkRecoveryList(MERCHANT)
    ).rejects.toThrow("authority changed")
  })

  it("does not turn an unexpected strict-inspection error into a clean empty result", async () => {
    let signerReads = 0
    __setCommerceTestOverrides({
      getAccountSigner: () =>
        plainTestSigner({
          user: async () => {
            signerReads += 1
            if (signerReads > 1) throw new Error("signer unavailable")
            return new NDKUser({ pubkey: MERCHANT })
          },
        } as NDKSigner as never),
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([signedWrap()]),
      giftUnwrap: async () => recoveryRumor(),
    })

    await expect(
      getMerchantCheckoutSparkRecoveryList(MERCHANT)
    ).rejects.toThrow("signer unavailable")
  })

  it("quarantines invalid outer wraps and decrypt failures without leaking payloads", async () => {
    const wrongRecipient = signedWrap(OTHER)
    const tampered = { ...signedWrap(), content: "changed after signature" }
    const undecipherable = signedWrap(MERCHANT, CREATED_AT + 1_000)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () =>
        protectedRead([wrongRecipient, tampered, undecipherable]),
      giftUnwrap: async () => null,
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(result.candidates).toEqual([])
    expect(result.coverage).toBe("partial")
    expect(result.malformedCount).toBe(2)
    expect(result.decryptFailureCount).toBe(1)
  })

  it("quarantines conflicting wallet authority for the same checkout", async () => {
    const firstWrap = signedWrap(MERCHANT, CREATED_AT)
    const secondWrap = signedWrap(MERCHANT, CREATED_AT + 1_000)
    const rumors = new Map([
      [firstWrap.id, recoveryRumor("synthetic wallet phrase one")],
      [secondWrap.id, recoveryRumor("synthetic wallet phrase two")],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([firstWrap, secondWrap]),
      giftUnwrap: async (event) => rumors.get(event.id) ?? null,
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(result.candidates).toEqual([])
    expect(result.conflictCount).toBe(1)
    expect(result.coverage).toBe("partial")
    expect(JSON.stringify(result)).not.toContain("phrase")
  })

  it("re-fetches the selected exact signed wrap and gives secrets only to a private adapter", async () => {
    const wrap = signedWrap()
    const observedReads: Array<{
      eventId?: string
      limit: number
      appRelays?: readonly string[]
    }> = []
    let consumed = 0
    let ordinaryCacheReads = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) => {
        observedReads.push({
          eventId: options.eventId,
          limit: options.limit,
          appRelays: options.appRelayUrls,
        })
        return protectedRead([wrap])
      },
      giftUnwrap: async () => recoveryRumor(),
      getCachedOrderMessages: async () => {
        ordinaryCacheReads += 1
        return []
      },
    })
    const discovery = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    const result = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      discovery.candidates[0]!,
      {
        async consume(payload, assertCurrent) {
          assertCurrent()
          expect(payload.wallet.mnemonic).toBe(RECOVERY_MNEMONIC)
          expect(payload.plan.planDigest).toBe(plan().planDigest)
          consumed += 1
        },
      }
    )

    expect(consumed).toBe(1)
    expect(ordinaryCacheReads).toBe(0)
    expect(observedReads).toEqual([
      { eventId: undefined, limit: 400, appRelays: [] },
      { eventId: undefined, limit: 400, appRelays: [] },
      { eventId: wrap.id, limit: 2, appRelays: [] },
    ])
    expect(result.status).toBe("consumed")
    expect(result.coverage).toBe("complete")
    expect(result.candidate?.wrapId).toBe(wrap.id)
    expect(JSON.stringify(result)).not.toContain("synthetic test-only")
    expect(JSON.stringify(result)).not.toContain("lnbc-private")
  })

  it("opens a previously selected exact wrap beyond 51 unrelated inbox wraps", async () => {
    const wrap = signedWrap()
    let crowded = false
    const unrelated = Array.from({ length: 51 }, (_, index) =>
      signedWrap(MERCHANT, CREATED_AT + (index + 1) * 1_000)
    )
    let consumed = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          options.eventId || !crowded ? [wrap] : [...unrelated, wrap]
        ),
      giftUnwrap: async (event) =>
        event.id === wrap.id
          ? recoveryRumor()
          : new NDKEvent(undefined, {
              kind: 14,
              tags: [],
              content: "ordinary message",
            }),
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    crowded = true
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      async consume(_payload, assertCurrent) {
        assertCurrent()
        consumed += 1
      },
    })
    expect(result.status).toBe("consumed")
    expect(result.coverage).toBe("complete")
    expect(result.discoveryCoverage).toBe("partial")
    expect(consumed).toBe(1)
  })

  it("blocks observed conflicting wallet authority even when the selected wrap fell outside the page", async () => {
    const wrap = signedWrap()
    const conflictingWrap = signedWrap(MERCHANT, CREATED_AT + 1_000)
    let changed = false
    let consumed = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          options.eventId || !changed ? [wrap] : [conflictingWrap],
          changed && !options.eventId ? { coverage: "partial" } : {}
        ),
      giftUnwrap: async (event) =>
        recoveryRumor(
          event.id === wrap.id
            ? "original synthetic material"
            : "conflicting synthetic material"
        ),
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    changed = true
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      async consume() {
        consumed += 1
      },
    })
    expect(result.status).toBe("incomplete")
    expect(result.coverage).toBe("partial")
    expect(consumed).toBe(0)
  })

  it("does not consume a stale, wrong, or missing exact wrap", async () => {
    const wrap = signedWrap()
    let readCount = 0
    let consumed = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) => {
        readCount += 1
        return options.eventId ? protectedRead([]) : protectedRead([wrap])
      },
      giftUnwrap: async () => recoveryRumor(),
    })
    const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    const adapter = {
      async consume() {
        consumed = true
      },
    }
    const wrong = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      { ...discovered.candidates[0]!, wrapId: "a".repeat(64) },
      adapter
    )
    expect(wrong.status).toBe("missing")
    expect(readCount).toBe(3)

    const missing = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      discovered.candidates[0]!,
      adapter
    )
    expect(missing.status).toBe("missing")
    expect(missing.coverage).toBe("complete")
    expect(consumed).toBe(false)
  })

  it("keeps forged, conflicting, and degraded exact reads out of the private adapter", async () => {
    const wrap = signedWrap()
    const altered = { ...wrap, content: "forged ciphertext" }
    let exact = protectedRead([altered])
    let consumed = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) => {
        return options.eventId ? exact : protectedRead([wrap])
      },
      giftUnwrap: async () => recoveryRumor(),
    })
    const adapter = {
      async consume() {
        consumed += 1
      },
    }
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!

    const forged = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(forged.status).toBe("incomplete")
    expect(forged.coverage).toBe("partial")

    exact = protectedRead([wrap, altered], { eventCount: 1 })
    const conflicting = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(conflicting.status).toBe("incomplete")
    expect(conflicting.coverage).toBe("partial")

    exact = protectedRead([signedWrap(MERCHANT, CREATED_AT + 1_000)])
    const wrongId = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(wrongId.status).toBe("incomplete")
    expect(wrongId.coverage).toBe("partial")

    exact = protectedRead([wrap], { coverage: "partial" })
    const degraded = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(degraded.status).toBe("incomplete")
    expect(degraded.coverage).toBe("partial")
    expect(consumed).toBe(0)
  })

  it("rejects account changes during exact re-fetch and sanitizes adapter errors", async () => {
    const wrap = signedWrap()
    let current = true
    let readCount = 0
    installProtectedReadSigner(
      {
        authMethod: "nip07",
        getPublicKey: async () => MERCHANT,
        signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
      },
      MERCHANT,
      () => current
    )
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => {
        readCount += 1
        if (readCount === 3) current = false
        return protectedRead([wrap])
      },
      giftUnwrap: async () => recoveryRumor(),
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        async consume() {
          throw new Error("should not run")
        },
      })
    ).rejects.toThrow("authority changed")

    current = true
    readCount = 0
    installMerchantSession()
    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        async consume() {
          throw new Error(RECOVERY_MNEMONIC)
        },
      })
    ).rejects.toThrow("Merchant checkout recovery adapter failed")
  })

  it("discards exact unwrapped material when the Merchant account changes", async () => {
    const wrap = signedWrap()
    let current = true
    let unwrapCount = 0
    let consumed = false
    installProtectedReadSigner(
      {
        authMethod: "nip07",
        getPublicKey: async () => MERCHANT,
        signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
      },
      MERCHANT,
      () => current
    )
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([wrap]),
      giftUnwrap: async () => {
        unwrapCount += 1
        if (unwrapCount === 3) current = false
        return recoveryRumor()
      },
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!

    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        async consume() {
          consumed = true
        },
      })
    ).rejects.toThrow("authority changed")
    expect(consumed).toBe(false)
  })

  it("leaves exact recovery partial if a signer unwrap stalls", async () => {
    const wrap = signedWrap()
    let unwrapCount = 0
    let consumed = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([wrap]),
      giftUnwrap: async () => {
        unwrapCount += 1
        return unwrapCount === 3
          ? new Promise<never>(() => {})
          : recoveryRumor()
      },
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      async consume() {
        consumed = true
      },
    })
    expect(result.status).toBe("incomplete")
    expect(result.coverage).toBe("partial")
    expect(consumed).toBe(false)
  }, 8_000)
})

describe("Merchant checkout Spark settled import", () => {
  it("remounts private recovery rows on principal changes", () => {
    expect(merchantCheckoutRecoveryPrincipalKey(MERCHANT)).not.toBe(
      merchantCheckoutRecoveryPrincipalKey(OTHER)
    )
    expect(merchantCheckoutRecoveryPrincipalKey(MERCHANT.toUpperCase())).toBe(
      merchantCheckoutRecoveryPrincipalKey(MERCHANT)
    )
    const panelSource = readFileSync(
      new URL(
        "../apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx",
        import.meta.url
      ),
      "utf8"
    )
    expect(panelSource).toMatch(
      /<CheckoutSparkRecoveryPanelForPrincipal\s+key=\{merchantCheckoutRecoveryPrincipalKey\(principalPubkey\)\}/
    )
    expect(panelSource).toContain("generation.current += 1")
  })

  it("keeps experimental provider compatibility behind an explicit local rehearsal", () => {
    const local = {
      dev: true,
      rehearsalFlag: "true",
      routerCanaryFlag: "true",
      hostname: "localhost",
      deploymentProfile: "local",
    }
    expect(isLocalCheckoutSparkRecoveryRehearsal(local)).toBe(true)
    expect(
      isLocalCheckoutSparkRecoveryRehearsal({
        ...local,
        hostname: "127.0.0.1",
      })
    ).toBe(true)
    expect(
      isLocalCheckoutSparkRecoveryRehearsal({ ...local, hostname: "[::1]" })
    ).toBe(true)
    expect(
      isLocalCheckoutSparkRecoveryRehearsal({ ...local, dev: false })
    ).toBe(false)
    for (const deploymentProfile of [
      "preview",
      "production",
      "staging",
      "unknown",
    ]) {
      expect(
        isLocalCheckoutSparkRecoveryRehearsal({ ...local, deploymentProfile })
      ).toBe(false)
    }
    expect(
      isLocalCheckoutSparkRecoveryRehearsal({
        ...local,
        rehearsalFlag: undefined,
      })
    ).toBe(false)
    expect(
      isLocalCheckoutSparkRecoveryRehearsal({
        ...local,
        routerCanaryFlag: undefined,
      })
    ).toBe(false)
    expect(
      isLocalCheckoutSparkRecoveryRehearsal({
        ...local,
        hostname: "sell.conduit.market",
      })
    ).toBe(false)
    expect(
      isLocalCheckoutSparkRecoveryRehearsal({
        ...local,
        hostname: "127.0.0.1.evil.test",
      })
    ).toBe(false)
  })

  it("rolls back import when Merchant authority changes during persistence", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const { rumor } = settledInitialSnapshot()
      const wrap = signedWrap(MERCHANT, CREATED_AT)
      let current = true
      installProtectedReadSigner(
        {
          authMethod: "nip07",
          getPublicKey: async () => MERCHANT,
          signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
        },
        MERCHANT,
        () => current
      )
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [INBOX],
        readProtectedInbox: async () => protectedRead([wrap]),
        giftUnwrap: async () => rumor,
      })
      const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
      database.checkoutSparkPlanBindings.hook("creating", () => {
        current = false
      })

      await expect(
        importMerchantCheckoutSparkSettledRecovery(
          MERCHANT,
          discovered.candidates[0]!,
          repository
        )
      ).rejects.toThrow("authority changed")
      expect(await database.checkoutSparkPlanBindings.count()).toBe(0)
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
    })
  })

  it("pairs a newer progress wrap with its initial and imports only the newer state", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const { plan, state, rumor } = settledInitialSnapshot()
      const initialPayload = parseCheckoutSparkRecoveryRumor(rumor)
      if (initialPayload.schemaVersion !== 2) {
        throw new Error("Invalid settled test fixture")
      }
      const credited = recordCheckoutSparkSettledCredit(state, {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: "received-exact-settled-test",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: 122,
        creditedSats: 121,
        observedAt: CREATED_AT + 2_000,
      })
      const progress = buildCheckoutSparkRecoveryRumor(
        createCheckoutSparkSettledRecoveryProgressPayload({
          initialHandoffId: initialPayload.handoffId,
          state: credited,
          senderPubkey: BUYER,
          preparedAt: CREATED_AT + 3_000,
        })
      )
      const initialWrap = signedWrap(MERCHANT, CREATED_AT)
      const progressWrap = signedWrap(MERCHANT, CREATED_AT + 4_000)
      const rumors = new Map([
        [initialWrap.id, rumor],
        [progressWrap.id, progress],
      ])
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [INBOX],
        readProtectedInbox: async (options) =>
          protectedRead(
            options.eventId
              ? [initialWrap, progressWrap].filter(
                  (wrap) => wrap.id === options.eventId
                )
              : [initialWrap, progressWrap]
          ),
        giftUnwrap: async (event) => rumors.get(event.id) ?? null,
      })
      const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
      expect(discovered.coverage).toBe("complete")
      expect(discovered.candidates[0]?.wrapId).toBe(progressWrap.id)
      expect(discovered.candidates[0]?.schemaVersion).toBe(3)

      const result = await importMerchantCheckoutSparkSettledRecovery(
        MERCHANT,
        discovered.candidates[0]!,
        repository
      )

      expect(result.status).toBe("consumed")
      const stored = await database.checkoutSparkReconciliations.get(
        plan.checkoutId
      )
      expect(stored?.state).toEqual(credited)
      expect(JSON.stringify(stored)).not.toContain(SETTLED_MNEMONIC)
    })
  })

  it("restores a selected progress wrap when bounded discovery no longer includes its initial wrap", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const { plan, state, rumor } = settledInitialSnapshot()
      const initialPayload = parseCheckoutSparkRecoveryRumor(rumor)
      if (initialPayload.schemaVersion !== 2) {
        throw new Error("Invalid settled test fixture")
      }
      const credited = recordCheckoutSparkSettledCredit(state, {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: "received-exact-settled-test",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: 122,
        creditedSats: 121,
        observedAt: CREATED_AT + 2_000,
      })
      const progress = buildCheckoutSparkRecoveryRumor(
        createCheckoutSparkSettledRecoveryProgressPayload({
          initialHandoffId: initialPayload.handoffId,
          state: credited,
          senderPubkey: BUYER,
          preparedAt: CREATED_AT + 3_000,
        })
      )
      const initialWrap = signedWrap(MERCHANT, CREATED_AT)
      const progressWrap = signedWrap(MERCHANT, CREATED_AT + 4_000)
      const unrelated = Array.from({ length: 51 }, (_, index) =>
        signedWrap(MERCHANT, CREATED_AT + 10_000 + index * 1_000)
      )
      const rumors = new Map([
        [initialWrap.id, rumor],
        [progressWrap.id, progress],
      ])
      let crowded = false
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [INBOX],
        readProtectedInbox: async (options) =>
          protectedRead(
            options.eventId
              ? [initialWrap, progressWrap].filter(
                  (wrap) => wrap.id === options.eventId
                )
              : crowded
                ? [...unrelated, progressWrap]
                : [initialWrap, progressWrap]
          ),
        giftUnwrap: async (event) =>
          rumors.get(event.id) ??
          new NDKEvent(undefined, {
            kind: 14,
            tags: [],
            content: "ordinary message",
          }),
      })
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      expect(selected.schemaVersion).toBe(3)
      crowded = true

      const result = await importMerchantCheckoutSparkSettledRecovery(
        MERCHANT,
        selected,
        repository
      )

      expect(result.status).toBe("consumed")
      expect(result.coverage).toBe("complete")
      expect(result.discoveryCoverage).toBe("partial")
      expect(
        (await database.checkoutSparkReconciliations.get(plan.checkoutId))
          ?.state
      ).toEqual(credited)
    })
  })

  it("refuses an older selected progress wrap when a newer signed update is observed", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const { plan, state, rumor } = settledInitialSnapshot()
      const initialPayload = parseCheckoutSparkRecoveryRumor(rumor)
      if (initialPayload.schemaVersion !== 2) {
        throw new Error("Invalid settled test fixture")
      }
      const credited = recordCheckoutSparkSettledCredit(state, {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: "received-exact-settled-test",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: 122,
        creditedSats: 121,
        observedAt: CREATED_AT + 2_000,
      })
      const makeProgress = (preparedAt: number) =>
        buildCheckoutSparkRecoveryRumor(
          createCheckoutSparkSettledRecoveryProgressPayload({
            initialHandoffId: initialPayload.handoffId,
            state: credited,
            senderPubkey: BUYER,
            preparedAt,
          })
        )
      const initialWrap = signedWrap(MERCHANT, CREATED_AT)
      const firstWrap = signedWrap(MERCHANT, CREATED_AT + 4_000)
      const laterWrap = signedWrap(MERCHANT, CREATED_AT + 6_000)
      const rumors = new Map([
        [initialWrap.id, rumor],
        [firstWrap.id, makeProgress(CREATED_AT + 3_000)],
        [laterWrap.id, makeProgress(CREATED_AT + 5_000)],
      ])
      let laterVisible = false
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [INBOX],
        readProtectedInbox: async (options) =>
          protectedRead(
            options.eventId
              ? [initialWrap, firstWrap, laterWrap].filter(
                  (wrap) => wrap.id === options.eventId
                )
              : laterVisible
                ? [initialWrap, firstWrap, laterWrap]
                : [initialWrap, firstWrap]
          ),
        giftUnwrap: async (event) => rumors.get(event.id) ?? null,
      })
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      expect(selected.wrapId).toBe(firstWrap.id)
      laterVisible = true

      const result = await importMerchantCheckoutSparkSettledRecovery(
        MERCHANT,
        selected,
        repository
      )

      expect(result.status).toBe("incomplete")
      expect(result.coverage).toBe("partial")
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
    })
  })

  it("rejects a selected progress wrap without an exact initial-wrap ID", async () => {
    const { state, rumor } = settledInitialSnapshot()
    const initialPayload = parseCheckoutSparkRecoveryRumor(rumor)
    if (initialPayload.schemaVersion !== 2) {
      throw new Error("Invalid settled test fixture")
    }
    const progress = buildCheckoutSparkRecoveryRumor(
      createCheckoutSparkSettledRecoveryProgressPayload({
        initialHandoffId: initialPayload.handoffId,
        state,
        senderPubkey: BUYER,
        preparedAt: CREATED_AT + 3_000,
      })
    )
    const initialWrap = signedWrap(MERCHANT, CREATED_AT)
    const progressWrap = signedWrap(MERCHANT, CREATED_AT + 4_000)
    const rumors = new Map([
      [initialWrap.id, rumor],
      [progressWrap.id, progress],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () =>
        protectedRead([initialWrap, progressWrap]),
      giftUnwrap: async (event) => rumors.get(event.id) ?? null,
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    expect(selected.schemaVersion).toBe(3)
    await expect(
      withMerchantCheckoutSparkRecovery(
        MERCHANT,
        { ...selected, initialWrapId: "not-a-wrap-id" },
        { async consume() {} }
      )
    ).rejects.toThrow("selection is invalid")
  })

  it("does not save when the fresh inbox pass loses relay coverage", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const { rumor } = settledInitialSnapshot()
      const wrap = signedWrap(MERCHANT, CREATED_AT)
      let reads = 0
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [INBOX],
        readProtectedInbox: async () => {
          reads += 1
          return protectedRead([wrap], {
            coverage: reads === 1 ? "complete" : "partial",
          })
        },
        giftUnwrap: async () => rumor,
      })
      const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
      expect(discovered.coverage).toBe("complete")

      const result = await importMerchantCheckoutSparkSettledRecovery(
        MERCHANT,
        discovered.candidates[0]!,
        repository
      )

      expect(result.status).toBe("incomplete")
      expect(result.coverage).toBe("partial")
      expect(await database.checkoutSparkPlanBindings.count()).toBe(0)
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
    })
  })

  it("keeps settled recovery incomplete when its exact signed profile is unavailable", async () => {
    const { selected } = await selectSettledBuyerProgressFixture()
    let sourceReads = 0
    __setCommerceTestOverrides({
      readCheckoutSparkPlanSourceEvents: async () => {
        sourceReads += 1
        return { events: [SETTLED_PRODUCT], coverage: "complete" }
      },
    })
    let consumed = 0
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      consume: async () => {
        consumed += 1
      },
      consumeSettled: async () => {
        consumed += 1
      },
    })
    expect(result.status).toBe("incomplete")
    expect(sourceReads).toBeGreaterThan(0)
    expect(consumed).toBe(0)
  })

  it("admits exact signed settled sources despite partial source transport coverage", async () => {
    await withRecoveryDatabase(async () => {
      let sourceReads = 0
      __setCommerceTestOverrides({
        readCheckoutSparkPlanSourceEvents: async () => {
          sourceReads += 1
          return {
            events: [SETTLED_PRODUCT, SETTLED_PROFILE],
            coverage: "partial",
          }
        },
      })
      const { plan, selected } = await selectSettledBuyerProgressFixture()
      let consumed = 0
      const result = await withMerchantCheckoutSparkRecovery(
        MERCHANT,
        selected,
        {
          consume: async () => {
            throw new Error("Unexpected legacy recovery consumer")
          },
          consumeSettled: async (initial, progress, assertCurrent) => {
            assertCurrent()
            expect(initial.plan).toEqual(plan)
            expect(progress.plan).toEqual(plan)
            consumed += 1
          },
        }
      )
      expect(result.status).toBe("consumed")
      expect(sourceReads).toBeGreaterThan(0)
      expect(consumed).toBe(1)
    })
  })

  it("consumes later buyer progress using the referenced initial source bundle", async () => {
    const { plan, selected } = await selectSettledBuyerProgressFixture(true)
    let publicReads = 0
    __setCommerceTestOverrides({
      readCheckoutSparkPlanSourceEvents: async () => {
        publicReads += 1
        return { events: [], coverage: "unavailable" }
      },
    })
    let consumed = 0
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      consume: async () => {
        throw new Error("Expected later buyer progress.")
      },
      consumeSettled: async (initial, progress, assertCurrent) => {
        assertCurrent()
        expect(initial.sourceEvents?.map((event) => event.id).sort()).toEqual(
          [SETTLED_PRODUCT.id, SETTLED_PROFILE.id].sort()
        )
        expect(progress.plan).toEqual(plan)
        consumed += 1
      },
    })
    expect(result.status).toBe("consumed")
    expect(consumed).toBe(1)
    expect(publicReads).toBe(0)
  })

  it.each([false, true])(
    "imports exact initial recovery without wallet material (bundled sources: %s)",
    async (withSources) => {
      await withRecoveryDatabase(async (database, repository) => {
        const { plan, state, rumor } = settledInitialSnapshot({ withSources })
        const wrap = signedWrap(MERCHANT, CREATED_AT)
        let ordinaryCacheReads = 0
        let publicReads = 0
        __setCommerceTestOverrides({
          resolveInboxRelayUrls: async () => [INBOX],
          readProtectedInbox: async () => protectedRead([wrap]),
          giftUnwrap: async () => rumor,
          readCheckoutSparkPlanSourceEvents: async () => {
            publicReads += 1
            return {
              events: withSources ? [] : [SETTLED_PRODUCT, SETTLED_PROFILE],
              coverage: withSources ? "unavailable" : "complete",
            }
          },
          getCachedOrderMessages: async () => {
            ordinaryCacheReads += 1
            return []
          },
        })
        const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
        expect(discovered.coverage).toBe("complete")
        expect(discovered.candidates[0]?.schemaVersion).toBe(2)

        const result = await importMerchantCheckoutSparkSettledRecovery(
          MERCHANT,
          discovered.candidates[0]!,
          repository
        )

        expect(result.status).toBe("consumed")
        expect(ordinaryCacheReads).toBe(0)
        expect(publicReads).toBe(withSources ? 0 : 1)
        expect(
          (
            await repository.loadMerchantPlanSourceEvents(
              plan.checkoutId,
              plan.planDigest
            )
          )
            .map((event) => event.id)
            .sort()
        ).toEqual([SETTLED_PRODUCT.id, SETTLED_PROFILE.id].sort())
        const stored = await database.checkoutSparkReconciliations.get(
          plan.checkoutId
        )
        expect(stored?.state).toEqual(state)
        expect(JSON.stringify(stored)).not.toContain(SETTLED_MNEMONIC)
        expect(JSON.stringify(result)).not.toContain(SETTLED_MNEMONIC)
      })
    }
  )
})

describe("Merchant checkout Spark offline recovery-key verification", () => {
  it("offers explicit verification only within the private account-keyed panel", () => {
    const panelSource = readFileSync(
      new URL(
        "../apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx",
        import.meta.url
      ),
      "utf8"
    )
    expect(panelSource).toContain(
      "verifyMerchantCheckoutSparkSettledRecoveryKey"
    )
    expect(panelSource).toContain("Check recovery access")
    expect(panelSource).toContain(
      "This check did not inspect funds or recipient payments, reveal the recovery phrase, or move money."
    )
    expect(panelSource).toContain("startMerchantCheckoutSparkDiscovery")
    expect(panelSource).toContain("await stopDiscovery()")
    expect(panelSource).toContain("CheckoutSparkRecoveryPanelForPrincipal")
  })

  it("derives a local identity from the exact account and rejects invalid recovery input", async () => {
    const mnemonic = VALID_MNEMONIC
    const accountOne = await deriveMerchantCheckoutSparkRecoveryIdentity(
      mnemonic,
      1
    )
    const accountZero = await deriveMerchantCheckoutSparkRecoveryIdentity(
      mnemonic,
      0
    )
    expect(accountOne).toMatch(/^(02|03)[0-9a-f]{64}$/)
    expect(accountZero).toMatch(/^(02|03)[0-9a-f]{64}$/)
    expect(accountOne).not.toBe(accountZero)
    await expect(
      deriveMerchantCheckoutSparkRecoveryIdentity(mnemonic, 0x80000000)
    ).rejects.toThrow("account is invalid")
    await expect(
      deriveMerchantCheckoutSparkRecoveryIdentity(INVALID_MNEMONIC, 1)
    ).rejects.toThrow("phrase is invalid")
  })

  it("matches the signed funding identity after takeover without saving or returning the key", async () => {
    await withRecoveryDatabase(async (database) => {
      const mnemonic = VALID_MNEMONIC
      const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
        mnemonic,
        1
      )
      const snapshot = settledInitialSnapshot({
        mnemonic,
        accountNumber: 1,
        receiverIdentityPublicKey: identity,
      })
      const wrap = signedWrap(MERCHANT, CREATED_AT)
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [INBOX],
        readProtectedInbox: async () => protectedRead([wrap]),
        giftUnwrap: async () => snapshot.rumor,
      })
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!

      const verified = await verifyMerchantCheckoutSparkSettledRecoveryKey(
        MERCHANT,
        selected,
        { now: () => snapshot.plan.takeoverAt }
      )

      expect(verified.status).toBe("consumed")
      expect(JSON.stringify(verified)).not.toContain(mnemonic)
      expect(await database.checkoutSparkReconciliations.count()).toBe(0)
      expect(await database.wallets.count()).toBe(0)
      expect(await database.walletCredentials.count()).toBe(0)
    })
  })

  it("refuses before takeover and does not derive a mismatched key into authority", async () => {
    const snapshot = settledInitialSnapshot()
    const wrap = signedWrap(MERCHANT, CREATED_AT)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([wrap]),
      giftUnwrap: async () => snapshot.rumor,
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    let derivations = 0
    const deriveIdentity = async () => {
      derivations += 1
      return `02${"a".repeat(64)}`
    }
    await expect(
      verifyMerchantCheckoutSparkSettledRecoveryKey(MERCHANT, selected, {
        now: () => snapshot.plan.takeoverAt - 1,
        deriveIdentity,
      })
    ).rejects.toThrow("Merchant checkout recovery adapter failed")
    expect(derivations).toBe(0)
    await expect(
      verifyMerchantCheckoutSparkSettledRecoveryKey(MERCHANT, selected, {
        now: () => snapshot.plan.takeoverAt,
        deriveIdentity,
      })
    ).rejects.toThrow("Merchant checkout recovery adapter failed")
    expect(derivations).toBe(1)
  })

  it("revalidates exact signed v3 progress against its original frozen funding key", async () => {
    const snapshot = settledInitialSnapshot()
    const initialPayload = parseCheckoutSparkRecoveryRumor(snapshot.rumor)
    if (initialPayload.schemaVersion !== 2) {
      throw new Error("Invalid settled test fixture")
    }
    const credited = recordCheckoutSparkSettledCredit(snapshot.state, {
      requestId: snapshot.plan.funding.requestId,
      paymentHash: snapshot.plan.funding.paymentHash,
      transferId: "received-exact-settled-test",
      receiverIdentityPublicKey:
        snapshot.plan.funding.receiverIdentityPublicKey,
      grossSats: 122,
      creditedSats: 121,
      observedAt: CREATED_AT + 2_000,
    })
    const progress = buildCheckoutSparkRecoveryRumor(
      createCheckoutSparkSettledRecoveryProgressPayload({
        initialHandoffId: initialPayload.handoffId,
        state: credited,
        senderPubkey: BUYER,
        preparedAt: CREATED_AT + 3_000,
      })
    )
    const initialWrap = signedWrap(MERCHANT, CREATED_AT)
    const progressWrap = signedWrap(MERCHANT, CREATED_AT + 4_000)
    const wraps = [initialWrap, progressWrap]
    const rumors = new Map([
      [initialWrap.id, snapshot.rumor],
      [progressWrap.id, progress],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          options.eventId
            ? wraps.filter((wrap) => wrap.id === options.eventId)
            : wraps
        ),
      giftUnwrap: async (event) => rumors.get(event.id) ?? null,
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    expect(selected.schemaVersion).toBe(3)
    let derivations = 0
    const verified = await verifyMerchantCheckoutSparkSettledRecoveryKey(
      MERCHANT,
      selected,
      {
        now: () => snapshot.plan.takeoverAt,
        deriveIdentity: async (mnemonic, accountNumber) => {
          derivations += 1
          expect(mnemonic).toBe(SETTLED_MNEMONIC)
          expect(accountNumber).toBe(0)
          return snapshot.plan.funding.receiverIdentityPublicKey
        },
      }
    )
    expect(verified.status).toBe("consumed")
    expect(derivations).toBe(1)
    expect(JSON.stringify(verified)).not.toContain("synthetic test-only")
  })

  it("never derives if the fresh signed inbox loses coverage", async () => {
    const snapshot = settledInitialSnapshot()
    const wrap = signedWrap(MERCHANT, CREATED_AT)
    let reads = 0
    let derivations = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => {
        reads += 1
        return protectedRead([wrap], {
          coverage: reads === 1 ? "complete" : "partial",
        })
      },
      giftUnwrap: async () => snapshot.rumor,
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    const verified = await verifyMerchantCheckoutSparkSettledRecoveryKey(
      MERCHANT,
      selected,
      {
        now: () => snapshot.plan.takeoverAt,
        deriveIdentity: async () => {
          derivations += 1
          return snapshot.plan.funding.receiverIdentityPublicKey
        },
      }
    )
    expect(verified.status).toBe("incomplete")
    expect(verified.coverage).toBe("partial")
    expect(derivations).toBe(0)
  })

  it("drops a derived identity if Merchant authority changes during derivation", async () => {
    const snapshot = settledInitialSnapshot()
    const wrap = signedWrap(MERCHANT, CREATED_AT)
    let current = true
    installProtectedReadSigner(
      {
        authMethod: "nip07",
        getPublicKey: async () => MERCHANT,
        signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
      },
      MERCHANT,
      () => current
    )
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([wrap]),
      giftUnwrap: async () => snapshot.rumor,
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    await expect(
      verifyMerchantCheckoutSparkSettledRecoveryKey(MERCHANT, selected, {
        now: () => snapshot.plan.takeoverAt,
        deriveIdentity: async () => {
          current = false
          return snapshot.plan.funding.receiverIdentityPublicKey
        },
      })
    ).rejects.toThrow("authority changed")
  })
})

describe("Merchant checkout Spark exact credit recovery", () => {
  function fakeCreditWallet(
    snapshot: ReturnType<typeof settledInitialSnapshot>,
    input: {
      status?: string
      creditedSats?: number
      transferId?: string
      identity?: string
      onCleanup?: () => void
    } = {}
  ) {
    const requestId = snapshot.plan.funding.requestId
    const transferId =
      input.transferId ?? "0197f9a0-0000-7000-8000-000000000001"
    return {
      ensurePrivateReady: async () => {},
      getIdentityPublicKey: async () =>
        input.identity ?? snapshot.plan.funding.receiverIdentityPublicKey,
      getLightningReceiveRequest: async () => ({
        id: requestId,
        status: input.status ?? "TRANSFER_COMPLETED",
        network: "MAINNET",
        invoice: {
          encodedInvoice: snapshot.plan.funding.paymentRequest,
          bitcoinNetwork: "MAINNET",
          paymentHash: snapshot.plan.funding.paymentHash,
          amount: { originalValue: 122, originalUnit: "SATOSHI" },
        },
        transfer: {
          sparkId: transferId,
          userRequestId: requestId,
          totalAmount: {
            originalValue: input.creditedSats ?? 121,
            originalUnit: "SATOSHI",
          },
        },
      }),
      getTransfer: async () => ({
        id: transferId,
        status: "TRANSFER_STATUS_COMPLETED",
        totalValue: input.creditedSats ?? 121,
        transferDirection: "INCOMING",
        receiverIdentityPublicKey:
          snapshot.plan.funding.receiverIdentityPublicKey,
        userRequest: { id: requestId },
      }),
      cleanup: async () => input.onCleanup?.(),
    }
  }

  async function prepareCreditTest(
    repository: DexieCheckoutSparkSettledRepository,
    input: { importState?: boolean } = {}
  ) {
    const snapshot = settledInitialSnapshot()
    const wrap = signedWrap(MERCHANT, CREATED_AT)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([wrap]),
      giftUnwrap: async () => snapshot.rumor,
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    if (input.importState !== false) {
      expect(
        (
          await importMerchantCheckoutSparkSettledRecovery(
            MERCHANT,
            selected,
            repository
          )
        ).status
      ).toBe("consumed")
    }
    return { snapshot, selected }
  }

  it("exposes an explicit local-only credit action with a claim warning and no payout", () => {
    const panelSource = readFileSync(
      new URL(
        "../apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx",
        import.meta.url
      ),
      "utf8"
    )
    expect(panelSource).toContain("reconcileMerchantCheckoutSparkSettledCredit")
    expect(panelSource).toContain("Check received payment")
    expect(panelSource).toMatch(/may\s+claim\s+pending\s+inbound\s+funds/)
    expect(panelSource).toContain("not create invoices or send payouts")
    expect(panelSource).toContain("CheckoutSparkRecoveryPanelForPrincipal")
    const adapterSource = readFileSync(
      new URL(
        "../apps/merchant/src/lib/checkout-spark-settled-recovery.ts",
        import.meta.url
      ),
      "utf8"
    )
    expect(adapterSource).toContain("...(input.outgoing")
    expect(adapterSource).toContain("wallet.payLightningInvoice(")
  })

  it("cleans up a captured wallet when initialization fails after a stream starts", async () => {
    const original = new Error("synthetic initializer failure")
    let cleanups = 0
    await expect(
      initializeMerchantSparkWalletWithCleanup(async (capture) => {
        capture({
          cleanup: async () => {
            cleanups += 1
          },
        })
        throw original
      })
    ).rejects.toBe(original)
    expect(cleanups).toBe(1)
  })

  it("reports both initializer and cleanup failures without suppressing either", async () => {
    const original = new Error("synthetic initializer failure")
    const cleanupFailure = new Error("synthetic cleanup failure")
    let thrown: unknown
    try {
      await initializeMerchantSparkWalletWithCleanup(async (capture) => {
        capture({
          cleanup: async () => {
            throw cleanupFailure
          },
        })
        throw original
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([
      original,
      cleanupFailure,
    ])
    expect((thrown as Error).message).not.toContain("synthetic")
  })

  it("records only the exact completed funding receive after takeover", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const snapshot = settledInitialSnapshot()
      const wrap = signedWrap(MERCHANT, CREATED_AT)
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [INBOX],
        readProtectedInbox: async () => protectedRead([wrap]),
        giftUnwrap: async () => snapshot.rumor,
      })
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      expect(
        (
          await importMerchantCheckoutSparkSettledRecovery(
            MERCHANT,
            selected,
            repository
          )
        ).status
      ).toBe("consumed")
      const requestId = snapshot.plan.funding.requestId
      const transferId = "0197f9a0-0000-7000-8000-000000000001"
      let cleanups = 0
      const recovered = await reconcileMerchantCheckoutSparkSettledCredit(
        MERCHANT,
        selected,
        {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => ({
            ensurePrivateReady: async () => {},
            getIdentityPublicKey: async () =>
              snapshot.plan.funding.receiverIdentityPublicKey,
            getLightningReceiveRequest: async () => ({
              id: requestId,
              status: "TRANSFER_COMPLETED",
              network: "MAINNET",
              invoice: {
                encodedInvoice: snapshot.plan.funding.paymentRequest,
                bitcoinNetwork: "MAINNET",
                paymentHash: snapshot.plan.funding.paymentHash,
                amount: { originalValue: 122, originalUnit: "SATOSHI" },
              },
              transfer: {
                sparkId: transferId,
                userRequestId: requestId,
                totalAmount: { originalValue: 121, originalUnit: "SATOSHI" },
              },
            }),
            getTransfer: async () => ({
              id: transferId,
              status: "TRANSFER_STATUS_COMPLETED",
              totalValue: 121,
              transferDirection: "INCOMING",
              receiverIdentityPublicKey:
                snapshot.plan.funding.receiverIdentityPublicKey,
              userRequest: { id: requestId },
            }),
            cleanup: async () => {
              cleanups += 1
            },
          }),
        }
      )
      expect(recovered.status).toBe("consumed")
      expect(recovered.creditStatus).toBe("recorded")
      expect(cleanups).toBe(1)
      const stored = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(
        stored.status === "active" && stored.state.credit?.creditedSats
      ).toBe(121)
      expect(stored.status === "active" && stored.revision).toBe(2)
      const verifiedCredit = await repository.loadMerchantSettlement(
        MERCHANT,
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(verifiedCredit).not.toBeNull()
      expect(projectCheckoutSparkMerchantSettlement(verifiedCredit!)).toEqual({
        creditVerified: true,
        merchantVerified: false,
        commerceVerified: false,
        feePending: true,
        recipientUnverified: false,
      })
      const again = await reconcileMerchantCheckoutSparkSettledCredit(
        MERCHANT,
        selected,
        {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => fakeCreditWallet(snapshot),
        }
      )
      expect(again.creditStatus).toBe("recorded")
      const afterRetry = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(afterRetry.status === "active" && afterRetry.revision).toBe(2)
      expect(JSON.stringify(recovered)).not.toContain(SETTLED_MNEMONIC)
    })
  })

  it("never opens Spark without complete fresh signed inbox evidence", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await prepareCreditTest(repository)
      __setCommerceTestOverrides({
        readProtectedInbox: async () =>
          protectedRead([signedWrap(MERCHANT, CREATED_AT)], {
            coverage: "partial",
          }),
      })
      let opened = 0
      const result = await reconcileMerchantCheckoutSparkSettledCredit(
        MERCHANT,
        selected,
        {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => {
            opened += 1
            throw new Error("wallet must not open")
          },
        }
      )
      expect(result.status).toBe("incomplete")
      expect(result.creditStatus).toBeNull()
      expect(opened).toBe(0)
    })
  })

  it("requires an imported exact checkout state and the pinned recovery key before opening Spark", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await prepareCreditTest(repository, {
        importState: false,
      })
      let opened = 0
      const openWallet = async () => {
        opened += 1
        throw new Error("wallet must not open")
      }
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet,
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(opened).toBe(0)
      expect(
        (
          await importMerchantCheckoutSparkSettledRecovery(
            MERCHANT,
            selected,
            repository
          )
        ).status
      ).toBe("consumed")
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () => `02${"a".repeat(64)}`,
          openWallet,
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(opened).toBe(0)
    })
  })

  it("does not open Spark before takeover or when a cross-tab lock is absent or busy", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await prepareCreditTest(repository)
      let opened = 0
      const openWallet = async () => {
        opened += 1
        throw new Error("wallet must not open")
      }
      const common = {
        repository,
        deriveIdentity: async () =>
          snapshot.plan.funding.receiverIdentityPublicKey,
        openWallet,
      }
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          ...common,
          now: () => snapshot.plan.takeoverAt - 1,
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          ...common,
          now: () => snapshot.plan.takeoverAt,
          lockManager: null,
          requireCrossTabLock: true,
        })
      ).rejects.toThrow("cannot safely coordinate")
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          ...common,
          now: () => snapshot.plan.takeoverAt,
          lockManager: {
            request: async (_name, _options, callback) => callback(null),
          },
          requireCrossTabLock: true,
        })
      ).rejects.toThrow("already active")
      expect(opened).toBe(0)
    })
  })

  it("cancels before wallet open when the session ends during key derivation", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await prepareCreditTest(repository)
      let active = true
      let opened = 0
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          repository,
          now: () => snapshot.plan.takeoverAt,
          assertActive: () => {
            if (!active) throw new Error("synthetic session ended")
          },
          deriveIdentity: async () => {
            active = false
            return snapshot.plan.funding.receiverIdentityPublicKey
          },
          openWallet: async () => {
            opened += 1
            throw new Error("wallet must not open")
          },
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(opened).toBe(0)
      const stored = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(stored.status === "active" && stored.revision).toBe(1)
    })
  })

  it("cancels after a provider await without persisting and cleans up the wallet", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await prepareCreditTest(repository)
      let active = true
      let cleanups = 0
      const wallet = fakeCreditWallet(snapshot, {
        onCleanup: () => {
          cleanups += 1
        },
      })
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          repository,
          now: () => snapshot.plan.takeoverAt,
          assertActive: () => {
            if (!active) throw new Error("synthetic session ended")
          },
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => ({
            ...wallet,
            getTransfer: async (id) => {
              const transfer = await wallet.getTransfer(id)
              active = false
              return transfer
            },
          }),
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(cleanups).toBe(1)
      const stored = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(stored.status === "active" && stored.revision).toBe(1)
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          snapshot.plan.checkoutId,
          snapshot.plan.planDigest
        )
      ).toBeNull()
    })
  })

  it("requires the fresh signed recovery sender to match the authenticated order witness", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await prepareCreditTest(repository)
      let opened = 0
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          repository,
          now: () => snapshot.plan.takeoverAt,
          expectedOrderWitness: {
            schemaVersion: 1,
            merchantPubkey: MERCHANT,
            buyerPubkey: OTHER,
            orderId: snapshot.plan.orderId,
            rumorId: "a".repeat(64),
            contentHash: "b".repeat(64),
            checkoutId: snapshot.plan.checkoutId,
            planDigest: snapshot.plan.planDigest,
          },
          openWallet: async () => {
            opened += 1
            throw new Error("wallet must not open")
          },
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(opened).toBe(0)
    })
  })

  it("keeps an incomplete receive pending and rejects a different receiver without saving", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await prepareCreditTest(repository)
      let cleanups = 0
      const options = {
        repository,
        now: () => snapshot.plan.takeoverAt,
        deriveIdentity: async () =>
          snapshot.plan.funding.receiverIdentityPublicKey,
        openWallet: async () =>
          fakeCreditWallet(snapshot, {
            status: "CREATED",
            onCleanup: () => {
              cleanups += 1
            },
          }),
      }
      const pending = await reconcileMerchantCheckoutSparkSettledCredit(
        MERCHANT,
        selected,
        options
      )
      expect(pending.status).toBe("consumed")
      expect(pending.creditStatus).toBe("pending")
      const wrongReceiver = fakeCreditWallet(snapshot, {
        onCleanup: () => {
          cleanups += 1
        },
      })
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          ...options,
          openWallet: async () => ({
            ...wrongReceiver,
            getTransfer: async () => ({
              ...(await wrongReceiver.getTransfer()),
              receiverIdentityPublicKey: `03${"a".repeat(64)}`,
            }),
          }),
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      const stored = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(stored.status === "active" && stored.revision).toBe(1)
      expect(cleanups).toBe(2)
    })
  })

  it("cleans up after private-mode failure and after a credit CAS conflict", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await prepareCreditTest(repository)
      let cleanups = 0
      let providerReads = 0
      const common = {
        now: () => snapshot.plan.takeoverAt,
        deriveIdentity: async () =>
          snapshot.plan.funding.receiverIdentityPublicKey,
      }
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          ...common,
          repository,
          openWallet: async () => ({
            ...fakeCreditWallet(snapshot),
            ensurePrivateReady: async () => {
              throw new Error("synthetic private mode failure")
            },
            getIdentityPublicKey: async () => {
              providerReads += 1
              return snapshot.plan.funding.receiverIdentityPublicKey
            },
            cleanup: async () => {
              cleanups += 1
            },
          }),
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(providerReads).toBe(0)
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          ...common,
          repository: {
            load: (checkoutId, digest) => repository.load(checkoutId, digest),
            loadMerchantOrderWitness:
              repository.loadMerchantOrderWitness.bind(repository),
            recordMerchantCredit:
              repository.recordMerchantCredit.bind(repository),
            recordMerchantPayout:
              repository.recordMerchantPayout.bind(repository),
            save: async () => {
              throw new Error("synthetic CAS conflict")
            },
          },
          openWallet: async () =>
            fakeCreditWallet(snapshot, {
              onCleanup: () => {
                cleanups += 1
              },
            }),
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      const stored = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(stored.status === "active" && stored.revision).toBe(1)
      expect(cleanups).toBe(2)
    })
  })

  it("holds one plan lock through cleanup and rejects a competing recovery", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await prepareCreditTest(repository)
      let release: (() => void) | undefined
      let signalOpened: (() => void) | undefined
      const opened = new Promise<void>((resolve) => {
        signalOpened = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let active = false
      let opens = 0
      const lockManager = {
        async request<T>(
          name: string,
          options: { mode: "exclusive"; ifAvailable: true },
          callback: (lock: { name: string } | null) => T | Promise<T>
        ): Promise<T> {
          expect(options).toEqual({ mode: "exclusive", ifAvailable: true })
          if (active) return callback(null)
          active = true
          try {
            return await callback({ name })
          } finally {
            active = false
          }
        },
      }
      const options = {
        repository,
        lockManager,
        requireCrossTabLock: true,
        now: () => snapshot.plan.takeoverAt,
        deriveIdentity: async () =>
          snapshot.plan.funding.receiverIdentityPublicKey,
        openWallet: async () => {
          opens += 1
          signalOpened?.()
          return {
            ...fakeCreditWallet(snapshot),
            ensurePrivateReady: async () => {
              await held
            },
          }
        },
      }
      const first = reconcileMerchantCheckoutSparkSettledCredit(
        MERCHANT,
        selected,
        options
      )
      await opened
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, options)
      ).rejects.toThrow("already active")
      expect(opens).toBe(1)
      release?.()
      expect((await first).creditStatus).toBe("recorded")
      expect(active).toBe(false)
    })
  })

  it("refuses a stale local import when fresh signed progress has already credited funding", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const snapshot = settledInitialSnapshot()
      const initialPayload = parseCheckoutSparkRecoveryRumor(snapshot.rumor)
      if (initialPayload.schemaVersion !== 2) {
        throw new Error("Invalid settled test fixture")
      }
      const signedCredit = recordCheckoutSparkSettledCredit(snapshot.state, {
        requestId: snapshot.plan.funding.requestId,
        paymentHash: snapshot.plan.funding.paymentHash,
        transferId: "signed-credit-before-local",
        receiverIdentityPublicKey:
          snapshot.plan.funding.receiverIdentityPublicKey,
        grossSats: 122,
        creditedSats: 121,
        observedAt: CREATED_AT + 2_000,
      })
      const progress = buildCheckoutSparkRecoveryRumor(
        createCheckoutSparkSettledRecoveryProgressPayload({
          initialHandoffId: initialPayload.handoffId,
          state: signedCredit,
          senderPubkey: BUYER,
          preparedAt: CREATED_AT + 3_000,
        })
      )
      const initialWrap = signedWrap(MERCHANT, CREATED_AT)
      const progressWrap = signedWrap(MERCHANT, CREATED_AT + 4_000)
      const wraps = [initialWrap, progressWrap]
      const rumors = new Map([
        [initialWrap.id, snapshot.rumor],
        [progressWrap.id, progress],
      ])
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [INBOX],
        readProtectedInbox: async (options) =>
          protectedRead(
            options.eventId
              ? wraps.filter((wrap) => wrap.id === options.eventId)
              : wraps
          ),
        giftUnwrap: async (event) => rumors.get(event.id) ?? null,
      })
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      expect(selected.schemaVersion).toBe(3)
      await repository.importRecoveryState(snapshot.state, () => {})
      let opens = 0
      await expect(
        reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => {
            opens += 1
            throw new Error("wallet must not open")
          },
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(opens).toBe(0)
    })
  })
})

const registerPayoutHistoryTest = it

describe("Merchant checkout Spark payout history inspection", () => {
  // Signed recovery replay, receipt verification and repeated recovery cross
  // several crypto/storage boundaries; allow bounded Windows harness time.
  const it = Object.assign(
    (name: string, run: () => void | Promise<void>) =>
      registerPayoutHistoryTest(name, run, 15_000),
    {
      each:
        <T>(cases: readonly T[]) =>
        (name: string, run: (value: T) => void | Promise<void>) =>
          registerPayoutHistoryTest.each([...cases])(name, run, 15_000),
    }
  )
  async function preparedHistoryFixture(
    repository: DexieCheckoutSparkSettledRepository,
    input: { merchantPrepared?: boolean; localOrigin?: boolean } = {}
  ) {
    const snapshot = settledInitialSnapshot()
    const wrap = signedWrap(MERCHANT, CREATED_AT)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([wrap]),
      giftUnwrap: async () => snapshot.rumor,
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    await importMerchantCheckoutSparkSettledRecovery(
      MERCHANT,
      selected,
      repository
    )
    const credited = recordCheckoutSparkSettledCredit(snapshot.state, {
      requestId: snapshot.plan.funding.requestId,
      paymentHash: snapshot.plan.funding.paymentHash,
      transferId: "exact-merchant-history-credit",
      receiverIdentityPublicKey:
        snapshot.plan.funding.receiverIdentityPublicKey,
      grossSats: 122,
      creditedSats: 121,
      observedAt: CREATED_AT + 2_000,
    })
    const leg = credited.legs[0]!
    const amountSats = leg.allocationSats! - 1
    const preimage = "07".repeat(32)
    const paymentHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          Uint8Array.from({ length: 32 }, () => 7)
        )
      ),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("")
    const invoice = makeSignedBolt11Fixture({
      hrp: `lnbc${amountSats * 10}n`,
      createdAt: CREATED_AT / 1_000,
      fields: [
        bolt11PaymentHashField(
          Uint8Array.from(paymentHash.match(/.{2}/g)!, (byte) =>
            Number.parseInt(byte, 16)
          )
        ),
        bolt11PaymentSecretField(),
        bolt11PlainDescriptionField(),
      ],
    })
    const intent = {
      legId: leg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(
        snapshot.plan,
        leg.legId
      ),
      paymentRequest: invoice,
      paymentHash,
      invoiceAmountSats: amountSats,
      maxFeeSats: 1,
      preparedAt: input.merchantPrepared
        ? snapshot.plan.takeoverAt
        : CREATED_AT + 3_000,
    }
    const prepared = prepareCheckoutSparkSettledLeg(credited, intent)
    const imported = await repository.importMerchantOrderRecovery(
      input.localOrigin === false ? prepared : credited,
      syntheticMerchantOrderWitness({ snapshot }),
      () => {}
    )
    if (input.localOrigin !== false) {
      if (imported.status !== "active") throw new Error("Fixture missing")
      const resolved = await resolveCheckoutSparkLnurlInvoice(
        {
          lud16: snapshot.plan.recipients[0]!.destination.value,
          amountSats,
          network: snapshot.plan.network,
          nowSeconds: Math.floor(intent.preparedAt / 1_000),
          shouldContinue: () => true,
        },
        {
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
          fetchInvoice: async () => ({ invoice }),
        }
      )
      if (!resolved.origin) throw new Error("Expected local invoice origin")
      await repository.savePreparedWithInvoiceOrigin(
        prepared,
        imported.revision,
        { legId: leg.legId, origin: resolved.origin },
        () => {}
      )
    }
    const nativeRequest = {
      typename: "LightningSendRequest",
      id: "exact-send-request",
      status: "LIGHTNING_PAYMENT_SUCCEEDED",
      fee: { originalValue: 1, originalUnit: "SATOSHI" },
      encodedInvoice: invoice,
      idempotencyKey: intent.transferId,
      paymentPreimage: preimage,
    }
    return { snapshot, selected, leg, intent, nativeRequest }
  }

  async function signedPreparedHistoryFixture(
    repository: DexieCheckoutSparkSettledRepository,
    input: { localOrigin?: boolean } = {}
  ) {
    const fixture = await preparedHistoryFixture(repository, input)
    const imported = await repository.load(
      fixture.snapshot.plan.checkoutId,
      fixture.snapshot.plan.planDigest
    )
    if (imported.status !== "active") throw new Error("Fixture is not active.")
    const initial = parseCheckoutSparkRecoveryRumor(fixture.snapshot.rumor)
    if (initial.schemaVersion !== 2) throw new Error("Fixture is not settled.")
    const progress = buildCheckoutSparkRecoveryRumor(
      createCheckoutSparkSettledRecoveryProgressPayload({
        initialHandoffId: initial.handoffId,
        state: imported.state,
        senderPubkey: BUYER,
        preparedAt: CREATED_AT + 4_000,
      })
    )
    const initialWrap = signedWrap(MERCHANT, CREATED_AT)
    const progressWrap = signedWrap(MERCHANT, CREATED_AT + 5_000)
    const wraps = [initialWrap, progressWrap]
    const rumors = new Map([
      [initialWrap.id, fixture.snapshot.rumor],
      [progressWrap.id, progress],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          options.eventId
            ? wraps.filter((wrap) => wrap.id === options.eventId)
            : wraps
        ),
      giftUnwrap: async (event) => rumors.get(event.id) ?? null,
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    expect(selected.schemaVersion).toBe(3)
    expect(selected.wrapId).toBe(progressWrap.id)
    return { ...fixture, selected, signedState: imported.state }
  }

  function continuationWallet(
    fixture: Awaited<ReturnType<typeof preparedHistoryFixture>>,
    provider: { sent: boolean; sends: number; cleanups: number },
    input: {
      receiveTransferId?: string
      history?: "normal" | "pending" | "unavailable"
      onHistoryRead?: () => void
      onSend?: (request: {
        paymentRequest: string
        maxFeeSats: number
        transferId: string
      }) => Promise<void>
    } = {}
  ) {
    const receiveTransferId =
      input.receiveTransferId ?? "exact-merchant-history-credit"
    return {
      ensurePrivateReady: async () => {},
      getIdentityPublicKey: async () =>
        fixture.snapshot.plan.funding.receiverIdentityPublicKey,
      getLightningReceiveRequest: async () => ({
        id: fixture.snapshot.plan.funding.requestId,
        status: "TRANSFER_COMPLETED",
        network: "MAINNET",
        invoice: {
          encodedInvoice: fixture.snapshot.plan.funding.paymentRequest,
          bitcoinNetwork: "MAINNET",
          paymentHash: fixture.snapshot.plan.funding.paymentHash,
          amount: { originalValue: 122, originalUnit: "SATOSHI" },
        },
        transfer: {
          sparkId: receiveTransferId,
          userRequestId: fixture.snapshot.plan.funding.requestId,
          totalAmount: { originalValue: 121, originalUnit: "SATOSHI" },
        },
      }),
      getTransfer: async () => ({
        id: receiveTransferId,
        status: "TRANSFER_STATUS_COMPLETED",
        totalValue: 121,
        transferDirection: "INCOMING",
        receiverIdentityPublicKey:
          fixture.snapshot.plan.funding.receiverIdentityPublicKey,
        userRequest: { id: fixture.snapshot.plan.funding.requestId },
      }),
      getTransferFromSsp: async (id: string) => {
        expect(id).toBe(fixture.intent.transferId)
        input.onHistoryRead?.()
        if (input.history === "unavailable") throw new Error("read unavailable")
        if (!provider.sent && input.history !== "pending") return undefined
        return {
          sparkId: fixture.intent.transferId,
          totalAmount: {
            originalValue: fixture.leg.allocationSats!,
            originalUnit: "SATOSHI",
          },
          userRequest: fixture.nativeRequest,
        }
      },
      getLightningSendRequest: async (id: string) => {
        expect(id).toBe(fixture.nativeRequest.id)
        return input.history === "pending"
          ? {
              ...fixture.nativeRequest,
              status: "LIGHTNING_PAYMENT_PENDING",
              paymentPreimage: null,
            }
          : fixture.nativeRequest
      },
      outgoing: {
        getAvailableSats: async () => 121n,
        estimateFee: async ({ paymentRequest }: { paymentRequest: string }) => {
          expect(paymentRequest).toBe(fixture.intent.paymentRequest)
          return 1
        },
        sendFrozen: async (request: {
          paymentRequest: string
          maxFeeSats: number
          transferId: string
        }) => {
          expect(request).toEqual({
            paymentRequest: fixture.intent.paymentRequest,
            maxFeeSats: fixture.intent.maxFeeSats,
            transferId: fixture.intent.transferId,
          })
          provider.sends += 1
          if (input.onSend) await input.onSend(request)
          else provider.sent = true
          return undefined
        },
      },
      cleanup: async () => {
        provider.cleanups += 1
      },
    }
  }

  const continuationDependencies = (
    fixture: Awaited<ReturnType<typeof preparedHistoryFixture>>,
    provider: { sent: boolean; sends: number; cleanups: number },
    repository: DexieCheckoutSparkSettledRepository,
    input: Parameters<typeof continuationWallet>[2] = {}
  ) => ({
    repository,
    now: () => fixture.snapshot.plan.takeoverAt,
    deriveIdentity: async () =>
      fixture.snapshot.plan.funding.receiverIdentityPublicKey,
    openWallet: async (request: { outgoing?: true }) => {
      expect(request.outgoing).toBe(true)
      return continuationWallet(fixture, provider, input)
    },
  })

  async function merchantContinuationHarness(
    database: ConduitDB,
    repository: DexieCheckoutSparkSettledRepository,
    input: { localOrigin?: boolean } = {}
  ) {
    const fixture = await preparedHistoryFixture(repository, {
      merchantPrepared: true,
      ...input,
    })
    const saved = await repository.load(
      fixture.snapshot.plan.checkoutId,
      fixture.snapshot.plan.planDigest
    )
    if (saved.status !== "active") throw new Error("Fixture missing")
    const initial = parseCheckoutSparkRecoveryRumor(fixture.snapshot.rumor)
    if (initial.schemaVersion !== 2)
      throw new Error("Expected settled recovery")
    const progress = createCheckoutSparkMerchantProgress({
      initialHandoffId: initial.handoffId,
      state: saved.state,
    })
    const initialWrap = signedWrap(MERCHANT, CREATED_AT)
    const progressWrap = signedWrap(MERCHANT, CREATED_AT + 121_000)
    const wraps = [initialWrap, progressWrap]
    const rumors = new Map([
      [initialWrap.id, fixture.snapshot.rumor],
      [progressWrap.id, buildCheckoutSparkMerchantProgressRumor(progress)],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          options.eventId
            ? wraps.filter((wrap) => wrap.id === options.eventId)
            : wraps
        ),
      giftUnwrap: async (event) => rumors.get(event.id) ?? null,
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    expect(selected.merchantProgress?.snapshotId).toBe(progress.snapshotId)
    const review = await reviewMerchantCheckoutSparkSettledPayout(
      MERCHANT,
      selected,
      repository
    )
    if (!review) throw new Error("Expected exact saved review")
    const provider = { sent: false, sends: 0, cleanups: 0 }
    const progressStore = new DexieMerchantCheckoutSparkProgressRepository(
      database
    )
    const published: SignedPublicNostrEvent[] = []
    const snapshots: CheckoutSparkMerchantProgressPayload[] = []
    const progressInbox = "wss://merchant-continuation.inbox.relay.dev"
    const dependencies: MerchantCheckoutSparkContinuationDependencies = {
      ...continuationDependencies(fixture, provider, repository),
      signer: plainTestSigner({
        user: async () => new NDKUser({ pubkey: MERCHANT }),
      } as NDKSigner as never),
      progressStore,
      progressTransport: {
        deliveryStore: new CommerceInboxStore(
          getProtectedReadAuthorization(MERCHANT)!,
          database
        ),
        recipientInboxRelays: [progressInbox],
        accountNetworkLocalStateRepository: { get: async () => undefined },
        giftWrapFn: (async (rumor, recipient) => {
          expect(recipient.pubkey).toBe(MERCHANT)
          const payload = parseCheckoutSparkMerchantProgressRumor(rumor)
          const current = await repository.load(
            fixture.snapshot.plan.checkoutId,
            fixture.snapshot.plan.planDigest
          )
          if (current.status !== "active") throw new Error("Fixture missing")
          expect(payload.state).toEqual(current.state)
          expect(payload.initialHandoffId).toBe(initial.handoffId)
          expect(payload.state.legs[0]!.intent).toEqual(fixture.intent)
          expect(rumor.content).not.toContain(initial.wallet.mnemonic)
          snapshots.push(payload)
          return signedWrap(
            MERCHANT,
            CREATED_AT + 130_000 + snapshots.length * 1_000
          )
        }) as NonNullable<
          MerchantCheckoutSparkContinuationDependencies["progressTransport"]
        >["giftWrapFn"],
        publishFn: (async (event, options) => {
          const entries = await progressStore.list(
            MERCHANT,
            fixture.snapshot.plan.checkoutId,
            fixture.snapshot.plan.planDigest
          )
          expect(
            entries.some(
              (entry) => entry.record.signedRecipientWrap.id === event.id
            )
          ).toBe(true)
          expect(options.exclusiveRelayUrls).toEqual([progressInbox])
          expect(options.appRelayUrls).toEqual([])
          expect(options.personalRelayUrls).toEqual([])
          published.push(event as SignedPublicNostrEvent)
          return {
            attemptedRelayUrls: [progressInbox],
            successfulRelayUrls: [progressInbox],
            failedRelayUrls: [],
            relayFailureMessages: {},
          }
        }) as NonNullable<
          MerchantCheckoutSparkContinuationDependencies["progressTransport"]
        >["publishFn"],
      },
    }
    return {
      ...fixture,
      initial,
      progress,
      selected,
      review,
      provider,
      progressStore,
      dependencies,
      published,
      snapshots,
      run: () =>
        continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          selected,
          review,
          dependencies
        ),
    }
  }

  it("continues a restored Merchant intent through the same exact engine and never resends after paid", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const test = await merchantContinuationHarness(database, repository)
      // A new repository instance reads the durable local origin witness.
      test.dependencies.repository = new DexieCheckoutSparkSettledRepository(
        database
      )
      const first = await test.run()
      expect(first.status).toBe("consumed")
      expect(first.payout).toMatchObject({
        outcome: "paid",
        sendAttempted: true,
      })
      expect(test.provider.sends).toBe(1)
      expect(
        test.snapshots.map((snapshot) => snapshot.state.legs[0]!.status)
      ).toContain("submitted")
      expect(
        test.snapshots.map((snapshot) => snapshot.state.legs[0]!.status)
      ).toContain("paid")
      const entries = await test.progressStore.list(
        MERCHANT,
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(entries.every((entry) => entry.relayAccepted)).toBe(true)
      expect(JSON.stringify(entries)).not.toContain(
        test.initial.wallet.mnemonic
      )
      expect(JSON.stringify(entries)).not.toContain('"paymentRequest"')
      const facts = await repository.loadMerchantSettlement(
        MERCHANT,
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(facts?.paidLegs).toHaveLength(1)
      expect(facts?.paidLegs[0]?.transferId).toBe(test.intent.transferId)
      expect(facts?.paidLegs[0]?.recipientVerified).toBe(true)
      const second = await test.run()
      expect(second.payout?.outcome).toBe("already_paid")
      expect(test.provider.sends).toBe(1)
      expect(test.provider.cleanups).toBe(2)
    })
  })

  it("keeps an imported Merchant-wrapped intent paused without local invoice origin", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const test = await merchantContinuationHarness(database, repository, {
        localOrigin: false,
      })
      const result = await test.run()
      expect(result.payout).toEqual({
        outcome: "wait",
        reason: "recipient_unverified",
        sendAttempted: false,
      })
      expect(test.provider.sends).toBe(0)
      const saved = await repository.load(
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(saved.status === "active" && saved.state.legs[0]).toMatchObject({
        status: "prepared",
        intent: test.intent,
      })
    })
  })

  it("retains imported exact provider-paid terminal state without claiming recipient verification", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const test = await merchantContinuationHarness(database, repository, {
        localOrigin: false,
      })
      test.provider.sent = true
      expect((await test.run()).payout?.outcome).toBe("already_paid")
      const facts = await repository.loadMerchantSettlement(
        MERCHANT,
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(facts?.paidLegs).toHaveLength(1)
      expect(facts?.paidLegs[0]?.recipientVerified).not.toBe(true)
      expect(projectCheckoutSparkMerchantSettlement(facts!)).toMatchObject({
        creditVerified: true,
        merchantVerified: false,
        commerceVerified: false,
        recipientUnverified: true,
      })
      const saved = await repository.load(
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(saved.status === "active" && saved.state.legs[0]).toMatchObject({
        status: "paid",
        intent: test.intent,
      })
      expect((await test.run()).payout?.outcome).toBe("already_paid")
      expect(test.provider.sends).toBe(0)
    })
  })

  it("also keeps a buyer-only imported intent paused without local invoice origin", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await signedPreparedHistoryFixture(repository, {
        localOrigin: false,
      })
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      if (!review) throw new Error("Expected saved invoice")
      const provider = { sent: false, sends: 0, cleanups: 0 }
      const result = await continueMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        review,
        continuationDependencies(fixture, provider, repository)
      )
      expect(result.payout).toEqual({
        outcome: "wait",
        reason: "recipient_unverified",
        sendAttempted: false,
      })
      expect(provider.sends).toBe(0)
    })
  })

  it("rechecks the current session after recipient evidence storage is read", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const test = await merchantContinuationHarness(database, repository)
      let current = true
      test.dependencies.shouldContinue = () => current
      const original = repository.assertInvoiceRecipient.bind(repository)
      repository.assertInvoiceRecipient = async (...args) => {
        await original(...args)
        current = false
      }
      await expect(test.run()).rejects.toThrow()
      expect(test.provider.sends).toBe(0)
      expect(test.provider.cleanups).toBe(1)
    })
  })

  it("requires the exact saved buyer order witness before Merchant-sidecar continuation opens Spark", async () => {
    for (const witness of [
      null,
      { buyerPubkey: OTHER },
      { orderId: "different-order" },
    ]) {
      await withRecoveryDatabase(async (database, repository) => {
        const test = await merchantContinuationHarness(database, repository)
        let opens = 0
        test.dependencies.openWallet = async () => {
          opens += 1
          throw new Error("Must not open")
        }
        test.dependencies.repository = {
          load: repository.load.bind(repository),
          save: repository.save.bind(repository),
          assertLocalInvoiceOrigin:
            repository.assertLocalInvoiceOrigin.bind(repository),
          recordMerchantCredit:
            repository.recordMerchantCredit.bind(repository),
          recordMerchantPayout:
            repository.recordMerchantPayout.bind(repository),
          loadMerchantOrderWitness: async () =>
            witness === null
              ? null
              : { ...syntheticMerchantOrderWitness(test), ...witness },
        }
        await expect(test.run()).rejects.toThrow()
        expect(opens).toBe(0)
        expect(test.provider.sends).toBe(0)
        expect(test.published).toEqual([])
      })
    }
  })

  it("pins the selected sidecar and exact reviewed parameters before awaiting private recovery", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const test = await merchantContinuationHarness(database, repository)
      const callerIntent = { ...test.review.intent }
      test.review.intent = callerIntent
      const reviewed = structuredClone(test.review)
      const selected = structuredClone(test.selected)
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let consumed: MerchantCheckoutSparkRecoveryCandidate | null = null
      test.dependencies.consumeRecovery = async (
        principal,
        candidate,
        adapter
      ) => {
        entered()
        await held
        consumed = structuredClone(candidate)
        return withMerchantCheckoutSparkRecovery(principal, candidate, adapter)
      }
      const pending = test.run()
      await started
      test.selected.checkoutId = "substituted-checkout"
      test.selected.planDigest = "f".repeat(64)
      test.selected.merchantProgress!.wrapId = "e".repeat(64)
      test.selected.merchantProgress!.snapshotId = "d".repeat(64)
      test.review.legId = test.snapshot.plan.recipients[1]!.legId
      test.review.destination = "substituted@example.test"
      callerIntent.paymentRequest = "not-the-reviewed-invoice"
      callerIntent.maxFeeSats = 100
      release()
      const result = await pending
      expect(result.payout?.outcome).toBe("paid")
      expect(consumed).toEqual(selected)
      expect(test.provider.sends).toBe(1)
      expect(
        test.snapshots.every(
          (snapshot) =>
            JSON.stringify(snapshot.state.legs[0]!.intent) ===
            JSON.stringify(reviewed.intent)
        )
      ).toBe(true)
    })
  })

  it("requires the matching Merchant publication signer before sidecar continuation opens Spark", async () => {
    for (const signer of [
      null,
      plainTestSigner({
        user: async () => new NDKUser({ pubkey: OTHER }),
      } as NDKSigner as never),
    ]) {
      await withRecoveryDatabase(async (database, repository) => {
        const test = await merchantContinuationHarness(database, repository)
        test.dependencies.signer = signer
        let opens = 0
        test.dependencies.openWallet = async () => {
          opens += 1
          throw new Error("Must not open")
        }
        await expect(test.run()).rejects.toThrow()
        expect(opens).toBe(0)
        expect(test.provider.sends).toBe(0)
        expect(test.published).toEqual([])
      })
    }
  })

  it("never sends when the submitted Merchant snapshot loses its relay ACK and never clears possible-send on retry", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const test = await merchantContinuationHarness(database, repository)
      const transport = test.dependencies.progressTransport!
      const publish = transport.publishFn!
      transport.publishFn = async (...args) => {
        const result = await publish(...args)
        const current = await repository.load(
          test.snapshot.plan.checkoutId,
          test.snapshot.plan.planDigest
        )
        if (
          current.status === "active" &&
          current.state.legs[0]!.status === "submitted"
        )
          throw new Error("Synthetic submitted relay ACK lost")
        return result
      }
      const first = await test.run()
      expect(first.payout).toMatchObject({
        outcome: "wait",
        reason: "recovery_handoff_unavailable",
        sendAttempted: false,
      })
      expect(test.provider.sends).toBe(0)
      const saved = await repository.load(
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(saved.status === "active" && saved.state.legs[0]!.status).toBe(
        "submitted"
      )
      const entries = await test.progressStore.list(
        MERCHANT,
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(entries.some((entry) => !entry.relayAccepted)).toBe(true)
      const pendingWrap = entries.find((entry) => !entry.relayAccepted)!.record
        .signedRecipientWrap
      const wrappedCount = test.snapshots.length
      transport.publishFn = publish
      const second = await test.run()
      expect(second.payout?.sendAttempted).toBe(false)
      expect(test.provider.sends).toBe(0)
      expect(test.published.at(-1)).toEqual(pendingWrap)
      expect(test.snapshots).toHaveLength(wrappedCount)
      expect(
        (
          await test.progressStore.list(
            MERCHANT,
            test.snapshot.plan.checkoutId,
            test.snapshot.plan.planDigest
          )
        ).every((entry) => entry.relayAccepted)
      ).toBe(true)
      const after = await repository.load(
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(after.status === "active" && after.state.legs[0]!.status).toBe(
        "submitted"
      )
    })
  })

  it("retains verified paid state when publishing the later Merchant paid snapshot loses its ACK", async () => {
    await withRecoveryDatabase(async (database, repository) => {
      const test = await merchantContinuationHarness(database, repository)
      const transport = test.dependencies.progressTransport!
      const publish = transport.publishFn!
      transport.publishFn = async (...args) => {
        const result = await publish(...args)
        const current = await repository.load(
          test.snapshot.plan.checkoutId,
          test.snapshot.plan.planDigest
        )
        if (
          current.status === "active" &&
          current.state.legs[0]!.status === "paid"
        )
          throw new Error("Synthetic paid relay ACK lost")
        return result
      }
      const first = await test.run()
      expect(first.payout).toMatchObject({
        outcome: "paid",
        sendAttempted: true,
      })
      expect(test.provider.sends).toBe(1)
      const saved = await repository.load(
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(saved.status === "active" && saved.state.legs[0]!.status).toBe(
        "paid"
      )
      const facts = await repository.loadMerchantSettlement(
        MERCHANT,
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(facts?.paidLegs).toHaveLength(1)
      const pending = await test.progressStore.list(
        MERCHANT,
        test.snapshot.plan.checkoutId,
        test.snapshot.plan.planDigest
      )
      expect(pending.some((entry) => !entry.relayAccepted)).toBe(true)
      const pendingWrap = pending.find((entry) => !entry.relayAccepted)!.record
        .signedRecipientWrap
      const wrappedCount = test.snapshots.length
      transport.publishFn = publish
      expect((await test.run()).payout?.outcome).toBe("already_paid")
      expect(test.provider.sends).toBe(1)
      expect(test.published.at(-1)).toEqual(pendingWrap)
      expect(test.snapshots).toHaveLength(wrappedCount)
      expect(
        (
          await test.progressStore.list(
            MERCHANT,
            test.snapshot.plan.checkoutId,
            test.snapshot.plan.planDigest
          )
        ).every((entry) => entry.relayAccepted)
      ).toBe(true)
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          test.snapshot.plan.checkoutId,
          test.snapshot.plan.planDigest
        )
      ).toEqual(facts)
    })
  })

  it.each(["submitted", "paid"] as const)(
    "repairs %s exact-wrap delivery after invoice expiry without reopening Spark",
    async (lostStatus) => {
      await withRecoveryDatabase(async (database, repository) => {
        const test = await merchantContinuationHarness(database, repository)
        const transport = test.dependencies.progressTransport!
        const publish = transport.publishFn!
        transport.publishFn = async (...args) => {
          const result = await publish(...args)
          const current = await repository.load(
            test.snapshot.plan.checkoutId,
            test.snapshot.plan.planDigest
          )
          if (
            current.status === "active" &&
            current.state.legs[0]!.status === lostStatus
          )
            throw new Error("Synthetic lost ACK")
          return result
        }
        await test.run()
        const entries = await test.progressStore.list(
          MERCHANT,
          test.snapshot.plan.checkoutId,
          test.snapshot.plan.planDigest
        )
        const pendingWrap = entries.find((entry) => !entry.relayAccepted)!
          .record.signedRecipientWrap
        const saved = await repository.load(
          test.snapshot.plan.checkoutId,
          test.snapshot.plan.planDigest
        )
        expect(saved.status === "active" && saved.state.legs[0]!.status).toBe(
          lostStatus
        )
        const wrappedCount = test.snapshots.length
        const sendCount = test.provider.sends
        test.dependencies.now = () => test.snapshot.plan.takeoverAt + 3_601_000
        test.dependencies.openWallet = async () => {
          throw new Error("Expired invoice must not open Spark")
        }
        transport.publishFn = publish
        const result = await test.run()
        expect(result.payout).toMatchObject({
          outcome: "wait",
          reason: "invoice_window_insufficient",
          sendAttempted: false,
        })
        expect(test.published.at(-1)).toEqual(pendingWrap)
        expect(test.snapshots).toHaveLength(wrappedCount)
        expect(test.provider.sends).toBe(sendCount)
        expect(test.provider.cleanups).toBe(1)
        expect(
          (
            await test.progressStore.list(
              MERCHANT,
              test.snapshot.plan.checkoutId,
              test.snapshot.plan.planDigest
            )
          ).every((entry) => entry.relayAccepted)
        ).toBe(true)
        expect(
          await repository.load(
            test.snapshot.plan.checkoutId,
            test.snapshot.plan.planDigest
          )
        ).toEqual(saved)
      })
    }
  )

  it.each([false, true])(
    "retains a provider-reconciled paid snapshot without sending and preserves payment (lost ACK=%s)",
    async (loseAck) => {
      await withRecoveryDatabase(async (database, repository) => {
        const test = await merchantContinuationHarness(database, repository)
        test.provider.sent = true
        const transport = test.dependencies.progressTransport!
        const publish = transport.publishFn!
        if (loseAck)
          transport.publishFn = async (...args) => {
            await publish(...args)
            throw new Error("Synthetic reconciled paid ACK lost")
          }
        const result = await test.run()
        expect(result.payout).toMatchObject({
          outcome: loseAck ? "wait" : "already_paid",
          ...(loseAck ? { reason: "recovery_handoff_unavailable" } : {}),
          sendAttempted: false,
        })
        expect(test.provider.sends).toBe(0)
        expect(
          test.snapshots.map((entry) => entry.state.legs[0]!.status)
        ).toEqual(["paid"])
        const saved = await repository.load(
          test.snapshot.plan.checkoutId,
          test.snapshot.plan.planDigest
        )
        expect(saved.status === "active" && saved.state.legs[0]!.status).toBe(
          "paid"
        )
        const facts = await repository.loadMerchantSettlement(
          MERCHANT,
          test.snapshot.plan.checkoutId,
          test.snapshot.plan.planDigest
        )
        expect(facts?.paidLegs).toHaveLength(1)
        const entries = await test.progressStore.list(
          MERCHANT,
          test.snapshot.plan.checkoutId,
          test.snapshot.plan.planDigest
        )
        expect(entries).toHaveLength(1)
        expect(entries[0]!.relayAccepted).toBe(!loseAck)
        const originalWrap = entries[0]!.record.signedRecipientWrap
        transport.publishFn = publish
        expect((await test.run()).payout?.outcome).toBe("already_paid")
        expect(test.provider.sends).toBe(0)
        expect(test.snapshots).toHaveLength(1)
        expect(JSON.parse(JSON.stringify(test.published.at(-1)))).toEqual(
          originalWrap
        )
        expect(
          (
            await test.progressStore.list(
              MERCHANT,
              test.snapshot.plan.checkoutId,
              test.snapshot.plan.planDigest
            )
          ).every((entry) => entry.relayAccepted)
        ).toBe(true)
        expect(
          await repository.loadMerchantSettlement(
            MERCHANT,
            test.snapshot.plan.checkoutId,
            test.snapshot.plan.planDigest
          )
        ).toEqual(facts)
      })
    }
  )

  it("stops Merchant continuation after account revocation or a CAS change during submitted snapshot delivery", async () => {
    for (const interruption of ["account", "cas"] as const) {
      installMerchantSession()
      await withRecoveryDatabase(async (database, repository) => {
        const test = await merchantContinuationHarness(database, repository)
        const publish = test.dependencies.progressTransport!.publishFn!
        test.dependencies.progressTransport!.publishFn = async (...args) => {
          const result = await publish(...args)
          const current = await repository.load(
            test.snapshot.plan.checkoutId,
            test.snapshot.plan.planDigest
          )
          if (
            current.status === "active" &&
            current.state.legs[0]!.status === "submitted"
          ) {
            if (interruption === "account") __resetProtectedReadSigner()
            else
              await repository.save(
                { ...current.state, updatedAt: current.state.updatedAt + 1 },
                current.revision
              )
          }
          return result
        }
        const pending = test.run()
        if (interruption === "account") await expect(pending).rejects.toThrow()
        else expect((await pending).payout?.sendAttempted).toBe(false)
        expect(test.provider.sends).toBe(0)
        expect(test.provider.cleanups).toBe(1)
        const current = await repository.load(
          test.snapshot.plan.checkoutId,
          test.snapshot.plan.planDigest
        )
        expect(
          current.status === "active" && current.state.legs[0]!.status
        ).toBe("submitted")
      })
    }
  })

  it("continues one buyer-signed frozen payout after takeover and never resends it", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await signedPreparedHistoryFixture(repository)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      expect(review?.intent).toEqual(fixture.intent)
      expect(review?.inspection).toEqual({
        recipientAttribution: "local_origin",
        savedStatus: "prepared",
        allocationBudget: "fits",
      })
      if (!review) throw new Error("Expected a prepared review.")
      const previewSnapshot = JSON.stringify(review)
      const provider = { sent: false, sends: 0, cleanups: 0 }
      const dependencies = continuationDependencies(
        fixture,
        provider,
        repository
      )
      const first = await continueMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        review,
        dependencies
      )
      expect(first.status).toBe("consumed")
      expect(first.payout).toEqual({
        outcome: "paid",
        reason: undefined,
        sendAttempted: true,
      })
      expect(provider.sends).toBe(1)
      expect(JSON.stringify(review)).toBe(previewSnapshot)
      const stored = await repository.load(
        fixture.snapshot.plan.checkoutId,
        fixture.snapshot.plan.planDigest
      )
      expect(stored.status).toBe("active")
      if (stored.status !== "active") return
      expect(stored.state.legs[0]).toMatchObject({
        status: "paid",
        finalDebitSats: fixture.leg.allocationSats,
        finalFeeSats: 1,
        intent: fixture.intent,
      })
      const verifiedPayout = await repository.loadMerchantSettlement(
        MERCHANT,
        fixture.snapshot.plan.checkoutId,
        fixture.snapshot.plan.planDigest
      )
      expect(verifiedPayout).not.toBeNull()
      expect(projectCheckoutSparkMerchantSettlement(verifiedPayout!)).toEqual({
        creditVerified: true,
        merchantVerified: true,
        commerceVerified: true,
        feePending: true,
        recipientUnverified: false,
      })
      const second = await continueMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        review,
        dependencies
      )
      expect(second.payout?.outcome).toBe("already_paid")
      expect(provider.sends).toBe(1)
      expect(provider.cleanups).toBe(2)
    })
  })

  it("restores the same signed invoice and transfer ID in another local database without sending twice", async () => {
    await withRecoveryDatabase(async (_database, firstRepository) => {
      const fixture = await signedPreparedHistoryFixture(firstRepository)
      const secondDatabase = new ConduitDB(
        `conduit-merchant-second-device-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      try {
        const secondRepository = new DexieCheckoutSparkSettledRepository(
          secondDatabase
        )
        await secondRepository.importMerchantOrderRecovery(
          fixture.signedState,
          syntheticMerchantOrderWitness(fixture),
          () => {}
        )
        const firstReview = await reviewMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          firstRepository
        )
        const secondReview = await reviewMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          secondRepository
        )
        const firstPayment = { ...firstReview }
        const secondPayment = { ...secondReview }
        delete firstPayment.inspection
        delete secondPayment.inspection
        expect(secondPayment).toEqual(firstPayment)
        expect(firstReview?.inspection?.recipientAttribution).toBe(
          "local_origin"
        )
        expect(secondReview?.inspection?.recipientAttribution).toBe("missing")
        if (!firstReview || !secondReview) {
          throw new Error("Expected matching prepared reviews.")
        }
        const provider = { sent: false, sends: 0, cleanups: 0 }
        const first = await continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          firstReview,
          continuationDependencies(fixture, provider, firstRepository)
        )
        expect(first.payout?.outcome).toBe("paid")
        const second = await continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          secondReview,
          continuationDependencies(fixture, provider, secondRepository)
        )
        expect(second.payout?.outcome).toBe("already_paid")
        expect(provider.sends).toBe(1)
        const restored = await secondRepository.load(
          fixture.snapshot.plan.checkoutId,
          fixture.snapshot.plan.planDigest
        )
        expect(restored.status).toBe("active")
        if (restored.status === "active") {
          expect(restored.state.legs[0]?.status).toBe("paid")
          expect(restored.state.legs[0]?.intent?.transferId).toBe(
            fixture.intent.transferId
          )
        }
      } finally {
        secondDatabase.close()
        await secondDatabase.delete()
      }
    })
  })

  it("retains provider-verified merchant payment when a later history read is unavailable", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await signedPreparedHistoryFixture(repository)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      if (!review) throw new Error("Expected a prepared review.")
      const provider = { sent: false, sends: 0, cleanups: 0 }
      await continueMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        review,
        continuationDependencies(fixture, provider, repository)
      )
      const verified = await repository.loadMerchantSettlement(
        MERCHANT,
        fixture.snapshot.plan.checkoutId,
        fixture.snapshot.plan.planDigest
      )
      expect(verified).not.toBeNull()
      const unavailable = await continueMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        review,
        continuationDependencies(fixture, provider, repository, {
          history: "unavailable",
        })
      )
      expect(unavailable.payout?.reason).toBe("provider_evidence_unavailable")
      expect(provider.sends).toBe(1)
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          fixture.snapshot.plan.checkoutId,
          fixture.snapshot.plan.planDigest
        )
      ).toEqual(verified)
      expect(projectCheckoutSparkMerchantSettlement(verified!)).toMatchObject({
        merchantVerified: true,
        commerceVerified: true,
        feePending: true,
      })
    })
  })

  it("keeps a concurrently restored client without local origin from making another send", async () => {
    await withRecoveryDatabase(async (_database, firstRepository) => {
      const fixture = await signedPreparedHistoryFixture(firstRepository)
      const secondDatabase = new ConduitDB(
        `conduit-merchant-concurrent-client-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      try {
        const secondRepository = new DexieCheckoutSparkSettledRepository(
          secondDatabase
        )
        await secondRepository.importMerchantOrderRecovery(
          fixture.signedState,
          syntheticMerchantOrderWitness(fixture),
          () => {}
        )
        const firstReview = await reviewMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          firstRepository
        )
        const secondReview = await reviewMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          secondRepository
        )
        if (!firstReview || !secondReview) {
          throw new Error("Expected matching signed reviews.")
        }
        const firstPayment = { ...firstReview }
        const secondPayment = { ...secondReview }
        delete firstPayment.inspection
        delete secondPayment.inspection
        expect(secondPayment).toEqual(firstPayment)
        expect(firstReview?.inspection?.recipientAttribution).toBe(
          "local_origin"
        )
        expect(secondReview?.inspection?.recipientAttribution).toBe("missing")
        const provider = { sent: false, sends: 0, cleanups: 0 }
        const attempted: Array<{
          paymentRequest: string
          maxFeeSats: number
          transferId: string
        }> = []
        let releaseSend!: () => void
        const sendReleased = new Promise<void>((resolve) => {
          releaseSend = resolve
        })
        const onSend = async (request: (typeof attempted)[number]) => {
          attempted.push(request)
          await sendReleased
          provider.sent = true
        }
        const firstPending = continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          firstReview,
          continuationDependencies(fixture, provider, firstRepository, {
            onSend,
          })
        )
        const second = await continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          secondReview,
          continuationDependencies(fixture, provider, secondRepository, {
            onSend,
          })
        )
        releaseSend()
        const first = await firstPending
        expect(first.payout?.outcome).toBe("paid")
        expect(second.payout).toEqual({
          outcome: "wait",
          reason: "recipient_unverified",
          sendAttempted: false,
        })
        expect(attempted).toHaveLength(1)
        expect(attempted[0]).toEqual({
          paymentRequest: fixture.intent.paymentRequest,
          maxFeeSats: fixture.intent.maxFeeSats,
          transferId: fixture.intent.transferId,
        })
        expect(provider.sends).toBe(1)
        expect(provider.cleanups).toBe(2)
      } finally {
        secondDatabase.close()
        await secondDatabase.delete()
      }
    })
  })

  it("stops before a provider send when persisting the submitted marker fails", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await signedPreparedHistoryFixture(repository)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      if (!review) throw new Error("Expected a prepared review.")
      const provider = { sent: false, sends: 0, cleanups: 0 }
      const failingRepository = {
        load: repository.load.bind(repository),
        assertLocalInvoiceOrigin:
          repository.assertLocalInvoiceOrigin.bind(repository),
        loadMerchantOrderWitness:
          repository.loadMerchantOrderWitness.bind(repository),
        recordMerchantCredit: repository.recordMerchantCredit.bind(repository),
        recordMerchantPayout: repository.recordMerchantPayout.bind(repository),
        save: async (...args: Parameters<typeof repository.save>) => {
          if (args[0].legs[0]?.status === "submitted") {
            throw new Error("synthetic submitted marker persistence failure")
          }
          return repository.save(...args)
        },
      }
      await expect(
        continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          review,
          {
            ...continuationDependencies(fixture, provider, repository),
            repository: failingRepository,
          }
        )
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(provider.sends).toBe(0)
      expect(provider.cleanups).toBe(1)
      const stored = await repository.load(
        fixture.snapshot.plan.checkoutId,
        fixture.snapshot.plan.planDigest
      )
      expect(stored.status).toBe("active")
      if (stored.status === "active") {
        expect(stored.state.legs[0]?.status).toBe("prepared")
      }
    })
  })

  it("refuses a local-only intent absent from the latest authenticated buyer recovery", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await preparedHistoryFixture(repository)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      if (!review) throw new Error("Expected a local prepared review.")
      let opens = 0
      await expect(
        continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          review,
          {
            repository,
            now: () => fixture.snapshot.plan.takeoverAt,
            openWallet: async () => {
              opens += 1
              throw new Error("must not open")
            },
          }
        )
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(opens).toBe(0)
    })
  })

  it("rejects an altered review and a pre-takeover attempt before opening Spark", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await signedPreparedHistoryFixture(repository)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      if (!review) throw new Error("Expected a prepared review.")
      let opens = 0
      const options = {
        repository,
        openWallet: async () => {
          opens += 1
          throw new Error("must not open")
        },
      }
      const alteredReviews = [
        { ...review, destination: "attacker@example.test" },
        {
          ...review,
          intent: {
            ...review.intent,
            maxFeeSats: review.intent.maxFeeSats + 1,
          },
        },
        { ...review, unexpectedPaymentField: true },
      ]
      for (const alteredReview of alteredReviews) {
        await expect(
          continueMerchantCheckoutSparkSettledPayout(
            MERCHANT,
            fixture.selected,
            alteredReview,
            { ...options, now: () => fixture.snapshot.plan.takeoverAt }
          )
        ).rejects.toThrow("Merchant checkout recovery adapter failed")
      }
      await expect(
        continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          review,
          { ...options, now: () => fixture.snapshot.plan.takeoverAt - 1 }
        )
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(opens).toBe(0)
    })
  })

  it("does not send an expired signed invoice or a paid claim without exact provider history", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await signedPreparedHistoryFixture(repository)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      if (!review) throw new Error("Expected a prepared review.")
      const provider = { sent: false, sends: 0, cleanups: 0 }
      const expired = await continueMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        review,
        {
          ...continuationDependencies(fixture, provider, repository),
          now: () => fixture.snapshot.plan.takeoverAt + 3_601_000,
        }
      )
      expect(expired.payout).toMatchObject({
        outcome: "wait",
        reason: "invoice_window_insufficient",
        sendAttempted: false,
      })
      expect(provider.sends).toBe(0)
      expect(provider.cleanups).toBe(0)
      const current = await repository.load(
        fixture.snapshot.plan.checkoutId,
        fixture.snapshot.plan.planDigest
      )
      if (current.status !== "active") throw new Error("Fixture is not active.")
      await repository.importRecoveryState(
        recordCheckoutSparkSettledLegStatus(current.state, {
          legId: fixture.leg.legId,
          transferId: fixture.intent.transferId,
          paymentHash: fixture.intent.paymentHash,
          status: "paid",
          observedAt: CREATED_AT + 4_000,
          finalFeeSats: 1,
          finalDebitSats: fixture.leg.allocationSats!,
        }),
        () => {}
      )
      const unverifiedClaim = await continueMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        review,
        continuationDependencies(fixture, provider, repository)
      )
      expect(unverifiedClaim.payout?.outcome).toBe("wait")
      expect(provider.sends).toBe(0)
    })
  })

  it("stops at the exact confirmation deadline and after key verification crosses it without opening Spark", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await signedPreparedHistoryFixture(repository)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      if (!review) throw new Error("Expected a prepared review.")
      const deadline = checkoutSparkProviderSendWindowEndsAt(
        review.intent.paymentRequest
      )
      if (deadline === null) throw new Error("Fixture deadline is invalid.")
      let opens = 0
      let clock = deadline
      const run = () =>
        continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          review,
          {
            repository,
            now: () => clock,
            deriveIdentity: async () => {
              clock = deadline
              return fixture.snapshot.plan.funding.receiverIdentityPublicKey
            },
            openWallet: async () => {
              opens += 1
              throw new Error("Must not open Spark after the deadline.")
            },
          }
        )
      for (const start of [deadline, deadline + 60_000, deadline - 1]) {
        clock = start
        expect((await run()).payout).toMatchObject({
          outcome: "wait",
          reason: "invoice_window_insufficient",
          sendAttempted: false,
        })
      }
      expect(opens).toBe(0)
    })
  })

  it("pauses on uncertain outgoing history and conflicting settled receive credit", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await signedPreparedHistoryFixture(repository)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      if (!review) throw new Error("Expected a prepared review.")
      const provider = { sent: false, sends: 0, cleanups: 0 }
      const pending = await continueMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        review,
        continuationDependencies(fixture, provider, repository, {
          history: "pending",
        })
      )
      expect(pending.payout).toMatchObject({
        outcome: "wait",
        reason: "prior_possible_send",
        sendAttempted: false,
      })
      expect(provider.sends).toBe(0)
      await expect(
        continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          review,
          continuationDependencies(fixture, provider, repository, {
            receiveTransferId: "another-checkout-credit",
          })
        )
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(provider.sends).toBe(0)
      expect(provider.cleanups).toBe(2)
    })
  })

  it("stops before send when the Merchant session changes during provider history", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = await signedPreparedHistoryFixture(repository)
      const review = await reviewMerchantCheckoutSparkSettledPayout(
        MERCHANT,
        fixture.selected,
        repository
      )
      if (!review) throw new Error("Expected a prepared review.")
      const provider = { sent: false, sends: 0, cleanups: 0 }
      let current = true
      await expect(
        continueMerchantCheckoutSparkSettledPayout(
          MERCHANT,
          fixture.selected,
          review,
          {
            ...continuationDependencies(fixture, provider, repository, {
              onHistoryRead: () => {
                current = false
              },
            }),
            shouldContinue: () => current,
          }
        )
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(provider.sends).toBe(0)
      expect(provider.cleanups).toBe(1)
    })
  })

  async function importedPaidHistoryFixture(
    repository: DexieCheckoutSparkSettledRepository
  ) {
    const fixture = await preparedHistoryFixture(repository)
    const loaded = await repository.load(
      fixture.snapshot.plan.checkoutId,
      fixture.snapshot.plan.planDigest
    )
    expect(loaded.status).toBe("active")
    if (loaded.status !== "active") throw new Error("Fixture is not active.")
    const paid = recordCheckoutSparkSettledLegStatus(loaded.state, {
      legId: fixture.leg.legId,
      transferId: fixture.intent.transferId,
      paymentHash: fixture.intent.paymentHash,
      status: "paid",
      observedAt: CREATED_AT + 4_000,
      finalFeeSats: 1,
      finalDebitSats: fixture.leg.allocationSats!,
    })
    await repository.importRecoveryState(paid, () => {})
    return fixture
  }

  it("offers an explicit history-only action with a claim warning", () => {
    const panelSource = readFileSync(
      new URL(
        "../apps/merchant/src/components/CheckoutSparkRecoveryPanel.tsx",
        import.meta.url
      ),
      "utf8"
    )
    expect(panelSource).toContain("Inspect exact payout history")
    expect(panelSource).toContain(
      "inspectMerchantCheckoutSparkSettledPayoutHistory"
    )
    expect(panelSource).toMatch(/may\s+claim\s+pending\s+inbound\s+funds/)
    expect(panelSource).toContain("No payout was sent by this check")
  })

  it("cancels payout-history inspection after wallet setup and cleans up", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await preparedHistoryFixture(repository)
      let active = true
      let cleanups = 0
      let historyReads = 0
      await expect(
        inspectMerchantCheckoutSparkSettledPayoutHistory(MERCHANT, selected, {
          repository,
          now: () => snapshot.plan.takeoverAt,
          assertActive: () => {
            if (!active) throw new Error("synthetic session ended")
          },
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => ({
            ensurePrivateReady: async () => {
              active = false
            },
            getIdentityPublicKey: async () => {
              historyReads += 1
              return snapshot.plan.funding.receiverIdentityPublicKey
            },
            getLightningReceiveRequest: async () => null,
            getTransfer: async () => undefined,
            cleanup: async () => {
              cleanups += 1
            },
          }),
        })
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(historyReads).toBe(0)
      expect(cleanups).toBe(1)
    })
  })

  it("does not open Spark without exact credit or a frozen payout intent", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const snapshot = settledInitialSnapshot()
      const wrap = signedWrap(MERCHANT, CREATED_AT)
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [INBOX],
        readProtectedInbox: async () => protectedRead([wrap]),
        giftUnwrap: async () => snapshot.rumor,
      })
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      await importMerchantCheckoutSparkSettledRecovery(
        MERCHANT,
        selected,
        repository
      )
      let opens = 0
      const options = {
        repository,
        now: () => snapshot.plan.takeoverAt,
        openWallet: async () => {
          opens += 1
          throw new Error("wallet must not open")
        },
      }
      const unfunded = await inspectMerchantCheckoutSparkSettledPayoutHistory(
        MERCHANT,
        selected,
        options
      )
      expect(unfunded.payoutHistory).toMatchObject({
        status: "credit_needed",
        checkedLegs: 0,
      })
      const credited = recordCheckoutSparkSettledCredit(snapshot.state, {
        requestId: snapshot.plan.funding.requestId,
        paymentHash: snapshot.plan.funding.paymentHash,
        transferId: "exact-no-intent-credit",
        receiverIdentityPublicKey:
          snapshot.plan.funding.receiverIdentityPublicKey,
        grossSats: 122,
        creditedSats: 121,
        observedAt: CREATED_AT + 2_000,
      })
      await repository.importRecoveryState(credited, () => {})
      const unprepared = await inspectMerchantCheckoutSparkSettledPayoutHistory(
        MERCHANT,
        selected,
        options
      )
      expect(unprepared.payoutHistory).toMatchObject({
        status: "no_intents",
        checkedLegs: 0,
        withoutIntentLegs: 2,
      })
      expect(opens).toBe(0)
    })
  })

  for (const timing of [
    { name: "at takeover", elapsedMs: 0, sendWindow: true },
    {
      name: "after frozen invoice expiry",
      elapsedMs: 3_601_000,
      sendWindow: false,
    },
  ]) {
    it(`records an exact completed leg ${timing.name} without preparing or sending a payout`, async () => {
      await withRecoveryDatabase(async (_database, repository) => {
        const { snapshot, selected, leg, intent, nativeRequest } =
          await preparedHistoryFixture(repository)
        expect(
          hasCheckoutSparkProviderSendWindow({
            paymentRequest: intent.paymentRequest,
            nowMs: snapshot.plan.takeoverAt + timing.elapsedMs,
          })
        ).toBe(timing.sendWindow)
        let historyReads = 0
        let cleanups = 0
        const inspected =
          await inspectMerchantCheckoutSparkSettledPayoutHistory(
            MERCHANT,
            selected,
            {
              repository,
              now: () => snapshot.plan.takeoverAt + timing.elapsedMs,
              deriveIdentity: async () =>
                snapshot.plan.funding.receiverIdentityPublicKey,
              openWallet: async () => ({
                ensurePrivateReady: async () => {},
                getIdentityPublicKey: async () =>
                  snapshot.plan.funding.receiverIdentityPublicKey,
                getLightningReceiveRequest: async () => null,
                getTransfer: async () => undefined,
                getTransferFromSsp: async (id: string) => {
                  historyReads += 1
                  expect(id).toBe(intent.transferId)
                  return {
                    sparkId: intent.transferId,
                    totalAmount: {
                      originalValue: leg.allocationSats!,
                      originalUnit: "SATOSHI",
                    },
                    userRequest: nativeRequest,
                  }
                },
                getLightningSendRequest: async (id: string) => {
                  expect(id).toBe(nativeRequest.id)
                  return nativeRequest
                },
                cleanup: async () => {
                  cleanups += 1
                },
              }),
            }
          )
        expect(inspected.status).toBe("consumed")
        expect(inspected.payoutHistory).toMatchObject({
          status: "inspected",
          checkedLegs: 1,
          newlyConfirmedLegs: 1,
        })
        expect(historyReads).toBe(1)
        expect(cleanups).toBe(1)
        const stored = await repository.load(
          snapshot.plan.checkoutId,
          snapshot.plan.planDigest
        )
        expect(stored.status).toBe("active")
        if (stored.status !== "active") return
        expect(stored.state.legs[0]?.status).toBe("paid")
        expect(stored.state.legs[1]?.intent).toBeNull()
        const verification = await repository.loadMerchantSettlement(
          MERCHANT,
          snapshot.plan.checkoutId,
          snapshot.plan.planDigest
        )
        expect(verification).not.toBeNull()
        expect(projectCheckoutSparkMerchantSettlement(verification!)).toEqual({
          creditVerified: false,
          merchantVerified: true,
          commerceVerified: false,
          feePending: false,
          recipientUnverified: false,
        })
      })
    })
  }

  it("keeps a conflicting fresh request unresolved instead of recording a payout", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected, leg, intent, nativeRequest } =
        await preparedHistoryFixture(repository)
      let cleanups = 0
      const inspected = await inspectMerchantCheckoutSparkSettledPayoutHistory(
        MERCHANT,
        selected,
        {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => ({
            ensurePrivateReady: async () => {},
            getIdentityPublicKey: async () =>
              snapshot.plan.funding.receiverIdentityPublicKey,
            getLightningReceiveRequest: async () => null,
            getTransfer: async () => undefined,
            getTransferFromSsp: async () => ({
              sparkId: intent.transferId,
              totalAmount: {
                originalValue: leg.allocationSats!,
                originalUnit: "SATOSHI",
              },
              userRequest: nativeRequest,
            }),
            getLightningSendRequest: async () => ({
              ...nativeRequest,
              idempotencyKey: "different-transfer-id",
            }),
            cleanup: async () => {
              cleanups += 1
            },
          }),
        }
      )
      expect(inspected.payoutHistory).toMatchObject({
        status: "inspected",
        checkedLegs: 1,
        newlyConfirmedLegs: 0,
        unresolvedLegs: 1,
      })
      const stored = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(stored.status).toBe("active")
      if (stored.status !== "active") return
      expect(stored.state.legs[0]?.status).toBe("conflicting_evidence")
      expect(stored.state.legs[0]?.finalDebitSats).toBeNull()
      expect(cleanups).toBe(1)
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          snapshot.plan.checkoutId,
          snapshot.plan.planDigest
        )
      ).toBeNull()
    })
  })

  it("does not treat an absent exact transfer as proof of payment or permission to send", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await preparedHistoryFixture(repository)
      const inspected = await inspectMerchantCheckoutSparkSettledPayoutHistory(
        MERCHANT,
        selected,
        {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => ({
            ensurePrivateReady: async () => {},
            getIdentityPublicKey: async () =>
              snapshot.plan.funding.receiverIdentityPublicKey,
            getLightningReceiveRequest: async () => null,
            getTransfer: async () => undefined,
            getTransferFromSsp: async () => undefined,
            getLightningSendRequest: async () => {
              throw new Error("must not read without an exact transfer")
            },
            cleanup: async () => {},
          }),
        }
      )
      expect(inspected.payoutHistory).toMatchObject({
        status: "inspected",
        checkedLegs: 1,
        newlyConfirmedLegs: 0,
        unresolvedLegs: 1,
      })
      const stored = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(stored.status).toBe("active")
      if (stored.status !== "active") return
      expect(stored.state.legs[0]?.status).toBe("prepared")
      expect(stored.state.legs[0]?.finalDebitSats).toBeNull()
    })
  })

  it("re-attests an imported paid leg from exact Spark history before counting it verified", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected, leg, intent, nativeRequest } =
        await importedPaidHistoryFixture(repository)
      const before = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          snapshot.plan.checkoutId,
          snapshot.plan.planDigest
        )
      ).toBeNull()
      let historyReads = 0
      const inspected = await inspectMerchantCheckoutSparkSettledPayoutHistory(
        MERCHANT,
        selected,
        {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => ({
            ensurePrivateReady: async () => {},
            getIdentityPublicKey: async () =>
              snapshot.plan.funding.receiverIdentityPublicKey,
            getLightningReceiveRequest: async () => null,
            getTransfer: async () => undefined,
            getTransferFromSsp: async (id: string) => {
              historyReads += 1
              expect(id).toBe(intent.transferId)
              return {
                sparkId: intent.transferId,
                totalAmount: {
                  originalValue: leg.allocationSats!,
                  originalUnit: "SATOSHI",
                },
                userRequest: nativeRequest,
              }
            },
            getLightningSendRequest: async (id: string) => {
              expect(id).toBe(nativeRequest.id)
              return nativeRequest
            },
            cleanup: async () => {},
          }),
        }
      )
      expect(inspected.payoutHistory).toMatchObject({
        status: "inspected",
        checkedLegs: 1,
        alreadyPaidLegs: 1,
        unresolvedLegs: 0,
      })
      expect(historyReads).toBe(1)
      expect(
        await repository.load(
          snapshot.plan.checkoutId,
          snapshot.plan.planDigest
        )
      ).toEqual(before)
      const attested = await repository.loadMerchantSettlement(
        MERCHANT,
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(attested).not.toBeNull()
      expect(projectCheckoutSparkMerchantSettlement(attested!)).toMatchObject({
        merchantVerified: true,
        creditVerified: false,
        commerceVerified: false,
      })
    })
  })

  for (const historyState of ["absent", "unavailable"] as const) {
    it(`does not trust an imported paid claim when exact history is ${historyState}`, async () => {
      await withRecoveryDatabase(async (_database, repository) => {
        const { snapshot, selected, leg, intent } =
          await importedPaidHistoryFixture(repository)
        const inspected =
          await inspectMerchantCheckoutSparkSettledPayoutHistory(
            MERCHANT,
            selected,
            {
              repository,
              now: () => snapshot.plan.takeoverAt,
              deriveIdentity: async () =>
                snapshot.plan.funding.receiverIdentityPublicKey,
              openWallet: async () => ({
                ensurePrivateReady: async () => {},
                getIdentityPublicKey: async () =>
                  snapshot.plan.funding.receiverIdentityPublicKey,
                getLightningReceiveRequest: async () => null,
                getTransfer: async () => undefined,
                getTransferFromSsp: async (id: string) => {
                  expect(id).toBe(intent.transferId)
                  if (historyState === "unavailable") {
                    throw new Error("history unavailable")
                  }
                  return undefined
                },
                getLightningSendRequest: async () => {
                  throw new Error("must not read without an exact transfer")
                },
                cleanup: async () => {},
              }),
            }
          )
        expect(inspected.payoutHistory).toMatchObject({
          status: "inspected",
          checkedLegs: 1,
          alreadyPaidLegs: 0,
          unresolvedLegs: 1,
        })
        const stored = await repository.load(
          snapshot.plan.checkoutId,
          snapshot.plan.planDigest
        )
        expect(stored.status).toBe("active")
        if (stored.status !== "active") return
        expect(stored.state.legs[0]).toMatchObject({
          status: "paid",
          finalFeeSats: 1,
          finalDebitSats: leg.allocationSats,
        })
        expect(
          await repository.loadMerchantSettlement(
            MERCHANT,
            snapshot.plan.checkoutId,
            snapshot.plan.planDigest
          )
        ).toBeNull()
      })
    })
  }

  it("does not verify an imported paid claim with a different provider debit", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected, leg, intent, nativeRequest } =
        await importedPaidHistoryFixture(repository)
      const actualRequest = {
        ...nativeRequest,
        fee: { originalValue: 0, originalUnit: "SATOSHI" },
      }
      const inspected = await inspectMerchantCheckoutSparkSettledPayoutHistory(
        MERCHANT,
        selected,
        {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => ({
            ensurePrivateReady: async () => {},
            getIdentityPublicKey: async () =>
              snapshot.plan.funding.receiverIdentityPublicKey,
            getLightningReceiveRequest: async () => null,
            getTransfer: async () => undefined,
            getTransferFromSsp: async (id: string) => {
              expect(id).toBe(intent.transferId)
              return {
                sparkId: intent.transferId,
                totalAmount: {
                  originalValue: intent.invoiceAmountSats,
                  originalUnit: "SATOSHI",
                },
                userRequest: actualRequest,
              }
            },
            getLightningSendRequest: async (id: string) => {
              expect(id).toBe(actualRequest.id)
              return actualRequest
            },
            cleanup: async () => {},
          }),
        }
      )
      expect(inspected.payoutHistory).toMatchObject({
        status: "inspected",
        checkedLegs: 1,
        alreadyPaidLegs: 0,
        unresolvedLegs: 1,
      })
      const stored = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(stored.status).toBe("active")
      if (stored.status !== "active") return
      expect(stored.state.legs[0]).toMatchObject({
        status: "paid",
        finalFeeSats: 1,
        finalDebitSats: leg.allocationSats,
      })
    })
  })

  it("does not open a wallet when fresh signed inbox coverage becomes incomplete", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected } = await preparedHistoryFixture(repository)
      __setCommerceTestOverrides({
        readProtectedInbox: async () =>
          protectedRead([signedWrap(MERCHANT, CREATED_AT)], {
            coverage: "partial",
          }),
      })
      let opens = 0
      const result = await inspectMerchantCheckoutSparkSettledPayoutHistory(
        MERCHANT,
        selected,
        {
          repository,
          now: () => snapshot.plan.takeoverAt,
          openWallet: async () => {
            opens += 1
            throw new Error("wallet must not open")
          },
        }
      )
      expect(result.status).toBe("incomplete")
      expect(result.payoutHistory).toBeNull()
      expect(opens).toBe(0)
    })
  })

  it("discards payout history when Merchant authority changes during the exact read", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const { snapshot, selected, leg, intent, nativeRequest } =
        await preparedHistoryFixture(repository)
      let current = true
      let cleanups = 0
      installProtectedReadSigner(
        {
          authMethod: "nip07",
          getPublicKey: async () => MERCHANT,
          signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
        },
        MERCHANT,
        () => current
      )
      await expect(
        inspectMerchantCheckoutSparkSettledPayoutHistory(MERCHANT, selected, {
          repository,
          now: () => snapshot.plan.takeoverAt,
          deriveIdentity: async () =>
            snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => ({
            ensurePrivateReady: async () => {},
            getIdentityPublicKey: async () =>
              snapshot.plan.funding.receiverIdentityPublicKey,
            getLightningReceiveRequest: async () => null,
            getTransfer: async () => undefined,
            getTransferFromSsp: async () => {
              current = false
              return {
                sparkId: intent.transferId,
                totalAmount: {
                  originalValue: leg.allocationSats!,
                  originalUnit: "SATOSHI",
                },
                userRequest: nativeRequest,
              }
            },
            getLightningSendRequest: async () => {
              throw new Error("must not read after account switch")
            },
            cleanup: async () => {
              cleanups += 1
            },
          }),
        })
      ).rejects.toThrow("authority changed")
      const stored = await repository.load(
        snapshot.plan.checkoutId,
        snapshot.plan.planDigest
      )
      expect(stored.status).toBe("active")
      if (stored.status !== "active") return
      expect(stored.state.legs[0]?.status).toBe("prepared")
      expect(cleanups).toBe(1)
    })
  })
})

describe("Merchant-authored Spark progress remains read-only recovery evidence", () => {
  it("imports authenticated Merchant progress without provider payout facts", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = settledMerchantProgressFixture()
      await repository.importMerchantOrderRecovery(
        fixture.snapshot.state,
        syntheticMerchantOrderWitness(fixture),
        () => {}
      )
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      expect(selected.merchantProgress?.wrapId).toBe(fixture.progressWrap.id)

      const result = await importMerchantCheckoutSparkSettledRecovery(
        MERCHANT,
        selected,
        repository
      )

      expect(result.status).toBe("consumed")
      const stored = await repository.load(
        fixture.snapshot.plan.checkoutId,
        fixture.snapshot.plan.planDigest
      )
      expect(stored.status).toBe("active")
      if (stored.status !== "active") return
      expect(stored.state).toEqual(fixture.prepared)
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          fixture.snapshot.plan.checkoutId,
          fixture.snapshot.plan.planDigest
        )
      ).toBeNull()
      expect(JSON.stringify(stored)).not.toContain(SETTLED_MNEMONIC)
      expect(JSON.stringify(result)).not.toContain(SETTLED_MNEMONIC)
    })
  })

  it("refuses to import Merchant progress without its authenticated buyer order", async () => {
    for (const witnessBuyer of [null, OTHER]) {
      await withRecoveryDatabase(async (_database, repository) => {
        const fixture = settledMerchantProgressFixture()
        if (witnessBuyer) {
          await repository.importMerchantOrderRecovery(
            fixture.snapshot.state,
            syntheticMerchantOrderWitness(fixture, witnessBuyer),
            () => {}
          )
        } else {
          await repository.importRecoveryState(fixture.snapshot.state, () => {})
        }
        const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
          .candidates[0]!

        await expect(
          importMerchantCheckoutSparkSettledRecovery(
            MERCHANT,
            selected,
            repository
          )
        ).rejects.toThrow("Merchant checkout recovery adapter failed")
        const stored = await repository.load(
          fixture.snapshot.plan.checkoutId,
          fixture.snapshot.plan.planDigest
        )
        expect(stored.status).toBe("active")
        if (stored.status === "active") {
          expect(stored.state).toEqual(fixture.snapshot.state)
        }
      })
    }
  })

  it("verifies a sidecar key only after the authenticated state is imported", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = settledMerchantProgressFixture()
      await repository.importMerchantOrderRecovery(
        fixture.snapshot.state,
        syntheticMerchantOrderWitness(fixture),
        () => {}
      )
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      let derivations = 0
      const dependencies = {
        repository,
        now: () => fixture.snapshot.plan.takeoverAt + 1_000,
        deriveIdentity: async () => {
          derivations += 1
          return fixture.snapshot.plan.funding.receiverIdentityPublicKey
        },
      }
      await expect(
        verifyMerchantCheckoutSparkSettledRecoveryKey(
          MERCHANT,
          selected,
          dependencies
        )
      ).rejects.toThrow("Merchant checkout recovery adapter failed")
      expect(derivations).toBe(0)

      await repository.importMerchantOrderRecovery(
        fixture.prepared,
        syntheticMerchantOrderWitness(fixture),
        () => {}
      )
      const result = await verifyMerchantCheckoutSparkSettledRecoveryKey(
        MERCHANT,
        selected,
        dependencies
      )
      expect(result.status).toBe("consumed")
      expect(derivations).toBe(1)
      expect(JSON.stringify(result)).not.toContain(SETTLED_MNEMONIC)
    })
  })

  it("re-attests sidecar credit with Spark and records provider proof separately", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = settledMerchantProgressFixture()
      await repository.importMerchantOrderRecovery(
        fixture.prepared,
        syntheticMerchantOrderWitness(fixture),
        () => {}
      )
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      expect(selected.merchantProgress).toMatchObject({
        wrapId: fixture.progressWrap.id,
        snapshotId: fixture.progress.snapshotId,
      })
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          fixture.snapshot.plan.checkoutId,
          fixture.snapshot.plan.planDigest
        )
      ).toBeNull()
      let opens = 0
      const result = await reconcileMerchantCheckoutSparkSettledCredit(
        MERCHANT,
        selected,
        {
          repository,
          now: () => fixture.snapshot.plan.takeoverAt + 1_000,
          deriveIdentity: async () =>
            fixture.snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => {
            opens += 1
            return {
              ensurePrivateReady: async () => {},
              getIdentityPublicKey: async () =>
                fixture.snapshot.plan.funding.receiverIdentityPublicKey,
              getLightningReceiveRequest: async () => ({
                id: fixture.snapshot.plan.funding.requestId,
                status: "TRANSFER_COMPLETED",
                network: "MAINNET",
                invoice: {
                  encodedInvoice: fixture.snapshot.plan.funding.paymentRequest,
                  bitcoinNetwork: "MAINNET",
                  paymentHash: fixture.snapshot.plan.funding.paymentHash,
                  amount: { originalValue: 122, originalUnit: "SATOSHI" },
                },
                transfer: {
                  sparkId: "0197f9a0-0000-7000-8000-000000000001",
                  userRequestId: fixture.snapshot.plan.funding.requestId,
                  totalAmount: { originalValue: 121, originalUnit: "SATOSHI" },
                },
              }),
              getTransfer: async () => ({
                id: "0197f9a0-0000-7000-8000-000000000001",
                status: "TRANSFER_STATUS_COMPLETED",
                totalValue: 121,
                transferDirection: "INCOMING",
                receiverIdentityPublicKey:
                  fixture.snapshot.plan.funding.receiverIdentityPublicKey,
                userRequest: { id: fixture.snapshot.plan.funding.requestId },
              }),
              cleanup: async () => {},
            }
          },
        }
      )
      expect(result.status).toBe("consumed")
      expect(result.creditStatus).toBe("recorded")
      expect(opens).toBe(1)
      const verified = await repository.loadMerchantSettlement(
        MERCHANT,
        fixture.snapshot.plan.checkoutId,
        fixture.snapshot.plan.planDigest
      )
      expect(verified).not.toBeNull()
      expect(
        projectCheckoutSparkMerchantSettlement(verified!).creditVerified
      ).toBe(true)
      expect(
        projectCheckoutSparkMerchantSettlement(verified!).merchantVerified
      ).toBe(false)
      expect(JSON.stringify(result)).not.toContain(SETTLED_MNEMONIC)
    })
  })

  it("requires an authenticated local buyer-order witness before opening Spark", async () => {
    for (const witnessBuyer of [null, OTHER]) {
      await withRecoveryDatabase(async (_database, repository) => {
        const fixture = settledMerchantProgressFixture()
        if (witnessBuyer) {
          await repository.importMerchantOrderRecovery(
            fixture.prepared,
            syntheticMerchantOrderWitness(fixture, witnessBuyer),
            () => {}
          )
        } else {
          await repository.importRecoveryState(fixture.prepared, () => {})
        }
        const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
          .candidates[0]!
        expect(selected.merchantProgress?.wrapId).toBe(fixture.progressWrap.id)
        let opens = 0
        await expect(
          reconcileMerchantCheckoutSparkSettledCredit(MERCHANT, selected, {
            repository,
            now: () => fixture.snapshot.plan.takeoverAt,
            deriveIdentity: async () =>
              fixture.snapshot.plan.funding.receiverIdentityPublicKey,
            openWallet: async () => {
              opens += 1
              throw new Error("wallet must not open")
            },
          })
        ).rejects.toThrow("Merchant checkout recovery adapter failed")
        expect(opens).toBe(0)
        expect(
          await repository.loadMerchantSettlement(
            MERCHANT,
            fixture.snapshot.plan.checkoutId,
            fixture.snapshot.plan.planDigest
          )
        ).toBeNull()
      })
    }
  })

  it("does not promote a Merchant sidecar paid claim without exact provider history", async () => {
    await withRecoveryDatabase(async (_database, repository) => {
      const fixture = settledMerchantProgressFixture({ paidClaim: true })
      await repository.importMerchantOrderRecovery(
        fixture.prepared,
        syntheticMerchantOrderWitness(fixture),
        () => {}
      )
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      expect(selected.merchantProgress?.wrapId).toBe(fixture.progressWrap.id)
      const result = await inspectMerchantCheckoutSparkSettledPayoutHistory(
        MERCHANT,
        selected,
        {
          repository,
          now: () => fixture.snapshot.plan.takeoverAt + 2_000,
          deriveIdentity: async () =>
            fixture.snapshot.plan.funding.receiverIdentityPublicKey,
          openWallet: async () => ({
            ensurePrivateReady: async () => {},
            getIdentityPublicKey: async () =>
              fixture.snapshot.plan.funding.receiverIdentityPublicKey,
            getLightningReceiveRequest: async () => null,
            getTransfer: async () => undefined,
            cleanup: async () => {},
          }),
        }
      )
      expect(result.status).toBe("consumed")
      expect(result.payoutHistory?.alreadyPaidLegs).toBe(0)
      expect(result.payoutHistory?.unresolvedLegs).toBe(1)
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          fixture.snapshot.plan.checkoutId,
          fixture.snapshot.plan.planDigest
        )
      ).toBeNull()
    })
  })
})

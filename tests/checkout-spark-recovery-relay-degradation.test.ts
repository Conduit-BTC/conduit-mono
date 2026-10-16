import { afterEach, describe, expect, it } from "bun:test"
import {
  giftWrap as legacyGiftWrap,
  NDKEvent,
  NDKPrivateKeySigner,
  NDKUser,
} from "@nostr-dev-kit/ndk"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  clearTestAccountSigner,
  setTestAccountSigner,
} from "./helpers/plain-signer"
import { ConduitDB } from "@conduit/core/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkRecoveryPayload,
  buildCheckoutSparkMerchantProgressRumor,
  createCheckoutSparkMerchantProgress,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  DexieCheckoutSparkSettledRepository,
  freezeCheckoutSparkPlan,
  freezeCheckoutSparkSettledPlan,
  getMerchantCheckoutSparkRecoveryList,
  prepareCheckoutSparkSettledLeg,
  deriveCheckoutSparkSettledTransferId,
  recordCheckoutSparkSettledCredit,
  withMerchantCheckoutSparkRecovery,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type { ProtectedInboxReadResult } from "../packages/core/src/protocol/protected-inbox-read"
import type { PrivateMessageEvent } from "../packages/core/src/protocol/messaging"
import { getNdk } from "../packages/core/src/protocol/ndk"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createInboxDeclarationFixtureEvidence } from "./helpers/inbox-declaration"
import { relayTargetsFromUrls } from "../packages/core/src/protocol/relay-authority"
import { __resetInboxDeclarationCache } from "../packages/core/src/protocol/private-message-routing"

const INBOXES = ["wss://ready.example.test", "wss://offline.example.test"]
const NOW = 1_800_000_000_000
const databases: ConduitDB[] = []
const owners: CommerceInbox[] = []

async function admitMerchantInbox(signer: NDKPrivateKeySigner) {
  const declaration = new NDKEvent(undefined, {
    kind: 10_050,
    created_at: NOW / 1_000,
    content: "",
    tags: INBOXES.map((url) => ["relay", url]),
  })
  await declaration.sign(signer)
  await createInboxDeclarationFixtureEvidence(declaration, { prime: true })
}

function fixtureOwner(
  merchant: string,
  signer: ConstructorParameters<typeof CommerceInbox>[1],
  database: ConduitDB
) {
  const authorization = getProtectedReadAuthorization(merchant)!
  const owner = new CommerceInbox(
    authorization,
    signer,
    new CommerceInboxStore(authorization, database)
  )
  owners.push(owner)
  return owner
}

// Keep the independently encrypted legacy NDK wire fixture while production
// builders now return plain protocol rumors.
function giftWrap(
  rumor: PrivateMessageEvent,
  recipient: NDKUser,
  signer: NDKPrivateKeySigner
) {
  return legacyGiftWrap(new NDKEvent(getNdk(), rumor), recipient, signer)
}

async function settledFixture(degradedStage: "buyer" | "initial" | "merchant") {
  const buyerSigner = NDKPrivateKeySigner.generate()
  const merchantSigner = NDKPrivateKeySigner.generate()
  const buyer = (await buyerSigner.user()).pubkey
  const merchant = (await merchantSigner.user()).pubkey
  await admitMerchantInbox(merchantSigner)
  const product = new NDKEvent(undefined, {
    kind: 30_402,
    pubkey: merchant,
    created_at: NOW / 1_000,
    content: "Offline product fixture",
    tags: [
      ["d", "relay-recovery"],
      ["title", "Recovery fixture"],
      ["price", "10", "SAT"],
      ["type", "simple", "digital"],
    ],
  })
  await product.sign(merchantSigner)
  const profile = new NDKEvent(undefined, {
    kind: 0,
    pubkey: merchant,
    created_at: NOW / 1_000,
    content: JSON.stringify({ lud16: "merchant@example.test" }),
    tags: [],
  })
  await profile.sign(merchantSigner)
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "settled-degraded-checkout",
    orderId: "settled-degraded-order",
    merchantPubkey: merchant,
    walletId: "settled-degraded-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    commerceQuote: {
      commerceTotalSats: 10,
      lines: [
        {
          productCoordinate: `30402:${merchant}:relay-recovery`,
          productEventId: product.id,
          merchantPubkey: merchant,
          quantity: 1,
          unitMerchandiseSats: 10,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "settled-degraded-receive",
      paymentRequest: makeSignedBolt11Fixture({
        hrp: "lnbc1220n",
        createdAt: NOW / 1_000,
        fields: [
          bolt11PaymentHashField(new Uint8Array(32).fill(3)),
          bolt11PaymentSecretField(),
          bolt11PlainDescriptionField(),
        ],
      }),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats: 122,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: merchant,
        weightSats: 10,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: profile.id,
            profileEventCreatedAt: NOW / 1_000,
          },
        },
      },
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
  const state = createCheckoutSparkSettledReconciliation(plan)
  const initial = createCheckoutSparkSettledRecoveryPayload({
    state,
    senderPubkey: buyer,
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 0,
    preparedAt: NOW + 1_000,
    sourceEvents: [
      product.rawEvent(),
      profile.rawEvent(),
    ] as SignedPublicNostrEvent[],
  })
  const credited = recordCheckoutSparkSettledCredit(state, {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    transferId: "offline-settled-credit",
    grossSats: 122,
    creditedSats: 122,
    observedAt: NOW + 2_000,
  })
  const latest = createCheckoutSparkSettledRecoveryProgressPayload({
    initialHandoffId: initial.handoffId,
    state: credited,
    senderPubkey: buyer,
    preparedAt: NOW + 3_000,
  })
  const prepared = prepareCheckoutSparkSettledLeg(credited, {
    legId: credited.legs[0]!.legId,
    transferId: deriveCheckoutSparkSettledTransferId(
      plan,
      credited.legs[0]!.legId
    ),
    paymentRequest: makeSignedBolt11Fixture({
      hrp: "lnbc90n",
      createdAt: plan.takeoverAt / 1_000,
      fields: [
        bolt11PaymentHashField(new Uint8Array(32).fill(8)),
        bolt11PaymentSecretField(),
        bolt11PlainDescriptionField(),
      ],
    }),
    paymentHash: "08".repeat(32),
    invoiceAmountSats: 9,
    maxFeeSats: credited.legs[0]!.allocationSats! - 9,
    preparedAt: plan.takeoverAt,
  })
  const merchantProgress = createCheckoutSparkMerchantProgress({
    initialHandoffId: initial.handoffId,
    state: prepared,
  })
  const recipient = new NDKUser({ pubkey: merchant })
  const wraps = await Promise.all([
    giftWrap(buildCheckoutSparkRecoveryRumor(initial), recipient, buyerSigner),
    giftWrap(buildCheckoutSparkRecoveryRumor(latest), recipient, buyerSigner),
    giftWrap(
      buildCheckoutSparkMerchantProgressRumor(merchantProgress),
      recipient,
      merchantSigner
    ),
  ])
  const events = wraps.map((wrap) => wrap.rawEvent() as SignedPublicNostrEvent)
  const database = new ConduitDB(`degraded-exact-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(database)
  const merchantOwner = setTestAccountSigner(merchantSigner)
  installProtectedReadSigner(merchantOwner, merchant, () => true)
  const owner = fixtureOwner(merchant, merchantOwner, database)
  const degradedId =
    wraps[degradedStage === "initial" ? 0 : degradedStage === "buyer" ? 1 : 2]!
      .id
  __setCommerceTestOverrides({
    getAccountSigner: () => merchantOwner,
    getCommerceInbox: () => owner,
    checkoutSparkSettledRepository: new DexieCheckoutSparkSettledRepository(
      database
    ),
    resolveInboxRelayUrls: async () => INBOXES,
    readProtectedInbox: async (options) =>
      read(
        options.eventId
          ? events.filter((event) => event.id === options.eventId)
          : events,
        options.eventId === degradedId,
        options.relayUrls
      ),
  })
  const selected = (await getMerchantCheckoutSparkRecoveryList(merchant))
    .candidates[0]!
  expect(selected.schemaVersion).toBe(3)
  expect(selected.merchantProgress?.snapshotId).toBe(
    merchantProgress.snapshotId
  )
  return { merchant, selected }
}

/** Signed encrypted fixtures only; this test never opens a provider wallet. */
async function fixture() {
  const buyerSigner = NDKPrivateKeySigner.generate()
  const merchantSigner = NDKPrivateKeySigner.generate()
  const buyer = (await buyerSigner.user()).pubkey
  const merchant = (await merchantSigner.user()).pubkey
  await admitMerchantInbox(merchantSigner)
  const plan = freezeCheckoutSparkPlan({
    checkoutId: "degraded-recovery-checkout",
    orderId: "degraded-recovery-order",
    merchantPubkey: merchant,
    walletId: "degraded-recovery-wallet",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    funding: {
      requestId: "synthetic-funding",
      paymentRequest: "synthetic-funding-invoice",
      paymentHash: "b".repeat(64),
      requiredNetSats: 1_235,
      grossFundingSats: 1_240,
      createdAt: NOW,
      expiresAt: NOW + 60_000,
    },
    obligations: [
      {
        kind: "merchant",
        recipientId: merchant,
        paymentRequest: "synthetic-merchant-invoice",
        amountSats: 1_000,
        maxFeeSats: 100,
      },
      {
        kind: "conduit",
        recipientId: "conduithodlings@strike.me",
        paymentRequest: "synthetic-conduit-invoice",
        amountSats: 111,
        maxFeeSats: 24,
      },
    ],
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${merchant}:synthetic-listing`,
          productEventId: "d".repeat(64),
          merchantPubkey: merchant,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
  })
  const payload = createCheckoutSparkRecoveryPayload({
    plan,
    senderPubkey: buyer,
    mnemonic: createRuntimeMnemonic(),
    accountNumber: 0,
    preparedAt: NOW + 1_000,
  })
  const wrapped = await giftWrap(
    buildCheckoutSparkRecoveryRumor(payload),
    new NDKUser({ pubkey: merchant }),
    buyerSigner
  )
  const wrap = wrapped.rawEvent() as SignedPublicNostrEvent
  const merchantOwner = setTestAccountSigner(merchantSigner)
  installProtectedReadSigner(merchantOwner, merchant, () => true)
  const database = new ConduitDB(`degraded-legacy-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  databases.push(database)
  const owner = fixtureOwner(merchant, merchantOwner, database)
  let exactEvents = [wrap]
  __setCommerceTestOverrides({
    getAccountSigner: () => merchantOwner,
    getCommerceInbox: () => owner,
    resolveInboxRelayUrls: async () => INBOXES,
    readProtectedInbox: async (options) => {
      if (options.eventId) expect(options.relayUrls).toEqual(INBOXES)
      else {
        expect(options.relayUrls).toHaveLength(1)
        expect(INBOXES).toContain(options.relayUrls[0]!)
      }
      expect(options.appRelayUrls).toBeUndefined()
      expect(options.relayTargets).toEqual(
        relayTargetsFromUrls(options.relayUrls, {
          kind: "owner_nip17",
          operation: "read",
          ownerPubkey: merchant,
        })
      )
      return read(
        options.eventId ? exactEvents : [wrap],
        !!options.eventId,
        options.relayUrls
      )
    },
  })
  const selected = (await getMerchantCheckoutSparkRecoveryList(merchant))
    .candidates[0]!
  expect(selected).toBeDefined()
  return {
    merchant,
    selected,
    wrap,
    omitExact: () => {
      exactEvents = []
    },
    alterExact: (
      alter: (wrap: SignedPublicNostrEvent) => SignedPublicNostrEvent
    ) => {
      exactEvents = [alter(wrap)]
    },
  }
}

function read(
  events: SignedPublicNostrEvent[],
  degraded: boolean,
  relays: readonly string[] = INBOXES
): ProtectedInboxReadResult {
  const completed = relays.filter(
    (relay) => !degraded || relay !== INBOXES[1]
  ).length
  const received = completed === 0 ? [] : events
  return {
    events: received,
    coverage:
      completed === 0
        ? "unavailable"
        : completed === relays.length
          ? "complete"
          : "partial",
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status:
        completed === 0
          ? "failed"
          : completed === relays.length
            ? "success"
            : "partial",
      observations: relays.flatMap((relay, index) =>
        degraded && relay === INBOXES[1]
          ? []
          : [{ type: "eose" as const, relayIndex: index }]
      ),
      relays: relays.map((relay, index) => ({
        relayIndex: index,
        status: degraded && relay === INBOXES[1] ? "failed" : "success",
        auth: "not_challenged",
        eventCount: degraded && relay === INBOXES[1] ? 0 : events.length,
        duplicateCount: 0,
        malformedCount: 0,
        unusableCount: 0,
      })),
      attemptedCount: relays.length,
      completedCount: completed,
      failedCount: relays.length - completed,
      authoritativeEmpty: completed === relays.length && received.length === 0,
    },
  }
}

afterEach(async () => {
  for (const owner of owners.splice(0)) owner.stop()
  clearTestAccountSigner()
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  __resetInboxDeclarationCache()
  for (const database of databases.splice(0)) {
    database.close()
    await database.delete()
  }
})

describe("exact Merchant recovery under inbox relay degradation", () => {
  it.each(["buyer", "initial", "merchant"] as const)(
    "opens current settled recovery when only the %s exact read has an unavailable peer",
    async (stage) => {
      const { merchant, selected } = await settledFixture(stage)
      let consumed = 0
      const result = await withMerchantCheckoutSparkRecovery(
        merchant,
        selected,
        {
          async consume() {
            throw new Error("Current recovery must consume Merchant progress")
          },
          async consumeMerchantProgress(
            initial,
            latest,
            progress,
            assertCurrent
          ) {
            assertCurrent()
            expect(initial.plan.planDigest).toBe(selected.planDigest)
            expect(latest.schemaVersion).toBe(3)
            expect(progress.snapshotId).toBe(
              selected.merchantProgress!.snapshotId
            )
            consumed += 1
          },
        }
      )
      expect(result.status).toBe("consumed")
      expect(result.coverage).toBe("partial")
      expect(consumed).toBe(1)
    }
  )
  it("opens a valid exact encrypted recovery from one declared inbox when another times out", async () => {
    const { merchant, selected } = await fixture()
    let consumed = 0
    const result = await withMerchantCheckoutSparkRecovery(merchant, selected, {
      async consume(payload, assertCurrent) {
        assertCurrent()
        expect(payload.plan.orderId).toBe(selected.orderId)
        expect(payload.plan.planDigest).toBe(selected.planDigest)
        consumed += 1
      },
    })
    expect(result.status).toBe("consumed")
    expect(result.coverage).toBe("partial")
    expect(consumed).toBe(1)
  })

  it("does not turn an empty partial exact read into missing or recovery authority", async () => {
    const { merchant, selected, omitExact } = await fixture()
    omitExact()
    let consumed = 0
    const result = await withMerchantCheckoutSparkRecovery(merchant, selected, {
      async consume() {
        consumed += 1
      },
    })
    expect(result.status).toBe("incomplete")
    expect(result.coverage).toBe("partial")
    expect(consumed).toBe(0)
  })

  it.each(["content", "id", "recipient"] as const)(
    "rejects an altered %s even when a completed declared source returns it",
    async (field) => {
      const { merchant, selected, alterExact } = await fixture()
      alterExact((wrap) => ({
        ...wrap,
        ...(field === "content"
          ? { content: "invalid encrypted envelope" }
          : {}),
        ...(field === "id" ? { id: "a".repeat(64) } : {}),
        ...(field === "recipient" ? { tags: [["p", "b".repeat(64)]] } : {}),
      }))
      let consumed = 0
      const result = await withMerchantCheckoutSparkRecovery(
        merchant,
        selected,
        {
          async consume() {
            consumed += 1
          },
        }
      )
      expect(result.status).toBe("incomplete")
      expect(result.coverage).toBe("partial")
      expect(consumed).toBe(0)
    }
  )

  it("keeps the authenticated order binding when a sibling inbox is unavailable", async () => {
    const { merchant, selected } = await fixture()
    let consumed = 0
    const result = await withMerchantCheckoutSparkRecovery(
      merchant,
      { ...selected, orderId: "another-order" },
      {
        async consume() {
          consumed += 1
        },
      }
    )
    expect(result.status).toBe("incomplete")
    expect(consumed).toBe(0)
  })
})

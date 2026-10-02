import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildCheckoutSparkMerchantProgressRumor,
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkMerchantProgress,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  createMerchantCheckoutSparkRecoveryDiscovery,
  deriveCheckoutSparkSettledTransferId,
  DexieCheckoutSparkSettledRepository,
  freezeCheckoutSparkSettledPlan,
  getMerchantCheckoutSparkRecoveryList,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkMerchantProgressPayload,
  type CheckoutSparkSettledReconciliation,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"
import {
  __resetProtectedReadSigner,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type { ProtectedInboxReadResult } from "../packages/core/src/protocol/protected-inbox-read"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = getPublicKey(generateSecretKey())
const WRAP_SECRET = generateSecretKey()
const INBOX = "wss://merchant-progress-inbox.example"
const CREATED_AT = 1_800_000_000_000
const TAKEOVER_AT = CREATED_AT + 120_000
const MNEMONIC = createRuntimeMnemonic()
const SETTLED_PRODUCT = finalizeEvent(
  {
    kind: 30_402,
    created_at: CREATED_AT / 1_000,
    tags: [
      ["d", "progress-inbox-fixture"],
      ["title", "Merchant progress fixture"],
      ["price", "1000", "SAT"],
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

function invoice(amount: number, hash: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amount * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(hash)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function fixtures(withSources = false) {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "merchant-progress-inbox-checkout",
    orderId: "merchant-progress-inbox-order",
    merchantPubkey: MERCHANT,
    walletId: "merchant-progress-inbox-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: TAKEOVER_AT,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:progress-inbox-fixture`,
          productEventId: SETTLED_PRODUCT.id,
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "merchant-progress-inbox-receive",
      paymentRequest: invoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"d".repeat(64)}`,
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
            profileEventId: SETTLED_PROFILE.id,
            profileEventCreatedAt: SETTLED_PROFILE.created_at,
          },
        },
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        weightSats: 111,
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: {
            type: "conduit_allowlist",
            policy: "local_router_canary",
          },
        },
      },
    ],
  })
  const initialState = createCheckoutSparkSettledReconciliation(plan)
  const initial = createCheckoutSparkSettledRecoveryPayload({
    state: initialState,
    senderPubkey: BUYER,
    mnemonic: MNEMONIC,
    accountNumber: 0,
    preparedAt: CREATED_AT + 1_000,
    ...(withSources
      ? { sourceEvents: [SETTLED_PRODUCT, SETTLED_PROFILE] }
      : {}),
  })
  const credited = recordCheckoutSparkSettledCredit(initialState, {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    transferId: "merchant-progress-inbox-credit",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: 1_113,
    creditedSats: 1_111,
    observedAt: CREATED_AT + 2_000,
  })
  const buyerProgress = createCheckoutSparkSettledRecoveryProgressPayload({
    initialHandoffId: initial.handoffId,
    senderPubkey: BUYER,
    state: credited,
    preparedAt: CREATED_AT + 3_000,
  })
  const prepare = (hash = 8) =>
    prepareCheckoutSparkSettledLeg(credited, {
      legId: credited.legs[0]!.legId,
      transferId: deriveCheckoutSparkSettledTransferId(
        plan,
        credited.legs[0]!.legId
      ),
      paymentRequest: invoice(995, hash),
      paymentHash: hash.toString(16).padStart(2, "0").repeat(32),
      invoiceAmountSats: 995,
      maxFeeSats: 5,
      preparedAt: TAKEOVER_AT,
    })
  const state = prepare()
  const progressOf = (next = state) =>
    createCheckoutSparkMerchantProgress({
      initialHandoffId: initial.handoffId,
      state: next,
    })
  return {
    initial,
    buyerProgress,
    state,
    prepare,
    progressOf,
    progress: progressOf(),
  }
}

function entry(rumor: NDKEvent, second: number, suffix = "") {
  const event = finalizeEvent(
    {
      kind: 1_059,
      created_at: CREATED_AT / 1_000 + second,
      tags: [["p", MERCHANT]],
      content: `synthetic ciphertext ${second} ${suffix}`,
    },
    WRAP_SECRET
  )
  return { event, rumor }
}
type Entry = ReturnType<typeof entry>

function protectedRead(events: Entry["event"][]): ProtectedInboxReadResult {
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

function inbox(
  all: Entry[],
  options: {
    scan?: () => Entry[]
    beforeRead?: (id?: string) => void | Promise<void>
    beforeExact?: (id: string) => void
  } = {}
) {
  const exactIds: string[] = []
  __setCommerceTestOverrides({
    resolveInboxRelayUrls: async () => [INBOX],
    readProtectedInbox: async (request) => {
      await options.beforeRead?.(request.eventId)
      if (request.eventId) {
        expect(request.limit).toBe(2)
        exactIds.push(request.eventId)
        options.beforeExact?.(request.eventId)
      }
      const source = request.eventId ? all : (options.scan?.() ?? all)
      const events = source
        .map((value) => value.event)
        .filter(
          (event) =>
            (!request.eventId || event.id === request.eventId) &&
            (request.since === undefined ||
              event.created_at >= request.since) &&
            (request.until === undefined || event.created_at <= request.until)
        )
        .sort((left, right) => right.created_at - left.created_at)
        .slice(0, request.limit)
      return protectedRead(events)
    },
    giftUnwrap: async (event) =>
      all.find((value) => value.event.id === event.id)?.rumor ?? null,
  })
  return { exactIds }
}

function orderRumor() {
  const rumor = new NDKEvent()
  rumor.kind = 16
  rumor.pubkey = BUYER
  rumor.created_at = CREATED_AT / 1_000
  rumor.tags = [
    ["p", MERCHANT],
    ["type", "order"],
    ["order", "merchant-progress-inbox-order"],
    ["amount", "1000"],
    ["currency", "SATS"],
    ["item", `30402:${MERCHANT}:progress-inbox-fixture`, "1"],
    [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
  ]
  rumor.content = JSON.stringify({
    id: "merchant-progress-inbox-order",
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    merchantPubkey: MERCHANT,
    items: [
      {
        productId: `30402:${MERCHANT}:progress-inbox-fixture`,
        format: "digital",
        fulfillment: { type: "digital" },
        quantity: 1,
        priceAtPurchase: 1000,
        currency: "SATS",
        shippingCostSats: 0,
      },
    ],
    subtotal: 1000,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: "not_required",
    createdAt: CREATED_AT,
    note: "private full-order note",
  })
  rumor.id = rumor.getEventHash()
  return rumor
}

function progressEntry(
  progress: CheckoutSparkMerchantProgressPayload,
  second = 80
) {
  return entry(buildCheckoutSparkMerchantProgressRumor(progress), second)
}

function baseEntries(
  fixture: ReturnType<typeof fixtures>,
  buyerProgress = true
): Entry[] {
  return [
    entry(buildCheckoutSparkRecoveryRumor(fixture.initial), 2),
    ...(buyerProgress
      ? [entry(buildCheckoutSparkRecoveryRumor(fixture.buyerProgress), 3)]
      : []),
  ]
}

function advance(
  state: CheckoutSparkSettledReconciliation,
  status: "submitted" | "paid",
  at: number
) {
  const intent = state.legs[0]!.intent!
  return recordCheckoutSparkSettledLegStatus(state, {
    legId: intent.legId,
    transferId: intent.transferId,
    paymentHash: intent.paymentHash,
    status,
    observedAt: at,
    ...(status === "paid" ? { finalFeeSats: 1, finalDebitSats: 996 } : {}),
  })
}

function expectPrivateMetadata(
  candidate: MerchantCheckoutSparkRecoveryCandidate,
  fixture: ReturnType<typeof fixtures>
) {
  const serialized = JSON.stringify(candidate)
  for (const privateValue of [
    MNEMONIC,
    "private full-order note",
    "merchant@example.test",
    fixture.state.legs[0]!.intent!.paymentRequest,
    BUYER,
  ]) {
    expect(serialized).not.toContain(privateValue)
  }
  expect(candidate).not.toHaveProperty("state")
  expect(candidate).not.toHaveProperty("payload")
  expect(Object.keys(candidate.merchantProgress!).sort()).toEqual([
    "recordedAt",
    "snapshotId",
    "wrapId",
  ])
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  sourceDatabase = new ConduitDB(
    `conduit-merchant-progress-sources-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  installProtectedReadSigner(
    {
      authMethod: "nip07",
      getPublicKey: async () => MERCHANT,
      signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
    },
    MERCHANT,
    () => true
  )
  __setCommerceTestOverrides({
    checkoutSparkSettledRepository: new DexieCheckoutSparkSettledRepository(
      sourceDatabase
    ),
    readCheckoutSparkPlanSourceEvents: async () => ({
      events: [SETTLED_PRODUCT, SETTLED_PROFILE],
      coverage: "complete",
    }),
    getAccountSigner: () =>
      plainTestSigner({
        user: async () => new NDKUser({ pubkey: MERCHANT }),
      } as NDKSigner as never),
  })
})
afterEach(async () => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  sourceDatabase.close()
  await sourceDatabase.delete()
})

describe("Merchant-authored progress inbox integration", () => {
  it.each([false, true])(
    "consumes bundled historical sources without public lookup (buyer progress: %s)",
    async (withBuyerProgress) => {
      const fixture = fixtures(true)
      const buyer = baseEntries(fixture, withBuyerProgress)
      const merchant = progressEntry(fixture.progress)
      const { exactIds } = inbox([...buyer, merchant])
      let publicReads = 0
      __setCommerceTestOverrides({
        readCheckoutSparkPlanSourceEvents: async () => {
          publicReads += 1
          return { events: [], coverage: "unavailable" }
        },
      })
      const discovery = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
      const candidate = discovery.candidates[0]!
      let consumed = 0
      const result = await withMerchantCheckoutSparkRecovery(
        MERCHANT,
        candidate,
        {
          consume: async () => {
            throw new Error("Expected private Merchant progress path.")
          },
          consumeMerchantProgress: async (
            initial,
            latest,
            progress,
            assertCurrent
          ) => {
            assertCurrent()
            expect(initial.sourceEvents).toEqual(fixture.initial.sourceEvents)
            expect(latest.handoffId).toBe(
              withBuyerProgress
                ? fixture.buyerProgress.handoffId
                : fixture.initial.handoffId
            )
            expect(progress.snapshotId).toBe(fixture.progress.snapshotId)
            consumed += 1
          },
        }
      )
      expect(result.status).toBe("consumed")
      expect(consumed).toBe(1)
      expect(publicReads).toBe(0)
      expect(exactIds).toContain(buyer[0]!.event.id)
      expect(exactIds).toContain(merchant.event.id)
    }
  )

  it.each([false, true])(
    "keeps buyer envelope identity while one-page discovery attaches private progress metadata (buyer progress: %s)",
    async (withBuyerProgress) => {
      const fixture = fixtures()
      const buyer = baseEntries(fixture, withBuyerProgress)
      const merchant = progressEntry(fixture.progress)
      inbox([...buyer, merchant])
      const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
      expect(result.coverage).toBe("complete")
      expect(result.candidates).toHaveLength(1)
      const candidate = result.candidates[0]!
      expect(candidate.wrapId).toBe(buyer.at(-1)!.event.id)
      expect(candidate.schemaVersion).toBe(withBuyerProgress ? 3 : 2)
      expect(candidate.preparedAt).toBe(
        withBuyerProgress
          ? fixture.buyerProgress.preparedAt
          : fixture.initial.preparedAt
      )
      expect(candidate.merchantProgress).toEqual({
        wrapId: merchant.event.id,
        snapshotId: fixture.progress.snapshotId,
        recordedAt: TAKEOVER_AT,
      })
      expectPrivateMetadata(candidate, fixture)
    }
  )

  it("stitches progress before the buyer package and signed order, preserving original buyer witness", async () => {
    const fixture = fixtures()
    const buyer = baseEntries(fixture)
    const order = entry(orderRumor(), 1)
    const merchant = progressEntry(fixture.progress)
    const unrelated = Array.from({ length: 49 }, (_, index) =>
      entry(
        new NDKEvent(undefined, { kind: 14, tags: [], content: "ordinary" }),
        30 + index
      )
    )
    inbox([...buyer, order, merchant, ...unrelated])
    const saved: {
      state: CheckoutSparkSettledReconciliation
      witness: unknown
    }[] = []
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        onOrderRecovery: async ({ state, witness, assertCurrent }) => {
          assertCurrent()
          saved.push({ state, witness })
        },
      }
    )
    try {
      const first = await session.nextPage()
      expect(first.candidates).toEqual([])
      expect(first.coverage).toBe("partial")
      expect(first.history.hasMore).toBe(true)
      const second = await session.nextPage()
      expect(second.candidates).toHaveLength(1)
      expect(second.candidates[0]!.merchantProgress?.snapshotId).toBe(
        fixture.progress.snapshotId
      )
      expect(saved).toHaveLength(1)
      expect(saved[0]!.state).toEqual(fixture.state)
      expect(saved[0]!.witness).toMatchObject({
        buyerPubkey: BUYER,
        merchantPubkey: MERCHANT,
        rumorId: order.rumor.id,
        planDigest: fixture.initial.plan.planDigest,
      })
      expect(JSON.stringify(saved)).not.toContain(MNEMONIC)
      expect(JSON.stringify(saved)).not.toContain("private full-order note")
      expectPrivateMetadata(second.candidates[0]!, fixture)
    } finally {
      session.dispose()
    }
  })

  it("persists new Merchant progress when its buyer wrap and authenticated order are unchanged", async () => {
    const fixture = fixtures()
    const all = [
      ...baseEntries(fixture),
      entry(orderRumor(), 1),
      progressEntry(fixture.progress),
    ]
    inbox(all)
    const states: CheckoutSparkSettledReconciliation[] = []
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        onOrderRecovery: async ({ state, assertCurrent }) => {
          assertCurrent()
          states.push(state)
        },
      }
    )
    try {
      const first = await session.nextPage()
      expect(states).toEqual([fixture.state])
      await session.nextPage()
      expect(states).toHaveLength(1)
      const next = fixture.progressOf(
        advance(fixture.state, "submitted", TAKEOVER_AT + 1)
      )
      all.push(progressEntry(next, 81))
      session.restartScan()
      const second = await session.nextPage()
      expect(second.candidates[0]!.wrapId).toBe(first.candidates[0]!.wrapId)
      expect(second.candidates[0]!.merchantProgress?.snapshotId).toBe(
        next.snapshotId
      )
      expect(states).toEqual([fixture.state, next.state])
    } finally {
      session.dispose()
    }
  })

  it("keeps orphan Merchant progress partial without inventing buyer authority", async () => {
    const fixture = fixtures()
    inbox([progressEntry(fixture.progress)])
    const onePage = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(onePage.candidates).toEqual([])
    expect(onePage.coverage).toBe("partial")
    let imports = 0
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        onOrderRecovery: async () => {
          imports += 1
        },
      }
    )
    try {
      expect((await session.nextPage()).candidates).toEqual([])
      expect(imports).toBe(0)
    } finally {
      session.dispose()
    }
  })

  it("rejects a mismatched initial handoff and conflicting Merchant intent", async () => {
    for (const variant of ["handoff", "intent"] as const) {
      const fixture = fixtures()
      const conflict =
        variant === "handoff"
          ? createCheckoutSparkMerchantProgress({
              initialHandoffId: "f".repeat(64),
              state: fixture.state,
            })
          : fixture.progressOf(fixture.prepare(9))
      inbox([
        ...baseEntries(fixture),
        progressEntry(fixture.progress),
        progressEntry(conflict, 81),
      ])
      const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
      expect(result.candidates).toEqual([])
      expect(result.conflictCount).toBe(1)
      expect(result.coverage).toBe("partial")
    }
  })

  it("does not replace observed paid progress with a later prepared claim", async () => {
    const fixture = fixtures()
    const paid = fixture.progressOf(
      advance(fixture.state, "paid", TAKEOVER_AT + 1)
    )
    const regression = fixture.progressOf({
      ...fixture.state,
      updatedAt: TAKEOVER_AT + 2,
      legs: fixture.state.legs.map((leg) =>
        leg.intent ? { ...leg, observedAt: TAKEOVER_AT + 2 } : leg
      ),
    })
    inbox([
      ...baseEntries(fixture),
      progressEntry(paid),
      progressEntry(regression, 81),
    ])
    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(result.candidates).toEqual([])
    expect(result.conflictCount).toBe(1)
    expect(result.coverage).toBe("partial")
  })

  it.each([false, true])(
    "strictly reopens original buyer authority and calls only the Merchant callback (buyer progress: %s)",
    async (withBuyerProgress) => {
      const fixture = fixtures()
      const buyer = baseEntries(fixture, withBuyerProgress)
      const merchant = progressEntry(fixture.progress)
      const { exactIds } = inbox([...buyer, merchant])
      const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
        .candidates[0]!
      let consumed = 0
      let fallback = 0
      const result = await withMerchantCheckoutSparkRecovery(
        MERCHANT,
        selected,
        {
          consume: async () => {
            fallback += 1
          },
          consumeSettled: async () => {
            fallback += 1
          },
          consumeMerchantProgress: async (
            initial,
            latestBuyer,
            progress,
            guard
          ) => {
            guard()
            consumed += 1
            expect(initial).toEqual(fixture.initial)
            expect(initial.senderPubkey).toBe(BUYER)
            expect(latestBuyer).toEqual(
              withBuyerProgress ? fixture.buyerProgress : fixture.initial
            )
            expect(progress).toEqual(fixture.progress)
            expect(progress.merchantPubkey).toBe(MERCHANT)
          },
        }
      )
      expect(result.status).toBe("consumed")
      expect(consumed).toBe(1)
      expect(fallback).toBe(0)
      expect(exactIds.sort()).toEqual(
        [...buyer.map((value) => value.event.id), merchant.event.id].sort()
      )
      expectPrivateMetadata(result.candidate!, fixture)
    }
  )

  it("refuses a Merchant sidecar without its dedicated consumer and never falls back", async () => {
    const fixture = fixtures()
    inbox([...baseEntries(fixture), progressEntry(fixture.progress)])
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    let fallback = 0
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      consume: async () => {
        fallback += 1
      },
      consumeSettled: async () => {
        fallback += 1
      },
    })
    expect(result.status).toBe("incomplete")
    expect(fallback).toBe(0)
  })

  it("rejects stale or substituted progress metadata before private consumption", async () => {
    const fixture = fixtures()
    const all = [...baseEntries(fixture), progressEntry(fixture.progress)]
    inbox(all)
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    let consumed = 0
    const adapter = {
      consume: async () => {
        consumed += 1
      },
      consumeSettled: async () => {
        consumed += 1
      },
      consumeMerchantProgress: async () => {
        consumed += 1
      },
    }
    for (const merchantProgress of [
      { ...selected.merchantProgress!, snapshotId: "a".repeat(64) },
      { ...selected.merchantProgress!, recordedAt: TAKEOVER_AT + 1 },
      { ...selected.merchantProgress!, wrapId: all[0]!.event.id },
    ]) {
      const result = await withMerchantCheckoutSparkRecovery(
        MERCHANT,
        { ...selected, merchantProgress },
        adapter
      )
      expect(result.status).toBe("incomplete")
    }
    all.push(
      progressEntry(
        fixture.progressOf(
          advance(fixture.state, "submitted", TAKEOVER_AT + 1)
        ),
        81
      )
    )
    expect(
      (await withMerchantCheckoutSparkRecovery(MERCHANT, selected, adapter))
        .status
    ).toBe("incomplete")
    expect(consumed).toBe(0)
  })

  it("pins the entire selected buyer candidate and nested progress before an awaited discovery read", async () => {
    const fixture = fixtures()
    const buyer = baseEntries(fixture)
    const merchant = progressEntry(fixture.progress)
    const all = [...buyer, merchant]
    let hold = false
    let started!: () => void
    let release!: () => void
    const readStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { exactIds } = inbox(all, {
      beforeRead: async (id) => {
        if (hold && id === undefined) {
          started()
          await readGate
        }
      },
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    const original = structuredClone(selected)
    hold = true
    let consumed = 0
    let fallback = 0
    const pending = withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      consume: async () => {
        fallback += 1
      },
      consumeSettled: async () => {
        fallback += 1
      },
      consumeMerchantProgress: async (
        initial,
        latestBuyer,
        progress,
        guard
      ) => {
        guard()
        consumed += 1
        expect(initial).toEqual(fixture.initial)
        expect(latestBuyer).toEqual(fixture.buyerProgress)
        expect(progress).toEqual(fixture.progress)
      },
    })
    await readStarted
    selected.wrapId = merchant.event.id
    selected.schemaVersion = 1
    selected.checkoutId = "substituted-checkout"
    selected.orderId = "substituted-order"
    selected.planDigest = "f".repeat(64)
    selected.takeoverAt += 1
    selected.preparedAt += 1
    selected.initialWrapId = merchant.event.id
    selected.initialHandoffId = "f".repeat(64)
    selected.merchantProgress!.wrapId = buyer[0]!.event.id
    selected.merchantProgress!.snapshotId = "f".repeat(64)
    selected.merchantProgress!.recordedAt += 1
    release()
    const result = await pending
    expect(result.status).toBe("consumed")
    expect(result.candidate).toEqual(original)
    expect(consumed).toBe(1)
    expect(fallback).toBe(0)
    expect(exactIds.sort()).toEqual(all.map((value) => value.event.id).sort())
  })

  it("refuses a removed sidecar when fresh discovery observes Merchant progress instead of falling back to the buyer snapshot", async () => {
    const fixture = fixtures()
    inbox([...baseEntries(fixture), progressEntry(fixture.progress)])
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    delete selected.merchantProgress
    let consumed = 0
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      consume: async () => {
        consumed += 1
      },
      consumeSettled: async () => {
        consumed += 1
      },
      consumeMerchantProgress: async () => {
        consumed += 1
      },
    })
    expect(result.status).toBe("incomplete")
    expect(result.coverage).toBe("partial")
    expect(result.candidate).toBeNull()
    expect(consumed).toBe(0)
  })

  it("opens an exact sidecar when bounded discovery omitted it, without requiring a second recovery authority", async () => {
    const fixture = fixtures()
    const buyer = baseEntries(fixture)
    const all = [...buyer, progressEntry(fixture.progress)]
    let omitProgress = false
    inbox(all, { scan: () => (omitProgress ? buyer : all) })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    omitProgress = true
    let calls = 0
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      consume: async () => {
        throw new Error("unexpected fallback")
      },
      consumeMerchantProgress: async (
        initial,
        latestBuyer,
        progress,
        guard
      ) => {
        guard()
        calls += 1
        expect(initial.senderPubkey).toBe(BUYER)
        expect(latestBuyer).toEqual(fixture.buyerProgress)
        expect(progress).toEqual(fixture.progress)
      },
    })
    expect(result.status).toBe("consumed")
    expect(calls).toBe(1)
  })

  it("discards an exact progress read when signer authority changes", async () => {
    const fixture = fixtures()
    const merchant = progressEntry(fixture.progress)
    const all = [...baseEntries(fixture), merchant]
    let revoke = false
    inbox(all, {
      beforeExact: (id) => {
        if (revoke && id === merchant.event.id) __resetProtectedReadSigner()
      },
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    revoke = true
    let calls = 0
    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        consume: async () => {
          calls += 1
        },
        consumeSettled: async () => {
          calls += 1
        },
        consumeMerchantProgress: async () => {
          calls += 1
        },
      })
    ).rejects.toThrow("authority changed")
    expect(calls).toBe(0)
  })
})

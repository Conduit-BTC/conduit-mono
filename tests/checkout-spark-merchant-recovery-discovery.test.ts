import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import { plainTestSigner } from "./helpers/plain-signer"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  CHECKOUT_SPARK_ROUTER_ORDER_TAG,
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildCheckoutSparkRecoveryRumor,
  calculateCheckoutSparkSettledGrossFundingSats,
  createCheckoutSparkSettledReconciliation,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  createMerchantCheckoutSparkRecoveryDiscovery,
  freezeCheckoutSparkSettledPlan,
  recordCheckoutSparkSettledCredit,
  readMerchantCheckoutSparkPlanSources,
  readCheckoutSparkMerchantOrderEvidence,
  resolveCheckoutSparkSignedPickup,
  parseShippingOptionEvent,
} from "@conduit/core"
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
import { createCheckoutSparkPickupFixture } from "./support/checkout-spark-pickup-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const MNEMONIC = createRuntimeMnemonic()
const CONFLICT_MNEMONIC = createRuntimeMnemonic()
const OTHER_CONFLICT_MNEMONIC = createRuntimeMnemonic()
const LATER_CONFLICT_MNEMONIC = createRuntimeMnemonic()

const MERCHANT_SECRET = generateSecretKey()
const BUYER_SECRET = generateSecretKey()
const WRAP_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = getPublicKey(BUYER_SECRET)
const FIRST_INBOX = "wss://merchant-history-a.example"
const SECOND_INBOX = "wss://merchant-history-b.example"
const CREATED_AT = 1_800_000_000_000
const PRODUCT_SOURCE = finalizeEvent(
  {
    kind: 30_402,
    created_at: CREATED_AT / 1_000,
    tags: [
      ["d", "history-fixture"],
      ["title", "Recovery source fixture"],
      ["price", "10", "SAT"],
      ["type", "simple", "digital"],
    ],
    content: "Signed digital listing",
  },
  MERCHANT_SECRET
)
const PROFILE_SOURCE = finalizeEvent(
  {
    kind: 0,
    created_at: CREATED_AT / 1_000,
    tags: [],
    content: JSON.stringify({ lud16: "merchant@example.test" }),
  },
  MERCHANT_SECRET
)
const PLAN_SOURCES = [PRODUCT_SOURCE, PROFILE_SOURCE]
const SHIPPING_SOURCE = finalizeEvent(
  {
    kind: 30_406,
    created_at: CREATED_AT / 1_000,
    tags: [
      ["d", "history-shipping"],
      ["title", "Included shipping"],
      ["price", "0", "SAT"],
      ["country", "US"],
      ["service", "standard"],
    ],
    content: "",
  },
  MERCHANT_SECRET
)
const SHIPPING_COORDINATE = `30406:${MERCHANT}:history-shipping`
const PHYSICAL_PRODUCT_SOURCE = finalizeEvent(
  {
    kind: 30_402,
    created_at: CREATED_AT / 1_000,
    tags: [
      ["d", "history-fixture"],
      ["title", "Physical recovery source fixture"],
      ["price", "10", "SAT"],
      ["type", "simple", "physical"],
      ["shipping_option", SHIPPING_COORDINATE],
    ],
    content: "Signed physical listing",
  },
  MERCHANT_SECRET
)
const PHYSICAL_PLAN_SOURCES = [
  PHYSICAL_PRODUCT_SOURCE,
  PROFILE_SOURCE,
  SHIPPING_SOURCE,
]

function wrap(second: number, suffix = "") {
  return finalizeEvent(
    {
      kind: 1_059,
      created_at: CREATED_AT / 1_000 + second,
      tags: [["p", MERCHANT]],
      content: `opaque recovery ciphertext ${second} ${suffix}`,
    },
    WRAP_SECRET
  )
}

function protectedRead(
  events: ReturnType<typeof wrap>[],
  coverage: "complete" | "partial" | "unavailable" = "complete"
): ProtectedInboxReadResult {
  const complete = coverage === "complete"
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
      status: complete ? "success" : coverage,
      observations: complete ? [{ type: "eose", relayIndex: 0 }] : [],
      relays: [
        {
          relayIndex: 0,
          status: complete ? "success" : "partial",
          auth: "not_challenged",
          eventCount: events.length,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
        },
      ],
      attemptedCount: 1,
      completedCount: complete ? 1 : 0,
      failedCount: complete ? 0 : 1,
      authoritativeEmpty: complete && events.length === 0,
    },
  }
}

function settledFixtures(withSources = false) {
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc1220n",
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(3)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-history-fixture",
    orderId: "order-history-fixture",
    merchantPubkey: MERCHANT,
    walletId: "wallet-history-fixture",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    commerceQuote: {
      commerceTotalSats: 10,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:history-fixture`,
          productEventId: PRODUCT_SOURCE.id,
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 10,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-history-fixture",
      paymentRequest: invoice,
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
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
            profileEventId: PROFILE_SOURCE.id,
            profileEventCreatedAt: CREATED_AT / 1_000,
          },
        },
        weightSats: 10,
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
        weightSats: 111,
      },
    ],
  })
  const state = createCheckoutSparkSettledReconciliation(plan)
  const initial = createCheckoutSparkSettledRecoveryPayload({
    state,
    senderPubkey: BUYER,
    mnemonic: MNEMONIC,
    accountNumber: 0,
    preparedAt: CREATED_AT + 1_000,
    ...(withSources ? { sourceEvents: PLAN_SOURCES } : {}),
  })
  const credited = recordCheckoutSparkSettledCredit(state, {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    transferId: "received-history-fixture",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: 122,
    creditedSats: 121,
    observedAt: CREATED_AT + 2_000,
  })
  const progress = createCheckoutSparkSettledRecoveryProgressPayload({
    initialHandoffId: initial.handoffId,
    state: credited,
    senderPubkey: BUYER,
    preparedAt: CREATED_AT + 3_000,
  })
  return { initial, progress, credited }
}

function orderRumor(
  options: {
    buyer?: string
    amount?: number
    note?: string
    physical?: boolean
  } = {}
) {
  const rumor = new NDKEvent()
  const buyer = options.buyer ?? BUYER
  const amount = options.amount ?? 10
  rumor.kind = 16
  rumor.pubkey = buyer
  rumor.created_at = CREATED_AT / 1_000
  rumor.tags = [
    ["p", MERCHANT],
    ["type", "order"],
    ["order", "order-history-fixture"],
    ["amount", String(amount)],
    ["currency", "SATS"],
    ["item", `30402:${MERCHANT}:history-fixture`, "1"],
    [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
    ...(options.physical ? [["shipping", SHIPPING_COORDINATE]] : []),
  ]
  rumor.content = JSON.stringify({
    id: "order-history-fixture",
    buyerPubkey: buyer,
    buyerIdentityKind: "signed_in",
    merchantPubkey: MERCHANT,
    items: [
      {
        productId: `30402:${MERCHANT}:history-fixture`,
        format: options.physical ? "physical" : "digital",
        fulfillment: { type: options.physical ? "shipping" : "digital" },
        quantity: 1,
        priceAtPurchase: amount,
        currency: "SATS",
        shippingCostSats: 0,
        ...(options.physical
          ? {
              shippingOptionId: SHIPPING_COORDINATE,
              shippingOptionDTag: "history-shipping",
              sourceShippingCost: {
                amount: 0,
                currency: "SAT",
                normalizedCurrency: "SAT",
              },
              shippingCountries: ["US"],
              shippingCountryRules:
                parseShippingOptionEvent(SHIPPING_SOURCE)!.countryRules,
            }
          : {}),
      },
    ],
    subtotal: amount,
    currency: "SATS",
    shippingCostSats: 0,
    shippingCostStatus: options.physical ? "included" : "not_required",
    ...(options.physical
      ? {
          shippingAddress: {
            name: "Test Shopper",
            street: "123 Main Street",
            city: "New York",
            state: "NY",
            postalCode: "10001",
            country: "US",
          },
        }
      : {}),
    createdAt: CREATED_AT,
    ...(options.note ? { note: options.note } : {}),
  })
  rumor.id = rumor.getEventHash()
  return rumor
}

function historicalPickupPlan(
  calendarKind: 31922 | 31923,
  handoffMode: "merchant_handoff" | "organizer_handoff" = "organizer_handoff"
) {
  const pickup = createCheckoutSparkPickupFixture({
    merchantSecret: MERCHANT_SECRET,
    calendarKind,
    handoffMode,
    quantity: 1,
    createdAt: CREATED_AT / 1_000 - 120,
    acceptedAtMs: CREATED_AT,
  })
  const original = settledFixtures().initial.plan
  const total = pickup.line.unitMerchandiseSats + pickup.line.unitShippingSats
  const grossFundingSats = calculateCheckoutSparkSettledGrossFundingSats(total)
  const plan = freezeCheckoutSparkSettledPlan({
    ...original,
    commerceQuote: { commerceTotalSats: total, lines: [pickup.line] },
    funding: {
      ...original.funding,
      grossFundingSats,
      paymentRequest: makeSignedBolt11Fixture({
        hrp: `lnbc${grossFundingSats * 10}n`,
        createdAt: CREATED_AT / 1_000,
        fields: [
          bolt11PaymentHashField(new Uint8Array(32).fill(3)),
          bolt11PaymentSecretField(),
          bolt11PlainDescriptionField(),
        ],
      }),
    },
    recipients: original.recipients.map((recipient) => ({
      ...recipient,
      weightSats: recipient.kind === "merchant" ? total : recipient.weightSats,
    })),
  })
  return {
    plan,
    sources: [pickup.productEvent, PROFILE_SOURCE, ...pickup.sourceEvents],
    pickup,
  }
}

function physicalRecoveryFixture() {
  const original = settledFixtures().initial
  const plan = freezeCheckoutSparkSettledPlan({
    ...original.plan,
    commerceQuote: {
      ...original.plan.commerceQuote,
      lines: original.plan.commerceQuote.lines.map((line) => ({
        ...line,
        productEventId: PHYSICAL_PRODUCT_SOURCE.id,
        shippingOption: {
          coordinate: SHIPPING_COORDINATE,
          eventId: SHIPPING_SOURCE.id,
        },
      })),
    },
  })
  return createCheckoutSparkSettledRecoveryPayload({
    state: createCheckoutSparkSettledReconciliation(plan),
    senderPubkey: BUYER,
    mnemonic: MNEMONIC,
    accountNumber: 0,
    preparedAt: CREATED_AT + 1_000,
  })
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
  __setCommerceTestOverrides({
    getAccountSigner: () =>
      plainTestSigner({
        user: async () => new NDKUser({ pubkey: MERCHANT }),
      } as NDKSigner as never),
  })
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  installMerchantSession()
  __setCommerceTestOverrides({
    readCheckoutSparkPlanSourceEvents: async () => ({
      events: PLAN_SOURCES,
      coverage: "complete",
    }),
  })
})
afterEach(() => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
})

describe("exact signed Merchant recovery source reads", () => {
  it("retains the frozen shipping revision when a later legitimate revision is also observed", async () => {
    const initial = physicalRecoveryFixture()
    const laterShipping = finalizeEvent(
      {
        kind: SHIPPING_SOURCE.kind,
        created_at: SHIPPING_SOURCE.created_at + 60,
        content: "",
        tags: SHIPPING_SOURCE.tags.map((tag) =>
          tag[0] === "price" ? ["price", "25", "SAT"] : [...tag]
        ),
      },
      MERCHANT_SECRET
    )
    let originalAvailable = false
    __setCommerceTestOverrides({
      readCheckoutSparkPlanSourceEvents: async () => ({
        events: [
          PHYSICAL_PRODUCT_SOURCE,
          PROFILE_SOURCE,
          laterShipping,
          ...(originalAvailable ? [SHIPPING_SOURCE] : []),
        ],
        coverage: "complete",
      }),
    })
    const missing = await readMerchantCheckoutSparkPlanSources(
      MERCHANT,
      initial.plan,
      () => {}
    )
    expect(missing.status).toBe("unresolved")
    originalAvailable = true
    const retained = await readMerchantCheckoutSparkPlanSources(
      MERCHANT,
      initial.plan,
      () => {}
    )
    expect(retained.status).toBe("verified")
    expect(retained.events.map((event) => event.id).sort()).toEqual(
      PHYSICAL_PLAN_SOURCES.map((event) => event.id).sort()
    )
  })

  it.each([31922, 31923] as const)(
    "recovers every exact source kind for a legacy pickup with calendar %s",
    async (calendarKind) => {
      const fixture = historicalPickupPlan(calendarKind)
      const requested: string[] = []
      const requestedKinds: number[] = []
      __setCommerceTestOverrides({
        readCheckoutSparkPlanSourceEvents: undefined,
        getRelayLists: async () => new Map(),
        fetchPublicEventsWithDiagnostics: async (filter) => {
          expect(filter.since).toBeUndefined()
          expect(filter.ids?.length).toBeGreaterThan(0)
          requested.push(...(filter.ids ?? []))
          requestedKinds.push(...(filter.kinds ?? []))
          return {
            events: fixture.sources
              .filter(
                (event) =>
                  filter.ids?.includes(event.id) &&
                  filter.kinds?.includes(event.kind) &&
                  filter.authors?.includes(event.pubkey)
              )
              .map((event) => structuredClone(event)),
            attemptedRelayUrls: [FIRST_INBOX, SECOND_INBOX],
            successfulRelayUrls: [FIRST_INBOX],
            failedRelayUrls: [SECOND_INBOX],
            cappedRelayUrls: [],
          }
        },
      })
      const read = await readMerchantCheckoutSparkPlanSources(
        MERCHANT,
        fixture.plan,
        () => {}
      )
      expect(read.status).toBe("verified")
      expect(read.coverage).toBe("partial")
      expect(read.events.map((event) => event.id).sort()).toEqual(
        fixture.sources.map((event) => event.id).sort()
      )
      expect(requested.sort()).toEqual(
        fixture.sources.map((event) => event.id).sort()
      )
      expect(requestedKinds.sort()).toEqual(
        [0, 30402, 30405, 30406, calendarKind].sort()
      )
    }
  )

  it("uses retained initial sources without a public read or available local cache", async () => {
    const { initial } = settledFixtures(true)
    let publicReads = 0
    __setCommerceTestOverrides({
      readCheckoutSparkPlanSourceEvents: async () => {
        publicReads += 1
        return { events: [], coverage: "unavailable" }
      },
    })
    const result = await readMerchantCheckoutSparkPlanSources(
      MERCHANT,
      initial.plan,
      () => {},
      undefined,
      initial.sourceEvents
    )
    expect(result.status).toBe("verified")
    expect(result.events.map((event) => event.id).sort()).toEqual(
      PLAN_SOURCES.map((event) => event.id).sort()
    )
    expect(publicReads).toBe(0)
  })

  it("uses exact historical IDs and accepts positive evidence across partial reads", async () => {
    const { initial } = settledFixtures()
    const requested: string[] = []
    __setCommerceTestOverrides({
      readCheckoutSparkPlanSourceEvents: undefined,
      getRelayLists: async () => new Map(),
      fetchPublicEventsWithDiagnostics: async (filter, options) => {
        expect(filter.authors).toEqual([MERCHANT])
        expect(filter.since).toBeUndefined()
        expect(options?.accountPubkey).toBe(MERCHANT)
        expect(options?.shouldContinue?.()).toBe(true)
        requested.push(...(filter.ids ?? []))
        return {
          events: PLAN_SOURCES.filter((event) =>
            filter.ids?.includes(event.id)
          ).map((event) => structuredClone(event)),
          attemptedRelayUrls: [FIRST_INBOX, SECOND_INBOX],
          successfulRelayUrls: [FIRST_INBOX],
          failedRelayUrls: [SECOND_INBOX],
          cappedRelayUrls: [],
        }
      },
    })
    const read = await readMerchantCheckoutSparkPlanSources(
      MERCHANT,
      initial.plan,
      () => {}
    )
    expect(read.status).toBe("verified")
    expect(read.coverage).toBe("partial")
    expect(read.events).toHaveLength(2)
    expect(requested.sort()).toEqual(
      PLAN_SOURCES.map((event) => event.id).sort()
    )
  })

  it("keeps missing historical sources unresolved until a later positive read", async () => {
    const { initial } = settledFixtures()
    __setCommerceTestOverrides({
      readCheckoutSparkPlanSourceEvents: async () => ({
        events: [PRODUCT_SOURCE],
        coverage: "partial",
      }),
    })
    expect(
      await readMerchantCheckoutSparkPlanSources(
        MERCHANT,
        initial.plan,
        () => {}
      )
    ).toEqual({
      status: "unresolved",
      events: [],
      coverage: "partial",
    })
    __setCommerceTestOverrides({
      readCheckoutSparkPlanSourceEvents: async () => ({
        events: PLAN_SOURCES,
        coverage: "partial",
      }),
    })
    expect(
      (
        await readMerchantCheckoutSparkPlanSources(
          MERCHANT,
          initial.plan,
          () => {}
        )
      ).status
    ).toBe("verified")
  })
})

describe("paginated Merchant Spark recovery discovery", () => {
  it.each(["merchant_handoff", "organizer_handoff"] as const)(
    "binds a historical %s order after resolving its exact absent-bundle graph",
    async (handoffMode) => {
      const fixture = historicalPickupPlan(31923, handoffMode)
      const { plan } = fixture
      const fulfillment = resolveCheckoutSparkSignedPickup(fixture.pickup)!
      const initial = createCheckoutSparkSettledRecoveryPayload({
        state: createCheckoutSparkSettledReconciliation(plan),
        senderPubkey: BUYER,
        mnemonic: MNEMONIC,
        accountNumber: 0,
        preparedAt: CREATED_AT + 1_000,
      })
      const order = new NDKEvent()
      order.kind = 16
      order.pubkey = BUYER
      order.created_at = CREATED_AT / 1_000
      order.tags = [
        ["p", MERCHANT],
        ["type", "order"],
        ["order", plan.orderId],
        ["amount", String(plan.commerceQuote.commerceTotalSats)],
        ["currency", "SATS"],
        ["item", fixture.pickup.line.productCoordinate, "1"],
        ["shipping", fulfillment.option.coordinate],
        [...CHECKOUT_SPARK_ROUTER_ORDER_TAG],
      ]
      order.content = JSON.stringify({
        id: plan.orderId,
        buyerPubkey: BUYER,
        buyerIdentityKind: "signed_in",
        merchantPubkey: MERCHANT,
        items: [
          {
            productId: fixture.pickup.line.productCoordinate,
            format: "physical",
            fulfillment,
            quantity: 1,
            priceAtPurchase: fixture.pickup.line.unitMerchandiseSats,
            currency: "SATS",
            shippingCostSats: fulfillment.costSats,
            sourceShippingCost: fulfillment.sourceCost,
            shippingOptionId: fulfillment.option.coordinate,
            shippingOptionDTag: "booth",
            shippingCountries: [],
            shippingCountryRules: [],
          },
        ],
        subtotal: plan.commerceQuote.commerceTotalSats,
        currency: "SATS",
        shippingCostSats: fulfillment.costSats,
        shippingCostStatus: "priced",
        createdAt: CREATED_AT,
      })
      order.id = order.getEventHash()
      expect(readCheckoutSparkMerchantOrderEvidence(order)).not.toBeNull()
      const initialWrap = wrap(2)
      const orderWrap = wrap(1)
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [FIRST_INBOX],
        readProtectedInbox: async () => protectedRead([initialWrap, orderWrap]),
        giftUnwrap: async (event) =>
          event.id === initialWrap.id
            ? buildCheckoutSparkRecoveryRumor(initial)
            : order,
        readCheckoutSparkPlanSourceEvents: async () => ({
          events: fixture.sources,
          coverage: "partial",
        }),
      })
      let bound = false
      const session = await createMerchantCheckoutSparkRecoveryDiscovery(
        MERCHANT,
        {
          async onOrderRecovery({ witness, sourceEvents, assertCurrent }) {
            assertCurrent()
            expect(witness.planDigest).toBe(plan.planDigest)
            expect(witness.rumorId).toBe(order.id)
            expect(sourceEvents.map((event) => event.id).sort()).toEqual(
              fixture.sources.map((event) => event.id).sort()
            )
            bound = true
          },
        }
      )
      try {
        const result = await session.nextPage()
        expect(result.orderBindingFailureCount).toBeUndefined()
        expect(bound).toBe(true)
      } finally {
        session.dispose()
      }
    }
  )

  it("binds an authenticated physical order using fallback historical sources before witness construction", async () => {
    const initial = physicalRecoveryFixture()
    const initialWrap = wrap(2)
    const orderWrap = wrap(1)
    const order = orderRumor({ physical: true })
    expect(readCheckoutSparkMerchantOrderEvidence(order)).not.toBeNull()
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead([initialWrap, orderWrap]),
      giftUnwrap: async (event) =>
        event.id === initialWrap.id
          ? buildCheckoutSparkRecoveryRumor(initial)
          : order,
      readCheckoutSparkPlanSourceEvents: async () => ({
        events: PHYSICAL_PLAN_SOURCES,
        coverage: "partial",
      }),
    })
    const saved: string[] = []
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        async onOrderRecovery({ witness, sourceEvents, assertCurrent }) {
          assertCurrent()
          expect(sourceEvents.map((event) => event.id).sort()).toEqual(
            PHYSICAL_PLAN_SOURCES.map((event) => event.id).sort()
          )
          expect(witness.planDigest).toBe(initial.plan.planDigest)
          saved.push(witness.rumorId)
        },
      }
    )
    try {
      const result = await session.nextPage()
      expect(result.candidates).toHaveLength(1)
      expect(saved).toEqual([order.id])
      expect(result.orderBindingFailureCount).toBeUndefined()
    } finally {
      session.dispose()
    }
  })

  it("admits later progress from the initial private source bundle after public history is pruned", async () => {
    const { initial, progress, credited } = settledFixtures(true)
    const initialWrap = wrap(2)
    const progressWrap = wrap(3)
    const orderWrap = wrap(1)
    let publicReads = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () =>
        protectedRead([progressWrap, initialWrap, orderWrap]),
      giftUnwrap: async (event) =>
        event.id === initialWrap.id
          ? buildCheckoutSparkRecoveryRumor(initial)
          : event.id === progressWrap.id
            ? buildCheckoutSparkRecoveryRumor(progress)
            : orderRumor(),
      readCheckoutSparkPlanSourceEvents: async () => {
        publicReads += 1
        return { events: [], coverage: "unavailable" }
      },
    })
    let saves = 0
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        async onOrderRecovery({ state, sourceEvents, assertCurrent }) {
          assertCurrent()
          expect(state).toEqual(credited)
          expect(sourceEvents.map((event) => event.id).sort()).toEqual(
            PLAN_SOURCES.map((event) => event.id).sort()
          )
          saves += 1
        },
      }
    )
    try {
      const result = await session.nextPage()
      expect(result.candidates).toHaveLength(1)
      expect(result.orderBindingFailureCount).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain(PRODUCT_SOURCE.content)
      expect(JSON.stringify(result)).not.toContain(PROFILE_SOURCE.content)
      expect(saves).toBe(1)
      expect(publicReads).toBe(0)
    } finally {
      session.dispose()
    }
  })

  it("retains the order and retries source discovery before admitting it locally", async () => {
    const { initial } = settledFixtures()
    const initialWrap = wrap(2)
    const orderWrap = wrap(1)
    let sourcesAvailable = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead([initialWrap, orderWrap]),
      giftUnwrap: async (event) =>
        event.id === initialWrap.id
          ? buildCheckoutSparkRecoveryRumor(initial)
          : orderRumor(),
      readCheckoutSparkPlanSourceEvents: async () => ({
        events: sourcesAvailable ? PLAN_SOURCES : [PRODUCT_SOURCE],
        coverage: "partial",
      }),
    })
    let saves = 0
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        async onOrderRecovery({ sourceEvents, assertCurrent }) {
          assertCurrent()
          expect(sourceEvents.map((event) => event.id).sort()).toEqual(
            PLAN_SOURCES.map((event) => event.id).sort()
          )
          saves += 1
        },
      }
    )
    const waiting = await session.nextPage()
    expect(waiting.candidates).toHaveLength(1)
    expect(waiting.orderBindingFailureCount).toBe(1)
    expect(saves).toBe(0)
    sourcesAvailable = true
    session.restartScan()
    const recovered = await session.nextPage()
    expect(recovered.orderBindingFailureCount).toBeUndefined()
    expect(saves).toBe(1)
    session.dispose()
  })

  it("does not admit recovery after the account changes during source discovery", async () => {
    const { initial } = settledFixtures()
    const initialWrap = wrap(2)
    const orderWrap = wrap(1)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead([initialWrap, orderWrap]),
      giftUnwrap: async (event) =>
        event.id === initialWrap.id
          ? buildCheckoutSparkRecoveryRumor(initial)
          : orderRumor(),
      readCheckoutSparkPlanSourceEvents: async () => {
        __resetProtectedReadSigner()
        await Promise.resolve()
        return { events: PLAN_SOURCES, coverage: "complete" }
      },
    })
    let saves = 0
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        async onOrderRecovery() {
          saves += 1
        },
      }
    )
    await expect(session.nextPage()).rejects.toThrow("authority changed")
    expect(saves).toBe(0)
    session.dispose()
  })

  it("privately binds an authenticated order to recovery across history pages", async () => {
    const { initial, progress } = settledFixtures()
    const initialWrap = wrap(2)
    const progressWrap = wrap(51)
    const orderWrap = wrap(1)
    const order = orderRumor({ note: "private fixture note" })
    const unrelated = Array.from({ length: 48 }, (_, index) => wrap(index + 3))
    const all = [progressWrap, ...unrelated, initialWrap, orderWrap]
    const rumors = new Map([
      [initialWrap.id, buildCheckoutSparkRecoveryRumor(initial)],
      [progressWrap.id, buildCheckoutSparkRecoveryRumor(progress)],
      [orderWrap.id, order],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          all
            .filter(
              (event) =>
                (options.since === undefined ||
                  event.created_at >= options.since) &&
                (options.until === undefined ||
                  event.created_at <= options.until)
            )
            .sort((left, right) => right.created_at - left.created_at)
            .slice(0, options.limit)
        ),
      giftUnwrap: async (event) => rumors.get(event.id) ?? new NDKEvent(),
    })
    const persisted: unknown[] = []
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        async onOrderRecovery({ state, witness, assertCurrent }) {
          assertCurrent()
          persisted.push({ state, witness })
        },
      }
    )
    const first = await session.nextPage()
    expect(first.history.hasMore).toBe(true)
    expect(persisted).toHaveLength(0)
    const last = await session.nextPage()
    expect(persisted).toMatchObject([
      {
        state: progress.state,
        witness: {
          buyerPubkey: BUYER,
          merchantPubkey: MERCHANT,
          orderId: initial.plan.orderId,
          rumorId: order.id,
          checkoutId: initial.plan.checkoutId,
          planDigest: initial.plan.planDigest,
        },
      },
    ])
    expect(JSON.stringify(persisted)).not.toContain(initial.wallet.mnemonic)
    expect(JSON.stringify(persisted)).not.toContain("private fixture note")
    expect(JSON.stringify(last)).not.toContain("contentHash")
    expect(JSON.stringify(last)).not.toContain(order.id)
    session.restartScan()
    await session.nextPage()
    await session.nextPage()
    expect(persisted).toHaveLength(1)
    session.dispose()
  })

  for (const variant of [
    "other_buyer",
    "changed_amount",
    "duplicate_order",
  ] as const) {
    it(`does not bind ${variant} to a recovery plan`, async () => {
      const { initial } = settledFixtures()
      const initialWrap = wrap(3)
      const orderWrap = wrap(2)
      const extraWrap = wrap(1)
      const order = orderRumor(
        variant === "other_buyer"
          ? { buyer: getPublicKey(generateSecretKey()) }
          : variant === "changed_amount"
            ? { amount: 11 }
            : {}
      )
      const rumors = new Map([
        [initialWrap.id, buildCheckoutSparkRecoveryRumor(initial)],
        [orderWrap.id, order],
        [extraWrap.id, orderRumor({ note: "different signed order" })],
      ])
      __setCommerceTestOverrides({
        resolveInboxRelayUrls: async () => [FIRST_INBOX],
        readProtectedInbox: async () =>
          protectedRead([
            initialWrap,
            orderWrap,
            ...(variant === "duplicate_order" ? [extraWrap] : []),
          ]),
        giftUnwrap: async (event) => rumors.get(event.id) ?? null,
      })
      let saves = 0
      const session = await createMerchantCheckoutSparkRecoveryDiscovery(
        MERCHANT,
        {
          async onOrderRecovery() {
            saves += 1
          },
        }
      )
      expect((await session.nextPage()).candidates).toHaveLength(1)
      expect(saves).toBe(0)
      session.dispose()
    })
  }

  it("deduplicates one order rumor wrapped separately on sibling relays", async () => {
    const { initial } = settledFixtures()
    const initialWrap = wrap(3)
    const firstOrder = wrap(2)
    const secondOrder = wrap(1)
    const order = orderRumor()
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX, SECOND_INBOX],
      readProtectedInbox: async (options) =>
        protectedRead([
          initialWrap,
          options.relayUrls[0] === FIRST_INBOX ? firstOrder : secondOrder,
        ]),
      giftUnwrap: async (event) =>
        event.id === initialWrap.id
          ? buildCheckoutSparkRecoveryRumor(initial)
          : order,
    })
    let saves = 0
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        async onOrderRecovery() {
          saves += 1
        },
      }
    )
    await session.nextPage()
    await session.nextPage()
    expect(saves).toBe(1)
    session.dispose()
  })

  it("stops local persistence when the active account changes during its await", async () => {
    const { initial } = settledFixtures()
    const initialWrap = wrap(2)
    const orderWrap = wrap(1)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead([initialWrap, orderWrap]),
      giftUnwrap: async (event) =>
        event.id === initialWrap.id
          ? buildCheckoutSparkRecoveryRumor(initial)
          : orderRumor(),
    })
    let checked = false
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        async onOrderRecovery({ assertCurrent }) {
          __resetProtectedReadSigner()
          await Promise.resolve()
          assertCurrent()
          checked = true
        },
      }
    )
    await expect(session.nextPage()).rejects.toThrow("authority changed")
    expect(checked).toBe(false)
    session.dispose()
  })

  it("keeps discovery usable when a local binding save fails and retries it", async () => {
    const { initial } = settledFixtures()
    const initialWrap = wrap(2)
    const orderWrap = wrap(1)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead([initialWrap, orderWrap]),
      giftUnwrap: async (event) =>
        event.id === initialWrap.id
          ? buildCheckoutSparkRecoveryRumor(initial)
          : orderRumor(),
    })
    let attempts = 0
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(
      MERCHANT,
      {
        async onOrderRecovery({ assertCurrent }) {
          assertCurrent()
          attempts += 1
          if (attempts === 1)
            throw new Error("Synthetic local save unavailable")
        },
      }
    )
    const first = await session.nextPage()
    expect(first.candidates).toHaveLength(1)
    expect(first.orderBindingFailureCount).toBe(1)
    session.restartScan()
    const next = await session.nextPage()
    expect(next.candidates).toHaveLength(1)
    expect(next.orderBindingFailureCount).toBeUndefined()
    expect(attempts).toBe(2)
    session.dispose()
  })

  it("pairs progress found before its initial on a later signed relay page", async () => {
    const { initial, progress } = settledFixtures()
    const initialWrap = wrap(1)
    const progressWrap = wrap(51)
    const unrelated = Array.from({ length: 49 }, (_, index) => wrap(index + 2))
    const all = [progressWrap, ...unrelated, initialWrap]
    const rumors = new Map([
      [initialWrap.id, buildCheckoutSparkRecoveryRumor(initial)],
      [progressWrap.id, buildCheckoutSparkRecoveryRumor(progress)],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          all
            .filter(
              (event) =>
                (options.since === undefined ||
                  event.created_at >= options.since) &&
                (options.until === undefined ||
                  event.created_at <= options.until)
            )
            .sort((left, right) => right.created_at - left.created_at)
            .slice(0, options.limit)
        ),
      giftUnwrap: async (event) => rumors.get(event.id) ?? new NDKEvent(),
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    const first = await session.nextPage()
    expect(first.candidates).toEqual([])
    expect(first.coverage).toBe("partial")
    expect(first.history).toEqual({
      hasMore: true,
      pageStatus: "advanced",
      retentionLimitReached: false,
    })
    const second = await session.nextPage()
    expect(second.candidates).toMatchObject([
      {
        wrapId: progressWrap.id,
        initialWrapId: initialWrap.id,
        schemaVersion: 3,
      },
    ])
    expect(second.coverage).toBe("partial")
    expect(second.history).toEqual({
      hasMore: false,
      pageStatus: "source_eose",
      retentionLimitReached: false,
    })
    expect(JSON.stringify(second)).not.toContain(
      "synthetic history-only wallet"
    )
    session.dispose()
  })

  it("continues beyond eight clean pages to older recoveries", async () => {
    const { initial } = settledFixtures()
    const initialWrap = wrap(1)
    const all = [
      ...Array.from({ length: 450 }, (_, index) => wrap(index + 2)),
      initialWrap,
    ]
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          all
            .filter(
              (event) =>
                (options.since === undefined ||
                  event.created_at >= options.since) &&
                (options.until === undefined ||
                  event.created_at <= options.until)
            )
            .sort((left, right) => right.created_at - left.created_at)
            .slice(0, options.limit)
        ),
      giftUnwrap: async (event) =>
        event.id === initialWrap.id
          ? buildCheckoutSparkRecoveryRumor(initial)
          : new NDKEvent(),
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    for (let index = 0; index < 9; index += 1) {
      const page = await session.nextPage()
      expect(page.history.pageStatus).toBe("advanced")
      expect(page.history.hasMore).toBe(true)
      expect(page.candidates).toEqual([])
    }
    const last = await session.nextPage()
    expect(last.history.pageStatus).toBe("source_eose")
    expect(last.history.hasMore).toBe(false)
    expect(last.candidates[0]?.wrapId).toBe(initialWrap.id)
    expect(last.coverage).toBe("partial")
    session.dispose()
  })

  it("accepts a later advancing full v2 snapshot with a different handoff ID", async () => {
    const { initial, credited } = settledFixtures()
    const later = createCheckoutSparkSettledRecoveryPayload({
      state: credited,
      senderPubkey: BUYER,
      mnemonic: initial.wallet.mnemonic,
      accountNumber: initial.wallet.accountNumber,
      preparedAt: CREATED_AT + 3_000,
    })
    expect(later.handoffId).not.toBe(initial.handoffId)
    const initialWrap = wrap(1)
    const laterWrap = wrap(51)
    const all = [
      laterWrap,
      ...Array.from({ length: 49 }, (_, index) => wrap(index + 2)),
      initialWrap,
    ]
    const rumors = new Map([
      [initialWrap.id, buildCheckoutSparkRecoveryRumor(initial)],
      [laterWrap.id, buildCheckoutSparkRecoveryRumor(later)],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          all
            .filter(
              (event) =>
                (options.since === undefined ||
                  event.created_at >= options.since) &&
                (options.until === undefined ||
                  event.created_at <= options.until)
            )
            .sort((left, right) => right.created_at - left.created_at)
            .slice(0, options.limit)
        ),
      giftUnwrap: async (event) => rumors.get(event.id) ?? new NDKEvent(),
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    expect((await session.nextPage()).candidates[0]?.wrapId).toBe(laterWrap.id)
    const completed = await session.nextPage()
    expect(completed.candidates[0]?.wrapId).toBe(laterWrap.id)
    expect(completed.conflictCount).toBe(0)
    session.dispose()
  })

  it("binds v3 progress to the latest advancing full v2 snapshot", async () => {
    const { initial, credited } = settledFixtures()
    const later = createCheckoutSparkSettledRecoveryPayload({
      state: credited,
      senderPubkey: BUYER,
      mnemonic: initial.wallet.mnemonic,
      accountNumber: initial.wallet.accountNumber,
      preparedAt: CREATED_AT + 3_000,
    })
    const progress = createCheckoutSparkSettledRecoveryProgressPayload({
      initialHandoffId: later.handoffId,
      state: credited,
      senderPubkey: BUYER,
      preparedAt: CREATED_AT + 4_000,
    })
    const firstWrap = wrap(1)
    const laterWrap = wrap(2)
    const progressWrap = wrap(51)
    const all = [
      progressWrap,
      ...Array.from({ length: 49 }, (_, index) => wrap(index + 3, "unrelated")),
      laterWrap,
      firstWrap,
    ]
    const rumors = new Map([
      [firstWrap.id, buildCheckoutSparkRecoveryRumor(initial)],
      [laterWrap.id, buildCheckoutSparkRecoveryRumor(later)],
      [progressWrap.id, buildCheckoutSparkRecoveryRumor(progress)],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          all
            .filter(
              (event) =>
                (options.since === undefined ||
                  event.created_at >= options.since) &&
                (options.until === undefined ||
                  event.created_at <= options.until)
            )
            .sort((left, right) => right.created_at - left.created_at)
            .slice(0, options.limit)
        ),
      giftUnwrap: async (event) => rumors.get(event.id) ?? new NDKEvent(),
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    const first = await session.nextPage()
    expect(first.candidates).toEqual([])
    const second = await session.nextPage()
    expect(second.candidates[0]).toMatchObject({
      wrapId: progressWrap.id,
      initialWrapId: laterWrap.id,
      initialHandoffId: later.handoffId,
    })
    expect(second.conflictCount).toBe(0)
    session.dispose()
  })

  it("rescans for a new progress wrap without forgetting the earlier wallet wrap", async () => {
    const { initial, progress } = settledFixtures()
    const initialWrap = wrap(1)
    const progressWrap = wrap(2)
    const events = [initialWrap]
    const rumors = new Map([
      [initialWrap.id, buildCheckoutSparkRecoveryRumor(initial)],
      [progressWrap.id, buildCheckoutSparkRecoveryRumor(progress)],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead(events),
      giftUnwrap: async (event) => rumors.get(event.id) ?? null,
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    const first = await session.nextPage()
    expect(first.candidates[0]?.wrapId).toBe(initialWrap.id)
    expect(first.history.hasMore).toBe(false)
    session.restartScan()
    events.unshift(progressWrap)
    const later = await session.nextPage()
    expect(later.candidates[0]).toMatchObject({
      wrapId: progressWrap.id,
      initialWrapId: initialWrap.id,
    })
    expect(later.conflictCount).toBe(0)
    session.dispose()
  })

  it("does not call a later empty rescan complete while retaining an earlier candidate", async () => {
    const { initial } = settledFixtures()
    const initialWrap = wrap(1)
    let events = [initialWrap]
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead(events),
      giftUnwrap: async () => buildCheckoutSparkRecoveryRumor(initial),
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    expect((await session.nextPage()).coverage).toBe("complete")
    session.restartScan()
    events = []
    const later = await session.nextPage()
    expect(later.candidates[0]?.wrapId).toBe(initialWrap.id)
    expect(later.coverage).toBe("partial")
    session.dispose()
  })

  it("stops at the private retention bound without erasing observed conflicts", async () => {
    const { initial } = settledFixtures()
    const conflict = createCheckoutSparkSettledRecoveryPayload({
      state: createCheckoutSparkSettledReconciliation(initial.plan),
      senderPubkey: BUYER,
      mnemonic: CONFLICT_MNEMONIC,
      accountNumber: 0,
      preparedAt: CREATED_AT + 4_000,
    })
    const all = Array.from({ length: 513 }, (_, index) => wrap(index + 1))
    const conflictWrapId = all[511]!.id
    // The mocked decrypt boundary returns two exact rumors, not 513 newly
    // reconstructed copies. All 513 distinct signed outer wraps still reach discovery.
    const initialRumor = buildCheckoutSparkRecoveryRumor(initial)
    const conflictRumor = buildCheckoutSparkRecoveryRumor(conflict)
    let readCount = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async (options) => {
        readCount += 1
        return protectedRead(
          all
            .filter(
              (event) =>
                (options.since === undefined ||
                  event.created_at >= options.since) &&
                (options.until === undefined ||
                  event.created_at <= options.until)
            )
            .sort((left, right) => right.created_at - left.created_at)
            .slice(0, options.limit)
        )
      },
      giftUnwrap: async (event) =>
        event.id === conflictWrapId ? conflictRumor : initialRumor,
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    let result = await session.nextPage()
    for (let index = 0; result.history.hasMore && index < 20; index += 1) {
      result = await session.nextPage()
    }
    expect(result.history).toMatchObject({
      hasMore: false,
      pageStatus: "capped",
      retentionLimitReached: true,
    })
    expect(result.coverage).toBe("partial")
    expect(result.conflictCount).toBe(1)
    const before = readCount
    expect((await session.nextPage()).history.retentionLimitReached).toBe(true)
    expect(readCount).toBe(before)
    expect(() => session.restartScan()).toThrow("retention limit")
    session.dispose()
  }, 20_000)

  it("expires a dormant session without another relay read or restart", async () => {
    let readCount = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => {
        readCount += 1
        return protectedRead([])
      },
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    const originalNow = Date.now
    const createdAt = originalNow()
    try {
      Date.now = () => createdAt + 31 * 60_000
      await expect(session.nextPage()).rejects.toThrow("expired")
      expect(readCount).toBe(0)
      expect(() => session.restartScan()).toThrow("authority changed")
    } finally {
      Date.now = originalNow
      session.dispose()
    }
  })

  it("does not read an inbox after aborting a held signer lookup", async () => {
    let releaseUser!: (user: NDKUser) => void
    const heldUser = new Promise<NDKUser>((resolve) => {
      releaseUser = resolve
    })
    let userStarted!: () => void
    const started = new Promise<void>((resolve) => {
      userStarted = resolve
    })
    let readCount = 0
    __setCommerceTestOverrides({
      getAccountSigner: () =>
        plainTestSigner({
          user: async () => {
            userStarted()
            return await heldUser
          },
        } as NDKSigner as never),
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => {
        readCount += 1
        return protectedRead([])
      },
    })
    const controller = new AbortController()
    const opening = createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT, {
      signal: controller.signal,
    })
    await started
    controller.abort()
    releaseUser(new NDKUser({ pubkey: MERCHANT }))
    await expect(opening).rejects.toThrow("cancelled")
    expect(readCount).toBe(0)
  })

  it("does not read an inbox after aborting a held declaration lookup", async () => {
    let releaseDeclaration!: () => void
    const heldDeclaration = new Promise<void>((resolve) => {
      releaseDeclaration = resolve
    })
    let declarationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      declarationStarted = resolve
    })
    let readCount = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => {
        declarationStarted()
        await heldDeclaration
        return [FIRST_INBOX]
      },
      readProtectedInbox: async () => {
        readCount += 1
        return protectedRead([])
      },
    })
    const controller = new AbortController()
    const opening = createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT, {
      signal: controller.signal,
    })
    await started
    controller.abort()
    releaseDeclaration()
    await expect(opening).rejects.toThrow("cancelled")
    expect(readCount).toBe(0)
  })

  it("retains an observed conflict even when a later sweep omits its wrap", async () => {
    const { initial } = settledFixtures()
    const firstWrap = wrap(1)
    const conflictWrap = wrap(2)
    let events = [firstWrap, conflictWrap]
    const conflict = createCheckoutSparkSettledRecoveryPayload({
      state: createCheckoutSparkSettledReconciliation(initial.plan),
      senderPubkey: BUYER,
      mnemonic: OTHER_CONFLICT_MNEMONIC,
      accountNumber: 0,
      preparedAt: CREATED_AT + 4_000,
    })
    const rumors = new Map([
      [firstWrap.id, buildCheckoutSparkRecoveryRumor(initial)],
      [conflictWrap.id, buildCheckoutSparkRecoveryRumor(conflict)],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead(events),
      giftUnwrap: async (event) => rumors.get(event.id) ?? null,
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    expect((await session.nextPage()).conflictCount).toBe(1)
    session.restartScan()
    events = [firstWrap]
    const later = await session.nextPage()
    expect(later.candidates).toEqual([])
    expect(later.conflictCount).toBe(1)
    session.dispose()
  })

  it("retries a failed unwrap on a later sweep and clears its failure count", async () => {
    const { initial } = settledFixtures()
    const initialWrap = wrap(1)
    let canDecrypt = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead([initialWrap]),
      giftUnwrap: async () =>
        canDecrypt ? buildCheckoutSparkRecoveryRumor(initial) : null,
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    const failed = await session.nextPage()
    expect(failed.decryptFailureCount).toBe(1)
    expect(failed.candidates).toEqual([])
    session.restartScan()
    canDecrypt = true
    const recovered = await session.nextPage()
    expect(recovered.decryptFailureCount).toBe(0)
    expect(recovered.candidates[0]?.wrapId).toBe(initialWrap.id)
    session.dispose()
  })

  it("retains a healthy relay's candidate while a sibling is unavailable", async () => {
    const { initial } = settledFixtures()
    const initialWrap = wrap(1)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX, SECOND_INBOX],
      readProtectedInbox: async (options) =>
        options.relayUrls[0] === FIRST_INBOX
          ? protectedRead([initialWrap])
          : protectedRead([], "unavailable"),
      giftUnwrap: async () => buildCheckoutSparkRecoveryRumor(initial),
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    expect((await session.nextPage()).candidates).toHaveLength(1)
    const sibling = await session.nextPage()
    expect(sibling.candidates).toHaveLength(1)
    expect(sibling.coverage).toBe("partial")
    expect(sibling.history.hasMore).toBe(true)
    await session.nextPage()
    const exhausted = await session.nextPage()
    expect(exhausted.history.hasMore).toBe(false)
    expect(exhausted.candidates).toHaveLength(1)
    session.dispose()
  })

  it("deduplicates cross-relay wraps and quarantines conflicting wallet authority", async () => {
    const { initial } = settledFixtures()
    const first = wrap(1)
    const second = wrap(2)
    const conflict = createCheckoutSparkSettledRecoveryPayload({
      state: createCheckoutSparkSettledReconciliation(initial.plan),
      senderPubkey: BUYER,
      mnemonic: LATER_CONFLICT_MNEMONIC,
      accountNumber: 0,
      preparedAt: CREATED_AT + 4_000,
    })
    const rumors = new Map([
      [first.id, buildCheckoutSparkRecoveryRumor(initial)],
      [second.id, buildCheckoutSparkRecoveryRumor(conflict)],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX, SECOND_INBOX],
      readProtectedInbox: async (options) =>
        protectedRead(
          options.relayUrls[0] === FIRST_INBOX ? [first] : [first, second]
        ),
      giftUnwrap: async (event) => rumors.get(event.id) ?? null,
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    expect((await session.nextPage()).candidates).toHaveLength(1)
    const final = await session.nextPage()
    expect(final.candidates).toEqual([])
    expect(final.conflictCount).toBe(1)
    expect(final.coverage).toBe("partial")
    session.dispose()
  })

  it("rejects an account switch and clears a disposed session", async () => {
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [FIRST_INBOX],
      readProtectedInbox: async () => protectedRead([]),
    })
    const session = await createMerchantCheckoutSparkRecoveryDiscovery(MERCHANT)
    __resetProtectedReadSigner()
    await expect(session.nextPage()).rejects.toThrow("authority changed")
    await expect(session.nextPage()).rejects.toThrow("authority changed")
    session.dispose()
  })
})

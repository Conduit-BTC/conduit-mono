import * as eventMarketProtocol from "../packages/core/src/protocol/event-market"
import { installMerchantAcceptanceTestSession } from "./helpers/merchant-acceptance-session"
import { __resetProtectedReadSigner } from "../packages/core/src/protocol/protected-read-authorization"
import { openMerchantAcceptanceEvidence } from "../packages/core/src/protocol/merchant-acceptance-privacy"
import { buildCheckoutPricingIntent } from "../apps/market/src/lib/checkout-payment"
import { beforeEach, afterEach, expect, it, spyOn } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { matchFilter, type Filter } from "nostr-tools"
import type { SignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"
import { db } from "../packages/core/src/db"
import { orderSchema, type ProductSchema } from "../packages/core/src/schemas"
import { admitFixtureEvent } from "./helpers/admit-event"
import { parseProductEvent } from "../packages/core/src/protocol/products"
import { projectSignedProductListingForLocalCommit } from "../packages/core/src/protocol/commerce"
import {
  initializeMerchantInventoryProduct,
  commitMerchantInventoryAssignment,
} from "../packages/core/src/protocol/merchant-inventory"
import { computeEventMarketAssignmentDTag } from "../packages/core/src/protocol/event-market-assignment"
import {
  buildEventMarketCalendarDraft,
  parseEventMarketCalendarEvent,
} from "../packages/core/src/protocol/event-market"
import { acceptMerchantOccurrenceOrder } from "../packages/core/src/protocol/merchant-occurrence-workflow"
import { commitLocalProductWrite } from "../packages/core/src/protocol/local-product-write"
import { prepareProductListingDeliveryJob } from "../packages/core/src/protocol/product-listing-delivery"
import {
  readEventMarketRoster,
  readEventMarketProduct,
  readEventMarketCatalog,
  retainEventMarketCommerceEvidence,
} from "../packages/core/src/protocol/event-market-roster-read"
import { createEventMarketOrderFixture as createSignedFixture } from "./helpers/event-market-order-fixture"

function createEventMarketOrderFixture(
  options: Parameters<typeof createSignedFixture>[0]
) {
  const fixture = createSignedFixture(options)
  installMerchantAcceptanceTestSession(fixture.merchant)
  return fixture
}

const secret = generateSecretKey()
const merchant = getPublicKey(secret)
let restore: () => void
beforeEach(async () => {
  installMerchantAcceptanceTestSession(merchant)
  const deps = (db as unknown as { _deps: Record<string, unknown> })._deps
  const previous = { ...deps }
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (
          name: string,
          run: (lock: { name: string }) => Promise<unknown>
        ) => run({ name }),
      },
    },
  })
  db.close({ disableAutoOpen: false })
  Object.assign(deps, { indexedDB: new IDBFactory(), IDBKeyRange })
  restore = () => {
    db.close({ disableAutoOpen: false })
    Object.assign(deps, previous)
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
  await db.open()
})
afterEach(() => {
  restore()
  __resetProtectedReadSigner()
})
function listing(
  d: string,
  stock = 10,
  price = 10,
  currency = "SATS",
  at = 100
) {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: at,
      content: "",
      tags: [
        ["d", d],
        ["title", "Synthetic product"],
        ["type", "simple", "digital"],
        ["price", String(price), currency],
        ["stock", String(stock)],
      ],
    },
    secret
  )
}
async function setup(event: ReturnType<typeof listing>) {
  const verified = await admitFixtureEvent(event)
  const product = parseProductEvent(verified)
  await db.products.put(projectSignedProductListingForLocalCommit(verified))
  await initializeMerchantInventoryProduct({
    db,
    merchantPubkey: merchant,
    productCoordinate: product.id,
    stock: product.stock,
    signedProductEvent: event,
  })
  return product
}
function order(products: ProductSchema[], id = "regression-order") {
  return orderSchema.parse({
    id,
    buyerPubkey: "a".repeat(64),
    merchantPubkey: merchant,
    items: products.map((p) => ({
      productId: p.id,
      title: p.title,
      format: p.format,
      fulfillment: { type: "digital" },
      quantity: 1,
      priceAtPurchase: p.currency === "USD" ? 10000 : p.price,
      currency: "SATS",
      sourcePrice: p.sourcePrice ?? {
        amount: p.price,
        currency: p.currency,
        normalizedCurrency: p.currency,
      },
    })),
    subtotal: products.reduce(
      (sum, p) => sum + (p.currency === "USD" ? 10000 : p.price),
      0
    ),
    currency: "SATS",
    createdAt: Date.now(),
  })
}
const session = {
  merchantPubkey: merchant,
  authenticatedPubkey: merchant,
  shouldContinue: () => true,
}
function job(event: ReturnType<typeof listing>) {
  return prepareProductListingDeliveryJob({
    merchantPubkey: merchant,
    signedEvents: [event],
    relayTargets: [
      {
        relayUrl: "wss://relay.conduit.market",
        ownerSelected: false,
        personalRelay: true,
      },
    ],
    readyForDelivery: false,
  })
}
it("unchanged fiat source-priced checkout order can be accepted", async () => {
  const p = await setup(listing("fiat", 10, 10, "USD"))
  const paidOrder = order([p])
  const result = await acceptMerchantOccurrenceOrder({
    ...session,
    order: paidOrder,
    products: [p],
  }).then(
    () => ({ accepted: true }),
    (e) => ({ accepted: false, error: e.message })
  )
  expect(result.accepted).toBe(true)
})
it("already-applied stock action and acceptance consume only once across reload", async () => {
  const original = listing("stock-once")
  const p = await setup(original)
  const purchase = order([p], "already-stocked")
  const next = listing("stock-once", 9, 10, "SATS", 101)
  await commitLocalProductWrite({
    intentId: "manual-stock-action",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: p.id, eventId: original.id }],
    listingJob: job(next),
    stock: {
      orderId: purchase.id,
      adjustment: {
        key: `${encodeURIComponent(purchase.id)}:${encodeURIComponent(p.id)}`,
        addressId: p.id,
        sourceEventId: original.id,
        title: p.title,
        quantity: 1,
        currentStock: 10,
        nextStock: 9,
        shortfall: 0,
      },
    },
  })
  expect(await db.localProductStockCheckpoints.count()).toBe(1)
  expect((await db.merchantInventoryProducts.get(p.id))?.stock).toBe(9)
  db.close({ disableAutoOpen: false })
  await db.open()
  await acceptMerchantOccurrenceOrder({
    ...session,
    order: purchase,
    products: [parseProductEvent(await admitFixtureEvent(next))],
  })
  const stock = (await db.merchantInventoryProducts.get(p.id))?.stock
  expect(stock).toBe(9)
})
it("material product change while a later item loads rejects atomic acceptance", async () => {
  const first = listing("race-first")
  const second = listing("race-second")
  const a = await setup(first),
    b = await setup(second)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((r) => (enter = r)),
    held = new Promise<void>((r) => (release = r))
  const originalGet = db.merchantInventoryProducts.get.bind(
    db.merchantInventoryProducts
  )
  let stopped = false
  const probe = spyOn(db.merchantInventoryProducts, "get").mockImplementation(
    async (key: Parameters<typeof originalGet>[0]) => {
      if (key === b.id && !stopped) {
        stopped = true
        enter()
        await held
      }
      return originalGet(key)
    }
  )
  const pending = acceptMerchantOccurrenceOrder({
    ...session,
    order: order([a, b], "concurrent-change"),
    products: [a, b],
  }).then(
    () => true,
    () => false
  )
  await entered
  try {
    const changed = listing("race-first", 10, 11, "SATS", 101)
    await commitLocalProductWrite({
      intentId: "concurrent-price-edit",
      merchantPubkey: merchant,
      expectedRevisions: [{ addressId: a.id, eventId: first.id }],
      listingJob: job(changed),
    })
  } finally {
    release()
  }
  const accepted = await pending
  probe.mockRestore()
  expect(accepted).toBe(false)
  expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
  expect((await db.merchantInventoryProducts.get(a.id))?.stock).toBe(10)
  expect((await db.merchantInventoryProducts.get(b.id))?.stock).toBe(10)
})
function source(initial: readonly SignedPublicNostrEvent[]) {
  let events = initial
  const retained = new Map<string, SignedPublicNostrEvent>()
  return {
    set(next: readonly SignedPublicNostrEvent[]) {
      events = next
    },
    deps: {
      plan: async () => ({
        relayUrls: ["wss://fixture.example"],
        candidateRelayUrls: ["wss://fixture.example"],
        maxRelayAttempts: 1,
        ownerSelectedRelayUrls: [],
        appRelayUrls: ["wss://fixture.example"],
        personalRelayUrls: [],
        independentRelayUrls: [],
        relayListState: "missing" as const,
        relayHintTruncated: false,
      }),
      fetch: async (filter: Filter) => ({
        events: events.filter((e) => matchFilter(filter, e)),
        relays: [
          { relayUrl: "wss://fixture.example", status: "success" as const },
        ],
      }),
      load: async () => [...retained.values()],
      retain: async (
        _coordinate: string,
        rows: readonly SignedPublicNostrEvent[]
      ) => {
        for (const e of rows) retained.set(e.id, e)
      },
    },
  }
}
for (const kind of ["hidden", "deleted", "deleted_by_id"])
  it(`observed ${kind} variation parent stays withdrawn after a stale read`, async () => {
    const f = createEventMarketOrderFixture({
      mode: "merchant_present",
      newAssignment: true,
    })
    const parentCoordinate = `30402:${f.merchant}:variable-parent`
    const parent = finalizeEvent(
      {
        kind: 30402,
        created_at: 90,
        content: "",
        tags: [
          ["d", "variable-parent"],
          ["title", "Family"],
          ["type", "variable", "physical"],
          ["price", "0", "SATS"],
        ],
      },
      f.merchantSecret
    )
    const child = finalizeEvent(
      {
        ...f.fulfillment.product.signedEvent,
        tags: [
          ...f.fulfillment.product.signedEvent!.tags.filter(
            (t) => t[0] !== "type"
          ),
          ["type", "variation", "physical"],
          ["a", parentCoordinate],
        ],
      },
      f.merchantSecret
    )
    const base = [
      ...f.events.filter((e) => e.id !== f.fulfillment.product.eventId),
      child,
      parent,
    ]
    const env = source(base)
    const marketRead = await readEventMarketRoster(
      { reference: f.fulfillment.market.coordinate },
      env.deps
    )
    const input = {
      marketRead,
      productCoordinate: f.fulfillment.product.coordinate,
      selectedOccurrenceCoordinate: f.fulfillment.calendar.coordinate,
    }
    expect((await readEventMarketProduct(input, env.deps)).actionable).toBe(
      true
    )
    const negative =
      kind === "hidden"
        ? finalizeEvent(
            {
              ...parent,
              created_at: 110,
              tags: [...parent.tags, ["visibility", "hidden"]],
            },
            f.merchantSecret
          )
        : finalizeEvent(
            {
              kind: 5,
              created_at: 110,
              content: "",
              tags: [
                [
                  kind === "deleted_by_id" ? "e" : "a",
                  kind === "deleted_by_id" ? parent.id : parentCoordinate,
                ],
              ],
            },
            f.merchantSecret
          )
    env.set([...base, negative])
    expect((await readEventMarketProduct(input, env.deps)).actionable).toBe(
      false
    )
    env.set(base)
    const after = (await readEventMarketProduct(input, env.deps)).actionable
    expect(after).toBe(false)
  })
it("assigned product with empty content is discoverable by its title", async () => {
  const f = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const product = finalizeEvent(
    { ...f.fulfillment.product.signedEvent, content: "" },
    f.merchantSecret
  )
  const env = source([
    ...f.events.filter((e) => e.id !== f.fulfillment.product.eventId),
    product,
  ])
  const input = {
    reference: f.fulfillment.market.coordinate,
    selectedOccurrenceCoordinate: f.fulfillment.calendar.coordinate,
  }
  expect((await readEventMarketCatalog(input, env.deps)).products.length).toBe(
    1
  )
  const count = (
    await readEventMarketCatalog({ ...input, search: "Coffee" }, env.deps)
  ).products.length
  expect(count).toBe(1)
})
it("cold shopper can buy remaining allocation with only the latest signed revision", async () => {
  const f = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const original = f.fulfillment.occurrenceAssignment!.signedEvent
  const updated = finalizeEvent(
    {
      ...original,
      created_at: 102,
      tags: [
        ...original.tags.filter((t) => t[0] !== "inventory" && t[0] !== "prev"),
        ["inventory", "tracked", "5"],
        ["prev", original.id],
      ],
    },
    f.merchantSecret
  )
  const input = { reference: f.fulfillment.market.coordinate }
  const inspect = async (events: readonly SignedPublicNostrEvent[]) => {
    const env = source(events)
    const marketRead = await readEventMarketRoster(input, env.deps)
    return readEventMarketProduct(
      {
        marketRead,
        productCoordinate: f.fulfillment.product.coordinate,
        selectedOccurrenceCoordinate: f.fulfillment.calendar.coordinate,
      },
      env.deps
    )
  }
  const withHistory = await inspect([...f.events, updated])
  expect(withHistory.actionable).toBe(true)
  const currentOnly = await inspect([
    ...f.events.filter((e) => e.id !== original.id),
    updated,
  ])
  expect(currentOnly.actionable).toBe(true)
})
for (const mode of ["merchant_present", "organizer_handoff"] as const)
  it(`valid pre-assignment ${mode} order retains an acceptance path`, async () => {
    const f = createEventMarketOrderFixture({ mode })
    const verified = await admitFixtureEvent(f.fulfillment.product.signedEvent)
    const product = parseProductEvent(verified)
    await db.products.put(projectSignedProductListingForLocalCommit(verified))
    await initializeMerchantInventoryProduct({
      db,
      merchantPubkey: f.merchant,
      productCoordinate: product.id,
      stock: product.stock,
      signedProductEvent: verified,
    })
    const result = await acceptMerchantOccurrenceOrder({
      merchantPubkey: f.merchant,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      order: f.order,
      products: [product],
    }).then(
      () => ({ accepted: true, error: undefined }),
      (e) => ({ accepted: false, error: e.message })
    )
    expect(result.accepted).toBe(true)
  })

for (const mode of ["merchant_present", "organizer_handoff"] as const)
  it(`unended pre-assignment ${mode} order retains an acceptance path`, async () => {
    const f = createEventMarketOrderFixture({
      mode,
      newAssignment: true,
    })
    const original = f.fulfillment.product.signedEvent!
    const legacyProduct = finalizeEvent(
      {
        ...original,
        tags: [...original.tags, ["a", f.fulfillment.market.coordinate]],
      },
      f.merchantSecret
    )
    expect(f.fulfillment.occurrenceAssignment).toBeDefined()
    const historical = { ...f.fulfillment, occurrenceAssignment: undefined }
    const fulfillment = {
      ...historical,
      product: {
        ...historical.product,
        eventId: legacyProduct.id,
        signedEvent: legacyProduct,
      },
    }
    const purchase = orderSchema.parse({
      ...f.order,
      id: "future-pre-assignment",
      items: [{ ...f.order.items[0], fulfillment }],
    })
    expect(fulfillment.calendar.end).toBeGreaterThan(Date.now())
    const verified = await admitFixtureEvent(legacyProduct)
    const product = parseProductEvent(verified)
    await db.products.put(projectSignedProductListingForLocalCommit(verified))
    await initializeMerchantInventoryProduct({
      db,
      merchantPubkey: f.merchant,
      productCoordinate: product.id,
      stock: product.stock,
      signedProductEvent: verified,
    })
    const result = await acceptMerchantOccurrenceOrder({
      merchantPubkey: f.merchant,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      order: purchase,
      products: [product],
    }).then(
      () => ({ accepted: true, error: undefined }),
      (e) => ({ accepted: false, error: e.message })
    )
    expect(result.accepted).toBe(true)
  })
for (const currency of ["SATS", "USD"])
  it(`actual ${currency} checkout payload can be accepted unchanged`, async () => {
    const p = await setup(listing(`composed-${currency}`, 10, 10, currency))
    const now = Date.now()
    const intent = buildCheckoutPricingIntent(
      [
        {
          productId: p.id,
          merchantPubkey: merchant,
          title: p.title,
          price: p.price,
          currency: p.currency,
          sourcePrice: p.sourcePrice,
          quantity: 1,
          format: p.format,
          fulfillment: { type: "digital" },
        },
      ],
      { rate: 50_000, fetchedAt: now, source: "mempool" },
      now
    )
    expect(intent.status).toBe("ok")
    if (intent.status !== "ok") return
    const purchase = orderSchema.parse({
      ...order([p], `composed-${currency}`),
      items: intent.items,
      subtotal: intent.totalSats,
    })
    const result = await acceptMerchantOccurrenceOrder({
      ...session,
      order: purchase,
      products: [p],
    }).then(
      () => ({ accepted: true, error: undefined }),
      (e) => ({ accepted: false, error: e.message })
    )
    expect(result.accepted).toBe(true)
  })

for (const shortfall of [0, 1])
  it(`credits a prior stock decision once, with shortfall ${shortfall}`, async () => {
    const product = await setup(listing(`prior-stock-${shortfall}`, 4))
    const purchase = orderSchema.parse({
      ...order([product]),
      items: [{ ...order([product]).items[0], quantity: 2 }],
      subtotal: 20,
    })
    const priorStockAdjustments = [
      { productCoordinate: product.id, quantity: 2, shortfall },
    ]
    await acceptMerchantOccurrenceOrder({
      ...session,
      order: purchase,
      products: [product],
      priorStockAdjustments,
    })
    expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(
      4 - shortfall
    )
    db.close({ disableAutoOpen: false })
    await db.open()
    const replay = await acceptMerchantOccurrenceOrder({
      ...session,
      order: purchase,
      products: [],
      priorStockAdjustments,
    })
    expect(replay.replayed).toBe(true)
    expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(
      4 - shortfall
    )
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(1)
  })
it("accepts the last unit already handled by a legacy stock decision", async () => {
  const product = await setup(listing("legacy-last-unit", 0))
  await acceptMerchantOccurrenceOrder({
    ...session,
    order: order([product]),
    products: [product],
    priorStockAdjustments: [
      { productCoordinate: product.id, quantity: 1, shortfall: 0 },
    ],
  })
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(0)
  expect(await db.merchantInventoryAcceptedOrders.count()).toBe(1)
  expect(
    (await db.merchantInventoryProducts.get(product.id))?.publicationJobs
  ).toHaveLength(0)
})
it("rejects a changed quantity under a prior order stock decision without consuming anything", async () => {
  const product = await setup(listing("changed-stock-order", 4))
  await expect(
    acceptMerchantOccurrenceOrder({
      ...session,
      order: order([product]),
      products: [product],
      priorStockAdjustments: [
        { productCoordinate: product.id, quantity: 2, shortfall: 0 },
      ],
    })
  ).rejects.toThrow("stock decision needs reconciliation")
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(4)
  expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
})
it("rejects a different source currency even when its claimed normalized currency matches", async () => {
  const product = await setup(listing("fiat-currency-binding", 10, 10, "USD"))
  const purchase = order([product])
  purchase.items[0]!.sourcePrice = {
    amount: 10,
    currency: "EUR",
    normalizedCurrency: "USD",
  }
  await expect(
    acceptMerchantOccurrenceOrder({
      ...session,
      order: purchase,
      products: [product],
    })
  ).rejects.toThrow("Order source currency")
  expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
})
it("does not authorize a variation when retaining its parent fails", async () => {
  const f = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const parentCoordinate = `30402:${f.merchant}:retained-family`
  const parent = finalizeEvent(
    {
      kind: 30402,
      created_at: 90,
      content: "",
      tags: [
        ["d", "retained-family"],
        ["title", "Family"],
        ["type", "variable", "physical"],
        ["price", "0", "SATS"],
      ],
    },
    f.merchantSecret
  )
  const child = finalizeEvent(
    {
      ...f.fulfillment.product.signedEvent!,
      tags: [
        ...f.fulfillment.product.signedEvent!.tags.filter(
          (tag) => tag[0] !== "type"
        ),
        ["type", "variation", "physical"],
        ["a", parentCoordinate],
      ],
    },
    f.merchantSecret
  )
  const env = source([
    ...f.events.filter((event) => event.id !== f.fulfillment.product.eventId),
    child,
    parent,
  ])
  const retain = env.deps.retain
  env.deps.retain = async (coordinate, rows) => {
    if (rows.some((event) => event.id === parent.id))
      throw new Error("Parent storage unavailable")
    await retain(coordinate, rows)
  }
  const marketRead = await readEventMarketRoster(
    { reference: f.fulfillment.market.coordinate },
    env.deps
  )
  const result = await readEventMarketProduct(
    {
      marketRead,
      productCoordinate: f.fulfillment.product.coordinate,
      selectedOccurrenceCoordinate: f.fulfillment.calendar.coordinate,
    },
    env.deps
  )
  expect(result.actionable).toBe(false)
  expect(result.retained).toBe(false)
})

it("a warm shopper accepts the latest assignment when a superseded intermediate was discarded", async () => {
  const f = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const initial = f.fulfillment.occurrenceAssignment!.signedEvent
  const revision = (
    parent: SignedPublicNostrEvent,
    quantity: number,
    at: number
  ) =>
    finalizeEvent(
      {
        ...initial,
        created_at: at,
        tags: [
          ...initial.tags.filter(
            (tag) => tag[0] !== "inventory" && tag[0] !== "prev"
          ),
          ["inventory", "tracked", String(quantity)],
          ["prev", parent.id],
        ],
      },
      f.merchantSecret
    )
  const intermediate = revision(initial, 5, 102)
  const current = revision(intermediate, 4, 103)
  const env = source(f.events)
  const marketRead = await readEventMarketRoster(
    { reference: f.fulfillment.market.coordinate },
    env.deps
  )
  const input = {
    marketRead,
    productCoordinate: f.fulfillment.product.coordinate,
    selectedOccurrenceCoordinate: f.fulfillment.calendar.coordinate,
  }
  expect((await readEventMarketProduct(input, env.deps)).actionable).toBe(true)
  env.set([...f.events.filter((event) => event.id !== initial.id), current])
  expect((await readEventMarketProduct(input, env.deps)).actionable).toBe(true)
})

for (const shape of ["roots", "siblings", "siblings_without_parent"])
  it(`retains a known material assignment fork: ${shape}`, async () => {
    const f = createEventMarketOrderFixture({
      mode: "merchant_present",
      newAssignment: true,
    })
    const initial = f.fulfillment.occurrenceAssignment!.signedEvent
    const branch = (quantity: number, at: number) =>
      finalizeEvent(
        {
          ...initial,
          created_at: at,
          tags: [
            ...initial.tags.filter(
              (tag) => tag[0] !== "inventory" && tag[0] !== "prev"
            ),
            ["inventory", "tracked", String(quantity)],
            ...(shape === "roots" ? [] : [["prev", initial.id]]),
          ],
        },
        f.merchantSecret
      )
    const events = [
      ...f.events.filter((event) => event.id !== initial.id),
      branch(5, 102),
      branch(4, 103),
      ...(shape === "siblings" ? [initial] : []),
    ]
    const env = source(events)
    const marketRead = await readEventMarketRoster(
      { reference: f.fulfillment.market.coordinate },
      env.deps
    )
    const result = await readEventMarketProduct(
      {
        marketRead,
        productCoordinate: f.fulfillment.product.coordinate,
        selectedOccurrenceCoordinate: f.fulfillment.calendar.coordinate,
      },
      env.deps
    )
    expect(result.actionable).toBe(false)
  })

it("keeps an observed assignment removal through a later stale read", async () => {
  const f = createEventMarketOrderFixture({
    mode: "merchant_present",
    newAssignment: true,
  })
  const initial = f.fulfillment.occurrenceAssignment!.signedEvent
  const removed = finalizeEvent(
    {
      ...initial,
      created_at: 102,
      tags: [
        ...initial.tags.filter(
          (tag) =>
            !["inventory", "fulfillment", "state", "prev"].includes(tag[0]!)
        ),
        ["state", "removed"],
        ["inventory", "tracked", "0"],
        ["prev", initial.id],
      ],
    },
    f.merchantSecret
  )
  const env = source(f.events)
  const marketRead = await readEventMarketRoster(
    { reference: f.fulfillment.market.coordinate },
    env.deps
  )
  const input = {
    marketRead,
    productCoordinate: f.fulfillment.product.coordinate,
    selectedOccurrenceCoordinate: f.fulfillment.calendar.coordinate,
  }
  expect((await readEventMarketProduct(input, env.deps)).actionable).toBe(true)
  env.set([...f.events, removed])
  expect((await readEventMarketProduct(input, env.deps)).actionable).toBe(false)
  env.set(f.events)
  expect((await readEventMarketProduct(input, env.deps)).actionable).toBe(false)
})

for (const stockAction of [false, true])
  it(`shared ${stockAction ? "order stock action" : "product edit"} protects a retained postponement before any assignment-panel read`, async () => {
    const original = listing(`postponed-${stockAction}`, 6)
    const product = await setup(original)
    const organizerSecret = generateSecretKey()
    const organizer = getPublicKey(organizerSecret)
    const now = Math.floor(Date.now() / 1000)
    const oldEnd = (now + 7200) * 1000
    const newEnd = oldEnd + 7200000
    const marketCoordinate = `30409:${organizer}:postponed`
    const occurrenceCoordinate = `31923:${organizer}:postponed`
    const assignmentCoordinate = `30410:${merchant}:${computeEventMarketAssignmentDTag({ marketCoordinate, occurrenceCoordinate, productCoordinate: product.id })}`
    await commitMerchantInventoryAssignment({
      db,
      merchantPubkey: merchant,
      productCoordinate: product.id,
      assignmentCoordinate,
      marketCoordinate,
      occurrenceCoordinate,
      inventory: { mode: "tracked", quantity: 4 },
      state: "active",
      fulfillmentMethods: ["pickup"],
      expectedRevision: null,
      mutationId: "allocate-before-postponement",
      context: {
        kind: "validated-event-market-assignment",
        productEventId: original.id,
        marketEventId: "a".repeat(64),
        occurrenceEventId: "b".repeat(64),
        grantEventId: "c".repeat(64),
        occurrenceEndMs: oldEnd,
        terminal: false,
      },
    })
    const calendar = finalizeEvent(
      {
        ...buildEventMarketCalendarDraft({
          kind: 31923,
          dTag: "postponed",
          title: "Postponed fair",
          start: now + 10800,
          end: newEnd / 1000,
          locations: ["Public hall"],
        }),
        created_at: now,
      },
      organizerSecret
    )
    expect(
      parseEventMarketCalendarEvent(await admitFixtureEvent(calendar))?.end
    ).toBe(newEnd)
    await retainEventMarketCommerceEvidence(marketCoordinate, [calendar])
    const changed = listing(`postponed-${stockAction}`, 1, 10, "SATS", 102)
    const clock = spyOn(Date, "now").mockReturnValue(oldEnd + 1000)
    try {
      await expect(
        commitLocalProductWrite({
          intentId: "ordinary-write-after-old-end",
          merchantPubkey: merchant,
          expectedRevisions: [{ addressId: product.id, eventId: original.id }],
          listingJob: job(changed),
          ...(stockAction
            ? {
                stock: {
                  orderId: "ordinary-order",
                  adjustment: {
                    key: `${encodeURIComponent("ordinary-order")}:${encodeURIComponent(product.id)}`,
                    addressId: product.id,
                    sourceEventId: original.id,
                    title: product.title,
                    quantity: 5,
                    currentStock: 6,
                    nextStock: 1,
                    shortfall: 0,
                  },
                },
              }
            : {}),
        })
      ).rejects.toThrow(
        "Reconcile occurrence allocations before changing stock"
      )
      expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(
        6
      )
      expect(await db.localProductWriteIntents.count()).toBe(0)
      expect(await db.localProductStockCheckpoints.count()).toBe(0)
    } finally {
      clock.mockRestore()
    }
  })

it("new delegated assignment acceptance stays gated while legacy handoff orders remain usable", async () => {
  const f = createEventMarketOrderFixture({
    mode: "organizer_handoff",
    newAssignment: true,
  })
  const verified = await admitFixtureEvent(f.fulfillment.product.signedEvent)
  const product = parseProductEvent(verified)
  await db.products.put(projectSignedProductListingForLocalCommit(verified))
  await initializeMerchantInventoryProduct({
    db,
    merchantPubkey: f.merchant,
    productCoordinate: product.id,
    stock: product.stock,
    signedProductEvent: verified,
  })
  await expect(
    acceptMerchantOccurrenceOrder({
      merchantPubkey: f.merchant,
      authenticatedPubkey: f.merchant,
      shouldContinue: () => true,
      order: f.order,
      products: [product],
    })
  ).rejects.toThrow("This order needs its delegated fulfillment workflow.")
  expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(6)
})

it("explicit acceptance retains the original order price after a later committed listing edit", async () => {
  const original = listing("honor-original-quote", 10, 100)
  const product = await setup(original)
  const purchase = order([product], "original-price-order")
  const edited = listing("honor-original-quote", 10, 110, "SATS", 102)
  await commitLocalProductWrite({
    intentId: "edit-price-after-order",
    merchantPubkey: merchant,
    expectedRevisions: [{ addressId: product.id, eventId: original.id }],
    listingJob: job(edited),
  })
  const accepted = await acceptMerchantOccurrenceOrder({
    ...session,
    order: purchase,
    products: [],
  })
  expect(accepted.replayed).toBe(false)
  expect(await openMerchantAcceptanceEvidence(accepted.order)).toBe(
    JSON.stringify(orderSchema.parse(purchase))
  )
  expect(purchase.items[0]?.priceAtPurchase).toBe(100)
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(9)
  expect(
    (await db.merchantInventoryProducts.get(product.id))?.sourceProductEvent.id
  ).toBe(edited.id)
  expect(
    (
      await acceptMerchantOccurrenceOrder({
        ...session,
        order: purchase,
        products: [],
      })
    ).replayed
  ).toBe(true)
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(9)
})

it("reads saved acceptance only for the exact original identity and terms", async () => {
  const { readMerchantOccurrenceAcceptedOrder } =
    await import("../packages/core/src/protocol/merchant-occurrence-workflow")
  const product = await setup(listing("read-accepted-binding"))
  const purchase = order([product], "bound-accepted-order")
  const saved = await acceptMerchantOccurrenceOrder({
    ...session,
    order: purchase,
    products: [product],
  })
  const read = (candidate: typeof purchase | null) =>
    readMerchantOccurrenceAcceptedOrder({
      merchantPubkey: merchant,
      orderId: purchase.id,
      order: candidate,
    })
  expect((await read(purchase))?.termsBinding).toBe(saved.order.termsBinding)
  for (const candidate of [
    { ...purchase, buyerPubkey: "b".repeat(64) },
    {
      ...purchase,
      items: purchase.items.map((item) => ({ ...item, quantity: 2 })),
      subtotal: 20,
    },
    {
      ...purchase,
      items: purchase.items.map((item) => ({
        ...item,
        priceAtPurchase: 11,
        sourcePrice: {
          amount: 11,
          currency: "SATS",
          normalizedCurrency: "SATS",
        },
      })),
      subtotal: 11,
    },
  ])
    await expect(read(orderSchema.parse(candidate))).rejects.toThrow(
      "conflicting accepted terms"
    )
  await expect(read(null)).rejects.toThrow("conflicting accepted terms")
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(9)
  expect(await db.merchantInventoryAcceptedOrders.count()).toBe(1)
})

for (const hidden of [false, true]) {
  for (const reverse of [false, true]) {
    it(`strongest signed ${hidden ? "hidden" : "sold-out"} revision must deny first acceptance (reverse=${reverse})`, async () => {
      const stale = await admitFixtureEvent(listing("review-revision", 6))
      const fresh = await admitFixtureEvent(
        finalizeEvent(
          {
            kind: 30402,
            created_at: 101,
            content: "",
            tags: [
              ["d", "review-revision"],
              ["title", "Synthetic product"],
              ["type", "simple", "digital"],
              ["price", "10", "SATS"],
              ["stock", hidden ? "6" : "0"],
              ...(hidden ? [["visibility", "hidden"]] : []),
            ],
          },
          secret
        )
      )
      const staleProduct = parseProductEvent(stale)
      // This tests signed revision selection, not relay recovery. Keep the
      // uninitialized inventory path while making unavailable coverage explicit.
      const plan = spyOn(
        eventMarketProtocol,
        "getEventMarketReadPlan"
      ).mockRejectedValue(new Error("Synthetic relay coverage unavailable"))
      try {
        await expect(
          acceptMerchantOccurrenceOrder({
            ...session,
            order: order([staleProduct]),
            products: reverse
              ? [parseProductEvent(fresh), staleProduct]
              : [staleProduct, parseProductEvent(fresh)],
          })
        ).rejects.toThrow(
          hidden ? "not currently sellable" : "Insufficient ordinary stock"
        )
        expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
        if (!hidden)
          expect(
            (await db.merchantInventoryProducts.get(staleProduct.id))?.stock
          ).toBe(0)
      } finally {
        plan.mockRestore()
      }
    })
  }
}

for (const reverse of [false, true]) {
  it(`duplicate observations cannot hide an independent stock revision (reverse=${reverse})`, async () => {
    const stale = await setup(listing("committed-freshness", 6))
    const fresh = parseProductEvent(
      await admitFixtureEvent(
        listing("committed-freshness", 0, 10, "SATS", 101)
      )
    )
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: order([stale]),
        products: reverse ? [fresh, stale] : [stale, fresh],
      })
    ).rejects.toThrow("newer independent product revision")
    expect((await db.merchantInventoryProducts.get(stale.id))?.stock).toBe(6)
    expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
  })
}

it("duplicate observations use the signed tie-break and ignore forged or unrelated coordinates", async () => {
  const events = [listing("same-time", 6), listing("same-time", 0)].sort(
    (a, b) => a.id.localeCompare(b.id)
  )
  const winner = parseProductEvent(await admitFixtureEvent(events[0]!))
  const loser = parseProductEvent(await admitFixtureEvent(events[1]!))
  const unrelated = parseProductEvent(
    await admitFixtureEvent(listing("unrelated", 0, 10, "SATS", 200))
  )
  const forged = {
    ...winner,
    signedProductEvent: { ...events[0]!, created_at: 300 },
  }
  for (const products of [
    [loser, winner],
    [winner, loser],
  ]) {
    await db.merchantInventoryProducts.clear()
    await db.merchantInventoryAcceptedOrders.clear()
    const accept = acceptMerchantOccurrenceOrder({
      ...session,
      order: order([winner]),
      products: [forged, { ...unrelated, id: winner.id }, ...products],
    })
    if (winner.stock === 0)
      await expect(accept).rejects.toThrow("Insufficient ordinary stock")
    else {
      await accept
      expect((await db.merchantInventoryProducts.get(winner.id))?.stock).toBe(5)
    }
  }
})

it("encrypts private acceptance bytes and preserves exact replay after reload", async () => {
  const product = await setup(listing("private-order"))
  const purchase = orderSchema.parse({
    ...order([product]),
    note: "SYNTHETIC_PRIVATE_NOTE",
    buyerIdentityKind: "guest_ephemeral",
    guestContact: {
      email: "synthetic-private@example.test",
      phone: "+15555550123",
    },
    shippingAddress: {
      name: "Synthetic Buyer",
      street: "123 Private Lane",
      city: "Test",
      postalCode: "12345",
      country: "US",
    },
  })
  const accepted = await acceptMerchantOccurrenceOrder({
    ...session,
    order: purchase,
    products: [product],
  })
  const saved = (await db.merchantInventoryAcceptedOrders.get(purchase.id))!
  for (const privateValue of [
    purchase.note!,
    purchase.shippingAddress!.street,
    purchase.buyerPubkey,
    purchase.guestContact!.email!,
    purchase.guestContact!.phone!,
  ])
    expect(JSON.stringify(saved)).not.toContain(privateValue)
  expect(saved.evidenceFormat).toBe("device-encrypted-v1")
  expect(saved.termsBinding).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(await openMerchantAcceptanceEvidence(saved)).toBe(
    JSON.stringify(purchase)
  )
  db.close({ disableAutoOpen: false })
  await db.open()
  expect(
    (
      await acceptMerchantOccurrenceOrder({
        ...session,
        order: purchase,
        products: [],
      })
    ).replayed
  ).toBe(true)
  for (const changed of [
    { ...purchase, note: "other" },
    {
      ...purchase,
      shippingAddress: {
        ...purchase.shippingAddress!,
        street: "456 Elsewhere",
      },
    },
  ])
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: changed,
        products: [],
      })
    ).rejects.toThrow("conflicting accepted terms")
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(9)
  expect(
    (await db.merchantInventoryAcceptedOrders.get(purchase.id))?.evidence
  ).toBe(accepted.order.evidence)
})

it("concurrent encrypted acceptance reuses one decision despite randomized nonces", async () => {
  const product = await setup(listing("private-concurrent"))
  const purchase = order([product])
  const results = await Promise.all(
    [1, 2].map(() =>
      acceptMerchantOccurrenceOrder({
        ...session,
        order: purchase,
        products: [product],
      })
    )
  )
  expect(results.filter((result) => !result.replayed)).toHaveLength(1)
  expect(results[0]!.order.evidence).toBe(results[1]!.order.evidence)
  expect(await openMerchantAcceptanceEvidence(results[0]!.order)).toBe(
    JSON.stringify(purchase)
  )
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(9)
  expect(await db.merchantInventoryAcceptedOrders.count()).toBe(1)
})

it("repairs legacy plaintext records without changing stock or original acceptance", async () => {
  const product = await setup(listing("legacy-private"))
  const purchase = orderSchema.parse({
    ...order([product]),
    note: "LEGACY_SYNTHETIC_NOTE",
  })
  const accepted = await acceptMerchantOccurrenceOrder({
    ...session,
    order: purchase,
    products: [product],
  })
  const legacy = { ...accepted.order }
  delete legacy.evidenceFormat
  delete legacy.evidenceBinding
  await db.merchantInventoryAcceptedOrders.put({
    ...legacy,
    identityBinding: JSON.stringify([
      purchase.id,
      purchase.buyerPubkey,
      purchase.merchantPubkey,
    ]),
    termsBinding: JSON.stringify(purchase),
    evidence: JSON.stringify(purchase),
  })
  const before = await db.merchantInventoryProducts.get(product.id)
  db.close({ disableAutoOpen: false })
  await db.open()
  const { readMerchantOccurrenceAcceptedOrder } =
    await import("../packages/core/src/protocol/merchant-occurrence-workflow")
  const saved = (await readMerchantOccurrenceAcceptedOrder({
    merchantPubkey: merchant,
    orderId: purchase.id,
    order: purchase,
  }))!
  expect(JSON.stringify(saved)).not.toContain(purchase.note!)
  expect(saved.acceptedAt).toBe(accepted.order.acceptedAt)
  expect(saved.items).toEqual(accepted.order.items)
  expect(await openMerchantAcceptanceEvidence(saved)).toBe(
    JSON.stringify(purchase)
  )
  expect(
    (
      await acceptMerchantOccurrenceOrder({
        ...session,
        order: purchase,
        products: [],
      })
    ).replayed
  ).toBe(true)
  await expect(
    acceptMerchantOccurrenceOrder({
      ...session,
      order: { ...purchase, note: "changed" },
      products: [],
    })
  ).rejects.toThrow("conflicting accepted terms")
  expect(await db.merchantInventoryProducts.get(product.id)).toEqual(before)
})

it("encrypted evidence rejects swapped order identity, tampering and another account", async () => {
  const product = await setup(listing("private-account-fence"))
  const purchase = order([product])
  const { order: saved } = await acceptMerchantOccurrenceOrder({
    ...session,
    order: purchase,
    products: [product],
  })
  await expect(
    openMerchantAcceptanceEvidence({ ...saved, orderId: "different-order" })
  ).rejects.toThrow()
  const cipher = JSON.parse(saved.evidence)
  cipher.bytes =
    (cipher.bytes.startsWith("00") ? "01" : "00") + cipher.bytes.slice(2)
  await expect(
    openMerchantAcceptanceEvidence({
      ...saved,
      evidence: JSON.stringify(cipher),
    })
  ).rejects.toThrow()
  installMerchantAcceptanceTestSession("b".repeat(64))
  await expect(openMerchantAcceptanceEvidence(saved)).rejects.toThrow(
    "Reconnect"
  )
  await expect(
    acceptMerchantOccurrenceOrder({ ...session, order: purchase, products: [] })
  ).rejects.toThrow("Reconnect")
  installMerchantAcceptanceTestSession(merchant)
  expect(await openMerchantAcceptanceEvidence(saved)).toBe(
    JSON.stringify(purchase)
  )
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(9)
})

it("failed encryption or a revoked lease never commits an acceptance debit", async () => {
  const { CommerceInboxStore } =
    await import("../packages/core/src/protocol/commerce-inbox-store")
  const product = await setup(listing("private-failed-seal"))
  const purchase = order([product])
  const original = CommerceInboxStore.prototype.seal
  const seal = spyOn(CommerceInboxStore.prototype, "seal").mockRejectedValue(
    new Error("Synthetic storage failure")
  )
  try {
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: purchase,
        products: [product],
      })
    ).rejects.toThrow("Synthetic storage failure")
    seal.mockImplementation(async function (
      this: InstanceType<typeof CommerceInboxStore>,
      ...args: Parameters<typeof original>
    ) {
      const cipher = await original.apply(this, args)
      __resetProtectedReadSigner()
      return cipher
    })
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: purchase,
        products: [product],
      })
    ).rejects.toThrow("authority is unavailable")
  } finally {
    seal.mockRestore()
  }
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(10)
  expect(await db.merchantInventoryAcceptedOrders.count()).toBe(0)
})

it("failed legacy repair remains retryable and cannot debit the accepted order again", async () => {
  const { CommerceInboxStore } =
    await import("../packages/core/src/protocol/commerce-inbox-store")
  const product = await setup(listing("legacy-repair-retry"))
  const purchase = orderSchema.parse({
    ...order([product]),
    note: "LEGACY_REPAIR_NOTE",
  })
  const accepted = await acceptMerchantOccurrenceOrder({
    ...session,
    order: purchase,
    products: [product],
  })
  const legacy = { ...accepted.order }
  delete legacy.evidenceFormat
  delete legacy.evidenceBinding
  const original = {
    ...legacy,
    identityBinding: JSON.stringify([
      purchase.id,
      purchase.buyerPubkey,
      merchant,
    ]),
    termsBinding: JSON.stringify(purchase),
    evidence: JSON.stringify(purchase),
  }
  await db.merchantInventoryAcceptedOrders.put(original)
  const seal = spyOn(CommerceInboxStore.prototype, "seal").mockRejectedValue(
    new Error("Synthetic repair failure")
  )
  try {
    await expect(
      acceptMerchantOccurrenceOrder({
        ...session,
        order: purchase,
        products: [],
      })
    ).rejects.toThrow("Synthetic repair failure")
    expect(await db.merchantInventoryAcceptedOrders.get(purchase.id)).toEqual(
      original
    )
    expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(9)
  } finally {
    seal.mockRestore()
  }
  const replay = await acceptMerchantOccurrenceOrder({
    ...session,
    order: purchase,
    products: [],
  })
  expect(replay.replayed).toBe(true)
  expect(JSON.stringify(replay.order)).not.toContain(purchase.note!)
  expect(await openMerchantAcceptanceEvidence(replay.order)).toBe(
    JSON.stringify(purchase)
  )
  expect((await db.merchantInventoryProducts.get(product.id))?.stock).toBe(9)
})

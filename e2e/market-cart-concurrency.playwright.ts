import { fileURLToPath } from "node:url"

import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from "nostr-tools/pure"
import { buildEventMarketRosterDraft } from "../packages/core/src/protocol/event-market-roster"
import { buildEventMarketAuthorizationDraft } from "../packages/core/src/protocol/event-market-authorization"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import type { CartPurchaseClaim } from "../apps/market/src/lib/cart-repository"
import { publishTestRelayEvents } from "./helpers/auth"
import { delayCartNotifications } from "./helpers/cart-notifications"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const coreBrowserModulePath = `/@fs${fileURLToPath(
  new URL("../packages/core/src/index.ts", import.meta.url)
)}`

const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const ORGANIZER_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const STOCK_REFRESH_SECRET = generateSecretKey()
const STOCK_REFRESH_MERCHANT = getPublicKey(STOCK_REFRESH_SECRET)

const legacyCart = {
  version: 2,
  items: [
    {
      productId: `30402:${MERCHANT}:race-item`,
      merchantPubkey: MERCHANT,
      title: "Race item",
      price: 1_200,
      currency: "SATS",
      priceSats: 1_200,
      format: "digital",
      quantity: 2,
    },
  ],
}

async function seedLegacyCart(
  context: BrowserContext,
  seed: unknown
): Promise<void> {
  await context.addInitScript((value) => {
    if (localStorage.getItem("conduit:cart") === null) {
      localStorage.setItem("conduit:cart", JSON.stringify(value))
    }
  }, seed)
}

async function seedRawLegacyCart(
  context: BrowserContext,
  raw: string
): Promise<void> {
  await context.addInitScript((value) => {
    if (localStorage.getItem("conduit:cart") === null) {
      localStorage.setItem("conduit:cart", value)
    }
  }, raw)
}

async function readCanonicalLines(
  page: Page
): Promise<
  Array<{ id: string; title: string; quantity: number; priceSats?: number }>
> {
  return page.evaluate(
    () =>
      new Promise<
        Array<{
          id: string
          title: string
          quantity: number
          priceSats?: number
        }>
      >((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction("shoppingCarts", "readonly")
          const get = transaction.objectStore("shoppingCarts").get("market")
          transaction.oncomplete = () => {
            const lines = Array.isArray(get.result?.lines)
              ? get.result.lines
              : []
            resolve(
              lines.map(
                (line: {
                  id: string
                  item: {
                    title: string
                    priceSats?: number
                  }
                  batches: Array<{ quantity: number }>
                }) => ({
                  id: line.id,
                  title: line.item.title,
                  priceSats: line.item.priceSats,
                  quantity: line.batches.reduce(
                    (sum, batch) => sum + batch.quantity,
                    0
                  ),
                })
              )
            )
            database.close()
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
  )
}

async function hasCanonicalCartRecord(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction("shoppingCarts", "readonly")
          const get = transaction.objectStore("shoppingCarts").get("market")
          transaction.oncomplete = () => {
            resolve(get.result !== undefined)
            database.close()
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
  )
}

async function awaitCartRepositoryInitialization(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const modulePath = "/src/lib/cart-repository.ts"
    const repository = (await import(/* @vite-ignore */ modulePath)) as {
      initializeCartRepository(): Promise<void>
    }
    await repository.initializeCartRepository()
  })
}

async function addCartItemThroughRepository(
  page: Page,
  item: {
    productId: string
    merchantPubkey: string
    title: string
    price: number
    currency: string
    priceSats: number
    format: "digital" | "physical"
    stock?: number
    fulfillment?:
      { type: "shipping" } | ReturnType<typeof pickupItem>["fulfillment"]
  }
): Promise<void> {
  await page.evaluate(async (value) => {
    const modulePath = "/src/lib/cart-repository.ts"
    const repository = (await import(/* @vite-ignore */ modulePath)) as {
      addCartRepositoryItem(
        input: typeof value,
        quantity: number
      ): Promise<unknown>
    }
    await repository.addCartRepositoryItem(value, 1)
  }, item)
}

function pickupItem(input: {
  merchant: string
  organizer: string
  product: string
  title: string
  event: "a" | "b"
  price?: number
  currency?: string
}) {
  if (input.merchant !== MERCHANT || input.organizer !== ORGANIZER)
    throw new Error(
      "Signed pickup fixtures require their synthetic fixture identities."
    )
  const createdAtOffset = input.event === "a" ? 0 : 100
  const coordinate = `30402:${input.merchant}:${input.product}`
  const calendarCoordinate = `31923:${input.organizer}:event-${input.event}`
  const marketCoordinate = `30409:${input.organizer}:market-${input.event}`
  const start = 1_900_000_000 + createdAtOffset
  const end = start + 3_600
  const price = input.price ?? 1_000
  const currency = input.currency ?? "SATS"
  const market = finalizeEvent(
    {
      ...buildEventMarketRosterDraft({
        dTag: `market-${input.event}`,
        organizerPubkey: input.organizer,
        calendarCoordinate,
        state: "open",
        merchants: [
          {
            pubkey: input.merchant,
            mode: "organizer_handoff",
            assignment: "Shared entrance",
          },
        ],
      }),
      created_at: 100 + createdAtOffset,
    },
    ORGANIZER_SECRET
  )
  const calendar = finalizeEvent(
    {
      kind: 31923,
      created_at: 101 + createdAtOffset,
      content: "",
      tags: [
        ["d", `event-${input.event}`],
        ["title", `Event ${input.event.toUpperCase()}`],
        ["start", String(start)],
        ["end", String(end)],
        ["start_tzid", "UTC"],
        ["end_tzid", "UTC"],
        ["location", "Fixture Hall"],
        ["D", String(Math.floor(start / 86_400))],
      ],
    },
    ORGANIZER_SECRET
  )
  const grant = finalizeEvent(
    {
      ...buildEventMarketAuthorizationDraft({
        marketCoordinate,
        merchantPubkey: input.merchant,
        state: "active",
        sequence: 0,
        parentIds: [],
      }),
      created_at: 99 + createdAtOffset,
    },
    ORGANIZER_SECRET
  )
  const product = finalizeEvent(
    {
      kind: 30402,
      created_at: 102 + createdAtOffset,
      content: input.title,
      tags: [
        ["d", input.product],
        ["title", input.title],
        ["price", String(price), currency],
        ["type", "simple", "physical"],
        ["a", marketCoordinate],
      ],
    },
    MERCHANT_SECRET
  )
  return {
    productId: coordinate,
    merchantPubkey: input.merchant,
    title: input.title,
    price,
    currency,
    sourcePrice: { amount: price, currency, normalizedCurrency: currency },
    priceSats: 1_000,
    format: "physical" as const,
    quantity: 1,
    productEventId: product.id,
    productUpdatedAt: product.created_at * 1_000,
    eventMarketContext: { marketCoordinate, calendarCoordinate },
    fulfillment: {
      type: "event_market_pickup" as const,
      organizerPubkey: input.organizer,
      merchantPubkey: input.merchant,
      payeePubkey: input.merchant,
      market: {
        coordinate: marketCoordinate,
        eventId: market.id,
        createdAt: market.created_at * 1_000,
        signedEvent: market,
      },
      calendar: {
        coordinate: calendarCoordinate,
        eventId: calendar.id,
        createdAt: calendar.created_at * 1_000,
        start: start * 1_000,
        end: end * 1_000,
        signedEvent: calendar,
      },
      grant: {
        kind: 3841 as const,
        pubkey: input.organizer,
        eventId: grant.id,
        createdAt: grant.created_at * 1_000,
        ancestryEventIds: [grant.id],
        observedDeletionEventIds: [],
        signedEvidence: { tip: grant, ancestry: [grant], deletions: [] },
      },
      product: {
        coordinate,
        eventId: product.id,
        createdAt: product.created_at * 1_000,
        signedEvent: product,
      },
      mode: "organizer_handoff" as const,
      assignment: "Shared entrance",
    },
  }
}

function currentStockProduct(input: {
  dTag: string
  title: string
  createdAt: number
  stock?: number
}): Event {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: input.createdAt,
      content: `${input.title} synthetic stock fixture.`,
      tags: [
        ["d", input.dTag],
        ["title", input.title],
        ["summary", "Synthetic stock refresh fixture."],
        ["price", "1200", "SATS"],
        ["type", "simple", "digital"],
        ["visibility", "on-sale"],
        ["image", "https://cdn.conduit.market/conduit-test/stock-refresh.svg"],
        ...(input.stock === undefined ? [] : [["stock", String(input.stock)]]),
      ],
    },
    STOCK_REFRESH_SECRET
  )
}

for (const destination of ["shipping", "pickup"] as const) {
  test(`fulfillment merges into existing ${destination} across tabs and reload @market`, async ({
    context,
    page,
  }) => {
    const pickup = {
      ...pickupItem({
        merchant: MERCHANT,
        organizer: ORGANIZER,
        product: "fulfillment-merge",
        title: "Fulfillment merge",
        event: "a",
      }),
      stock: 4,
      quantity: 2,
    }
    const shipping = {
      ...pickup,
      fulfillment: { type: "shipping" as const },
      shippingOptionId: `30406:${MERCHANT}:shipping`,
      shippingCostSats: 100,
    }
    const source = destination === "shipping" ? pickup : shipping
    const target = destination === "shipping" ? shipping : pickup
    await seedLegacyCart(context, {
      version: 2,
      items: [source, { ...target, quantity: 1 }],
    })
    await page.goto(`${marketUrl}/cart`)
    await awaitCartRepositoryInitialization(page)
    const observer = await context.newPage()
    await observer.goto(`${marketUrl}/cart`)
    await awaitCartRepositoryInitialization(observer)
    const result = await page.evaluate(async (input) => {
      const repositoryPath = "/src/lib/cart-repository.ts"
      const modelPath = "/src/lib/cart-model.ts"
      const repository = (await import(
        /* @vite-ignore */ repositoryPath
      )) as typeof import("../apps/market/src/lib/cart-repository")
      const model = (await import(
        /* @vite-ignore */ modelPath
      )) as typeof import("../apps/market/src/lib/cart-model")
      const before = repository.getCartRepositorySnapshot()
      const sourceLine = before.items.find(
        (item) => item.fulfillment?.type !== input.fulfillment.type
      )!
      const targetLine = before.items.find(
        (item) => item.fulfillment?.type === input.fulfillment.type
      )!
      const groups = model.groupCartPurchases(before.items)
      const sourceGroup = groups.find((group) =>
        group.items.some((item) => item.cartLineId === sourceLine.cartLineId)
      )!
      const targetGroup = groups.find((group) =>
        group.items.some((item) => item.cartLineId === targetLine.cartLineId)
      )!
      const sourceClaim = await repository.captureCartPurchase(
        sourceGroup.id,
        sourceGroup.items
      )
      const targetClaim = await repository.captureCartPurchase(
        targetGroup.id,
        targetGroup.items
      )
      const changed = await repository.changeCartRepositoryFulfillment(
        sourceLine,
        input,
        before.revision
      )
      const merged = repository.getCartRepositorySnapshot()
      const sourceConsumed = await repository.consumeCartPurchase(sourceClaim)
      const targetConsumed = await repository.consumeCartPurchase(targetClaim)
      const after = repository.getCartRepositorySnapshot()
      return {
        changed: changed.changed,
        mergedLines: merged.items.length,
        mergedQuantity: merged.items[0]?.quantity,
        keptDestination: merged.items[0]?.cartLineId === targetLine.cartLineId,
        sourceConsumed: sourceConsumed.changed,
        targetConsumed: targetConsumed.changed,
        remainingQuantity: after.items[0]?.quantity,
        mode: after.persistenceMode,
      }
    }, target)
    expect(result).toEqual({
      changed: true,
      mergedLines: 1,
      mergedQuantity: 3,
      keptDestination: true,
      sourceConsumed: false,
      targetConsumed: true,
      remainingQuantity: 2,
      mode: "persistent",
    })
    const readProjection = (tab: Page) =>
      tab.evaluate(async () => {
        const path = "/src/lib/cart-repository.ts"
        const repository = (await import(
          /* @vite-ignore */ path
        )) as typeof import("../apps/market/src/lib/cart-repository")
        await repository.initializeCartRepository()
        const snapshot = repository.getCartRepositorySnapshot()
        return {
          lines: snapshot.items.length,
          quantity: snapshot.items[0]?.quantity,
          mode: snapshot.persistenceMode,
        }
      })
    await expect
      .poll(() => readProjection(observer))
      .toEqual({ lines: 1, quantity: 2, mode: "persistent" })
    await page.reload()
    await expect
      .poll(() => readProjection(page))
      .toEqual({ lines: 1, quantity: 2, mode: "persistent" })
    await page.evaluate(async () => {
      const path = "/src/lib/cart-repository.ts"
      const repository = (await import(
        /* @vite-ignore */ path
      )) as typeof import("../apps/market/src/lib/cart-repository")
      await repository.incrementCartRepositoryItem(
        repository.getCartRepositorySnapshot().items[0]!
      )
    })
    await expect
      .poll(() => readProjection(observer))
      .toEqual({ lines: 1, quantity: 3, mode: "persistent" })
  })
}

test("Cart and HUD increments honor newer signed stock evidence @market", async ({
  context,
}) => {
  const currentRevision = Math.floor(Date.now() / 1_000) - 10
  const persistedRevision = currentRevision * 1_000 - 1_000
  const fixtures = [
    { dTag: "cart-stock-increase", title: "Cart stock increase", stock: 2 },
    { dTag: "cart-stock-untracked", title: "Cart stock untracked" },
    { dTag: "hud-stock-increase", title: "HUD stock increase", stock: 2 },
    { dTag: "hud-stock-untracked", title: "HUD stock untracked" },
  ] as const
  await publishTestRelayEvents(
    fixtures.map((fixture) =>
      currentStockProduct({ ...fixture, createdAt: currentRevision })
    )
  )
  await seedLegacyCart(context, {
    version: 2,
    items: fixtures.map((fixture) => ({
      productId: `30402:${STOCK_REFRESH_MERCHANT}:${fixture.dTag}`,
      merchantPubkey: STOCK_REFRESH_MERCHANT,
      title: fixture.title,
      price: 1_200,
      currency: "SATS",
      priceSats: 1_200,
      format: "digital",
      productUpdatedAt: persistedRevision,
      stock: 1,
      quantity: 1,
    })),
  })

  const page = await context.newPage()
  await page.route("https://cdn.conduit.market/conduit-test/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"/>',
    })
  )
  await page.goto(`${marketUrl}/cart`)
  for (const title of ["Cart stock increase", "Cart stock untracked"]) {
    const increment = page.getByRole("button", {
      name: `Increase quantity for ${title}`,
    })
    await expect(increment).toBeEnabled()
    await increment.click()
  }
  await expect
    .poll(() => readCanonicalLines(page))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Cart stock increase", quantity: 2 }),
        expect.objectContaining({ title: "Cart stock untracked", quantity: 2 }),
      ])
    )

  await page.goto(`${marketUrl}/products`)
  const hud = page.getByRole("region", { name: "Cart inventory" })
  await expect(hud).toBeVisible()
  const toggle = hud.locator("button[aria-expanded]")
  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click()
  }
  for (const title of ["HUD stock increase", "HUD stock untracked"]) {
    const increment = hud.getByRole("button", {
      name: `Increase ${title} quantity`,
    })
    await expect(increment).toBeEnabled()
    await increment.click()
  }
  await expect
    .poll(() => readCanonicalLines(page))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "HUD stock increase", quantity: 2 }),
        expect.objectContaining({ title: "HUD stock untracked", quantity: 2 }),
      ])
    )
})

test("delayed stale quantity actions cannot restore a line removed in another tab @market", async ({
  context,
}) => {
  await seedLegacyCart(context, legacyCart)

  const currentTab = await context.newPage()
  const staleDecreaseTab = await context.newPage()
  const staleIncreaseTab = await context.newPage()
  await Promise.all([
    delayCartNotifications(staleDecreaseTab),
    delayCartNotifications(staleIncreaseTab),
  ])

  await Promise.all([
    currentTab.goto(`${marketUrl}/cart`),
    staleDecreaseTab.goto(`${marketUrl}/cart`),
    staleIncreaseTab.goto(`${marketUrl}/cart`),
  ])

  const remove = currentTab.getByRole("button", {
    name: "Remove Race item from cart",
  })
  const staleDecrease = staleDecreaseTab.getByRole("button", {
    name: "Decrease quantity for Race item",
  })
  const staleIncrease = staleIncreaseTab.getByRole("button", {
    name: "Increase quantity for Race item",
  })
  await expect(remove).toBeVisible()
  await expect(staleDecrease).toBeVisible()

  await remove.click()
  await expect(
    currentTab.getByRole("heading", { name: "Your cart is empty" })
  ).toBeVisible()

  await expect(staleDecrease).toBeVisible()
  expect(
    await staleDecreaseTab.evaluate(() =>
      (
        window as typeof window & {
          __cartNotificationDelay: { count(): number }
        }
      ).__cartNotificationDelay.count()
    )
  ).toBeGreaterThan(0)
  await staleDecrease.click()
  await staleIncrease.click()
  await expect(currentTab.getByText("Race item")).toHaveCount(0)

  for (const staleTab of [staleDecreaseTab, staleIncreaseTab]) {
    await staleTab.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow"))
    })
    await expect(
      staleTab.getByRole("heading", { name: "Your cart is empty" })
    ).toBeVisible()

    await staleTab.evaluate(() =>
      (
        window as typeof window & {
          __cartNotificationDelay: { release(): void }
        }
      ).__cartNotificationDelay.release()
    )
    await expect(
      staleTab.getByRole("heading", { name: "Your cart is empty" })
    ).toBeVisible()
  }
  await currentTab.reload()
  await expect(
    currentTab.getByRole("heading", { name: "Your cart is empty" })
  ).toBeVisible()
})

test("delayed product quote refreshes cannot restore a line removed in another tab @market", async ({
  context,
}) => {
  const item = pickupItem({
    merchant: MERCHANT,
    organizer: ORGANIZER,
    product: "quote-refresh",
    title: "Quote refresh item",
    event: "a",
    price: 10,
    currency: "USD",
  })
  await seedLegacyCart(context, { version: 2, items: [item] })

  const currentTab = await context.newPage()
  const staleProductTab = await context.newPage()
  await delayCartNotifications(staleProductTab)
  await Promise.all([
    currentTab.goto(`${marketUrl}/cart`),
    staleProductTab.goto(`${marketUrl}/cart`),
  ])

  const remove = currentTab.getByRole("button", {
    name: "Remove Quote refresh item from cart",
  })
  await expect(remove).toBeVisible()
  await expect(
    staleProductTab.getByRole("link", { name: "Quote refresh item" })
  ).toBeVisible()

  const staleItem = await staleProductTab.evaluate(async () => {
    const modulePath = "/src/lib/cart-repository.ts"
    const repository = (await import(/* @vite-ignore */ modulePath)) as {
      getCartRepositorySnapshot(): { items: CartItem[] }
    }
    return repository.getCartRepositorySnapshot().items[0]
  })
  expect(staleItem?.cartLineId).toBeTruthy()

  await remove.click()
  await expect(
    currentTab.getByRole("heading", { name: "Your cart is empty" })
  ).toBeVisible()

  const changed = await staleProductTab.evaluate(async (renderedItem) => {
    const modulePath = "/src/lib/cart-repository.ts"
    const repository = (await import(/* @vite-ignore */ modulePath)) as {
      refreshAndIncrementCartRepositoryItem(
        identity: CartItem,
        input: Omit<CartItem, "cartLineId" | "merchantAddedAt" | "quantity">,
        quantity: number
      ): Promise<{ changed: boolean }>
    }
    const {
      cartLineId: _cartLineId,
      merchantAddedAt: _merchantAddedAt,
      quantity: _quantity,
      ...candidate
    } = renderedItem
    void _cartLineId
    void _merchantAddedAt
    void _quantity
    candidate.priceSats = 1_250
    const result = await repository.refreshAndIncrementCartRepositoryItem(
      renderedItem,
      candidate,
      1
    )
    return result.changed
  }, staleItem!)

  expect(changed).toBe(false)
  await expect.poll(() => readCanonicalLines(currentTab)).toEqual([])
  await currentTab.reload()
  await expect(
    currentTab.getByRole("heading", { name: "Your cart is empty" })
  ).toBeVisible()
})

test("same-second product mutations preserve the NIP-01 cart winner @market", async ({
  context,
}) => {
  const staleSnapshot = {
    ...legacyCart.items[0]!,
    productId: `30402:${MERCHANT}:retained-snapshot`,
    title: "Older signed snapshot",
    price: 1_000,
    priceSats: 1_000,
    format: "physical" as const,
    fulfillment: { type: "shipping" as const },
    shippingCostSats: 100,
    shippingOptionId: "older-shipping",
    shippingOptionDTag: "older-shipping",
    shippingCountries: ["US"],
    shippingCountryRules: [
      { code: "US", name: "United States", restrictTo: [], exclude: [] },
    ],
    productUpdatedAt: 100,
    productEventId: "8".repeat(64),
    canonicalShippingResolved: true,
    publicZapEnabled: true,
    zapMessagePolicy: "custom" as const,
    publicZapPolicyKnown: true,
    stock: 10,
    quantity: 1,
  }
  await seedLegacyCart(context, { version: 2, items: [staleSnapshot] })

  const currentTab = await context.newPage()
  const staleTab = await context.newPage()
  await delayCartNotifications(staleTab)
  await Promise.all([
    currentTab.goto(`${marketUrl}/cart`),
    staleTab.goto(`${marketUrl}/cart`),
  ])

  await expect
    .poll(
      () =>
        staleTab.evaluate(async () => {
          const modulePath = "/src/lib/cart-repository.ts"
          const repository = (await import(/* @vite-ignore */ modulePath)) as {
            getCartRepositorySnapshot(): {
              hydrated: boolean
              items: CartItem[]
            }
          }
          const snapshot = repository.getCartRepositorySnapshot()
          return snapshot.hydrated ? snapshot.items[0]?.cartLineId : undefined
        }),
      { timeout: 30_000 }
    )
    .toBeTruthy()

  const renderedStaleItem = await staleTab.evaluate(async () => {
    const modulePath = "/src/lib/cart-repository.ts"
    const repository = (await import(/* @vite-ignore */ modulePath)) as {
      getCartRepositorySnapshot(): { items: CartItem[] }
    }
    return repository.getCartRepositorySnapshot().items[0]
  })

  const winningResult = await currentTab.evaluate(async () => {
    const modulePath = "/src/lib/cart-repository.ts"
    const repository = (await import(/* @vite-ignore */ modulePath)) as {
      getCartRepositorySnapshot(): { items: CartItem[] }
      refreshAndIncrementCartRepositoryItem(
        identity: CartItem,
        input: Omit<CartItem, "cartLineId" | "merchantAddedAt" | "quantity">,
        quantity: number
      ): Promise<{ changed: boolean }>
    }
    const item = repository.getCartRepositorySnapshot().items[0]!
    const {
      cartLineId: _cartLineId,
      merchantAddedAt: _merchantAddedAt,
      quantity: _quantity,
      ...candidate
    } = item
    void _cartLineId
    void _merchantAddedAt
    void _quantity
    const result = await repository.refreshAndIncrementCartRepositoryItem(
      item,
      {
        ...candidate,
        title: "Newer signed snapshot",
        price: 2_000,
        priceSats: 2_000,
        shippingCostSats: 200,
        shippingOptionId: "newer-shipping",
        shippingOptionDTag: "newer-shipping",
        shippingCountries: ["CA"],
        shippingCountryRules: [
          { code: "CA", name: "Canada", restrictTo: [], exclude: [] },
        ],
        productUpdatedAt: 100,
        productEventId: "7".repeat(64),
        publicZapEnabled: false,
        zapMessagePolicy: "generic_only",
        stock: 5,
      },
      1
    )
    return result.changed
  })
  expect(winningResult).toBe(true)

  const delayedResult = await staleTab.evaluate(async (staleItem) => {
    const modulePath = "/src/lib/cart-repository.ts"
    const repository = (await import(/* @vite-ignore */ modulePath)) as {
      refreshAndIncrementCartRepositoryItem(
        identity: CartItem,
        input: Omit<CartItem, "cartLineId" | "merchantAddedAt" | "quantity">,
        quantity: number
      ): Promise<{ changed: boolean; after: CartItem[] }>
      addCartRepositoryItem(
        input: Omit<CartItem, "cartLineId" | "merchantAddedAt" | "quantity">,
        quantity: number
      ): Promise<{ changed: boolean; after: CartItem[] }>
      incrementCartRepositoryItem(
        identity: CartItem,
        quantity: number,
        currentStockEvidence?: Pick<
          CartItem,
          "stock" | "productUpdatedAt" | "productEventId"
        >
      ): Promise<{ changed: boolean; after: CartItem[] }>
    }
    const {
      cartLineId: _cartLineId,
      merchantAddedAt: _merchantAddedAt,
      quantity: _quantity,
      ...candidate
    } = staleItem
    void _cartLineId
    void _merchantAddedAt
    void _quantity
    const refreshed = await repository.refreshAndIncrementCartRepositoryItem(
      staleItem,
      candidate,
      1
    )
    const added = await repository.addCartRepositoryItem(candidate, 1)
    const incremented = await repository.incrementCartRepositoryItem(
      staleItem,
      1,
      {
        stock: 99,
        productUpdatedAt: 100,
        productEventId: "8".repeat(64),
      }
    )
    return {
      changes: [refreshed.changed, added.changed, incremented.changed],
      item: incremented.after[0],
    }
  }, renderedStaleItem!)

  expect(delayedResult.changes).toEqual([true, true, true])
  expect(delayedResult.item).toEqual(
    expect.objectContaining({
      title: "Newer signed snapshot",
      price: 2_000,
      priceSats: 2_000,
      shippingCostSats: 200,
      shippingOptionId: "newer-shipping",
      shippingOptionDTag: "newer-shipping",
      shippingCountries: ["CA"],
      shippingCountryRules: [
        { code: "CA", name: "Canada", restrictTo: [], exclude: [] },
      ],
      productUpdatedAt: 100,
      productEventId: "7".repeat(64),
      publicZapEnabled: false,
      zapMessagePolicy: "generic_only",
      stock: 5,
      quantity: 5,
    })
  )

  const capturedPurchase = await currentTab.evaluate(async () => {
    const repositoryPath = "/src/lib/cart-repository.ts"
    const modelPath = "/src/lib/cart-model.ts"
    const repository = (await import(/* @vite-ignore */ repositoryPath)) as {
      getCartRepositorySnapshot(): { items: CartItem[] }
      captureCartPurchase(
        purchaseId: string,
        reviewedItems: CartItem[]
      ): Promise<CartPurchaseClaim>
    }
    const model = (await import(/* @vite-ignore */ modelPath)) as {
      groupCartPurchases(items: CartItem[]): Array<{
        id: string
        items: CartItem[]
      }>
    }
    const purchase = model.groupCartPurchases(
      repository.getCartRepositorySnapshot().items
    )[0]!
    return repository.captureCartPurchase(purchase.id, purchase.items)
  })
  expect(capturedPurchase.allocations).toHaveLength(1)
})

test("atomic quantity deltas preserve concurrent changes across signed-out tabs @market", async ({
  context,
}) => {
  await seedLegacyCart(context, {
    version: 2,
    items: [
      { ...legacyCart.items[0]!, title: "Alpha", quantity: 1 },
      {
        ...legacyCart.items[0]!,
        productId: `30402:${MERCHANT}:beta`,
        title: "Beta",
        quantity: 1,
      },
    ],
  })
  const first = await context.newPage()
  const second = await context.newPage()
  await delayCartNotifications(second)
  await Promise.all([
    first.goto(`${marketUrl}/cart`),
    second.goto(`${marketUrl}/cart`),
  ])
  await expect(
    first.getByRole("link", { name: "Alpha", exact: true })
  ).toBeVisible()
  await expect(
    second.getByRole("link", { name: "Beta", exact: true })
  ).toBeVisible()

  await Promise.all([
    first.getByRole("button", { name: "Increase quantity for Alpha" }).click(),
    second.getByRole("button", { name: "Increase quantity for Beta" }).click(),
  ])
  await expect
    .poll(async () => readCanonicalLines(first))
    .toEqual([
      expect.objectContaining({ title: "Alpha", quantity: 2 }),
      expect.objectContaining({ title: "Beta", quantity: 2 }),
    ])

  await second.evaluate(() =>
    (
      window as typeof window & {
        __cartNotificationDelay: { release(): void }
      }
    ).__cartNotificationDelay.release()
  )
  await expect(
    second.getByRole("button", { name: "Decrease quantity for Alpha" })
  ).toBeVisible()

  await Promise.all([
    first.getByRole("button", { name: "Increase quantity for Alpha" }).click(),
    second.getByRole("button", { name: "Decrease quantity for Alpha" }).click(),
  ])
  await expect
    .poll(async () => readCanonicalLines(first))
    .toEqual([
      expect.objectContaining({ title: "Alpha", quantity: 2 }),
      expect.objectContaining({ title: "Beta", quantity: 2 }),
    ])

  await second.evaluate(() =>
    (
      window as typeof window & {
        __cartNotificationDelay: { release(): void }
      }
    ).__cartNotificationDelay.release()
  )
  await expect(
    second.getByRole("button", { name: "Decrease quantity for Alpha" })
  ).toBeVisible()
  await Promise.all([
    first.getByRole("button", { name: "Decrease quantity for Alpha" }).click(),
    second.getByRole("button", { name: "Decrease quantity for Alpha" }).click(),
  ])
  await expect
    .poll(async () => readCanonicalLines(first))
    .toEqual([expect.objectContaining({ title: "Beta", quantity: 2 })])
  await second.evaluate(() =>
    (
      window as typeof window & {
        __cartNotificationDelay: { release(): void }
      }
    ).__cartNotificationDelay.release()
  )
  await second.reload()
  expect(await readCanonicalLines(second)).toEqual([
    expect.objectContaining({ title: "Beta", quantity: 2 }),
  ])
})

test("atomic concurrent additions preserve both new lines across signed-out tabs @market", async ({
  context,
}) => {
  await seedLegacyCart(context, legacyCart)
  const first = await context.newPage()
  const second = await context.newPage()
  await Promise.all([
    first.goto(`${marketUrl}/cart`),
    second.goto(`${marketUrl}/cart`),
  ])
  await expect(
    first.getByRole("link", { name: "Race item", exact: true })
  ).toBeVisible()
  await expect(
    second.getByRole("link", { name: "Race item", exact: true })
  ).toBeVisible()

  await Promise.all([
    addCartItemThroughRepository(first, {
      productId: `30402:${MERCHANT}:concurrent-alpha`,
      merchantPubkey: MERCHANT,
      title: "Concurrent alpha",
      price: 500,
      currency: "SATS",
      priceSats: 500,
      format: "digital",
    }),
    addCartItemThroughRepository(second, {
      productId: `30402:${MERCHANT}:concurrent-beta`,
      merchantPubkey: MERCHANT,
      title: "Concurrent beta",
      price: 700,
      currency: "SATS",
      priceSats: 700,
      format: "digital",
    }),
  ])

  await expect
    .poll(async () =>
      (await readCanonicalLines(first)).map((line) => line.title).sort()
    )
    .toEqual(["Concurrent alpha", "Concurrent beta", "Race item"])
})

test("a stale remove consumes only observed quantities and preserves a concurrent add @market", async ({
  context,
}) => {
  await seedLegacyCart(context, {
    ...legacyCart,
    items: [{ ...legacyCart.items[0]!, quantity: 1 }],
  })
  const addingTab = await context.newPage()
  const staleRemovingTab = await context.newPage()
  await delayCartNotifications(staleRemovingTab)
  await Promise.all([
    addingTab.goto(`${marketUrl}/cart`),
    staleRemovingTab.goto(`${marketUrl}/cart`),
  ])
  await expect(
    staleRemovingTab.getByRole("button", {
      name: "Remove Race item from cart",
    })
  ).toBeVisible()

  await addCartItemThroughRepository(addingTab, {
    productId: legacyCart.items[0]!.productId,
    merchantPubkey: MERCHANT,
    title: "Race item",
    price: 1_200,
    currency: "SATS",
    priceSats: 1_200,
    format: "digital",
  })
  await expect
    .poll(async () => readCanonicalLines(addingTab))
    .toEqual([expect.objectContaining({ title: "Race item", quantity: 2 })])

  await staleRemovingTab
    .getByRole("button", { name: "Remove Race item from cart" })
    .click()
  await expect
    .poll(async () => readCanonicalLines(addingTab))
    .toEqual([expect.objectContaining({ title: "Race item", quantity: 1 })])

  await staleRemovingTab.evaluate(() =>
    (
      window as typeof window & {
        __cartNotificationDelay: { release(): void }
      }
    ).__cartNotificationDelay.release()
  )
  await expect(
    staleRemovingTab.getByText("Qty 1", { exact: true })
  ).toBeVisible()
})

test("signed cart quantities can decrease and be removed while verification is unavailable @market", async ({
  context,
  page,
}) => {
  const signedProductEvent = finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      content: "Synthetic cart outage fixture",
      tags: [
        ["d", "race-item"],
        ["title", "Race item"],
        ["price", "1200", "SATS"],
        ["type", "simple", "digital"],
      ],
    },
    MERCHANT_SECRET
  )
  await seedLegacyCart(context, {
    ...legacyCart,
    items: [
      {
        ...legacyCart.items[0]!,
        productEventId: signedProductEvent.id,
        productUpdatedAt: 100000,
        signedProductEvent,
      },
    ],
  })
  await page.goto(`${marketUrl}/cart`)
  await expect(page.getByText("Qty 2", { exact: true })).toBeVisible()
  await page.evaluate(async (corePath) => {
    const repositoryPath = "/src/lib/cart-repository.ts"
    const proofPath = corePath.replace(
      /index\.ts$/,
      "protocol/verified-public-event.ts"
    )
    const repository = (await import(
      /* @vite-ignore */ repositoryPath
    )) as typeof import("../apps/market/src/lib/cart-repository")
    const proof = (await import(
      /* @vite-ignore */ proofPath
    )) as typeof import("../packages/core/src/protocol/verified-public-event")
    if (
      !proof.isVerifiedNostrEvent(
        repository.getCartRepositorySnapshot().items[0]?.signedProductEvent
      )
    ) {
      throw new Error(
        "Synthetic signed cart did not hydrate through the browser worker"
      )
    }
    proof.__resetPublicEventVerificationForTests()
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: undefined,
    })
  }, coreBrowserModulePath)

  await page
    .getByRole("button", { name: "Decrease quantity for Race item" })
    .click()
  await expect(page.getByText("Qty 1", { exact: true })).toBeVisible()
  const preserved = await page.evaluate(
    async ({ corePath, signedEvent }) => {
      const core = (await import(
        /* @vite-ignore */ corePath
      )) as typeof import("../packages/core/src")
      const proofPath = corePath.replace(
        /index\.ts$/,
        "protocol/verified-public-event.ts"
      )
      const proof = (await import(
        /* @vite-ignore */ proofPath
      )) as typeof import("../packages/core/src/protocol/verified-public-event")
      const row = await core.db.shoppingCarts.get("market")
      const line = row?.lines[0] as
        { item?: { signedProductEvent?: typeof signedEvent } } | undefined
      return (
        !!line?.item?.signedProductEvent &&
        proof.sameSignedPublicEvent(signedEvent, line.item.signedProductEvent)
      )
    },
    { corePath: coreBrowserModulePath, signedEvent: signedProductEvent }
  )
  expect(preserved).toBe(true)
  await page.getByRole("button", { name: "Remove Race item from cart" }).click()
  await expect(
    page.getByRole("heading", { name: "Your cart is empty" })
  ).toBeVisible()
  expect(await readCanonicalLines(page)).toEqual([])
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Your cart is empty" })
  ).toBeVisible()
})

test("legacy writes are ignored after the canonical migration boundary @market", async ({
  context,
  page,
}) => {
  await seedLegacyCart(context, legacyCart)
  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByRole("link", { name: "Race item", exact: true })
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("conduit:cart") ?? "null")?.version
      )
    )
    .toBe(3)

  await page.evaluate(
    (seed) => {
      localStorage.setItem("conduit:cart", JSON.stringify(seed))
    },
    {
      version: 2,
      items: [
        {
          ...legacyCart.items[0]!,
          productId: `30402:${MERCHANT}:obsolete-write`,
          title: "Obsolete write",
          quantity: 9,
        },
      ],
    }
  )
  await page.reload()
  await expect(
    page.getByRole("link", { name: "Race item", exact: true })
  ).toBeVisible()
  await expect(page.getByText("Obsolete write", { exact: true })).toHaveCount(0)

  const resumed = await context.newPage()
  await resumed.goto(`${marketUrl}/cart`)
  await expect(
    resumed.getByRole("link", { name: "Race item", exact: true })
  ).toBeVisible()
  expect(await readCanonicalLines(resumed)).toEqual([
    expect.objectContaining({ title: "Race item", quantity: 2 }),
  ])
})

test("an unsupported future cart stays untouched without a canonical record @market", async ({
  context,
  page,
}) => {
  const raw = JSON.stringify({ version: 3, items: legacyCart.items })
  await seedRawLegacyCart(context, raw)

  await page.goto(`${marketUrl}/cart`)
  await awaitCartRepositoryInitialization(page)

  expect(await page.evaluate(() => localStorage.getItem("conduit:cart"))).toBe(
    raw
  )
  expect(await hasCanonicalCartRecord(page)).toBe(false)
})

test("an unsupported future cart stays untouched beside canonical data @market", async ({
  context,
  page,
}) => {
  await seedLegacyCart(context, legacyCart)
  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByRole("link", { name: "Race item", exact: true })
  ).toBeVisible()

  const raw = JSON.stringify({ version: 3, items: legacyCart.items })
  await page.evaluate((value) => {
    localStorage.setItem("conduit:cart", value)
  }, raw)
  await page.reload()
  await expect(
    page.getByRole("link", { name: "Race item", exact: true })
  ).toBeVisible()

  expect(await page.evaluate(() => localStorage.getItem("conduit:cart"))).toBe(
    raw
  )
  expect(await readCanonicalLines(page)).toEqual([
    expect.objectContaining({ title: "Race item", quantity: 2 }),
  ])
})

test("fiat quote refreshes merge into one stock-bounded pickup line @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/products`)
  const base = pickupItem({
    merchant: MERCHANT,
    organizer: ORGANIZER,
    product: "fiat-pickup",
    title: "Fiat pickup",
    event: "a",
    price: 1,
    currency: "USD",
  })
  const initial = { ...base, stock: 2, priceSats: 1_000 }
  const refreshed = { ...initial, priceSats: 2_000 }

  await addCartItemThroughRepository(page, initial)
  await addCartItemThroughRepository(page, refreshed)
  await addCartItemThroughRepository(page, refreshed)

  expect(await readCanonicalLines(page)).toEqual([
    expect.objectContaining({
      title: "Fiat pickup",
      quantity: 2,
      priceSats: 2_000,
    }),
  ])
})

test("storage failure keeps the cart usable in one tab without claiming persistence @market", async ({
  context,
  page,
}) => {
  await seedLegacyCart(context, legacyCart)
  await context.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, "open", {
      configurable: true,
      value() {
        throw new DOMException(
          "Synthetic IndexedDB unavailability",
          "InvalidStateError"
        )
      },
    })
  })

  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByText(
      "Cart storage is unavailable. Changes work in this tab only and may not survive a reload or appear in another tab."
    )
  ).toBeVisible()
  await expect(page.getByText("Qty 2", { exact: true })).toBeVisible()
  await page
    .getByRole("button", { name: "Increase quantity for Race item" })
    .click()
  await expect(page.getByText("Qty 3", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Remove Race item from cart" }).click()
  await expect(
    page.getByRole("heading", { name: "Your cart is empty" })
  ).toBeVisible()
})

test("a mid-session storage failure preserves exact purchase cleanup in memory @market", async ({
  context,
  page,
}) => {
  await seedLegacyCart(context, legacyCart)
  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByRole("link", { name: "Race item", exact: true })
  ).toBeVisible()

  const result = await page.evaluate(async (corePath) => {
    const repositoryPath = "/src/lib/cart-repository.ts"
    const modelPath = "/src/lib/cart-model.ts"
    const repository = (await import(/* @vite-ignore */ repositoryPath)) as {
      getCartRepositorySnapshot(): {
        items: CartItem[]
        persistenceMode: "persistent" | "memory"
      }
      captureCartPurchase(
        purchaseId: string,
        reviewedItems: readonly CartItem[]
      ): Promise<CartPurchaseClaim>
      consumeCartPurchase(claim: CartPurchaseClaim): Promise<{
        changed: boolean
      }>
    }
    const model = (await import(/* @vite-ignore */ modelPath)) as {
      groupCartPurchases(items: CartItem[]): Array<{ id: string }>
    }
    const core = (await import(/* @vite-ignore */ corePath)) as {
      db: object
    }
    const snapshot = repository.getCartRepositorySnapshot()
    const purchase = model.groupCartPurchases(snapshot.items)[0]
    if (!purchase) throw new Error("Synthetic purchase is missing")

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction("shoppingCarts", "readwrite")
        const store = transaction.objectStore("shoppingCarts")
        const get = store.get("market")
        get.onerror = () => reject(get.error)
        get.onsuccess = () => {
          const record = get.result
          const line = record?.lines?.[0]
          if (!line) {
            reject(new Error("Synthetic canonical line is missing"))
            return
          }
          const quantity = line.batches.reduce(
            (sum: number, batch: { quantity: number }) => sum + batch.quantity,
            0
          )
          line.batches = [{ id: "batch:synthetic-replaced", quantity }]
          record.revision += 1
          record.updatedAt += 1
          store.put(record)
        }
        transaction.oncomplete = () => {
          database.close()
          resolve()
        }
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })

    const claim = await repository.captureCartPurchase(
      purchase.id,
      snapshot.items
    )
    Object.defineProperty(core.db, "transaction", {
      configurable: true,
      value() {
        throw new DOMException(
          "Synthetic mid-session IndexedDB failure",
          "InvalidStateError"
        )
      },
    })
    const consumed = await repository.consumeCartPurchase(claim)
    const after = repository.getCartRepositorySnapshot()
    return {
      changed: consumed.changed,
      itemCount: after.items.length,
      persistenceMode: after.persistenceMode,
    }
  }, coreBrowserModulePath)

  expect(result).toEqual({
    changed: true,
    itemCount: 0,
    persistenceMode: "memory",
  })
  await expect(
    page.getByRole("heading", { name: "Your cart is empty" })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole("link", { name: "Race item", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText(
      "Cart storage is unavailable. Changes work in this tab only and may not survive a reload or appear in another tab."
    )
  ).toHaveCount(0)
})

test("mixed shipping, two events, and two merchants become separate purchasable groups @market", async ({
  context,
  page,
}) => {
  const merchantB = "b".repeat(64)
  const organizer = ORGANIZER
  await seedLegacyCart(context, {
    version: 2,
    items: [
      {
        ...legacyCart.items[0]!,
        title: "Shipped item",
        format: "physical",
        fulfillment: { type: "shipping" },
      },
      pickupItem({
        merchant: MERCHANT,
        organizer,
        product: "event-a",
        title: "Event A item",
        event: "a",
      }),
      pickupItem({
        merchant: MERCHANT,
        organizer,
        product: "event-b",
        title: "Event B item",
        event: "b",
      }),
      {
        ...legacyCart.items[0]!,
        merchantPubkey: merchantB,
        productId: `30402:${merchantB}:other-store`,
        title: "Other store item",
        format: "digital",
      },
    ],
  })

  await page.goto(`${marketUrl}/cart`)
  await addCartItemThroughRepository(
    page,
    pickupItem({
      merchant: MERCHANT,
      organizer,
      product: "race-item",
      title: "Shipped listing at Event A",
      event: "a",
    })
  )
  await expect
    .poll(async () =>
      (await readCanonicalLines(page)).map((line) => line.title).sort()
    )
    .toEqual([
      "Event A item",
      "Event B item",
      "Other store item",
      "Shipped item",
      "Shipped listing at Event A",
    ])
  await expect(
    page.getByText("Conflicting fulfillment was separated")
  ).toBeVisible()
  await expect(page.getByLabel(/Clear .* purchase/)).toHaveCount(4)
  await expect(
    page.getByRole("button", { name: "Order", exact: true })
  ).toHaveCount(4)
  await expect(
    page.getByText("Separate fulfillment", { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByText("Shipping / delivery", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText(/^Event pickup · Shared entrance · /)
  ).toHaveCount(2)

  await page.goto(`${marketUrl}/checkout?merchant=${MERCHANT}`)
  await expect(
    page.getByRole("heading", { name: "Choose a purchase before ordering" })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: /Shipping \/ delivery/ })
  ).toHaveCount(1)
  await expect(page.getByRole("link", { name: /Event pickup/ })).toHaveCount(2)
  await expect(
    page.getByRole("link", { name: /Event pickup/ }).filter({
      hasText: "Event A item",
    })
  ).toHaveCount(1)
  await expect(
    page.getByRole("link", { name: /Event pickup/ }).filter({
      hasText: "Event B item",
    })
  ).toHaveCount(1)

  await page.goto(`${marketUrl}/cart`)
  const eventBPurchase = page
    .getByText("Event B item", { exact: true })
    .first()
    .locator("xpath=ancestor::section[1]")
  await eventBPurchase.getByRole("button", { name: "Review 1 item" }).click()
  await eventBPurchase
    .getByRole("button", { name: "Remove Event B item from cart" })
    .click()
  await expect(page.getByText("Event B item", { exact: true })).toHaveCount(0)
  await expect(page.getByLabel(/Clear .* purchase/)).toHaveCount(3)
})

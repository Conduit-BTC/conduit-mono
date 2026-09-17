import { fileURLToPath } from "node:url"

import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import type { CartItem } from "../apps/market/src/lib/cart-model"
import type { CartPurchaseClaim } from "../apps/market/src/lib/cart-repository"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const coreBrowserModulePath = `/@fs${fileURLToPath(
  new URL("../packages/core/src/index.ts", import.meta.url)
)}`

const MERCHANT = "a".repeat(64)

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
  seed: typeof legacyCart
): Promise<void> {
  await context.addInitScript((value) => {
    if (localStorage.getItem("conduit:cart") === null) {
      localStorage.setItem("conduit:cart", JSON.stringify(value))
    }
  }, seed)
}

async function readCanonicalLines(
  page: Page
): Promise<Array<{ id: string; title: string; quantity: number }>> {
  return page.evaluate(
    () =>
      new Promise<Array<{ id: string; title: string; quantity: number }>>(
        (resolve, reject) => {
          const request = indexedDB.open("conduit")
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction(
              "shoppingCarts",
              "readonly"
            )
            const get = transaction.objectStore("shoppingCarts").get("market")
            transaction.oncomplete = () => {
              const lines = Array.isArray(get.result?.lines)
                ? get.result.lines
                : []
              resolve(
                lines.map(
                  (line: {
                    id: string
                    item: { title: string }
                    batches: Array<{ quantity: number }>
                  }) => ({
                    id: line.id,
                    title: line.item.title,
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
        }
      )
  )
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
}) {
  const evidenceDigits =
    input.event === "a" ? ["1", "2", "3", "4"] : ["5", "6", "7", "8"]
  const createdAtOffset = input.event === "a" ? 0 : 100
  const coordinate = `30402:${input.merchant}:${input.product}`
  return {
    productId: coordinate,
    merchantPubkey: input.merchant,
    title: input.title,
    price: 1_000,
    currency: "SATS",
    priceSats: 1_000,
    format: "physical" as const,
    quantity: 1,
    fulfillment: {
      type: "pickup" as const,
      organizerPubkey: input.organizer,
      product: {
        coordinate,
        eventId: evidenceDigits[0]!.repeat(64),
        createdAt: 100 + createdAtOffset,
        merchantPubkey: input.merchant,
      },
      calendar: {
        coordinate: `31922:${input.organizer}:event-${input.event}`,
        eventId: evidenceDigits[1]!.repeat(64),
        createdAt: 101 + createdAtOffset,
      },
      collection: {
        coordinate: `30405:${input.organizer}:market-${input.event}`,
        eventId: evidenceDigits[2]!.repeat(64),
        createdAt: 102 + createdAtOffset,
      },
      option: {
        coordinate: `30406:${input.organizer}:pickup-${input.event}`,
        eventId: evidenceDigits[3]!.repeat(64),
        createdAt: 103 + createdAtOffset,
        title: "Shared entrance",
        location: "Fixture Hall",
      },
      handoffMode: "organizer_handoff" as const,
      handlerPubkey: input.organizer,
      costSats: 0,
      sourceCost: { amount: 0, currency: "SAT", normalizedCurrency: "SAT" },
    },
  }
}

async function delayCartNotifications(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type DelayControl = {
      count(): number
      release(): void
    }
    const queued: Array<() => void> = []
    const NativeBroadcastChannel = window.BroadcastChannel

    class DelayedBroadcastChannel extends NativeBroadcastChannel {
      private assignedHandler: ((event: MessageEvent) => void) | null = null

      constructor(name: string) {
        super(name)
      }

      override set onmessage(
        listener: ((this: BroadcastChannel, ev: MessageEvent) => unknown) | null
      ) {
        this.assignedHandler = listener
          ? (event) => listener.call(this, event)
          : null
        super.onmessage = this.assignedHandler
          ? (event) => {
              queued.push(() => this.assignedHandler?.(event))
            }
          : null
      }

      override get onmessage() {
        return this.assignedHandler
      }
    }

    window.BroadcastChannel = DelayedBroadcastChannel

    const addEventListener = window.addEventListener.bind(window)
    const removeEventListener = window.removeEventListener.bind(window)
    const storageListeners = new Map<
      EventListenerOrEventListenerObject,
      EventListener
    >()
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type !== "storage") {
        addEventListener(type, listener, options)
        return
      }
      const delayed: EventListener = (event) => {
        queued.push(() => {
          if (typeof listener === "function") listener.call(window, event)
          else listener.handleEvent(event)
        })
      }
      storageListeners.set(listener, delayed)
      addEventListener(type, delayed, options)
    }) as typeof window.addEventListener
    window.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) => {
      removeEventListener(
        type,
        type === "storage"
          ? (storageListeners.get(listener) ?? listener)
          : listener,
        options
      )
      storageListeners.delete(listener)
    }) as typeof window.removeEventListener

    ;(
      window as typeof window & { __cartNotificationDelay: DelayControl }
    ).__cartNotificationDelay = {
      count: () => queued.length,
      release: () => {
        const pending = queued.splice(0)
        for (const deliver of pending.reverse()) deliver()
      },
    }
  })
}

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
  await expect(first.getByText("Alpha", { exact: true })).toBeVisible()
  await expect(second.getByText("Beta", { exact: true })).toBeVisible()

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
  await expect(first.getByText("Race item", { exact: true })).toBeVisible()
  await expect(second.getByText("Race item", { exact: true })).toBeVisible()

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

test("legacy writes are ignored after the canonical migration boundary @market", async ({
  context,
  page,
}) => {
  await seedLegacyCart(context, legacyCart)
  await page.goto(`${marketUrl}/cart`)
  await expect(page.getByText("Race item", { exact: true })).toBeVisible()
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
  await expect(page.getByText("Race item", { exact: true })).toBeVisible()
  await expect(page.getByText("Obsolete write", { exact: true })).toHaveCount(0)

  const resumed = await context.newPage()
  await resumed.goto(`${marketUrl}/cart`)
  await expect(resumed.getByText("Race item", { exact: true })).toBeVisible()
  expect(await readCanonicalLines(resumed)).toEqual([
    expect.objectContaining({ title: "Race item", quantity: 2 }),
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
  await expect(page.getByText("Race item", { exact: true })).toBeVisible()

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
  await expect(page.getByText("Race item", { exact: true })).toBeVisible()
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
  const organizer = "c".repeat(64)
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
    page.getByText("Event pickup · Shared entrance", { exact: true })
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
    .getByText(/Event B item · Ref/)
    .locator("xpath=ancestor::section[1]")
  await eventBPurchase.getByRole("button", { name: "Review 1 item" }).click()
  await eventBPurchase
    .getByRole("button", { name: "Remove Event B item from cart" })
    .click()
  await expect(page.getByText("Event B item", { exact: true })).toHaveCount(0)
  await expect(page.getByLabel(/Clear .* purchase/)).toHaveCount(3)
})

import { expect, test } from "@playwright/test"
import { nip19 } from "@nostr-dev-kit/ndk"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`

test("fresh shopper opens a hinted signed product at checkout without submitting an order @market", async ({
  page,
}) => {
  const merchantKey = generateSecretKey()
  const product = finalizeEvent(
    {
      kind: 30402,
      created_at: Math.floor(Date.now() / 1000),
      content: "Synthetic link checkout product.",
      tags: [
        ["d", "handoff-fresh-product"],
        ["title", "Synthetic handoff product"],
        ["price", "1000", "SATS"],
        ["type", "simple", "digital"],
        ["stock", "5"],
        ["image", "https://blossom.conduit.market/handoff-product.png"],
      ],
    },
    merchantKey
  )
  await publishTestRelayEvents([product])
  const naddr = nip19.naddrEncode({
    kind: 30402,
    pubkey: product.pubkey,
    identifier: "handoff-fresh-product",
    relays: [TEST_RELAY_URL],
  })
  await page.goto(
    `${marketUrl}/checkout#${new URLSearchParams({ buy: naddr }).toString()}`
  )
  await expect.poll(() => page.url()).not.toContain("#")
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const modulePath = "/src/lib/cart-repository.ts"
          const repository = await import(/* @vite-ignore */ modulePath)
          await repository.initializeCartRepository()
          return repository.getCartRepositorySnapshot().items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
          }))
        }),
      { timeout: 30_000 }
    )
    .toEqual([
      {
        productId: `30402:${product.pubkey}:handoff-fresh-product`,
        quantity: 1,
      },
    ])
  await expect(
    page.getByRole("heading", { name: "Opening linked checkout" })
  ).toHaveCount(0)
  const orderCount = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "orderLifecycles",
            "readonly"
          )
          const count = transaction.objectStore("orderLifecycles").count()
          count.onsuccess = () => {
            resolve(count.result)
            database.close()
          }
          count.onerror = () => reject(count.error)
        }
      })
  )
  expect(orderCount).toBe(0)
  await page.reload()
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const modulePath = "/src/lib/cart-repository.ts"
        const repository = await import(/* @vite-ignore */ modulePath)
        return repository.getCartRepositorySnapshot().items[0]?.quantity
      })
    )
    .toBe(1)
})

test("signed cart link keeps existing items until the shopper replaces the merchant purchase @market", async ({
  page,
}) => {
  const merchantKey = generateSecretKey()
  const createdAt = Math.floor(Date.now() / 1000)
  const products = ["one", "two"].map((name) =>
    finalizeEvent(
      {
        kind: 30402,
        created_at: createdAt,
        content: `Synthetic ${name}.`,
        tags: [
          ["d", `handoff-${name}`],
          ["title", `Synthetic ${name}`],
          ["price", "1000", "SATS"],
          ["type", "simple", "digital"],
          ["stock", "10"],
          ["image", `https://blossom.conduit.market/handoff-${name}.png`],
        ],
      },
      merchantKey
    )
  )
  await publishTestRelayEvents(products)
  const merchant = products[0]!.pubkey
  await page.goto(marketUrl)
  await page.evaluate(
    async ({ merchant }) => {
      const modulePath = "/src/lib/cart-repository.ts"
      const repository = await import(/* @vite-ignore */ modulePath)
      await repository.initializeCartRepository()
      await repository.addCartRepositoryItem({
        productId: `30402:${merchant}:old`,
        merchantPubkey: merchant,
        title: "Old",
        price: 1000,
        currency: "SATS",
        format: "digital",
        fulfillment: { type: "digital" },
        stock: 10,
      })
      await repository.addCartRepositoryItem({
        productId: `30402:${"b".repeat(64)}:other`,
        merchantPubkey: "b".repeat(64),
        title: "Other merchant",
        price: 1000,
        currency: "SATS",
        format: "digital",
        fulfillment: { type: "digital" },
        stock: 10,
      })
    },
    { merchant }
  )
  const items = products.map((product, index) => ({
    product: nip19.naddrEncode({
      kind: 30402,
      pubkey: merchant,
      identifier: `handoff-${index === 0 ? "one" : "two"}`,
      relays: [TEST_RELAY_URL],
    }),
    quantity: index + 2,
  }))
  await page.goto(
    `${marketUrl}/checkout#${new URLSearchParams({ cart: JSON.stringify({ v: 1, items }) }).toString()}`
  )
  await expect(
    page.getByRole("heading", { name: "Choose your purchase" })
  ).toBeVisible({ timeout: 30_000 })
  const before = await page.evaluate(async () => {
    const modulePath = "/src/lib/cart-repository.ts"
    const repository = await import(/* @vite-ignore */ modulePath)
    return repository
      .getCartRepositorySnapshot()
      .items.map((item) => item.productId)
  })
  expect(before).toContain(`30402:${merchant}:old`)
  await page.getByRole("button", { name: "Use linked items" }).click()
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const modulePath = "/src/lib/cart-repository.ts"
        const repository = await import(/* @vite-ignore */ modulePath)
        return repository
          .getCartRepositorySnapshot()
          .items.map((item) => [item.productId, item.quantity])
          .sort()
      })
    )
    .toEqual(
      [
        [`30402:${"b".repeat(64)}:other`, 1],
        [`30402:${merchant}:handoff-one`, 2],
        [`30402:${merchant}:handoff-two`, 3],
      ].sort()
    )
  await expect.poll(() => page.url()).not.toContain("#")
})

test("invalid checkout fragment is scrubbed and cannot fall through to the cart @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/checkout?intent=zap#buy=not-a-product`)
  await expect(
    page.getByRole("heading", { name: "Checkout link needs attention" })
  ).toBeVisible()
  await expect.poll(() => page.url()).not.toContain("#")
  await expect.poll(() => page.url()).not.toContain("intent=zap")
  await expect(
    page.getByText("This checkout link is invalid.", { exact: false })
  ).toBeVisible()
  await page.getByRole("button", { name: "Keep my cart" }).click()
  await expect(
    page.getByRole("heading", { name: "Cart is empty" })
  ).toBeVisible()
})

test("linked purchase installs exact quantities, requires choice, and protects other merchants @market", async ({
  page,
  context,
}) => {
  await page.goto(marketUrl)
  const initial = await page.evaluate(async () => {
    const repository = await import(
      /* @vite-ignore */ "/src/lib/cart-repository.ts"
    )
    await repository.initializeCartRepository()
    await repository.clearCartRepository()
    const merchant = "a".repeat(64)
    const other = "b".repeat(64)
    const make = (pubkey: string, d: string, quantity: number) => ({
      productId: `30402:${pubkey}:${d}`,
      merchantPubkey: pubkey,
      title: d,
      price: 1000,
      currency: "SATS",
      format: "digital" as const,
      fulfillment: { type: "digital" as const },
      stock: 20,
      quantity,
      productUpdatedAt: 100,
      productEventId: "1".repeat(64),
    })
    const first = make(merchant, "first", 2)
    const second = make(merchant, "second", 3)
    const revision = repository.getCartRepositorySnapshot().revision
    const installed = await repository.installCheckoutIntentPurchase(
      [first, second],
      revision,
      false
    )
    const replay = await repository.installCheckoutIntentPurchase(
      [first, second],
      repository.getCartRepositorySnapshot().revision,
      false
    )
    const conflict = await repository.installCheckoutIntentPurchase(
      [make(merchant, "third", 1)],
      repository.getCartRepositorySnapshot().revision,
      false
    )
    await repository.addCartRepositoryItem(make(other, "retained", 1))
    const replaced = await repository.installCheckoutIntentPurchase(
      [make(merchant, "third", 1)],
      repository.getCartRepositorySnapshot().revision,
      true
    )
    return {
      installed,
      replay,
      conflict,
      replaced,
      items: repository.getCartRepositorySnapshot().items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
    }
  })
  expect(initial.installed.status).toBe("installed")
  expect(initial.replay.status).toBe("unchanged")
  expect(initial.conflict.status).toBe("cart_conflict")
  expect(initial.replaced.status).toBe("installed")
  expect(initial.items).toEqual(
    expect.arrayContaining([
      { productId: `30402:${"a".repeat(64)}:third`, quantity: 1 },
      { productId: `30402:${"b".repeat(64)}:retained`, quantity: 1 },
    ])
  )
  expect(initial.items).toHaveLength(2)

  const staleRevision = await page.evaluate(async () => {
    const repository = await import(
      /* @vite-ignore */ "/src/lib/cart-repository.ts"
    )
    return repository.getCartRepositorySnapshot().revision
  })
  const secondTab = await context.newPage()
  await secondTab.goto(marketUrl)
  await secondTab.evaluate(async () => {
    const repository = await import(
      /* @vite-ignore */ "/src/lib/cart-repository.ts"
    )
    await repository.initializeCartRepository()
    await repository.addCartRepositoryItem({
      productId: `30402:${"c".repeat(64)}:parallel`,
      merchantPubkey: "c".repeat(64),
      title: "Parallel",
      price: 1000,
      currency: "SATS",
      format: "digital",
      fulfillment: { type: "digital" },
      stock: 10,
    })
  })
  const stale = await page.evaluate(async (revision) => {
    const repository = await import(
      /* @vite-ignore */ "/src/lib/cart-repository.ts"
    )
    return repository.installCheckoutIntentPurchase(
      [
        {
          productId: `30402:${"a".repeat(64)}:fourth`,
          merchantPubkey: "a".repeat(64),
          title: "Fourth",
          price: 1000,
          currency: "SATS",
          format: "digital",
          fulfillment: { type: "digital" },
          stock: 10,
          quantity: 1,
        },
      ],
      revision,
      true
    )
  }, staleRevision)
  expect(stale.status).toBe("revision_conflict")
  await secondTab.close()
})

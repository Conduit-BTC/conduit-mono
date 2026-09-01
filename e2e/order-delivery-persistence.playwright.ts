import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
const checkpointHarnessUrl =
  "/src/test-fixtures/order-delivery-checkpoint-harness.ts"
const strictModeRetryHarnessUrl =
  "/src/test-fixtures/order-delivery-retry-strict-mode-harness.tsx"

type StoredOrderDelivery = {
  orderId: string
  orderDeliveryStatus: "pending" | "sent"
  phase: "pending" | "in_progress"
  orderRelayDelivery: {
    signedRecipientWrap: {
      id: string
      content: string
    }
    relayDelivery: Array<{
      relayUrl: string
      status: "pending" | "acked" | "timed_out"
    }>
  }
}

type CheckpointBrowserState = {
  orders: Array<
    Pick<StoredOrderDelivery, "orderId" | "orderDeliveryStatus" | "phase">
  >
  merchantProductIds: string[]
  otherMerchantProductIds: string[]
}

async function readCheckpointBrowserState(
  page: import("@playwright/test").Page,
  input: { merchantPubkey: string; otherMerchantPubkey: string }
): Promise<CheckpointBrowserState> {
  return await page.evaluate(async (stateInput) => {
    const orders = await new Promise<
      Array<
        Pick<StoredOrderDelivery, "orderId" | "orderDeliveryStatus" | "phase">
      >
    >((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction("orderLifecycles", "readonly")
        const getAll = transaction.objectStore("orderLifecycles").getAll()
        getAll.onsuccess = () =>
          resolve(
            (getAll.result as StoredOrderDelivery[]).map((order) => ({
              orderId: order.orderId,
              orderDeliveryStatus: order.orderDeliveryStatus,
              phase: order.phase,
            }))
          )
        getAll.onerror = () => reject(getAll.error)
        transaction.oncomplete = () => database.close()
      }
    })
    const cart = JSON.parse(localStorage.getItem("conduit:cart") ?? "{}") as {
      items?: Array<{ merchantPubkey?: string; productId?: string }>
    }
    const productIdsFor = (merchantPubkey: string) =>
      (cart.items ?? [])
        .filter((item) => item.merchantPubkey === merchantPubkey)
        .map((item) => item.productId ?? "")

    return {
      orders,
      merchantProductIds: productIdsFor(stateInput.merchantPubkey),
      otherMerchantProductIds: productIdsFor(stateInput.otherMerchantPubkey),
    }
  }, input)
}

test("a committed checkpoint retires only its merchant cart before interrupted relay delivery @market", async ({
  page,
}) => {
  await page.goto(marketUrl)
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some(
      (database) => database.name === "conduit"
    )
  )
  const orderId = `checkpoint-order-${Date.now()}`
  const buyerPubkey = "a".repeat(64)
  const merchantPubkey = "b".repeat(64)
  const otherMerchantPubkey = "9".repeat(64)
  const productId = "30402:" + merchantPubkey + ":checkpoint-product"
  const otherProductId = "30402:" + otherMerchantPubkey + ":retained-product"

  await page.evaluate(
    ({ merchant, otherMerchant, submittedProduct, retainedProduct }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 2,
          items: [
            {
              productId: submittedProduct,
              merchantPubkey: merchant,
              title: "Checkpoint product",
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
            {
              productId: retainedProduct,
              merchantPubkey: otherMerchant,
              title: "Retained product",
              price: 2,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
          ],
        })
      )
    },
    {
      merchant: merchantPubkey,
      otherMerchant: otherMerchantPubkey,
      submittedProduct: productId,
      retainedProduct: otherProductId,
    }
  )

  try {
    await page.evaluate(
      async ({ harnessUrl, order, buyer, merchant, product }) => {
        const harness = (await import(harnessUrl)) as {
          startInterruptedOrderCheckpoint: (input: {
            orderId: string
            buyerPubkey: string
            merchantPubkey: string
            productId: string
          }) => Promise<void>
        }
        await harness.startInterruptedOrderCheckpoint({
          orderId: order,
          buyerPubkey: buyer,
          merchantPubkey: merchant,
          productId: product,
        })
      },
      {
        harnessUrl: checkpointHarnessUrl,
        order: orderId,
        buyer: buyerPubkey,
        merchant: merchantPubkey,
        product: productId,
      }
    )

    const atCheckpoint = await readCheckpointBrowserState(page, {
      merchantPubkey,
      otherMerchantPubkey,
    })
    expect(atCheckpoint.orders).toEqual([
      { orderId, orderDeliveryStatus: "pending", phase: "pending" },
    ])
    expect(atCheckpoint.merchantProductIds).toEqual([])
    expect(atCheckpoint.otherMerchantProductIds).toEqual([otherProductId])

    await page.reload()

    const afterInterruption = await readCheckpointBrowserState(page, {
      merchantPubkey,
      otherMerchantPubkey,
    })
    expect(afterInterruption.orders).toEqual([
      { orderId, orderDeliveryStatus: "pending", phase: "pending" },
    ])
    expect(afterInterruption.merchantProductIds).toEqual([])
    expect(afterInterruption.otherMerchantProductIds).toEqual([otherProductId])
  } finally {
    await page.evaluate(async (cleanupOrderId) => {
      localStorage.removeItem("conduit:cart")
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "orderLifecycles",
            "readwrite"
          )
          transaction.objectStore("orderLifecycles").delete(cleanupOrderId)
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
    }, orderId)
  }
})

test("startup repairs a cart when the document stops immediately after the lifecycle checkpoint @market", async ({
  page,
}) => {
  await page.goto(marketUrl)
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some(
      (database) => database.name === "conduit"
    )
  )
  const orderId = `checkpoint-crash-order-${Date.now()}`
  const buyerPubkey = "1".repeat(64)
  const merchantPubkey = "2".repeat(64)
  const otherMerchantPubkey = "3".repeat(64)
  const productId = `30402:${merchantPubkey}:submitted-product`
  const newerProductId = `30402:${merchantPubkey}:newer-product`
  const otherProductId = `30402:${otherMerchantPubkey}:other-product`

  await page.evaluate(
    ({ merchant, otherMerchant, product, otherProduct }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 2,
          items: [
            {
              productId: product,
              merchantPubkey: merchant,
              title: "Submitted product",
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 2,
            },
            {
              productId: otherProduct,
              merchantPubkey: otherMerchant,
              title: "Other product",
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
          ],
        })
      )
    },
    {
      merchant: merchantPubkey,
      otherMerchant: otherMerchantPubkey,
      product: productId,
      otherProduct: otherProductId,
    }
  )

  try {
    await page.evaluate(
      async ({ harnessUrl, order, buyer, merchant, product }) => {
        const harness = (await import(harnessUrl)) as {
          startInterruptedOrderCheckpoint: (input: {
            orderId: string
            buyerPubkey: string
            merchantPubkey: string
            productId: string
            skipImmediateCartReconciliation: true
          }) => Promise<void>
        }
        await harness.startInterruptedOrderCheckpoint({
          orderId: order,
          buyerPubkey: buyer,
          merchantPubkey: merchant,
          productId: product,
          skipImmediateCartReconciliation: true,
        })
      },
      {
        harnessUrl: checkpointHarnessUrl,
        order: orderId,
        buyer: buyerPubkey,
        merchant: merchantPubkey,
        product: productId,
      }
    )

    await page.evaluate(
      ({ merchant, product, newerProduct }) => {
        const cart = JSON.parse(localStorage.getItem("conduit:cart") ?? "{}")
        const submitted = cart.items.find(
          (item: { productId?: string }) => item.productId === product
        )
        submitted.quantity = 3
        cart.items.push({
          productId: newerProduct,
          merchantPubkey: merchant,
          title: "Newer product",
          price: 2,
          currency: "SATS",
          format: "digital",
          quantity: 1,
        })
        localStorage.setItem("conduit:cart", JSON.stringify(cart))
      },
      {
        merchant: merchantPubkey,
        product: productId,
        newerProduct: newerProductId,
      }
    )

    await page.reload()
    await page.waitForFunction(
      ({ product, newerProduct }) => {
        const cart = JSON.parse(localStorage.getItem("conduit:cart") ?? "{}")
        const quantities = new Map(
          (cart.items ?? []).map(
            (item: { productId: string; quantity: number }) => [
              item.productId,
              item.quantity,
            ]
          )
        )
        return (
          quantities.get(product) === 1 && quantities.get(newerProduct) === 1
        )
      },
      { product: productId, newerProduct: newerProductId }
    )
    const repaired = await readCheckpointBrowserState(page, {
      merchantPubkey,
      otherMerchantPubkey,
    })
    expect(repaired.merchantProductIds).toEqual([productId, newerProductId])
    expect(repaired.otherMerchantProductIds).toEqual([otherProductId])
  } finally {
    await page.evaluate(async (cleanupOrderId) => {
      localStorage.removeItem("conduit:cart")
      const request = indexedDB.open("conduit")
      await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "orderLifecycles",
            "readwrite"
          )
          transaction.objectStore("orderLifecycles").delete(cleanupOrderId)
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
        }
      })
    }, orderId)
  }
})

test("cart retirement preserves a newer mutation queued from another tab @market", async ({
  context,
  page,
}) => {
  await page.goto(marketUrl)
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some(
      (database) => database.name === "conduit"
    )
  )
  const orderId = `cross-tab-retirement-${Date.now()}`
  const buyerPubkey = "1".repeat(64)
  const merchantPubkey = "2".repeat(64)
  const productId = `30402:${merchantPubkey}:cross-tab-retirement`
  const productTitle = "Cross-tab retirement product"
  const lineGenerationId = "cross-tab-retirement-generation"

  await page.evaluate(
    ({ merchant, product, title, generation }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 3,
          items: [
            {
              productId: product,
              merchantPubkey: merchant,
              lineGenerationId: generation,
              merchantAddedAt: 1,
              title,
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
          ],
          appliedOrderRetirements: [],
        })
      )
    },
    {
      merchant: merchantPubkey,
      product: productId,
      title: productTitle,
      generation: lineGenerationId,
    }
  )

  const otherPage = await context.newPage()
  try {
    await otherPage.goto(`${marketUrl}/cart`)
    const increase = otherPage.getByRole("button", {
      name: `Increase quantity for ${productTitle}`,
    })
    await expect(increase).toBeVisible()

    await page.evaluate(
      async ({ harnessUrl, order, buyer, merchant, product }) => {
        const harness = (await import(harnessUrl)) as {
          startInterruptedOrderCheckpoint: (input: {
            orderId: string
            buyerPubkey: string
            merchantPubkey: string
            productId: string
            skipImmediateCartReconciliation: true
          }) => Promise<void>
        }
        await harness.startInterruptedOrderCheckpoint({
          orderId: order,
          buyerPubkey: buyer,
          merchantPubkey: merchant,
          productId: product,
          skipImmediateCartReconciliation: true,
        })
      },
      {
        harnessUrl: checkpointHarnessUrl,
        order: orderId,
        buyer: buyerPubkey,
        merchant: merchantPubkey,
        product: productId,
      }
    )

    await page.evaluate(async () => {
      const cart =
        (await import("/src/hooks/useCart.ts")) as typeof import("../apps/market/src/hooks/useCart")
      type ReconciliationWindow = Window & {
        __conduitCartReconciliationPaused?: boolean
        __conduitCartReconciliationDone?: boolean
        __conduitReleaseCartReconciliation?: () => void
      }
      const testWindow = window as ReconciliationWindow
      let release!: () => void
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      testWindow.__conduitReleaseCartReconciliation = release
      void cart
        .reconcilePendingOrderCartRetirements({
          afterStorageRead: async () => {
            testWindow.__conduitCartReconciliationPaused = true
            await barrier
          },
        })
        .then((result) => {
          testWindow.__conduitCartReconciliationDone = result
        })
    })
    await page.waitForFunction(
      () =>
        (
          window as Window & {
            __conduitCartReconciliationPaused?: boolean
          }
        ).__conduitCartReconciliationPaused === true
    )

    await increase.click()
    await expect
      .poll(async () => {
        return await otherPage.evaluate(async () => {
          const cart =
            (await import("/src/hooks/useCart.ts")) as typeof import("../apps/market/src/hooks/useCart")
          const snapshot = await navigator.locks.query()
          return snapshot.pending?.some(
            (lock) => lock.name === cart.CART_MUTATION_LOCK_NAME
          )
        })
      })
      .toBe(true)

    await page.evaluate(() => {
      ;(
        window as Window & {
          __conduitReleaseCartReconciliation?: () => void
        }
      ).__conduitReleaseCartReconciliation?.()
    })
    await page.waitForFunction(
      () =>
        (
          window as Window & {
            __conduitCartReconciliationDone?: boolean
          }
        ).__conduitCartReconciliationDone === true
    )

    await expect
      .poll(async () => {
        return await otherPage.evaluate(
          ({ product, order }) => {
            const cart = JSON.parse(
              localStorage.getItem("conduit:cart") ?? "{}"
            ) as {
              items?: Array<{ productId: string; quantity: number }>
              appliedOrderRetirements?: string[]
            }
            return {
              quantity: cart.items?.find((item) => item.productId === product)
                ?.quantity,
              retirementApplied:
                cart.appliedOrderRetirements?.includes(order) === true,
            }
          },
          { product: productId, order: orderId }
        )
      })
      .toEqual({ quantity: 1, retirementApplied: true })
  } finally {
    await otherPage.close()
    await page.evaluate(async (cleanupOrderId) => {
      localStorage.removeItem("conduit:cart")
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "orderLifecycles",
            "readwrite"
          )
          transaction.objectStore("orderLifecycles").delete(cleanupOrderId)
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
    }, orderId)
  }
})

test("startup retries cart retirement after localStorage rejects the checkpoint write @market", async ({
  page,
}) => {
  await page.goto(marketUrl)
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some(
      (database) => database.name === "conduit"
    )
  )
  const orderId = `checkpoint-storage-failure-${Date.now()}`
  const buyerPubkey = "4".repeat(64)
  const merchantPubkey = "5".repeat(64)
  const otherMerchantPubkey = "6".repeat(64)
  const productId = `30402:${merchantPubkey}:storage-failure-product`

  await page.evaluate(
    ({ merchant, product }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 2,
          items: [
            {
              productId: product,
              merchantPubkey: merchant,
              title: "Storage failure product",
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
          ],
        })
      )
      const storagePrototype = Storage.prototype as Storage & {
        __conduitOriginalSetItem?: Storage["setItem"]
      }
      storagePrototype.__conduitOriginalSetItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === "conduit:cart") {
          throw new DOMException(
            "simulated cart write failure",
            "QuotaExceededError"
          )
        }
        return storagePrototype.__conduitOriginalSetItem!.call(this, key, value)
      }
    },
    { merchant: merchantPubkey, product: productId }
  )

  try {
    await page.evaluate(
      async ({ harnessUrl, order, buyer, merchant, product }) => {
        const harness = (await import(harnessUrl)) as {
          startInterruptedOrderCheckpoint: (input: {
            orderId: string
            buyerPubkey: string
            merchantPubkey: string
            productId: string
          }) => Promise<void>
        }
        await harness.startInterruptedOrderCheckpoint({
          orderId: order,
          buyerPubkey: buyer,
          merchantPubkey: merchant,
          productId: product,
        })
      },
      {
        harnessUrl: checkpointHarnessUrl,
        order: orderId,
        buyer: buyerPubkey,
        merchant: merchantPubkey,
        product: productId,
      }
    )

    expect(
      await page.evaluate(
        (product) =>
          (localStorage.getItem("conduit:cart") ?? "").includes(product),
        productId
      )
    ).toBe(true)
    await page.evaluate(() => {
      const storagePrototype = Storage.prototype as Storage & {
        __conduitOriginalSetItem?: Storage["setItem"]
      }
      Storage.prototype.setItem = storagePrototype.__conduitOriginalSetItem!
      delete storagePrototype.__conduitOriginalSetItem
    })
    await page.reload()
    await page.waitForFunction(
      (product) =>
        !(localStorage.getItem("conduit:cart") ?? "").includes(product),
      productId
    )
  } finally {
    await page.evaluate(async (cleanupOrderId) => {
      localStorage.removeItem("conduit:cart")
      const request = indexedDB.open("conduit")
      await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "orderLifecycles",
            "readwrite"
          )
          transaction.objectStore("orderLifecycles").delete(cleanupOrderId)
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
        }
      })
    }, orderId)
  }
})

test("checkout refuses an in-memory cart change that localStorage rejected @market", async ({
  page,
}) => {
  const merchantPubkey = "d".repeat(64)
  const productId = `30402:${merchantPubkey}:failed-cart-write`
  const title = "Failed cart write product"
  const lineGenerationId = "failed-cart-write-generation"

  await page.goto(marketUrl)
  await page.evaluate(
    ({ merchant, product, productTitle, generation }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 3,
          items: [
            {
              productId: product,
              merchantPubkey: merchant,
              lineGenerationId: generation,
              merchantAddedAt: Date.now(),
              title: productTitle,
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
          ],
          appliedOrderRetirements: [],
        })
      )
    },
    {
      merchant: merchantPubkey,
      product: productId,
      productTitle: title,
      generation: lineGenerationId,
    }
  )
  await page.goto(`${marketUrl}/cart`)
  const increase = page.getByRole("button", {
    name: `Increase quantity for ${title}`,
  })
  await expect(increase).toBeVisible()

  await page.evaluate(() => {
    const storagePrototype = Storage.prototype as Storage & {
      __conduitOriginalSetItem?: Storage["setItem"]
    }
    storagePrototype.__conduitOriginalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "conduit:cart") {
        throw new DOMException(
          "simulated cart write failure",
          "QuotaExceededError"
        )
      }
      return storagePrototype.__conduitOriginalSetItem!.call(this, key, value)
    }
  })

  try {
    await increase.click()
    await expect(increase.locator("..")).toContainText("2")

    const result = await page.evaluate(
      async ({ merchant, product, productTitle, generation }) => {
        const cart = (await import("/src/hooks/useCart.ts")) as {
          assertDurableCheckoutCartItems: (
            reviewedItems: Array<{
              productId: string
              merchantPubkey: string
              lineGenerationId: string
              title: string
              price: number
              currency: string
              format: "digital"
              quantity: number
            }>
          ) => Promise<void>
        }
        try {
          await cart.assertDurableCheckoutCartItems([
            {
              productId: product,
              merchantPubkey: merchant,
              lineGenerationId: generation,
              title: productTitle,
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 2,
            },
          ])
          return null
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      {
        merchant: merchantPubkey,
        product: productId,
        productTitle: title,
        generation: lineGenerationId,
      }
    )
    expect(result).toContain("cart could not be saved")
    expect(
      await page.evaluate(() => {
        const cart = JSON.parse(localStorage.getItem("conduit:cart") ?? "{}")
        return cart.items?.[0]?.quantity
      })
    ).toBe(1)
    expect(
      await page.evaluate(async () => {
        return await new Promise<number>((resolve, reject) => {
          const request = indexedDB.open("conduit")
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction(
              "orderLifecycles",
              "readonly"
            )
            const count = transaction.objectStore("orderLifecycles").count()
            count.onsuccess = () => resolve(count.result)
            count.onerror = () => reject(count.error)
            transaction.oncomplete = () => database.close()
          }
        })
      })
    ).toBe(0)
  } finally {
    await page.evaluate(() => {
      const storagePrototype = Storage.prototype as Storage & {
        __conduitOriginalSetItem?: Storage["setItem"]
      }
      if (storagePrototype.__conduitOriginalSetItem) {
        Storage.prototype.setItem = storagePrototype.__conduitOriginalSetItem
        delete storagePrototype.__conduitOriginalSetItem
      }
      localStorage.removeItem("conduit:cart")
    })
  }
})

test("a later cart mutation replays an earlier write-failed intent @market", async ({
  page,
}) => {
  const merchantPubkey = "c".repeat(64)
  const removedProductId = `30402:${merchantPubkey}:write-failed-remove`
  const retainedProductId = `30402:${merchantPubkey}:write-recovery-update`
  const removedTitle = "Write-failed removal product"
  const retainedTitle = "Write recovery quantity product"
  const removedGeneration = "write-failed-remove-generation"
  const retainedGeneration = "write-recovery-update-generation"

  await page.goto(marketUrl)
  await page.evaluate(
    ({
      merchant,
      removedProduct,
      retainedProduct,
      firstTitle,
      secondTitle,
      firstGeneration,
      secondGeneration,
    }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 3,
          items: [
            {
              productId: removedProduct,
              merchantPubkey: merchant,
              lineGenerationId: firstGeneration,
              merchantAddedAt: 1,
              title: firstTitle,
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
            {
              productId: retainedProduct,
              merchantPubkey: merchant,
              lineGenerationId: secondGeneration,
              merchantAddedAt: 1,
              title: secondTitle,
              price: 2,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
          ],
          appliedOrderRetirements: [],
        })
      )
    },
    {
      merchant: merchantPubkey,
      removedProduct: removedProductId,
      retainedProduct: retainedProductId,
      firstTitle: removedTitle,
      secondTitle: retainedTitle,
      firstGeneration: removedGeneration,
      secondGeneration: retainedGeneration,
    }
  )
  await page.goto(`${marketUrl}/cart`)

  const remove = page.getByRole("button", {
    name: `Remove ${removedTitle} from cart`,
  })
  const increase = page.getByRole("button", {
    name: `Increase quantity for ${retainedTitle}`,
  })
  await expect(remove).toBeVisible()
  await expect(increase).toBeVisible()

  await page.evaluate(() => {
    const storagePrototype = Storage.prototype as Storage & {
      __conduitOriginalSetItem?: Storage["setItem"]
      __conduitCartWriteFailuresRemaining?: number
    }
    storagePrototype.__conduitOriginalSetItem = Storage.prototype.setItem
    storagePrototype.__conduitCartWriteFailuresRemaining = 1
    Storage.prototype.setItem = function (key: string, value: string) {
      if (
        key === "conduit:cart" &&
        (storagePrototype.__conduitCartWriteFailuresRemaining ?? 0) > 0
      ) {
        storagePrototype.__conduitCartWriteFailuresRemaining!--
        throw new DOMException(
          "simulated one-shot cart write failure",
          "QuotaExceededError"
        )
      }
      return storagePrototype.__conduitOriginalSetItem!.call(this, key, value)
    }
  })

  try {
    await remove.click()
    await expect(remove).not.toBeVisible()
    await page.waitForFunction(
      () =>
        (
          Storage.prototype as Storage & {
            __conduitCartWriteFailuresRemaining?: number
          }
        ).__conduitCartWriteFailuresRemaining === 0
    )

    await increase.click()
    await expect(increase.locator("..")).toContainText("2")

    await expect
      .poll(async () => {
        return await page.evaluate(
          ({ removedProduct, retainedProduct }) => {
            const durable = JSON.parse(
              localStorage.getItem("conduit:cart") ?? "{}"
            ) as {
              items?: Array<{ productId: string; quantity: number }>
            }
            return {
              removedPresent:
                durable.items?.some(
                  (item) => item.productId === removedProduct
                ) ?? false,
              retainedQuantity: durable.items?.find(
                (item) => item.productId === retainedProduct
              )?.quantity,
            }
          },
          {
            removedProduct: removedProductId,
            retainedProduct: retainedProductId,
          }
        )
      })
      .toEqual({ removedPresent: false, retainedQuantity: 2 })

    const checkoutError = await page.evaluate(
      async ({ merchant, product, title, generation }) => {
        const cart = (await import("/src/hooks/useCart.ts")) as {
          assertDurableCheckoutCartItems: (
            reviewedItems: Array<{
              productId: string
              merchantPubkey: string
              lineGenerationId: string
              merchantAddedAt: number
              title: string
              price: number
              currency: string
              format: "digital"
              quantity: number
            }>
          ) => Promise<void>
        }
        try {
          await cart.assertDurableCheckoutCartItems([
            {
              productId: product,
              merchantPubkey: merchant,
              lineGenerationId: generation,
              merchantAddedAt: 1,
              title,
              price: 2,
              currency: "SATS",
              format: "digital",
              quantity: 2,
            },
          ])
          return null
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      {
        merchant: merchantPubkey,
        product: retainedProductId,
        title: retainedTitle,
        generation: retainedGeneration,
      }
    )
    expect(checkoutError).toBeNull()
  } finally {
    await page.evaluate(() => {
      const storagePrototype = Storage.prototype as Storage & {
        __conduitOriginalSetItem?: Storage["setItem"]
        __conduitCartWriteFailuresRemaining?: number
      }
      if (storagePrototype.__conduitOriginalSetItem) {
        Storage.prototype.setItem = storagePrototype.__conduitOriginalSetItem
        delete storagePrototype.__conduitOriginalSetItem
      }
      delete storagePrototype.__conduitCartWriteFailuresRemaining
      localStorage.removeItem("conduit:cart")
    })
  }
})

test("checkout rejects a reviewed cart after another tab changes it @market", async ({
  context,
  page,
}) => {
  const merchantPubkey = "e".repeat(64)
  const productId = `30402:${merchantPubkey}:cross-tab-cart`
  const lineGenerationId = "cross-tab-cart-generation"
  const reviewedItem = {
    productId,
    merchantPubkey,
    lineGenerationId,
    merchantAddedAt: Date.now(),
    title: "Cross-tab cart product",
    price: 1,
    currency: "SATS",
    format: "digital" as const,
    quantity: 1,
  }

  await page.goto(marketUrl)
  await page.evaluate((item) => {
    localStorage.setItem(
      "conduit:cart",
      JSON.stringify({
        version: 3,
        items: [item],
        appliedOrderRetirements: [],
      })
    )
  }, reviewedItem)
  await page.goto(`${marketUrl}/cart`)
  await expect(
    page.getByRole("button", {
      name: `Increase quantity for ${reviewedItem.title}`,
    })
  ).toBeVisible()

  const otherPage = await context.newPage()
  try {
    await otherPage.goto(marketUrl)
    await otherPage.evaluate((product) => {
      const cart = JSON.parse(localStorage.getItem("conduit:cart") ?? "{}")
      const item = cart.items.find(
        (candidate: { productId?: string }) => candidate.productId === product
      )
      item.quantity = 2
      localStorage.setItem("conduit:cart", JSON.stringify(cart))
    }, productId)

    const result = await page.evaluate(async (item) => {
      const cart = (await import("/src/hooks/useCart.ts")) as {
        assertDurableCheckoutCartItems: (
          reviewedItems: (typeof item)[]
        ) => Promise<void>
      }
      try {
        await cart.assertDurableCheckoutCartItems([item])
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, reviewedItem)
    expect(result).toContain("cart changed in another tab")
  } finally {
    await otherPage.close()
    await page.evaluate(() => localStorage.removeItem("conduit:cart"))
  }
})

test("manual retry starts with a live signal after the StrictMode effect probe @market", async ({
  page,
}) => {
  await page.goto(marketUrl)
  const result = await page.evaluate(async (harnessUrl) => {
    const harness = (await import(harnessUrl)) as {
      probeStrictModeOrderDeliveryRetry: () => Promise<{
        effectSetups: number
        signalAborted: boolean
      }>
    }
    return await harness.probeStrictModeOrderDeliveryRetry()
  }, strictModeRetryHarnessUrl)

  expect(result.effectSetups).toBeGreaterThanOrEqual(2)
  expect(result.signalAborted).toBe(false)
})

test("a queued guest retains its same-tab draft until relay acceptance @market", async ({
  page,
}) => {
  await page.goto(marketUrl)
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some(
      (database) => database.name === "conduit"
    )
  )
  const orderId = `guest-checkpoint-order-${Date.now()}`
  const buyerPubkey = "8".repeat(64)
  const merchantPubkey = "7".repeat(64)
  const productId = "30402:" + merchantPubkey + ":guest-checkpoint-product"
  const shippingDraft = {
    firstName: "Guest",
    lastName: "Shopper",
    street: "Recovery street",
    line2: "",
    city: "Recovery city",
    state: "CA",
    postalCode: "90001",
    country: "US",
    name: "Guest Shopper",
    phone: "",
    email: "guest@example.invalid",
  }

  await page.evaluate(
    ({ merchant, product }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 2,
          items: [
            {
              productId: product,
              merchantPubkey: merchant,
              title: "Guest checkpoint product",
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
          ],
        })
      )
    },
    { merchant: merchantPubkey, product: productId }
  )

  try {
    await page.evaluate(
      async ({ harnessUrl, order, buyer, merchant, product, draft }) => {
        const harness = (await import(harnessUrl)) as {
          startInterruptedOrderCheckpoint: (input: {
            orderId: string
            buyerPubkey: string
            merchantPubkey: string
            productId: string
            buyerIdentityKind: "guest_ephemeral"
            shippingDraft: typeof draft
          }) => Promise<void>
        }
        await harness.startInterruptedOrderCheckpoint({
          orderId: order,
          buyerPubkey: buyer,
          merchantPubkey: merchant,
          productId: product,
          buyerIdentityKind: "guest_ephemeral",
          shippingDraft: draft,
        })
      },
      {
        harnessUrl: checkpointHarnessUrl,
        order: orderId,
        buyer: buyerPubkey,
        merchant: merchantPubkey,
        product: productId,
        draft: shippingDraft,
      }
    )

    const readDraft = () =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("conduit:checkout-shipping")
        if (!raw) return null
        return (JSON.parse(raw) as { value?: unknown }).value ?? null
      })

    expect(await readDraft()).toEqual(shippingDraft)
    await page.reload()
    expect(await readDraft()).toEqual(shippingDraft)

    const retryResult = await page.evaluate(
      async ({ order, buyer }) => {
        const deliveryRetry =
          (await import("/src/lib/order-delivery-retry.ts")) as typeof import("../apps/market/src/lib/order-delivery-retry")
        const lifecycle = await deliveryRetry.retryOrderDeliveryFromOrders(
          order,
          buyer,
          {
            allowGuestExplicitRetry: true,
            leaseOwner: "browser-orders-retry",
            publisher: async ({ relayUrl, signedEvent }) => {
              if (
                relayUrl !== "wss://checkpoint.conduit.market" ||
                signedEvent.content !== "encrypted-checkpoint-wrap"
              ) {
                throw new Error("Retry did not preserve the staged delivery")
              }
              return "acked"
            },
          }
        )
        return lifecycle
          ? {
              orderDeliveryStatus: lifecycle.orderDeliveryStatus,
              phase: lifecycle.phase,
            }
          : null
      },
      { order: orderId, buyer: buyerPubkey }
    )
    expect(retryResult).toEqual({
      orderDeliveryStatus: "sent",
      phase: "in_progress",
    })
    expect(await readDraft()).toBeNull()
  } finally {
    await page.evaluate(async (cleanupOrderId) => {
      localStorage.removeItem("conduit:cart")
      sessionStorage.removeItem("conduit:checkout-shipping")
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "orderLifecycles",
            "readwrite"
          )
          transaction.objectStore("orderLifecycles").delete(cleanupOrderId)
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
    }, orderId)
  }
})

test("a first-attempt ACK clears its matching guest draft before an interrupted route settles @market", async ({
  page,
}) => {
  await page.goto(marketUrl)
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some(
      (database) => database.name === "conduit"
    )
  )
  const orderId = `guest-first-ack-order-${Date.now()}`
  const buyerPubkey = "6".repeat(64)
  const merchantPubkey = "5".repeat(64)
  const otherMerchantPubkey = "4".repeat(64)
  const productId = "30402:" + merchantPubkey + ":guest-first-ack-product"
  const shippingDraft = {
    firstName: "Guest",
    lastName: "Acknowledged",
    street: "Committed street",
    line2: "",
    city: "Committed city",
    state: "CA",
    postalCode: "90001",
    country: "US",
    name: "Guest Acknowledged",
    phone: "",
    email: "guest@example.invalid",
  }

  await page.evaluate(
    ({ merchant, product }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 2,
          items: [
            {
              productId: product,
              merchantPubkey: merchant,
              title: "Guest first ACK product",
              price: 1,
              currency: "SATS",
              format: "digital",
              quantity: 1,
            },
          ],
        })
      )
    },
    { merchant: merchantPubkey, product: productId }
  )

  try {
    await page.evaluate(
      async ({ harnessUrl, order, buyer, merchant, product, draft }) => {
        const harness = (await import(harnessUrl)) as {
          startInterruptedOrderCheckpoint: (input: {
            orderId: string
            buyerPubkey: string
            merchantPubkey: string
            productId: string
            buyerIdentityKind: "guest_ephemeral"
            shippingDraft: typeof draft
            firstAttemptAck: true
          }) => Promise<void>
        }
        await harness.startInterruptedOrderCheckpoint({
          orderId: order,
          buyerPubkey: buyer,
          merchantPubkey: merchant,
          productId: product,
          buyerIdentityKind: "guest_ephemeral",
          shippingDraft: draft,
          firstAttemptAck: true,
        })
      },
      {
        harnessUrl: checkpointHarnessUrl,
        order: orderId,
        buyer: buyerPubkey,
        merchant: merchantPubkey,
        product: productId,
        draft: shippingDraft,
      }
    )

    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("conduit:checkout-shipping")
      )
    ).toBeNull()
    await page.reload()
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("conduit:checkout-shipping")
      )
    ).toBeNull()
    const afterInterruption = await readCheckpointBrowserState(page, {
      merchantPubkey,
      otherMerchantPubkey,
    })
    expect(afterInterruption.orders).toEqual([
      { orderId, orderDeliveryStatus: "sent", phase: "in_progress" },
    ])
    expect(afterInterruption.merchantProductIds).toEqual([])
  } finally {
    await page.evaluate(async (cleanupOrderId) => {
      localStorage.removeItem("conduit:cart")
      sessionStorage.removeItem("conduit:checkout-shipping")
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "orderLifecycles",
            "readwrite"
          )
          transaction.objectStore("orderLifecycles").delete(cleanupOrderId)
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
    }, orderId)
  }
})

test("a staged encrypted order and partial ACK state survive browser restart @market", async ({
  page,
}) => {
  await page.goto(marketUrl)
  const databaseName = "conduit"
  await page.waitForFunction(async (name) => {
    const databases = await indexedDB.databases()
    return databases.some((database) => database.name === name)
  }, databaseName)
  const orderId = `e2e-order-${Date.now()}`
  const encryptedContent = "encrypted-gift-wrap-only"
  const staged = {
    orderId,
    buyerPubkey: "a".repeat(64),
    buyerIdentityKind: "signed_in",
    merchantPubkey: "b".repeat(64),
    checkoutMode: "pay_later",
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "pending",
    orderDeliveryRoute: "declared_inbox",
    orderRelayDelivery: {
      signedRecipientWrap: {
        id: "c".repeat(64),
        pubkey: "d".repeat(64),
        created_at: 1_700_000_000,
        kind: 1059,
        tags: [["p", "b".repeat(64)]],
        content: encryptedContent,
        sig: "e".repeat(128),
      },
      route: "declared_inbox",
      relayDelivery: [
        {
          relayUrl: "wss://one.conduit.market",
          source: "declared",
          status: "pending",
          attemptCount: 0,
        },
        {
          relayUrl: "wss://two.conduit.market",
          source: "declared",
          status: "pending",
          attemptCount: 0,
        },
      ],
      deliveryAttemptCount: 0,
      retryCount: 0,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 86_400_000,
    },
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  const writeRecord = async (record: unknown) => {
    await page.evaluate(
      async ({ databaseName, value }) => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(databaseName)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result
            if (!database.objectStoreNames.contains("orderLifecycles")) {
              database.close()
              reject(new Error("Market lifecycle store is unavailable"))
              return
            }
            const transaction = database.transaction(
              "orderLifecycles",
              "readwrite"
            )
            transaction.objectStore("orderLifecycles").put(value)
            transaction.oncomplete = () => {
              database.close()
              resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
          }
        })
      },
      { databaseName, value: record }
    )
  }

  const readRecord = async (): Promise<StoredOrderDelivery | undefined> =>
    await page.evaluate(
      async ({ databaseName, key }) => {
        return await new Promise<StoredOrderDelivery | undefined>(
          (resolve, reject) => {
            const request = indexedDB.open(databaseName)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
              const database = request.result
              const transaction = database.transaction(
                "orderLifecycles",
                "readonly"
              )
              const get = transaction.objectStore("orderLifecycles").get(key)
              get.onsuccess = () =>
                resolve(get.result as StoredOrderDelivery | undefined)
              get.onerror = () => reject(get.error)
              transaction.oncomplete = () => database.close()
            }
          }
        )
      },
      { databaseName, key: orderId }
    )

  try {
    await writeRecord(staged)
    await page.reload()

    const afterStageRestart = await readRecord()
    expect(afterStageRestart?.orderDeliveryStatus).toBe("pending")
    expect(afterStageRestart?.phase).toBe("pending")
    const stagedCiphertextPreserved =
      afterStageRestart?.orderRelayDelivery.signedRecipientWrap.content ===
      encryptedContent
    const stagedPlanPreserved =
      afterStageRestart?.orderRelayDelivery.relayDelivery.length === 2 &&
      afterStageRestart.orderRelayDelivery.relayDelivery[0]?.relayUrl ===
        "wss://one.conduit.market" &&
      afterStageRestart.orderRelayDelivery.relayDelivery[1]?.relayUrl ===
        "wss://two.conduit.market"
    expect(stagedCiphertextPreserved).toBe(true)
    expect(stagedPlanPreserved).toBe(true)

    const partial = structuredClone(staged)
    partial.orderDeliveryStatus = "sent"
    partial.phase = "in_progress"
    partial.orderRelayDelivery.deliveryAttemptCount = 1
    partial.orderRelayDelivery.relayDelivery[0] = {
      ...partial.orderRelayDelivery.relayDelivery[0],
      status: "acked",
      attemptCount: 1,
    }
    partial.orderRelayDelivery.relayDelivery[1] = {
      ...partial.orderRelayDelivery.relayDelivery[1],
      status: "timed_out",
      attemptCount: 1,
    }
    await writeRecord(partial)
    await page.reload()

    const afterPartialRestart = await readRecord()
    const signedWrapPreserved =
      afterPartialRestart?.orderRelayDelivery.signedRecipientWrap.id ===
      staged.orderRelayDelivery.signedRecipientWrap.id
    const partialAckPreserved =
      afterPartialRestart?.orderRelayDelivery.relayDelivery.length === 2 &&
      afterPartialRestart.orderRelayDelivery.relayDelivery[0]?.status ===
        "acked" &&
      afterPartialRestart.orderRelayDelivery.relayDelivery[1]?.status ===
        "timed_out"
    expect(signedWrapPreserved).toBe(true)
    expect(partialAckPreserved).toBe(true)
    expect(afterPartialRestart?.phase).toBe("in_progress")
  } finally {
    await page.evaluate(
      async ({ name, key }) => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(name)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction(
              "orderLifecycles",
              "readwrite"
            )
            transaction.objectStore("orderLifecycles").delete(key)
            transaction.oncomplete = () => {
              database.close()
              resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
          }
        })
      },
      { name: databaseName, key: orderId }
    )
  }
})

import { expect, test, type Page } from "@playwright/test"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"

const merchantUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
}`
const MERCHANT_SECRET = new Uint8Array(32).fill(41)
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const PRODUCT_EVENT_ID = "9".repeat(64)
const PRODUCT_D_TAG = "durable-delete-browser"
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}`

type UnsignedBrowserEvent = {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

async function installValidTestSigner(
  page: Page,
  onSign?: () => void
): Promise<void> {
  await page.exposeFunction(
    "__conduitSignDeletionTestEvent",
    (event: UnsignedBrowserEvent) => {
      onSign?.()
      return finalizeEvent(event, MERCHANT_SECRET)
    }
  )
  await page.addInitScript((merchantPubkey) => {
    localStorage.setItem("conduit:auth", merchantPubkey)
    const signer = window as typeof window & {
      __conduitSignDeletionTestEvent: (
        event: UnsignedBrowserEvent
      ) => Promise<Record<string, unknown>>
      nostr?: unknown
    }
    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        async getPublicKey() {
          return merchantPubkey
        },
        async getRelays() {
          return {
            "wss://write-browser.example": { read: true, write: true },
          }
        },
        async signEvent(event: UnsignedBrowserEvent) {
          return await signer.__conduitSignDeletionTestEvent({
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content,
          })
        },
      },
    })
  }, MERCHANT_PUBKEY)
}

type ObservedRelayPublish = {
  relayUrl: string
  event: Record<string, unknown>
}

function normalizeRelayUrl(relayUrl: string): string {
  return relayUrl.endsWith("/") ? relayUrl.slice(0, -1) : relayUrl
}

async function installRelayMock(
  page: Page,
  publishes: ObservedRelayPublish[],
  accept: (relayUrl: string, event: Record<string, unknown>) => boolean
): Promise<void> {
  await page.routeWebSocket(/^wss:\/\//, (socket) => {
    const relayUrl = normalizeRelayUrl(socket.url())
    socket.onMessage((message) => {
      if (typeof message !== "string") return
      let frame: unknown
      try {
        frame = JSON.parse(message)
      } catch {
        return
      }
      if (!Array.isArray(frame)) return

      if (frame[0] === "REQ" && typeof frame[1] === "string") {
        socket.send(JSON.stringify(["EOSE", frame[1]]))
        return
      }
      if (
        frame[0] !== "EVENT" ||
        typeof frame[1] !== "object" ||
        frame[1] === null
      ) {
        return
      }

      const event = structuredClone(frame[1] as Record<string, unknown>)
      publishes.push({ relayUrl, event })
      const accepted = accept(relayUrl, event)
      socket.send(
        JSON.stringify([
          "OK",
          event.id,
          accepted,
          accepted ? "" : "blocked: simulated partial delivery",
        ])
      )
    })
  })
}

async function seedCachedProduct(page: Page): Promise<void> {
  await page.evaluate(
    ({ merchantPubkey, eventId, dTag, addressId }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction("products", "readwrite")
          const timestamp = Date.now()
          transaction.objectStore("products").put({
            id: addressId,
            pubkey: merchantPubkey,
            title: "Durable delete browser fixture",
            summary: "Public browser regression fixture",
            price: 1,
            currency: "SATS",
            priceSats: 1,
            type: "simple",
            format: "digital",
            visibility: "public",
            stock: 1,
            images: [{ url: "https://example.com/delete-fixture.png" }],
            tags: ["deletion", "browser", "regression"],
            publicZapEnabled: true,
            zapMessagePolicy: "generic_only",
            publicZapPolicyKnown: true,
            eventId,
            eventCreatedAt: 100,
            dTag,
            sourceRelayUrls: ["wss://source-browser.example"],
            createdAt: timestamp,
            updatedAt: timestamp,
            cachedAt: timestamp,
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      merchantPubkey: MERCHANT_PUBKEY,
      eventId: PRODUCT_EVENT_ID,
      dTag: PRODUCT_D_TAG,
      addressId: PRODUCT_ADDRESS,
    }
  )
}

async function readDeletionState(page: Page): Promise<{
  jobs: Array<{
    id: string
    signedEvent: {
      id: string
      kind: number
      pubkey: string
      tags: string[][]
      sig: string
    }
    relayPlan: Array<{ relayUrl: string; roles: string[] }>
    relayDelivery: Array<{
      relayUrl: string
      status: string
      attemptCount: number
    }>
    state: string
    deliveryAttemptCount: number
    nextRetryAt?: number
  }>
  tombstoneCount: number
}> {
  return await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            ["productDeletionOutbox", "productTombstones"],
            "readonly"
          )
          const jobsRequest = transaction
            .objectStore("productDeletionOutbox")
            .getAll()
          const tombstonesRequest = transaction
            .objectStore("productTombstones")
            .count()
          transaction.oncomplete = () =>
            resolve({
              jobs: jobsRequest.result,
              tombstoneCount: tombstonesRequest.result,
            })
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
  )
}

async function makeDeletionImmediatelyRetryableAndRemoveLocalEvidence(
  page: Page
): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            ["productDeletionOutbox", "productTombstones"],
            "readwrite"
          )
          const outbox = transaction.objectStore("productDeletionOutbox")
          const jobsRequest = outbox.getAll()
          jobsRequest.onsuccess = () => {
            for (const job of jobsRequest.result) {
              outbox.put({ ...job, nextRetryAt: 0 })
            }
          }
          transaction.objectStore("productTombstones").clear()
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })
  )
}

async function seedVersionEightDatabase(page: Page): Promise<{
  product: Record<string, unknown>
  tombstone: Record<string, unknown>
}> {
  return await page.evaluate(
    ({ merchantPubkey, eventId, dTag, addressId }) =>
      new Promise((resolve, reject) => {
        const product = {
          id: addressId,
          pubkey: merchantPubkey,
          title: "Preserved v8 product",
          summary: "Schema migration fixture",
          price: 1,
          currency: "SATS",
          priceSats: 1,
          type: "simple",
          format: "digital",
          visibility: "public",
          stock: 1,
          images: [{ url: "https://example.com/v8-product.png" }],
          tags: ["migration"],
          eventId,
          eventCreatedAt: 100,
          dTag,
          createdAt: 100_000,
          updatedAt: 100_000,
          cachedAt: 100_000,
        }
        const tombstone = {
          id: `e:${merchantPubkey}:${eventId}`,
          pubkey: merchantPubkey,
          eventId,
          deletedAt: 110,
          deletionEventId: "7".repeat(64),
          cachedAt: 110_000,
        }
        const request = indexedDB.open("conduit", 80)
        request.onerror = () => reject(request.error)
        request.onupgradeneeded = () => {
          const database = request.result
          const stores: Array<{
            name: string
            keyPath: string
            indexes: Array<[string, boolean?]>
          }> = [
            {
              name: "orders",
              keyPath: "id",
              indexes: [
                ["buyerPubkey"],
                ["merchantPubkey"],
                ["status"],
                ["createdAt"],
              ],
            },
            {
              name: "messages",
              keyPath: "id",
              indexes: [
                ["senderPubkey"],
                ["recipientPubkey"],
                ["kind"],
                ["createdAt"],
                ["read"],
              ],
            },
            {
              name: "products",
              keyPath: "id",
              indexes: [["pubkey"], ["tags", true], ["cachedAt"]],
            },
            {
              name: "productTombstones",
              keyPath: "id",
              indexes: [
                ["pubkey"],
                ["addressId"],
                ["eventId"],
                ["deletedAt"],
                ["cachedAt"],
              ],
            },
            {
              name: "profiles",
              keyPath: "pubkey",
              indexes: [["cachedAt"]],
            },
            {
              name: "orderMessages",
              keyPath: "id",
              indexes: [
                ["orderId"],
                ["type"],
                ["senderPubkey"],
                ["recipientPubkey"],
                ["createdAt"],
              ],
            },
            {
              name: "relayLists",
              keyPath: "pubkey",
              indexes: [["cachedAt"]],
            },
            {
              name: "productSocialSummaries",
              keyPath: "key",
              indexes: [["cachedAt"]],
            },
            {
              name: "nip05Verifications",
              keyPath: "id",
              indexes: [
                ["pubkey"],
                ["normalizedIdentifier"],
                ["status"],
                ["expiresAt"],
                ["cachedAt"],
              ],
            },
            {
              name: "paymentAttempts",
              keyPath: "id",
              indexes: [
                ["orderId"],
                ["buyerPubkey"],
                ["merchantPubkey"],
                ["proofDeliveryStatus"],
                ["createdAt"],
              ],
            },
            {
              name: "orderLifecycles",
              keyPath: "orderId",
              indexes: [
                ["buyerPubkey"],
                ["merchantPubkey"],
                ["phase"],
                ["updatedAt"],
                ["createdAt"],
              ],
            },
          ]
          for (const definition of stores) {
            const store = database.createObjectStore(definition.name, {
              keyPath: definition.keyPath,
            })
            for (const [indexName, multiEntry = false] of definition.indexes) {
              store.createIndex(indexName, indexName, { multiEntry })
            }
          }
        }
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            ["products", "productTombstones"],
            "readwrite"
          )
          transaction.objectStore("products").put(product)
          transaction.objectStore("productTombstones").put(tombstone)
          transaction.oncomplete = () => {
            database.close()
            resolve({ product, tombstone })
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      merchantPubkey: MERCHANT_PUBKEY,
      eventId: PRODUCT_EVENT_ID,
      dTag: PRODUCT_D_TAG,
      addressId: PRODUCT_ADDRESS,
    }
  )
}

async function readDatabaseMigrationState(page: Page): Promise<{
  nativeVersion: number
  stores: string[]
  outboxIndexes: string[]
  productIndexes: string[]
  tombstoneIndexes: string[]
  product: Record<string, unknown> | undefined
  tombstone: Record<string, unknown> | undefined
  outboxCount: number
}> {
  return await page.evaluate(
    ({ addressId, merchantPubkey, eventId }) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const stores = Array.from(database.objectStoreNames)
          if (!stores.includes("productDeletionOutbox")) {
            database.close()
            resolve({
              nativeVersion: database.version,
              stores,
              outboxIndexes: [],
              productIndexes: [],
              tombstoneIndexes: [],
              product: undefined,
              tombstone: undefined,
              outboxCount: -1,
            })
            return
          }
          const transaction = database.transaction(
            ["products", "productTombstones", "productDeletionOutbox"],
            "readonly"
          )
          const products = transaction.objectStore("products")
          const tombstones = transaction.objectStore("productTombstones")
          const outbox = transaction.objectStore("productDeletionOutbox")
          const productRequest = products.get(addressId)
          const tombstoneRequest = tombstones.get(
            `e:${merchantPubkey}:${eventId}`
          )
          const outboxCountRequest = outbox.count()
          transaction.oncomplete = () => {
            const state = {
              nativeVersion: database.version,
              stores,
              outboxIndexes: Array.from(outbox.indexNames).sort(),
              productIndexes: Array.from(products.indexNames).sort(),
              tombstoneIndexes: Array.from(tombstones.indexNames).sort(),
              product: productRequest.result,
              tombstone: tombstoneRequest.result,
              outboxCount: outboxCountRequest.result,
            }
            database.close()
            resolve(state)
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      addressId: PRODUCT_ADDRESS,
      merchantPubkey: MERCHANT_PUBKEY,
      eventId: PRODUCT_EVENT_ID,
    }
  )
}

test("Merchant upgrades v8 cache data to the durable v11 cache stores", async ({
  page,
}) => {
  await page.route(
    `${merchantUrl}/__product-deletion-v8-fixture`,
    async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Product deletion v8 fixture</title>",
      })
    }
  )
  await page.goto(`${merchantUrl}/__product-deletion-v8-fixture`)
  const fixture = await seedVersionEightDatabase(page)

  await page.goto(`${merchantUrl}/`)
  await expect
    .poll(
      async () => {
        const state = await readDatabaseMigrationState(page)
        return {
          nativeVersion: state.nativeVersion,
          hasOutbox: state.stores.includes("productDeletionOutbox"),
          hasShopperTrust: state.stores.includes("shopperTrustSnapshots"),
        }
      },
      { timeout: 20_000 }
    )
    .toEqual({
      nativeVersion: 110,
      hasOutbox: true,
      hasShopperTrust: true,
    })

  const migrated = await readDatabaseMigrationState(page)
  expect(migrated.product).toEqual(fixture.product)
  expect(migrated.tombstone).toEqual(fixture.tombstone)
  expect(migrated.outboxCount).toBe(0)
  expect(migrated.outboxIndexes).toEqual([
    "createdAt",
    "deliveryLeaseExpiresAt",
    "nextRetryAt",
    "state",
    "updatedAt",
  ])
  expect(migrated.productIndexes).toEqual(["cachedAt", "pubkey", "tags"])
  expect(migrated.tombstoneIndexes).toEqual([
    "addressId",
    "cachedAt",
    "deletedAt",
    "eventId",
    "pubkey",
  ])
})

test("Merchant persists one exact deletion and restores it after reload", async ({
  page,
}) => {
  const publishes: ObservedRelayPublish[] = []
  await installRelayMock(page, publishes, () => true)
  await installValidTestSigner(page)
  await page.goto(`${merchantUrl}/products`)
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()

  await seedCachedProduct(page)
  await page.reload()
  await expect(
    page.getByText("Durable delete browser fixture", { exact: true })
  ).toBeVisible()

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Delete", exact: true }).click()

  await expect
    .poll(async () => (await readDeletionState(page)).jobs.length, {
      timeout: 20_000,
    })
    .toBe(1)
  await expect(
    page.getByText("Durable delete browser fixture", { exact: true })
  ).toHaveCount(0)

  const beforeReload = await readDeletionState(page)
  const [job] = beforeReload.jobs
  expect(job?.signedEvent.kind).toBe(5)
  expect(job?.signedEvent.pubkey).toBe(MERCHANT_PUBKEY)
  expect(job?.signedEvent.tags).toContainEqual(["e", PRODUCT_EVENT_ID])
  expect(job?.signedEvent.tags).toContainEqual(["a", PRODUCT_ADDRESS])
  expect(job?.signedEvent.sig).toMatch(/^[0-9a-f]{128}$/)
  expect(beforeReload.tombstoneCount).toBeGreaterThan(0)
  expect(job?.relayPlan).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relayUrl: "wss://relay.conduit.market",
        roles: expect.arrayContaining(["conduit"]),
      }),
      expect.objectContaining({
        relayUrl: "wss://source-browser.example",
        roles: expect.arrayContaining(["source"]),
      }),
      expect.objectContaining({
        relayUrl: "wss://write-browser.example",
        roles: expect.arrayContaining(["author_write"]),
      }),
    ])
  )

  const exactSignedEvent = structuredClone(job?.signedEvent)
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Durable delete browser fixture", { exact: true })
  ).toHaveCount(0)

  const afterReload = await readDeletionState(page)
  expect(afterReload.jobs[0]?.signedEvent).toEqual(exactSignedEvent)
  expect(afterReload.tombstoneCount).toBeGreaterThan(0)
})

test("Merchant resumes a partial deletion after browser restart without signing again", async ({
  browser,
}) => {
  let signerCalls = 0
  const firstPublishes: ObservedRelayPublish[] = []
  const firstContext = await browser.newContext()
  const firstPage = await firstContext.newPage()

  try {
    await installRelayMock(
      firstPage,
      firstPublishes,
      (relayUrl) => relayUrl !== "wss://write-browser.example"
    )
    await installValidTestSigner(firstPage, () => {
      signerCalls += 1
    })
    await firstPage.goto(`${merchantUrl}/products`)
    await expect(
      firstPage.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible()

    await seedCachedProduct(firstPage)
    await firstPage.reload()
    await expect(
      firstPage.getByText("Durable delete browser fixture", { exact: true })
    ).toBeVisible()

    firstPage.once("dialog", (dialog) => dialog.accept())
    await firstPage.getByRole("button", { name: "Delete", exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readDeletionState(firstPage)).jobs[0]?.relayDelivery.find(
            ({ relayUrl }) => relayUrl === "wss://write-browser.example"
          )?.status,
        { timeout: 20_000 }
      )
      .toBe("rejected")

    const beforeRestart = await readDeletionState(firstPage)
    const [partialJob] = beforeRestart.jobs
    expect(signerCalls).toBe(1)
    expect(
      partialJob?.relayDelivery.find(
        ({ relayUrl }) => relayUrl === "wss://write-browser.example"
      )
    ).toEqual(
      expect.objectContaining({
        status: "rejected",
        attemptCount: 1,
      })
    )
    expect(
      partialJob?.relayDelivery
        .filter(({ relayUrl }) => relayUrl !== "wss://write-browser.example")
        .every(({ status }) => status === "acked")
    ).toBe(true)

    const exactSignedEvent = structuredClone(partialJob?.signedEvent)
    const ackedBeforeRestart = new Set(
      partialJob?.relayDelivery
        .filter(({ status }) => status === "acked")
        .map(({ relayUrl }) => relayUrl) ?? []
    )
    await makeDeletionImmediatelyRetryableAndRemoveLocalEvidence(firstPage)
    const storageState = await firstContext.storageState({ indexedDB: true })
    await firstContext.close()

    const retryPublishes: ObservedRelayPublish[] = []
    const restartedContext = await browser.newContext({ storageState })
    const restartedPage = await restartedContext.newPage()
    try {
      await installRelayMock(restartedPage, retryPublishes, () => true)
      await installValidTestSigner(restartedPage, () => {
        signerCalls += 1
        throw new Error("A durable retry must not request another signature")
      })
      await restartedPage.goto(`${merchantUrl}/products`)
      await expect(
        restartedPage.getByRole("heading", {
          name: "Products",
          exact: true,
        })
      ).toBeVisible()

      await expect
        .poll(
          async () => (await readDeletionState(restartedPage)).jobs[0]?.state,
          { timeout: 20_000 }
        )
        .toBe("delivered")
      const afterRestart = await readDeletionState(restartedPage)
      expect(afterRestart.jobs[0]?.signedEvent).toEqual(exactSignedEvent)
      expect(afterRestart.tombstoneCount).toBeGreaterThan(0)
      expect(signerCalls).toBe(1)
      expect(
        restartedPage.getByText("Durable delete browser fixture", {
          exact: true,
        })
      ).toHaveCount(0)

      expect(retryPublishes.map(({ relayUrl }) => relayUrl)).toEqual([
        "wss://write-browser.example",
      ])
      expect(retryPublishes[0]?.event).toEqual(exactSignedEvent)
      for (const relayUrl of ackedBeforeRestart) {
        expect(retryPublishes.some((item) => item.relayUrl === relayUrl)).toBe(
          false
        )
      }
    } finally {
      await restartedContext.close()
    }
  } finally {
    if (firstContext.pages().length > 0) {
      await firstContext.close()
    }
  }
})

import { expect, test, type Page } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

const merchantUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"
}`
const isolatedRelayUrl = `ws://127.0.0.1:${
  process.env.PLAYWRIGHT_RELAY_PORT ?? "7777"
}`
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const OTHER_SECRET = generateSecretKey()
const PRODUCT_EVENT_ID = "9".repeat(64)
const PRODUCT_D_TAG = "durable-delete-browser"
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}`
const relayLifecycleHarnessUrl = "/src/test-fixtures/relay-lifecycle-harness.ts"

type UnsignedBrowserEvent = {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

function hasSameSerializedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function installValidTestSigner(
  page: Page,
  onSign?: () => void,
  signingSecret = MERCHANT_SECRET
): Promise<void> {
  await page.exposeFunction(
    "__conduitSignDeletionTestEvent",
    (event: UnsignedBrowserEvent) => {
      onSign?.()
      return finalizeEvent(event, signingSecret)
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

type RelayResponseGate = {
  errors: unknown[]
  wait: (relayUrl: string, event: Record<string, unknown>) => Promise<void>
}

function normalizeRelayUrl(relayUrl: string): string {
  return relayUrl.endsWith("/") ? relayUrl.slice(0, -1) : relayUrl
}

async function installRelayMock(
  page: Page,
  publishes: ObservedRelayPublish[],
  accept: (
    relayUrl: string,
    event: Record<string, unknown>
  ) => boolean | "transport_failure",
  responseGate?: RelayResponseGate
): Promise<void> {
  await page.routeWebSocket(/^wss?:\/\//, (socket) => {
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
      if (accepted === "transport_failure") {
        void socket.close()
        return
      }
      const sendResponse = () =>
        socket.send(
          JSON.stringify([
            "OK",
            event.id,
            accepted,
            accepted ? "" : "blocked: simulated partial delivery",
          ])
        )
      const responseReady = responseGate?.wait(relayUrl, event)
      if (!responseReady) {
        sendResponse()
        return
      }
      void responseReady
        .then(sendResponse)
        .catch((error) => responseGate.errors.push(error))
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
            sourceRelayUrls: ["wss://source-browser.conduit.market"],
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
      created_at: number
      tags: string[][]
      content: string
      sig: string
    }
    relayPlan: Array<{ relayUrl: string; roles: string[] }>
    relayDelivery: Array<{
      relayUrl: string
      status: string
      attemptCount: number
    }>
    companionListingJobId?: string
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

async function readListingJobs(page: Page): Promise<
  Array<{
    id: string
    state: string
    signedEvents: Array<{ id: string; tags: string[][] }>
    relayDelivery: Array<{
      relayUrl: string
      status: string
      attemptCount: number
    }>
    companionDeletionJobId?: string
    deliveryAttemptCount: number
  }>
> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const transaction = request.result.transaction(
            "productListingOutbox",
            "readonly"
          )
          const jobs = transaction.objectStore("productListingOutbox").getAll()
          transaction.oncomplete = () => resolve(jobs.result)
          transaction.onerror = () => reject(transaction.error)
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

async function seedVersionSixteenDatabase(page: Page): Promise<{
  product: Record<string, unknown>
  tombstone: Record<string, unknown>
  eventMarketEvidence: Record<string, unknown>
  merchantPendingInvoice: Record<string, unknown>
}> {
  return await page.evaluate(
    ({ merchantPubkey, eventId, dTag, addressId }) =>
      new Promise((resolve, reject) => {
        const product = {
          id: addressId,
          pubkey: merchantPubkey,
          title: "Preserved v16 product",
          summary: "Schema migration fixture",
          price: 1,
          currency: "SATS",
          priceSats: 1,
          type: "simple",
          format: "digital",
          visibility: "public",
          stock: 1,
          images: [{ url: "https://example.com/v16-product.png" }],
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
        const eventMarketEvidence = {
          id: `31990:${merchantPubkey}:migration-market`,
          organizerPubkey: merchantPubkey,
          kind: 31990,
          addressId: `31990:${merchantPubkey}:migration-market`,
          cachedAt: 120_000,
        }
        const merchantPendingInvoice = {
          id: "migration-pending-invoice",
          merchantPubkey,
          orderId: "migration-order",
          deliveryState: "pending",
          invoiceExpiresAt: 130_000,
          updatedAt: 120_000,
        }
        const request = indexedDB.open("conduit", 160)
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
            {
              name: "shopperTrustSnapshots",
              keyPath: "id",
              indexes: [["merchantPubkey"], ["shopperPubkey"], ["cachedAt"]],
            },
            {
              name: "productDeletionOutbox",
              keyPath: "id",
              indexes: [
                ["state"],
                ["nextRetryAt"],
                ["deliveryLeaseExpiresAt"],
                ["updatedAt"],
                ["createdAt"],
              ],
            },
            {
              name: "inboxDeclarationEvidence",
              keyPath: "pubkey",
              indexes: [["cachedAt"]],
            },
            {
              name: "ownContactListSnapshots",
              keyPath: "pubkey",
              indexes: [["state"], ["cachedAt"]],
            },
            { name: "wallets", keyPath: "id", indexes: [] },
            {
              name: "walletCredentials",
              keyPath: "walletId",
              indexes: [],
            },
            {
              name: "shippingOptionFrontiers",
              keyPath: "coordinate",
              indexes: [
                ["pubkey"],
                ["dTag"],
                ["strongestCreatedAt"],
                ["cachedAt"],
              ],
            },
            {
              name: "merchantPendingInvoices",
              keyPath: "id",
              indexes: [
                ["merchantPubkey"],
                ["orderId"],
                ["deliveryState"],
                ["invoiceExpiresAt"],
                ["updatedAt"],
              ],
            },
            {
              name: "eventMarketEvidence",
              keyPath: "id",
              indexes: [
                ["organizerPubkey"],
                ["kind"],
                ["addressId"],
                ["cachedAt"],
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
            [
              "products",
              "productTombstones",
              "eventMarketEvidence",
              "merchantPendingInvoices",
            ],
            "readwrite"
          )
          transaction.objectStore("products").put(product)
          transaction.objectStore("productTombstones").put(tombstone)
          transaction
            .objectStore("eventMarketEvidence")
            .put(eventMarketEvidence)
          transaction
            .objectStore("merchantPendingInvoices")
            .put(merchantPendingInvoice)
          transaction.oncomplete = () => {
            database.close()
            resolve({
              product,
              tombstone,
              eventMarketEvidence,
              merchantPendingInvoice,
            })
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
  ownerEvidenceIndexes: string[]
  product: Record<string, unknown> | undefined
  tombstone: Record<string, unknown> | undefined
  eventMarketEvidence: Record<string, unknown> | undefined
  merchantPendingInvoice: Record<string, unknown> | undefined
  outboxCount: number
  ownerEvidenceCount: number
}> {
  return await page.evaluate(
    ({ addressId, merchantPubkey, eventId }) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const stores = Array.from(database.objectStoreNames)
          if (
            !stores.includes("productDeletionOutbox") ||
            !stores.includes("ownerRelayListEvidence")
          ) {
            database.close()
            resolve({
              nativeVersion: database.version,
              stores,
              outboxIndexes: [],
              productIndexes: [],
              tombstoneIndexes: [],
              ownerEvidenceIndexes: [],
              product: undefined,
              tombstone: undefined,
              eventMarketEvidence: undefined,
              merchantPendingInvoice: undefined,
              outboxCount: -1,
              ownerEvidenceCount: -1,
            })
            return
          }
          const transaction = database.transaction(
            [
              "products",
              "productTombstones",
              "productDeletionOutbox",
              "ownerRelayListEvidence",
              "eventMarketEvidence",
              "merchantPendingInvoices",
            ],
            "readonly"
          )
          const products = transaction.objectStore("products")
          const tombstones = transaction.objectStore("productTombstones")
          const outbox = transaction.objectStore("productDeletionOutbox")
          const ownerEvidence = transaction.objectStore(
            "ownerRelayListEvidence"
          )
          const eventMarkets = transaction.objectStore("eventMarketEvidence")
          const pendingInvoices = transaction.objectStore(
            "merchantPendingInvoices"
          )
          const productRequest = products.get(addressId)
          const tombstoneRequest = tombstones.get(
            `e:${merchantPubkey}:${eventId}`
          )
          const outboxCountRequest = outbox.count()
          const ownerEvidenceCountRequest = ownerEvidence.count()
          const eventMarketRequest = eventMarkets.get(
            `31990:${merchantPubkey}:migration-market`
          )
          const pendingInvoiceRequest = pendingInvoices.get(
            "migration-pending-invoice"
          )
          transaction.oncomplete = () => {
            const state = {
              nativeVersion: database.version,
              stores,
              outboxIndexes: Array.from(outbox.indexNames).sort(),
              productIndexes: Array.from(products.indexNames).sort(),
              tombstoneIndexes: Array.from(tombstones.indexNames).sort(),
              ownerEvidenceIndexes: Array.from(ownerEvidence.indexNames).sort(),
              product: productRequest.result,
              tombstone: tombstoneRequest.result,
              eventMarketEvidence: eventMarketRequest.result,
              merchantPendingInvoice: pendingInvoiceRequest.result,
              outboxCount: outboxCountRequest.result,
              ownerEvidenceCount: ownerEvidenceCountRequest.result,
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

test("Merchant upgrades v16 data to the v17 owner-evidence store @merchant", async ({
  page,
}) => {
  await page.route(
    `${merchantUrl}/__product-deletion-v16-fixture`,
    async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Product deletion v16 fixture</title>",
      })
    }
  )
  await page.goto(`${merchantUrl}/__product-deletion-v16-fixture`)
  const fixture = await seedVersionSixteenDatabase(page)

  await page.goto(`${merchantUrl}/`)
  await expect
    .poll(
      async () => {
        const state = await readDatabaseMigrationState(page)
        return {
          nativeVersion: state.nativeVersion,
          hasOutbox: state.stores.includes("productDeletionOutbox"),
          hasShopperTrust: state.stores.includes("shopperTrustSnapshots"),
          hasInboxDeclarationEvidence: state.stores.includes(
            "inboxDeclarationEvidence"
          ),
          hasOwnContactListSnapshots: state.stores.includes(
            "ownContactListSnapshots"
          ),
          hasEventMarketEvidence: state.stores.includes("eventMarketEvidence"),
          hasWallets: state.stores.includes("wallets"),
          hasWalletCredentials: state.stores.includes("walletCredentials"),
          hasShippingOptionFrontiers: state.stores.includes(
            "shippingOptionFrontiers"
          ),
          hasMerchantPendingInvoices: state.stores.includes(
            "merchantPendingInvoices"
          ),
          hasOwnerRelayListEvidence: state.stores.includes(
            "ownerRelayListEvidence"
          ),
          hasShoppingCarts: state.stores.includes("shoppingCarts"),
          hasProductListingOutbox: state.stores.includes(
            "productListingOutbox"
          ),
        }
      },
      { timeout: 20_000 }
    )
    .toEqual({
      nativeVersion: 200,
      hasOutbox: true,
      hasShopperTrust: true,
      hasInboxDeclarationEvidence: true,
      hasOwnContactListSnapshots: true,
      hasEventMarketEvidence: true,
      hasWallets: true,
      hasWalletCredentials: true,
      hasShippingOptionFrontiers: true,
      hasMerchantPendingInvoices: true,
      hasOwnerRelayListEvidence: true,
      hasShoppingCarts: true,
      hasProductListingOutbox: true,
    })

  const migrated = await readDatabaseMigrationState(page)
  expect(hasSameSerializedValue(migrated.product, fixture.product)).toBe(true)
  expect(hasSameSerializedValue(migrated.tombstone, fixture.tombstone)).toBe(
    true
  )
  expect(
    hasSameSerializedValue(
      migrated.eventMarketEvidence,
      fixture.eventMarketEvidence
    )
  ).toBe(true)
  expect(
    hasSameSerializedValue(
      migrated.merchantPendingInvoice,
      fixture.merchantPendingInvoice
    )
  ).toBe(true)
  expect(migrated.outboxCount).toBe(0)
  expect(migrated.ownerEvidenceCount).toBe(0)
  expect(migrated.ownerEvidenceIndexes).toEqual(["cachedAt"])
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

test("Merchant persists one exact deletion and restores it after reload @merchant", async ({
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
  expect(
    job?.signedEvent.kind === 5 &&
      job.signedEvent.pubkey === MERCHANT_PUBKEY &&
      job.signedEvent.tags.some(
        ([tagName, value]) => tagName === "e" && value === PRODUCT_EVENT_ID
      ) &&
      job.signedEvent.tags.some(
        ([tagName, value]) => tagName === "a" && value === PRODUCT_ADDRESS
      ) &&
      /^[0-9a-f]{128}$/.test(job.signedEvent.sig)
  ).toBe(true)
  expect(beforeReload.tombstoneCount).toBeGreaterThan(0)
  expect(
    job?.relayPlan.length === 1 &&
      job.relayPlan[0]?.relayUrl === isolatedRelayUrl &&
      hasSameSerializedValue(job.relayPlan[0]?.roles, [
        "author_write",
        "conduit",
      ])
  ).toBe(true)

  const exactSignedEvent = structuredClone(job?.signedEvent)
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Durable delete browser fixture", { exact: true })
  ).toHaveCount(0)

  const afterReload = await readDeletionState(page)
  expect(
    hasSameSerializedValue(afterReload.jobs[0]?.signedEvent, exactSignedEvent)
  ).toBe(true)
  expect(afterReload.tombstoneCount).toBeGreaterThan(0)
})

test("Merchant starts a newly signed deletion after every relay rejects the original @merchant", async ({
  page,
}) => {
  let allowDelivery = false
  let signerCalls = 0
  const publishes: ObservedRelayPublish[] = []
  await installRelayMock(page, publishes, () => allowDelivery)
  await installValidTestSigner(page, () => {
    signerCalls += 1
  })
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
    .poll(async () => {
      const jobs = (await readDeletionState(page)).jobs
      return (
        jobs.length === 1 &&
        jobs[0]!.relayDelivery.length > 0 &&
        jobs[0]!.relayDelivery.every(
          (delivery) => delivery.status === "rejected"
        )
      )
    })
    .toBe(true)
  const first = (await readDeletionState(page)).jobs[0]!
  expect(signerCalls).toBe(1)
  await expect(page.getByText("Delete rejected")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Retry delivery" })
  ).toHaveCount(0)

  await page.reload()
  await expect(
    page.getByRole("button", { name: "Sign new delivery" })
  ).toBeVisible()
  const beforeRepair = (await readDeletionState(page)).jobs
  expect(beforeRepair).toHaveLength(1)
  expect(beforeRepair[0]!.deliveryAttemptCount).toBe(1)

  allowDelivery = true
  await page.getByRole("button", { name: "Sign new delivery" }).click()
  await expect
    .poll(async () => {
      const jobs = (await readDeletionState(page)).jobs
      return (
        jobs.length === 2 &&
        jobs.some((job) => job.id !== first.id && job.state === "delivered")
      )
    })
    .toBe(true)
  const recovered = (await readDeletionState(page)).jobs
  expect(signerCalls).toBe(2)
  expect(
    recovered.find((job) => job.id === first.id)?.deliveryAttemptCount
  ).toBe(1)
  const replacement = recovered.find((job) => job.id !== first.id)!
  expect(replacement.signedEvent.id).not.toBe(first.signedEvent.id)
  expect(replacement.signedEvent.created_at).toBe(first.signedEvent.created_at)
  expect(
    replacement.signedEvent.tags.filter(
      ([name]) => name !== "conduit_recovery_attempt"
    )
  ).toEqual(first.signedEvent.tags)
  expect(
    replacement.signedEvent.tags.filter(
      ([name]) => name === "conduit_recovery_attempt"
    )
  ).toHaveLength(1)
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Sign new delivery" })
  ).toHaveCount(0)
})

test("Merchant refuses a deletion signed by a switched account before staging @merchant", async ({
  page,
}) => {
  let signerCalls = 0
  const publishes: ObservedRelayPublish[] = []
  await installRelayMock(page, publishes, () => true)
  await installValidTestSigner(
    page,
    () => {
      signerCalls += 1
    },
    OTHER_SECRET
  )
  await page.goto(`${merchantUrl}/products`)
  await seedCachedProduct(page)
  await page.reload()
  await expect(
    page.getByText("Durable delete browser fixture", { exact: true })
  ).toBeVisible()

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await expect.poll(async () => signerCalls).toBe(1)
  await expect(
    page.getByText(/The event was signed with a different account/)
  ).toBeVisible()
  await expect
    .poll(async () => (await readDeletionState(page)).jobs.length)
    .toBe(0)
  expect((await readDeletionState(page)).tombstoneCount).toBe(0)
  expect(publishes).toEqual([])
})

test("Merchant re-signs a rejected companion deletion only after its replacement family has a reciprocal common ACK @merchant", async ({
  page,
}) => {
  test.setTimeout(60_000)
  let signerCalls = 0
  const publishes: ObservedRelayPublish[] = []
  await installRelayMock(page, publishes, () => true)
  await installValidTestSigner(page, () => {
    signerCalls += 1
  })
  await page.goto(`${merchantUrl}/products`)
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()

  const eventCreatedAt = Math.floor(Date.now() / 1000) - 60
  const replacementEvents = ["parent", "variation"].map((dTag) =>
    finalizeEvent(
      {
        kind: 30402,
        created_at: eventCreatedAt + 1,
        tags: [["d", `companion-recovery-${dTag}`]],
        content: "Replacement family fixture",
      },
      MERCHANT_SECRET
    )
  )
  const originalDeletion = finalizeEvent(
    {
      kind: 5,
      created_at: eventCreatedAt + 2,
      tags: [
        ["e", PRODUCT_EVENT_ID],
        ["a", PRODUCT_ADDRESS],
        ["k", "30402"],
      ],
      content: "",
    },
    MERCHANT_SECRET
  )
  const listingJobId = `product-listing:${replacementEvents.map((event) => event.id).join(":")}`
  const now = Date.now()
  await page.evaluate(
    ({ listingJob, deletionJob }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const transaction = request.result.transaction(
            ["productListingOutbox", "productDeletionOutbox"],
            "readwrite"
          )
          transaction.objectStore("productListingOutbox").put(listingJob)
          transaction.objectStore("productDeletionOutbox").put(deletionJob)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      listingJob: {
        id: listingJobId,
        merchantPubkey: MERCHANT_PUBKEY,
        signedEvents: replacementEvents,
        relayTargets: [{ relayUrl: isolatedRelayUrl, ownerSelected: false }],
        relayDelivery: replacementEvents.map((event) => ({
          eventId: event.id,
          relayUrl: isolatedRelayUrl,
          status: "pending",
          attemptCount: 0,
        })),
        companionDeletionJobId: originalDeletion.id,
        readyForDelivery: false,
        state: "pending",
        deliveryAttemptCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      deletionJob: {
        id: originalDeletion.id,
        signedEvent: originalDeletion,
        relayPlan: [
          {
            relayUrl: isolatedRelayUrl,
            roles: ["author_write", "conduit"],
          },
        ],
        relayDelivery: [
          {
            relayUrl: isolatedRelayUrl,
            status: "rejected",
            attemptCount: 1,
            lastAttemptAt: now,
            rejectedAt: now,
          },
        ],
        state: "partial",
        deliveryAttemptCount: 1,
        retryCount: 1,
        companionListingJobId: listingJobId,
        createdAt: now,
        updatedAt: now,
      },
    }
  )

  async function updateCompanionListing(reciprocal: boolean): Promise<void> {
    await page.evaluate(
      ({ id, deletionId, relayUrl, reciprocal }) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("conduit")
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const transaction = request.result.transaction(
              "productListingOutbox",
              "readwrite"
            )
            const store = transaction.objectStore("productListingOutbox")
            const jobRequest = store.get(id)
            jobRequest.onsuccess = () => {
              const job = jobRequest.result
              store.put({
                ...job,
                companionDeletionJobId: reciprocal
                  ? deletionId
                  : "f".repeat(64),
                readyForDelivery: true,
                state: "delivered",
                deliveryAttemptCount: 1,
                relayDelivery: job.signedEvents.map(
                  (event: { id: string }) => ({
                    eventId: event.id,
                    relayUrl,
                    status: "acked",
                    attemptCount: 1,
                    acknowledgedAt: Date.now(),
                  })
                ),
                updatedAt: Date.now(),
              })
            }
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
          }
        }),
      {
        id: listingJobId,
        deletionId: originalDeletion.id,
        relayUrl: isolatedRelayUrl,
        reciprocal,
      }
    )
  }

  await page.reload()
  await expect(
    page.getByRole("button", { name: "Sign new delivery" })
  ).toHaveCount(0)
  expect(signerCalls).toBe(0)

  await updateCompanionListing(false)
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Sign new delivery" })
  ).toHaveCount(0)
  expect(signerCalls).toBe(0)

  await updateCompanionListing(true)
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Sign new delivery" })
  ).toBeVisible()
  const beforeRecovery = (await readDeletionState(page)).jobs
  expect(beforeRecovery).toHaveLength(1)
  expect(beforeRecovery[0]?.deliveryAttemptCount).toBe(1)

  await page.getByRole("button", { name: "Sign new delivery" }).click()
  await expect
    .poll(async () => {
      const jobs = (await readDeletionState(page)).jobs
      return (
        jobs.length === 2 &&
        jobs.some(
          (job) => job.id !== originalDeletion.id && job.state === "delivered"
        )
      )
    })
    .toBe(true)
  const jobs = (await readDeletionState(page)).jobs
  const newJob = jobs.find((job) => job.id !== originalDeletion.id)!
  expect(signerCalls).toBe(1)
  expect(
    jobs.find((job) => job.id === originalDeletion.id)?.deliveryAttemptCount
  ).toBe(1)
  expect(newJob.signedEvent.created_at).toBe(originalDeletion.created_at)
  expect(newJob.signedEvent.id).not.toBe(originalDeletion.id)
  expect(
    newJob.signedEvent.tags.filter(([name]) => name === "e" || name === "a")
  ).toEqual(
    originalDeletion.tags.filter(([name]) => name === "e" || name === "a")
  )
  expect(publishes.some(({ event }) => event.id === originalDeletion.id)).toBe(
    false
  )
  expect(
    publishes.some(({ event }) => event.id === newJob.signedEvent.id)
  ).toBe(true)
})

test("Merchant can re-sign an unchanged product after terminal relay rejection @merchant", async ({
  page,
}) => {
  test.setTimeout(60_000)
  let allowDelivery = false
  let listingSignerCalls = 0
  const publishes: ObservedRelayPublish[] = []
  await installRelayMock(page, publishes, () => allowDelivery)
  await installValidTestSigner(page, () => {
    listingSignerCalls += 1
  })
  await page.goto(`${merchantUrl}/products`)
  await page.getByRole("button", { name: "Add product" }).first().click()
  const dialog = page.getByRole("dialog", { name: "Add product" })
  await dialog.getByLabel("Title").fill("Rejected listing browser fixture")
  await dialog.getByLabel("Summary").fill("Tests newly signed relay recovery")
  await dialog.getByLabel("Price").fill("10")
  await dialog.getByLabel("Stock quantity").fill("1")
  await dialog.locator("#product-currency").click()
  await page.getByRole("option", { name: "SATS" }).click()
  await dialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital" }).click()
  await dialog.getByRole("button", { name: "Add by URL" }).click()
  await dialog
    .getByLabel("Primary image URL")
    .fill("https://media.conduit.market/rejected-listing.png")
  const tags = dialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["merchant", "recovery", "regression"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  await expect(
    dialog.getByRole("button", { name: "Publish product" })
  ).toBeEnabled()
  await dialog.getByRole("button", { name: "Publish product" }).click()
  const readinessDialog = page.getByRole("alertdialog")
  if (await readinessDialog.isVisible()) {
    await readinessDialog
      .getByRole("button", { name: "Publish anyway" })
      .click()
  }
  await expect
    .poll(async () => {
      const jobs = await readListingJobs(page)
      return jobs.length === 1 && jobs[0]?.state === "failed"
    })
    .toBe(true)
  const first = (await readListingJobs(page))[0]!
  expect(listingSignerCalls).toBe(1)
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Review and republish" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Review and republish" }).click()
  const editDialog = page.getByRole("dialog", { name: "Edit listing" })
  await expect(editDialog.getByLabel("Title")).toHaveValue(
    "Rejected listing browser fixture"
  )
  await expect(
    editDialog.getByRole("button", { name: "Sign new delivery" })
  ).toBeEnabled()

  allowDelivery = true
  await editDialog.getByRole("button", { name: "Sign new delivery" }).click()
  await expect
    .poll(async () => {
      const jobs = await readListingJobs(page)
      return (
        jobs.length === 2 &&
        jobs.some((job) => job.id !== first.id && job.state === "delivered")
      )
    })
    .toBe(true)
  const recovered = await readListingJobs(page)
  expect(listingSignerCalls).toBe(2)
  expect(
    recovered.find((job) => job.id === first.id)?.deliveryAttemptCount
  ).toBe(1)
  expect(recovered.find((job) => job.id !== first.id)?.id).not.toBe(first.id)
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Review and republish" })
  ).toHaveCount(0)
})

test("Merchant deliberately re-signs a rejected mixed listing and deletion together after reload @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  let allowDelivery = false
  let signerCalls = 0
  let releaseListingAck: () => void = () => {}
  const listingAckGate = new Promise<void>((resolve) => {
    releaseListingAck = resolve
  })
  const publishes: ObservedRelayPublish[] = []
  const responseGate: RelayResponseGate = {
    errors: [],
    wait: async (_relayUrl, event) => {
      if (allowDelivery && event.kind === 30402) await listingAckGate
    },
  }
  await installRelayMock(page, publishes, () => allowDelivery, responseGate)
  await installValidTestSigner(page, () => {
    signerCalls += 1
  })
  await page.goto(`${merchantUrl}/products`)
  await page.getByRole("button", { name: "Add product" }).first().click()
  const addDialog = page.getByRole("dialog", { name: "Add product" })
  await addDialog.getByLabel("Title").fill("Rejected mixed browser fixture")
  await addDialog.getByLabel("Summary").fill("Tests paired relay recovery")
  await addDialog.getByLabel("Price").fill("10")
  await addDialog.getByLabel("Stock quantity").fill("1")
  await addDialog.locator("#product-currency").click()
  await page.getByRole("option", { name: "SATS" }).click()
  await addDialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital" }).click()
  await addDialog.getByRole("button", { name: "Add by URL" }).click()
  await addDialog
    .getByLabel("Primary image URL")
    .fill("https://media.conduit.market/rejected-mixed.png")
  const tags = addDialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["merchant", "recovery", "regression"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  await addDialog.getByRole("button", { name: "Publish product" }).click()
  const readinessDialog = page.getByRole("alertdialog")
  if (await readinessDialog.isVisible()) {
    await readinessDialog
      .getByRole("button", { name: "Publish anyway" })
      .click()
  }
  await expect
    .poll(async () => (await readListingJobs(page))[0]?.state)
    .toBe("failed")
  const originalListing = (await readListingJobs(page))[0]!
  expect(originalListing.signedEvents).toHaveLength(1)
  expect(signerCalls).toBe(1)

  // The first listing is already a real locally authored, all-relay-rejected
  // browser product. Add the reciprocal, untouched deletion that a mixed
  // edit leaves queued when its listing never receives a common relay ACK.
  const originalDeletion = finalizeEvent(
    {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000) - 60,
      tags: [
        ["e", "8".repeat(64)],
        ["a", `30402:${MERCHANT_PUBKEY}:removed-variation`],
        ["k", "30402"],
      ],
      content: "",
    },
    MERCHANT_SECRET
  )
  const originalRelayUrl = originalListing.relayDelivery[0]!.relayUrl
  const stagedAt = Date.now()
  await page.evaluate(
    ({ listingId, deletionEvent, relayUrl, stagedAt }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const transaction = request.result.transaction(
            ["productListingOutbox", "productDeletionOutbox"],
            "readwrite"
          )
          const listings = transaction.objectStore("productListingOutbox")
          const listingRequest = listings.get(listingId)
          listingRequest.onsuccess = () => {
            listings.put({
              ...listingRequest.result,
              companionDeletionJobId: deletionEvent.id,
              updatedAt: stagedAt,
            })
          }
          transaction.objectStore("productDeletionOutbox").put({
            id: deletionEvent.id,
            signedEvent: deletionEvent,
            relayPlan: [{ relayUrl, roles: ["author_write", "conduit"] }],
            relayDelivery: [{ relayUrl, status: "pending", attemptCount: 0 }],
            state: "pending",
            deliveryAttemptCount: 0,
            retryCount: 0,
            companionListingJobId: listingId,
            createdAt: stagedAt,
            updatedAt: stagedAt,
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      listingId: originalListing.id,
      deletionEvent: originalDeletion,
      relayUrl: originalRelayUrl,
      stagedAt,
    }
  )

  await page.reload()
  await expect(
    page.getByRole("button", { name: "Review and republish" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Review and republish" }).click()
  const editDialog = page.getByRole("dialog", { name: "Edit listing" })
  await expect(editDialog.getByLabel("Title")).toHaveValue(
    "Rejected mixed browser fixture"
  )
  await expect(
    editDialog.getByRole("button", { name: "Sign new delivery" })
  ).toBeEnabled()
  expect((await readDeletionState(page)).jobs[0]?.deliveryAttemptCount).toBe(0)
  expect(publishes.some(({ event }) => event.id === originalDeletion.id)).toBe(
    false
  )

  allowDelivery = true
  await editDialog.getByRole("button", { name: "Sign new delivery" }).click()
  await expect
    .poll(async () => {
      const listings = await readListingJobs(page)
      const deletions = (await readDeletionState(page)).jobs
      return listings.length === 2 && deletions.length === 2
    })
    .toBe(true)
  const listingsBeforeAck = await readListingJobs(page)
  const deletionsBeforeAck = (await readDeletionState(page)).jobs
  const newListing = listingsBeforeAck.find(
    (job) => job.id !== originalListing.id
  )!
  const newDeletion = deletionsBeforeAck.find(
    (job) => job.id !== originalDeletion.id
  )!
  expect(signerCalls).toBe(3)
  expect(newListing.signedEvents[0]?.id).not.toBe(
    originalListing.signedEvents[0]?.id
  )
  expect(newListing.companionDeletionJobId).toBe(newDeletion.id)
  expect(newDeletion.companionListingJobId).toBe(newListing.id)
  expect(newDeletion.signedEvent.created_at).toBe(originalDeletion.created_at)
  expect(
    newDeletion.signedEvent.tags.filter(
      ([name]) => name === "e" || name === "a"
    )
  ).toEqual(
    originalDeletion.tags.filter(([name]) => name === "e" || name === "a")
  )
  expect(newDeletion.signedEvent.tags).toContainEqual([
    "conduit_recovery_attempt",
    originalDeletion.id,
    expect.any(String),
  ])
  expect(newDeletion.deliveryAttemptCount).toBe(0)
  expect(
    newDeletion.relayDelivery.every((entry) => entry.status === "pending")
  ).toBe(true)
  expect(publishes.some(({ event }) => event.id === newDeletion.id)).toBe(false)

  releaseListingAck()
  await expect
    .poll(async () => {
      const listings = await readListingJobs(page)
      const deletions = (await readDeletionState(page)).jobs
      return (
        listings.find((job) => job.id === newListing.id)?.state ===
          "delivered" &&
        deletions.find((job) => job.id === newDeletion.id)?.state ===
          "delivered"
      )
    })
    .toBe(true)
  const finalListings = await readListingJobs(page)
  const finalDeletions = (await readDeletionState(page)).jobs
  const deliveredListing = finalListings.find(
    (job) => job.id === newListing.id
  )!
  const deliveredDeletion = finalDeletions.find(
    (job) => job.id === newDeletion.id
  )!
  expect(
    deliveredDeletion.relayDelivery.some((deletionRelay) =>
      deliveredListing.relayDelivery.some(
        (listingRelay) =>
          listingRelay.relayUrl === deletionRelay.relayUrl &&
          listingRelay.status === "acked" &&
          deletionRelay.status === "acked"
      )
    )
  ).toBe(true)
  expect(
    finalListings.find((job) => job.id === originalListing.id)?.state
  ).toBe("failed")
  expect(
    finalListings.find((job) => job.id === originalListing.id)
      ?.deliveryAttemptCount
  ).toBe(originalListing.deliveryAttemptCount)
  expect(
    finalDeletions.find((job) => job.id === originalDeletion.id)
      ?.deliveryAttemptCount
  ).toBe(0)
  expect(publishes.some(({ event }) => event.id === originalDeletion.id)).toBe(
    false
  )
  expect(responseGate.errors).toEqual([])
})

test("Merchant resumes a timed-out deletion after browser restart without signing again @merchant", async ({
  browser,
}) => {
  let signerCalls = 0
  const firstPublishes: ObservedRelayPublish[] = []
  const firstContext = await browser.newContext()
  const firstPage = await firstContext.newPage()

  try {
    await installRelayMock(firstPage, firstPublishes, (relayUrl) =>
      relayUrl === isolatedRelayUrl ? "transport_failure" : true
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
            ({ relayUrl }) => relayUrl === isolatedRelayUrl
          )?.status,
        { timeout: 20_000 }
      )
      .toBe("timed_out")

    const beforeRestart = await readDeletionState(firstPage)
    const [partialJob] = beforeRestart.jobs
    expect(signerCalls).toBe(1)
    const timedOutDelivery = partialJob?.relayDelivery.find(
      ({ relayUrl }) => relayUrl === isolatedRelayUrl
    )
    expect(
      timedOutDelivery?.status === "timed_out" &&
        timedOutDelivery.attemptCount === 1
    ).toBe(true)
    expect(
      partialJob?.relayDelivery
        .filter(({ relayUrl }) => relayUrl !== isolatedRelayUrl)
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
    const retryResponseErrors: unknown[] = []
    let releaseRetryAcknowledgement = () => {}
    const retryAcknowledgementGate = new Promise<void>((resolve) => {
      releaseRetryAcknowledgement = resolve
    })
    const restartedContext = await browser.newContext({ storageState })
    const restartedPage = await restartedContext.newPage()
    try {
      await installRelayMock(restartedPage, retryPublishes, () => true, {
        errors: retryResponseErrors,
        wait: async (relayUrl) => {
          if (relayUrl === isolatedRelayUrl) {
            await retryAcknowledgementGate
          }
        },
      })
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

      await expect.poll(() => retryPublishes.length).toBe(1)
      // Hold the relay ACK until the ambient session client is reset. The
      // durable retry must own a separate transport or this exact publish is
      // disconnected and incorrectly backed off as a timeout.
      await restartedPage.evaluate(async (harnessUrl) => {
        const harness = (await import(harnessUrl)) as {
          resetSharedRelayClient: () => void
        }
        harness.resetSharedRelayClient()
      }, relayLifecycleHarnessUrl)
      releaseRetryAcknowledgement()

      await expect
        .poll(
          async () => (await readDeletionState(restartedPage)).jobs[0]?.state,
          { timeout: 20_000 }
        )
        .toBe("delivered")
      const afterRestart = await readDeletionState(restartedPage)
      expect(
        hasSameSerializedValue(
          afterRestart.jobs[0]?.signedEvent,
          exactSignedEvent
        )
      ).toBe(true)
      expect(afterRestart.tombstoneCount).toBeGreaterThan(0)
      expect(signerCalls).toBe(1)
      await expect
        .poll(
          async () =>
            (await restartedPage
              .getByText("Durable delete browser fixture", { exact: true })
              .count()) === 0,
          { timeout: 20_000 }
        )
        .toBe(true)

      expect(retryPublishes.map(({ relayUrl }) => relayUrl)).toEqual([
        isolatedRelayUrl,
      ])
      expect(
        hasSameSerializedValue(retryPublishes[0]?.event, exactSignedEvent)
      ).toBe(true)
      expect(retryResponseErrors.length).toBe(0)
      for (const relayUrl of ackedBeforeRestart) {
        expect(retryPublishes.some((item) => item.relayUrl === relayUrl)).toBe(
          false
        )
      }
    } finally {
      releaseRetryAcknowledgement()
      await restartedContext.close()
    }
  } finally {
    if (firstContext.pages().length > 0) {
      await firstContext.close()
    }
  }
})

import { expect, test, type Page } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT_PUBKEY = getPublicKey(MERCHANT_SECRET)
const PRODUCT_EVENT_ID = "8".repeat(64)
const PRODUCT_D_TAG = "market-cache-tombstone"
const PRODUCT_ADDRESS = `30402:${MERCHANT_PUBKEY}:${PRODUCT_D_TAG}`
const PRODUCT_TITLE = "Product deletion Market tombstone fixture"
const deletionEvent = finalizeEvent(
  {
    kind: 5,
    created_at: 110,
    tags: [
      ["e", PRODUCT_EVENT_ID],
      ["a", PRODUCT_ADDRESS],
      ["k", "30402"],
    ],
    content: "",
  },
  MERCHANT_SECRET
)

type UnsignedBrowserEvent = {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

async function installValidTestSigner(page: Page): Promise<void> {
  await page.exposeFunction(
    "__conduitSignMarketTestEvent",
    (event: UnsignedBrowserEvent) => finalizeEvent(event, MERCHANT_SECRET)
  )
  await page.addInitScript((merchantPubkey) => {
    localStorage.setItem("conduit:auth", merchantPubkey)
    const signer = window as typeof window & {
      __conduitSignMarketTestEvent: (
        event: UnsignedBrowserEvent
      ) => Promise<Record<string, unknown>>
    }
    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        async getPublicKey() {
          return merchantPubkey
        },
        async getRelays() {
          return {}
        },
        async signEvent(event: UnsignedBrowserEvent) {
          return await signer.__conduitSignMarketTestEvent(event)
        },
      },
    })
  }, MERCHANT_PUBKEY)
}

async function seedProduct(page: Page): Promise<void> {
  await page.evaluate(
    ({ merchantPubkey, eventId, dTag, addressId, title }) =>
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
            title,
            summary: "Public Market deletion browser fixture",
            price: 1,
            currency: "SATS",
            priceSats: 1,
            type: "simple",
            format: "digital",
            visibility: "public",
            stock: 1,
            images: [
              {
                url: "https://blossom.conduit.market/market-delete-fixture.png",
              },
            ],
            tags: ["deletion", "market", "regression"],
            publicZapEnabled: true,
            zapMessagePolicy: "generic_only",
            publicZapPolicyKnown: true,
            eventId,
            eventCreatedAt: 100,
            dTag,
            sourceRelayUrls: ["wss://source-market-browser.example"],
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
      title: PRODUCT_TITLE,
    }
  )
}

async function seedValidatedTombstones(page: Page): Promise<void> {
  await page.evaluate(
    ({ merchantPubkey, eventId, addressId, signedEvent }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction(
            "productTombstones",
            "readwrite"
          )
          const store = transaction.objectStore("productTombstones")
          const cachedAt = Date.now()
          const common = {
            pubkey: merchantPubkey,
            deletedAt: signedEvent.created_at,
            deletionEventId: signedEvent.id,
            signedEvent,
            sourceRelayUrls: ["wss://source-market-browser.example"],
            observedLocally: false,
            cachedAt,
          }
          store.put({
            ...common,
            id: `e:${merchantPubkey}:${eventId}`,
            eventId,
          })
          store.put({
            ...common,
            id: `a:${addressId}`,
            addressId,
          })
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    {
      merchantPubkey: MERCHANT_PUBKEY,
      eventId: PRODUCT_EVENT_ID,
      addressId: PRODUCT_ADDRESS,
      signedEvent: deletionEvent,
    }
  )
}

test("Market hides a stale cached product after durable tombstone evidence @market", async ({
  page,
}) => {
  await installValidTestSigner(page)
  await page.goto(`${marketUrl}/products?source=combined`)
  await expect(
    page.getByRole("textbox", { name: "Search products" })
  ).toBeVisible()

  await seedProduct(page)
  await page.reload()
  await expect(page.getByText(PRODUCT_TITLE, { exact: true })).toBeVisible()

  await seedValidatedTombstones(page)
  await page.reload()
  await expect(page.getByText(PRODUCT_TITLE, { exact: true })).toHaveCount(0)
})

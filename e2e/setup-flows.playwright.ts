import { expect, test, type Page } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  TEST_BUYER_PUBKEY,
  TEST_MERCHANT_PUBKEY,
  TEST_RELAY_URL,
  installRejectingTestSigner,
  installTestSigner,
  publishTestRelayEvents,
  readTestRelayEvents,
  seedMarketCart,
  seedTestRelayIdentity,
  seedStoredAuth,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const MERCHANT_TAG_CATALOG = [
  {
    dTag: "catalog-hardware-one",
    title: "Catalog Hardware One",
    tags: [" Hardware ", "HARDWARE", "relay"],
  },
  {
    dTag: "catalog-hardware-two",
    title: "Catalog Hardware Two",
    tags: ["hardware", "handmade"],
  },
  {
    dTag: "catalog-hardware-three",
    title: "Catalog Hardware Three",
    tags: ["hardware", "nostr"],
  },
] as const

async function exerciseNetworkInboxDeclaration(
  page: Page,
  appUrl: string,
  initialDeclaration: "empty" | "omit"
): Promise<void> {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey, {
    inboxDeclaration: initialDeclaration,
  })
  const seededDeclarations = await readTestRelayEvents({
    kinds: [10_050],
    authors: [pubkey],
  })
  expect(seededDeclarations).toHaveLength(
    initialDeclaration === "empty" ? 1 : 0
  )
  if (initialDeclaration === "empty") {
    expect(seededDeclarations[0]?.tags).toEqual([])
  }
  await installTestSigner(page, pubkey, { secretKey })
  await page.goto(appUrl === marketUrl ? `${appUrl}/products` : appUrl)
  await expect(
    page.getByRole("button", {
      name:
        appUrl === marketUrl
          ? "Open account menu"
          : "Open merchant account menu",
    })
  ).toBeVisible({ timeout: 15_000 })
  await page.goto(`${appUrl}/network`)

  await expect(
    page.getByRole("heading", { name: "Network Settings" })
  ).toBeVisible()
  await expect(
    page.getByText(
      initialDeclaration === "empty"
        ? "Restore your private inbox"
        : "Finish private inbox setup",
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    page.getByRole("checkbox", { name: TEST_RELAY_URL })
  ).toBeChecked()

  const publishButton = page.getByRole("button", {
    name: "Publish inbox declaration",
  })
  await expect(publishButton).toBeEnabled()
  await publishButton.click()

  await expect(
    page.getByText("Private inbox ready", { exact: true })
  ).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByText("Inbox declaration published and confirmed.", {
      exact: true,
    })
  ).toBeVisible()

  const declarations = await readTestRelayEvents({
    kinds: [10_050],
    authors: [pubkey],
  })
  expect(declarations).toHaveLength(1)
  expect(declarations[0]).toMatchObject({
    kind: 10_050,
    pubkey,
    tags: [["relay", TEST_RELAY_URL]],
  })
}

type StoredRelayEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStoredRelayEvent(value: unknown): value is StoredRelayEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.pubkey === "string" &&
    typeof value.created_at === "number" &&
    typeof value.kind === "number" &&
    Array.isArray(value.tags) &&
    typeof value.content === "string" &&
    typeof value.sig === "string"
  )
}

function relayEventMatchesFilter(
  event: StoredRelayEvent,
  filter: Record<string, unknown>
): boolean {
  const ids = filter.ids
  if (
    Array.isArray(ids) &&
    !ids.some((id) => typeof id === "string" && event.id.startsWith(id))
  ) {
    return false
  }
  const authors = filter.authors
  if (
    Array.isArray(authors) &&
    !authors.some(
      (author) => typeof author === "string" && event.pubkey.startsWith(author)
    )
  ) {
    return false
  }
  const kinds = filter.kinds
  if (Array.isArray(kinds) && !kinds.includes(event.kind)) return false
  if (typeof filter.since === "number" && event.created_at < filter.since) {
    return false
  }
  if (typeof filter.until === "number" && event.created_at > filter.until) {
    return false
  }

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue
    const tagName = key.slice(1)
    if (
      !event.tags.some(
        (tag) => tag[0] === tagName && values.includes(tag[1] ?? "")
      )
    ) {
      return false
    }
  }
  return true
}

function normalizeRelayUrl(relayUrl: string): string {
  return relayUrl.endsWith("/") ? relayUrl.slice(0, -1) : relayUrl
}

async function installStoredRelay(page: Page): Promise<void> {
  const eventsByRelay = new Map<string, Map<string, StoredRelayEvent>>()
  await page.routeWebSocket(
    /^(?:ws:\/\/127\.0\.0\.1:7777|wss:\/\/)/,
    (socket) => {
      const relayUrl = normalizeRelayUrl(socket.url())
      const eventsById =
        eventsByRelay.get(relayUrl) ?? new Map<string, StoredRelayEvent>()
      eventsByRelay.set(relayUrl, eventsById)
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
          const subscriptionId = frame[1]
          const filters = frame.slice(2).filter(isRecord)
          const limitedMatchesById = new Map<string, StoredRelayEvent>()
          for (const filter of filters) {
            const matches = Array.from(eventsById.values())
              .filter((event) => relayEventMatchesFilter(event, filter))
              .sort(
                (left, right) =>
                  right.created_at - left.created_at ||
                  left.id.localeCompare(right.id)
              )
            const limit =
              typeof filter.limit === "number"
                ? Math.max(0, Math.floor(filter.limit))
                : matches.length
            for (const event of matches.slice(0, limit)) {
              limitedMatchesById.set(event.id, event)
            }
          }
          for (const event of limitedMatchesById.values()) {
            socket.send(JSON.stringify(["EVENT", subscriptionId, event]))
          }
          socket.send(JSON.stringify(["EOSE", subscriptionId]))
          return
        }

        if (frame[0] === "EVENT" && isStoredRelayEvent(frame[1])) {
          const event = structuredClone(frame[1])
          eventsById.set(event.id, event)
          socket.send(JSON.stringify(["OK", event.id, true, "saved"]))
        }
      })
    }
  )
}

async function seedCachedMerchantProduct(page: Page): Promise<void> {
  await page.evaluate((merchantPubkey) => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction("products", "readwrite")
        const timestamp = Date.now()
        transaction.objectStore("products").put({
          id: `30402:${merchantPubkey}:published-pocket-relay`,
          pubkey: merchantPubkey,
          title: "Published Pocket Relay",
          summary: "Published summary",
          price: 1,
          currency: "SATS",
          priceSats: 1,
          sourcePrice: {
            amount: 0.00000001,
            currency: "BTC",
            normalizedCurrency: "BTC",
          },
          type: "simple",
          format: "physical",
          visibility: "public",
          stock: 1,
          images: [{ url: "https://blossom.conduit.market/pocket-relay.png" }],
          tags: ["relay", "hardware", "nostr"],
          publicZapEnabled: true,
          zapMessagePolicy: "generic_only",
          publicZapPolicyKnown: true,
          createdAt: timestamp,
          updatedAt: timestamp,
          cachedAt: timestamp,
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })
  }, TEST_MERCHANT_PUBKEY)
}

async function seedManualPaymentCart(
  page: Page,
  fixture: { productCoordinate: string; merchantPubkey: string }
): Promise<void> {
  await page.addInitScript(
    ({ coordinate, pubkey }) => {
      localStorage.setItem(
        "conduit:cart",
        JSON.stringify({
          version: 2,
          items: [
            {
              productId: coordinate,
              merchantPubkey: pubkey,
              title: "Manual payment checkout product",
              price: 1_000,
              currency: "SATS",
              priceSats: 1_000,
              format: "digital",
              quantity: 1,
            },
          ],
        })
      )
    },
    {
      coordinate: fixture.productCoordinate,
      pubkey: fixture.merchantPubkey,
    }
  )
}

async function exerciseProfileSave(
  page: Page,
  appUrl: string,
  profileName: string
): Promise<void> {
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  const createdAt = Math.floor(Date.now() / 1_000)
  await publishTestRelayEvents([
    finalizeEvent(
      {
        kind: 0,
        created_at: createdAt,
        tags: [],
        content: JSON.stringify({
          name: `before-${profileName}`,
          display_name: `Before ${profileName}`,
        }),
      },
      secretKey
    ),
    finalizeEvent(
      {
        kind: 10_002,
        created_at: createdAt,
        tags: [["r", TEST_RELAY_URL]],
        content: "",
      },
      secretKey
    ),
  ])
  await installTestSigner(page, pubkey, { secretKey })
  await page.goto(`${appUrl}/profile`)

  await expect(
    page.getByText(`Before ${profileName}`, { exact: true }).first()
  ).toBeVisible({ timeout: 30_000 })
  await page
    .getByRole("button", { name: "Edit profile", exact: true })
    .first()
    .click()
  const displayName = page.locator("#profile-display-name")
  await expect(displayName).toHaveValue(`Before ${profileName}`)
  await displayName.fill(`After ${profileName}`)
  await page.getByRole("button", { name: "Save changes", exact: true }).click()

  await expect(
    page.getByText("Profile signed and saved.", { exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText(`After ${profileName}`, { exact: true }).first()
  ).toBeVisible()
}

async function exerciseProfileDraftSignerSwitch(page: Page): Promise<void> {
  const firstSecretKey = generateSecretKey()
  const firstPubkey = getPublicKey(firstSecretKey)
  const secondSecretKey = generateSecretKey()
  const secondPubkey = getPublicKey(secondSecretKey)
  const createdAt = Math.floor(Date.now() / 1_000)

  await publishTestRelayEvents(
    [
      [firstSecretKey, "First account"],
      [secondSecretKey, "Second account"],
    ].flatMap(([secretKey, displayName]) => [
      finalizeEvent(
        {
          kind: 0,
          created_at: createdAt,
          tags: [],
          content: JSON.stringify({ display_name: displayName }),
        },
        secretKey as Uint8Array
      ),
      finalizeEvent(
        {
          kind: 10_002,
          created_at: createdAt,
          tags: [["r", TEST_RELAY_URL]],
          content: "",
        },
        secretKey as Uint8Array
      ),
    ])
  )

  await installTestSigner(page, firstPubkey, { secretKey: firstSecretKey })
  await page.goto(`${marketUrl}/profile`)
  await expect(
    page.getByText("First account", { exact: true }).first()
  ).toBeVisible({
    timeout: 30_000,
  })
  await page
    .getByRole("button", { name: "Edit profile", exact: true })
    .first()
    .click()
  await page.locator("#profile-display-name").fill("First account draft")

  await page.getByRole("button", { name: "Open account menu" }).click()
  await page.getByRole("menuitem", { name: "Disconnect" }).click()
  await expect(
    page.getByRole("button", { name: "Connect", exact: true })
  ).toBeVisible()

  await page.evaluate((signerPubkey) => {
    Object.defineProperty(window, "nostr", {
      configurable: true,
      value: {
        async getPublicKey() {
          return signerPubkey
        },
        async getRelays() {
          return { "ws://127.0.0.1:7777": { read: true, write: true } }
        },
        async signEvent(event: Record<string, unknown>) {
          return {
            ...event,
            pubkey: signerPubkey,
            id: "0".repeat(64),
            sig: "1".repeat(128),
          }
        },
      },
    })
  }, secondPubkey)

  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await page.getByRole("button", { name: "Connect Extension (NIP-07)" }).click()
  await expect(
    page.getByText("Second account", { exact: true }).first()
  ).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator("#profile-display-name")).toBeHidden()

  await page
    .getByRole("button", { name: "Edit profile", exact: true })
    .first()
    .click()
  await expect(page.locator("#profile-display-name")).toHaveValue(
    "Second account"
  )
}

async function seedMerchantTagCatalog(secretKey: Uint8Array): Promise<void> {
  const createdAt = Math.floor(Date.now() / 1_000)

  await publishTestRelayEvents(
    MERCHANT_TAG_CATALOG.map((product, index) =>
      finalizeEvent(
        {
          kind: 30_402,
          created_at: createdAt - index,
          tags: [
            ["d", product.dTag],
            ["title", product.title],
            ["price", "1", "SATS"],
            ["type", "simple", "digital"],
            ["stock", "1"],
            ["image", `https://example.com/catalog-${index}.png`],
            ...product.tags.map((tag) => ["t", tag]),
          ],
          content: "Catalog tag suggestion fixture",
        },
        secretKey
      )
    )
  )
}

async function seedCachedMerchantTagCatalog(
  page: Page,
  merchantPubkey: string
): Promise<void> {
  await page.evaluate(
    ([pubkey, products]) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("conduit")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction("products", "readwrite")
          const timestamp = Date.now()

          for (const [index, product] of products.entries()) {
            transaction.objectStore("products").put({
              id: `30402:${pubkey}:${product.dTag}`,
              pubkey,
              title: product.title,
              summary: "Catalog tag suggestion fixture",
              price: 1,
              currency: "SATS",
              priceSats: 1,
              sourcePrice: {
                amount: 1,
                currency: "SATS",
                normalizedCurrency: "SATS",
              },
              type: "simple",
              format: "digital",
              visibility: "public",
              stock: 1,
              images: [{ url: `https://example.com/catalog-${index}.png` }],
              tags: [...product.tags],
              publicZapEnabled: true,
              zapMessagePolicy: "generic_only",
              publicZapPolicyKnown: true,
              createdAt: timestamp - index,
              updatedAt: timestamp - index,
              cachedAt: timestamp,
            })
          }

          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      }),
    [merchantPubkey, MERCHANT_TAG_CATALOG] as const
  )
}

async function seedPortableWalletDescriptor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const randomBase64 = (byteLength: number): string => {
      const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
      return btoa(String.fromCharCode(...bytes))
    }

    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(
          ["wallets", "walletCredentials"],
          "readwrite"
        )
        const timestamp = Date.now()
        transaction.objectStore("wallets").put({
          id: "playwright-portable-wallet",
          kind: "portable",
          providerId: "spark",
          label: "QA Portable",
          network: "mainnet",
          capabilities: [
            "pay_invoice",
            "receive",
            "balance",
            "history",
            "spark_transfer",
          ],
          status: "locked",
          defaultIntents: ["pay_invoice"],
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        transaction.objectStore("walletCredentials").put({
          walletId: "playwright-portable-wallet",
          providerId: "spark",
          credential: JSON.stringify({
            type: "password",
            walletId: "playwright-portable-wallet",
            providerId: "spark",
            network: "mainnet",
            accountNumber: 1,
            recovery: {
              version: 2,
              kdf: "PBKDF2-SHA-256",
              cipher: "AES-GCM",
              iterations: 100_000,
              salt: randomBase64(16),
              iv: randomBase64(12),
              ciphertext: randomBase64(48),
            },
          }),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      }
    })
  })
}

test("merchant shipping country combobox supports search and selection @merchant", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 })
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/shipping`)

  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()

  const countryPicker = page.getByRole("combobox", {
    name: "Search countries to add...",
  })
  const countryPickerTrigger = page
    .locator("[data-combobox-search-trigger]")
    .filter({ has: countryPicker })
  const leadingTriggerSize = await countryPickerTrigger.evaluate((element) => ({
    width: element.clientWidth,
    height: element.clientHeight,
  }))
  await countryPickerTrigger.click({
    position: { x: 12, y: leadingTriggerSize.height / 2 },
  })
  await expect(countryPicker).toBeFocused()
  await page.keyboard.type("un")
  await expect(countryPicker).toHaveValue("un")
  await expect(page.getByRole("option").first()).toContainText("United")

  await countryPicker.fill("")
  await expect(page.getByRole("option").first()).toContainText("Åland Islands")

  await page.getByRole("heading", { name: "Shipping" }).click()
  const trailingTriggerSize = await countryPickerTrigger.evaluate(
    (element) => ({
      width: element.clientWidth,
      height: element.clientHeight,
    })
  )
  await countryPickerTrigger.click({
    position: {
      x: trailingTriggerSize.width - 12,
      y: trailingTriggerSize.height / 2,
    },
  })
  await expect(countryPicker).toBeFocused()
  await page.keyboard.type("canada")
  await expect(countryPicker).toHaveValue("canada")
  await page.getByRole("option", { name: /CA Canada/i }).click()

  await expect(
    page.locator("span").filter({ hasText: /^Canada$/ })
  ).toBeVisible()
  await expect(countryPicker).toHaveValue("")
})

test("Market Network publishes a private inbox through the isolated relay @market", async ({
  page,
}) => {
  await exerciseNetworkInboxDeclaration(page, marketUrl, "omit")
})

test("Merchant Network repairs a signed-empty private inbox through the isolated relay @merchant", async ({
  page,
}) => {
  await exerciseNetworkInboxDeclaration(page, merchantUrl, "empty")
})

test("Market profile saves update the mounted owner view immediately @market", async ({
  page,
}) => {
  await exerciseProfileSave(page, marketUrl, "Market owner")
})

test("Merchant profile saves update the mounted owner view immediately @merchant", async ({
  page,
}) => {
  await exerciseProfileSave(page, merchantUrl, "Merchant owner")
})

test("Market profile drafts do not cross signer identities @market", async ({
  page,
}) => {
  await exerciseProfileDraftSignerSwitch(page)
})

test("merchant product authoring warns about missing Lightning setup without blocking publication @merchant", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const secretKey = generateSecretKey()
  const merchantPubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey)
  await expect
    .poll(
      async () =>
        (
          await readTestRelayEvents({
            authors: [merchantPubkey],
            kinds: [0, 10_002],
          })
        ).length,
      { timeout: 10_000 }
    )
    .toBe(2)
  await installTestSigner(page, merchantPubkey, { secretKey })
  await page.goto(`${merchantUrl}/products`)
  await page.getByRole("button", { name: "Add product" }).first().click()

  const dialog = page.getByRole("dialog", { name: "Add product" })
  await expect(
    dialog.getByText("Lightning payments are not set up", { exact: true })
  ).toBeVisible({ timeout: 45_000 })
  await expect(
    dialog.getByRole("link", { name: "Set up payments", exact: true })
  ).toHaveAttribute("href", "/payments")

  await dialog.getByLabel("Title").fill("Manual payment product")
  await dialog.getByLabel("Price").fill("1")
  await dialog.locator("#product-fulfillment").click()
  await page.getByRole("option", { name: "Digital", exact: true }).click()
  await dialog
    .getByLabel("Image URL")
    .fill("https://media.conduit.market/manual-payment-product.png")
  const tags = dialog.getByRole("combobox", { name: "Tags" })
  for (const tag of ["manual", "payment", "demo"]) {
    await tags.fill(tag)
    await tags.press("Enter")
  }
  await expect(
    dialog.getByRole("button", { name: "Publish product", exact: true })
  ).toBeEnabled()
})

test("market checkout explains missing merchant Lightning setup without blocking signed order-first @market", async ({
  browser,
  page,
}) => {
  const merchantSecret = generateSecretKey()
  const merchantPubkey = getPublicKey(merchantSecret)
  const createdAt = Math.floor(Date.now() / 1_000)
  const productCoordinate = `30402:${merchantPubkey}:manual-payment-checkout`
  await publishTestRelayEvents([
    finalizeEvent(
      {
        kind: 0,
        created_at: createdAt,
        tags: [],
        content: JSON.stringify({ name: "Manual Payment Merchant" }),
      },
      merchantSecret
    ),
    finalizeEvent(
      {
        kind: 10_002,
        created_at: createdAt,
        tags: [["r", TEST_RELAY_URL]],
        content: "",
      },
      merchantSecret
    ),
    finalizeEvent(
      {
        kind: 30_402,
        created_at: createdAt,
        tags: [
          ["d", "manual-payment-checkout"],
          ["title", "Manual payment checkout product"],
          ["summary", "Paid product without a profile Lightning Address."],
          ["price", "1000", "SATS"],
          ["type", "simple", "digital"],
          ["stock", "3"],
          ["image", "https://media.conduit.market/manual-payment-checkout.png"],
        ],
        content: "Paid product without a profile Lightning Address.",
      },
      merchantSecret
    ),
  ])
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await seedManualPaymentCart(page, { productCoordinate, merchantPubkey })

  await page.goto(`${marketUrl}/checkout?merchant=${merchantPubkey}`)
  await expect(
    page.getByRole("heading", { name: "Send Order", exact: true })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText("Merchant Lightning payments are not set up", {
      exact: true,
    })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.getByText(
      "You can still send the order first and arrange payment with the merchant.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    page.getByText("Checking fulfillment", { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Send order", exact: true })
  ).toBeEnabled({
    timeout: 30_000,
  })

  const guestPage = await browser.newPage()
  await seedManualPaymentCart(guestPage, { productCoordinate, merchantPubkey })
  await guestPage.goto(`${marketUrl}/checkout?merchant=${merchantPubkey}`)
  await expect(
    guestPage.getByText("Merchant Lightning payments are not set up", {
      exact: true,
    })
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    guestPage.getByText(
      "Connect a signer to send the order and arrange payment with the merchant.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    guestPage.getByText("Checking fulfillment", { exact: true })
  ).toHaveCount(0)
  await guestPage.close()
})

test("merchant product tags suggest the loaded catalog without blocking freeform entry @merchant", async ({
  browser,
}) => {
  const secretKey = generateSecretKey()
  const merchantPubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey)
  await seedMerchantTagCatalog(secretKey)
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 375, height: 667 },
  })
  const page = await context.newPage()
  await installTestSigner(page, merchantPubkey, { secretKey })
  await page.goto(`${merchantUrl}/products`)
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  await seedCachedMerchantTagCatalog(page, merchantPubkey)
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Catalog Hardware One", { exact: true })
  ).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "Add product" }).first().click()

  const title = page.locator("#product-title")
  const tags = page.getByRole("combobox", { name: "Tags" })

  await tags.fill("ha")
  await expect(tags).toHaveAttribute("aria-expanded", "true")
  await expect(
    page.getByText("From your catalog", { exact: true })
  ).toBeVisible()
  await expect(page.getByRole("option").first()).toContainText(
    "hardware3 listings"
  )
  const suggestionListId = await tags.getAttribute("aria-controls")
  expect(suggestionListId).toBeTruthy()
  await expect(page.locator(`[id="${suggestionListId}"]`)).toHaveAttribute(
    "role",
    "listbox"
  )
  const activeSuggestionId = await tags.getAttribute("aria-activedescendant")
  expect(activeSuggestionId).toBeTruthy()
  await expect(page.locator(`[id="${activeSuggestionId}"]`)).toHaveAttribute(
    "aria-selected",
    "true"
  )

  const popup = page.locator("[data-radix-popper-content-wrapper]:visible")
  const popupBox = await popup.boundingBox()
  if (!popupBox) throw new Error("Product tag suggestion popup was not visible")
  expect(popupBox.x).toBeGreaterThanOrEqual(0)
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(375)

  await tags.fill("handm")
  const handmadeOption = page.getByRole("option", { name: /handmade/i })
  await expect(handmadeOption).toBeVisible()
  const handmadeOptionId = await handmadeOption.getAttribute("id")
  if (!handmadeOptionId) throw new Error("Handmade tag option had no id")
  await tags.press("ArrowDown")
  await expect(tags).toHaveAttribute("aria-activedescendant", handmadeOptionId)
  await tags.press("Enter")
  await expect(
    page.getByRole("button", { name: "Remove handmade tag" })
  ).toBeVisible()
  await expect(tags).toHaveValue("")

  await tags.fill("hard")
  await page.getByRole("option", { name: /hardware 3 listings/i }).tap()
  await expect(
    page.getByRole("button", { name: "Remove hardware tag" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Remove hard tag" })
  ).toHaveCount(0)

  await tags.fill("hard")
  await expect(tags).toHaveAttribute("aria-expanded", "false")
  await tags.fill("custom tag")
  await tags.press("Enter")
  await expect(
    page.getByRole("button", { name: "Remove custom tag tag" })
  ).toBeVisible()

  await tags.fill("rel")
  await expect(tags).toHaveAttribute("aria-expanded", "true")
  await tags.press("Escape")
  await expect(tags).toHaveAttribute("aria-expanded", "false")
  await expect(tags).toHaveValue("rel")
  await tags.press("Enter")
  await expect(
    page.getByRole("button", { name: "Remove rel tag" })
  ).toBeVisible()

  await tags.fill("blur tag")
  await title.focus()
  await expect(
    page.getByRole("button", { name: "Remove blur tag tag" })
  ).toBeVisible()
  await context.close()
})

test("merchant product options provide a generic availability matrix @merchant", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/products`)
  await page.getByRole("button", { name: "Add product" }).first().click()

  await page.getByRole("checkbox", { name: /This product has options/ }).check()
  await page.getByRole("button", { name: "Add option" }).click()
  await page.getByRole("button", { name: "Add option" }).click()

  const optionNames = page.getByLabel("Option name", { exact: true })
  const optionValues = page.getByLabel("Values", { exact: true })
  await optionNames.nth(0).fill("option-a")
  await optionValues.nth(0).fill("a1, a2")
  await optionNames.nth(1).fill("option-b")
  await optionValues.nth(1).fill("b1, b2")
  await optionNames.nth(2).fill("option-c")
  await optionValues.nth(2).fill("c1, c2")

  const matrix = page.getByRole("region", {
    name: "Combination availability matrix",
  })
  const availability = matrix.getByRole("checkbox")
  await expect(availability).toHaveCount(8)
  await expect(availability.first()).not.toBeChecked()
  await page.getByRole("button", { name: "Make all available" }).click()
  await expect(
    page.getByRole("button", { name: "Mark unavailable" })
  ).toHaveCount(8)
  await expect(page.getByText("a1 / b1 / c1")).toBeVisible()

  const dialogOverflow = await page
    .getByRole("dialog", { name: "Add product" })
    .evaluate((dialog) => {
      const directContentBottom = Math.max(
        ...Array.from(dialog.children).map(
          (child) => child.offsetTop + child.clientHeight
        )
      )
      const variationScroller = dialog.querySelector(
        "[data-product-variation-rows]"
      )

      if (!(variationScroller instanceof HTMLElement)) {
        throw new Error("Variation row scroller was not rendered")
      }

      return {
        excessScrollHeight: dialog.scrollHeight - directContentBottom,
        variationClientHeight: variationScroller.clientHeight,
        variationScrollHeight: variationScroller.scrollHeight,
      }
    })

  expect(dialogOverflow.variationScrollHeight).toBeGreaterThan(
    dialogOverflow.variationClientHeight
  )
  expect(dialogOverflow.excessScrollHeight).toBeLessThanOrEqual(32)

  await page
    .getByLabel("Combination title")
    .first()
    .fill("Retained combination title")
  await page.getByRole("button", { name: "Mark unavailable" }).first().click()
  await expect(
    page.getByRole("button", { name: "Mark unavailable" })
  ).toHaveCount(7)
  await expect(availability.first()).not.toBeChecked()
  await availability.first().check()
  await expect(
    page.getByRole("button", { name: "Mark unavailable" })
  ).toHaveCount(8)
  await expect(page.getByLabel("Combination title").first()).toHaveValue(
    "Retained combination title"
  )
})

test("merchant product drafts survive safe dialog dismissal @merchant", async ({
  page,
}) => {
  await installTestSigner(page, TEST_MERCHANT_PUBKEY)
  await page.goto(`${merchantUrl}/products`)

  await expect(
    page.getByRole("heading", { name: "Products", exact: true })
  ).toBeVisible()

  const addProduct = page.getByRole("button", { name: "Add product" }).first()
  const productDialog = page.getByRole("dialog", { name: "Add product" })
  const title = page.locator("#product-title")
  const tags = page.locator("#product-tags")
  const price = page.locator("#product-price")
  const shipping = page.locator("#product-shipping")
  const coordinateShipping = page.getByRole("checkbox", {
    name: "Coordinate shipping with the buyer after the order",
  })

  await addProduct.click()
  await title.fill("Pocket relay draft")

  await expect(page.locator("#product-tags-hint")).toContainText(
    "Minimum 3; aim for 5–12. 0/24 tags used"
  )

  await tags.fill("配送")
  await tags.dispatchEvent("compositionstart")
  await tags.dispatchEvent("keydown", { key: "Enter", code: "Enter" })
  await expect(tags).toHaveValue("配送")
  await expect(
    page.getByRole("button", { name: "Remove 配送 tag" })
  ).toHaveCount(0)
  await tags.dispatchEvent("compositionend")
  await tags.press("Enter")
  await expect(
    page.getByRole("button", { name: "Remove 配送 tag" })
  ).toBeVisible()
  await expect(tags).toHaveValue("")

  const priceError = page.locator("#product-price-error")
  await expect(priceError).toBeVisible()
  await expect(priceError).toHaveClass(/sm:col-span-4/)

  await price.fill("")
  await price.press("e")
  await expect(price).toHaveValue("")
  await price.fill("1e3")
  await expect(price).toHaveValue("")
  await price.fill("25")

  await shipping.fill("e")
  await expect(shipping).toHaveValue("")
  await shipping.fill("0")
  await expect(page.locator("#product-shipping-help")).toContainText(
    "fast checkout"
  )

  await coordinateShipping.check()
  await expect(shipping).toBeDisabled()
  await expect(shipping).toHaveValue("")
  await expect(page.locator("#product-coordinate-shipping-help")).toContainText(
    "Fast checkout will be unavailable"
  )
  await coordinateShipping.uncheck()
  await expect(shipping).toBeEnabled()
  await expect(shipping).toHaveValue("0")
  await expect(shipping).toHaveAttribute("placeholder", "0 or fixed amount")

  await page.locator("#product-currency").click()
  await expect(page.getByRole("listbox")).toBeVisible()
  const titleBox = await title.boundingBox()
  if (!titleBox) throw new Error("Product title was not visible")
  await page.mouse.click(titleBox.x + 12, titleBox.y + titleBox.height / 2)

  await expect(productDialog).toBeVisible()
  await expect(title).toHaveValue("Pocket relay draft")
  await expect(page.getByRole("listbox")).not.toBeVisible()

  const currency = page.locator("#product-currency")
  await currency.click()
  await page.getByRole("option", { name: "SATS" }).click()
  await expect(currency).toContainText("SATS")

  const dialogBox = await productDialog.boundingBox()
  if (!dialogBox) throw new Error("Product dialog was not visible")
  await page.mouse.click(
    Math.max(4, dialogBox.x - 12),
    Math.max(4, dialogBox.y + 24)
  )

  await expect(productDialog).toBeVisible()
  await expect(title).toHaveValue("Pocket relay draft")

  await page.keyboard.press("Escape")
  await expect(productDialog).not.toBeVisible()
  await expect(addProduct).toBeFocused()

  await addProduct.click()
  await expect(title).toHaveValue("Pocket relay draft")
  await expect(currency).toContainText("SATS")

  await page.keyboard.press("Escape")
  await page.reload()
  await addProduct.click()
  await expect(title).toHaveValue("Pocket relay draft")
  await expect(currency).toContainText("SATS")

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard changes" }).click()
  await expect(productDialog).not.toBeVisible()

  await addProduct.click()
  await expect(title).toHaveValue("")

  await page.keyboard.press("Escape")
  await seedCachedMerchantProduct(page)
  await page.reload()

  const editProduct = page.getByRole("button", { name: "Edit" })
  const editDialog = page.getByRole("dialog", { name: "Edit listing" })

  await expect(editProduct).toBeVisible()
  await editProduct.click()
  await expect(coordinateShipping).toBeChecked()
  await expect(shipping).toBeDisabled()
  await expect(price).toHaveValue("0.00000001")
  await title.fill("Unpublished edited title")
  await page.keyboard.press("Escape")
  await expect(editDialog).not.toBeVisible()

  await editProduct.click()
  await expect(title).toHaveValue("Unpublished edited title")
  await expect(price).toHaveValue("0.00000001")

  await page.keyboard.press("Escape")
  await page.reload()
  await editProduct.click()
  await expect(title).toHaveValue("Unpublished edited title")
  await expect(price).toHaveValue("0.00000001")

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Discard changes" }).click()
  await editProduct.click()
  await expect(title).toHaveValue("Published Pocket Relay")
})

test("market checkout country combobox supports search and selection @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await seedMarketCart(page)
  await page.goto(`${marketUrl}/checkout`)

  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()

  await page.getByRole("combobox", { name: /country/i }).click()
  await page.getByPlaceholder("Search countries...").fill("canada")
  await page.getByRole("option", { name: /CA Canada/i }).click()

  await expect(page.getByRole("combobox", { name: /country/i })).toContainText(
    "Canada (CA)"
  )
})

test("market authenticated initial checkout claims a guest draft @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await seedMarketCart(page)
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "conduit:checkout-shipping",
      JSON.stringify({
        ownerPubkey: null,
        updatedAt: Date.now(),
        value: {
          firstName: "Guest",
          street: "123 Guest Street",
          postalCode: "10001",
          city: "New York",
          country: "US",
        },
      })
    )
  })

  await page.goto(`${marketUrl}/checkout`)

  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible()
  await expect(page.getByLabel("First name")).toHaveValue("Guest")
  await expect(page.getByLabel("Street address")).toHaveValue(
    "123 Guest Street"
  )
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("conduit:checkout-shipping")
        if (!raw) return null
        return (JSON.parse(raw) as { ownerPubkey?: string | null }).ownerPubkey
      })
    )
    .toBe(TEST_BUYER_PUBKEY)
})

test("market guest initial checkout clears a signed draft @market", async ({
  page,
}) => {
  await seedMarketCart(page)
  await page.addInitScript((ownerPubkey) => {
    sessionStorage.setItem(
      "conduit:checkout-shipping",
      JSON.stringify({
        ownerPubkey,
        updatedAt: Date.now(),
        value: {
          firstName: "Private",
          street: "456 Hidden Street",
          postalCode: "10002",
          city: "New York",
          country: "US",
        },
      })
    )
  }, TEST_BUYER_PUBKEY)

  await page.goto(`${marketUrl}/checkout`)

  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()
  await expect(page.getByLabel("First name")).toHaveValue("")
  await expect(page.getByLabel("Street address")).toHaveValue("")
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("conduit:checkout-shipping"))
    )
    .toBeNull()
})

test("market initial checkout clears a foreign signed draft @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await seedMarketCart(page)
  await page.addInitScript((ownerPubkey) => {
    sessionStorage.setItem(
      "conduit:checkout-shipping",
      JSON.stringify({
        ownerPubkey,
        updatedAt: Date.now(),
        value: {
          firstName: "Private",
          street: "456 Hidden Street",
          postalCode: "10002",
          city: "New York",
          country: "US",
        },
      })
    )
  }, "c".repeat(64))

  await page.goto(`${marketUrl}/checkout`)

  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible()
  await expect(page.getByLabel("First name")).toHaveValue("")
  await expect(page.getByLabel("Street address")).toHaveValue("")
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("conduit:checkout-shipping"))
    )
    .toBeNull()
})

test("market checkout claims a guest draft when a signer connects @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY, { rememberAuth: false })
  await seedMarketCart(page)
  await page.goto(`${marketUrl}/checkout`)

  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()
  const firstName = page.getByLabel("First name")
  const lastName = page.getByLabel("Last name")
  const street = page.getByLabel("Street address")
  const postalCode = page.getByLabel("Postal/ZIP code")
  const city = page.getByLabel("City")
  await firstName.fill("Guest")
  await lastName.fill("Buyer")
  await street.fill("123 Guest Street")
  await postalCode.fill("10001")
  await city.fill("New York")

  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("conduit:checkout-shipping")
        if (!raw) return null
        const stored = JSON.parse(raw) as {
          ownerPubkey?: string | null
          updatedAt?: number
          value?: { street?: string }
        }
        return {
          ownerPubkey: stored.ownerPubkey,
          updatedAt: stored.updatedAt,
          street: stored.value?.street,
        }
      })
    )
    .toEqual({
      ownerPubkey: null,
      updatedAt: expect.any(Number),
      street: "123 Guest Street",
    })
  const guestDraft = await page.evaluate(() => {
    const raw = sessionStorage.getItem("conduit:checkout-shipping")
    if (!raw) return null
    const stored = JSON.parse(raw) as { updatedAt?: number }
    return stored.updatedAt
  })
  if (guestDraft === null)
    throw new Error("Guest checkout draft was not stored")

  await page
    .getByRole("button", { name: /^Connect$/ })
    .first()
    .click()
  await page
    .getByRole("button", { name: /Connect Extension \(NIP-07\)/i })
    .click()

  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible()
  await expect(firstName).toHaveValue("Guest")
  await expect(lastName).toHaveValue("Buyer")
  await expect(street).toHaveValue("123 Guest Street")
  await expect(postalCode).toHaveValue("10001")
  await expect(city).toHaveValue("New York")
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("conduit:checkout-shipping")
        if (!raw) return null
        const stored = JSON.parse(raw) as {
          ownerPubkey?: string | null
          updatedAt?: number
          value?: { street?: string }
        }
        return {
          ownerPubkey: stored.ownerPubkey,
          updatedAt: stored.updatedAt,
          street: stored.value?.street,
        }
      })
    )
    .toEqual({
      ownerPubkey: TEST_BUYER_PUBKEY,
      updatedAt: guestDraft,
      street: "123 Guest Street",
    })
})

test("market authenticated checkout draft survives reload and clears across identities @market", async ({
  page,
}) => {
  const secondBuyerPubkey = "c".repeat(64)
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await seedMarketCart(page)
  await page.goto(`${marketUrl}/checkout`)
  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible()

  const firstName = page.getByLabel("First name")
  const lastName = page.getByLabel("Last name")
  const street = page.getByLabel("Street address")
  const postalCode = page.getByLabel("Postal/ZIP code")
  const city = page.getByLabel("City")
  await firstName.fill("Alice")
  await lastName.fill("Example")
  await street.fill("123 Private Street")
  await postalCode.fill("10001")
  await city.fill("New York")

  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem("conduit:checkout-shipping")
        if (!raw) return null
        const stored = JSON.parse(raw) as {
          ownerPubkey?: string
          value?: { street?: string }
        }
        return {
          ownerPubkey: stored.ownerPubkey,
          street: stored.value?.street,
        }
      })
    )
    .toEqual({
      ownerPubkey: TEST_BUYER_PUBKEY,
      street: "123 Private Street",
    })

  await page.reload()
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("conduit:checkout-shipping"))
    )
    .not.toBeNull()
  await expect(firstName).toHaveValue("Alice")
  await expect(lastName).toHaveValue("Example")
  await expect(street).toHaveValue("123 Private Street")
  await expect(postalCode).toHaveValue("10001")
  await expect(city).toHaveValue("New York")

  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(street).toHaveValue("123 Private Street")

  await page.getByRole("button", { name: "Open account menu" }).click()
  await page.getByRole("menuitem", { name: "Disconnect" }).click()
  await expect(
    page.getByRole("button", { name: /^Connect$/ }).first()
  ).toBeVisible()
  await expect(firstName).toHaveValue("")
  await expect(street).toHaveValue("")
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("conduit:checkout-shipping"))
    )
    .toBeNull()

  await page.evaluate((nextPubkey) => {
    const signer = window.nostr
    if (!signer) throw new Error("Test signer unavailable")
    signer.getPublicKey = async () => nextPubkey
    signer.signEvent = async (event) => ({
      ...event,
      pubkey: nextPubkey,
      id: "2".repeat(64),
      sig: "3".repeat(128),
    })
  }, secondBuyerPubkey)
  await page
    .getByRole("button", { name: /^Connect$/ })
    .first()
    .click()
  await page
    .getByRole("button", { name: /Connect Extension \(NIP-07\)/i })
    .click()

  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible()
  await expect(firstName).toHaveValue("")
  await expect(street).toHaveValue("")
})

test("market checkout clears an identity draft after signer restoration fails @market", async ({
  page,
}) => {
  await seedStoredAuth(page, TEST_BUYER_PUBKEY)
  await installRejectingTestSigner(page)
  await seedMarketCart(page)
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )
    if (!descriptor?.get || !descriptor.set) return
    Object.defineProperty(HTMLInputElement.prototype, "value", {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value: string) {
        if (
          (this.id === "ship-first-name" || this.id === "ship-street") &&
          value
        ) {
          sessionStorage.setItem("conduit:test-private-draft-rendered", "true")
        }
        descriptor.set!.call(this, value)
      },
    })
  })
  await page.addInitScript((ownerPubkey) => {
    sessionStorage.setItem(
      "conduit:checkout-shipping",
      JSON.stringify({
        ownerPubkey,
        updatedAt: Date.now(),
        value: {
          firstName: "Private",
          street: "456 Hidden Street",
          postalCode: "10002",
          city: "New York",
          country: "US",
        },
      })
    )
  }, TEST_BUYER_PUBKEY)

  await page.goto(`${marketUrl}/checkout`)
  await expect(page.getByRole("heading", { name: "Shipping" })).toBeVisible()
  await expect(page.getByLabel("First name")).toHaveValue("")
  await expect(page.getByLabel("Street address")).toHaveValue("")
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("conduit:test-private-draft-rendered")
    )
  ).toBeNull()
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("conduit:checkout-shipping"))
    )
    .toBeNull()
})

test("market checkout clears an identity draft after cross-tab auth replacement @market", async ({
  page,
}) => {
  const replacementPubkey = "c".repeat(64)
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await seedMarketCart(page)
  await page.goto(`${marketUrl}/checkout`)
  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible()

  const street = page.getByLabel("Street address")
  await street.fill("789 Identity Street")
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("conduit:checkout-shipping"))
    )
    .not.toBeNull()

  await page.evaluate((nextPubkey) => {
    const oldValue = localStorage.getItem("conduit:auth")
    const newValue = JSON.stringify({
      version: 1,
      type: "nip07",
      userPubkey: nextPubkey,
    })
    localStorage.setItem("conduit:auth", newValue)
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "conduit:auth",
        oldValue,
        newValue,
        storageArea: localStorage,
      })
    )
  }, replacementPubkey)

  await expect(
    page.getByRole("button", { name: /^Connect$/ }).first()
  ).toBeVisible()
  await expect(street).toHaveValue("")
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("conduit:checkout-shipping"))
    )
    .toBeNull()
})

test("market wallets route renders portable and connected wallet groups @market", async ({
  page,
}) => {
  await installTestSigner(page, TEST_BUYER_PUBKEY)
  await page.goto(`${marketUrl}/wallet`)

  await expect(
    page.getByRole("heading", { name: "Wallets", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Portable", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Connected", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("No Portable Wallets on this device.", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("No Connected Wallets on this device.", { exact: true })
  ).toBeVisible()

  const connectWalletButton = page.getByRole("button", {
    name: "Connect wallet",
  })
  await connectWalletButton.click()
  await expect(
    page.getByRole("heading", { name: "Connect wallet", exact: true })
  ).toBeVisible()
  const nwcConnection = page.getByPlaceholder("nostr+walletconnect://...")
  await expect(nwcConnection).toBeVisible()
  await nwcConnection.fill("not-an-nwc-authorization")
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(connectWalletButton).toBeFocused()

  const displayCurrency = page.getByRole("combobox", {
    name: "Preferred currency",
  })
  const satsStandard = page.getByRole("switch", {
    name: "Sats the standard",
  })
  await displayCurrency.click()
  await page.getByRole("option", { name: "EUR" }).click()
  await satsStandard.click()
  await expect(displayCurrency).toContainText("EUR")
  await expect(satsStandard).toBeChecked()

  await page.reload()
  await expect(displayCurrency).toContainText("EUR")
  await expect(satsStandard).toBeChecked()
})

test("portable wallet restore keeps derivation advanced and device-only fields clear @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/wallet`)
  await page.getByRole("button", { name: "Add portable wallet" }).click()

  const dialog = page.getByRole("dialog", { name: "Add a Spark wallet" })
  await expect(dialog).toBeVisible()
  const networkContext = dialog.getByText(/^Spark wallet · /)
  await expect(networkContext).toBeVisible()
  const networkLabel = await networkContext.textContent()

  await dialog.getByRole("tab", { name: "Restore" }).click()
  await expect(dialog.getByLabel("Recovery phrase")).toBeVisible()
  const advancedSettings = dialog.locator("details")
  await expect(advancedSettings).not.toHaveAttribute("open", "")
  await advancedSettings.locator("summary").click()
  await expect(dialog.getByLabel("Spark account number")).toHaveValue(
    networkLabel?.endsWith("Regtest") ? "0" : "1"
  )
  await expect(dialog.getByLabel("Wallet nickname (optional)")).toBeVisible()
  await expect(dialog.getByLabel("Local wallet password")).toBeVisible()
  await expect(
    dialog.getByText("Use this nickname to identify the wallet in Conduit.", {
      exact: false,
    })
  ).toBeVisible()
  await expect(
    dialog.getByText("It is not the source wallet's password", {
      exact: false,
    })
  ).toBeVisible()
})

test("market wallets remain available without a Nostr signer @market", async ({
  page,
}) => {
  await page.goto(marketUrl)

  const walletsNavigation = page.getByRole("button", {
    name: "Wallets",
    exact: true,
  })
  await expect(walletsNavigation).toBeVisible()
  await walletsNavigation.click()

  await expect(page).toHaveURL(`${marketUrl}/wallet`)
  await expect(page).toHaveTitle("Wallets | Conduit Market")
  await expect(
    page.getByRole("heading", { name: "Wallets", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Connect", exact: true })
  ).toBeVisible()
})

test("wallet dialog dismissal clears device-local sensitive state @market", async ({
  page,
}) => {
  await page.goto(`${marketUrl}/wallet`)
  await expect(
    page.getByRole("heading", { name: "Wallets", exact: true })
  ).toBeVisible()
  await seedPortableWalletDescriptor(page)
  await page.reload()

  await expect(page.getByText("QA Portable", { exact: true })).toBeVisible()

  const unlockButton = page.getByRole("button", {
    name: "Unlock",
    exact: true,
  })
  await unlockButton.click()
  const unlockDialog = page.getByRole("dialog", {
    name: "Unlock QA Portable",
  })
  const unlockPassword = unlockDialog.getByLabel("Wallet password")
  await unlockPassword.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Expected the wallet password control to be an input.")
    }
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set
    if (!setValue) throw new Error("The input value setter is unavailable.")
    setValue.call(element, crypto.randomUUID())
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await page.keyboard.press("Escape")
  await expect(unlockDialog).not.toBeVisible()
  await expect(unlockButton).toBeFocused()

  await unlockButton.click()
  expect(
    await unlockPassword.evaluate(
      (element) =>
        element instanceof HTMLInputElement && element.value.length === 0
    )
  ).toBe(true)
  await unlockDialog.getByRole("button", { name: "Cancel" }).click()

  await page
    .getByRole("button", { name: "Remove from this device", exact: true })
    .click()
  const removeDialog = page.getByRole("alertdialog", {
    name: "Remove from this device?",
  })
  const recoveryConfirmation = removeDialog.getByRole("switch", {
    name: /I have the recovery (phrase and Spark account number|details required to restore this Portable Wallet)/,
  })
  await recoveryConfirmation.click()
  await expect(recoveryConfirmation).toBeChecked()
  await page.keyboard.press("Escape")
  await expect(removeDialog).not.toBeVisible()

  await page
    .getByRole("button", { name: "Remove from this device", exact: true })
    .click()
  await expect(recoveryConfirmation).not.toBeChecked()
  await expect(
    removeDialog.getByRole("button", {
      name: "Remove from this device",
      exact: true,
    })
  ).toBeDisabled()
})

test("market shopper preferences remove legacy plaintext and render the complete form @market", async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  const secretKey = generateSecretKey()
  const buyerPubkey = getPublicKey(secretKey)
  await installStoredRelay(page)
  await installTestSigner(page, buyerPubkey, { nip44: false, secretKey })
  await page.addInitScript((buyerPubkey) => {
    localStorage.setItem(
      `conduit:market-shopper-presets:v1:${buyerPubkey}`,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        value: {
          shippingCountry: "DE",
        },
      })
    )
  }, buyerPubkey)

  await page.goto(`${marketUrl}/preferences`)
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible()
  const preferencesStatus = page
    .locator("header")
    .filter({ has: page.getByRole("heading", { name: "Preferences" }) })
    .getByRole("status")
  await expect(preferencesStatus).toContainText(
    /Encrypted on relays|Relay ready/,
    { timeout: 20_000 }
  )
  const recipientName = page.getByLabel("Recipient name")
  const addressLine1 = page.getByLabel("Address line 1")
  await expect(recipientName).toBeVisible()
  await expect(addressLine1).toBeVisible()
  const addressPositionBefore = await addressLine1.boundingBox()
  await expect(
    recipientName.locator("..").getByText("Required", { exact: true })
  ).toBeVisible()
  await recipientName.fill("Ada Lovelace")
  await expect(
    recipientName.locator("..").getByText("Required", { exact: true })
  ).not.toBeVisible()
  const addressPositionAfter = await addressLine1.boundingBox()
  expect(addressPositionAfter?.y).toBe(addressPositionBefore?.y)
  await expect(page.getByLabel("Postal / ZIP code")).toBeVisible()
  const encryptionPassword = page.getByLabel("Encryption password")
  const confirmPassword = page.getByLabel("Confirm password")
  const unlockPreference = page.getByLabel("Unlock preference")
  await expect(encryptionPassword).toBeVisible()
  await expect(confirmPassword).toBeVisible()
  await expect(unlockPreference).toBeVisible()
  const encryptionPasswordPosition = await encryptionPassword.boundingBox()
  const confirmPasswordPosition = await confirmPassword.boundingBox()
  expect(confirmPasswordPosition?.y).toBe(encryptionPasswordPosition?.y)
  await expect(encryptionPassword).toHaveAttribute("maxlength", "1024")
  await expect(confirmPassword).toHaveAttribute("maxlength", "1024")
  const unlockPreferencePositionBefore = await unlockPreference.evaluate(
    (element) => element.getBoundingClientRect().top + window.scrollY
  )
  await encryptionPassword.fill("short")
  await expect(
    encryptionPassword
      .locator("..")
      .getByText("Password must contain 16 or more characters.")
  ).toBeVisible()
  await encryptionPassword.fill("long password text")
  await expect(
    encryptionPassword
      .locator("..")
      .getByText("Password must contain at least one number.")
  ).toBeVisible()
  await encryptionPassword.fill("secure password 7")
  const unlockPreferencePositionAfter = await unlockPreference.evaluate(
    (element) => element.getBoundingClientRect().top + window.scrollY
  )
  expect(unlockPreferencePositionAfter).toBe(unlockPreferencePositionBefore)
  await expect(
    encryptionPassword
      .locator("..")
      .getByText("Password must contain 16 or more characters.")
  ).not.toBeVisible()
  await confirmPassword.fill("different")
  await expect(
    confirmPassword.locator("..").getByText("Password confirmation must match.")
  ).toBeVisible()
  await confirmPassword.fill("secure password 7")
  await expect(
    confirmPassword.locator("..").getByText("Password confirmation must match.")
  ).not.toBeVisible()
  await expect(page.getByText(/save requirements remaining/)).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Save preferences" })
  ).toBeDisabled()

  await expect
    .poll(() =>
      page.evaluate((buyerPubkey) => {
        return localStorage.getItem(
          `conduit:market-shopper-presets:v1:${buyerPubkey}`
        )
      }, buyerPubkey)
    )
    .toBeNull()

  await addressLine1.fill("12 St James Square")
  await page.getByLabel("City").fill("London")
  await page.getByLabel("Postal / ZIP code").fill("SW1Y 4LB")
  await expect(page.getByText("Ready to save", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Save preferences" }).click()
  await expect(
    page.getByText("Preset encrypted and saved on your relays.")
  ).toBeVisible({ timeout: 40_000 })
  await expect(
    preferencesStatus.filter({ hasText: "Encrypted on relays" })
  ).toBeVisible()

  await recipientName.fill("Sensitive unsaved recipient")
  await addressLine1.fill("Sensitive unsaved address")
  await page.getByRole("button", { name: "Lock", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Unlock shipping preset" })
  ).toBeVisible()
  const unlockPassword = page.getByLabel("Password", { exact: true })
  await expect(unlockPassword).toHaveAttribute("maxlength", "1024")
  await page.getByRole("button", { name: "Replace forgotten preset" }).click()
  await expect(recipientName).toHaveValue("")
  await expect(addressLine1).toHaveValue("")
  await expect(page.getByText("Sensitive unsaved recipient")).toHaveCount(0)
  await expect(page.getByText("Sensitive unsaved address")).toHaveCount(0)
})

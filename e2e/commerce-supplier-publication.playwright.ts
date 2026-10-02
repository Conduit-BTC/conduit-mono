import { expect, test, type Locator, type Page } from "@playwright/test"
import { nip19 } from "nostr-tools"
import { verifyEvent, type Event } from "nostr-tools/pure"
import {
  publishTestRelayEvents,
  readTestRelayEvents,
  TEST_RELAY_URL,
} from "./helpers/auth"
import {
  createHermeticCommerceNetworkPolicy,
  installHermeticCommerceNetwork,
} from "./helpers/hermetic-network"
import { createHermeticLnurlFixture } from "./helpers/hermetic-lnurl"
import { installPersistenceReloadBarrier } from "./helpers/persistence-reload-barrier"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  signRuntimeTestEvent,
  type RuntimeSignerIdentity,
} from "./helpers/real-nip07-signer"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const imageUrl = "https://cdn.conduit.market/supplier-publication-smoke.svg"
const merchantName = "Supplier Publication Merchant"
const supplierName = "Supplier Publication Supplier"
const merchantLud16 = "supplier-publication-merchant@wallet.conduit.market"
const supplierLud16 = "supplier-publication-supplier@wallet.conduit.market"
const productTitle = "Local supplier allocation download"
const productSummary =
  "Synthetic digital listing for isolated commerce verification."
// Public relay hints are signed terms, not transport targets for this smoke.
// The network policy blocks both; only the configured loopback relay is used.
const merchantProfileRelay = "wss://relay.conduit.market/"
const supplierProfileRelay = "wss://relay.damus.io/"
const networkOptions = {
  appUrls: [marketUrl, merchantUrl],
  relayUrl: TEST_RELAY_URL,
  imageUrl,
}

test.use({ screenshot: "off", trace: "off", video: "off" })

async function seedIdentity(
  identity: RuntimeSignerIdentity,
  name: string,
  lud16?: string
): Promise<void> {
  // Fresh identities and one revision per kind avoid same-second replacement
  // ambiguity. The product itself must be authored only by the mounted form.
  const createdAt = Math.floor(Date.now() / 1_000)
  await publishTestRelayEvents([
    signRuntimeTestEvent(identity, {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: JSON.stringify({ name, ...(lud16 ? { lud16 } : {}) }),
    }),
    signRuntimeTestEvent(identity, {
      kind: 10_002,
      created_at: createdAt,
      tags: [["r", TEST_RELAY_URL]],
      content: "",
    }),
    signRuntimeTestEvent(identity, {
      kind: 10_050,
      created_at: createdAt,
      tags: [["relay", TEST_RELAY_URL]],
      content: "",
    }),
  ])
}

async function expectSupplierDraft(
  dialog: Locator,
  supplierNpub: string
): Promise<void> {
  await expect(dialog.getByLabel("Title")).toHaveValue(productTitle)
  await expect(dialog.getByLabel("Summary")).toHaveValue(productSummary)
  await expect(dialog.getByLabel("Price", { exact: true })).toHaveValue("21")
  await expect(dialog.getByLabel("Stock quantity")).toHaveValue("3")
  await expect(dialog.locator("#product-currency")).toContainText("SATS")
  await expect(dialog.locator("#product-fulfillment")).toContainText("Digital")
  await expect(dialog.getByLabel("Primary image URL")).toHaveValue(imageUrl)
  await expect(
    dialog.getByRole("checkbox", {
      name: "Share revenue with suppliers",
      exact: true,
    })
  ).toBeChecked()
  await expect(
    dialog.getByLabel("Merchant weight", { exact: true })
  ).toHaveCount(0)
  if (!(await dialog.getByLabel("Your profile relay hint").isVisible())) {
    await dialog
      .getByText("Advanced profile discovery", { exact: true })
      .click()
  }
  await expect(dialog.getByLabel("Your profile relay hint")).toHaveValue(
    merchantProfileRelay
  )
  // Keep generated identity values out of assertion diagnostics.
  await expect
    .poll(
      async () =>
        (await dialog.getByLabel("Supplier 1 npub").inputValue()) ===
        supplierNpub
    )
    .toBe(true)
  await expect(dialog.getByLabel("Supplier 1 profile relay hint")).toHaveValue(
    supplierProfileRelay
  )
  await expect(
    dialog.getByLabel("Supplier 1 share (%)", { exact: true })
  ).toHaveValue("25")
  await expect(
    dialog.getByText("Your share: 75%", { exact: true })
  ).toBeVisible()
  await expect(
    dialog.getByRole("checkbox", { name: /Enable public zaps for purchases/ })
  ).not.toBeChecked()
  for (const tag of ["commerce", "supplier", "hermetic"]) {
    await expect(
      dialog.getByRole("button", { name: `Remove ${tag} tag` })
    ).toBeVisible()
  }
}

type AllocationRecipient = {
  pubkey: string
  relayHint: string
  weight: number
  role: "merchant" | "supplier"
}

async function readMarketConsumption(
  page: Page,
  expected: {
    coordinate: string
    event: Event
    recipients: AllocationRecipient[]
  }
) {
  // Observe records populated by the real Market route. Never seed its cache,
  // cart, draft, or checkout state, or import an application service to add it.
  return page.evaluate(async (expected) => {
    type CachedListing = {
      id?: string
      pubkey?: string
      eventId?: string
      eventCreatedAt?: number
      supplierAllocation?: {
        state?: string
        issues?: unknown[]
        recipients?: AllocationRecipient[]
        revisionEventId?: string
        revisionCreatedAt?: number
        revisionEvent?: Event
      }
    }
    type CartRecord = {
      lines?: Array<{
        item?: {
          productId?: string
          merchantPubkey?: string
          productEventId?: string
          productUpdatedAt?: number
          format?: string
          quantity?: number
        }
      }>
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("conduit")
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(new Error("Market observation database unavailable."))
      request.onupgradeneeded = () => request.transaction?.abort()
    })
    try {
      const read = <T>(store: string, key: string) =>
        new Promise<T | undefined>((resolve, reject) => {
          const request = database
            .transaction(store, "readonly")
            .objectStore(store)
            .get(key)
          request.onsuccess = () => resolve(request.result as T | undefined)
          request.onerror = () =>
            reject(new Error("Market observation record unavailable."))
        })
      const [product, cart, orderCount] = await Promise.all([
        read<CachedListing>("products", expected.coordinate),
        read<CartRecord>("shoppingCarts", "market"),
        new Promise<number>((resolve, reject) => {
          const request = database
            .transaction("orders", "readonly")
            .objectStore("orders")
            .count()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () =>
            reject(new Error("Market order count unavailable."))
        }),
      ])
      const allocation = product?.supplierAllocation
      const revision = allocation?.revisionEvent
      const item = cart?.lines?.[0]?.item
      // Only aggregate booleans cross this observation boundary. Exact signed
      // bytes remain in memory, absent from logs, attachments, and snapshots.
      return {
        selectedRevision:
          product?.id === expected.coordinate &&
          product.pubkey === expected.event.pubkey &&
          product.eventId === expected.event.id &&
          product.eventCreatedAt === expected.event.created_at,
        signedTerms:
          allocation?.state === "valid" &&
          allocation.issues?.length === 0 &&
          allocation.revisionEventId === expected.event.id &&
          allocation.revisionCreatedAt === expected.event.created_at &&
          revision?.id === expected.event.id &&
          revision.pubkey === expected.event.pubkey &&
          revision.created_at === expected.event.created_at &&
          revision.kind === expected.event.kind &&
          revision.content === expected.event.content &&
          revision.sig === expected.event.sig &&
          JSON.stringify(revision.tags) === JSON.stringify(expected.event.tags),
        allocation:
          allocation?.recipients?.length === expected.recipients.length &&
          expected.recipients.every((recipient, index) => {
            const observed = allocation?.recipients?.[index]
            return (
              observed?.pubkey === recipient.pubkey &&
              observed.relayHint === recipient.relayHint &&
              observed.weight === recipient.weight &&
              observed.role === recipient.role
            )
          }),
        cartRevision:
          cart?.lines?.length === 1 &&
          item?.productId === expected.coordinate &&
          item.merchantPubkey === expected.event.pubkey &&
          item.productEventId === expected.event.id &&
          item.productUpdatedAt === expected.event.created_at * 1_000 &&
          item.format === "digital" &&
          item.quantity === 1,
        noOrderCreated: orderCount === 0,
      }
    } finally {
      database.close()
    }
  }, expected)
}

test("supplier percentages and readiness gate publish exact signed terms consumed by Market checkout @commerce", async ({
  browser,
}) => {
  test.setTimeout(120_000)
  // Commerce configuration also disables Playwright's automatic failure DOM
  // snapshot; generated identities and signed terms must not become artifacts.
  createHermeticCommerceNetworkPolicy(networkOptions)
  const merchant = createRuntimeSignerIdentity()
  const buyer = createRuntimeSignerIdentity()
  const supplier = createRuntimeSignerIdentity()
  const lnurl = createHermeticLnurlFixture({
    recipients: [{ lud16: merchantLud16 }, { lud16: supplierLud16 }],
    nowSeconds: () => Math.floor(Date.now() / 1_000),
  })
  let supplierEndpointReady = false
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = []
  const beginNetworkTeardown = new Map<(typeof contexts)[number], () => void>()
  const reloadBarriers: ReturnType<typeof installPersistenceReloadBarrier>[] =
    []
  let stage = "isolated identity setup"
  try {
    await seedIdentity(merchant, merchantName, merchantLud16)
    await seedIdentity(buyer, "Supplier Publication Buyer")
    await seedIdentity(supplier, supplierName, supplierLud16)
    const merchantContext = await browser.newContext({
      serviceWorkers: "block",
    })
    contexts.push(merchantContext)
    await merchantContext.grantPermissions(["local-network-access"], {
      origin: merchantUrl,
    })
    beginNetworkTeardown.set(
      merchantContext,
      await installHermeticCommerceNetwork(merchantContext, {
        ...networkOptions,
        lnurl: async (request) => {
          if (
            !supplierEndpointReady &&
            request.url ===
              "https://wallet.conduit.market/.well-known/lnurlp/supplier-publication-supplier"
          ) {
            return {
              status: 503,
              contentType: "application/json",
              headers: {
                "access-control-allow-origin": "*",
                "cache-control": "no-store",
              },
              body: JSON.stringify({
                status: "ERROR",
                reason: "Fixture offline",
              }),
            }
          }
          return lnurl.respond(request)
        },
      })
    )
    const merchantPage = await merchantContext.newPage()
    const merchantReload = installPersistenceReloadBarrier(
      merchantPage,
      merchantUrl
    )
    reloadBarriers.push(merchantReload)
    await installRealTestSigner(merchantPage, merchant, TEST_RELAY_URL)
    stage = "isolated profile fixture readback"
    expect(
      (
        await readTestRelayEvents({
          kinds: [0],
          authors: [merchant.pubkey, supplier.pubkey],
        })
      ).length
    ).toBe(2)
    stage = "mounted supplier draft entry"
    await merchantPage.goto(`${merchantUrl}/products`)
    await expect(
      merchantPage.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible()
    await merchantPage
      .getByRole("button", { name: "Add product" })
      .first()
      .click()
    const dialog = merchantPage.getByRole("dialog", { name: "Add product" })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel("Title").fill(productTitle)
    await dialog.getByLabel("Summary").fill(productSummary)
    await dialog.getByLabel("Price", { exact: true }).fill("21")
    await dialog.getByLabel("Stock quantity").fill("3")
    await dialog.locator("#product-currency").click()
    await merchantPage
      .getByRole("option", { name: "SATS", exact: true })
      .click()
    await dialog.locator("#product-fulfillment").click()
    await merchantPage
      .getByRole("option", { name: "Digital", exact: true })
      .click()
    await dialog
      .getByRole("button", { name: "Add by URL", exact: true })
      .click()
    await dialog.getByLabel("Primary image URL").fill(imageUrl)
    await dialog
      .getByRole("checkbox", { name: /Enable public zaps for purchases/ })
      .uncheck()
    const tags = dialog.getByRole("combobox", { name: "Tags" })
    for (const tag of ["commerce", "supplier", "hermetic"]) {
      await tags.fill(tag)
      await tags.press("Enter")
    }
    await dialog
      .getByRole("checkbox", {
        name: "Share revenue with suppliers",
        exact: true,
      })
      .check()
    await dialog
      .getByRole("button", { name: "Add supplier", exact: true })
      .click()
    const supplierNpub = nip19.npubEncode(supplier.pubkey)
    await dialog.getByLabel("Supplier 1 npub").fill(supplierNpub)
    const supplierShare = dialog.getByLabel("Supplier 1 share (%)", {
      exact: true,
    })
    await expect(supplierShare).toHaveValue("25")
    await expect(
      dialog.getByText("Your share: 75%", { exact: true })
    ).toBeVisible()
    await expect(dialog.getByLabel("Your profile relay hint")).toBeHidden()
    await expect(
      dialog.getByLabel("Supplier 1 profile relay hint")
    ).toBeHidden()
    await expect(dialog.getByLabel("Your profile relay hint")).toHaveValue("")
    await expect(
      dialog.getByLabel("Supplier 1 profile relay hint")
    ).toHaveValue("")
    const publish = dialog.getByRole("button", {
      name: "Publish product",
      exact: true,
    })
    stage = "readiness blocks publication without manual relay fields"
    await expect(
      dialog.getByText(
        "Their payment service could not be reached or has no usable payment range. Retry or ask them to check their Lightning address.",
        { exact: true }
      )
    ).toBeVisible({ timeout: 30_000 })
    await expect(publish).toBeDisabled()
    expect(lnurl.snapshot().invoicesIssued).toBe(0)
    supplierEndpointReady = true
    await dialog
      .getByRole("button", { name: "Check setup again", exact: true })
      .click()
    await expect(
      dialog.getByText(
        `${supplierName} · Payment and messaging setup checked.`,
        {
          exact: true,
        }
      )
    ).toBeVisible({ timeout: 30_000 })
    await expect(publish).toBeEnabled()

    stage = "percentage validation and automatic merchant remainder"
    await supplierShare.fill("100")
    await expect(supplierShare).toHaveAttribute("aria-invalid", "true")
    await expect(publish).toBeDisabled()
    await supplierShare.fill("40")
    await expect(
      dialog.getByText("Your share: 60%", { exact: true })
    ).toBeVisible()
    await expect(supplierShare).toHaveAttribute("aria-invalid", "false")
    await expect(publish).toBeEnabled()
    await supplierShare.fill("25")
    await expect(
      dialog.getByText("Your share: 75%", { exact: true })
    ).toBeVisible()
    stage = "responsive supplier authoring at a narrow viewport"
    const desktopViewport = merchantPage.viewportSize()
    await merchantPage.setViewportSize({ width: 390, height: 844 })
    const supplierIdentity = dialog.getByLabel("Supplier 1 npub")
    stage = "responsive supplier identity visibility"
    await supplierIdentity.scrollIntoViewIfNeeded()
    await expect(supplierIdentity).toBeVisible()
    await expect(supplierShare).toBeVisible()
    stage = "responsive supplier geometry"
    await expect
      .poll(async () => {
        const split = dialog.getByRole("group", {
          name: "Revenue split",
          exact: true,
        })
        return split.evaluate((element) => {
          const viewportWidth = document.documentElement.clientWidth
          const bounds = element.getBoundingClientRect()
          return {
            splitFits: element.scrollWidth <= element.clientWidth + 1,
            pageFits: document.documentElement.scrollWidth <= viewportWidth + 1,
            withinViewport:
              bounds.left >= 0 && bounds.right <= viewportWidth + 1,
            inputsFit: Array.from(element.querySelectorAll("input"))
              .filter((input) => input.offsetWidth > 0)
              .every((input) => {
                const inputBounds = input.getBoundingClientRect()
                return (
                  inputBounds.left >= 0 &&
                  inputBounds.right <= viewportWidth + 1
                )
              }),
          }
        })
      })
      .toEqual({
        splitFits: true,
        pageFits: true,
        withinViewport: true,
        inputsFit: true,
      })
    await merchantPage.setViewportSize(
      desktopViewport ?? { width: 1280, height: 720 }
    )
    stage = "advanced profile hints and saved supplier draft"
    await dialog
      .getByText("Advanced profile discovery", { exact: true })
      .click()
    await dialog
      .getByLabel("Your profile relay hint")
      .fill(merchantProfileRelay)
    await dialog
      .getByLabel("Supplier 1 profile relay hint")
      .fill(supplierProfileRelay)
    await expectSupplierDraft(dialog, supplierNpub)

    stage = "draft close, reload, and resume"
    await dialog
      .locator("form")
      .getByRole("button", { name: "Close", exact: true })
      .click()
    await expect(dialog).toBeHidden()
    const resume = merchantPage.getByRole("button", {
      name: "Resume product draft",
      exact: true,
    })
    await expect(resume).toBeVisible()
    await merchantReload.wait()
    await merchantPage.reload()
    await expect(resume).toBeVisible()
    await expect(dialog).toBeHidden()
    await resume.click()
    await expect(dialog).toBeVisible()
    await expectSupplierDraft(dialog, supplierNpub)
    expect(
      (
        await readTestRelayEvents({
          kinds: [30_402],
          authors: [merchant.pubkey],
        })
      ).length
    ).toBe(0)
    stage = "fresh pre-sign readiness rejects a newly unavailable endpoint"
    await expect(publish).toBeEnabled({ timeout: 30_000 })
    supplierEndpointReady = false
    await publish.click()
    await expect(
      dialog.getByText(
        "A revenue recipient's payment or messaging setup could not be verified. Check the Revenue split section before publishing.",
        { exact: true }
      )
    ).toBeVisible({ timeout: 30_000 })
    expect(
      (
        await readTestRelayEvents({
          kinds: [30_402],
          authors: [merchant.pubkey],
        })
      ).length
    ).toBe(0)
    expect(lnurl.snapshot().invoicesIssued).toBe(0)
    supplierEndpointReady = true
    stage = "mounted listing publication"
    await expect(publish).toBeEnabled()
    await publish.click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })

    stage = "signed relay readback"
    let emitted: Event | undefined
    await expect
      .poll(
        async () => {
          const events = await readTestRelayEvents({
            kinds: [30_402],
            authors: [merchant.pubkey],
          })
          emitted = events.length === 1 ? events[0] : undefined
          return events.length
        },
        { timeout: 30_000 }
      )
      .toBe(1)
    if (!emitted)
      throw new Error(
        "Published listing was not observed on the isolated relay."
      )
    expect(verifyEvent(emitted)).toBe(true)
    expect(emitted.pubkey === merchant.pubkey && emitted.kind === 30_402).toBe(
      true
    )
    const dTags = emitted.tags.filter(([name]) => name === "d")
    expect(
      dTags.length === 1 && dTags[0]?.length === 2 && !!dTags[0]?.[1]
    ).toBe(true)
    const coordinate = `30402:${merchant.pubkey}:${dTags[0]![1]}`
    const expectedTags = [
      ["conduit_supplier_allocation", "1"],
      ["zap", merchant.pubkey, merchantProfileRelay, "3"],
      ["zap", supplier.pubkey, supplierProfileRelay, "1"],
    ]
    expect(
      JSON.stringify(
        emitted.tags.filter(
          ([name]) => name === "conduit_supplier_allocation" || name === "zap"
        )
      ) === JSON.stringify(expectedTags)
    ).toBe(true)
    expect(
      emitted.tags.some(
        (tag) =>
          JSON.stringify(tag) === JSON.stringify(["type", "simple", "digital"])
      )
    ).toBe(true)

    // A separate origin and fresh context force Market to discover the actual
    // emitted event. No Merchant cache, signed listing fixture, or cart seed is shared.
    stage = "Market listing discovery and cart entry"
    const buyerContext = await browser.newContext({ serviceWorkers: "block" })
    contexts.push(buyerContext)
    await buyerContext.grantPermissions(["local-network-access"], {
      origin: marketUrl,
    })
    beginNetworkTeardown.set(
      buyerContext,
      await installHermeticCommerceNetwork(buyerContext, networkOptions)
    )
    const buyerPage = await buyerContext.newPage()
    const buyerReload = installPersistenceReloadBarrier(buyerPage, marketUrl)
    reloadBarriers.push(buyerReload)
    await installRealTestSigner(buyerPage, buyer, TEST_RELAY_URL)
    await buyerPage.goto(`${marketUrl}/${nip19.npubEncode(merchant.pubkey)}`)
    await expect(
      buyerPage.getByRole("heading", { name: merchantName, exact: true })
    ).toBeVisible({ timeout: 30_000 })
    const product = buyerPage
      .getByRole("listitem")
      .filter({ hasText: productTitle })
    await expect(product).toBeVisible({ timeout: 30_000 })
    const add = product.getByRole("button", { name: "Add", exact: true })
    await expect(add).toBeEnabled({ timeout: 30_000 })
    await add.click()
    const cart = buyerPage.getByRole("region", {
      name: "Cart inventory",
      exact: true,
    })
    await cart
      .getByRole("link", { name: "Continue to checkout", exact: true })
      .click()
    const checkoutHeading = buyerPage.getByRole("heading", {
      name: "Checkout",
      exact: true,
    })
    await expect(checkoutHeading).toBeVisible({ timeout: 30_000 })
    const sendOrder = buyerPage.getByRole("button", {
      name: "Send order",
      exact: true,
    })
    await expect(sendOrder).toBeEnabled({ timeout: 30_000 })
    const expected = {
      coordinate,
      event: emitted,
      recipients: [
        {
          pubkey: merchant.pubkey,
          relayHint: merchantProfileRelay,
          weight: 3,
          role: "merchant" as const,
        },
        {
          pubkey: supplier.pubkey,
          relayHint: supplierProfileRelay,
          weight: 1,
          role: "supplier" as const,
        },
      ],
    }
    const consumed = {
      selectedRevision: true,
      signedTerms: true,
      allocation: true,
      cartRevision: true,
      noOrderCreated: true,
    }
    stage = "exact Market checkout consumption"
    await expect
      .poll(() => readMarketConsumption(buyerPage, expected), {
        timeout: 30_000,
      })
      .toEqual(consumed)
    stage = "Market checkout reload"
    await Promise.all([merchantReload.wait(), buyerReload.wait()])
    await buyerPage.reload()
    await expect(checkoutHeading).toBeVisible({ timeout: 30_000 })
    await expect(sendOrder).toBeEnabled({ timeout: 30_000 })
    await expect
      .poll(() => readMarketConsumption(buyerPage, expected), {
        timeout: 30_000,
      })
      .toEqual(consumed)
    // Deliberately stop before Send order, router preparation, invoices, or any
    // wallet action. This proves terms consumption, never supplier settlement.
    expect(lnurl.snapshot().metadataRequests).toBeGreaterThan(0)
    expect(lnurl.snapshot().invoicesIssued).toBe(0)
  } catch {
    // Navigation/fill errors can quote generated npubs even with tracing off.
    // Retain a fixed stage only, never raw browser, relay, or signer errors.
    throw new Error(`Supplier publication smoke failed during ${stage}.`)
  } finally {
    for (const barrier of reloadBarriers) barrier.dispose()
    for (const beginTeardown of beginNetworkTeardown.values()) beginTeardown()
    await Promise.allSettled(contexts.map((context) => context.close()))
    for (const identity of [merchant, buyer, supplier]) {
      disposeRuntimeSignerIdentity(identity)
    }
  }
})

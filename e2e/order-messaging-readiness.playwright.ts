import { expect, test } from "@playwright/test"
import { nip19 } from "nostr-tools"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  parseCanonicalRuntimePrivateRumor,
  readAuthenticatedGiftWraps,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"

test.use({ trace: "off", screenshot: "off", video: "off" })

test("signed-in checkout repairs messaging before committing while retaining its draft @commerce", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(30_000)
  const buyer = createRuntimeSignerIdentity()
  const merchant = createRuntimeSignerIdentity()
  const now = Math.floor(Date.now() / 1000)
  const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
  const title = `Inbox readiness ${crypto.randomUUID()}`
  const image = "https://cdn.conduit.market/inbox-readiness-smoke.svg"
  try {
    await page.route(image, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"/>',
      })
    )
    await publishTestRelayEvents([
      ...[buyer, merchant].flatMap((identity) => [
        signRuntimeTestEvent(identity, {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name: identity === buyer ? "Readiness Buyer" : "Readiness Merchant",
          }),
        }),
        signRuntimeTestEvent(identity, {
          kind: 10002,
          created_at: now,
          tags: [["r", TEST_RELAY_URL]],
          content: "",
        }),
      ]),
      signRuntimeTestEvent(merchant, {
        kind: 10050,
        created_at: now,
        tags: [["relay", TEST_RELAY_URL]],
        content: "",
      }),
      signRuntimeTestEvent(merchant, {
        kind: 30402,
        created_at: now,
        tags: [
          ["d", "readiness"],
          ["title", title],
          ["price", "21", "SATS"],
          ["type", "simple", "digital"],
          ["stock", "3"],
          ["image", image],
          ["t", "commerce"],
          ["t", "smoke"],
          ["t", "hermetic"],
        ],
        content: "Synthetic readiness fixture",
      }),
    ])
    await installRealTestSigner(page, buyer, TEST_RELAY_URL)
    await page.goto(`${marketUrl}/${nip19.npubEncode(merchant.pubkey)}`)
    const product = page.getByRole("listitem").filter({ hasText: title })
    await expect(product).toBeVisible()
    await product.getByRole("button", { name: /^Add .+ to cart$/ }).click()
    await page
      .getByRole("region", { name: "Cart inventory" })
      .getByRole("link", { name: "Continue to checkout" })
      .click()
    await expect(
      page.getByText("Set up order messaging", { exact: true })
    ).toBeVisible()
    const note = page.getByLabel("Order note (optional)")
    await note.fill("Keep this synthetic draft during setup")
    await page.getByRole("button", { name: "Send order", exact: true }).click()
    await expect(
      page.getByRole("alert").filter({ hasText: "No private inbox was found" })
    ).toBeVisible()
    await expect(page).toHaveURL(/\/checkout/)
    expect(
      (await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)).length
    ).toBe(0)
    const pendingCounts = await page.evaluate(async (root) => {
      const { db } = await import(/* @vite-ignore */ `${root}/db/index.ts`)
      return {
        orders: await db.orderLifecycles.count(),
        payments: await db.paymentAttempts.count(),
      }
    }, `/@fs${process.cwd()}/packages/core/src`)
    expect(pendingCounts).toEqual({ orders: 0, payments: 0 })

    const popupPromise = context.waitForEvent("page")
    await page
      .getByRole("link", {
        name: "Open Network settings in a new tab",
        exact: true,
      })
      .click()
    const setup = await popupPromise
    await expect(setup).toHaveURL(/\/network/)
    await page.bringToFront()
    await expect(note).toHaveValue("Keep this synthetic draft during setup")
    await expect(page).toHaveURL(/\/checkout/)

    // The signed declaration is published by the runner-owned signer. This
    // verifies discovery and return behavior, not an installed signer or device.
    await publishTestRelayEvents([
      signRuntimeTestEvent(buyer, {
        kind: 10050,
        created_at: now + 1,
        tags: [["relay", TEST_RELAY_URL]],
        content: "",
      }),
    ])
    await setup.close()
    await page.bringToFront()
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe("visible")
    await page.getByRole("button", { name: "Check again", exact: true }).click()
    await expect(
      page.getByText("Set up order messaging", { exact: true })
    ).toHaveCount(0)
    await expect(note).toHaveValue("Keep this synthetic draft during setup")
    await page.getByRole("button", { name: "Send order", exact: true }).click()
    await expect(page).toHaveURL(/\/orders\?order=/)
    const orderId = new URL(page.url()).searchParams.get("order")
    await expect
      .poll(async () => {
        const wraps = await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)
        return new Set(
          wraps.flatMap((wrap) => {
            const rumor = parseCanonicalRuntimePrivateRumor({
              inboxOwner: merchant,
              recipient: merchant,
              sender: buyer,
              rumorKind: 16,
              wrap,
            })
            return rumor?.tags.some(
              (tag) => tag[0] === "order" && tag[1] === orderId
            )
              ? [rumor.id]
              : []
          })
        ).size
      })
      .toBe(1)
  } finally {
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
})

test("signed-in checkout waits for delayed inbox evidence before one-click order submission @commerce", async ({
  page,
}) => {
  const buyer = createRuntimeSignerIdentity()
  const merchant = createRuntimeSignerIdentity()
  const now = Math.floor(Date.now() / 1000)
  const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
  const title = `Delayed inbox ${crypto.randomUUID()}`
  const image = "https://cdn.conduit.market/inbox-readiness-smoke.svg"
  let waitingForInbox = true
  const pendingInboxReads: Array<() => void> = []
  try {
    await page.route(image, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"/>',
      })
    )
    // Delay only the buyer's declaration requests, forwarding all other traffic
    // to the real isolated relay. The eventual declaration remains signed.
    await page.routeWebSocket(TEST_RELAY_URL, (socket) => {
      const server = socket.connectToServer()
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message)) as unknown[]
        const buyerInboxRead =
          frame[0] === "REQ" &&
          frame.slice(2).some((filter) => {
            const query = filter as { kinds?: number[]; authors?: string[] }
            return (
              query.kinds?.includes(10050) &&
              query.authors?.includes(buyer.pubkey)
            )
          })
        if (waitingForInbox && buyerInboxRead) {
          pendingInboxReads.push(() => server.send(message))
        } else {
          server.send(message)
        }
      })
    })
    await publishTestRelayEvents([
      ...[buyer, merchant].flatMap((identity) => [
        signRuntimeTestEvent(identity, {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name: identity === buyer ? "Delayed Buyer" : "Delayed Merchant",
          }),
        }),
        signRuntimeTestEvent(identity, {
          kind: 10002,
          created_at: now,
          tags: [["r", TEST_RELAY_URL]],
          content: "",
        }),
        signRuntimeTestEvent(identity, {
          kind: 10050,
          created_at: now,
          tags: [["relay", TEST_RELAY_URL]],
          content: "",
        }),
      ]),
      signRuntimeTestEvent(merchant, {
        kind: 30402,
        created_at: now,
        tags: [
          ["d", "delayed-readiness"],
          ["title", title],
          ["price", "21", "SATS"],
          ["type", "simple", "digital"],
          ["stock", "3"],
          ["image", image],
          ["t", "commerce"],
          ["t", "smoke"],
          ["t", "hermetic"],
        ],
        content: "Synthetic delayed inbox fixture",
      }),
    ])
    await installRealTestSigner(page, buyer, TEST_RELAY_URL)
    await page.goto(`${marketUrl}/${nip19.npubEncode(merchant.pubkey)}`)
    const product = page.getByRole("listitem").filter({ hasText: title })
    await expect(product).toBeVisible()
    await product.getByRole("button", { name: /^Add .+ to cart$/ }).click()
    await page
      .getByRole("region", { name: "Cart inventory" })
      .getByRole("link", { name: "Continue to checkout" })
      .click()
    await expect(
      page.getByText("Checking order messaging", { exact: true })
    ).toBeVisible()
    const sendOrder = page.getByRole("button", {
      name: "Send order",
      exact: true,
    })
    expect(await sendOrder.isDisabled()).toBe(true)
    expect(pendingInboxReads.length).toBeGreaterThan(0)
    // A disabled native control must not invoke the preflight or persist work.
    await sendOrder.evaluate((button: HTMLButtonElement) => button.click())
    await expect(page.getByRole("alert")).toHaveCount(0)
    const pendingCounts = await page.evaluate(async (root) => {
      const { db } = await import(/* @vite-ignore */ `${root}/db/index.ts`)
      return {
        orders: await db.orderLifecycles.count(),
        payments: await db.paymentAttempts.count(),
      }
    }, `/@fs${process.cwd()}/packages/core/src`)
    expect(pendingCounts).toEqual({ orders: 0, payments: 0 })
    expect(
      await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)
    ).toHaveLength(0)

    waitingForInbox = false
    for (const release of pendingInboxReads.splice(0)) release()
    await expect(sendOrder).toBeEnabled()
    await sendOrder.click()
    await expect(page).toHaveURL(/\/orders\?order=/)
    const orderId = new URL(page.url()).searchParams.get("order")
    await expect
      .poll(async () => {
        const wraps = await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)
        return new Set(
          wraps.flatMap((wrap) => {
            const rumor = parseCanonicalRuntimePrivateRumor({
              inboxOwner: merchant,
              recipient: merchant,
              sender: buyer,
              rumorKind: 16,
              wrap,
            })
            return rumor?.tags.some(
              (tag) => tag[0] === "order" && tag[1] === orderId
            )
              ? [rumor.id]
              : []
          })
        ).size
      })
      .toBe(1)
  } finally {
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
})

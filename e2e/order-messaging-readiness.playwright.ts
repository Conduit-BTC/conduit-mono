import { expect, test, type Page } from "@playwright/test"
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

test("signed-in checkout keeps repair drafts and sends without a discoverable sender inbox @commerce", async ({
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

    await setup.close()
    await page.bringToFront()
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe("visible")
    await expect(
      page.getByText("Set up order messaging", { exact: true })
    ).toBeVisible()
    await expect(page.getByText(/You can still send this order/)).toBeVisible()
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
    await assertOneLocallyRecoverableOrder(page, orderId!)
    expect(
      await readAuthenticatedGiftWraps(buyer, TEST_RELAY_URL)
    ).toHaveLength(0)
    await page.reload()
    await assertOneLocallyRecoverableOrder(page, orderId!)
    expect(
      await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)
    ).toHaveLength(1)
  } finally {
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
})

test("signed-in checkout sends once while sender inbox evidence is delayed @commerce", async ({
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
    await expect(sendOrder).toBeEnabled()
    expect(pendingInboxReads.length).toBeGreaterThan(0)
    await expect(page.getByText(/You can still send this order/)).toBeVisible()
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
    // Merchant acceptance and local recovery do not wait for optional self-copy.
    await assertOneLocallyRecoverableOrder(page, orderId!)
    waitingForInbox = false
    for (const release of pendingInboxReads.splice(0)) release()
    await page.reload()
    await assertOneLocallyRecoverableOrder(page, orderId!)
    expect(
      await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)
    ).toHaveLength(1)
  } finally {
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
})

async function assertOneLocallyRecoverableOrder(page: Page, orderId: string) {
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ root, orderId }) => {
          const { db } = await import(/* @vite-ignore */ `${root}/db/index.ts`)
          const order = await db.orderLifecycles.get(orderId)
          return {
            orders: await db.orderLifecycles.count(),
            payments: await db.paymentAttempts.count(),
            status: order?.orderDeliveryStatus,
            format: order?.orderWireFormat,
            declaredRecipient:
              order?.orderRelayDelivery?.route === "declared_inbox",
            exactRecipientWrap:
              !!order?.orderRelayDelivery?.signedRecipientWrap,
          }
        },
        { root: `/@fs${process.cwd()}/packages/core/src`, orderId }
      )
    )
    .toEqual({
      orders: 1,
      payments: 0,
      status: "sent",
      format: "open_markets_v2",
      declaredRecipient: true,
      exactRecipientWrap: true,
    })
}

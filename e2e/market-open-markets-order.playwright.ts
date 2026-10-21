import { expect, test, type Page } from "@playwright/test"
import { nip19 } from "nostr-tools"
import { getEventHash } from "nostr-tools/pure"
import { createWrap } from "nostr-tools/nip59"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  encryptRuntimeTestPayload,
  installRealTestSigner,
  parseCanonicalRuntimePrivateRumor,
  readAuthenticatedGiftWraps,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "../tests/support/bolt11-fixture"

test.use({ trace: "off", screenshot: "off", video: "off" })

// Source-derived peer packets: nostrichOS/nostrich-marketplace@668198e, docs/orders.md
// and src/orders/orders.ts. The peer here is a runner-owned simulation, not Nostrich.
test("Market defaults to one numeric order and completes the external merchant lifecycle after reload @commerce", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(30_000)
  const buyer = createRuntimeSignerIdentity()
  const merchant = createRuntimeSignerIdentity()
  const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
  const now = Math.floor(Date.now() / 1000)
  const title = `Peer contract ${crypto.randomUUID()}`
  const image = "https://cdn.conduit.market/peer-contract-smoke.svg"
  let sequence = 0
  let orderId = ""
  const peerSend = async (kind: number, tags: string[][], content: string) => {
    const rumor = {
      kind,
      pubkey: merchant.pubkey,
      created_at: now + ++sequence,
      tags,
      content,
    }
    const seal = signRuntimeTestEvent(merchant, {
      kind: 13,
      created_at: rumor.created_at,
      tags: [],
      content: encryptRuntimeTestPayload(
        merchant,
        buyer.pubkey,
        JSON.stringify({ ...rumor, id: getEventHash(rumor) })
      ),
    })
    await publishTestRelayEvents([createWrap(seal, buyer.pubkey)])
  }
  const peerRead = async (kind: number) => {
    const wraps = await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)
    return wraps.flatMap((wrap) => {
      const rumor = parseCanonicalRuntimePrivateRumor({
        inboxOwner: merchant,
        recipient: merchant,
        sender: buyer,
        rumorKind: kind as 14 | 16 | 17,
        wrap,
      })
      return rumor &&
        rumor.tags.some((tag) => tag[0] === "order" && tag[1] === orderId)
        ? [rumor]
        : []
    })
  }
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
            name: identity === buyer ? "Peer Buyer" : "Peer Merchant",
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
          ["d", "peer-contract"],
          ["title", title],
          ["price", "21", "SATS"],
          ["type", "simple", "digital"],
          ["stock", "3"],
          ["image", image],
          ["t", "commerce"],
          ["t", "smoke"],
          ["t", "hermetic"],
        ],
        content: "Synthetic interoperability fixture",
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
      page.getByRole("combobox", { name: "Order compatibility" })
    ).toHaveCount(0)
    await page.getByRole("button", { name: "Send order", exact: true }).click()
    await expect(page).toHaveURL(/\/orders\?order=/)
    orderId = new URL(page.url()).searchParams.get("order") ?? ""
    expect(Boolean(orderId)).toBe(true)
    await expect
      .poll(async () => {
        const orders = await peerRead(16)
        return new Set(
          orders
            .filter((rumor) =>
              rumor.tags.some((tag) => tag[0] === "type" && tag[1] === "1")
            )
            .map((rumor) => rumor.id)
        ).size
      })
      .toBe(1)
    const orders = await peerRead(16)
    const extension = orders[0]!.tags.find((tag) => tag[0] === "conduit")!
    expect(extension.slice(0, 3)).toEqual(["conduit", "2", "order"])
    const terms = JSON.parse(extension[3]!)
    expect(terms.payload).toMatchObject({
      id: orderId,
      buyerPubkey: buyer.pubkey,
      merchantPubkey: merchant.pubkey,
      subtotal: 21,
      currency: "SATS",
    })
    expect(terms.payload.items[0]).toMatchObject({
      productId: `30402:${merchant.pubkey}:peer-contract`,
      quantity: 1,
      priceAtPurchase: 21,
      format: "digital",
    })
    expect(terms.tags).toContainEqual(["type", "order"])
    expect(
      orders.every(
        (rumor) =>
          !rumor.tags.some((tag) => tag[0] === "type" && tag[1] === "order")
      )
    ).toBe(true)
    const advisory = async () =>
      (await peerRead(14)).filter((rumor) =>
        rumor.tags.some(
          (tag) =>
            tag[0] === "subject" && tag[1] === "conduit-order-notification"
        )
      )
    await expect
      .poll(
        async () => new Set((await advisory()).map((rumor) => rumor.id)).size
      )
      .toBe(1)
    expect((await advisory())[0]!.tags).toContainEqual([
      "conduit",
      "order-companion",
      "1",
      orders[0]!.id,
    ])
    expect((await advisory())[0]!.content).not.toContain(title)
    const originalWrap = await page.evaluate(
      async ({ root, orderId }) => {
        const { db } = await import(/* @vite-ignore */ `${root}/db/index.ts`)
        const order = await db.orderLifecycles.get(orderId)
        const choice = await db.orderWireFormats.get(orderId)
        if (
          order?.orderWireFormat !== "open_markets_v2" ||
          choice?.orderWireFormat !== "open_markets_v2" ||
          !order.orderRelayDelivery
        )
          throw new Error("Numeric order format was not durably bound")
        return JSON.stringify(order.orderRelayDelivery.signedRecipientWrap)
      },
      { root: `/@fs${process.cwd()}/packages/core/src`, orderId }
    )
    console.info("Market numeric order accepted and format persisted")
    const invoice = makeBolt11Fixture({
      hrp: "lntb210n",
      createdAt: now,
      fields: [
        bolt11PaymentHashField(),
        bolt11PlainDescriptionField("Synthetic peer browser invoice"),
      ],
    })
    const common = [
      ["p", buyer.pubkey],
      ["order", orderId],
    ]
    await peerSend(
      16,
      [
        ...common,
        ["subject", "order-info"],
        ["type", "3"],
        ["status", "pending"],
      ],
      "Order accepted"
    )
    await peerSend(
      16,
      [
        ...common,
        ["subject", "order-payment"],
        ["type", "2"],
        ["amount", "21"],
        ["payment", "bitcoin", "synthetic-bitcoin-address"],
        ["payment", "lightning", invoice],
        ["payment", "ecash", "synthetic-ecash-request"],
        ["expiration", String(now + 3600)],
      ],
      "Synthetic payment instructions"
    )
    await page.reload()
    await expect(page.getByLabel("Open account menu")).toBeVisible()
    await expect(
      page.getByRole("heading", { name: "Pay merchant invoice", exact: true })
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Report payment to merchant", exact: true })
      .click()
    await expect
      .poll(async () =>
        (await peerRead(17)).some((rumor) =>
          rumor.tags.some(
            (tag) =>
              tag.length === 3 &&
              tag[0] === "payment" &&
              tag[1] === "lightning" &&
              tag[2] === invoice
          )
        )
      )
      .toBe(true)
    console.info("Market unverified report consumed by numeric peer")
    await peerSend(
      16,
      [
        ...common,
        ["subject", "order-info"],
        ["type", "3"],
        ["status", "confirmed"],
      ],
      "Payment confirmed by the simulated merchant"
    )
    await peerSend(
      14,
      [...common, ["subject", orderId]],
      "Your order is being prepared"
    )
    await page
      .getByRole("button", { name: "Open messages", exact: true })
      .click()
    const messages = page.getByRole("dialog", { name: "Messages" })
    await expect(
      messages.getByText("Your order is being prepared", { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    const text = messages.getByRole("textbox", { name: "Message", exact: true })
    await page.evaluate((principal) => {
      const provider = (
        window as unknown as {
          nostr: {
            nip44: { encrypt: (peer: string, text: string) => Promise<string> }
          }
        }
      ).nostr.nip44
      const encrypt = provider.encrypt.bind(provider)
      provider.encrypt = async (peer, text) => {
        if (peer === principal) throw new Error("Synthetic self-copy refusal")
        return encrypt(peer, text)
      }
    }, buyer.pubkey)
    await text.fill("Thank you for the update")
    await messages
      .getByRole("button", { name: "Send message", exact: true })
      .click()
    await expect(text).toHaveValue("")
    await expect
      .poll(async () =>
        (await peerRead(14)).some(
          (rumor) =>
            rumor.content === "Thank you for the update" &&
            rumor.tags.some((tag) => tag[0] === "subject" && tag[1] === orderId)
        )
      )
      .toBe(true)
    await page.keyboard.press("Escape")
    await page.goto(
      `${marketUrl}/messages?tab=merchants&merchant=${merchant.pubkey}`
    )
    const threadReply = page.getByRole("textbox", {
      name: "Reply to merchant",
      exact: true,
    })
    await expect(threadReply).toBeVisible()
    await threadReply.fill("Reply from Market Messages")
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click()
    try {
      await expect(threadReply).toHaveValue("")
    } catch (error) {
      const pageState = await page.evaluate(() => {
        const text = document.body.textContent ?? ""
        return {
          sending: [...document.querySelectorAll("button")].some(
            (button) => button.textContent?.trim() === "Sending..."
          ),
          sessionError:
            text.includes("session ended") ||
            text.includes("Reconnect your signer"),
          scopeError:
            text.includes("another buyer or merchant") ||
            text.includes("conflicting") ||
            text.includes("saved commerce format"),
          documentVisible: document.visibilityState === "visible",
        }
      })
      await testInfo.attach("numeric-reply-state", {
        body: JSON.stringify({
          ...pageState,
          peerAccepted: (await peerRead(14)).some(
            (rumor) => rumor.content === "Reply from Market Messages"
          ),
        }),
        contentType: "application/json",
      })
      throw error
    }
    await expect
      .poll(async () =>
        (await peerRead(14)).some(
          (rumor) =>
            rumor.content === "Reply from Market Messages" &&
            rumor.tags.some((tag) => tag[0] === "subject" && tag[1] === orderId)
        )
      )
      .toBe(true)
    await page.reload()
    await expect(
      page
        .locator("section")
        .filter({ has: threadReply })
        .getByText("Reply from Market Messages", { exact: true })
    ).toBeVisible()
    await page.goto(
      `${marketUrl}/orders?order=${encodeURIComponent(orderId)}&counterparty=${merchant.pubkey}`
    )
    await peerSend(
      16,
      [
        ...common,
        ["subject", "shipping-info"],
        ["type", "4"],
        ["status", "shipped"],
        ["carrier", "Example"],
        ["tracking", "synthetic-tracking"],
      ],
      "Fulfillment dispatched"
    )
    await peerSend(
      16,
      [
        ...common,
        ["subject", "order-info"],
        ["type", "3"],
        ["status", "completed"],
      ],
      "Order completed"
    )
    await page.reload()
    await expect(
      page
        .getByText(/^(Order complete|Completed|Complete)$/)
        .filter({ visible: true })
        .first()
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Open messages", exact: true })
      .click()
    await expect(
      page
        .getByRole("dialog", { name: "Messages" })
        .getByText("Thank you for the update", { exact: true })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    const unchanged = await page.evaluate(
      async ({ root, orderId, original }) => {
        const { db } = await import(/* @vite-ignore */ `${root}/db/index.ts`)
        const order = await db.orderLifecycles.get(orderId)
        return (
          order?.orderWireFormat === "open_markets_v2" &&
          JSON.stringify(order.orderRelayDelivery?.signedRecipientWrap) ===
            original
        )
      },
      {
        root: `/@fs${process.cwd()}/packages/core/src`,
        orderId,
        original: originalWrap,
      }
    )
    expect(unchanged).toBe(true)
    // A fresh device has the authenticated inbox original, not this lifecycle.
    await page.evaluate(
      async ({ root, orderId }) => {
        const { db } = await import(/* @vite-ignore */ `${root}/db/index.ts`)
        await db.orderLifecycles.delete(orderId)
      },
      { root: `/@fs${process.cwd()}/packages/core/src`, orderId }
    )
    await page.goto(
      `${marketUrl}/orders?order=${encodeURIComponent(orderId)}&counterparty=${merchant.pubkey}`
    )
    await expect(
      page
        .getByText(/^(Order complete|Completed|Complete)$/)
        .filter({ visible: true })
        .first()
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Open messages", exact: true })
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Open messages", exact: true })
      .click()
    await expect(
      page
        .getByRole("dialog", { name: "Messages" })
        .getByText("Reply from Market Messages", { exact: true })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    expect(new Set((await advisory()).map((rumor) => rumor.id)).size).toBe(1)
    expect(
      new Set(
        (await peerRead(16))
          .filter((rumor) =>
            rumor.tags.some((tag) => tag[0] === "type" && tag[1] === "1")
          )
          .map((rumor) => rumor.id)
      ).size
    ).toBe(1)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1
      )
    ).toBe(true)
    console.info(
      "Bidirectional numeric lifecycle completed with immutable order bytes after reload"
    )
  } finally {
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
})

async function checkPerItemShipping(page: Page, supported: boolean) {
  test.setTimeout(180_000)
  const buyer = createRuntimeSignerIdentity()
  const merchant = createRuntimeSignerIdentity()
  const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
  const now = Math.floor(Date.now() / 1000)
  const image = "https://cdn.conduit.market/fixed-shipping-smoke.svg"
  const lines = [
    { d: "fixed-parcel-a", price: 21, shipping: 3 },
    { d: "fixed-parcel-b", price: 34, shipping: 5 },
  ]
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
      ...lines.flatMap((line) => [
        signRuntimeTestEvent(merchant, {
          kind: 30406,
          created_at: now,
          tags: [
            ["d", `${line.d}-shipping-standard`],
            ["title", "Standard Shipping"],
            ["price", String(line.shipping), "SATS"],
            ["country", "US"],
            ["service", "standard"],
          ],
          content: "",
        }),
        signRuntimeTestEvent(merchant, {
          kind: 30402,
          created_at: now + 1,
          tags: [
            ["d", line.d],
            ["title", line.d],
            ["price", String(line.price), "SATS"],
            ["type", "simple", "physical"],
            ["stock", "3"],
            ...(supported
              ? [
                  [
                    "conduit_commerce",
                    "2",
                    "per_item_shipping",
                    "event_pickup",
                    "router_checkout",
                  ],
                ]
              : []),
            ["image", image],
            [
              "shipping_option",
              `30406:${merchant.pubkey}:${line.d}-shipping-standard`,
            ],
          ],
          content: "Synthetic fixed shipping fixture",
        }),
      ]),
    ])
    await installRealTestSigner(page, buyer, TEST_RELAY_URL)
    for (const line of lines) {
      await page.goto(
        `${marketUrl}/products/30402:${merchant.pubkey}:${line.d}`
      )
      await page
        .getByRole("button", { name: "Add 1 to cart", exact: true })
        .click()
      await expect
        .poll(() =>
          page.evaluate(async (productId) => {
            const path = "/src/lib/cart-repository.ts"
            const repository = await import(/* @vite-ignore */ path)
            await repository.initializeCartRepository()
            const items = repository.getCartRepositorySnapshot().items
            return items.some(
              (item: { productId: string }) => item.productId === productId
            )
          }, `30402:${merchant.pubkey}:${line.d}`)
        )
        .toBe(true)
    }
    await page.goto(`${marketUrl}/checkout?merchant=${merchant.pubkey}`)
    await page.getByLabel(/First name/i).fill("Synthetic")
    await page.getByLabel(/Last name/i).fill("Buyer")
    await page.getByLabel(/Street address/i).fill("1 Test Way")
    await page.getByLabel(/^City/i).fill("Seattle")
    await page.getByLabel(/State/i).fill("WA")
    await page.getByLabel(/Postal\/ZIP code/i).fill("98101")
    await expect(
      page.getByRole("combobox", { name: "Order compatibility" })
    ).toHaveCount(0)
    const send = page.getByRole("button", { name: "Send order", exact: true })
    await expect(send).toBeEnabled()
    await send.click()
    if (!supported) {
      await expect(
        page.getByText(/This seller’s current listings do not declare support/)
      ).toBeVisible()
      expect(new URL(page.url()).pathname).toBe("/checkout")
      const staged = await page.evaluate(async (root) => {
        const { db } = await import(/* @vite-ignore */ `${root}/db/index.ts`)
        return {
          lifecycles: await db.orderLifecycles.count(),
          formats: await db.orderWireFormats.count(),
          paymentAttempts: await db.paymentAttempts.count(),
        }
      }, `/@fs${process.cwd()}/packages/core/src`)
      expect(staged).toEqual({ lifecycles: 0, formats: 0, paymentAttempts: 0 })
      expect(
        await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)
      ).toHaveLength(0)
      return
    }
    await expect(page).toHaveURL(/\/orders\?order=/)
    const orderId = new URL(page.url()).searchParams.get("order")!
    const saved = await page.evaluate(
      async ({ root, orderId }) => {
        const { db } = await import(/* @vite-ignore */ `${root}/db/index.ts`)
        return {
          lifecycle: await db.orderLifecycles.get(orderId),
          choice: await db.orderWireFormats.get(orderId),
        }
      },
      { root: `/@fs${process.cwd()}/packages/core/src`, orderId }
    )
    expect(saved.choice.orderWireFormat).toBe("open_markets_v2")
    expect(saved.lifecycle.orderWireFormat).toBe("open_markets_v2")
    expect(saved.lifecycle.totalSats).toBe(63)
    await expect
      .poll(async () => {
        const wraps = await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)
        return wraps.flatMap((wrap) => {
          const rumor = parseCanonicalRuntimePrivateRumor({
            inboxOwner: merchant,
            recipient: merchant,
            sender: buyer,
            rumorKind: 16,
            wrap,
          })
          if (
            !rumor ||
            !rumor.tags.some((tag) => tag[0] === "order" && tag[1] === orderId)
          )
            return []
          expect(rumor.tags).toContainEqual(["type", "1"])
          expect(rumor.tags.filter((tag) => tag[0] === "shipping")).toEqual([])
          const extension = rumor.tags.find((tag) => tag[0] === "conduit")!
          expect(extension.slice(0, 3)).toEqual(["conduit", "2", "order"])
          const { payload } = JSON.parse(extension[3]!)
          return payload.items
            .map(
              (item: {
                productId: string
                shippingOptionId: string
                shippingCostSats: number
                price: number
                quantity: number
              }) => ({
                productId: item.productId,
                shippingOptionId: item.shippingOptionId,
                shippingCostSats: item.shippingCostSats,
                quantity: item.quantity,
              })
            )
            .sort((a: { productId: string }, b: { productId: string }) =>
              a.productId.localeCompare(b.productId)
            )
        })
      })
      .toEqual(
        lines.map((line) => ({
          productId: `30402:${merchant.pubkey}:${line.d}`,
          shippingOptionId: `30406:${merchant.pubkey}:${line.d}-shipping-standard`,
          shippingCostSats: line.shipping,
          quantity: 1,
        }))
      )
    console.info(
      "Two fixed shipping snapshots delivered with the unified format"
    )
  } finally {
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
}

for (const historicalFormat of ["conduit", "open_markets"] as const) {
  test(`Market resumes a saved ${historicalFormat} order without upgrading its writer @commerce`, async ({
    page,
  }) => {
    const buyer = createRuntimeSignerIdentity()
    const merchant = createRuntimeSignerIdentity()
    const orderId = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000) - 2
    const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
    const payload = {
      id: orderId,
      buyerPubkey: buyer.pubkey,
      merchantPubkey: merchant.pubkey,
      buyerIdentityKind: "signed_in",
      items: [
        {
          productId: `30402:${merchant.pubkey}:installed-product`,
          quantity: 1,
          priceAtPurchase: 21,
          currency: "SATS",
          format: "digital",
          fulfillment: { type: "digital" },
        },
      ],
      subtotal: 21,
      currency: "SATS",
      createdAt: now * 1000,
    }
    const tags =
      historicalFormat === "conduit"
        ? [
            ["p", merchant.pubkey],
            ["type", "order"],
            ["order", orderId],
            ["amount", "21"],
            ["currency", "SATS"],
          ]
        : [
            ["p", merchant.pubkey],
            ["subject", "Order"],
            ["type", "1"],
            ["order", orderId],
            ["amount", "21"],
            ["currency", "SATS"],
            ["item", `30402:${merchant.pubkey}:installed-product`, "1"],
            ["conduit", "1", "order", JSON.stringify(payload)],
          ]
    const original = {
      kind: 16,
      pubkey: buyer.pubkey,
      created_at: now,
      tags,
      content: historicalFormat === "conduit" ? JSON.stringify(payload) : "",
    }
    const seal = signRuntimeTestEvent(buyer, {
      kind: 13,
      created_at: now,
      tags: [],
      content: encryptRuntimeTestPayload(
        buyer,
        buyer.pubkey,
        JSON.stringify({ ...original, id: getEventHash(original) })
      ),
    })
    const originalWrap = createWrap(seal, buyer.pubkey)
    try {
      await publishTestRelayEvents([
        ...[buyer, merchant].flatMap((identity) => [
          signRuntimeTestEvent(identity, {
            kind: 10050,
            created_at: now,
            tags: [["relay", TEST_RELAY_URL]],
            content: "",
          }),
          signRuntimeTestEvent(identity, {
            kind: 10002,
            created_at: now,
            tags: [["r", TEST_RELAY_URL]],
            content: "",
          }),
        ]),
        originalWrap,
      ])
      await installRealTestSigner(page, buyer, TEST_RELAY_URL)
      await page.goto(
        `${marketUrl}/orders?order=${orderId}&counterparty=${merchant.pubkey}`
      )
      await expect(page.getByLabel("Open account menu")).toBeVisible()
      await page.evaluate(
        async ({
          root,
          orderId,
          buyerPubkey,
          merchantPubkey,
          orderWireFormat,
        }) => {
          const { db } = await import(`${root}/db/index.ts`)
          await db.orderWireFormats.put({
            orderId,
            buyerPubkey,
            merchantPubkey,
            orderWireFormat,
            createdAt: Date.now(),
          })
        },
        {
          root: `/@fs${process.cwd()}/packages/core/src`,
          orderId,
          buyerPubkey: buyer.pubkey,
          merchantPubkey: merchant.pubkey,
          orderWireFormat: historicalFormat,
        }
      )
      await page.reload()
      await page
        .getByRole("button", { name: "Open messages", exact: true })
        .click()
      const dialog = page.getByRole("dialog", { name: "Messages" })
      await dialog
        .getByRole("textbox", { name: "Message", exact: true })
        .fill("Reply to installed order")
      await dialog
        .getByRole("button", { name: "Send message", exact: true })
        .click()
      const replies = async () =>
        (await readAuthenticatedGiftWraps(merchant, TEST_RELAY_URL)).flatMap(
          (wrap) => {
            const rumor = parseCanonicalRuntimePrivateRumor({
              inboxOwner: merchant,
              recipient: merchant,
              sender: buyer,
              rumorKind: historicalFormat === "conduit" ? 16 : 14,
              wrap,
            })
            return rumor &&
              rumor.tags.some((tag) => tag[0] === "order" && tag[1] === orderId)
              ? [rumor]
              : []
          }
        )
      await expect.poll(async () => (await replies()).length).toBe(1)
      const reply = (await replies())[0]!
      if (historicalFormat === "conduit") {
        expect(reply.tags).toContainEqual(["type", "message"])
        expect(JSON.parse(reply.content).note).toBe("Reply to installed order")
      } else {
        expect(reply.tags).toContainEqual(["subject", orderId])
        expect(reply.content).toBe("Reply to installed order")
      }
      await page.reload()
      const retained = await page.evaluate(
        async ({ root, orderId, wrapId, expectedWrap }) => {
          const { db } = await import(`${root}/db/index.ts`)
          const choice = await db.orderWireFormats.get(orderId)
          const rows = await db.commerceInboxWrappers.toArray()
          return {
            format: choice?.orderWireFormat,
            originalUnchanged: rows.some(
              (row: { event: Record<string, unknown> }) => {
                const expected = JSON.parse(expectedWrap) as Record<
                  string,
                  unknown
                >
                // Admission may reorder object properties. Compare every signed field,
                // including the exact ciphertext, signature and original event identity.
                return (
                  row.event.id === wrapId &&
                  [
                    "id",
                    "pubkey",
                    "kind",
                    "created_at",
                    "tags",
                    "content",
                    "sig",
                  ].every(
                    (key) =>
                      JSON.stringify(row.event[key]) ===
                      JSON.stringify(expected[key])
                  )
                )
              }
            ),
          }
        },
        {
          root: `/@fs${process.cwd()}/packages/core/src`,
          orderId,
          wrapId: originalWrap.id,
          expectedWrap: JSON.stringify(originalWrap),
        }
      )
      expect(retained).toEqual({
        format: historicalFormat,
        originalUnchanged: true,
      })
      expect((await replies()).length).toBe(1)
    } finally {
      disposeRuntimeSignerIdentity(buyer)
      disposeRuntimeSignerIdentity(merchant)
    }
  })
}

for (const supported of [true, false]) {
  test(
    supported
      ? "Market preserves two product-scoped fixed shipping snapshots with unified numeric terms @commerce"
      : "Market explains unsupported per-item shipping before staging an order or payment @commerce",
    async ({ page }) => {
      await checkPerItemShipping(page, supported)
    }
  )
}

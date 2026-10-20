import { expect, test } from "@playwright/test"
import { randomBytes } from "node:crypto"
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

test("independent numeric order retains invoice, shipping and accepted conversation after reload @commerce", async ({
  page,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(30_000)
  const buyer = createRuntimeSignerIdentity()
  const merchant = createRuntimeSignerIdentity()
  const now = Math.floor(Date.now() / 1000)
  const wireOrderId = `external-${crypto.randomUUID()}`
  const product = `30402:${merchant.pubkey}:adapter-book`
  const invoice = makeBolt11Fixture({
    hrp: "lntb2000n",
    createdAt: now,
    fields: [
      bolt11PaymentHashField(randomBytes(32)),
      bolt11PlainDescriptionField("Synthetic adapter browser invoice"),
    ],
  })
  const publishBuyer = async (
    kind: number,
    tags: string[][],
    content: string
  ) => {
    const rumor = {
      kind,
      pubkey: buyer.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    }
    const seal = signRuntimeTestEvent(buyer, {
      kind: 13,
      created_at: rumor.created_at,
      tags: [],
      content: encryptRuntimeTestPayload(
        buyer,
        merchant.pubkey,
        JSON.stringify({ ...rumor, id: getEventHash(rumor) })
      ),
    })
    await publishTestRelayEvents([createWrap(seal, merchant.pubkey)])
  }
  const peerObserved = async (type: string, status?: string) => {
    const wraps = await readAuthenticatedGiftWraps(buyer, TEST_RELAY_URL)
    return wraps.some((wrap) => {
      const rumor = parseCanonicalRuntimePrivateRumor({
        inboxOwner: buyer,
        recipient: buyer,
        sender: merchant,
        rumorKind: 16,
        wrap,
      })
      return (
        rumor?.tags.some(
          (tag) => tag[0] === "order" && tag[1] === wireOrderId
        ) &&
        rumor.tags.some((tag) => tag[0] === "type" && tag[1] === type) &&
        (!status ||
          rumor.tags.some((tag) => tag[0] === "status" && tag[1] === status)) &&
        !rumor.content.trim().startsWith("{") &&
        (type !== "2" ||
          (rumor.tags.some(
            (tag) => tag[0] === "expiration" && tag[1] === String(now + 3600)
          ) &&
            rumor.tags.some(
              (tag) =>
                tag[0] === "payment" &&
                tag[1] === "lightning" &&
                tag[2] === invoice
            )))
      )
    })
  }
  try {
    await publishTestRelayEvents([
      ...[buyer, merchant].flatMap((identity) => [
        signRuntimeTestEvent(identity, {
          kind: 0,
          created_at: now,
          tags: [],
          content: JSON.stringify({
            name: identity === buyer ? "Adapter Buyer" : "Adapter Merchant",
          }),
        }),
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
      signRuntimeTestEvent(merchant, {
        kind: 30402,
        created_at: now,
        tags: [
          ["d", "adapter-book"],
          ["title", "Independent order book"],
          ["price", "100", "SATS"],
          ["format", "physical"],
          ["stock", "10"],
          ["t", "books"],
        ],
        content: "Synthetic interoperability fixture",
      }),
    ])
    await publishBuyer(
      16,
      [
        ["p", merchant.pubkey],
        ["subject", "Order"],
        ["type", "1"],
        ["order", wireOrderId],
        ["amount", "200"],
        ["item", product, "2"],
        ["address", "Synthetic delivery address requiring review"],
      ],
      "Please confirm delivery before invoicing."
    )
    console.info("Adapter fixture published")
    await installRealTestSigner(page, merchant, TEST_RELAY_URL)
    const url = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}/orders`
    await page.goto(
      `${url}?order=${encodeURIComponent(wireOrderId)}&counterparty=${buyer.pubkey}`
    )
    await expect(
      page
        .getByText("Requested total", { exact: true })
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      page
        .getByText("Synthetic delivery address requiring review", {
          exact: false,
        })
        .filter({ visible: true })
        .first()
    ).toBeVisible()
    console.info("Adapter order reviewed")
    await expect(
      page
        .getByText(/Unit price not supplied/)
        .filter({ visible: true })
        .first()
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Accept order", exact: true })
      .click()
    await expect
      .poll(() => peerObserved("3", "pending"), { timeout: 30_000 })
      .toBe(true)
    console.info("Adapter acceptance observed")
    const readInventory = () =>
      page.evaluate(
        async ({ root, product }) => {
          const { db } = await import(root + "/db/index.ts")
          const saved = await db.merchantInventoryAcceptedOrders.toArray()
          return {
            stock: (await db.merchantInventoryProducts.get(product))?.stock,
            accepted: saved.length,
            encrypted: saved.every(
              (order: { evidenceFormat: string }) =>
                order.evidenceFormat === "device-encrypted-v1"
            ),
          }
        },
        { root: `/@fs${process.cwd()}/packages/core/src`, product }
      )
    await expect
      .poll(readInventory)
      .toEqual({ stock: 8, accepted: 1, encrypted: true })
    await expect(
      page.getByText("Status update sent to buyer", { exact: true })
    ).toBeVisible()
    const invoiceSource = page.locator("#invoice-source")
    await expect(invoiceSource).toBeVisible()
    await invoiceSource.click()
    console.info("Adapter invoice source opened")
    await page
      .getByRole("option", { name: "Paste BOLT11 manually", exact: true })
      .click()
    console.info("Adapter manual invoice selected")
    await page.locator("#invoice-bolt11").fill(invoice)
    await page
      .getByRole("button", { name: "Validate & send invoice", exact: true })
      .click()
    await expect.poll(() => peerObserved("2"), { timeout: 30_000 }).toBe(true)
    await expect(
      page.getByText("Invoice generated and sent to the buyer's relay", {
        exact: true,
      })
    ).toBeVisible()
    console.info("Adapter invoice observed and local send completed")
    await page.reload()
    await expect(
      page
        .getByText("Requested total", { exact: true })
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 30_000 })
    console.info("Adapter invoice reload complete")
    await publishBuyer(
      17,
      [
        ["p", merchant.pubkey],
        ["subject", "Receipt"],
        ["order", wireOrderId],
        ["amount", "200"],
        ["payment", "lightning", invoice],
      ],
      "Payment claimed"
    )
    await expect(
      page.getByRole("button", { name: "Confirm payment", exact: true })
    ).toBeVisible({ timeout: 30_000 })
    console.info("Adapter claim received")
    expect(await peerObserved("3", "confirmed")).toBe(false)
    await page
      .getByRole("button", { name: "Confirm payment", exact: true })
      .click()
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Confirm payment", exact: true })
      .click()
    await expect
      .poll(() => peerObserved("3", "confirmed"), { timeout: 30_000 })
      .toBe(true)
    console.info("Adapter explicit payment confirmation observed")
    await expect
      .poll(readInventory)
      .toEqual({ stock: 8, accepted: 1, encrypted: true })
    await page.locator("#shipping-tracking-code").fill("SYNTHETIC-TRACKING")
    await page.locator("#shipping-carrier").fill("Synthetic carrier")
    await page
      .getByRole("button", { name: "Send shipping update", exact: true })
      .click()
    await expect.poll(() => peerObserved("4"), { timeout: 30_000 }).toBe(true)
    await expect(
      page.getByText("Shipping update sent to buyer", { exact: true })
    ).toBeVisible()
    console.info("Adapter shipping observed and local send completed")
    await page.reload()
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (path) => {
              const { readAuthSession } = await import(
                path + "/auth-session.ts"
              )
              const { getCommerceInbox } = await import(
                path + "/commerce-inbox.ts"
              )
              try {
                const snapshot = getCommerceInbox(
                  readAuthSession().userPubkey
                ).getSnapshot()
                return {
                  shipping: snapshot.orderMessages.filter(
                    (message: { type: string }) =>
                      message.type === "shipping_update"
                  ).length,
                  tracking: snapshot.orderMessages.some(
                    (message: {
                      type: string
                      payload: { trackingNumber?: string }
                    }) =>
                      message.type === "shipping_update" &&
                      message.payload.trackingNumber === "SYNTHETIC-TRACKING"
                  ),
                  external: snapshot.externalRecords.length,
                  storageFailed: snapshot.diagnostics.storageUnavailable,
                }
              } catch {
                return {
                  shipping: 0,
                  tracking: false,
                  external: 0,
                  storageFailed: false,
                }
              }
            },
            "/@fs" + process.cwd() + "/packages/core/src/protocol"
          ),
        { timeout: 30_000 }
      )
      .toMatchObject({ shipping: 1, tracking: true, storageFailed: false })
    await expect(
      page
        .getByText("SYNTHETIC-TRACKING", { exact: false })
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 30_000 })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    )
    expect(overflow).toBe(false)
    console.info("Adapter shipping reload and layout verified")
    const note = "Synthetic accepted Merchant conversation"
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
    }, merchant.pubkey)
    await page
      .getByRole("button", { name: "Open messages", exact: true })
      .click()
    const messages = page.getByRole("dialog", { name: "Messages" })
    await messages
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(note)
    await messages
      .getByRole("button", { name: "Send message", exact: true })
      .click()
    await expect(
      messages.getByRole("status").filter({
        hasText:
          "Message was accepted and saved on this device. Sync to your other devices is incomplete.",
      })
    ).toBeVisible()
    await expect
      .poll(async () => {
        const wraps = await readAuthenticatedGiftWraps(buyer, TEST_RELAY_URL)
        return new Set(
          wraps.flatMap((wrap) => {
            const rumor = parseCanonicalRuntimePrivateRumor({
              inboxOwner: buyer,
              recipient: buyer,
              sender: merchant,
              rumorKind: 14,
              wrap,
            })
            return rumor?.content === note &&
              rumor.tags.some(
                (tag) => tag[0] === "order" && tag[1] === wireOrderId
              )
              ? [rumor.id]
              : []
          })
        ).size
      })
      .toBe(1)
    await page.reload()
    await expect(page.getByLabel("Open merchant account menu")).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          async ({ root, principal, note }) => {
            const { getCommerceInbox } = await import(
              `${root}/protocol/commerce-inbox.ts`
            )
            const { db } = await import(`${root}/db/index.ts`)
            try {
              const snapshot = getCommerceInbox(principal).getSnapshot()
              return {
                direct: snapshot.directMessages.filter(
                  (message: { content: string; senderPubkey: string }) =>
                    message.content === note &&
                    message.senderPubkey === principal
                ).length,
                preview: snapshot.orderMessages.filter(
                  (message: { type: string; payload: { note?: string } }) =>
                    message.type === "message" && message.payload.note === note
                ).length,
                encrypted: !JSON.stringify(
                  await db.commerceInboxRecords.toArray()
                ).includes(note),
              }
            } catch {
              return { direct: 0, preview: 0, encrypted: false }
            }
          },
          {
            root: `/@fs${process.cwd()}/packages/core/src`,
            principal: merchant.pubkey,
            note,
          }
        )
      )
      .toEqual({ direct: 1, preview: 1, encrypted: true })
    await page.goto(
      `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}/messages`
    )
    await expect(
      page.getByText(note, { exact: true }).filter({ visible: true }).first()
    ).toBeVisible()
    await page.reload()
    await expect(
      page.getByText(note, { exact: true }).filter({ visible: true }).first()
    ).toBeVisible()
    console.info(
      "Adapter conversation survives refused self-copy in Messages and Orders"
    )
  } finally {
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
})

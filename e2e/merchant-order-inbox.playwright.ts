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
import { inspectCommerceUi } from "./helpers/shared-ui-evidence"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const protocolRoot = `/@fs${process.cwd()}/packages/core/src/protocol`

test.use({ trace: "off", screenshot: "off", video: "off" })

test("Buyer and Merchant order replies survive refused self-copy and reload after one recipient delivery each @commerce", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const buyer = createRuntimeSignerIdentity()
  const merchant = createRuntimeSignerIdentity()
  const contextOptions = {
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
    userAgent: testInfo.project.use.userAgent,
  }
  const buyerContext = await browser.newContext(contextOptions)
  const merchantContext = await browser.newContext(contextOptions)
  const assignments = new Map<string, string>()
  const title = `Accepted reply fixture ${Date.now().toString(36)}`
  const reply = `Accepted merchant reply ${Date.now().toString(36)}`
  const imageUrl = "https://cdn.conduit.market/merchant-order-reply-smoke.svg"

  try {
    const createdAt = Math.floor(Date.now() / 1_000)
    await publishTestRelayEvents(
      [buyer, merchant].flatMap((identity) => [
        signRuntimeTestEvent(identity, {
          kind: 0,
          created_at: createdAt,
          tags: [],
          content: JSON.stringify({
            name: identity === buyer ? "reply-buyer" : "reply-merchant",
            display_name: identity === buyer ? "Reply Buyer" : "Reply Merchant",
          }),
        }),
        signRuntimeTestEvent(identity, {
          kind: 10002,
          created_at: createdAt,
          tags: [["r", TEST_RELAY_URL]],
          content: "",
        }),
        signRuntimeTestEvent(identity, {
          kind: 10050,
          created_at: createdAt,
          tags: [["relay", TEST_RELAY_URL]],
          content: "",
        }),
      ])
    )
    await merchantContext.route(imageUrl, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"/>',
      })
    )
    const buyerPage = await buyerContext.newPage()
    const merchantPage = await merchantContext.newPage()
    await installRealTestSigner(buyerPage, buyer, TEST_RELAY_URL)
    await installRealTestSigner(merchantPage, merchant, TEST_RELAY_URL)

    await merchantPage.goto(`${merchantUrl}/products`)
    await expect(
      merchantPage.getByRole("heading", { name: "Products" })
    ).toBeVisible()
    await merchantPage
      .getByRole("button", { name: "Add product" })
      .first()
      .click()
    const productDialog = merchantPage.getByRole("dialog", {
      name: "Add product",
    })
    await productDialog.getByLabel("Title").fill(title)
    await productDialog
      .getByLabel("Summary")
      .fill("Encrypted order reply smoke fixture")
    await productDialog.getByLabel("Price").fill("21")
    await productDialog.getByLabel("Stock quantity").fill("3")
    await productDialog.locator("#product-currency").click()
    await merchantPage
      .getByRole("option", { name: "SATS", exact: true })
      .click()
    await productDialog.locator("#product-fulfillment").click()
    await merchantPage
      .getByRole("option", { name: "Digital", exact: true })
      .click()
    await productDialog.getByRole("button", { name: "Add by URL" }).click()
    await productDialog.getByLabel("Primary image URL").fill(imageUrl)
    const publicZaps = productDialog.getByRole("checkbox", {
      name: /Enable public zaps for purchases/,
    })
    if (await publicZaps.isChecked()) await publicZaps.uncheck()
    const tags = productDialog.getByRole("combobox", { name: "Tags" })
    for (const tag of ["commerce", "smoke", "hermetic"]) {
      await tags.fill(tag)
      await tags.press("Enter")
    }
    const publishProduct = productDialog.getByRole("button", {
      name: "Publish product",
      exact: true,
    })
    await expect(publishProduct).toBeEnabled()
    await publishProduct.click()
    await expect(productDialog).toBeHidden({ timeout: 20_000 })

    await buyerPage.goto(`${marketUrl}/${nip19.npubEncode(merchant.pubkey)}`)
    const product = buyerPage.getByRole("listitem").filter({ hasText: title })
    await expect(product).toBeVisible({ timeout: 30_000 })
    await product.getByRole("button", { name: /^Add .+ to cart$/ }).click()
    await buyerPage
      .getByRole("region", { name: "Cart inventory" })
      .getByRole("link", { name: "Continue to checkout" })
      .click()
    await expect(
      buyerPage.getByRole("button", { name: "Send order" })
    ).toBeEnabled()
    await buyerPage
      .getByRole("button", { name: "Send order", exact: true })
      .click()
    await expect(buyerPage).toHaveURL(/\/orders\?order=/, { timeout: 30_000 })
    const orderId = new URL(buyerPage.url()).searchParams.get("order")
    if (!orderId) throw new Error("The order route has no order ID")

    await merchantPage.goto(
      `${merchantUrl}/orders?order=${encodeURIComponent(orderId)}`
    )
    await expect(
      merchantPage
        .getByText(title, { exact: true })
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 30_000 })
    await merchantPage.evaluate((principal) => {
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

    await merchantPage
      .getByRole("button", { name: "Open messages", exact: true })
      .click()
    const messages = merchantPage.getByRole("dialog", { name: "Messages" })
    await expect(messages).toBeVisible()
    await inspectCommerceUi(
      merchantPage,
      testInfo,
      "merchant-order-conversation"
    )
    await messages.getByRole("textbox", { name: "Message" }).fill(reply)
    await messages.getByRole("button", { name: "Send message" }).click()
    await expect(
      messages.getByRole("status").filter({
        hasText:
          "Message was accepted and saved on this device. Sync to your other devices is incomplete.",
      })
    ).toBeVisible({ timeout: 30_000 })

    const saved = async (page: Page, principal: string, note: string) =>
      page.evaluate(
        async ({ root, principal, note }) => {
          const { getCommerceInbox } = await import(`${root}/commerce-inbox.ts`)
          const { db } = await import(
            `${root.replace("/protocol", "")}/db/index.ts`
          )
          const owner = getCommerceInbox(principal)
          const projections = await owner.store.projections()
          const records = await db.commerceInboxRecords.toArray()
          return {
            matches: projections.filter(
              ({ projection }) =>
                projection.kind === "order" &&
                projection.message.type === "message" &&
                projection.message.senderPubkey === principal &&
                projection.message.payload.note === note
            ).length,
            encrypted: !JSON.stringify(records).includes(note),
          }
        },
        { root: protocolRoot, principal, note }
      )
    await expect
      .poll(() => saved(merchantPage, merchant.pubkey, reply), {
        timeout: 30_000,
      })
      .toEqual({
        matches: 1,
        encrypted: true,
      })
    await merchantPage.reload()
    await expect(
      merchantPage.getByLabel("Open merchant account menu")
    ).toBeVisible()
    await expect
      .poll(() => saved(merchantPage, merchant.pubkey, reply), {
        timeout: 30_000,
      })
      .toEqual({
        matches: 1,
        encrypted: true,
      })

    const recipientWraps = await readAuthenticatedGiftWraps(
      buyer,
      TEST_RELAY_URL
    )
    const matchingWraps = recipientWraps.filter((wrap) => {
      const rumor = parseCanonicalRuntimePrivateRumor({
        inboxOwner: buyer,
        recipient: buyer,
        sender: merchant,
        wrapperKeyAssignments: assignments,
        wrap,
      })
      return (
        rumor?.kind === 16 &&
        rumor.content.includes(reply) &&
        rumor.tags.some(
          ([name, value]) => name === "order" && value === orderId
        ) &&
        rumor.tags.some(
          ([name, value]) => name === "type" && value === "message"
        )
      )
    })
    expect(matchingWraps).toHaveLength(1)

    await buyerPage.reload()
    await expect(buyerPage.getByLabel("Open account menu")).toBeVisible()
    await buyerPage.evaluate((principal) => {
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
    await buyerPage
      .getByRole("button", { name: "Open messages", exact: true })
      .click()
    const buyerMessages = buyerPage.getByRole("dialog", { name: "Messages" })
    const buyerReply = `Accepted buyer reply ${Date.now().toString(36)}`
    await buyerMessages
      .getByRole("textbox", { name: "Message" })
      .fill(buyerReply)
    await buyerMessages.getByRole("button", { name: "Send message" }).click()
    await expect(
      buyerMessages.getByRole("status").filter({
        hasText:
          "Message was accepted by Nostr delivery relays for merchant pickup and saved locally. Buyer relay backup needs retry.",
      })
    ).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => saved(buyerPage, buyer.pubkey, buyerReply), {
        timeout: 30_000,
      })
      .toEqual({ matches: 1, encrypted: true })
    await buyerPage.reload()
    await expect(buyerPage.getByLabel("Open account menu")).toBeVisible()
    await expect
      .poll(() => saved(buyerPage, buyer.pubkey, buyerReply), {
        timeout: 30_000,
      })
      .toEqual({ matches: 1, encrypted: true })
    const merchantWraps = await readAuthenticatedGiftWraps(
      merchant,
      TEST_RELAY_URL
    )
    expect(
      merchantWraps.filter((wrap) => {
        const rumor = parseCanonicalRuntimePrivateRumor({
          inboxOwner: merchant,
          recipient: merchant,
          sender: buyer,
          wrapperKeyAssignments: assignments,
          wrap,
        })
        return (
          rumor?.kind === 16 &&
          rumor.content.includes(buyerReply) &&
          rumor.tags.some(
            ([name, value]) => name === "order" && value === orderId
          ) &&
          rumor.tags.some(
            ([name, value]) => name === "type" && value === "message"
          )
        )
      })
    ).toHaveLength(1)
  } finally {
    await Promise.allSettled([buyerContext.close(), merchantContext.close()])
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
})

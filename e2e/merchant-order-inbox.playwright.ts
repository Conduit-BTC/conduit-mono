import { expect, test, type Page } from "@playwright/test"
import { getEventHash, nip19 } from "nostr-tools"
import { createWrap } from "nostr-tools/nip59"
import type { InboxProjection } from "@conduit/core/protocol/commerce-inbox-store"
import { publishTestRelayEvents, TEST_RELAY_URL } from "./helpers/auth"
import { prepareEmptyMerchantCatalog } from "./helpers/merchant-catalog"
import {
  observeMessagesDialogTrigger,
  recordSmokeDiagnostic,
  recordSmokeFailureContext,
} from "./helpers/smoke-diagnostics"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  encryptRuntimeTestPayload,
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
  const phase = (phase: string) =>
    recordSmokeDiagnostic(testInfo, "order-reply", { phase })
  phase("setup")
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
    for (const context of [buyerContext, merchantContext]) {
      await context.route(imageUrl, (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"/>',
        })
      )
    }
    const buyerPage = await buyerContext.newPage()
    const merchantPage = await merchantContext.newPage()
    await installRealTestSigner(buyerPage, buyer, TEST_RELAY_URL)
    await installRealTestSigner(merchantPage, merchant, TEST_RELAY_URL)

    const addProduct = await prepareEmptyMerchantCatalog(
      merchantPage,
      `${merchantUrl}/products`,
      (step) =>
        phase(step === "navigate" ? "merchant_navigate" : "merchant_catalog")
    )
    phase("merchant_open_dialog")
    await addProduct.click()
    const productDialog = merchantPage.getByRole("dialog", {
      name: "Add product",
    })
    phase("merchant_dialog")
    await expect(productDialog).toBeVisible()
    phase("merchant_form")
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
    phase("publish_product")
    await publishProduct.click()
    await expect(productDialog).toBeHidden({ timeout: 20_000 })

    phase("buyer_checkout")
    await buyerPage.goto(`${marketUrl}/${nip19.npubEncode(merchant.pubkey)}`)
    const product = buyerPage.getByRole("listitem").filter({ hasText: title })
    await expect(product).toBeVisible({ timeout: 30_000 })
    await product.getByRole("button", { name: /^Add .+ to cart$/ }).click()
    await buyerPage
      .getByRole("region", { name: "Cart inventory" })
      .getByRole("link", { name: "Continue to checkout" })
      .click()
    phase("send_order")
    await expect(
      buyerPage.getByRole("button", { name: "Send order" })
    ).toBeEnabled()
    await buyerPage
      .getByRole("button", { name: "Send order", exact: true })
      .click()
    await expect(buyerPage).toHaveURL(/\/orders\?order=/, { timeout: 30_000 })
    const orderId = new URL(buyerPage.url()).searchParams.get("order")
    if (!orderId) throw new Error("The order route has no order ID")

    phase("merchant_order")
    await merchantPage.goto(
      `${merchantUrl}/orders?order=${encodeURIComponent(orderId)}`
    )
    await expect(
      merchantPage
        .getByText(title, { exact: true })
        .filter({ visible: true })
        .first()
    ).toBeVisible({ timeout: 30_000 })
    phase("merchant_reply")
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

    const messages = merchantPage.getByRole("dialog", { name: "Messages" })
    const merchantTriggerProbe = await observeMessagesDialogTrigger(
      merchantPage
    ).catch(() => null)
    try {
      recordSmokeFailureContext(
        testInfo,
        "merchant_open_messages_click_completed"
      )
      const openMessages = merchantPage.getByRole("button", {
        name: "Open messages",
        exact: true,
      })
      await merchantPage.evaluate(() => document.fonts.ready)
      if (testInfo.project.use.hasTouch) await openMessages.tap()
      else await openMessages.click()
      recordSmokeFailureContext(
        testInfo,
        "merchant_open_messages_click_completed",
        "met"
      )
      recordSmokeFailureContext(testInfo, "merchant_messages_dialog_ready")
      await expect(messages).toBeVisible()
      recordSmokeFailureContext(
        testInfo,
        "merchant_messages_dialog_ready",
        "met"
      )
    } catch (error) {
      let observation: Record<string, number | boolean> = {
        observationAvailable: false,
      }
      try {
        if (merchantTriggerProbe)
          observation = await merchantTriggerProbe.evaluate((probe) =>
            probe.read()
          )
      } catch {
        // A diagnostic must not replace the original action/assertion failure.
      }
      recordSmokeDiagnostic(testInfo, "order-reply", {
        phase: "merchant_reply",
        ...observation,
      })
      throw error
    } finally {
      await merchantTriggerProbe
        ?.evaluate((probe) => probe.dispose())
        .catch(() => undefined)
      await merchantTriggerProbe?.dispose().catch(() => undefined)
    }
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
              ({ projection }: { projection: InboxProjection }) =>
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
    phase("merchant_restore")
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

    phase("buyer_delivery")
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

    phase("buyer_reply")
    recordSmokeFailureContext(testInfo, "buyer_account_ready")
    await buyerPage.reload()
    await expect(buyerPage.getByLabel("Open account menu")).toBeVisible()
    recordSmokeFailureContext(testInfo, "buyer_account_ready", "met")
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
    const buyerMessages = buyerPage.getByRole("dialog", { name: "Messages" })
    const buyerReply = `Accepted buyer reply ${Date.now().toString(36)}`
    const buyerTriggerProbe = await observeMessagesDialogTrigger(
      buyerPage
    ).catch(() => null)
    try {
      recordSmokeFailureContext(testInfo, "buyer_open_messages_click_completed")
      const openMessages = buyerPage.getByRole("button", {
        name: "Open messages",
        exact: true,
      })
      await buyerPage.evaluate(() => document.fonts.ready)
      if (testInfo.project.use.hasTouch) await openMessages.tap()
      else await openMessages.click()
      recordSmokeFailureContext(
        testInfo,
        "buyer_open_messages_click_completed",
        "met"
      )
      recordSmokeFailureContext(testInfo, "buyer_dialog_ready")
      await expect(buyerMessages).toBeVisible()
      const buyerDialogState = await buyerPage.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
        const input = dialog?.querySelector<HTMLInputElement>("input")
        const send = dialog?.querySelector<HTMLButtonElement>(
          'button[aria-label="Send message"]'
        )
        const visible = (element: HTMLElement | undefined | null) =>
          !!element &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility === "visible"
        return {
          dialogVisible: visible(dialog),
          inputPresent: !!input,
          inputVisible: visible(input),
          inputEnabled: !!input && !input.disabled,
          sendPresent: !!send,
          focusWithinDialog: !!dialog?.contains(document.activeElement),
        }
      })
      recordSmokeDiagnostic(testInfo, "order-reply", {
        phase: "buyer_dialog",
        ...buyerDialogState,
      })
      recordSmokeFailureContext(
        testInfo,
        "buyer_dialog_ready",
        buyerDialogState.dialogVisible && buyerDialogState.inputEnabled
          ? "met"
          : "unmet"
      )
      recordSmokeFailureContext(testInfo, "buyer_input_filled")
      await buyerMessages
        .getByRole("textbox", { name: "Message" })
        .fill(buyerReply)
      phase("buyer_input_filled")
      recordSmokeFailureContext(testInfo, "buyer_input_filled", "met")
    } catch (error) {
      let observation: Record<string, number | boolean> = {
        observationAvailable: false,
      }
      try {
        if (buyerTriggerProbe)
          observation = await buyerTriggerProbe.evaluate((probe) =>
            probe.read()
          )
      } catch {
        // A diagnostic must not replace the original action/assertion failure.
      }
      recordSmokeDiagnostic(testInfo, "order-reply", {
        phase: "buyer_dialog",
        ...observation,
      })
      throw error
    } finally {
      await buyerTriggerProbe
        ?.evaluate((probe) => probe.dispose())
        .catch(() => undefined)
      await buyerTriggerProbe?.dispose().catch(() => undefined)
    }
    recordSmokeFailureContext(testInfo, "buyer_send_clicked")
    await buyerMessages.getByRole("button", { name: "Send message" }).click()
    phase("buyer_send_clicked")
    recordSmokeFailureContext(testInfo, "buyer_send_clicked", "met")
    recordSmokeFailureContext(testInfo, "buyer_delivery_status_visible")
    await expect(
      buyerMessages.getByRole("status").filter({
        hasText:
          "Message was accepted by Nostr delivery relays for merchant pickup and saved locally. Buyer relay backup needs retry.",
      })
    ).toBeVisible({ timeout: 30_000 })
    phase("buyer_restore")
    recordSmokeFailureContext(testInfo, "buyer_delivery_status_visible", "met")
    recordSmokeFailureContext(testInfo, "buyer_reply_saved")
    await expect
      .poll(() => saved(buyerPage, buyer.pubkey, buyerReply), {
        timeout: 30_000,
      })
      .toEqual({ matches: 1, encrypted: true })
    recordSmokeFailureContext(testInfo, "buyer_reply_saved", "met")
    recordSmokeFailureContext(testInfo, "buyer_reply_saved")
    await buyerPage.reload()
    await expect(buyerPage.getByLabel("Open account menu")).toBeVisible()
    await expect
      .poll(() => saved(buyerPage, buyer.pubkey, buyerReply), {
        timeout: 30_000,
      })
      .toEqual({ matches: 1, encrypted: true })
    recordSmokeFailureContext(testInfo, "buyer_reply_saved", "met")
    phase("merchant_delivery")
    recordSmokeFailureContext(testInfo, "buyer_reply_relay_observed")
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
    recordSmokeFailureContext(testInfo, "buyer_reply_relay_observed", "met")
    phase("complete")
  } finally {
    await Promise.allSettled([buyerContext.close(), merchantContext.close()])
    disposeRuntimeSignerIdentity(buyer)
    disposeRuntimeSignerIdentity(merchant)
  }
})

test("Same-ID orders keep selection and encrypted replies bound to their participants after reload @commerce", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000)
  const identities = Array.from({ length: 4 }, () =>
    createRuntimeSignerIdentity()
  )
  const [buyer, merchant, otherMerchant, otherBuyer] = identities as [
    (typeof identities)[number],
    (typeof identities)[number],
    (typeof identities)[number],
    (typeof identities)[number],
  ]
  const labels = [
    "Collision Buyer A",
    "Collision Merchant A",
    "Collision Merchant B",
    "Collision Buyer B",
  ]
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        viewport: testInfo.project.use.viewport,
        isMobile: testInfo.project.use.isMobile,
        hasTouch: testInfo.project.use.hasTouch,
        userAgent: testInfo.project.use.userAgent,
      })
    )
  )
  const orderId = `shared-${Date.now().toString(36)}`
  const assignments = new Map<string, string>()
  try {
    const createdAt = Math.floor(Date.now() / 1000)
    await publishTestRelayEvents(
      identities.flatMap((identity, index) => [
        signRuntimeTestEvent(identity, {
          kind: 0,
          created_at: createdAt,
          tags: [],
          content: JSON.stringify({
            name: labels[index],
            display_name: labels[index],
          }),
        }),
        signRuntimeTestEvent(identity, {
          kind: 10050,
          created_at: createdAt,
          tags: [["relay", TEST_RELAY_URL]],
          content: "",
        }),
        signRuntimeTestEvent(identity, {
          kind: 10002,
          created_at: createdAt,
          tags: [["r", TEST_RELAY_URL]],
          content: "",
        }),
      ])
    )
    const wraps = []
    for (const [sender, receiver] of [
      [buyer, merchant],
      [buyer, otherMerchant],
      [otherBuyer, merchant],
    ] as const) {
      const draft = {
        kind: 16,
        pubkey: sender.pubkey,
        created_at: createdAt,
        tags: [
          ["p", receiver.pubkey],
          ["type", "order"],
          ["order", orderId],
        ],
        content: JSON.stringify({
          id: orderId,
          buyerPubkey: sender.pubkey,
          merchantPubkey: receiver.pubkey,
          items: [
            {
              productId: `30402:${receiver.pubkey}:collision`,
              quantity: 1,
              priceAtPurchase: 21,
              currency: "SATS",
              format: "digital",
              fulfillment: { type: "digital" },
            },
          ],
          subtotal: 21,
          currency: "SATS",
          shippingCostSats: 0,
          shippingCostStatus: "not_required",
          createdAt: createdAt * 1000,
        }),
      }
      const rumor = { ...draft, id: getEventHash(draft) }
      for (const recipient of [sender, receiver]) {
        const seal = signRuntimeTestEvent(sender, {
          kind: 13,
          created_at: createdAt,
          tags: [],
          content: encryptRuntimeTestPayload(
            sender,
            recipient.pubkey,
            JSON.stringify(rumor)
          ),
        })
        wraps.push(createWrap(seal, recipient.pubkey))
      }
    }
    await publishTestRelayEvents(wraps)
    const scenarios = [
      {
        app: "market",
        url: marketUrl,
        owner: buyer,
        first: merchant,
        target: otherMerchant,
        targetLabel: labels[2]!,
        context: contexts[0]!,
      },
      {
        app: "merchant",
        url: merchantUrl,
        owner: merchant,
        first: buyer,
        target: otherBuyer,
        targetLabel: labels[3]!,
        context: contexts[1]!,
      },
    ]
    for (const scenario of scenarios) {
      const page = await scenario.context.newPage()
      await installRealTestSigner(page, scenario.owner, TEST_RELAY_URL)
      await page.goto(
        `${scenario.url}/orders?order=${orderId}&counterparty=${scenario.first.pubkey}`
      )
      recordSmokeDiagnostic(testInfo, "order-reply", {
        phase: scenario.app === "market" ? "buyer_checkout" : "merchant_order",
      })
      await expect(
        page.getByLabel(
          scenario.app === "market"
            ? "Open account menu"
            : "Open merchant account menu"
        )
      ).toBeVisible()
      const count = () =>
        page.evaluate(
          async ({ root, principal, role }) => {
            const { getCommerceInbox } = await import(
              `${root}/commerce-inbox.ts`
            )
            const { projectCommerceInbox } = await import(`${root}/commerce.ts`)
            const owner = getCommerceInbox(principal)
            const projection = projectCommerceInbox(
              owner.getSnapshot(),
              principal
            )
            return (role === "market" ? projection.buyer : projection.merchant)
              .data.length
          },
          {
            root: protocolRoot,
            principal: scenario.owner.pubkey,
            role: scenario.app,
          }
        )
      try {
        await expect.poll(count, { timeout: 30_000 }).toBe(2)
      } catch (error) {
        const observation = await page.evaluate(
          async ({ root, principal }) => {
            const { getCommerceInbox } = await import(
              `${root}/commerce-inbox.ts`
            )
            const snapshot = getCommerceInbox(principal).getSnapshot()
            return {
              orderMessages: snapshot.orderMessages.length,
              distinctSenders: new Set(
                snapshot.orderMessages.map(
                  (message: { senderPubkey: string }) => message.senderPubkey
                )
              ).size,
              distinctRecipients: new Set(
                snapshot.orderMessages.map(
                  (message: { recipientPubkey: string }) =>
                    message.recipientPubkey
                )
              ).size,
              decryptFailures: snapshot.decryptFailures.length,
              pending: snapshot.pending,
              storageUnavailable: snapshot.diagnostics.storageUnavailable,
              queued: snapshot.diagnostics.states.queued ?? 0,
              opened: snapshot.diagnostics.states.opened ?? 0,
            }
          },
          { root: protocolRoot, principal: scenario.owner.pubkey }
        )
        recordSmokeDiagnostic(testInfo, "order-reply", {
          phase:
            scenario.app === "market" ? "buyer_delivery" : "merchant_order",
          ...observation,
        })
        throw error
      }
      const target = page
        .getByRole("button")
        .filter({ hasText: scenario.targetLabel, visible: true })
        .first()
      await expect(target).toBeVisible()
      await target.click()
      await expect
        .poll(() => new URL(page.url()).searchParams.get("counterparty"))
        .toBe(scenario.target.pubkey)
      recordSmokeDiagnostic(testInfo, "order-reply", {
        phase: scenario.app === "market" ? "buyer_restore" : "merchant_restore",
      })
      await page.reload()
      await expect(
        page.getByLabel(
          scenario.app === "market"
            ? "Open account menu"
            : "Open merchant account menu"
        )
      ).toBeVisible()
      await expect.poll(count, { timeout: 30_000 }).toBe(2)
      await expect(
        page.getByRole("button", { name: "Open messages", exact: true })
      ).toBeVisible()
      expect(new URL(page.url()).searchParams.get("counterparty")).toBe(
        scenario.target.pubkey
      )
      if (scenario.app === "market") {
        const browse = page.getByRole("button", { name: "Browse", exact: true })
        const compact = await browse.isVisible()
        const filterOrders = async (query: string) => {
          if (compact) await browse.click()
          await page
            .getByRole("searchbox", { name: "Search orders" })
            .filter({ visible: true })
            .fill(query)
          if (compact) {
            await page
              .getByRole("dialog", { name: "Your orders" })
              .getByRole("button", { name: "Close", exact: true })
              .click()
          }
        }
        // A filter must not replace the participant named in the restored URL.
        await filterOrders(scenario.first.pubkey)
        await expect(
          page.getByText("Select an order to view its status.", { exact: true })
        ).toBeVisible()
        await expect(
          page.getByRole("button", { name: "Open messages", exact: true })
        ).toHaveCount(0)
        expect(new URL(page.url()).searchParams.get("counterparty")).toBe(
          scenario.target.pubkey
        )
        await filterOrders("")
        await expect(
          page.getByRole("button", { name: "Open messages", exact: true })
        ).toBeVisible()
      }
      await page
        .getByRole("button", { name: "Open messages", exact: true })
        .click()
      const dialog = page.getByRole("dialog", { name: "Messages" })
      await expect(dialog).toBeVisible()
      const reply = `participant collision reply ${scenario.app}`
      await dialog.getByRole("textbox", { name: "Message" }).fill(reply)
      await dialog.getByRole("button", { name: "Send message" }).click()
      const deliveredReplies = async (
        recipient: typeof buyer,
        content = reply
      ) => {
        const received = await readAuthenticatedGiftWraps(
          recipient,
          TEST_RELAY_URL
        )
        return received.filter((wrap) => {
          const rumor = parseCanonicalRuntimePrivateRumor({
            inboxOwner: recipient,
            recipient,
            sender: scenario.owner,
            wrapperKeyAssignments: assignments,
            wrap,
          })
          return (
            rumor?.kind === 16 &&
            rumor.content.includes(content) &&
            rumor.tags.some(
              ([tag, value]) => tag === "order" && value === orderId
            )
          )
        }).length
      }
      await expect
        .poll(() => deliveredReplies(scenario.target), { timeout: 30_000 })
        .toBe(1)
      expect(await deliveredReplies(scenario.first)).toBe(0)
      if (scenario.app === "market") {
        // A single filtered thread exercises automatic selection with an opaque
        // tuple ID. An explicit colliding thread must survive URL restoration.
        await page.goto(
          `${marketUrl}/messages?tab=merchants&merchant=${scenario.first.pubkey}`
        )
        const composer = page.getByRole("textbox", {
          name: "Reply to merchant",
        })
        await expect(composer).toBeVisible()
        const firstThread = JSON.stringify([
          orderId,
          buyer.pubkey,
          scenario.first.pubkey,
        ])
        await expect
          .poll(() =>
            JSON.parse(new URL(page.url()).searchParams.get("thread") ?? "null")
          )
          .toBe(firstThread)
        const targetThread = JSON.stringify([
          orderId,
          buyer.pubkey,
          scenario.target.pubkey,
        ])
        await page.goto(
          `${marketUrl}/messages?tab=merchants&thread=${encodeURIComponent(JSON.stringify(targetThread))}`
        )
        await expect(composer).toBeVisible()
        await page.reload()
        await expect(composer).toBeVisible()
        expect(
          JSON.parse(new URL(page.url()).searchParams.get("thread") ?? "null")
        ).toBe(targetThread)
        const messageReply = "participant collision Messages reply"
        await composer.fill(messageReply)
        await page
          .getByRole("button", { name: "Send message", exact: true })
          .click()
        await expect(composer).toHaveValue("")
        await expect
          .poll(() => deliveredReplies(scenario.target, messageReply), {
            timeout: 30_000,
          })
          .toBe(1)
        expect(await deliveredReplies(scenario.first, messageReply)).toBe(0)
      }
      recordSmokeDiagnostic(testInfo, "order-reply", {
        phase: "complete",
      })
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    identities.forEach(disposeRuntimeSignerIdentity)
  }
})

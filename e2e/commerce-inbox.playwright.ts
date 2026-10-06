import { expect, test } from "@playwright/test"
import { getEventHash } from "nostr-tools/pure"
import { createWrap } from "nostr-tools/nip59"
import { publishTestRelayEvents } from "./helpers/auth"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  encryptRuntimeTestPayload,
  installRealTestSigner,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"

test.use({ trace: "off", screenshot: "off", video: "off" })

test("buyer and seller open tagged messages, reply, recover external records and reload encrypted state @commerce", async ({
  browser,
}, testInfo) => {
  const buyer = createRuntimeSignerIdentity()
  const seller = createRuntimeSignerIdentity()
  const relayUrl = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  const contextOptions = {
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
    userAgent: testInfo.project.use.userAgent,
  }
  const contexts = [
    await browser.newContext(contextOptions),
    await browser.newContext(contextOptions),
  ]
  try {
    const createdAt = Math.floor(Date.now() / 1000)
    await publishTestRelayEvents(
      [buyer, seller].flatMap((identity) => [
        signRuntimeTestEvent(identity, {
          kind: 10050,
          created_at: createdAt,
          tags: [["relay", relayUrl]],
          content: "",
        }),
        signRuntimeTestEvent(identity, {
          kind: 10002,
          created_at: createdAt,
          tags: [["r", relayUrl]],
          content: "",
        }),
      ])
    )
    const inner = {
      kind: 14,
      pubkey: buyer.pubkey,
      created_at: createdAt,
      tags: [["p", seller.pubkey]],
      content: "synthetic browser conversation",
    }
    const seal = signRuntimeTestEvent(buyer, {
      kind: 13,
      created_at: createdAt,
      tags: [["client", "Synthetic independent client"]],
      content: encryptRuntimeTestPayload(
        buyer,
        seller.pubkey,
        JSON.stringify({ ...inner, id: getEventHash(inner) })
      ),
    })
    const external = {
      ...inner,
      kind: 16,
      tags: [
        ["p", seller.pubkey],
        ["type", "999"],
        ["order", "synthetic-external"],
        ["subject", "external commerce"],
      ],
      content: "synthetic external note",
    }
    const externalSeal = signRuntimeTestEvent(buyer, {
      kind: 13,
      created_at: createdAt,
      tags: [],
      content: encryptRuntimeTestPayload(
        buyer,
        seller.pubkey,
        JSON.stringify({ ...external, id: getEventHash(external) })
      ),
    })
    const sentExternalSeal = signRuntimeTestEvent(buyer, {
      kind: 13,
      created_at: createdAt,
      tags: [],
      content: encryptRuntimeTestPayload(
        buyer,
        buyer.pubkey,
        JSON.stringify({ ...external, id: getEventHash(external) })
      ),
    })
    await publishTestRelayEvents([
      createWrap(seal, seller.pubkey),
      createWrap(externalSeal, seller.pubkey),
      createWrap(sentExternalSeal, buyer.pubkey),
    ])
    const buyerPage = await contexts[0]!.newPage()
    const sellerPage = await contexts[1]!.newPage()
    await installRealTestSigner(buyerPage, buyer, relayUrl)
    await installRealTestSigner(sellerPage, seller, relayUrl)
    const root = `/@fs${process.cwd()}/packages/core/src/protocol`
    const counts = async (page: typeof sellerPage) =>
      await page.evaluate(async (path) => {
        const { readAuthSession } = await import(`${path}/remote-signer.ts`)
        const { getCommerceInbox } = await import(`${path}/commerce-inbox.ts`)
        const owner = getCommerceInbox(readAuthSession().userPubkey)
        await owner.syncRecent()
        const view = owner.getSnapshot()
        return {
          direct: view.directMessages.length,
          external: view.externalRecords.length,
          orders: view.orderMessages.length,
          storageFailed: view.diagnostics.storageUnavailable,
          compatibility: view.diagnostics.clientSealMetadataAccepted,
        }
      }, root)
    await sellerPage.goto(
      `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}/messages`
    )
    await expect(
      sellerPage.getByLabel("Open merchant account menu")
    ).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => (await counts(sellerPage)).direct, { timeout: 30_000 })
      .toBe(1)
    expect(await counts(sellerPage)).toMatchObject({
      external: 1,
      orders: 0,
      storageFailed: false,
      compatibility: 1,
    })
    const thread = sellerPage
      .getByRole("button")
      .filter({ hasText: "synthetic browser conversation" })
      .first()
    await thread.click()
    const composer = sellerPage.getByRole("textbox", { name: "Message" })
    await expect(composer).toBeVisible()
    await composer.fill("synthetic seller reply")
    await sellerPage
      .getByRole("button", { name: "Send message", exact: true })
      .click()
    await expect
      .poll(async () => (await counts(sellerPage)).direct, { timeout: 30_000 })
      .toBe(2)
    await buyerPage.goto(
      `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}/messages?tab=dms`
    )
    await expect(buyerPage.getByLabel("Open account menu")).toBeVisible({
      timeout: 15_000,
    })
    await expect
      .poll(async () => (await counts(buyerPage)).direct, { timeout: 30_000 })
      .toBe(1)
    await buyerPage
      .getByRole("button")
      .filter({ hasText: "synthetic seller reply" })
      .first()
      .click()
    await expect(
      buyerPage.getByText("synthetic seller reply", { exact: true }).last()
    ).toBeVisible()
    const buyerComposer = buyerPage.getByRole("textbox", { name: "Message" })
    await buyerComposer.fill("synthetic buyer response")
    await buyerPage
      .getByRole("button", { name: "Send message", exact: true })
      .click()
    await expect
      .poll(async () => (await counts(sellerPage)).direct, { timeout: 30_000 })
      .toBe(3)
    await sellerPage
      .getByText("External commerce records (1)", { exact: true })
      .click()
    await sellerPage
      .getByLabel("Search external commerce records")
      .fill("synthetic-external")
    await expect(
      sellerPage.getByRole("button", { name: "Inspect and reply" })
    ).toHaveCount(1)
    await sellerPage.getByRole("button", { name: "Inspect and reply" }).click()
    await sellerPage
      .getByLabel("Local order association")
      .fill("synthetic-local-order")
    await sellerPage
      .getByRole("button", { name: "Associate locally", exact: true })
      .click()
    await expect(
      sellerPage.getByText("Locally associated with synthetic-local-order", {
        exact: true,
      })
    ).toBeVisible()
    const recovery = sellerPage.getByRole("region", {
      name: "Inbox history and recovery",
    })
    await recovery
      .getByRole("textbox", { name: "Message" })
      .fill("synthetic external reply")
    await recovery
      .getByRole("button", { name: "Send message", exact: true })
      .click()
    await expect
      .poll(async () => (await counts(buyerPage)).direct, { timeout: 30_000 })
      .toBe(3)
    expect((await counts(sellerPage)).orders).toBe(0)
    await buyerPage
      .getByText("External commerce records (1)", { exact: true })
      .click()
    await buyerPage.getByRole("button", { name: "Inspect and reply" }).click()
    const sentRecovery = buyerPage.getByRole("region", {
      name: "Inbox history and recovery",
    })
    await sentRecovery
      .getByRole("textbox", { name: "Message" })
      .fill("synthetic buyer response to sent record")
    await sentRecovery
      .getByRole("button", { name: "Send message", exact: true })
      .click()
    await expect
      .poll(async () => (await counts(sellerPage)).direct, { timeout: 30_000 })
      .toBe(5)
    await sellerPage.reload()
    await expect(
      sellerPage.getByLabel("Open merchant account menu")
    ).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => (await counts(sellerPage)).direct, { timeout: 30_000 })
      .toBe(5)
    const safe = await sellerPage.evaluate(async (path) => {
      const { db } = await import(
        `${path.replace("/protocol", "")}/db/index.ts`
      )
      const rows = await db.commerceInboxRecords.toArray()
      return {
        encrypted: rows.every(
          (row: { value: { bytes: unknown }; content?: unknown }) =>
            row.value.bytes instanceof ArrayBuffer && row.content === undefined
        ),
        oldPlaintext:
          (await db.messages.count()) + (await db.orderMessages.count()),
      }
    }, root)
    expect(safe).toEqual({ encrypted: true, oldPlaintext: 0 })
    // Reconnect the same principal without reloading: the hook must subscribe to
    // the new session owner rather than remain attached to the retired owner.
    await buyerPage.getByLabel("Open account menu").click()
    await buyerPage
      .getByRole("menuitem", { name: "Disconnect", exact: true })
      .click()
    const connect = buyerPage
      .getByRole("button", { name: "Connect", exact: true })
      .first()
    await expect(connect).toBeVisible()
    await expect(
      buyerPage.getByRole("textbox", { name: "Message" })
    ).toHaveCount(0)
    await connect.click()
    await buyerPage
      .getByRole("button", {
        name: /Reconnect your account|Connect Extension \(NIP-07\)|Continue with browser signer/i,
      })
      .first()
      .click()
    await expect(buyerPage.getByLabel("Open account menu")).toBeVisible()
    const restoredConversation = buyerPage
      .getByRole("button")
      .filter({
        hasText: /synthetic (buyer response|external reply|seller reply)/,
      })
      .first()
    await expect(restoredConversation).toBeVisible({ timeout: 30_000 })
    await restoredConversation.click()
    await expect(
      buyerPage.getByText("synthetic external reply", { exact: true }).last()
    ).toBeVisible()
  } finally {
    try {
      await Promise.all(contexts.map((context) => context.close()))
    } finally {
      disposeRuntimeSignerIdentity(buyer)
      disposeRuntimeSignerIdentity(seller)
    }
  }
})

test("extra authenticated recipients cannot expand buyer or merchant replies @commerce", async ({
  browser,
}, testInfo) => {
  const buyer = createRuntimeSignerIdentity()
  const seller = createRuntimeSignerIdentity()
  const extra = createRuntimeSignerIdentity()
  const relayUrl = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  const contexts = []
  try {
    const createdAt = Math.floor(Date.now() / 1000)
    await publishTestRelayEvents(
      [buyer, seller, extra].flatMap((identity) => [
        signRuntimeTestEvent(identity, {
          kind: 10050,
          created_at: createdAt,
          tags: [["relay", relayUrl]],
          content: "",
        }),
        signRuntimeTestEvent(identity, {
          kind: 10002,
          created_at: createdAt,
          tags: [["r", relayUrl]],
          content: "",
        }),
      ])
    )
    for (const app of ["market", "merchant"] as const) {
      const recipient = app === "market" ? buyer : seller
      const sender = app === "market" ? seller : buyer
      const rumor = {
        kind: 14,
        pubkey: sender.pubkey,
        created_at: createdAt,
        tags: [
          ["p", recipient.pubkey],
          ["p", extra.pubkey],
        ],
        content: "synthetic extra recipient input",
      }
      const seal = signRuntimeTestEvent(sender, {
        kind: 13,
        created_at: createdAt,
        tags: [],
        content: encryptRuntimeTestPayload(
          sender,
          recipient.pubkey,
          JSON.stringify({ ...rumor, id: getEventHash(rumor) })
        ),
      })
      await publishTestRelayEvents([createWrap(seal, recipient.pubkey)])
      const context = await browser.newContext({
        viewport: testInfo.project.use.viewport,
        isMobile: testInfo.project.use.isMobile,
        hasTouch: testInfo.project.use.hasTouch,
        userAgent: testInfo.project.use.userAgent,
      })
      contexts.push(context)
      const page = await context.newPage()
      await installRealTestSigner(page, recipient, relayUrl)
      const port =
        app === "market"
          ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
          : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
      await page.goto(
        `http://127.0.0.1:${port}/messages${app === "market" ? "?tab=dms" : ""}`
      )
      const thread = page
        .getByRole("button")
        .filter({ hasText: "synthetic extra recipient input" })
        .first()
      await expect(thread).toBeVisible({ timeout: 30_000 })
      await thread.click()
      await page
        .getByRole("textbox", { name: "Message" })
        .fill("synthetic two-party reply")
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click()
      await expect
        .poll(
          async () =>
            await page.evaluate(
              async ({ root, disallowed, peer }) => {
                const { readAuthSession } = await import(
                  `${root}/remote-signer.ts`
                )
                const { getCommerceInbox } = await import(
                  `${root}/commerce-inbox.ts`
                )
                const owner = getCommerceInbox(readAuthSession().userPubkey)
                const rows = await owner.store.database.commerceInboxDeliveries
                  .where("accountPubkey")
                  .equals(owner.store.principal)
                  .toArray()
                const jobs = await Promise.all(
                  rows.map((row: { value: unknown; id: string }) =>
                    owner.store.open(
                      row.value,
                      row.id.slice(owner.store.principal.length + 1)
                    )
                  )
                )
                const legs = jobs.flatMap(
                  (job: {
                    legs: Array<{
                      recipientPubkey: string
                      acknowledged: string[]
                    }>
                  }) => job.legs
                )
                return {
                  acceptedByPeer: legs.some(
                    (leg: {
                      recipientPubkey: string
                      acknowledged: string[]
                    }) =>
                      leg.recipientPubkey === peer &&
                      leg.acknowledged.length > 0
                  ),
                  unapprovedRecipients: legs.filter(
                    (leg: { recipientPubkey: string }) =>
                      leg.recipientPubkey === disallowed
                  ).length,
                }
              },
              {
                root: `/@fs${process.cwd()}/packages/core/src/protocol`,
                disallowed: extra.pubkey,
                peer: sender.pubkey,
              }
            ),
          { timeout: 30_000 }
        )
        .toEqual({ acceptedByPeer: true, unapprovedRecipients: 0 })
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    for (const identity of [buyer, seller, extra])
      disposeRuntimeSignerIdentity(identity)
  }
})

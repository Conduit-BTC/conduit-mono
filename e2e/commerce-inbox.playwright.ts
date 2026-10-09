import { expect, test } from "@playwright/test"
import { getEventHash } from "nostr-tools/pure"
import { createWrap } from "nostr-tools/nip59"
import type { InboxProjection } from "../packages/core/src/protocol/commerce-inbox-store"
import { publishTestRelayEvents } from "./helpers/auth"
import { interceptBlossom } from "./helpers/blossom"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  encryptRuntimeTestPayload,
  installRealTestSigner,
  parseCanonicalRuntimePrivateRumor,
  readAuthenticatedGiftWraps,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"

test.use({ trace: "off", screenshot: "off", video: "off" })

test("buyer and seller retain conversations and files through self-copy failure, reload and reconnect @commerce", async ({
  browser,
}, testInfo) => {
  const buyer = createRuntimeSignerIdentity()
  const seller = createRuntimeSignerIdentity()
  const mediaServer = "https://cdn.conduit.market"
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
        signRuntimeTestEvent(identity, {
          kind: 10063,
          created_at: createdAt,
          tags: [["server", mediaServer]],
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
    await interceptBlossom(buyerPage, mediaServer, {
      resourcePathPrefix: "private-fixture",
    })
    await interceptBlossom(sellerPage, mediaServer, {
      resourcePathPrefix: "private-fixture",
    })
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
    await sellerPage
      .getByRole("button")
      .filter({
        hasText: /synthetic (buyer response|external reply|seller reply)/,
      })
      .first()
      .click()
    for (const [page, sender, recipient] of [
      [buyerPage, buyer, seller],
      [sellerPage, seller, buyer],
    ] as const) {
      // Reject only optional sender self encryption after real recipient delivery.
      await page.evaluate((principal) => {
        const provider = (
          window as unknown as {
            nostr: {
              nip44: {
                encrypt: (peer: string, text: string) => Promise<string>
              }
            }
          }
        ).nostr.nip44
        const encrypt = provider.encrypt.bind(provider)
        provider.encrypt = async (peer, text) => {
          if (peer === principal) throw new Error("Synthetic self-copy refusal")
          return encrypt(peer, text)
        }
      }, sender.pubkey)
      const text = `synthetic ${sender === buyer ? "buyer" : "seller"} self-copy text`
      const savedText = async () =>
        await page.evaluate(
          async ({ root, principal, text }) => {
            const { getCommerceInbox } = await import(
              `${root}/commerce-inbox.ts`
            )
            const owner = getCommerceInbox(principal)
            return (await owner.store.projections()).filter(
              ({ projection }: { projection: InboxProjection }) =>
                projection.kind === "direct" &&
                projection.message.senderPubkey === principal &&
                projection.message.content === text
            ).length
          },
          { root, principal: sender.pubkey, text }
        )
      await page.getByRole("textbox", { name: "Message" }).fill(text)
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click()
      await expect(
        page.getByRole("status").filter({
          hasText:
            "Reply sent and saved on this device. Sync to your other devices is incomplete.",
        })
      ).toBeVisible({ timeout: 30_000 })
      await expect.poll(savedText).toBe(1)
      await page.getByLabel("Choose an encrypted attachment").setInputFiles({
        name: "synthetic.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("synthetic encrypted attachment"),
      })
      await expect(
        page.getByRole("status").filter({
          hasText:
            "Attachment sent and saved on this device. Sync to your other devices is incomplete.",
        })
      ).toBeVisible({ timeout: 30_000 })
      const savedFile = async () =>
        page.evaluate(
          async ({ root, principal }) => {
            const { getCommerceInbox } = await import(
              `${root}/commerce-inbox.ts`
            )
            const { downloadAndDecryptPrivateFile } = await import(
              `${root}/private-file-message.ts`
            )
            const owner = getCommerceInbox(principal)
            const files = (await owner.store.projections()).flatMap(
              ({ projection }: { projection: InboxProjection }) =>
                projection.kind === "direct" &&
                projection.message.senderPubkey === principal &&
                projection.message.file
                  ? [projection.message.file]
                  : []
            )
            const file = files[0]
            if (
              !file ||
              file.algorithm !== "aes-gcm" ||
              !file.key ||
              !file.nonce ||
              !file.encryptedSha256
            )
              return { count: files.length, decrypts: false }
            const bytes = await downloadAndDecryptPrivateFile(
              file.url,
              {
                algorithm: file.algorithm,
                key: file.key,
                nonce: file.nonce,
                encryptedSha256: file.encryptedSha256,
                originalSha256: file.originalSha256,
                encryptedSize: Number(file.size),
              },
              (url: string) => fetch(url)
            )
            return {
              count: files.length,
              decrypts:
                new TextDecoder().decode(bytes) ===
                "synthetic encrypted attachment",
            }
          },
          { root, principal: sender.pubkey }
        )
      await expect.poll(savedFile).toEqual({ count: 1, decrypts: true })
      await page.reload()
      await expect(
        page.getByLabel(
          sender === buyer ? "Open account menu" : "Open merchant account menu"
        )
      ).toBeVisible()
      await expect.poll(savedFile).toEqual({ count: 1, decrypts: true })
      await expect.poll(savedText).toBe(1)
      const wraps = await readAuthenticatedGiftWraps(recipient, relayUrl)
      expect(
        wraps.filter(
          (wrap) =>
            parseCanonicalRuntimePrivateRumor({
              inboxOwner: recipient,
              recipient,
              sender,
              rumorKind: 14,
              wrap,
            })?.content === text
        ).length
      ).toBe(1)
      expect(
        wraps.filter(
          (wrap) =>
            parseCanonicalRuntimePrivateRumor({
              inboxOwner: recipient,
              recipient,
              sender,
              rumorKind: 15,
              wrap,
            })?.kind === 15
        ).length
      ).toBe(1)
    }
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
  const merchantOwner = createRuntimeSignerIdentity()
  const merchantPeer = createRuntimeSignerIdentity()
  const extra = createRuntimeSignerIdentity()
  const identities = [buyer, seller, merchantOwner, merchantPeer, extra]
  const relayUrl = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  const contexts = []
  try {
    const createdAt = Math.floor(Date.now() / 1000)
    await publishTestRelayEvents(
      identities.flatMap((identity) => [
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
      const recipient = app === "market" ? buyer : merchantOwner
      const sender = app === "market" ? seller : merchantPeer
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
                  // Reload tests the encrypted projection, not an optimistic bubble.
                  retainedReply: (await owner.store.projections()).some(
                    ({ projection }: { projection: InboxProjection }) =>
                      projection.kind === "direct" &&
                      projection.message.senderPubkey ===
                        owner.store.principal &&
                      projection.message.recipientPubkey === peer &&
                      projection.message.content === "synthetic two-party reply"
                  ),
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
        .toEqual({
          retainedReply: true,
          acceptedByPeer: true,
          unapprovedRecipients: 0,
        })
      const conversation = page
        .locator("main span")
        .filter({ hasText: /^synthetic extra recipient input$/ })
      await expect(conversation).toBeVisible()
      await expect(
        page
          .locator("main span")
          .filter({ hasText: /^synthetic two-party reply$/ })
      ).toBeVisible()
      await page.reload()
      const restoredThread = page
        .getByRole("button")
        .filter({ hasText: "synthetic two-party reply", visible: true })
      await expect(restoredThread).toHaveCount(1)
      await restoredThread.click()
      await expect(
        page
          .locator("main span")
          .filter({ hasText: /^synthetic extra recipient input$/ })
      ).toBeVisible()
      await expect(
        page
          .locator("main span")
          .filter({ hasText: /^synthetic two-party reply$/ })
      ).toBeVisible()
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()))
    for (const identity of identities) disposeRuntimeSignerIdentity(identity)
  }
})

test("domain persistence rejection leaves no generic delivery to retry @commerce", async ({
  page,
}) => {
  const sender = createRuntimeSignerIdentity()
  const peer = createRuntimeSignerIdentity()
  const relayUrl = `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  const createdAt = Math.floor(Date.now() / 1_000)
  const senderDeclaration = signRuntimeTestEvent(sender, {
    kind: 10050,
    created_at: createdAt,
    tags: [["relay", relayUrl]],
    content: "",
  })
  const recipientDeclaration = signRuntimeTestEvent(peer, {
    kind: 10050,
    created_at: createdAt,
    tags: [["relay", relayUrl]],
    content: "",
  })
  try {
    await publishTestRelayEvents([senderDeclaration, recipientDeclaration])
    await installRealTestSigner(page, sender, relayUrl)
    await page.goto(
      `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}/messages?tab=dms`
    )
    await expect(page.getByLabel("Open account menu")).toBeVisible({
      timeout: 15_000,
    })
    const evidence = await page.evaluate(
      async ({
        root,
        principal,
        recipient,
        relay,
        senderDeclaration,
        recipientDeclaration,
      }) => {
        const { getCommerceInbox } = await import(`${root}/commerce-inbox.ts`)
        const { getAccountSigner } = await import(`${root}/session-signer.ts`)
        const { createParticipantMessageRumor, publishPrivateMessage } =
          await import(`${root}/messaging.ts`)
        const { retryPrivateDeliveries, resumePrivateDelivery } = await import(
          `${root}/private-message-delivery.ts`
        )
        const { createInMemoryInboxDeclarationEvidenceRepository } =
          await import(`${root}/inbox-declaration-evidence.ts`)
        const { resolveInboxDeclaration } = await import(
          `${root}/private-message-routing.ts`
        )
        const owner = getCommerceInbox(principal)
        await owner.initialize()
        const inboxDeclarationEvidenceRepository =
          createInMemoryInboxDeclarationEvidenceRepository()
        const resolveDeclaration = async (pubkey: string) => {
          const declaration = await resolveInboxDeclaration(pubkey, {
            relayUrls: [relay],
            evidenceRepository: inboxDeclarationEvidenceRepository,
            allowLocalRelayUrlsForPubkey:
              pubkey === principal ? principal : null,
            requestingAccountPubkey: principal,
            authenticatedPubkey: principal,
          })
          if (declaration.state !== "declared" || !declaration.eventId)
            throw new Error(
              `Signed inbox declaration evidence is unavailable (${declaration.state}; ${declaration.relayUrls.join(",")})`
            )
          return declaration
        }
        await resolveDeclaration(principal)
        await resolveDeclaration(recipient)
        const rumor = createParticipantMessageRumor({
          senderPubkey: principal,
          recipientPubkeys: [recipient],
          content: "synthetic domain boundary",
          appId: "market",
        })
        let publishes = 0
        const publisher = async (
          _event: unknown,
          options: { exclusiveRelayUrls: string[] }
        ) => {
          if (
            options.exclusiveRelayUrls.length !== 1 ||
            options.exclusiveRelayUrls[0] !== relay
          )
            throw new Error("Unexpected private delivery relay target")
          publishes++
          return {
            plan: {},
            attemptedRelayUrls: options.exclusiveRelayUrls,
            successfulRelayUrls: options.exclusiveRelayUrls,
            failedRelayUrls: [],
            relayFailureMessages: {},
          }
        }
        const input = {
          rumor,
          senderPubkey: principal,
          recipientPubkey: recipient,
          accountPubkey: principal,
          authenticatedPubkey: principal,
          signer: getAccountSigner(),
          rumorKind: 14,
          selfCopy: true,
          inboxDeclarationEvidenceRepository,
          publishFn: publisher,
        }
        let rejected = false
        try {
          await publishPrivateMessage({
            ...input,
            onWrapped: async () => {
              throw new Error("synthetic domain persistence rejection")
            },
          })
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "synthetic domain persistence rejection"
          )
            throw error
          rejected = true
        }
        const rows =
          await owner.store.database.commerceInboxDeliveries.toArray()
        // Make any abandoned job eligible without waiting for its lease.
        for (const row of rows)
          await owner.store.database.commerceInboxDeliveries.update(row.id, {
            claim: undefined,
          })
        await retryPrivateDeliveries(
          principal,
          publisher,
          undefined,
          owner.store,
          resolveDeclaration,
          { inboxDeclarationEvidenceRepository }
        )
        const resumedRejected = await resumePrivateDelivery(
          owner.store,
          rumor.id,
          recipient,
          publisher
        )
        const rejectedEvidence = {
          rejected,
          abandonedJobs: rows.length,
          resumed: !!resumedRejected,
          publishes,
        }
        if (rows.length)
          return {
            rejectedEvidence,
            successfulBoundary: false,
            exactRetry: false,
          }
        let persisted: {
          wrappedToRecipient: { id: string }
          wrappedToSelf: { id: string } | null
        } | null = null
        try {
          await publishPrivateMessage({
            ...input,
            onWrapped: async (prepared: typeof persisted) => {
              persisted = prepared
            },
            publishFn: async () => {
              throw new Error("synthetic transport interruption")
            },
          })
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "synthetic transport interruption"
          )
            throw error
        }
        const jobs =
          await owner.store.database.commerceInboxDeliveries.toArray()
        let exactRetry = true
        let retried = 0
        await retryPrivateDeliveries(
          principal,
          async (
            event: { id: string },
            options: { exclusiveRelayUrls: string[] }
          ) => {
            retried++
            exactRetry &&=
              !!persisted &&
              [persisted.wrappedToRecipient, persisted.wrappedToSelf].some(
                (saved) => JSON.stringify(saved) === JSON.stringify(event)
              )
            return publisher(event, options)
          },
          undefined,
          owner.store,
          resolveDeclaration,
          { inboxDeclarationEvidenceRepository }
        )
        const resumed = await resumePrivateDelivery(
          owner.store,
          rumor.id,
          recipient,
          publisher
        )
        return {
          rejectedEvidence,
          successfulBoundary: !!persisted && jobs.length === 1 && !!resumed,
          exactRetry: exactRetry && retried === 1,
        }
      },
      {
        root: `/@fs${process.cwd()}/packages/core/src/protocol`,
        principal: sender.pubkey,
        recipient: peer.pubkey,
        relay: relayUrl,
        senderDeclaration,
        recipientDeclaration,
      }
    )
    expect(evidence).toEqual({
      rejectedEvidence: {
        rejected: true,
        abandonedJobs: 0,
        resumed: false,
        publishes: 0,
      },
      successfulBoundary: true,
      exactRetry: true,
    })
  } finally {
    disposeRuntimeSignerIdentity(sender)
    disposeRuntimeSignerIdentity(peer)
  }
})

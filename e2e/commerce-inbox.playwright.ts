import {
  expect,
  test,
  type Browser,
  type Page,
  type Locator,
  type TestInfo,
} from "@playwright/test"
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
import { inspectCommerceUi } from "./helpers/shared-ui-evidence"
import { recordSmokeDiagnostic } from "./helpers/smoke-diagnostics"

test.use({ trace: "off", screenshot: "off", video: "off" })

test("buyer and seller retain external conversations and local associations through reload @commerce", async ({
  browser,
}, info) => {
  await exerciseInboxScenario(browser, info, "history")
})
test("buyer retains messages and encrypted files through reconnect, self-copy failure and reload @commerce", async ({
  browser,
}, info) => {
  await exerciseInboxScenario(browser, info, "buyer-self-copy")
})
test("seller retains messages and encrypted files through self-copy failure and reload @commerce", async ({
  browser,
}, info) => {
  await exerciseInboxScenario(browser, info, "seller-self-copy")
})

async function activateInboxControl(control: Locator, info: TestInfo) {
  await control.evaluate((element) =>
    element.scrollIntoView({ behavior: "instant", block: "center" })
  )
  if (info.project.use.hasTouch) await control.tap()
  else await control.click()
}

async function reconnectBuyer(page: Page, testInfo: TestInfo) {
  const accountMenu = page.getByLabel("Open account menu")
  // Finish the programmatic scroll before the menu's pointer-down handler runs.
  // A moving trigger can leave pointer-up and click on the page behind it.
  await accountMenu.evaluate((element) =>
    element.scrollIntoView({ behavior: "instant", block: "center" })
  )
  await activateInboxControl(accountMenu, testInfo)
  await activateInboxControl(
    page.getByRole("menuitem", { name: "Disconnect", exact: true }),
    testInfo
  )
  const connect = page
    .getByRole("button", { name: "Connect", exact: true })
    .first()
  await expect(connect).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0)
  await activateInboxControl(connect, testInfo)
  await activateInboxControl(
    page
      .getByRole("button", {
        name: /Reconnect your account|Connect Extension \(NIP-07\)|Continue with browser signer/i,
      })
      .first(),
    testInfo
  )
  await expect(page.getByLabel("Open account menu")).toBeVisible()
}

// History/reconnect and optional self-copy recovery are independent contracts.
// Each starts with real encrypted relay history and keeps the normal case budget.
async function exerciseInboxScenario(
  browser: Browser,
  testInfo: TestInfo,
  scenario: "history" | "buyer-self-copy" | "seller-self-copy"
) {
  const startedAt = Date.now()
  type SelfCopyPhase =
    | "setup_complete"
    | "reconnect_complete"
    | "loop_enter"
    | "before_send"
    | "send_completed"
    | "status_visible"
    | "text_persisted"
    | "before_attachment"
    | "attachment_completed"
    | "attachment_status_visible"
    | "file_persisted"
    | "complete"
  type SelfCopyPrincipal = "none" | "buyer" | "seller"
  let selfCopyDiagnostic: Record<string, unknown> | undefined
  const selfCopyCheckpoint = (
    phase: SelfCopyPhase,
    principal: SelfCopyPrincipal,
    clickStarted = false,
    clickResolved = false,
    extra: Record<string, boolean> = {}
  ) => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10
    selfCopyDiagnostic = {
      phase,
      principal,
      elapsedSeconds,
      nearCaseDeadline: elapsedSeconds >= 25,
      caseDeadlinePassed: elapsedSeconds >= 30,
      clickStarted,
      clickResolved,
      observationAvailable: false,
      ...extra,
    }
    recordSmokeDiagnostic(
      testInfo,
      "commerce-inbox-self-copy",
      selfCopyDiagnostic
    )
  }
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
    const counts = async (
      page: typeof sellerPage,
      refresh: false | "initial" | "fresh" = false
    ) =>
      await page.evaluate(
        async ({ path, refresh }) => {
          const { readAuthSession } = await import(`${path}/auth-session.ts`)
          const { getCommerceInbox } = await import(`${path}/commerce-inbox.ts`)
          const owner = getCommerceInbox(readAuthSession().userPubkey)
          // Read after the sender's durable result, then let assertions observe.
          // An explicit refresh queues behind any older in-flight read.
          if (refresh === "initial") await owner.syncRecent()
          if (refresh === "fresh") await owner.refreshRecent()
          const view = owner.getSnapshot()
          return {
            direct: view.directMessages.length,
            external: view.externalRecords.length,
            orders: view.orderMessages.length,
            storageFailed: view.diagnostics.storageUnavailable,
            compatibility: view.diagnostics.clientSealMetadataAccepted,
          }
        },
        { path: root, refresh }
      )
    selfCopyCheckpoint("setup_complete", "none")
    if (scenario === "history") {
      await Promise.all([
        sellerPage.goto(
          `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}/messages`
        ),
        buyerPage.goto(
          `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}/messages?tab=dms`
        ),
      ])
      await expect(
        sellerPage.getByLabel("Open merchant account menu")
      ).toBeVisible({ timeout: 15_000 })
      await counts(sellerPage, "initial")
      await expect
        .poll(async () => (await counts(sellerPage)).direct, {
          timeout: 30_000,
        })
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
      await activateInboxControl(thread, testInfo)
      const composer = sellerPage.getByRole("textbox", { name: "Message" })
      await expect(composer).toBeVisible()
      await composer.fill("synthetic seller reply")
      await activateInboxControl(
        sellerPage.getByRole("button", { name: "Send message", exact: true }),
        testInfo
      )
      await expect
        .poll(async () => (await counts(sellerPage)).direct, {
          timeout: 30_000,
        })
        .toBe(2)
      await expect(buyerPage.getByLabel("Open account menu")).toBeVisible({
        timeout: 15_000,
      })
      await counts(buyerPage, "fresh")
      await expect
        .poll(async () => (await counts(buyerPage)).direct, { timeout: 30_000 })
        .toBe(1)
      await activateInboxControl(
        buyerPage
          .getByRole("button")
          .filter({ hasText: "synthetic seller reply" })
          .first(),
        testInfo
      )
      await expect(
        buyerPage.getByText("synthetic seller reply", { exact: true }).last()
      ).toBeVisible()
      await inspectCommerceUi(buyerPage, testInfo, "buyer-populated-inbox")
      await inspectCommerceUi(sellerPage, testInfo, "merchant-populated-inbox")
      const buyerComposer = buyerPage.getByRole("textbox", { name: "Message" })
      await buyerComposer.fill("synthetic buyer response")
      await activateInboxControl(
        buyerPage.getByRole("button", { name: "Send message", exact: true }),
        testInfo
      )
      await expect.poll(async () => (await counts(buyerPage)).direct).toBe(2)
      await counts(sellerPage, "fresh")
      await expect
        .poll(async () => (await counts(sellerPage)).direct, {
          timeout: 30_000,
        })
        .toBe(3)
      await activateInboxControl(
        sellerPage.getByText("External commerce records (1)", { exact: true }),
        testInfo
      )
      await sellerPage
        .getByLabel("Search external commerce records")
        .fill("synthetic-external")
      await expect(
        sellerPage.getByRole("button", { name: "Inspect and reply" })
      ).toHaveCount(1)
      await activateInboxControl(
        sellerPage.getByRole("button", { name: "Inspect and reply" }),
        testInfo
      )
      await sellerPage
        .getByLabel("Local order association")
        .fill("synthetic-local-order")
      await activateInboxControl(
        sellerPage.getByRole("button", {
          name: "Associate locally",
          exact: true,
        }),
        testInfo
      )
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
      await activateInboxControl(
        recovery.getByRole("button", { name: "Send message", exact: true }),
        testInfo
      )
      await expect.poll(async () => (await counts(sellerPage)).direct).toBe(4)
      await counts(buyerPage, "fresh")
      await expect
        .poll(async () => (await counts(buyerPage)).direct, { timeout: 30_000 })
        .toBe(3)
      expect((await counts(sellerPage)).orders).toBe(0)
      await activateInboxControl(
        buyerPage.getByText("External commerce records (1)", { exact: true }),
        testInfo
      )
      await activateInboxControl(
        buyerPage.getByRole("button", { name: "Inspect and reply" }),
        testInfo
      )
      const sentRecovery = buyerPage.getByRole("region", {
        name: "Inbox history and recovery",
      })
      await sentRecovery
        .getByRole("textbox", { name: "Message" })
        .fill("synthetic buyer response to sent record")
      await activateInboxControl(
        sentRecovery.getByRole("button", { name: "Send message", exact: true }),
        testInfo
      )
      await expect.poll(async () => (await counts(buyerPage)).direct).toBe(4)
      await counts(sellerPage, "fresh")
      await expect
        .poll(async () => (await counts(sellerPage)).direct, {
          timeout: 30_000,
        })
        .toBe(5)
      await sellerPage.reload()
      await expect(
        sellerPage.getByLabel("Open merchant account menu")
      ).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(async () => (await counts(sellerPage)).direct, {
          timeout: 30_000,
        })
        .toBe(5)
      const safe = await sellerPage.evaluate(async (path) => {
        const { db } = await import(
          `${path.replace("/protocol", "")}/db/index.ts`
        )
        const rows = await db.commerceInboxRecords.toArray()
        return {
          encrypted: rows.every(
            (row: { value: { bytes: unknown }; content?: unknown }) =>
              row.value.bytes instanceof ArrayBuffer &&
              row.content === undefined
          ),
          oldPlaintext:
            (await db.messages.count()) + (await db.orderMessages.count()),
        }
      }, root)
      expect(safe).toEqual({ encrypted: true, oldPlaintext: 0 })
      return
    }

    const [page, sender, recipient, port, accountLabel] =
      scenario === "buyer-self-copy"
        ? ([
            buyerPage,
            buyer,
            seller,
            process.env.PLAYWRIGHT_MARKET_PORT ?? "7000",
            "Open account menu",
          ] as const)
        : ([
            sellerPage,
            seller,
            buyer,
            process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001",
            "Open merchant account menu",
          ] as const)
    // Seed the buyer's incoming thread independently of the history workflow.
    if (scenario === "buyer-self-copy") {
      const incoming = {
        ...inner,
        content: "synthetic external reply",
        pubkey: seller.pubkey,
        tags: [["p", buyer.pubkey]],
      }
      const incomingSeal = signRuntimeTestEvent(seller, {
        kind: 13,
        created_at: createdAt,
        tags: [],
        content: encryptRuntimeTestPayload(
          seller,
          buyer.pubkey,
          JSON.stringify({ ...incoming, id: getEventHash(incoming) })
        ),
      })
      await publishTestRelayEvents([createWrap(incomingSeal, buyer.pubkey)])
    }
    await page.goto(
      `http://127.0.0.1:${port}/messages${scenario === "buyer-self-copy" ? "?tab=dms" : ""}`
    )
    await expect(page.getByLabel(accountLabel)).toBeVisible({ timeout: 15_000 })
    await counts(page, "initial")
    await expect
      .poll(async () => (await counts(page)).direct, { timeout: 30_000 })
      .toBe(1)
    await activateInboxControl(
      page
        .getByRole("button")
        .filter({
          hasText:
            scenario === "buyer-self-copy"
              ? "synthetic external reply"
              : "synthetic browser conversation",
        })
        .first(),
      testInfo
    )
    if (scenario === "buyer-self-copy") {
      // Preserve a real successful send in the old owner before reconnecting.
      await page
        .getByRole("textbox", { name: "Message" })
        .fill("synthetic buyer response")
      await activateInboxControl(
        page.getByRole("button", { name: "Send message", exact: true }),
        testInfo
      )
      await expect.poll(async () => (await counts(page)).direct).toBe(2)
      // Reconnect the same principal without reloading: the hook must subscribe to
      // the new session owner rather than remain attached to the retired owner.
      await reconnectBuyer(buyerPage, testInfo)
      const restoredConversation = buyerPage
        .getByRole("button")
        .filter({
          hasText: /synthetic (buyer response|external reply|seller reply)/,
        })
        .first()
      await expect(restoredConversation).toBeVisible({ timeout: 30_000 })
      await activateInboxControl(restoredConversation, testInfo)
      const externalReply = buyerPage.getByText("synthetic external reply", {
        exact: true,
      })
      try {
        await expect(externalReply.last()).toBeVisible()
      } catch (error) {
        try {
          const visibleCount = (elements: Element[]) =>
            elements.filter((element) => {
              const bounds = element.getBoundingClientRect()
              return (
                bounds.width > 0 &&
                bounds.height > 0 &&
                getComputedStyle(element).visibility === "visible"
              )
            }).length
          const [
            controlCount,
            controlVisible,
            dialogCount,
            composerVisible,
            bodyMatchCount,
            visibleBodyMatchCount,
            loadingHistoryCount,
            emptyHistoryCount,
            unavailableHistoryCount,
            local,
          ] = await Promise.all([
            buyerPage
              .getByRole("button")
              .filter({
                hasText:
                  /synthetic (buyer response|external reply|seller reply)/,
              })
              .count(),
            restoredConversation.isVisible(),
            buyerPage.getByRole("dialog").count(),
            buyerPage
              .getByRole("textbox", { name: "Message" })
              .first()
              .isVisible(),
            externalReply.count(),
            externalReply.evaluateAll(visibleCount),
            buyerPage
              .getByText("Loading message history…", { exact: true })
              .evaluateAll(visibleCount),
            buyerPage
              .getByText("No messages yet. Say hello.", { exact: true })
              .evaluateAll(visibleCount),
            buyerPage
              .getByText(
                "Message history is unavailable. Retry the protected read before relying on an empty thread.",
                { exact: true }
              )
              .evaluateAll(visibleCount),
            buyerPage.evaluate(
              async ({ root, buyerPubkey }) => {
                try {
                  const { readAuthSession } = await import(
                    `${root}/auth-session.ts`
                  )
                  const { getCommerceInbox } = await import(
                    `${root}/commerce-inbox.ts`
                  )
                  const session = readAuthSession()
                  const current = session?.userPubkey === buyerPubkey
                  const provider = (
                    window as Window & {
                      nostr?: { nip44?: { decrypt?: unknown } }
                    }
                  ).nostr
                  const base = {
                    sessionCurrent: current,
                    providerReady:
                      typeof provider?.nip44?.decrypt === "function",
                  }
                  if (!current)
                    return { ...base, localObservationAvailable: false }
                  try {
                    const snapshot = getCommerceInbox(buyerPubkey).getSnapshot()
                    return {
                      ...base,
                      localObservationAvailable: true,
                      localCoverage: snapshot.diagnostics.coverage,
                      localDirectCount: snapshot.directMessages.length,
                      localReplyRetained: snapshot.directMessages.some(
                        (message: { content: string }) =>
                          message.content === "synthetic external reply"
                      ),
                      localPending: snapshot.pending,
                      localStorageFailed:
                        snapshot.diagnostics.storageUnavailable,
                    }
                  } catch {
                    return { ...base, localObservationAvailable: false }
                  }
                } catch {
                  return { localObservationAvailable: false }
                }
              },
              { root, buyerPubkey: buyer.pubkey }
            ),
          ])
          recordSmokeDiagnostic(testInfo, "commerce-inbox-reconnect", {
            observationAvailable: true,
            controlCount,
            controlVisible,
            dialogCount,
            composerVisible,
            bodyMatchCount,
            visibleBodyMatchCount,
            loadingHistoryVisible: loadingHistoryCount > 0,
            emptyHistoryVisible: emptyHistoryCount > 0,
            unavailableHistoryVisible: unavailableHistoryCount > 0,
            buyerDirectCountReachedThreeBeforeReconnect: false,
            ...local,
          })
        } catch {
          recordSmokeDiagnostic(testInfo, "commerce-inbox-reconnect", {
            observationAvailable: false,
            buyerDirectCountReachedThreeBeforeReconnect: false,
          })
        }
        throw error
      }
      selfCopyCheckpoint("reconnect_complete", "none")
    }
    const principal: SelfCopyPrincipal = sender === buyer ? "buyer" : "seller"
    selfCopyCheckpoint("loop_enter", principal)
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
          const { getCommerceInbox } = await import(`${root}/commerce-inbox.ts`)
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
    selfCopyCheckpoint("before_send", principal, true)
    // Observe the current controls and local owner without delaying Send.
    // Only the fixed booleans below may enter the smoke annotation.
    void page
      .evaluate(
        async ({ root, expectedPrincipal }) => {
          const visible = (element: Element) => {
            const bounds = element.getBoundingClientRect()
            return (
              bounds.width > 0 &&
              bounds.height > 0 &&
              getComputedStyle(element).visibility === "visible"
            )
          }
          const sends = Array.from(
            document.querySelectorAll<HTMLButtonElement>(
              'button[aria-label="Send message"]'
            )
          )
          const drafts = Array.from(
            document.querySelectorAll<HTMLTextAreaElement>(
              'textarea[aria-label="Message"]'
            )
          )
          const send = sends.find(visible) ?? sends[0]
          const draft = drafts.find(visible) ?? drafts[0]
          const provider = (
            window as Window & {
              nostr?: { nip44?: { encrypt?: unknown } }
            }
          ).nostr
          const observation: Record<string, boolean> = {
            observationAvailable: true,
            providerReady: typeof provider?.nip44?.encrypt === "function",
          }
          if (send) {
            observation.sendVisible = visible(send)
            observation.sendEnabled = !send.disabled
          }
          if (draft) observation.draftPresent = draft.value.trim().length > 0
          try {
            const { readAuthSession } = await import(`${root}/auth-session.ts`)
            const sessionCurrent =
              readAuthSession()?.userPubkey === expectedPrincipal
            observation.sessionCurrent = sessionCurrent
            if (sessionCurrent) {
              const { getCommerceInbox } = await import(
                `${root}/commerce-inbox.ts`
              )
              const snapshot = getCommerceInbox(expectedPrincipal).getSnapshot()
              observation.localPending = snapshot.pending
              observation.localStorageFailed =
                snapshot.diagnostics.storageUnavailable
            }
          } catch {
            // Leave unavailable local observations absent from the annotation.
          }
          return observation
        },
        { root, expectedPrincipal: sender.pubkey }
      )
      .then((observation) => {
        if (
          selfCopyDiagnostic?.phase !== "before_send" ||
          selfCopyDiagnostic.principal !== principal
        )
          return
        selfCopyDiagnostic = {
          ...selfCopyDiagnostic,
          ...observation,
          observationWhen: "send_pending",
        }
        recordSmokeDiagnostic(
          testInfo,
          "commerce-inbox-self-copy",
          selfCopyDiagnostic
        )
      })
      .catch(() => {
        // This optional probe must not replace an action or assertion failure.
      })
    await activateInboxControl(
      page.getByRole("button", { name: "Send message", exact: true }),
      testInfo
    )
    selfCopyCheckpoint("send_completed", principal, true, true)
    await expect(
      page.getByRole("status").filter({
        hasText:
          "Reply sent and saved on this device. Sync to your other devices is incomplete.",
      })
    ).toBeVisible({ timeout: 30_000 })
    selfCopyCheckpoint("status_visible", principal, true, true)
    await expect.poll(savedText).toBe(1)
    selfCopyCheckpoint("text_persisted", principal, true, true, {
      textPersisted: true,
    })
    selfCopyCheckpoint("before_attachment", principal, true, true, {
      textPersisted: true,
    })
    await page.getByLabel("Choose an encrypted attachment").setInputFiles({
      name: "synthetic.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic encrypted attachment"),
    })
    selfCopyCheckpoint("attachment_completed", principal, true, true, {
      textPersisted: true,
    })
    await expect(
      page.getByRole("status").filter({
        hasText:
          "Attachment sent and saved on this device. Sync to your other devices is incomplete.",
      })
    ).toBeVisible({ timeout: 30_000 })
    selfCopyCheckpoint("attachment_status_visible", principal, true, true, {
      textPersisted: true,
    })
    const savedFile = async () =>
      page.evaluate(
        async ({ root, principal }) => {
          const { getCommerceInbox } = await import(`${root}/commerce-inbox.ts`)
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
    selfCopyCheckpoint("file_persisted", principal, true, true, {
      textPersisted: true,
    })
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
    selfCopyCheckpoint("complete", "none")
  } finally {
    try {
      await Promise.all(contexts.map((context) => context.close()))
    } finally {
      disposeRuntimeSignerIdentity(buyer)
      disposeRuntimeSignerIdentity(seller)
    }
  }
}

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
                  `${root}/auth-session.ts`
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
        const { admitPublicEvent } = await import(
          `${root}/verified-public-event.ts`
        )
        const owner = getCommerceInbox(principal)
        await owner.initialize()
        const inboxDeclarationEvidenceRepository =
          createInMemoryInboxDeclarationEvidenceRepository()
        // Discovery may return from the process cache without populating this
        // isolated repository. Give the domain boundary its own verified fixture
        // evidence so relay admission does not depend on app bootstrap timing.
        const observedAt = Date.now()
        for (const signedEvent of [senderDeclaration, recipientDeclaration]) {
          const admitted = await admitPublicEvent(signedEvent)
          if (admitted.status !== "verified") {
            throw new Error("Signed inbox fixture failed admission")
          }
          await inboxDeclarationEvidenceRepository.merge({
            pubkey: admitted.event.pubkey,
            signedEvent: admitted.event,
            sourceRelayUrls: [relay],
            observedAt,
            completeObservedAt: observedAt,
            lookup: {
              observedAt,
              coverage: "complete",
              hadEvent: true,
              eventId: signedEvent.id,
            },
          })
        }
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

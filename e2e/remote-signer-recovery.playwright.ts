import { expect, test, type Page } from "@playwright/test"
import { SimplePool } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type EventTemplate,
} from "nostr-tools/pure"
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44"

import type { Nip46AuthSession } from "../packages/core/src/protocol/remote-signer"
import {
  TEST_RELAY_URL,
  readTestRelayEvents,
  seedTestRelayIdentity,
} from "./helpers/auth"

const merchantUrl =
  "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
const remoteSignerVaultModuleUrl = `/@fs${process.cwd()}/packages/core/src/protocol/remote-signer-vault.ts`
const signerRelayAlias = "wss://signer.test"
const NOSTR_CONNECT_KIND = 24_133
const PRODUCT_KIND = 30_402

type RemoteSignerHarness = {
  allowProductSigning(): void
  failPing(): void
  returnMalformedIdentity(): void
  identityRequestCount(): number
  productSignRequestCount(): number
  responseErrors(): readonly string[]
  close(): void
}

async function startRemoteSignerHarness(
  remoteSignerSecret: Uint8Array,
  merchantSecret: Uint8Array
): Promise<RemoteSignerHarness> {
  const pool = new SimplePool()
  const remoteSignerPubkey = getPublicKey(remoteSignerSecret)
  const seenRequestIds = new Set<string>()
  const errors: string[] = []
  let productSigningAllowed = false
  let pingShouldFail = false
  let identityShouldBeMalformed = false
  let identityRequests = 0
  let productSignRequests = 0

  await pool.ensureRelay(TEST_RELAY_URL)
  const subscription = pool.subscribe(
    [TEST_RELAY_URL],
    {
      kinds: [NOSTR_CONNECT_KIND],
      "#p": [remoteSignerPubkey],
      since: Math.floor(Date.now() / 1_000) - 5,
      limit: 0,
    },
    {
      onevent: (requestEvent) => {
        void (async () => {
          if (seenRequestIds.has(requestEvent.id)) return
          seenRequestIds.add(requestEvent.id)

          const conversationKey = getConversationKey(
            remoteSignerSecret,
            requestEvent.pubkey
          )
          const request = JSON.parse(
            decrypt(requestEvent.content, conversationKey)
          ) as {
            id: string
            method: string
            params: string[]
          }
          let result: string | null = null
          let error: string | null = null

          switch (request.method) {
            case "connect":
              result = "ack"
              break
            case "ping":
              if (pingShouldFail) error = "Saved connection unavailable"
              else result = "pong"
              break
            case "get_public_key":
              identityRequests += 1
              result = identityShouldBeMalformed
                ? "malformed-pubkey"
                : getPublicKey(merchantSecret)
              break
            case "sign_event": {
              const template = JSON.parse(
                request.params[0] ?? "{}"
              ) as EventTemplate
              if (template.kind === PRODUCT_KIND) {
                productSignRequests += 1
                if (!productSigningAllowed) return
              }
              result = JSON.stringify(finalizeEvent(template, merchantSecret))
              break
            }
            case "logout":
              result = "ack"
              break
            default:
              error = "Unsupported test signer method"
          }

          const response = finalizeEvent(
            {
              kind: NOSTR_CONNECT_KIND,
              created_at: Math.floor(Date.now() / 1_000),
              tags: [["p", requestEvent.pubkey]],
              content: encrypt(
                JSON.stringify({
                  id: request.id,
                  ...(result === null ? {} : { result }),
                  ...(error === null ? {} : { error }),
                }),
                conversationKey
              ),
            },
            remoteSignerSecret
          )
          await Promise.all(
            pool.publish([TEST_RELAY_URL], response, { maxWait: 2_000 })
          )
        })().catch((cause) => {
          errors.push(cause instanceof Error ? cause.message : String(cause))
        })
      },
    }
  )

  return {
    allowProductSigning() {
      productSigningAllowed = true
    },
    failPing() {
      pingShouldFail = true
    },
    returnMalformedIdentity() {
      identityShouldBeMalformed = true
    },
    identityRequestCount() {
      return identityRequests
    },
    productSignRequestCount() {
      return productSignRequests
    },
    responseErrors() {
      return errors
    },
    close() {
      subscription.close()
      pool.close([TEST_RELAY_URL])
    },
  }
}

async function installSignerRelayAlias(page: Page): Promise<void> {
  await page.addInitScript(
    ({ alias, loopback }) => {
      const NativeWebSocket = window.WebSocket
      class LoopbackSignerWebSocket extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = String(url).startsWith(alias) ? loopback : url
          if (protocols === undefined) super(target)
          else super(target, protocols)
        }
      }
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        value: LoopbackSignerWebSocket,
      })
    },
    { alias: signerRelayAlias, loopback: TEST_RELAY_URL }
  )
}

async function isRemoteSignerKeyRemoved(
  page: Page,
  clientKeyId: string | null
): Promise<boolean> {
  if (!clientKeyId) return false

  return page.evaluate(
    async ({ moduleUrl, keyId }) => {
      const { createBrowserRemoteSignerKeyVault } = (await import(
        moduleUrl
      )) as {
        createBrowserRemoteSignerKeyVault: () => {
          load(id: string): Promise<string | null>
        }
      }
      return (await createBrowserRemoteSignerKeyVault().load(keyId)) === null
    },
    { moduleUrl: remoteSignerVaultModuleUrl, keyId: clientKeyId }
  )
}

async function connectRemoteSigner(
  page: Page,
  remoteSignerPubkey: string
): Promise<void> {
  await page.getByRole("tab", { name: "Bunker URL" }).click()
  await page
    .getByRole("textbox", { name: "Remote signer bunker URL" })
    .fill(
      "bunker://" +
        remoteSignerPubkey +
        "?relay=" +
        encodeURIComponent(signerRelayAlias)
    )
  await page.getByRole("button", { name: "Connect with bunker link" }).click()
}

test("remote signer timeout keeps the product draft recoverable and requires an explicit retry @merchant", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000)
  const remoteSignerSecret = generateSecretKey()
  const merchantSecret = generateSecretKey()
  const remoteSignerPubkey = getPublicKey(remoteSignerSecret)
  const merchantPubkey = getPublicKey(merchantSecret)
  const harness = await startRemoteSignerHarness(
    remoteSignerSecret,
    merchantSecret
  )

  try {
    await seedTestRelayIdentity(merchantSecret)
    await installSignerRelayAlias(page)

    await page.goto(merchantUrl + "/products")
    await connectRemoteSigner(page, remoteSignerPubkey)
    await page.getByRole("link", { name: "Products", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible({ timeout: 15_000 })

    await page.getByRole("button", { name: "Add product" }).first().click()
    const productDialog = page.getByRole("dialog", { name: "Add product" })
    const title = productDialog.getByLabel("Title")
    await title.fill("Remote signer recovery fixture")
    await productDialog.getByLabel("Price").fill("21")
    await productDialog
      .getByLabel("Image URL")
      .fill("https://media.conduit.market/product.png")
    await productDialog.locator("#product-fulfillment").click()
    await page.getByRole("option", { name: "Digital" }).click()
    const tags = productDialog.getByRole("combobox", { name: "Tags" })
    for (const tag of ["fixture", "recovery", "signer"]) {
      await tags.fill(tag)
      await tags.press("Enter")
    }

    const publishButton = productDialog.getByRole("button", {
      name: "Publish product",
    })
    await expect(publishButton).toBeEnabled()
    await publishButton.click()
    await expect(
      productDialog.getByText("Approve product — 1 of 1")
    ).toBeVisible()
    await expect(
      productDialog.getByRole("button", { name: "Waiting for signer..." })
    ).toBeVisible()

    const recoveryNotice = productDialog.getByRole("alert")
    await expect(recoveryNotice).toContainText(
      "Your signing connection stopped responding.",
      { timeout: 40_000 }
    )
    await expect(title).toHaveValue("Remote signer recovery fixture")
    await expect(productDialog).toBeVisible()

    const retainedSession = await page.evaluate(() => {
      const rawSession = localStorage.getItem("conduit:auth")
      if (!rawSession) throw new Error("Missing recoverable signer session")
      const oldRevision = localStorage.getItem("conduit:auth:revision")
      const nextRevision = `${oldRevision ?? "claim"}:other-tab`
      localStorage.setItem("conduit:auth:revision", nextRevision)
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "conduit:auth:revision",
          oldValue: oldRevision,
          newValue: nextRevision,
          url: window.location.href,
        })
      )
      return rawSession
    })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    await expect(productDialog).toBeVisible()
    await expect(recoveryNotice).toContainText(
      "Your signing connection stopped responding."
    )
    expect(
      await page.evaluate(() => localStorage.getItem("conduit:auth"))
    ).toBe(retainedSession)
    await expect(
      productDialog.getByRole("button", {
        name: "Reconnect signer to continue",
      })
    ).toBeDisabled()
    expect(harness.productSignRequestCount()).toBe(1)

    await recoveryNotice.scrollIntoViewIfNeeded()
    const screenshot = await recoveryNotice.screenshot()
    await testInfo.attach("remote-signer-product-recovery", {
      body: screenshot,
      contentType: "image/png",
    })
    const requestedScreenshotPath =
      process.env.PLAYWRIGHT_RECOVERY_SCREENSHOT_PATH
    if (requestedScreenshotPath) {
      await recoveryNotice.screenshot({ path: requestedScreenshotPath })
    }

    harness.allowProductSigning()
    await recoveryNotice
      .getByRole("button", { name: "Reconnect signer" })
      .click()
    await expect(
      productDialog.getByText(
        "Signer reconnected. Review your draft, then choose Publish product when ready."
      )
    ).toBeFocused({ timeout: 15_000 })
    await expect(title).toHaveValue("Remote signer recovery fixture")
    expect(harness.productSignRequestCount()).toBe(1)

    await publishButton.click()
    await expect(productDialog).toBeHidden({ timeout: 15_000 })
    await expect.poll(() => harness.productSignRequestCount()).toBe(2)
    await expect
      .poll(async () => {
        const events = await readTestRelayEvents({
          kinds: [PRODUCT_KIND],
          authors: [merchantPubkey],
        })
        return events.filter((event) =>
          event.tags.some(
            ([name, value]) =>
              name === "title" && value === "Remote signer recovery fixture"
          )
        ).length
      })
      .toBe(1)
    expect(harness.responseErrors()).toEqual([])
  } finally {
    harness.close()
  }
})

test("a malformed restored identity retires the saved session across reloads @merchant", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const remoteSignerSecret = generateSecretKey()
  const merchantSecret = generateSecretKey()
  const remoteSignerPubkey = getPublicKey(remoteSignerSecret)
  const harness = await startRemoteSignerHarness(
    remoteSignerSecret,
    merchantSecret
  )

  try {
    await seedTestRelayIdentity(merchantSecret)
    await installSignerRelayAlias(page)

    await page.goto(merchantUrl + "/products")
    await connectRemoteSigner(page, remoteSignerPubkey)
    await page.getByRole("link", { name: "Products", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible({ timeout: 15_000 })

    const clientKeyId = await page.evaluate(() => {
      const rawSession = localStorage.getItem("conduit:auth")
      if (!rawSession) throw new Error("Missing remote signer session")
      return (JSON.parse(rawSession) as Nip46AuthSession).clientKeyId
    })
    const identityRequestsBeforeRestore = harness.identityRequestCount()
    harness.returnMalformedIdentity()

    await page.reload()
    const connectGate = page.locator('main[aria-label="Sign in to Conduit"]')
    await expect(connectGate).toBeFocused({ timeout: 15_000 })
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("conduit:auth")))
      .toBeNull()
    await expect
      .poll(() => isRemoteSignerKeyRemoved(page, clientKeyId))
      .toBe(true)
    await expect(
      page.getByRole("button", { name: "Reconnect your account" })
    ).toHaveCount(0)
    expect(harness.identityRequestCount()).toBe(
      identityRequestsBeforeRestore + 1
    )

    await page.reload()
    await expect(connectGate).toBeFocused({ timeout: 15_000 })
    expect(
      await page.evaluate(() => localStorage.getItem("conduit:auth"))
    ).toBeNull()
    expect(await isRemoteSignerKeyRemoved(page, clientKeyId)).toBe(true)
    expect(harness.identityRequestCount()).toBe(
      identityRequestsBeforeRestore + 1
    )
    expect(harness.responseErrors()).toEqual([])
  } finally {
    harness.close()
  }
})

test("an authority-only revision keeps exact remote signer reconnect available @merchant", async ({
  page,
}) => {
  test.setTimeout(45_000)
  const remoteSignerSecret = generateSecretKey()
  const merchantSecret = generateSecretKey()
  const remoteSignerPubkey = getPublicKey(remoteSignerSecret)
  const harness = await startRemoteSignerHarness(
    remoteSignerSecret,
    merchantSecret
  )

  try {
    await seedTestRelayIdentity(merchantSecret)
    await installSignerRelayAlias(page)

    await page.goto(merchantUrl + "/products")
    await connectRemoteSigner(page, remoteSignerPubkey)
    await page.getByRole("link", { name: "Products", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible({ timeout: 15_000 })

    const retained = await page.evaluate(() => {
      const rawSession = localStorage.getItem("conduit:auth")
      if (!rawSession) throw new Error("Missing remote signer session")
      const session = JSON.parse(rawSession) as Nip46AuthSession
      const oldRevision = localStorage.getItem("conduit:auth:revision")
      const nextRevision = `${oldRevision ?? "claim"}:other-tab`
      localStorage.setItem("conduit:auth:revision", nextRevision)
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "conduit:auth:revision",
          oldValue: oldRevision,
          newValue: nextRevision,
          url: window.location.href,
        })
      )
      return {
        rawSession,
        identity: {
          version: session.version,
          type: session.type,
          userPubkey: session.userPubkey,
          remoteSignerPubkey: session.remoteSignerPubkey,
          relayUrls: session.relayUrls,
          clientKeyId: session.clientKeyId,
          createdAt: session.createdAt,
        },
        updatedAt: session.updatedAt,
      }
    })

    expect(retained.identity.remoteSignerPubkey).toBe(remoteSignerPubkey)
    expect(retained.identity.relayUrls).toEqual([signerRelayAlias])
    expect(Number.isFinite(retained.identity.createdAt)).toBe(true)
    expect(Number.isFinite(retained.updatedAt)).toBe(true)

    await expect(
      page.locator('main[aria-label="Sign in to Conduit"]')
    ).toBeVisible()
    expect(
      await page.evaluate(() => localStorage.getItem("conduit:auth"))
    ).toBe(retained.rawSession)

    const reconnect = page.getByRole("button", {
      name: "Reconnect your account",
    })
    await expect(reconnect).toBeVisible({ timeout: 5_000 })
    await reconnect.click()

    await expect(
      page.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(() =>
        page.evaluate(() => {
          const rawSession = localStorage.getItem("conduit:auth")
          if (!rawSession) return null
          const session = JSON.parse(rawSession) as Nip46AuthSession
          return {
            version: session.version,
            type: session.type,
            userPubkey: session.userPubkey,
            remoteSignerPubkey: session.remoteSignerPubkey,
            relayUrls: session.relayUrls,
            clientKeyId: session.clientKeyId,
            createdAt: session.createdAt,
          }
        })
      )
      .toEqual(retained.identity)
    expect(harness.productSignRequestCount()).toBe(0)
    expect(harness.responseErrors()).toEqual([])
  } finally {
    harness.close()
  }
})

test("a different signer starts a fresh merchant workspace after verified recovery retirement @merchant", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const remoteSignerASecret = generateSecretKey()
  const merchantASecret = generateSecretKey()
  const remoteSignerBSecret = generateSecretKey()
  const merchantBSecret = generateSecretKey()
  const remoteSignerAPubkey = getPublicKey(remoteSignerASecret)
  const remoteSignerBPubkey = getPublicKey(remoteSignerBSecret)
  const merchantAPubkey = getPublicKey(merchantASecret)
  const merchantBPubkey = getPublicKey(merchantBSecret)
  const harnessA = await startRemoteSignerHarness(
    remoteSignerASecret,
    merchantASecret
  )
  const harnessB = await startRemoteSignerHarness(
    remoteSignerBSecret,
    merchantBSecret
  )

  try {
    await seedTestRelayIdentity(merchantASecret)
    await seedTestRelayIdentity(merchantBSecret)
    await installSignerRelayAlias(page)

    await page.goto(merchantUrl + "/products")
    await connectRemoteSigner(page, remoteSignerAPubkey)
    await page.getByRole("link", { name: "Products", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible({ timeout: 15_000 })

    await page.getByRole("button", { name: "Add product" }).first().click()
    const productDialog = page.getByRole("dialog", { name: "Add product" })
    const title = productDialog.getByLabel("Title")
    await title.fill("Account A retained draft")
    await productDialog.getByLabel("Price").fill("34")
    await productDialog
      .getByLabel("Image URL")
      .fill("https://media.conduit.market/account-a-draft.png")
    await productDialog.locator("#product-fulfillment").click()
    await page.getByRole("option", { name: "Digital" }).click()
    const tags = productDialog.getByRole("combobox", { name: "Tags" })
    for (const tag of ["account", "draft", "recovery"]) {
      await tags.fill(tag)
      await tags.press("Enter")
    }

    await productDialog.getByRole("button", { name: "Publish product" }).click()
    const recoveryNotice = productDialog.getByRole("alert")
    await expect(recoveryNotice).toContainText(
      "Your signing connection stopped responding.",
      { timeout: 40_000 }
    )
    expect(harnessA.productSignRequestCount()).toBe(1)

    const retained = await page.evaluate(() => {
      const draftKey = Object.keys(localStorage).find(
        (key) =>
          key.startsWith("conduit:merchant:product_draft:") &&
          localStorage.getItem(key)?.includes("Account A retained draft")
      )
      const auth = JSON.parse(
        localStorage.getItem("conduit:auth") ?? "null"
      ) as { clientKeyId?: string } | null
      return {
        draftKey: draftKey ?? null,
        clientKeyId: auth?.clientKeyId ?? null,
      }
    })
    expect(retained.draftKey).not.toBeNull()
    expect(retained.clientKeyId).not.toBeNull()

    harnessA.failPing()
    await recoveryNotice
      .getByRole("button", { name: "Reconnect signer" })
      .click()
    await expect(recoveryNotice).toContainText(
      "That saved connection could not be restored.",
      { timeout: 15_000 }
    )
    await recoveryNotice
      .getByRole("button", { name: "Use a different signer" })
      .click()

    const connectGate = page.locator('main[aria-label="Sign in to Conduit"]')
    await expect(connectGate).toBeFocused({ timeout: 15_000 })
    await expect(productDialog).toBeHidden()
    expect(
      await page.evaluate(() => localStorage.getItem("conduit:auth"))
    ).toBeNull()
    expect(
      await page.evaluate(async (clientKeyId) => {
        if (!clientKeyId) return false
        return new Promise<boolean>((resolve, reject) => {
          const open = indexedDB.open("conduit-remote-signer")
          open.addEventListener("error", () => reject(open.error), {
            once: true,
          })
          open.addEventListener(
            "success",
            () => {
              const database = open.result
              const transaction = database.transaction(
                "session-keys",
                "readonly"
              )
              const request = transaction
                .objectStore("session-keys")
                .get(clientKeyId)
              request.addEventListener(
                "success",
                () => {
                  const removed = request.result === undefined
                  database.close()
                  resolve(removed)
                },
                { once: true }
              )
              request.addEventListener("error", () => reject(request.error), {
                once: true,
              })
            },
            { once: true }
          )
        })
      }, retained.clientKeyId)
    ).toBe(true)

    await connectRemoteSigner(page, remoteSignerBPubkey)
    await expect(
      page.getByRole("heading", { name: "Products", exact: true })
    ).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByRole("button", { name: "Resume product draft" })
    ).toHaveCount(0)
    await page.getByRole("button", { name: "Add product" }).first().click()
    const accountBDialog = page.getByRole("dialog", { name: "Add product" })
    await expect(accountBDialog.getByLabel("Title")).toHaveValue("")
    await expect(accountBDialog).not.toContainText("Account A retained draft")

    expect(harnessA.productSignRequestCount()).toBe(1)
    expect(harnessB.productSignRequestCount()).toBe(0)
    expect(
      await page.evaluate((draftKey) => {
        if (!draftKey) return false
        return localStorage
          .getItem(draftKey)
          ?.includes("Account A retained draft")
      }, retained.draftKey)
    ).toBe(true)
    await expect
      .poll(async () => {
        const events = await readTestRelayEvents({
          kinds: [PRODUCT_KIND],
          authors: [merchantAPubkey, merchantBPubkey],
        })
        return events.filter((event) =>
          event.tags.some(
            ([name, value]) =>
              name === "title" && value === "Account A retained draft"
          )
        ).length
      })
      .toBe(0)
    expect(harnessA.responseErrors()).toEqual([])
    expect(harnessB.responseErrors()).toEqual([])
  } finally {
    harnessA.close()
    harnessB.close()
  }
})

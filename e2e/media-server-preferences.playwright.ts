import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  TEST_RELAY_URL,
  installTestSigner,
  readTestRelayEvents,
  seedTestRelayIdentity,
} from "./helpers/auth"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const merchantUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"}`
const screenshotDirectory = process.env.PLAYWRIGHT_BLOSSOM_SCREENSHOT_DIR
const FIRST_SERVER = "https://one.conduit.market"
const SECOND_SERVER = "https://two.conduit.market"

async function openNetwork(
  page: Page,
  app: "market" | "merchant",
  secretKey: Uint8Array
): Promise<string> {
  const pubkey = getPublicKey(secretKey)
  await seedTestRelayIdentity(secretKey)
  await installTestSigner(page, pubkey, { secretKey })
  const appUrl = app === "market" ? marketUrl : merchantUrl
  await page.goto(app === "market" ? `${appUrl}/products` : appUrl)
  await expect(
    page.getByRole("button", {
      name:
        app === "market" ? "Open account menu" : "Open merchant account menu",
    })
  ).toBeVisible({ timeout: 15_000 })
  await page.goto(`${appUrl}/network`)
  await expect(
    page.getByRole("heading", { name: "Network", exact: true })
  ).toBeVisible()
  const section = page.getByRole("region", { name: "Media servers" })
  await expect(section).toBeVisible()
  await expect(
    section.getByText("No list observed", { exact: true })
  ).toBeVisible({ timeout: 20_000 })
  return pubkey
}

async function addServer(page: Page, serverUrl: string): Promise<void> {
  const section = page.getByRole("region", { name: "Media servers" })
  const input = section.getByLabel("Add media server root")
  await input.fill(serverUrl)
  await section.getByRole("button", { name: "Add server" }).click()
  await expect(input).toHaveValue("")
}

async function exerciseSharedSurface(
  page: Page,
  app: "market" | "merchant",
  options: { cancelSignerOnce: boolean }
): Promise<void> {
  test.setTimeout(90_000)
  const secretKey = generateSecretKey()
  const pubkey = await openNetwork(page, app, secretKey)
  const section = page.getByRole("region", { name: "Media servers" })
  const input = section.getByLabel("Add media server root")

  await input.fill("http://unsafe.conduit.market")
  await section.getByRole("button", { name: "Add server" }).click()
  await expect(section.getByRole("alert")).toContainText(
    "public HTTPS server root"
  )
  await expect(input).toHaveValue("http://unsafe.conduit.market")
  await input.fill("")

  await addServer(page, FIRST_SERVER)
  await addServer(page, SECOND_SERVER)
  await expect(
    section.getByText("Unpublished local edits", { exact: true })
  ).toBeVisible()

  const orderedList = section.getByRole("list", {
    name: "Ordered media servers",
  })
  await expect(orderedList.locator("li")).toHaveCount(2)
  await section
    .getByRole("button", { name: `Move ${SECOND_SERVER} earlier` })
    .click()
  await expect(orderedList.locator("li").nth(0)).toContainText(SECOND_SERVER)
  await expect(
    section.getByRole("button", { name: `Move ${SECOND_SERVER} later` })
  ).toBeFocused()

  await section.getByRole("button", { name: `Remove ${FIRST_SERVER}` }).click()
  await expect(orderedList.locator("li")).toHaveCount(1)
  await expect(
    section.getByRole("button", { name: `Remove ${SECOND_SERVER}` })
  ).toBeFocused()
  await addServer(page, FIRST_SERVER)

  expect(
    await readTestRelayEvents({ kinds: [10_063], authors: [pubkey] })
  ).toHaveLength(0)

  const reviewButton = section.getByRole("button", {
    name: "Review and publish",
  })
  await reviewButton.click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText(SECOND_SERVER)
  await expect(dialog).toContainText(FIRST_SERVER)
  await dialog.getByRole("button", { name: "Keep editing" }).click()
  await expect(reviewButton).toBeFocused()
  expect(
    await readTestRelayEvents({ kinds: [10_063], authors: [pubkey] })
  ).toHaveLength(0)

  if (options.cancelSignerOnce) {
    await page.evaluate(() => {
      const signer = (
        window as unknown as {
          nostr: {
            signEvent: (
              event: Record<string, unknown>
            ) => Promise<Record<string, unknown>>
          }
        }
      ).nostr
      const originalSignEvent = signer.signEvent.bind(signer)
      let cancelOnce = true
      signer.signEvent = async (event) => {
        if (event.kind === 10_063 && cancelOnce) {
          cancelOnce = false
          throw { code: "ACTION_REJECTED" }
        }
        return originalSignEvent(event)
      }
    })
    await reviewButton.click()
    await dialog.getByRole("button", { name: "Sign and publish" }).click()
    await expect(
      section.getByText(
        "Signing was cancelled. Your local media server edits were retained.",
        { exact: true }
      )
    ).toBeVisible()
    await expect(
      section.getByText("Unpublished local edits", { exact: true })
    ).toBeVisible()
    expect(
      await readTestRelayEvents({ kinds: [10_063], authors: [pubkey] })
    ).toHaveLength(0)
  }

  await reviewButton.click()
  await dialog.getByRole("button", { name: "Sign and publish" }).click()
  await expect(
    section.getByText(
      "The ordered media server preference was confirmed by a fresh relay read-back.",
      { exact: true }
    )
  ).toBeVisible({ timeout: 20_000 })

  const published = await readTestRelayEvents({
    kinds: [10_063],
    authors: [pubkey],
  })
  expect(published).toHaveLength(1)
  expect(published[0]).toMatchObject({
    kind: 10_063,
    pubkey,
    content: "",
    tags: [
      ["server", SECOND_SERVER],
      ["server", FIRST_SERVER],
    ],
  })

  if (screenshotDirectory) {
    mkdirSync(screenshotDirectory, { recursive: true })
    const screenshotPath = join(
      screenshotDirectory,
      `${app}-network-media-servers.png`
    )
    if (app === "merchant") {
      await section.scrollIntoViewIfNeeded()
      await section.screenshot({ path: screenshotPath, animations: "disabled" })
    } else {
      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
        animations: "disabled",
      })
    }
  }
}

test("Market manages and publishes shared Blossom preferences @market", async ({
  page,
}) => {
  await exerciseSharedSurface(page, "market", { cancelSignerOnce: true })
})

test("Merchant manages and publishes shared Blossom preferences @merchant", async ({
  page,
}) => {
  await exerciseSharedSurface(page, "merchant", { cancelSignerOnce: false })
})

test("Market retries an exact retained kind 10063 without signing again @market", async ({
  page,
}) => {
  test.setTimeout(60_000)
  const secretKey = generateSecretKey()
  const pubkey = getPublicKey(secretKey)
  const createdAt = Math.floor(Date.now() / 1_000) + 1
  const signedEvent = finalizeEvent(
    {
      kind: 10_063,
      created_at: createdAt,
      tags: [["server", FIRST_SERVER]],
      content: "",
    },
    secretKey
  )
  await seedTestRelayIdentity(secretKey)
  await installTestSigner(page, pubkey, { secretKey })
  await page.addInitScript(
    ([owner, relayUrl, event, serverUrl]) => {
      const now = Date.now()
      localStorage.setItem(
        `conduit:media-server-preferences:v1:${owner}`,
        JSON.stringify({
          version: 1,
          owner,
          frontier: {
            eventId: event.id,
            createdAt: event.created_at,
            state: "valid",
          },
          pending: {
            signedEvent: event,
            serverUrls: [serverUrl],
            publishRelayUrls: [relayUrl],
            acknowledgedRelayUrls: [],
            rejectedRelayUrls: [relayUrl],
            timedOutRelayUrls: [],
            stagedAt: now,
          },
          draft: {
            serverUrls: [serverUrl],
            baseServerUrls: [],
            baseEventId: null,
            updatedAt: now,
          },
        })
      )
      ;(
        window as unknown as { __mediaServerSignCalls?: number }
      ).__mediaServerSignCalls = 0
    },
    [pubkey, TEST_RELAY_URL, signedEvent, FIRST_SERVER] as const
  )

  await page.goto(`${marketUrl}/products`)
  await expect(
    page.getByRole("button", { name: "Open account menu" })
  ).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => {
    const browserWindow = window as unknown as {
      __mediaServerSignCalls?: number
      nostr: {
        signEvent: (
          unsigned: Record<string, unknown>
        ) => Promise<Record<string, unknown>>
      }
    }
    const originalSignEvent = browserWindow.nostr.signEvent.bind(
      browserWindow.nostr
    )
    browserWindow.nostr.signEvent = async (unsigned) => {
      browserWindow.__mediaServerSignCalls =
        (browserWindow.__mediaServerSignCalls ?? 0) + 1
      return originalSignEvent(unsigned)
    }
  })
  await page.goto(`${marketUrl}/network`)
  const section = page.getByRole("region", { name: "Media servers" })
  const retry = section.getByRole("button", { name: "Retry signed update" })
  await expect(retry).toBeVisible({ timeout: 20_000 })
  await retry.click()
  await expect(
    section.getByText(
      "The ordered media server preference was confirmed by a fresh relay read-back.",
      { exact: true }
    )
  ).toBeVisible({ timeout: 20_000 })
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __mediaServerSignCalls?: number })
          .__mediaServerSignCalls ?? -1
    )
  ).toBe(0)
  const events = await readTestRelayEvents({
    kinds: [10_063],
    authors: [pubkey],
  })
  expect(events).toHaveLength(1)
  expect(events[0]?.id).toBe(signedEvent.id)
})

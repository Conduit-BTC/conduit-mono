import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  prepareControlledWallet,
  installControlledWallet,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"
const core = "/@fs" + path.resolve("packages/core/src/index.ts")
const relay = "ws://127.0.0.1:" + process.env.PLAYWRIGHT_RELAY_PORT
const apps = {
  market: "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"),
  merchant:
    "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"),
}
test.setTimeout(90000)
test.use({ trace: "off", screenshot: "off", video: "off" })
async function wallets(page: Page) {
  return page.evaluate(async (moduleUrl) => {
    const { db, getAccountSigner } = await import(moduleUrl)
    const owner = getAccountSigner().pubkey
    const descriptors = await db.wallets.toArray()
    const ids = []
    for (const wallet of descriptors) {
      const credential = await db.walletCredentials.get(wallet.id)
      if (credential && JSON.parse(credential.credential).ownerPubkey === owner)
        ids.push(wallet.id)
    }
    return ids
  }, core)
}
async function saved(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Save your recovery details" })
  ).toBeVisible()
  await page
    .getByLabel(
      "I saved the phrase, Spark account number and network somewhere private"
    )
    .check()
  await page.getByRole("button", { name: "Done", exact: true }).click()
}
for (const size of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const from of ["market", "merchant"] as const) {
    test(
      size.name +
        " " +
        from +
        " setup restores the same identity in the other app @market @merchant",
      async ({ browser }) => {
        const identity = createRuntimeSignerIdentity()
        const context = await browser.newContext({ viewport: size })
        const source = await context.newPage()
        const target = await context.newPage()
        const to = from === "market" ? "merchant" : "market"
        try {
          for (const page of [source, target]) {
            await prepareControlledWallet(page)
            await installRealTestSigner(page, identity, relay)
          }
          await source.goto(apps[from] + "/wallet")
          await expect(
            source.getByRole("heading", { name: "My wallets", exact: true })
          ).toBeVisible()
          await installControlledWallet(source)
          await expect(
            source.getByText(
              "Mainnet uses real bitcoin. Save your recovery details before receiving funds.",
              { exact: true }
            )
          ).toBeVisible()
          expect(
            await source.evaluate(() => (window as any).__walletProbe.opens)
          ).toBe(0)
          await source
            .getByRole("button", { name: "Create wallet", exact: true })
            .click()
          await saved(source)
          const sourceIds = await wallets(source)
          expect(sourceIds).toHaveLength(1)

          await target.goto(apps[to] + "/wallet")

          await expect(
            target.getByRole("heading", {
              name: "External wallets",
              exact: true,
            })
          ).toBeVisible()

          await installControlledWallet(target)

          await target.evaluate(() => {
            ;(window as any).__walletProbe.restoredAddress =
              "wallet1@conduit.cash"
          })
          await expect.poll(async () => (await wallets(target)).length).toBe(1)

          expect(await wallets(target)).toEqual(sourceIds)
          await target
            .getByRole("button", { name: "Open wallet", exact: true })
            .click()
          await target
            .getByRole("button", { name: "Open with Nostr", exact: true })
            .click()
          await expect(
            target.getByRole("button", { name: "Receive", exact: true })
          ).toBeVisible()
          expect(
            await target.evaluate(
              () => (window as any).__walletProbe.registrations
            )
          ).toBe(0)
          expect(
            await target.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth
            )
          ).toBe(true)
          await target.screenshot({
            path: "/tmp/635-" + to + "-" + size.name + "-shared-wallet.png",
            mask: [
              target.getByLabel(
                to === "market"
                  ? "Open account menu"
                  : "Open merchant account menu"
              ),
            ],
          })
        } finally {
          await context.close()
          disposeRuntimeSignerIdentity(identity)
        }
      }
    )
  }
}
for (const size of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const from of ["market", "merchant"] as const) {
    test(
      size.name +
        " " +
        from +
        " import preserves receiving address in the other app @market @merchant",
      async ({ browser }) => {
        const identity = createRuntimeSignerIdentity()
        const context = await browser.newContext({ viewport: size })
        const source = await context.newPage()
        const target = await context.newPage()
        const to = from === "market" ? "merchant" : "market"
        try {
          for (const page of [source, target]) {
            await prepareControlledWallet(page)
            await installRealTestSigner(page, identity, relay)
          }
          await source.goto(apps[from] + "/wallet")
          await expect(
            source.getByRole("heading", { name: "My wallets", exact: true })
          ).toBeVisible()
          await installControlledWallet(source)
          await source
            .getByRole("button", { name: "Import wallet", exact: true })
            .click()
          const phrase = await source.evaluate(
            () => (window as any).__walletProbe.importMnemonic
          )
          await source
            .getByLabel("Recovery phrase", { exact: true })
            .fill(phrase)
          await source
            .getByRole("dialog")
            .getByRole("button", { name: "Import wallet", exact: true })
            .click()
          await saved(source)
          await expect(
            source.getByLabel("Lightning address", { exact: true })
          ).toHaveValue("")
          const sourceIds = await wallets(source)
          expect(sourceIds).toHaveLength(1)

          await target.goto(apps[to] + "/wallet")

          await expect(
            target.getByRole("heading", {
              name: "External wallets",
              exact: true,
            })
          ).toBeVisible()

          await installControlledWallet(target)

          await target.evaluate(() => {
            ;(window as any).__walletProbe.restoredAddress =
              "support@conduit.cash"
          })
          await expect.poll(async () => (await wallets(target)).length).toBe(1)

          expect(await wallets(target)).toEqual(sourceIds)
          await target
            .getByRole("button", { name: "Open wallet", exact: true })
            .click()
          await target
            .getByRole("button", { name: "Open with Nostr", exact: true })
            .click()
          await expect(
            target.getByRole("button", { name: "Receive", exact: true })
          ).toBeVisible()
          expect(
            await target.evaluate(
              () => (window as any).__walletProbe.registrations
            )
          ).toBe(0)
          expect(
            await target.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth
            )
          ).toBe(true)
          await expect(
            target.getByLabel("Lightning address", { exact: true })
          ).toHaveValue("")
          await target.screenshot({
            path:
              "/tmp/635-" + to + "-" + size.name + "-import-shared-wallet.png",
            mask: [
              target.getByLabel(
                to === "market"
                  ? "Open account menu"
                  : "Open merchant account menu"
              ),
            ],
          })
        } finally {
          await context.close()
          disposeRuntimeSignerIdentity(identity)
        }
      }
    )
  }
}
test("simultaneous setup across origins retains conflicts and never creates another wallet on retry @market @merchant", async ({
  browser,
}) => {
  const identity = createRuntimeSignerIdentity()
  const context = await browser.newContext()
  const pages = [await context.newPage(), await context.newPage()]
  let arrivals = 0
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    for (const [index, page] of pages.entries()) {
      await prepareControlledWallet(page)
      await installRealTestSigner(page, identity, relay)
      await page.exposeFunction("__walletSetupBarrier", async () => {
        if (++arrivals === 2) release()
        await barrier
      })
      await page.goto((index ? apps.merchant : apps.market) + "/wallet")
      await expect(
        page.getByRole("heading", { name: "My wallets", exact: true })
      ).toBeVisible()
      await installControlledWallet(page)
    }
    await Promise.all(
      pages.map((page) =>
        page.getByRole("button", { name: "Create wallet", exact: true }).click()
      )
    )
    await Promise.all(pages.map(saved))
    for (const page of pages) {
      await page
        .getByRole("button", { name: "Sync wallet recovery", exact: true })
        .click()
      await expect(
        page.getByText(
          "Wallet recovery is incomplete or conflicting. Existing wallets remain usable. Retry before setting up another wallet.",
          { exact: true }
        )
      ).toBeVisible()
      await expect.poll(async () => (await wallets(page)).length).toBe(2)
      const before = (await wallets(page)).sort()
      await page
        .getByRole("button", { name: "Create wallet", exact: true })
        .click()
      await expect(
        page
          .getByRole("dialog")
          .getByRole("status")
          .filter({ hasText: "recovery is incomplete" })
      ).toBeVisible()
      expect((await wallets(page)).sort()).toEqual(before)
      await page.getByRole("button", { name: "Cancel", exact: true }).click()
    }
  } finally {
    release()
    await context.close()
    disposeRuntimeSignerIdentity(identity)
  }
})

for (const app of ["market", "merchant"] as const) {
  test(
    app +
      " disabled address support leaves invoice receive usable @market @merchant",
    async ({ browser }) => {
      const identity = createRuntimeSignerIdentity()
      const context = await browser.newContext()
      const page = await context.newPage()
      try {
        await prepareControlledWallet(page)
        await installRealTestSigner(page, identity, relay)
        await page.goto(apps[app] + "/wallet")
        await expect(
          page.getByRole("heading", { name: "My wallets", exact: true })
        ).toBeVisible()
        await installControlledWallet(page)
        await page.evaluate(() => {
          ;(window as any).__walletProbe.addressUnavailableReason =
            "unconfigured"
        })
        await expect(
          page.getByText(
            "Mainnet uses real bitcoin. Save your recovery details before receiving funds.",
            { exact: true }
          )
        ).toBeVisible()
        expect(
          await page.evaluate(() => (window as any).__walletProbe.opens)
        ).toBe(0)
        await page
          .getByRole("button", { name: "Create wallet", exact: true })
          .click()
        await saved(page)
        await expect(
          page.getByText(
            "Receiving address: Lightning addresses are not enabled in this build.",
            { exact: true }
          )
        ).toBeVisible()
        await expect(
          page.getByRole("button", { name: "Retry address setup", exact: true })
        ).toHaveCount(0)
        await page.getByRole("button", { name: "Receive", exact: true }).click()
        await expect(
          page.getByRole("button", {
            name: "Create Lightning invoice",
            exact: true,
          })
        ).toBeEnabled()
      } finally {
        await context.close()
        expect(disposeRuntimeSignerIdentity(identity)).toBe(true)
      }
    }
  )
}

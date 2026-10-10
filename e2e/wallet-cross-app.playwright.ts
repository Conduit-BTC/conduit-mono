import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import type { WalletDescriptor } from "@conduit/core"
import {
  prepareControlledWallet,
  installControlledWallet,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  signRuntimeTestEvent,
} from "./helpers/real-nip07-signer"
import { publishTestRelayEvents } from "./helpers/auth"
const core = "/@fs" + path.resolve("packages/core/src/index.ts")
const storage =
  "/@fs" + path.resolve("packages/core/src/wallets/wallet-storage.ts")
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
async function saved(page: Page, makeMain = true) {
  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("heading", {
      name: /^(Wallet imported|Save your recovery details)$/,
    })
  ).toBeVisible()
  await expect(
    dialog.getByText("Checking for your Lightning address…", { exact: true })
  ).toHaveCount(0)
  if (
    await dialog
      .getByRole("heading", { name: "Wallet imported", exact: true })
      .count()
  ) {
    await expect(dialog.getByLabel("recovery-saved")).toHaveCount(0)
  } else {
    await expect(
      dialog.getByRole("heading", { name: "Save your recovery details" })
    ).toBeVisible()
    await dialog
      .getByLabel(
        "I saved the phrase, Spark account number and network somewhere private"
      )
      .check()
  }
  const chooser = dialog.getByRole("button", {
    name: "Get conduit.cash address",
    exact: true,
  })
  if (await chooser.count()) await chooser.click()
  if (!makeMain)
    await dialog
      .getByLabel("Make this my main wallet", { exact: true })
      .uncheck()
  await dialog.getByRole("button", { name: "Done", exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

async function gateWalletSigner(page: Page) {
  await page.evaluate(async (moduleUrl) => {
    const { db } = await import(moduleUrl)
    const credential = (await db.walletCredentials.toArray())[0]
    const ciphertext = JSON.parse(credential.credential).ciphertext
    const fixture = window as any
    const decrypt = fixture.nostr.nip44.decrypt
    const gate = { mode: "deny", entered: 0, exited: 0, release: () => {} }
    fixture.__walletSignerGate = gate
    fixture.nostr.nip44.decrypt = async (peer: string, value: string) => {
      if (value !== ciphertext) return decrypt(peer, value)
      gate.entered++
      try {
        if (gate.mode === "deny") throw new Error("Signer permission denied")
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
        return await decrypt(peer, value)
      } finally {
        gate.exited++
      }
    }
  }, core)
}

for (const app of ["market", "merchant"] as const) {
  test(`${app} chooses a name and applies its card address to latest complete metadata @market @merchant`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    try {
      await publishTestRelayEvents([
        signRuntimeTestEvent(identity, {
          kind: 0,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: JSON.stringify({
            name: "Wallet fixture",
            about: "Original",
            lud16: "current@wallet.example",
            custom: { retain: true },
          }),
        }),
      ])
      await prepareControlledWallet(page)
      await installRealTestSigner(page, identity, relay)
      await page.goto(apps[app] + "/wallet")
      await installControlledWallet(page)
      await page
        .getByRole("button", { name: "Create wallet", exact: true })
        .click()
      const dialog = page.getByRole("dialog")
      await expect(dialog.getByLabel("Conduit address name")).toBeVisible()
      await dialog.getByLabel("Conduit address name").fill("shop-main")
      await saved(page)
      await expect(
        page.getByLabel("Lightning address", { exact: true })
      ).toHaveValue("current@wallet.example")
      await page
        .getByRole("button", { name: "Keep the current address", exact: true })
        .click()
      await page
        .getByRole("button", {
          name: "Set as public Lightning address",
          exact: true,
        })
        .click()
      await page.evaluate(
        async ({ core, app }) => {
          await (
            await import(core)
          ).publishProfileContext({ about: "Competing ordinary edit" }, app)
        },
        { core, app }
      )
      await page
        .getByRole("button", { name: "Use the Conduit address", exact: true })
        .click()
      await expect(
        page.getByLabel("Lightning address", { exact: true })
      ).toHaveValue("shop-main@conduit.cash")
      const metadata = await page.evaluate(async (core) => {
        const { fetchProfileContext, getAccountSigner } = await import(core)
        const owner = getAccountSigner().pubkey
        const context = await fetchProfileContext(owner, {
          authenticatedPubkey: owner,
          accountPubkey: owner,
          skipCache: true,
          requireCompleteEvidence: true,
          evidenceScope: "profile_edit",
        })
        const raw = JSON.parse(context.frontier.rawContent)
        return { name: raw.name, about: raw.about, custom: raw.custom }
      }, core)
      expect(metadata).toEqual({
        name: "Wallet fixture",
        about: "Competing ordinary edit",
        custom: { retain: true },
      })
      await expect(page.getByText("Main wallet", { exact: true })).toBeVisible()
      await page.getByRole("button", { name: /^Manage Conduit Wallet/ }).click()
      await page.getByRole("menuitem", { name: "Lock", exact: true }).click()
      await expect(
        page.getByRole("button", { name: "Open wallet", exact: true })
      ).toBeVisible()
      await gateWalletSigner(page)
      await page
        .getByRole("button", { name: "Open wallet", exact: true })
        .click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(
        page.getByRole("alert").filter({ hasText: "authorization_denied" })
      ).toBeVisible()
      expect(
        await page.evaluate(() => (window as any).__walletProbe.opens)
      ).toBe(1)
      await page.evaluate(() => {
        ;(window as any).__walletSignerGate.mode = "hold"
      })
      await page
        .getByRole("button", { name: "Open wallet", exact: true })
        .click()
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__walletSignerGate.entered)
        )
        .toBe(2)
      // A descriptor reload while external permission is pending must retain
      // Opening and must not initialize another native wallet session.
      await page.evaluate(async (moduleUrl) => {
        const { db } = await import(moduleUrl)
        const wallet = (await db.wallets.toArray())[0]
        await db.wallets.update(wallet.id, { label: "Conduit Wallet renamed" })
      }, core)
      await expect(
        page.getByRole("button", { name: "Opening…", exact: true })
      ).toBeDisabled()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.evaluate(() => (window as any).__walletSignerGate.release())
      await expect(page.getByText("Ready", { exact: true })).toBeVisible()
      expect(
        await page.evaluate(() => (window as any).__walletProbe.opens)
      ).toBe(2)
      await page.getByRole("button", { name: /^Manage Conduit Wallet/ }).click()
      await page.getByRole("menuitem", { name: "Lock", exact: true }).click()
      await page
        .getByRole("button", { name: "Open wallet", exact: true })
        .click()
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__walletSignerGate.entered)
        )
        .toBe(3)
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page
        .getByLabel(
          app === "market" ? "Open account menu" : "Open merchant account menu"
        )
        .click()
      await page
        .getByRole("menuitem", { name: "Disconnect", exact: true })
        .click()
      await page.evaluate(() => (window as any).__walletSignerGate.release())
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__walletSignerGate.exited)
        )
        .toBe(3)
      expect(
        await page.evaluate(() => (window as any).__walletProbe.opens)
      ).toBe(2)
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__walletProbe?.disconnects ?? 0)
        )
        .toBeGreaterThan(0)
      if (app === "merchant") await page.goto(apps[app] + "/wallet")
      await expect(
        page.getByRole("button", { name: /^Manage Conduit Wallet/ })
      ).toHaveCount(0)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}
for (const from of ["market", "merchant"] as const) {
  test(`${from} imports a second main wallet and restores that selection across origins @market @merchant`, async ({
    browser,
  }) => {
    const identity = createRuntimeSignerIdentity()
    const context = await browser.newContext()
    const source = await context.newPage()
    const target = await context.newPage()
    const to = from === "market" ? "merchant" : "market"
    try {
      for (const page of [source, target]) {
        await prepareControlledWallet(page)
        await installRealTestSigner(page, identity, relay)
      }
      await source.goto(apps[from] + "/wallet")
      await installControlledWallet(source)
      await source
        .getByRole("button", { name: "Create wallet", exact: true })
        .click()
      await saved(source)
      await expect(
        source.getByLabel("Lightning address", { exact: true })
      ).toHaveValue("wallet1@conduit.cash")
      const first = (await wallets(source))[0]
      await source
        .getByRole("button", { name: "Import wallet", exact: true })
        .click()
      await source
        .getByLabel("Recovery phrase", { exact: true })
        .fill(
          await source.evaluate(
            () => (window as any).__walletProbe.importMnemonic
          )
        )
      await source.getByText("Advanced settings", { exact: true }).click()
      await source.getByLabel("Spark account number", { exact: true }).fill("7")
      await source
        .getByRole("dialog")
        .getByRole("button", { name: "Import wallet", exact: true })
        .click()
      await saved(source)
      await source
        .getByRole("button", { name: "Keep the current address", exact: true })
        .click()
      const ids = await wallets(source)
      expect(ids).toHaveLength(2)
      const selected = ids.find((id) => id !== first)!
      await expect(
        source.getByLabel("Lightning address", { exact: true })
      ).toHaveValue("wallet1@conduit.cash")
      await target.goto(apps[to] + "/wallet")
      await installControlledWallet(target, false, "support@conduit.cash")
      await expect.poll(async () => (await wallets(target)).length).toBe(2)
      await expect
        .poll(() =>
          target.evaluate(() =>
            (window as any).__walletProbe.openedAccounts.sort()
          )
        )
        .toEqual([1, 7])
      const state = await target.evaluate(
        async ({ core, storage, selected }) => {
          const { getAccountSigner } = await import(core)
          const { getMarketWalletStore } = await import(storage)
          const descriptor = (
            await getMarketWalletStore().listVisible(
              getAccountSigner()?.pubkey ?? null
            )
          ).find((wallet: WalletDescriptor) => wallet.id === selected)!
          return {
            intents: descriptor.defaultIntents,
            registrations: (window as any).__walletProbe.registrations,
          }
        },
        { core, storage, selected }
      )
      expect(state.intents.sort()).toEqual(["pay_invoice", "receive"])
      expect(state.registrations).toBe(0)
      expect((await wallets(target)).sort()).toEqual(ids.sort())
      await expect(
        target.getByLabel("Lightning address", { exact: true })
      ).toHaveValue("wallet1@conduit.cash")
      await expect(
        target.getByText("Main wallet", { exact: true })
      ).toBeVisible()
      await expect(
        target.getByRole("button", { name: "Open wallet", exact: true })
      ).toHaveCount(0)
      await expect(target.getByRole("dialog")).toHaveCount(0)
      await expect(target.getByText("Ready", { exact: true })).toHaveCount(2)
      // All recovered signer-backed wallets open, independent of main selection.
      await expect(
        target.getByText("Receiving address: support@conduit.cash", {
          exact: true,
        })
      ).toHaveCount(2)
    } finally {
      await context.close()
      disposeRuntimeSignerIdentity(identity)
    }
  })
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

          await installControlledWallet(target, false, "wallet1@conduit.cash")
          await expect.poll(async () => (await wallets(target)).length).toBe(1)

          expect(await wallets(target)).toEqual(sourceIds)
          await expect(
            target.getByRole("button", { name: "Open wallet", exact: true })
          ).toHaveCount(0)
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

          await installControlledWallet(target, false, "support@conduit.cash")
          await expect.poll(async () => (await wallets(target)).length).toBe(1)

          expect(await wallets(target)).toEqual(sourceIds)
          await expect(
            target.getByRole("button", { name: "Open wallet", exact: true })
          ).toHaveCount(0)
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
    await Promise.all(pages.map((page) => saved(page, false)))
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

import {
  prepareControlledWallet,
  installControlledWallet,
} from "./helpers/wallet-fixture"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"

const market = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const core = `/@fs${path.resolve("packages/core/src/index.ts")}`
// Recovery material is never captured in traces, screenshots or video.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"
test.use({ trace: "off", screenshot: "off", video: "off" })

async function enterWallets(page: Page) {
  await page.getByLabel("Open account menu").click()
  await page.getByRole("menuitem", { name: "Wallets", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "My wallets", exact: true })
  ).toBeVisible()
}
async function saveRecovery(page: Page, makeMain = true) {
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
    await expect(dialog.locator("#recovery-saved")).toHaveCount(0)
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
async function existingProfile(page: Page) {
  await page.evaluate(async (moduleUrl) => {
    const { publishProfileContext } = await import(moduleUrl)
    await publishProfileContext(
      {
        name: "Synthetic shopper",
        about: "Wallet UI regression",
        lud16: "current@wallet.example",
      },
      "market"
    )
  }, core)
}
async function publicAddress(page: Page) {
  return page.evaluate(async (moduleUrl) => {
    const { fetchProfileContext, getAccountSigner } = await import(moduleUrl)
    const owner = await getAccountSigner().getPublicKey()
    return (
      (
        await fetchProfileContext(owner, {
          authenticatedPubkey: owner,
          accountPubkey: owner,
          skipCache: true,
          requireCompleteEvidence: true,
          evidenceScope: "profile_edit",
        })
      ).profile.lud16 ?? ""
    )
  }, core)
}

for (const size of [
  { name: "desktop", width: 1280, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${size.name} create/import preserve recovery and explicit profile choices @market`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    await prepareControlledWallet(page)
    const identity = createRuntimeSignerIdentity()
    await installRealTestSigner(
      page,
      identity,
      `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
    )
    try {
      await page.goto(`${market}/products`)
      await expect(page.getByLabel("Open account menu")).toBeVisible()
      await existingProfile(page)
      await installControlledWallet(page)
      await enterWallets(page)
      await expect(
        page.getByRole("heading", { name: "External wallets" })
      ).toBeVisible()
      await expect(page.getByLabel("Local wallet password")).toHaveCount(0)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({
        path: `/tmp/635-wallet-${size.name}-empty.png`,
        mask: [page.getByLabel("Open account menu")],
      })
      await page
        .getByRole("button", { name: "Create wallet", exact: true })
        .click()
      await saveRecovery(page)
      expect(await publicAddress(page)).toBe("current@wallet.example")
      await page
        .getByRole("button", { name: "Keep the current address" })
        .click()
      await expect(
        page.getByRole("button", { name: "Receive", exact: true })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Send", exact: true })
      ).toBeVisible()
      await expect(
        page.getByText("Receiving address: wallet1@conduit.cash", {
          exact: true,
        })
      ).toBeVisible()
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({
        path: `/tmp/635-wallet-${size.name}-ready.png`,
        mask: [page.getByLabel("Open account menu")],
      })
      // The saved recovery and credential remain encrypted and contain the
      // account/network needed to reopen the same native wallet.
      const encrypted = await page.evaluate(async (moduleUrl) => {
        const { db } = await import(moduleUrl)
        const probe = (window as any).__walletProbe
        const rows = await db.walletCredentials.toArray()
        const payload = JSON.parse(
          rows.find((row: any) => row.providerId === "spark").credential
        )
        return {
          type: payload.type,
          plaintextAbsent: !JSON.stringify(rows).includes(probe.savedMnemonic),
          accountNumber: payload.accountNumber,
        }
      }, core)
      expect(encrypted).toEqual({
        type: "signer",
        plaintextAbsent: true,
        accountNumber: 1,
      })
      await page
        .getByRole("button", { name: "Import wallet", exact: true })
        .click()
      await expect(page.getByLabel("Recovery phrase")).toBeVisible()
      await expect(page.getByLabel("Spark account number")).toBeHidden()
      await page.screenshot({
        path: `/tmp/635-wallet-${size.name}-import.png`,
        mask: [page.getByLabel("Open account menu")],
      })
      await page.getByText("Advanced settings", { exact: true }).click()
      await page.getByLabel("Spark account number").fill("7")
      await page.evaluate(() => {
        const input = document.getElementById(
          "portable-mnemonic"
        ) as HTMLTextAreaElement
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )!.set!
        setter.call(input, (window as any).__walletProbe.importMnemonic)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Import wallet", exact: true })
        .click()
      await saveRecovery(page)
      await expect(
        page.getByText(
          "Payments to its existing address continue reaching the recovered wallet.",
          { exact: false }
        )
      ).toBeVisible()
      expect(await publicAddress(page)).toBe("current@wallet.example")
      await expect(
        page.getByText("Receiving address: support@conduit.cash", {
          exact: true,
        })
      ).toBeVisible()
      const recovered = await page.evaluate(() => ({
        registrations: (window as any).__walletProbe.registrations,
        account: (window as any).__walletProbe.lastAccount,
      }))
      expect(recovered).toEqual({ registrations: 1, account: 7 })
      await page
        .getByRole("button", { name: "Use the Conduit address" })
        .click()
      await expect.poll(() => publicAddress(page)).toBe("support@conduit.cash")
      // Reimporting the same phrase reopens the retained registration.
      await page
        .getByRole("button", { name: "Import wallet", exact: true })
        .click()
      await page.getByText("Advanced settings", { exact: true }).click()
      await page.getByLabel("Spark account number").fill("7")
      await page.evaluate(() => {
        const input = document.getElementById(
          "portable-mnemonic"
        ) as HTMLTextAreaElement
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )!.set!.call(input, (window as any).__walletProbe.importMnemonic)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Import wallet", exact: true })
        .click()
      await saveRecovery(page)
      expect(
        await page.evaluate(
          async (moduleUrl) =>
            (await (await import(moduleUrl)).db.wallets.toArray()).length,
          core
        )
      ).toBe(2)
      expect(await publicAddress(page)).toBe("support@conduit.cash")
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

test("first wallet gets the disclosed empty-profile default and address failure stays usable @market", async ({
  page,
}) => {
  await prepareControlledWallet(page)
  const identity = createRuntimeSignerIdentity()
  await installRealTestSigner(
    page,
    identity,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  )
  try {
    await page.goto(`${market}/products`)
    await expect(page.getByLabel("Open account menu")).toBeVisible()
    await installControlledWallet(page, true)
    await enterWallets(page)
    await page
      .getByRole("button", { name: "Create wallet", exact: true })
      .click()
    await saveRecovery(page)
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Retry address setup" })
    ).toBeVisible()
    expect(await publicAddress(page)).toBe("")
    // No automatic profile change is authorized by an additional wallet.
    await page.evaluate(() => {
      ;(window as any).__walletProbe.failRegistration = false
    })
    await page.getByRole("button", { name: "Retry address setup" }).click()
    expect(await publicAddress(page)).toBe("")
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("empty profile uses the first created address only after recovery acknowledgement @market", async ({
  page,
}) => {
  await prepareControlledWallet(page)
  const identity = createRuntimeSignerIdentity()
  await installRealTestSigner(
    page,
    identity,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  )
  try {
    await page.goto(`${market}/products`)
    await expect(page.getByLabel("Open account menu")).toBeVisible()
    await installControlledWallet(page)
    await enterWallets(page)
    await page
      .getByRole("button", { name: "Create wallet", exact: true })
      .click()
    await expect(
      page.getByRole("heading", { name: "Save your recovery details" })
    ).toBeVisible()
    expect(await publicAddress(page)).toBe("")
    await saveRecovery(page)
    await expect.poll(() => publicAddress(page)).toBe("wallet1@conduit.cash")
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("legacy migration keeps its old encrypted copy and fresh sign-in reopens without a wallet password @market", async ({
  page,
}) => {
  await prepareControlledWallet(page)
  const identity = createRuntimeSignerIdentity()
  await installRealTestSigner(
    page,
    identity,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  )
  try {
    await page.goto(`${market}/products`)
    await expect(page.getByLabel("Open account menu")).toBeVisible()
    await installControlledWallet(page)
    await page.evaluate(async () => {
      const {
        getMarketWalletRegistry,
        getMarketWalletStore,
        registerSparkWalletAtomically,
      } = await import("/src/lib/wallet-storage.ts")
      const { encryptSparkMnemonic } =
        await import("/src/lib/spark-recovery.ts")
      const probe = (window as any).__walletProbe
      probe.legacyPassword = crypto.randomUUID()
      const binding = {
        walletId: crypto.randomUUID(),
        providerId: "spark" as const,
        network: "mainnet" as const,
        accountNumber: 7,
      }
      const store = getMarketWalletStore()
      const registry = getMarketWalletRegistry()
      const recovery = {
        ...binding,
        type: "password" as const,
        recovery: await encryptSparkMnemonic(
          probe.importMnemonic,
          probe.legacyPassword,
          binding
        ),
      }
      const wallet = await registerSparkWalletAtomically({
        store,
        recovery,
        register: () =>
          registry.add({
            id: binding.walletId,
            kind: "portable",
            providerId: "spark",
            label: "Legacy wallet",
            network: "mainnet",
            capabilities: ["pay_invoice", "receive", "balance"],
          }),
      })
      await registry.setDefault(wallet.id, "pay_invoice")
    })
    await enterWallets(page)
    await page.getByRole("button", { name: "Open wallet", exact: true }).click()
    await expect(
      page.getByLabel("Wallet password", { exact: true })
    ).toBeVisible()
    await page.evaluate(() => {
      const input = document.getElementById(
        "unlock-password"
      ) as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, (window as any).__walletProbe.legacyPassword)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await page
      .getByLabel(
        "Use Nostr sign-in from now on. Keep the existing encrypted recovery copy."
      )
      .click()
    await page
      .getByRole("button", { name: "Open and use Nostr sign-in" })
      .click()
    await expect(page.getByText("Ready", { exact: true })).toBeVisible()
    expect(
      await page.evaluate(async (moduleUrl) => {
        const { db } = await import(moduleUrl)
        const payload = JSON.parse(
          (await db.walletCredentials.toArray())[0].credential
        )
        return {
          signer: payload.type === "signer",
          legacy: payload.legacyRecovery?.type === "password",
          plaintextAbsent: !JSON.stringify(payload).includes(
            (window as any).__walletProbe.savedMnemonic
          ),
          account: payload.accountNumber,
        }
      }, core)
    ).toEqual({ signer: true, legacy: true, plaintextAbsent: true, account: 7 })
    await page.getByLabel("Manage Legacy wallet").click()
    await page.getByRole("menuitem", { name: "Lock", exact: true }).click()
    await page.getByRole("button", { name: "Open wallet", exact: true }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.getByText("Ready", { exact: true })).toBeVisible()
    await page.getByLabel("Manage Legacy wallet").click()
    await page
      .getByRole("menuitem", { name: "Use previous password", exact: true })
      .click()
    await expect(
      page.getByLabel("Use the previous wallet password")
    ).toBeVisible()
    await expect(
      page.getByLabel("Wallet password", { exact: true })
    ).toBeVisible()
    await page.evaluate(() => {
      const input = document.getElementById(
        "unlock-password"
      ) as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, (window as any).__walletProbe.legacyPassword)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Unlock", exact: true })
      .click()
    await expect(page.getByText("Ready", { exact: true })).toBeVisible()
    const legacyPassword = await page.evaluate(
      () => (window as any).__walletProbe.legacyPassword as string
    )
    // A new document gets a fresh account session and the same encrypted local
    // wallet. The fixture controls the network layer before initialization.
    await page.goto(`${market}/products`)
    await expect(page.getByLabel("Open account menu")).toBeVisible()
    await installControlledWallet(page)
    await enterWallets(page)
    await expect(page.getByText("Ready", { exact: true })).toBeVisible()
    expect(
      await page.evaluate(
        async (moduleUrl) => ({
          wallets: await (await import(moduleUrl)).db.wallets.count(),
          opens: (window as any).__walletProbe.opens,
          account: (window as any).__walletProbe.lastAccount,
          registrations: (window as any).__walletProbe.registrations,
        }),
        core
      )
    ).toEqual({ wallets: 1, opens: 1, account: 7, registrations: 0 })
    await page
      .getByRole("button", { name: "Create wallet", exact: true })
      .click()
    await saveRecovery(page, false)
    await page.getByLabel("Manage Legacy wallet").click()
    await page
      .getByRole("menuitem", { name: "Recovery details", exact: true })
      .click()
    let recoveryDialog = page.getByRole("dialog")
    await recoveryDialog.getByLabel("Use the previous wallet password").check()
    await page.evaluate((password) => {
      const input = document.getElementById(
        "recovery-password"
      ) as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, password)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }, legacyPassword)
    await recoveryDialog
      .getByRole("button", { name: "Show recovery phrase", exact: true })
      .click()
    await recoveryDialog
      .getByRole("button", { name: "Done", exact: true })
      .click()
    await expect(page.getByLabel("Manage Legacy wallet")).toBeFocused()
    await page.getByLabel("Manage Conduit Wallet").click()
    await page
      .getByRole("menuitem", { name: "Recovery details", exact: true })
      .click()
    recoveryDialog = page.getByRole("dialog")
    await expect(
      recoveryDialog.getByLabel("Wallet password", { exact: true })
    ).toHaveCount(0)
    await expect(
      recoveryDialog.getByRole("button", {
        name: "Show recovery phrase",
        exact: true,
      })
    ).toBeEnabled()
    await recoveryDialog
      .getByRole("button", { name: "Show recovery phrase", exact: true })
      .click()
    await recoveryDialog
      .getByRole("button", { name: "Done", exact: true })
      .click()
    await expect(page.getByLabel("Manage Conduit Wallet")).toBeFocused()
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("receive keeps pending address setup visible and blocks conflicting controls @market", async ({
  page,
}) => {
  await prepareControlledWallet(page)
  const identity = createRuntimeSignerIdentity()
  await installRealTestSigner(
    page,
    identity,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  )
  try {
    await page.goto(`${market}/products`)
    await expect(page.getByLabel("Open account menu")).toBeVisible()
    await existingProfile(page)
    await installControlledWallet(page)
    await page.evaluate(() => {
      ;(window as any).__walletProbe.failRegistration = true
    })
    await enterWallets(page)
    await page
      .getByRole("button", { name: "Create wallet", exact: true })
      .click()
    await saveRecovery(page)
    await page.getByRole("button", { name: "Receive", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await page.evaluate(() => {
      const probe = (window as any).__walletProbe
      probe.failRegistration = false
      probe.delayRegistration = true
    })
    await dialog
      .getByRole("button", { name: "Retry address setup", exact: true })
      .click()
    await expect(
      dialog.getByRole("button", { name: "Setting up address…" })
    ).toBeDisabled()
    await expect(
      dialog.getByRole("button", { name: "Create Lightning invoice" })
    ).toBeDisabled()
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true })
    ).toBeDisabled()
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true })
    ).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(dialog).toBeVisible()
    await page.mouse.click(5, 5)
    await expect(dialog).toBeVisible()
    await page.evaluate(() => {
      ;(window as any).__walletProbe.releaseRegistration()
    })
    await expect(
      dialog.getByRole("img", { name: "Reusable Lightning address QR code" })
    ).toBeVisible()
    await dialog.getByRole("button", { name: "Done", exact: true }).click()
    await expect(dialog).toHaveCount(0)
  } finally {
    expect(disposeRuntimeSignerIdentity(identity)).toBe(true)
  }
})

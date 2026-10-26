import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import type { AuthContextValue } from "@conduit/core"
import type { UseWalletsReturn } from "@conduit/core/hooks/useWallets"
import {
  installControlledWallet,
  observeWalletController,
  openWalletSetup,
  prepareControlledWallet,
  saveWalletRecovery,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"
import { viteFileModuleUrl } from "./helpers/vite-file-module-url"

const storage = viteFileModuleUrl(
  path.resolve("packages/core/src/wallets/wallet-storage.ts")
)
type Mode = "hold" | "reject" | "missing" | "pass"
type Probe = { mode: Mode; releases: Array<() => void>; restore(): void }
test.setTimeout(90_000)
test.use({ trace: "off", screenshot: "off", video: "off" })

async function setup(page: Page, app: "market" | "merchant") {
  const identity = createRuntimeSignerIdentity()
  await prepareControlledWallet(page)
  await observeWalletController(page, undefined, undefined, true)
  await installRealTestSigner(
    page,
    identity,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  )
  const port =
    app === "market"
      ? (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000")
      : (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001")
  await page.goto(`http://127.0.0.1:${port}/wallet`)
  await installControlledWallet(page)
  await openWalletSetup(page, "Create wallet")
  await saveWalletRecovery(page)
  await page.getByRole("button", { name: /^Manage / }).click()
  await expect(
    page.getByRole("menuitem", {
      name: "Remove wallet from account",
      exact: true,
    })
  ).toBeEnabled()
  return identity
}

async function control(page: Page, mode: Mode) {
  await page.evaluate(
    async ({ storage, mode }) => {
      const store = (await import(storage)).getMarketWalletStore()
      const original = store.getSparkRecovery.bind(store)
      const probe: Probe = {
        mode,
        releases: [],
        restore: () => {
          store.getSparkRecovery = original
        },
      }
      store.getSparkRecovery = async (walletId: string) => {
        if (probe.mode === "pass") return original(walletId)
        if (probe.mode === "reject")
          throw new Error("Controlled metadata failure")
        if (probe.mode === "missing") return null
        return new Promise((resolve) =>
          probe.releases.push(() => resolve(null))
        )
      }
      Reflect.set(window, "__metadataRead", probe)
    },
    { storage, mode }
  )
}

async function controlRow(page: Page, mode: Mode) {
  await page.evaluate((mode) => {
    ;(Reflect.get(window, "__metadataRead") as Probe | undefined)?.restore()
    const wallets = Reflect.get(
      window,
      "__controlledWalletController"
    ) as UseWalletsReturn
    const original = wallets.getSparkRecoveryType
    const observer = Reflect.get(window, "__observeControlledWalletController")
    const probe: Probe = {
      mode,
      releases: [],
      restore: () => {
        wallets.getSparkRecoveryType = original
        Reflect.set(window, "__observeControlledWalletController", observer)
      },
    }
    // Control the UI's read boundary only. Registry visibility, rename,
    // account teardown and provider operations retain their real storage reads.
    const read: UseWalletsReturn["getSparkRecoveryType"] = async (walletId) => {
      if (probe.mode === "pass") return original(walletId)
      if (probe.mode === "reject")
        throw new Error("Controlled metadata failure")
      if (probe.mode === "missing") return null
      return new Promise((resolve) => probe.releases.push(() => resolve(null)))
    }
    wallets.getSparkRecoveryType = read
    Reflect.set(
      window,
      "__observeControlledWalletController",
      (next: UseWalletsReturn) => {
        observer?.(next)
        next.getSparkRecoveryType = read
      }
    )
    Reflect.set(window, "__metadataRead", probe)
  }, mode)
}

async function mode(page: Page, mode: Mode) {
  await page.evaluate((mode) => {
    ;(Reflect.get(window, "__metadataRead") as Probe).mode = mode
  }, mode)
}
async function release(page: Page) {
  expect(
    await page.evaluate(async () => {
      const releases = (
        Reflect.get(window, "__metadataRead") as Probe
      ).releases.splice(0)
      releases.forEach((release) => release())
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      return releases.length
    })
  ).toBeGreaterThan(0)
}
async function cleanup(
  page: Page,
  identity: ReturnType<typeof createRuntimeSignerIdentity>
) {
  if (!page.isClosed())
    await page.evaluate(() =>
      (Reflect.get(window, "__metadataRead") as Probe | undefined)?.restore()
    )
  disposeRuntimeSignerIdentity(identity)
}

for (const app of ["market", "merchant"] as const) {
  test(`${app} stalled removal check offers retry and ignores late completion @market @merchant`, async ({
    page,
  }) => {
    const identity = await setup(page, app)
    try {
      await control(page, "hold")
      await page
        .getByRole("menuitem", {
          name: "Remove wallet from account",
          exact: true,
        })
        .click()
      const dialog = page.getByRole("alertdialog")
      await expect(
        dialog.getByText("Checking the local recovery method before removal…")
      ).toBeVisible()
      await expect(dialog.getByRole("switch")).toBeDisabled()
      await expect(dialog.getByRole("status")).toContainText(
        "temporarily unavailable",
        { timeout: 6_500 }
      )
      await expect(
        dialog.getByRole("button", {
          name: "Check recovery first",
          exact: true,
        })
      ).toBeDisabled()
      await mode(page, "pass")
      await dialog.getByRole("button", { name: "Retry recovery check" }).click()
      await expect(dialog.getByRole("switch")).toBeEnabled()
      await release(page)
      await expect(dialog.getByRole("switch")).toBeEnabled()
      await expect(
        dialog.getByRole("button", {
          name: "Remove wallet from account",
          exact: true,
        })
      ).toBeDisabled()
      await dialog.getByRole("switch").click()
      await expect(
        dialog.getByRole("button", {
          name: "Remove wallet from account",
          exact: true,
        })
      ).toBeEnabled()
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(page.getByRole("article")).toHaveCount(1)
    } finally {
      await cleanup(page, identity)
    }
  })
}

test("removal distinguishes failed reads from missing recovery and retires closed reads @market", async ({
  page,
}) => {
  const identity = await setup(page, "market")
  try {
    await control(page, "reject")
    await page
      .getByRole("menuitem", {
        name: "Remove wallet from account",
        exact: true,
      })
      .click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog.getByRole("status")).toContainText(
      "temporarily unavailable"
    )
    await mode(page, "missing")
    await dialog.getByRole("button", { name: "Retry recovery check" }).click()
    await expect(dialog.getByRole("status")).toContainText(
      "No local recovery method was found"
    )
    await expect(dialog.getByRole("switch")).toBeDisabled()
    await mode(page, "hold")
    await dialog.getByRole("button", { name: "Retry recovery check" }).click()
    await expect(dialog.getByRole("switch")).toBeDisabled()
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await mode(page, "pass")
    await page.getByRole("button", { name: /^Manage / }).click()
    await page
      .getByRole("menuitem", {
        name: "Remove wallet from account",
        exact: true,
      })
      .click()
    await expect(dialog.getByRole("switch")).toBeEnabled()
    await release(page)
    await expect(dialog.getByRole("switch")).toBeEnabled()
    await expect(
      dialog.getByRole("button", {
        name: "Remove wallet from account",
        exact: true,
      })
    ).toBeDisabled()
  } finally {
    await cleanup(page, identity)
  }
})

test("wallet menu retries a stalled check and account replacement retires removal @market", async ({
  page,
}) => {
  const identity = await setup(page, "market")
  try {
    await page.keyboard.press("Escape")
    await controlRow(page, "hold")
    // The real rename refreshes the descriptor while only the UI read is held.
    await page.getByRole("button", { name: /^Rename / }).click()
    await page.getByLabel("Wallet name", { exact: true }).fill("Recovery test")
    await page.getByRole("button", { name: "Save name", exact: true }).click()
    await page
      .getByRole("button", { name: "Manage Recovery test", exact: true })
      .click()
    await expect(
      page.getByRole("menuitem", { name: "Checking recovery…", exact: true })
    ).toBeDisabled()
    await expect(
      page.getByRole("menuitem", { name: "Retry recovery check" })
    ).toBeVisible({ timeout: 6_500 })
    await mode(page, "pass")
    await page.getByRole("menuitem", { name: "Retry recovery check" }).click()
    await page
      .getByRole("button", { name: "Manage Recovery test", exact: true })
      .click()
    await expect(
      page.getByRole("menuitem", {
        name: "Remove wallet from account",
        exact: true,
      })
    ).toBeEnabled()
    await release(page)
    await mode(page, "hold")
    await page
      .getByRole("menuitem", {
        name: "Remove wallet from account",
        exact: true,
      })
      .click()
    await expect(
      page.getByRole("alertdialog").getByRole("switch")
    ).toBeDisabled()
    await page.evaluate(async () => {
      await (
        Reflect.get(window, "__controlledWalletAuth") as AuthContextValue
      ).disconnect()
    })
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await release(page)
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    expect(
      await page.evaluate(
        () =>
          (
            Reflect.get(
              window,
              "__controlledWalletController"
            ) as UseWalletsReturn
          ).portableWallets.length
      )
    ).toBe(0)
  } finally {
    await cleanup(page, identity)
  }
})

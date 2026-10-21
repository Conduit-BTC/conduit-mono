import { randomUUID } from "node:crypto"
import path from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import {
  installControlledWallet,
  observeWalletController,
  prepareControlledWallet,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"
import { viteFileModuleUrl } from "./helpers/vite-file-module-url"

const core = viteFileModuleUrl(path.resolve("packages/core/src/index.ts"))
const recovery = viteFileModuleUrl(
  path.resolve("packages/core/src/wallets/account-spark-recovery.ts")
)
const phrase = viteFileModuleUrl(
  path.resolve("packages/core/src/wallets/spark-recovery.ts")
)
const storage = viteFileModuleUrl(
  path.resolve("packages/core/src/wallets/wallet-storage.ts")
)
const relay = "ws://127.0.0.1:" + process.env.PLAYWRIGHT_RELAY_PORT
const apps = {
  market: "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"),
  merchant:
    "http://127.0.0.1:" + (process.env.PLAYWRIGHT_MERCHANT_PORT ?? "7001"),
}

type RecoveryReadProbe = {
  mode: "hold" | "reject" | "missing" | "pass"
  passThroughReads: number
  release: Array<() => void>
  restore(): void
}

type ControlledWalletController = {
  loading: boolean
  recoverySync: string
  portableWallets: Array<{ id: string }>
  lockSpark(walletId: string): Promise<void>
  retryRecovery(): Promise<void>
}

type ControlledWalletAuth = {
  accountPubkey: string | null
  authGeneration: number
  signerReadiness: string
  connect(input: { method: "nip07" }): Promise<void>
  disconnect(): Promise<void>
}

type ControlledWalletProbe = {
  opens: number
  openBarrier?: () => Promise<void>
  slowOpenCompleted?: boolean
}

test.setTimeout(90_000)
test.use({ trace: "off", screenshot: "off", video: "off" })

async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const wallets = Reflect.get(window, "__controlledWalletController") as
          ControlledWalletController | undefined
        const auth = Reflect.get(window, "__controlledWalletAuth") as
          ControlledWalletAuth | undefined
        return (
          auth?.signerReadiness === "ready" &&
          wallets?.loading === false &&
          !["idle", "checking"].includes(wallets.recoverySync)
        )
      })
    )
    .toBe(true)
}

async function seedBackup(page: Page) {
  await page.evaluate(
    async ({ core, recovery, phrase }) => {
      const signer = (await import(core)).getAccountSigner()
      const service = (await import(recovery)).getAccountSparkRecovery(signer)
      const candidate = await service.prepare({
        mnemonic: (await import(phrase)).generateSparkMnemonic(),
        network: "mainnet",
        accountNumber: 7,
      })
      await service.preparePrimary(candidate)
    },
    { core, recovery, phrase }
  )
}

async function seedLegacyPasswordWallet(
  page: Page,
  password?: string,
  label = "Legacy fence"
) {
  await page.evaluate(
    async ({ core, phrase, password, label }) => {
      const { db } = await import(core)
      const random = (length: number) =>
        btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(length)))
        )
      const id = crypto.randomUUID()
      const timestamp = Date.now()
      const binding = {
        walletId: id,
        providerId: "spark" as const,
        network: "mainnet" as const,
        accountNumber: 1,
      }
      const recoveryApi = await import(phrase)
      const encrypted = password
        ? await recoveryApi.encryptSparkMnemonic(
            recoveryApi.generateSparkMnemonic(),
            password,
            binding
          )
        : {
            version: 2,
            kdf: "PBKDF2-SHA-256",
            cipher: "AES-GCM",
            iterations: 100_000,
            salt: random(16),
            iv: random(12),
            ciphertext: random(48),
          }
      await db.transaction(
        "rw",
        [db.wallets, db.walletCredentials],
        async () => {
          await db.wallets.put({
            id,
            kind: "portable",
            providerId: "spark",
            label,
            network: "mainnet",
            capabilities: ["receive", "balance"],
            status: "locked",
            defaultIntents: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          await db.walletCredentials.put({
            walletId: id,
            providerId: "spark",
            credential: JSON.stringify({
              type: "password",
              walletId: id,
              providerId: "spark",
              network: "mainnet",
              accountNumber: 1,
              recovery: encrypted,
            }),
            createdAt: timestamp,
            updatedAt: timestamp,
          })
        }
      )
    },
    { core, phrase, password, label }
  )
}

async function waitForPasswordRecovery(page: Page, label = "Legacy fence") {
  await page
    .getByRole("button", { name: `Manage ${label}`, exact: true })
    .click()
  await expect(
    page.getByRole("menuitem", { name: "Remove from this device", exact: true })
  ).toBeEnabled()
  await page.keyboard.press("Escape")
}

async function prepareRecoveryRead(
  page: Page,
  app: keyof typeof apps = "market",
  password?: string
) {
  await prepareControlledWallet(page)
  await observeWalletController(page, undefined, undefined, true)
  await page.goto(apps[app] + "/wallet")
  await installControlledWallet(page)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const wallets = Reflect.get(window, "__controlledWalletController") as
          ControlledWalletController | undefined
        return wallets?.loading
      })
    )
    .toBe(false)
  await seedLegacyPasswordWallet(page, password)
  await expect(
    page.getByRole("button", { name: "Open wallet", exact: true })
  ).toBeVisible()
  await waitForPasswordRecovery(page)
}

async function controlRecoveryRead(
  page: Page,
  mode: "hold" | "reject" | "missing",
  passThroughReads = 0
) {
  await page.evaluate(
    async ({ storage, mode, passThroughReads }) => {
      const store = (await import(storage)).getMarketWalletStore()
      const original = store.getSparkRecovery.bind(store)
      const probe: RecoveryReadProbe = {
        mode,
        passThroughReads,
        release: [],
        restore: () => {
          store.getSparkRecovery = original
        },
      }
      Reflect.set(window, "__recoveryRead", probe)
      store.getSparkRecovery = async (walletId: string) => {
        if (probe.passThroughReads > 0) {
          probe.passThroughReads--
          return original(walletId)
        }
        if (probe.mode === "pass") return original(walletId)
        if (probe.mode === "reject")
          throw new Error("Controlled metadata read failure")
        if (probe.mode === "missing") return null
        return new Promise((resolve) => {
          probe.release.push(() => resolve(null))
        })
      }
    },
    { storage, mode, passThroughReads }
  )
}

async function setRecoveryReadMode(
  page: Page,
  mode: RecoveryReadProbe["mode"]
) {
  await page.evaluate((mode) => {
    const probe = Reflect.get(window, "__recoveryRead") as RecoveryReadProbe
    probe.mode = mode
  }, mode)
}

async function releaseRecoveryReads(page: Page) {
  const released = await page.evaluate(async () => {
    const probe = Reflect.get(window, "__recoveryRead") as RecoveryReadProbe
    const releases = probe.release.splice(0)
    for (const release of releases) release()
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )
    return releases.length
  })
  expect(released).toBeGreaterThan(0)
}

async function restoreRecoveryRead(page: Page) {
  if (page.isClosed()) return
  await page.evaluate(() => {
    const probe = Reflect.get(window, "__recoveryRead") as
      RecoveryReadProbe | undefined
    probe?.restore()
  })
}

async function setInputValue(input: Locator, value: string) {
  await input.evaluate((element, nextValue) => {
    if (!(element instanceof HTMLInputElement))
      throw new Error("Expected a password input.")
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set
    if (!setter) throw new Error("The input value setter is unavailable.")
    setter.call(element, nextValue)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  }, value)
}

function controlledProbe(page: Page) {
  return page.evaluate(() => {
    const probe = Reflect.get(window, "__walletProbe") as ControlledWalletProbe
    return { opens: probe.opens, slowOpenCompleted: probe.slowOpenCompleted }
  })
}

test("recovery lookup stops checking and offers a safe retry after a stalled read @market", async ({
  page,
}) => {
  const password = randomUUID()
  await prepareRecoveryRead(page, "market", password)
  // Pass the outer Open wallet preflight; stall the actual dialog's read.
  await controlRecoveryRead(page, "hold", 1)
  try {
    await page.getByRole("button", { name: "Open wallet", exact: true }).click()
    const dialog = page.getByRole("dialog", {
      name: "Unlock Legacy fence",
      exact: true,
    })
    await expect(
      dialog.getByText("Checking recovery method", { exact: true })
    ).toBeVisible()
    await expect(dialog.getByRole("alert")).toContainText(
      "temporarily unavailable",
      { timeout: 6_500 }
    )
    await expect(dialog.getByLabel("Wallet password")).toHaveCount(0)
    await setRecoveryReadMode(page, "pass")
    await dialog
      .getByRole("button", { name: "Retry recovery check", exact: true })
      .click()
    const passwordInput = dialog.getByLabel("Wallet password")
    await expect(passwordInput).toBeVisible()
    await releaseRecoveryReads(page)
    await expect(passwordInput).toBeVisible()
    await expect(dialog.getByRole("alert")).toHaveCount(0)
    expect((await controlledProbe(page)).opens).toBe(0)

    await setInputValue(passwordInput, password)
    await dialog.getByRole("button", { name: "Unlock", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toBeVisible()
    expect((await controlledProbe(page)).opens).toBe(1)
  } finally {
    await restoreRecoveryRead(page)
  }
})

test("recovery lookup also bounds the Open wallet preflight without opening a provider @market", async ({
  page,
}) => {
  await prepareRecoveryRead(page)
  const card = page.getByRole("article", {
    name: "Legacy fence wallet",
    exact: true,
  })
  await expect(
    card.getByRole("button", { name: "Open wallet", exact: true })
  ).toBeVisible()
  await controlRecoveryRead(page, "hold")
  try {
    await card.getByRole("button", { name: "Open wallet", exact: true }).click()
    await expect(card.getByRole("alert")).toContainText(
      "temporarily unavailable",
      { timeout: 6_500 }
    )
    await expect(
      card.getByRole("button", { name: "Open wallet", exact: true })
    ).toBeEnabled()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await setRecoveryReadMode(page, "pass")
    await card.getByRole("button", { name: "Open wallet", exact: true }).click()
    await expect(
      page.getByRole("dialog").getByLabel("Wallet password")
    ).toBeVisible()
    expect((await controlledProbe(page)).opens).toBe(0)
  } finally {
    await restoreRecoveryRead(page)
  }
})

for (const app of ["market", "merchant"] as const) {
  test(`${app} recovery lookup distinguishes unavailable from missing and retries without revealing recovery @${app}`, async ({
    page,
  }) => {
    await prepareRecoveryRead(page, app)
    await controlRecoveryRead(page, "reject")
    try {
      await page
        .getByRole("button", { name: "Manage Legacy fence", exact: true })
        .click()
      await page
        .getByRole("menuitem", { name: "Recovery details", exact: true })
        .click()
      const dialog = page.getByRole("dialog", {
        name: "Recovery for Legacy fence",
        exact: true,
      })
      await expect(dialog.getByRole("alert")).toContainText(
        "temporarily unavailable"
      )
      await expect(
        dialog.getByText("No local recovery method was found.", {
          exact: false,
        })
      ).toHaveCount(0)
      await expect(
        dialog.getByRole("button", {
          name: "Show recovery phrase",
          exact: true,
        })
      ).toHaveCount(0)

      await setRecoveryReadMode(page, "missing")
      await dialog
        .getByRole("button", { name: "Retry recovery check", exact: true })
        .click()
      await expect(dialog.getByRole("alert")).toContainText(
        "No local recovery method was found."
      )
      await expect(dialog.getByLabel("Wallet password")).toHaveCount(0)

      await setRecoveryReadMode(page, "pass")
      await dialog
        .getByRole("button", { name: "Retry recovery check", exact: true })
        .click()
      await expect(dialog.getByLabel("Wallet password")).toBeVisible()
      await expect(
        dialog.getByRole("button", {
          name: "Show recovery phrase",
          exact: true,
        })
      ).toBeDisabled()
      expect((await controlledProbe(page)).opens).toBe(0)
    } finally {
      await restoreRecoveryRead(page)
    }
  })
}

test("recovery lookup retires a closed wallet's read before another wallet or reopen @market", async ({
  page,
}) => {
  await prepareRecoveryRead(page)
  await seedLegacyPasswordWallet(page, undefined, "Other legacy")
  await expect(
    page.getByRole("button", { name: "Manage Other legacy", exact: true })
  ).toBeVisible()
  await waitForPasswordRecovery(page, "Other legacy")
  await controlRecoveryRead(page, "hold")
  try {
    await page
      .getByRole("button", { name: "Manage Legacy fence", exact: true })
      .click()
    await page
      .getByRole("menuitem", { name: "Recovery details", exact: true })
      .click()
    const first = page.getByRole("dialog", {
      name: "Recovery for Legacy fence",
      exact: true,
    })
    await expect(
      first.getByText("Checking recovery method", { exact: true })
    ).toBeVisible()
    await first.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(first).toHaveCount(0)

    await setRecoveryReadMode(page, "pass")
    await page
      .getByRole("button", { name: "Manage Other legacy", exact: true })
      .click()
    await page
      .getByRole("menuitem", { name: "Recovery details", exact: true })
      .click()
    const second = page.getByRole("dialog", {
      name: "Recovery for Other legacy",
      exact: true,
    })
    await expect(second.getByLabel("Wallet password")).toBeVisible()
    await releaseRecoveryReads(page)
    await expect(second.getByLabel("Wallet password")).toBeVisible()
    await expect(second.getByRole("alert")).toHaveCount(0)
    await second.getByRole("button", { name: "Cancel", exact: true }).click()

    await page
      .getByRole("button", { name: "Manage Legacy fence", exact: true })
      .click()
    await page
      .getByRole("menuitem", { name: "Recovery details", exact: true })
      .click()
    await expect(first.getByLabel("Wallet password")).toBeVisible()
    expect((await controlledProbe(page)).opens).toBe(0)
  } finally {
    await restoreRecoveryRead(page)
  }
})

test("recovery lookup retires an open recovery dialog when signer authority changes @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page, undefined, undefined, true)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await settled(page)
    await seedLegacyPasswordWallet(page)
    await waitForPasswordRecovery(page)
    await controlRecoveryRead(page, "hold")
    await page
      .getByRole("button", { name: "Manage Legacy fence", exact: true })
      .click()
    await page
      .getByRole("menuitem", { name: "Recovery details", exact: true })
      .click()
    await expect(
      page
        .getByRole("dialog")
        .getByText("Checking recovery method", { exact: true })
    ).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const probe = Reflect.get(
            window,
            "__recoveryRead"
          ) as RecoveryReadProbe
          return probe.release.length
        })
      )
      .toBeGreaterThan(0)

    // Hold the old dialog observation, not unrelated reads during logout.
    await setRecoveryReadMode(page, "pass")
    await page.evaluate(async () => {
      const auth = Reflect.get(
        window,
        "__controlledWalletAuth"
      ) as ControlledWalletAuth
      await auth.disconnect()
    })
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await releaseRecoveryReads(page)
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page
      .getByRole("button", { name: "Manage Legacy fence", exact: true })
      .click()
    await page
      .getByRole("menuitem", { name: "Recovery details", exact: true })
      .click()
    await expect(
      page.getByRole("dialog").getByLabel("Wallet password")
    ).toBeVisible()
    expect((await controlledProbe(page)).opens).toBe(0)
  } finally {
    try {
      await restoreRecoveryRead(page)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  }
})

test("recovery lookup does not show an old preflight failure after reconnecting the same identity @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  try {
    await prepareControlledWallet(page)
    await observeWalletController(page, undefined, undefined, true)
    await installRealTestSigner(page, identity, relay)
    await page.goto(apps.market + "/wallet")
    await installControlledWallet(page)
    await settled(page)
    await seedLegacyPasswordWallet(page)
    await waitForPasswordRecovery(page)
    await page.clock.install()
    await controlRecoveryRead(page, "hold")
    await page.getByRole("button", { name: "Open wallet", exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const probe = Reflect.get(
            window,
            "__recoveryRead"
          ) as RecoveryReadProbe
          return probe.release.length
        })
      )
      .toBeGreaterThan(0)
    await setRecoveryReadMode(page, "pass")
    const generation = await page.evaluate(() => {
      const auth = Reflect.get(
        window,
        "__controlledWalletAuth"
      ) as ControlledWalletAuth
      return auth.authGeneration
    })
    await page.evaluate(async () => {
      const auth = Reflect.get(
        window,
        "__controlledWalletAuth"
      ) as ControlledWalletAuth
      await auth.disconnect()
    })
    await page.evaluate(async () => {
      const auth = Reflect.get(
        window,
        "__controlledWalletAuth"
      ) as ControlledWalletAuth
      await auth.connect({ method: "nip07" })
    })
    await expect
      .poll(() =>
        page.evaluate(
          ({ generation, owner }) => {
            const auth = Reflect.get(
              window,
              "__controlledWalletAuth"
            ) as ControlledWalletAuth
            return (
              auth.signerReadiness === "ready" &&
              auth.authGeneration !== generation &&
              auth.accountPubkey === owner
            )
          },
          { generation, owner: identity.pubkey }
        )
      )
      .toBe(true)
    await page.clock.fastForward(5_001)
    const card = page.getByRole("article", {
      name: "Legacy fence wallet",
      exact: true,
    })
    await expect(
      card.getByRole("button", { name: "Open wallet", exact: true })
    ).toBeEnabled()
    await expect(card.getByRole("alert")).toHaveCount(0)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect((await controlledProbe(page)).opens).toBe(0)
  } finally {
    try {
      await restoreRecoveryRead(page)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  }
})

for (const app of ["market", "merchant"] as const) {
  test(`${app} recovery lookup does not time out an authorized signer-backed provider open @${app}`, async ({
    page,
  }) => {
    const identity = createRuntimeSignerIdentity()
    try {
      await prepareControlledWallet(page)
      await observeWalletController(page, undefined, undefined, true)
      await installRealTestSigner(page, identity, relay)
      await page.goto(apps[app] + "/wallet")
      await installControlledWallet(page)
      await settled(page)
      await seedBackup(page)
      await page.evaluate(async () => {
        const wallets = Reflect.get(
          window,
          "__controlledWalletController"
        ) as ControlledWalletController
        await wallets.retryRecovery()
      })
      await expect(
        page.getByRole("button", { name: "Receive", exact: true })
      ).toBeVisible()
      const opens = await page.evaluate(async () => {
        const wallets = Reflect.get(
          window,
          "__controlledWalletController"
        ) as ControlledWalletController
        const wallet = wallets.portableWallets[0]
        if (!wallet) throw new Error("Expected a Portable Wallet.")
        await wallets.lockSpark(wallet.id)
        const probe = Reflect.get(
          window,
          "__walletProbe"
        ) as ControlledWalletProbe
        // Delay provider work beyond the metadata-only deadline, once.
        probe.openBarrier = () => {
          delete probe.openBarrier
          return new Promise<void>((resolve) =>
            setTimeout(() => {
              probe.slowOpenCompleted = true
              resolve()
            }, 6_000)
          )
        }
        return probe.opens
      })
      await page
        .getByRole("button", { name: "Open wallet", exact: true })
        .click()
      await expect(
        page.getByRole("button", { name: "Receive", exact: true })
      ).toBeVisible({ timeout: 10_000 })
      const provider = await controlledProbe(page)
      expect(provider.opens).toBe(opens + 1)
      expect(provider.slowOpenCompleted).toBe(true)
      await expect(page.getByRole("dialog", { name: /^Unlock / })).toHaveCount(
        0
      )
      await expect(page.getByLabel("Wallet password")).toHaveCount(0)
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

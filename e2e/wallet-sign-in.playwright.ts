import { openWalletSetup } from "./helpers/wallet-fixture"
import { recordSmokeDiagnostic } from "./helpers/smoke-diagnostics"
import {
  prepareControlledWallet,
  installControlledWallet,
  saveWalletRecovery as saveRecovery,
} from "./helpers/wallet-fixture"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  replaceRealTestSigner,
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

test("creation retry retains its encrypted wallet identity after provider opening fails @market", async ({
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
    await page.goto(`${market}/wallet`)
    await installControlledWallet(page)
    await page.evaluate(() => {
      ;(window as any).__walletProbe.failOpen = true
    })
    await openWalletSetup(page, "Create wallet")
    await expect(
      page.getByRole("button", { name: "Retry creation", exact: true })
    ).toBeVisible()
    const original = await page.evaluate(async (moduleUrl) => {
      const { db } = await import(moduleUrl)
      const rows = (await db.walletCredentials.toArray()).filter(
        (row: any) => row.providerId === "spark"
      )
      return {
        count: rows.length,
        credential: rows[0]?.credential,
        id: rows[0]?.walletId,
      }
    }, core)
    expect(original.count).toBe(1)
    await page.evaluate(() => {
      ;(window as any).__walletProbe.failOpen = false
    })
    await page
      .getByRole("button", { name: "Retry creation", exact: true })
      .click()
    await saveRecovery(page)
    expect(
      await page.evaluate(
        async ({ moduleUrl, original }) => {
          const { db } = await import(moduleUrl)
          const rows = (await db.walletCredentials.toArray()).filter(
            (row: any) => row.providerId === "spark"
          )
          return (
            rows.length === 1 &&
            rows[0].walletId === original.id &&
            rows[0].credential === original.credential
          )
        },
        { moduleUrl: core, original }
      )
    ).toBe(true)
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("cached signer wallet stays isolated across two identities and returns unchanged to its owner @market", async ({
  page,
}) => {
  await prepareControlledWallet(page)
  const first = createRuntimeSignerIdentity(),
    second = createRuntimeSignerIdentity()
  await installRealTestSigner(
    page,
    first,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  )
  try {
    await page.goto(`${market}/wallet`)
    await installControlledWallet(page)
    await openWalletSetup(page, "Create wallet")
    await saveRecovery(page)
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toBeVisible()
    const original = await page.evaluate(async (moduleUrl) => {
      const { db } = await import(moduleUrl)
      return JSON.stringify(
        (await db.walletCredentials.toArray()).filter(
          (row: any) => row.providerId === "spark"
        )
      )
    }, core)
    const disconnect = async () => {
      await page.getByLabel("Open account menu").click()
      await page
        .getByRole("menuitem", { name: "Disconnect", exact: true })
        .click()
      await expect(page.getByLabel("Open account menu")).toHaveCount(0)
    }
    const connect = async () => {
      await page
        .getByRole("button", { name: /^Connect$/ })
        .first()
        .click()
      await page
        .getByRole("button", { name: /Connect Extension \(NIP-07\)/i })
        .click()
      await expect(page.getByLabel("Open account menu")).toBeVisible()
    }
    await disconnect()
    await replaceRealTestSigner(page, second)
    await connect()
    await expect(
      page.getByRole("heading", { name: "My wallets", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toHaveCount(0)
    const isolated = await page.evaluate(
      async ({ moduleUrl, first, second, original }) => {
        const { db, getAccountSigner } = await import(moduleUrl)
        const { getMarketWalletStore } = await import(
          "/@fs" +
            moduleUrl.slice(4).replace("index.ts", "wallets/wallet-storage.ts")
        )
        const { getSparkWalletManager } = await import(
          "/@fs" +
            moduleUrl.slice(4).replace("index.ts", "wallets/spark-sdk.ts")
        )
        const rows = (await db.walletCredentials.toArray()).filter(
          (row: any) => row.providerId === "spark"
        )
        const mine = await getMarketWalletStore().listVisible(second)
        const theirs = await getMarketWalletStore().listVisible(first)
        return {
          correctAccount: getAccountSigner().pubkey === second,
          mine: mine.length,
          theirs: theirs.length,
          unchanged: JSON.stringify(rows) === original,
          foreignSessionClosed: theirs.every(
            (wallet: any) => !getSparkWalletManager().isOpen(wallet.id)
          ),
        }
      },
      { moduleUrl: core, first: first.pubkey, second: second.pubkey, original }
    )
    expect(isolated).toEqual({
      correctAccount: true,
      mine: 0,
      theirs: 1,
      unchanged: true,
      foreignSessionClosed: true,
    })
    await disconnect()
    await replaceRealTestSigner(page, first)
    await connect()
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toBeVisible()
    await page.reload()
    await installControlledWallet(page, false, "wallet1@breez.tips")
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toBeVisible()
    expect(
      await page.evaluate(
        async ({ moduleUrl, original }) => {
          const { db } = await import(moduleUrl)
          return (
            JSON.stringify(
              (await db.walletCredentials.toArray()).filter(
                (row: any) => row.providerId === "spark"
              )
            ) === original
          )
        },
        { moduleUrl: core, original }
      )
    ).toBe(true)
  } finally {
    disposeRuntimeSignerIdentity(first)
    disposeRuntimeSignerIdentity(second)
  }
})

for (const size of [
  { name: "desktop", width: 1280, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`${size.name} custom-name form distinguishes uncertain submission, receipt and manual approval @market`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    const identity = createRuntimeSignerIdentity()
    try {
      await page.goto(`${market}/wallet`)
      await page.evaluate(
        async ({ url, owner }) => {
          const reactModule = "/@id/react",
            domModule = "/@id/react-dom/client"
          const React = (await import(reactModule)).default
          const ReactDOM = (await import(domModule)).default
          const { AddressNameRequestForm } = await import(url)
          const host = document.createElement("div")
          host.id = "address-request-ui-test"
          document.body.replaceChildren(host)
          Object.assign(window, {
            turnstile: {
              render(_node: HTMLElement, options: any) {
                queueMicrotask(() => options.callback("controlled-challenge"))
                return "controlled"
              },
              remove() {},
            },
          })
          const requests: string[] = []
          let approvals = 0
          Object.assign(window, {
            __addressRequestUi: {
              requests,
              get approvals() {
                return approvals
              },
            },
          })
          ReactDOM.createRoot(host).render(
            React.createElement(AddressNameRequestForm, {
              walletId: "controlled-wallet",
              ownerPubkey: owner,
              siteKey: "controlled-public-site-key",
              async submit(
                _id: string,
                value: { requestId: string; check?: boolean }
              ) {
                requests.push(value.requestId)
                return ["pending", "not_received", "received", "approved"][
                  requests.length - 1
                ]
              },
              async activate(name: string) {
                approvals++
                return {
                  status: "registered",
                  username: name,
                  address: `${name}@conduit.cash`,
                }
              },
            })
          )
        },
        {
          url:
            "/@fs" +
            path.resolve(
              "packages/ui/src/components/AddressNameRequestForm.tsx"
            ),
          owner: identity.pubkey,
        }
      )
      await page.getByLabel("Desired name", { exact: true }).fill("Review-Name")
      await page
        .getByLabel("Note for the review team (optional)", { exact: true })
        .fill("Controlled optional note")
      await expect(
        page.getByLabel("Connected public identity", { exact: true })
      ).toHaveAttribute("readonly", "")
      await page
        .getByRole("button", { name: "Submit name request", exact: true })
        .click()
      await expect(page.getByRole("status")).toContainText(
        "Submission is not confirmed"
      )
      await expect(
        page.getByRole("button", {
          name: "Activate approved address",
          exact: true,
        })
      ).toHaveCount(0)
      await page
        .getByRole("button", { name: "Check request status", exact: true })
        .click()
      await expect(page.getByRole("status")).toContainText(
        "No submission was found"
      )
      await page
        .getByRole("button", { name: "Submit name request", exact: true })
        .click()
      await expect(page.getByRole("status")).toContainText("Request received")
      await expect(page.getByRole("status")).toContainText(
        "Submission is not approval"
      )
      await expect(
        page.getByRole("button", {
          name: "Activate approved address",
          exact: true,
        })
      ).toHaveCount(0)
      await page
        .getByRole("button", { name: "Check request status", exact: true })
        .click()
      await expect(page.getByRole("status")).toContainText(
        "Name approved for this wallet"
      )
      await page
        .getByRole("button", { name: "Activate approved address", exact: true })
        .click()
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Your approved address is ready" })
      ).toBeVisible()
      expect(
        await page.evaluate(() => {
          const ui = (window as any).__addressRequestUi
          return {
            sameRequest: new Set(ui.requests).size === 1,
            activations: ui.approvals,
            fits: document.documentElement.scrollWidth <= innerWidth,
          }
        })
      ).toEqual({ sameRequest: true, activations: 1, fits: true })
      await page.screenshot({
        path: `/private/tmp/wallet-name-form-${size.name}.png`,
        mask: [
          page.getByLabel("Connected public identity"),
          page.getByLabel("Note for the review team (optional)"),
        ],
      })
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
  test(`${size.name} creation shows activity and an accurate pending stage without a false signer approval prompt @market`, async ({
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
      await page.goto(`${market}/wallet`)
      await installControlledWallet(page)
      await page.evaluate(() => {
        ;(window as any).__walletSetupBarrier = () =>
          new Promise<void>((resolve) => {
            ;(window as any).__releaseWalletSetup = resolve
          })
      })
      await openWalletSetup(page, "Create wallet")
      const dialog = page.getByRole("dialog")
      await expect(
        dialog.getByRole("heading", {
          name: "Creating your wallet",
          exact: true,
        })
      ).toBeVisible()
      await expect(
        dialog.getByRole("status").filter({ hasText: "Opening your wallet…" })
      ).toBeVisible()
      await expect(dialog.locator("svg.animate-spin")).toBeVisible()
      await expect(
        dialog.getByText(/Confirm the encryption request|waiting for approval/)
      ).toHaveCount(0)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true)
      await page.screenshot({
        path: `/private/tmp/wallet-creation-${size.name}.png`,
        mask: [page.getByLabel("Open account menu")],
      })
      await page.evaluate(() => {
        ;(window as any).__releaseWalletSetup()
        delete (window as any).__walletSetupBarrier
      })
      await saveRecovery(page)
      await expect(
        page.getByRole("button", { name: "Copy address", exact: true })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "Share address", exact: true })
      ).toBeVisible()
      await expect(
        page.getByRole("button", { name: "History", exact: true })
      ).toBeVisible()
      expect(
        await page.evaluate(() => ({
          opens: (window as any).__walletProbe.opens,
          registrations: (window as any).__walletProbe.registrations,
        }))
      ).toEqual({ opens: 1, registrations: 1 })
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
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
      await page
        .getByText("External wallet management", { exact: true })
        .click()
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
      await openWalletSetup(page, "Create wallet")
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
        page.getByText("Receiving address: wallet1@breez.tips", {
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
      await openWalletSetup(page, "Import wallet")
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
      await openWalletSetup(page, "Import wallet")
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
    await openWalletSetup(page, "Create wallet")
    await saveRecovery(page)
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Retry receiving address" })
    ).toBeVisible()
    expect(await publicAddress(page)).toBe("")
    // No automatic profile change is authorized by an additional wallet.
    await page.evaluate(() => {
      ;(window as any).__walletProbe.failRegistration = false
    })
    await page.getByRole("button", { name: "Retry receiving address" }).click()
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
    await openWalletSetup(page, "Create wallet")
    await expect(
      page.getByRole("heading", { name: "Save your recovery details" })
    ).toBeVisible()
    expect(await publicAddress(page)).toBe("")
    await saveRecovery(page)
    await expect.poll(() => publicAddress(page)).toBe("wallet1@breez.tips")
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

for (const failure of ["none", "sdk-open", "post-open"] as const) {
  test(`legacy migration after ${failure} retires its old encrypted copy after verification and fresh sign-in reopens with the signer @market`, async ({
    page,
  }) => {
    const started = performance.now()
    let passwordPresent = false
    let showEnabled = false
    const phase = (value: string) =>
      recordSmokeDiagnostic(test.info(), "wallet-migration", {
        passwordPresent,
        showEnabled,
        scenario: failure,
        phase: value,
        elapsedSeconds: (performance.now() - started) / 1000,
      })
    phase("seed")
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
      await page.evaluate(
        async ({ moduleUrl, failure }) => {
          const { getMarketWalletStore } = await import(moduleUrl)
          const store = getMarketWalletStore()
          const probe = (window as any).__walletProbe
          probe.legacyWalletId = (await store.listVisible(null))[0].id
          probe.legacyCredential = await store.getSparkRecovery(
            probe.legacyWalletId
          )
          probe.migrationWrites = 0
          const put = store.putSparkRecovery.bind(store)
          store.putSparkRecovery = async (
            id: string,
            recovery: { type: string }
          ) => {
            if (id === probe.legacyWalletId && recovery.type === "signer")
              probe.migrationWrites++
            return put(id, recovery)
          }
          probe.failOpen = failure === "sdk-open"
          probe.failBalance = failure === "post-open"
        },
        {
          moduleUrl:
            "/@fs" +
            path.resolve("packages/core/src/wallets/wallet-storage.ts"),
          failure,
        }
      )
      phase("open_dialog")
      await enterWallets(page)
      await page
        .getByRole("button", { name: "Open wallet", exact: true })
        .click()
      await expect(
        page.getByLabel("Wallet password", { exact: true })
      ).toBeVisible()
      phase("password")
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
      phase("migrate")
      await page
        .getByRole("button", { name: "Open and use Nostr sign-in" })
        .click()
      if (failure !== "none") {
        phase("failed_open")
        await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
          failure === "sdk-open"
            ? "Injected SDK open failure"
            : "Injected post-open failure"
        )
        const retained = await page.evaluate(
          async ({ storage, recovery }) => {
            const { getMarketWalletStore } = await import(storage)
            const { recoverStoredSparkMnemonic } = await import(recovery)
            const store = getMarketWalletStore()
            const probe = (window as any).__walletProbe
            const stored = await store.getSparkRecovery(probe.legacyWalletId)
            const recovered = await recoverStoredSparkMnemonic(
              stored,
              probe.legacyCredential,
              probe.legacyPassword
            )
            return {
              unchanged:
                JSON.stringify(stored) ===
                JSON.stringify(probe.legacyCredential),
              signedOutVisible: (await store.listVisible(null)).some(
                (wallet: { id: string }) => wallet.id === probe.legacyWalletId
              ),
              passwordOpens: recovered.mnemonic === probe.importMnemonic,
              migrationWrites: probe.migrationWrites,
            }
          },
          {
            storage:
              "/@fs" +
              path.resolve("packages/core/src/wallets/wallet-storage.ts"),
            recovery:
              "/@fs" +
              path.resolve(
                "packages/core/src/wallets/signer-spark-recovery.ts"
              ),
          }
        )
        expect(retained).toEqual({
          unchanged: true,
          signedOutVisible: true,
          passwordOpens: true,
          migrationWrites: 0,
        })
        await page.evaluate(() => {
          const probe = (window as any).__walletProbe
          probe.failOpen = false
          probe.failBalance = false
        })
        phase("retry")
        await page
          .getByRole("button", { name: "Open and use Nostr sign-in" })
          .click()
      }
      phase("credential")
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await expect(page.getByText("Ready", { exact: true })).toBeVisible()
      expect(
        await page.evaluate(() => (window as any).__walletProbe.migrationWrites)
      ).toBe(1)
      expect(
        await page.evaluate(async (moduleUrl) => {
          const { db } = await import(moduleUrl)
          const payload = JSON.parse(
            (await db.walletCredentials.toArray())[0].credential
          )
          return {
            signer: payload.type === "signer",
            legacy: Object.hasOwn(payload, "legacyRecovery"),
            plaintextAbsent: !JSON.stringify(payload).includes(
              (window as any).__walletProbe.savedMnemonic
            ),
            account: payload.accountNumber,
          }
        }, core)
      ).toEqual({
        signer: true,
        legacy: false,
        plaintextAbsent: true,
        account: 7,
      })
      phase("retired_password")
      await page.getByLabel("Manage Legacy wallet").click()
      await expect(
        page.getByRole("menuitem", { name: "Lock", exact: true })
      ).toHaveCount(0)
      await expect(
        page.getByRole("menuitem", {
          name: "Use previous password",
          exact: true,
        })
      ).toHaveCount(0)
      await page.keyboard.press("Escape")
      phase("fresh_signin")
      // A new document gets a fresh account session and the same encrypted local
      // wallet. The fixture controls the network layer before initialization.
      await page.goto(`${market}/products`)
      await expect(page.getByLabel("Open account menu")).toBeVisible()
      await installControlledWallet(page, false, "wallet1@breez.tips")
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
      phase("second_wallet")
      await openWalletSetup(page, "Create wallet")
      await saveRecovery(page, false)
      // Dialog removal precedes its queued focus restoration. Finish that
      // handoff before opening a menu that outside focus would dismiss.
      await expect(
        page.getByRole("button", { name: "Create wallet", exact: true })
      ).toBeFocused()
      phase("legacy_recovery")
      await page.getByLabel("Manage Legacy wallet").click()
      phase("legacy_menu")
      await page
        .getByRole("menuitem", { name: "Recovery details", exact: true })
        .click()
      phase("legacy_dialog")
      let recoveryDialog = page.getByRole("dialog")
      await expect(
        recoveryDialog.getByLabel("Wallet password", { exact: true })
      ).toHaveCount(0)
      await expect(
        recoveryDialog.getByLabel("Use the previous wallet password")
      ).toHaveCount(0)
      passwordPresent = false
      showEnabled = await recoveryDialog
        .getByRole("button", { name: "Show recovery phrase", exact: true })
        .isEnabled()
      phase("legacy_reveal")
      await recoveryDialog
        .getByRole("button", { name: "Show recovery phrase", exact: true })
        .click()
      phase("legacy_close")
      await recoveryDialog
        .getByRole("button", { name: "Done", exact: true })
        .click()
      phase("legacy_focus")
      await expect(page.getByLabel("Manage Legacy wallet")).toBeFocused()
      phase("signer_recovery")
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
      phase("complete")
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

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
    await openWalletSetup(page, "Create wallet")
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

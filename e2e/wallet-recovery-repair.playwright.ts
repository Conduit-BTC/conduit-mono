import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import {
  prepareControlledWallet,
  installControlledWallet,
  openWalletSetup,
  saveWalletRecovery,
  observeWalletController,
  closeDefaultWalletSession,
} from "./helpers/wallet-fixture"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
  replaceRealTestSigner,
} from "./helpers/real-nip07-signer"

const market = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const moduleUrl = (file: string) =>
  "/@fs" + path.resolve(`packages/core/src/${file}`)
const core = moduleUrl("index.ts")
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1"
test.use({ trace: "off", screenshot: "off", video: "off" })

async function begin(page: Page) {
  await prepareControlledWallet(page)
  await observeWalletController(page, undefined, undefined, true)
  const identity = createRuntimeSignerIdentity()
  await installRealTestSigner(
    page,
    identity,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  )
  await page.goto(`${market}/wallet`)
  await installControlledWallet(page)
  await expect(page.getByLabel("Open account menu")).toBeVisible()
  return identity
}
async function importControlledPhrase(page: Page) {
  await openWalletSetup(page, "Import wallet")
  await page
    .getByLabel("Recovery phrase", { exact: true })
    .evaluate((input) => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!
      setter.call(input, Reflect.get(window, "__walletProbe").importMnemonic)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Import wallet", exact: true })
    .click()
  await saveWalletRecovery(page, false)
}

for (const coverage of ["partial", "unavailable"] as const) {
  test(`phrase restore works with ${coverage} relay reads and retained uncertainty without replacing account choices @market`, async ({
    page,
  }) => {
    const identity = await begin(page)
    try {
      await page.evaluate(
        async ({ core, recovery, storage, coverage }) => {
          const { getAccountSigner } = await import(core)
          const { getAccountSparkRecovery } = await import(recovery)
          const { DexieSparkRecoveryStore } = await import(storage)
          await new DexieSparkRecoveryStore().retain(
            getAccountSigner().pubkey,
            [],
            true
          )
          const service = getAccountSparkRecovery(getAccountSigner())
          const transport = Reflect.get(service, "input").transport
          const read = transport.read.bind(transport)
          transport.read = async (...args: unknown[]) => {
            const result = await read(...args)
            return { ...result, status: coverage }
          }
          await Reflect.get(
            window,
            "__controlledWalletController"
          ).retryRecovery()
        },
        {
          core,
          recovery: moduleUrl("wallets/account-spark-recovery.ts"),
          storage: moduleUrl("wallets/spark-recovery-store.ts"),
          coverage,
        }
      )
      await page
        .getByRole("button", {
          name: "Repair saved recovery state",
          exact: true,
        })
        .click()
      await expect(
        page.getByRole("alert").filter({ hasText: "A verified wallet backup" })
      ).toBeVisible()
      await importControlledPhrase(page)
      await expect(
        page.getByRole("button", { name: "Receive", exact: true })
      ).toBeVisible()
      await expect(
        page.getByLabel("Wallet password", { exact: true })
      ).toHaveCount(0)
      await importControlledPhrase(page)
      const result = await page.evaluate(
        async ({ core, storage }) => {
          const { db, getAccountSigner } = await import(core)
          const { DexieSparkRecoveryStore } = await import(storage)
          const rows = (await db.walletCredentials.toArray()).filter(
            (row: any) => row.providerId === "spark"
          )
          const journal = await new DexieSparkRecoveryStore().load(
            getAccountSigner().pubkey
          )
          return {
            wallets: rows.length,
            signerOnly: rows.every(
              (row: any) =>
                JSON.parse(row.credential).type === "signer" &&
                !JSON.parse(row.credential).legacyRecovery
            ),
            plaintextAbsent: !JSON.stringify(rows).includes(
              Reflect.get(window, "__walletProbe").importMnemonic
            ),
            noAccountChoices: journal.records.every((record: any) =>
              record.event.tags.every(
                (tag: string[]) =>
                  tag[0] !== "d" ||
                  !/^conduit:spark:(primary|main|registry):/.test(tag[1])
              )
            ),
            uncertaintyPreserved: journal.unresolvedObserved,
          }
        },
        { core, storage: moduleUrl("wallets/spark-recovery-store.ts") }
      )
      expect(result).toEqual({
        wallets: 1,
        signerOnly: true,
        plaintextAbsent: true,
        noAccountChoices: true,
        uncertaintyPreserved: true,
      })
    } finally {
      disposeRuntimeSignerIdentity(identity)
    }
  })
}

test("explicit recovery repair keeps wallets and signed evidence while clearing only the old warning @market", async ({
  page,
}) => {
  const identity = await begin(page)
  try {
    await openWalletSetup(page, "Create wallet")
    await saveWalletRecovery(page)
    await page.evaluate(
      async ({ core, storage }) => {
        const { db, getAccountSigner } = await import(core)
        const { DexieSparkRecoveryStore } = await import(storage)
        const journal = new DexieSparkRecoveryStore()
        await journal.retain(getAccountSigner().pubkey, [], true)
        Reflect.set(window, "__repairBefore", {
          credentials: JSON.stringify(await db.walletCredentials.toArray()),
          records: JSON.stringify(
            (await journal.load(getAccountSigner().pubkey)).records
          ),
        })
        await Reflect.get(
          window,
          "__controlledWalletController"
        ).retryRecovery()
      },
      { core, storage: moduleUrl("wallets/spark-recovery-store.ts") }
    )
    await page
      .getByRole("button", { name: "Repair saved recovery state", exact: true })
      .click()
    await expect(
      page.getByRole("button", {
        name: "Repair saved recovery state",
        exact: true,
      })
    ).toHaveCount(0)
    await expect
      .poll(async () =>
        page.evaluate(
          async ({ core, storage }) => {
            const { getAccountSigner } = await import(core)
            const { DexieSparkRecoveryStore } = await import(storage)
            return !(
              await new DexieSparkRecoveryStore().load(
                getAccountSigner().pubkey
              )
            ).unresolvedObserved
          },
          { core, storage: moduleUrl("wallets/spark-recovery-store.ts") }
        )
      )
      .toBe(true)
    const result = await page.evaluate(
      async ({ core, storage }) => {
        const { db, getAccountSigner } = await import(core)
        const { DexieSparkRecoveryStore } = await import(storage)
        const saved = await new DexieSparkRecoveryStore().load(
          getAccountSigner().pubkey
        )
        const before = Reflect.get(window, "__repairBefore")
        return {
          cleared: !saved.unresolvedObserved,
          acknowledged: !!saved.legacyUnresolvedRepair,
          credentialsUnchanged:
            before.credentials ===
            JSON.stringify(await db.walletCredentials.toArray()),
          signedBytesUnchanged: JSON.parse(before.records).every(
            (record: any) =>
              saved.records.some(
                (current: any) =>
                  current.event.id === record.event.id &&
                  JSON.stringify(current.event) === JSON.stringify(record.event)
              )
          ),
        }
      },
      { core, storage: moduleUrl("wallets/spark-recovery-store.ts") }
    )
    expect(result).toEqual({
      cleared: true,
      acknowledged: true,
      credentialsUnchanged: true,
      signedBytesUnchanged: true,
    })
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("opening a signer wallet uses the signer directly even when an encrypted password fallback is retained @market", async ({
  page,
}) => {
  const identity = await begin(page)
  const other = createRuntimeSignerIdentity()
  try {
    await openWalletSetup(page, "Create wallet")
    await saveWalletRecovery(page)
    await page.evaluate(
      async ({ core, storage, recovery }) => {
        const { getAccountSigner } = await import(core)
        const { getMarketWalletStore, getSparkRecoveryBinding } = await import(
          storage
        )
        const { encryptSparkMnemonic } = await import(recovery)
        const store = getMarketWalletStore()
        const wallet = (await store.listVisible(getAccountSigner().pubkey))[0]
        const saved = await store.getSparkRecovery(wallet.id)
        const binding = getSparkRecoveryBinding(wallet, saved)
        const legacyRecovery = {
          ...binding,
          type: "password",
          recovery: await encryptSparkMnemonic(
            Reflect.get(window, "__walletProbe").savedMnemonic,
            crypto.randomUUID(),
            binding,
            { iterations: 100000 }
          ),
        }
        await store.putSparkRecovery(wallet.id, { ...saved, legacyRecovery })
      },
      {
        core,
        storage: moduleUrl("wallets/wallet-storage.ts"),
        recovery: moduleUrl("wallets/spark-recovery.ts"),
      }
    )
    await closeDefaultWalletSession(page)
    await page.getByRole("button", { name: "Open wallet", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toBeVisible()
    await expect(page.getByRole("dialog", { name: /^Unlock / })).toHaveCount(0)
    await expect(
      page.getByLabel("Wallet password", { exact: true })
    ).toHaveCount(0)
    const activate = async (control: ReturnType<Page["getByRole"]>) => {
      if (test.info().project.use.hasTouch) await control.tap()
      else await control.click()
    }
    const switchTo = async (next: typeof identity) => {
      await activate(page.getByLabel("Open account menu"))
      await activate(
        page.getByRole("menuitem", { name: "Disconnect", exact: true })
      )
      await expect(page.getByLabel("Open account menu")).toHaveCount(0)
      await replaceRealTestSigner(page, next)
      // The real auth action supplies this wallet test's account precondition.
      // Signer cryptography and session/authority fences are not replaced.
      await page.evaluate(async () => {
        await Reflect.get(window, "__controlledWalletAuth").connect({
          method: "nip07",
        })
      })
      await expect(page.getByLabel("Open account menu")).toBeVisible()
    }
    await switchTo(other)
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toHaveCount(0)
    await switchTo(identity)
    await expect(
      page.getByRole("button", { name: "Receive", exact: true })
    ).toBeVisible()
    await expect(
      page.getByLabel("Wallet password", { exact: true })
    ).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: /^Unlock / })).toHaveCount(0)
  } finally {
    disposeRuntimeSignerIdentity(identity)
    disposeRuntimeSignerIdentity(other)
  }
})

test("explicit creation resumes one identity after native failure and reload under unavailable discovery @market", async ({
  page,
}) => {
  const identity = await begin(page)
  try {
    const degrade = async (failOpen: boolean) =>
      page.evaluate(
        async ({ core, recovery, failOpen }) => {
          const signer = (await import(core)).getAccountSigner()
          const service = (await import(recovery)).getAccountSparkRecovery(
            signer
          )
          Reflect.get(service, "input").transport.read = async () => ({
            status: "unavailable",
            events: [],
          })
          Reflect.get(service, "input").transport.publish = async () =>
            "timed_out"
          Reflect.get(window, "__walletProbe").failOpen = failOpen
        },
        {
          core,
          recovery: moduleUrl("wallets/account-spark-recovery.ts"),
          failOpen,
        }
      )
    await degrade(true)
    await openWalletSetup(page, "Create wallet")
    await expect(
      page.getByRole("status").filter({ hasText: "Injected SDK open failure" })
    ).toBeVisible()
    const snapshot = async () =>
      page.evaluate(
        async ({ core, storage }) => {
          const { db, getAccountSigner } = await import(core)
          const { getMarketWalletStore } = await import(storage)
          const wallets = await getMarketWalletStore().listVisible(
            getAccountSigner().pubkey
          )
          const credentials = await db.walletCredentials.toArray()
          // Only aggregate evidence and a random registration id leave the browser.
          return {
            count: wallets.length,
            id: wallets[0]?.id,
            encrypted: credentials.every((row: any) => {
              const value = JSON.parse(row.credential)
              return (
                value.type === "signer" && !!value.ciphertext && !value.mnemonic
              )
            }),
            pending: credentials.filter(
              (row: any) => JSON.parse(row.credential).creationPending
            ).length,
            defaults: wallets.flatMap((wallet: any) =>
              wallet.defaultIntents.map((intent: string) => ({
                id: wallet.id,
                intent,
              }))
            ),
          }
        },
        { core, storage: moduleUrl("wallets/wallet-storage.ts") }
      )
    const first = await snapshot()
    expect(first).toMatchObject({
      count: 1,
      encrypted: true,
      pending: 1,
      defaults: [],
    })
    await page.reload()
    await installControlledWallet(page)
    await expect(page.getByLabel("Open account menu")).toBeVisible()
    await degrade(false)
    await openWalletSetup(page, "Create wallet")
    await saveWalletRecovery(page, false)
    expect(await snapshot()).toEqual({ ...first, pending: 0 })
    await page.evaluate(async (walletId) => {
      await Reflect.get(
        window,
        "__controlledWalletController"
      ).setDefaultPaymentWallet(walletId)
    }, first.id)
    const selected = [{ id: first.id, intent: "pay_invoice" }]
    expect((await snapshot()).defaults).toEqual(selected)
    // Interrupt optional backup after the second identity is usable and retained.
    await page.evaluate(
      async ({ core, recovery }) => {
        const service = (await import(recovery)).getAccountSparkRecovery(
          (await import(core)).getAccountSigner()
        )
        Reflect.get(service, "input").transport.publish = () =>
          new Promise(() => {})
      },
      { core, recovery: moduleUrl("wallets/account-spark-recovery.ts") }
    )
    await openWalletSetup(page, "Create wallet")
    await expect(
      page.getByRole("heading", {
        name: "Save your recovery details",
        exact: true,
      })
    ).toBeVisible()
    expect(await snapshot()).toMatchObject({
      count: 2,
      pending: 1,
      encrypted: true,
      defaults: selected,
    })
    await page.reload()
    await installControlledWallet(page)
    await expect(page.getByLabel("Open account menu")).toBeVisible()
    await degrade(false)
    await openWalletSetup(page, "Create wallet")
    await saveWalletRecovery(page, false)
    expect(await snapshot()).toMatchObject({
      count: 2,
      encrypted: true,
      pending: 0,
      defaults: selected,
    })
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

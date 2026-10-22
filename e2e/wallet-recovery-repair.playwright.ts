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

async function begin(page: Page, options: { beforeDecrypt?: () => void } = {}) {
  await prepareControlledWallet(page)
  await observeWalletController(page, undefined, undefined, true)
  const identity = createRuntimeSignerIdentity()
  await installRealTestSigner(
    page,
    identity,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`,
    options
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
          const { getAccountSparkRecovery, runAccountWalletSetup } =
            await import(recovery)
          const service = getAccountSparkRecovery(signer)
          Reflect.get(service, "input").transport.read = async () => ({
            status: "unavailable",
            events: [],
          })
          Reflect.get(service, "input").transport.publish = async () =>
            "timed_out"
          Reflect.get(window, "__walletProbe").failOpen = failOpen
          // Reload can already be restoring the wallet with the original transport.
          // Drain that setup before exercising the controlled unavailable-read path.
          await runAccountWalletSetup(signer, async () => {})
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

test("pending creation verifies retained backup after signer denial without resuming background work @market", async ({
  page,
}) => {
  let denyDecrypt = false
  const identity = await begin(page, {
    beforeDecrypt: () => {
      if (denyDecrypt) throw new Error("Signer permission denied")
    },
  })
  try {
    const original = await page.evaluate(async (root) => {
      const signer = (await import(`${root}/index.ts`)).getAccountSigner()
      const {
        getAccountSparkRecovery,
        runAccountWalletSetup,
        pendingSparkCreation,
      } = await import(`${root}/wallets/account-spark-recovery.ts`)
      const { getMarketWalletStore } = await import(
        `${root}/wallets/wallet-storage.ts`
      )
      const { DexieSparkRecoveryStore } = await import(
        `${root}/wallets/spark-recovery-store.ts`
      )
      const { recoverStoredSparkMnemonic } = await import(
        `${root}/wallets/signer-spark-recovery.ts`
      )
      const service = getAccountSparkRecovery(signer)
      Reflect.get(service, "input").transport.read = async () => ({
        status: "unavailable",
        events: [],
      })
      Reflect.get(service, "input").transport.publish = async () => "timed_out"
      await runAccountWalletSetup(signer, async () => {})
      const controller = Reflect.get(window, "__controlledWalletController")
      Reflect.get(window, "__walletProbe").failOpen = true
      try {
        await controller.createSpark()
        throw new Error("Expected native initialization failure")
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("Injected SDK open failure")
        )
          throw error
      }
      const attempt = await pendingSparkCreation({
        signer,
        network: "mainnet",
        store: getMarketWalletStore(),
        journal: new DexieSparkRecoveryStore(),
      })
      if (!attempt) throw new Error("Expected retained creation")
      const { mnemonic } = await recoverStoredSparkMnemonic(
        attempt.recovery,
        attempt.recovery,
        undefined,
        { priority: "foreground" }
      )
      await service.prepare(
        {
          mnemonic,
          network: "mainnet",
          accountNumber: attempt.recovery.accountNumber,
        },
        attempt.wallet.id
      )
      Reflect.get(window, "__walletProbe").failOpen = false
      return { id: attempt.wallet.id, defaults: attempt.wallet.defaultIntents }
    }, moduleUrl(""))
    denyDecrypt = true
    expect(
      await page.evaluate(async (core) => {
        const signer = (await import(core)).getAccountSigner()
        try {
          await signer.decryptNip44(signer.pubkey, "unused", {
            priority: "foreground",
          })
          return "unexpected_success"
        } catch (error) {
          return (error as { code?: string }).code
        }
      }, core)
    ).toBe("authorization_denied")
    denyDecrypt = false
    expect(
      await page.evaluate(async () => {
        const { wallet } = await Reflect.get(
          window,
          "__controlledWalletController"
        ).createSpark()
        return { id: wallet.id, defaults: wallet.defaultIntents }
      })
    ).toEqual(original)
    expect(
      await page.evaluate(async (core) => {
        const { db, getAccountSigner } = await import(core)
        const signer = getAccountSigner()
        let backgroundCode
        try {
          await signer.decryptNip44(signer.pubkey, "unused", {
            priority: "background",
          })
        } catch (error) {
          backgroundCode = (error as { code?: string }).code
        }
        return { count: await db.walletCredentials.count(), backgroundCode }
      }, core)
    ).toEqual({ count: 1, backgroundCode: "background_paused" })
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

test("unresolved registry creation never automatically publishes a public address with Make main disabled @market", async ({
  page,
}) => {
  const identity = await begin(page)
  try {
    const evidence = await page.evaluate(
      async ({ core, recovery, registryModule }) => {
        const signer = (await import(core)).getAccountSigner()
        const { sparkWalletRegistryDTag } = await import(registryModule)
        const service = (await import(recovery)).getAccountSparkRecovery(signer)
        const missingId = crypto.randomUUID()
        const createdAt = Math.floor(Date.now() / 1000)
        const snapshot = {
          format: "conduit.spark.registry",
          version: 1,
          ownerPubkey: signer.pubkey,
          network: "mainnet",
          revision: 1,
          parentEventId: null,
          activeWalletIds: [missingId],
          removedWalletIds: [],
          payInvoiceWalletId: missingId,
          receiveWalletId: missingId,
          createdAt,
        }
        const registry = await signer.signEvent({
          kind: 30078,
          pubkey: signer.pubkey,
          created_at: createdAt,
          tags: [["d", sparkWalletRegistryDTag("mainnet")]],
          content: await signer.encryptNip44(
            signer.pubkey,
            JSON.stringify(snapshot)
          ),
        })
        const events = new Map([[registry.id, registry]])
        const transport = Reflect.get(service, "input").transport
        transport.read = async (
          _url: string,
          owner: string,
          eventId: string | undefined,
          _current: unknown,
          dTag: string | undefined
        ) => ({
          status: "complete",
          events: [...events.values()].filter(
            (event) =>
              event.pubkey === owner &&
              (!eventId || event.id === eventId) &&
              (!dTag ||
                event.tags.some((tag) => tag[0] === "d" && tag[1] === dTag))
          ),
        })
        transport.publish = async (_url: string, event: typeof registry) => {
          events.set(event.id, event)
          return "acked"
        }
        const sign = signer.signEvent.bind(signer)
        Reflect.set(window, "__profileWriteCount", 0)
        signer.signEvent = async (...args: Parameters<typeof sign>) => {
          if (args[0].kind === 0)
            Reflect.set(
              window,
              "__profileWriteCount",
              Reflect.get(window, "__profileWriteCount") + 1
            )
          return sign(...args)
        }
        const discovery = await service.discover(false, "mainnet")
        return {
          state: discovery.state,
          coverage: discovery.coverage,
          activeCount: discovery.registry?.activeWalletIds.length,
        }
      },
      {
        core,
        recovery: moduleUrl("wallets/account-spark-recovery.ts"),
        registryModule: moduleUrl("wallets/spark-wallet-registry.ts"),
      }
    )
    expect(evidence).toEqual({
      state: "unresolved",
      coverage: "complete",
      activeCount: 1,
    })
    await openWalletSetup(page, "Create wallet")
    await saveWalletRecovery(page, false)
    // The explicit suggestion proves setup completed without automatic publication.
    await expect(
      page.getByRole("button", { name: "Use this address", exact: true })
    ).toBeVisible()
    expect(
      await page.evaluate(() => Reflect.get(window, "__profileWriteCount"))
    ).toBe(0)
    expect(
      await page.evaluate(async (core) => {
        const { db } = await import(core)
        const wallets = await db.wallets.toArray()
        return {
          count: wallets.length,
          defaults: wallets.flatMap((wallet: any) => wallet.defaultIntents),
        }
      }, core)
    ).toEqual({ count: 1, defaults: [] })
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})

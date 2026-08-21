import { fileURLToPath } from "node:url"

import { expect, test, type Page } from "@playwright/test"
import type Dexie from "dexie"
import type { WalletDescriptor } from "@conduit/core"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
const dexieBrowserBundlePath = fileURLToPath(
  new URL("../packages/core/node_modules/dexie/dist/dexie.js", import.meta.url)
)

interface BrowserDexieConstructor {
  new (databaseName: string): Dexie
}

test("market wallet descriptors converge across tabs through Dexie liveQuery @market", async ({
  context,
}) => {
  // This test covers browser-local Dexie behavior only. Keep every socket in
  // process so public relay health cannot affect the liveQuery signal.
  await context.routeWebSocket(/^(?:ws|wss):\/\//, (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return
      let frame: unknown
      try {
        frame = JSON.parse(message)
      } catch {
        return
      }
      if (
        Array.isArray(frame) &&
        frame[0] === "REQ" &&
        typeof frame[1] === "string"
      ) {
        socket.send(JSON.stringify(["EOSE", frame[1]]))
      }
    })
  })

  const firstPage = await context.newPage()
  const secondPage = await context.newPage()
  const runtimeErrors: string[] = []
  for (const [name, page] of [
    ["first", firstPage],
    ["second", secondPage],
  ] as const) {
    page.on("pageerror", (error) =>
      runtimeErrors.push(`${name} pageerror: ${error.message}`)
    )
    page.on("console", (message) => {
      if (message.type() === "error") {
        runtimeErrors.push(`${name} console: ${message.text()}`)
      }
    })
  }
  await secondPage.addInitScript(() => {
    const probeWindow = window as typeof window & {
      __walletStoreReads: number
    }
    probeWindow.__walletStoreReads = 0
    const objectStorePrototype = IDBObjectStore.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >
    for (const method of ["getAll", "openCursor"]) {
      const original = objectStorePrototype[method]
      if (!original) continue
      objectStorePrototype[method] = function (
        this: IDBObjectStore,
        ...args: unknown[]
      ): unknown {
        if (this.name === "wallets") probeWindow.__walletStoreReads += 1
        return Reflect.apply(original, this, args)
      }
    }
  })
  const walletStoreReads = () =>
    secondPage.evaluate(
      () =>
        (
          window as typeof window & {
            __walletStoreReads: number
          }
        ).__walletStoreReads
    )

  await Promise.all([
    firstPage.goto(`${marketUrl}/wallet`),
    secondPage.goto(`${marketUrl}/wallet`),
  ])
  await Promise.all([
    firstPage.getByRole("heading", { name: "Wallets", level: 1 }).waitFor(),
    secondPage.getByRole("heading", { name: "Wallets", level: 1 }).waitFor(),
  ])
  await firstPage.addScriptTag({ path: dexieBrowserBundlePath })

  const wallet: WalletDescriptor = {
    id: `live-query-${Date.now()}`,
    kind: "portable",
    providerId: "future-provider",
    label: "Cross-tab live wallet",
    network: "mainnet",
    capabilities: ["pay_invoice"],
    status: "registered",
    defaultIntents: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  await putWallet(firstPage, wallet)
  await expect(
    secondPage.getByText(wallet.label, { exact: true })
  ).toBeVisible()

  await putWallet(firstPage, {
    ...wallet,
    defaultIntents: ["pay_invoice"],
    updatedAt: wallet.updatedAt + 1,
  })
  const targetHeader = secondPage
    .getByRole("heading", { name: wallet.label, level: 3 })
    .locator("..")
  await expect(targetHeader.getByText("Default", { exact: true })).toBeVisible()
  await secondPage.waitForTimeout(750)
  const beforeAbortReads = await walletStoreReads()

  const abortedLabel = "Aborted cross-tab wallet"
  const abortResult = await firstPage.evaluate(
    async ({ abortedLabel, wallet }) => {
      const Dexie = (
        window as typeof window & { Dexie: BrowserDexieConstructor }
      ).Dexie
      const database = new Dexie("conduit")
      database.version(13).stores({
        wallets: "id",
        walletCredentials: "walletId",
      })
      try {
        await database.open()
        const wallets = database.table<WalletDescriptor, string>("wallets")
        await database.transaction("rw", wallets, async () => {
          await wallets.put({
            ...wallet,
            id: `${wallet.id}-aborted`,
            label: abortedLabel,
          })
          throw new Error("abort wallet mutation")
        })
        return "committed"
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      } finally {
        database.close()
      }
    },
    { abortedLabel, wallet }
  )
  expect(abortResult).toContain("abort wallet mutation")
  await secondPage.waitForTimeout(750)
  expect(await walletStoreReads()).toBe(beforeAbortReads)
  await expect(secondPage.getByText(abortedLabel, { exact: true })).toHaveCount(
    0
  )

  await deleteWallet(firstPage, wallet.id)
  await expect(secondPage.getByText(wallet.label, { exact: true })).toHaveCount(
    0
  )

  const search = secondPage.getByRole("textbox", { name: "Search products" })
  await search.fill("wallet subscription cleanup")
  await search.press("Enter")
  await expect(secondPage).toHaveURL(/\/products/)
  await secondPage.waitForTimeout(100)
  const beforeNavigationMutationReads = await walletStoreReads()
  const afterUnsubscribeLabel = "Wallet after unsubscribe"
  await putWallet(firstPage, {
    ...wallet,
    id: `${wallet.id}-after-unsubscribe`,
    label: afterUnsubscribeLabel,
  })
  await secondPage.waitForTimeout(750)
  expect(await walletStoreReads()).toBe(beforeNavigationMutationReads)
  await expect(
    secondPage.getByText(afterUnsubscribeLabel, { exact: true })
  ).toHaveCount(0)
  expect(runtimeErrors).toEqual([])
})

async function putWallet(page: Page, wallet: WalletDescriptor): Promise<void> {
  await page.evaluate(async (wallet) => {
    const Dexie = (window as typeof window & { Dexie: BrowserDexieConstructor })
      .Dexie
    const database = new Dexie("conduit")
    database.version(13).stores({
      wallets: "id",
      walletCredentials: "walletId",
    })
    try {
      await database.open()
      await database.table<WalletDescriptor, string>("wallets").put(wallet)
    } finally {
      database.close()
    }
  }, wallet)
}

async function deleteWallet(page: Page, walletId: string): Promise<void> {
  await page.evaluate(async (walletId) => {
    const Dexie = (window as typeof window & { Dexie: BrowserDexieConstructor })
      .Dexie
    const database = new Dexie("conduit")
    database.version(13).stores({
      wallets: "id",
      walletCredentials: "walletId",
    })
    try {
      await database.open()
      await database.table<WalletDescriptor, string>("wallets").delete(walletId)
    } finally {
      database.close()
    }
  }, walletId)
}

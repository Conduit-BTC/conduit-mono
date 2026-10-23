import { randomUUID } from "node:crypto"
import path from "node:path"
import { expect, test, type Page } from "@playwright/test"
import type { ConduitDB } from "@conduit/core/db"
import type { createCheckoutRecoveryStorage } from "@conduit/core/protocol/checkout-recovery-storage"
import type { withCheckoutSparkStorageLock } from "../apps/market/src/lib/checkout-spark-storage"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const fixtureUrl = `${marketUrl}/__checkout-recovery-storage-fixture`
const outboxKey = "conduit:checkout-spark-recovery-outbox:v1"
const moduleUrl = (relative: string) =>
  `/@fs/${path.resolve(process.cwd(), relative).replaceAll("\\", "/")}`
const modules = {
  database: moduleUrl("packages/core/src/db/index.ts"),
  storage: moduleUrl("packages/core/src/protocol/checkout-recovery-storage.ts"),
  lock: moduleUrl("apps/market/src/lib/checkout-spark-storage.ts"),
}
type FixtureWindow = typeof window & {
  recoveryStorageFixture?: {
    database: ConduitDB
    storage: ReturnType<typeof createCheckoutRecoveryStorage>
    withLock: typeof withCheckoutSparkStorageLock
    release?: () => void
    work?: Promise<unknown>
  }
}

async function initialize(page: Page, databaseName: string) {
  await page.evaluate(
    async ({ modules, databaseName }) => {
      const [
        { ConduitDB },
        { createCheckoutRecoveryStorage },
        { withCheckoutSparkStorageLock },
      ] = await Promise.all([
        import(modules.database) as Promise<typeof import("@conduit/core/db")>,
        import(modules.storage) as Promise<
          typeof import("@conduit/core/protocol/checkout-recovery-storage")
        >,
        import(modules.lock) as Promise<
          typeof import("../apps/market/src/lib/checkout-spark-storage")
        >,
      ])
      const database = new ConduitDB(databaseName)
      ;(window as FixtureWindow).recoveryStorageFixture = {
        database,
        storage: createCheckoutRecoveryStorage(localStorage, database),
        withLock: withCheckoutSparkStorageLock,
      }
    },
    { modules, databaseName }
  )
}

async function dispose(pages: Page[]) {
  for (const page of pages) {
    await page
      .evaluate(async () => {
        const fixture = (window as FixtureWindow).recoveryStorageFixture
        fixture?.release?.()
        await fixture?.work?.catch(() => {})
        fixture?.database.close()
      })
      .catch(() => {})
  }
  await pages[0]?.evaluate(async () => {
    await (window as FixtureWindow).recoveryStorageFixture?.database.delete()
  })
}

// These blank same-origin pages import only storage modules. No account, wallet,
// payment provider, real encrypted record, or relay is used by this suite.
test.use({ trace: "off", screenshot: "off", video: "off" })
test.beforeEach(async ({ context }) => {
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === marketUrl
      ? route.continue()
      : route.abort()
  )
  await context.route(fixtureUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Synthetic checkout recovery storage</title>",
    })
  )
})

test("recovery storage survives real Web Storage quota, reload, and terminal tombstone @market", async ({
  page,
}) => {
  test.setTimeout(90_000)
  const databaseName = `conduit-recovery-browser-${randomUUID()}`
  await page.goto(fixtureUrl)
  await initialize(page, databaseName)
  try {
    const saved = await page.evaluate(async (outboxKey) => {
      const { storage, withLock } = (window as FixtureWindow)
        .recoveryStorageFixture!
      const original = JSON.stringify({
        synthetic: "legacy",
        padding: "x".repeat(128 * 1024),
      })
      const updated = JSON.stringify({
        synthetic: "current",
        padding: "x".repeat(512 * 1024),
      })
      localStorage.setItem(outboxKey, original)
      let quotaReached = false
      for (let index = 0; index < 256; index++) {
        try {
          localStorage.setItem(
            `synthetic-recovery-filler:${index}`,
            "x".repeat(128 * 1024)
          )
        } catch (error) {
          if (
            !(error instanceof DOMException) ||
            error.name !== "QuotaExceededError"
          )
            throw error
          quotaReached = true
          break
        }
      }
      let directWriteRejected = false
      try {
        localStorage.setItem(outboxKey, updated)
      } catch (error) {
        if (
          !(error instanceof DOMException) ||
          error.name !== "QuotaExceededError"
        )
          throw error
        directWriteRejected = true
      }
      await withLock(outboxKey, () => storage.setItem(outboxKey, updated))
      return {
        quotaReached,
        directWriteRejected,
        exact: (await storage.getItem(outboxKey)) === updated,
        smallMarker: (localStorage.getItem(outboxKey)?.length ?? 0) < 100,
        unrelatedRetained:
          localStorage.getItem("synthetic-recovery-filler:0")?.length ===
          128 * 1024,
      }
    }, outboxKey)
    expect(saved).toEqual({
      quotaReached: true,
      directWriteRejected: true,
      exact: true,
      smallMarker: true,
      unrelatedRetained: true,
    })
    await page.reload()
    await initialize(page, databaseName)
    const reopened = await page.evaluate(async (outboxKey) => {
      const { storage, withLock } = (window as FixtureWindow)
        .recoveryStorageFixture!
      const exact =
        (await storage.getItem(outboxKey)) ===
        JSON.stringify({
          synthetic: "current",
          padding: "x".repeat(512 * 1024),
        })
      await withLock(outboxKey, () => storage.removeItem(outboxKey))
      localStorage.setItem(
        outboxKey,
        JSON.stringify({ synthetic: "legacy", padding: "x".repeat(128 * 1024) })
      )
      return {
        exact,
        noResurrection: (await storage.getItem(outboxKey)) === null,
      }
    }, outboxKey)
    expect(reopened).toEqual({ exact: true, noResurrection: true })
  } finally {
    await dispose([page])
  }
})

test("recovery storage serializes two browser tabs and rejects conflicting old-tab writes @market", async ({
  context,
}) => {
  test.setTimeout(90_000)
  const databaseName = `conduit-recovery-tabs-${randomUUID()}`
  const first = await context.newPage()
  const second = await context.newPage()
  await Promise.all([first.goto(fixtureUrl), second.goto(fixtureUrl)])
  await Promise.all([
    initialize(first, databaseName),
    initialize(second, databaseName),
  ])
  try {
    await first.evaluate(async (outboxKey) => {
      const fixture = (window as FixtureWindow).recoveryStorageFixture!
      localStorage.setItem(outboxKey, JSON.stringify(["synthetic-initial"]))
      let entered!: () => void
      const acquired = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        fixture.release = resolve
      })
      fixture.work = fixture.withLock(outboxKey, async () => {
        const records = JSON.parse(
          (await fixture.storage.getItem(outboxKey))!
        ) as string[]
        entered()
        await gate
        await fixture.storage.setItem(
          outboxKey,
          JSON.stringify([...records, "synthetic-first"])
        )
      })
      await Promise.race([acquired, fixture.work])
    }, outboxKey)
    await second.evaluate((outboxKey) => {
      const fixture = (window as FixtureWindow).recoveryStorageFixture!
      fixture.work = fixture.withLock(outboxKey, async () => {
        const records = JSON.parse(
          (await fixture.storage.getItem(outboxKey))!
        ) as string[]
        await fixture.storage.setItem(
          outboxKey,
          JSON.stringify([...records, "synthetic-second"])
        )
      })
    }, outboxKey)
    await expect
      .poll(() =>
        second.evaluate(async (outboxKey) => {
          const state = await navigator.locks.query()
          return (
            state.pending?.some(
              (lock) =>
                lock.name === `conduit:checkout-spark-storage:${outboxKey}`
            ) ?? false
          )
        }, outboxKey)
      )
      .toBe(true)
    await first.evaluate(async () => {
      const fixture = (window as FixtureWindow).recoveryStorageFixture!
      fixture.release!()
      await fixture.work
    })
    await second.evaluate(async () => {
      await (window as FixtureWindow).recoveryStorageFixture!.work
    })
    await second.reload()
    await initialize(second, databaseName)
    const exact = await second.evaluate(async (outboxKey) => {
      const { storage } = (window as FixtureWindow).recoveryStorageFixture!
      return (
        (await storage.getItem(outboxKey)) ===
        JSON.stringify([
          "synthetic-initial",
          "synthetic-first",
          "synthetic-second",
        ])
      )
    }, outboxKey)
    expect(exact).toBe(true)
    const conflict = await first.evaluate(async (outboxKey) => {
      const { storage } = (window as FixtureWindow).recoveryStorageFixture!
      const marker = localStorage.getItem(outboxKey)!
      localStorage.setItem(outboxKey, "synthetic-old-tab-conflict")
      const rejected = async (operation: () => Promise<unknown>) => {
        try {
          await operation()
          return false
        } catch (error) {
          return error instanceof Error && error.message.includes("older tab")
        }
      }
      const readRejected = await rejected(() => storage.getItem(outboxKey))
      const writeRejected = await rejected(() =>
        storage.setItem(outboxKey, "synthetic-replacement")
      )
      // Restore only this synthetic fixture's marker to inspect retained bytes.
      localStorage.setItem(outboxKey, marker)
      return {
        readRejected,
        writeRejected,
        retained:
          (await storage.getItem(outboxKey)) ===
          JSON.stringify([
            "synthetic-initial",
            "synthetic-first",
            "synthetic-second",
          ]),
      }
    }, outboxKey)
    expect(conflict).toEqual({
      readRejected: true,
      writeRejected: true,
      retained: true,
    })
  } finally {
    await dispose([first, second])
  }
})

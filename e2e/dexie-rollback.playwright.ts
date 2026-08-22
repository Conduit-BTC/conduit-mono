import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`
const dexieBrowserBundlePath = fileURLToPath(
  new URL("../packages/core/node_modules/dexie/dist/dexie.js", import.meta.url)
)

type BrowserDexieTable = {
  get<T>(key: string): Promise<T | undefined>
  put<T>(value: T): Promise<unknown>
}

type BrowserDexieDatabase = {
  close(): void
  open(): Promise<unknown>
  table(name: string): BrowserDexieTable
  tables: Array<{ name: string }>
  transaction<T>(
    mode: "r",
    tableNames: string[],
    scope: () => Promise<T>
  ): Promise<T>
  verno: number
  version(version: number): {
    stores(schema: Record<string, string>): unknown
  }
}

type BrowserDexieConstructor = {
  new (databaseName: string): BrowserDexieDatabase
  delete(databaseName: string): Promise<void>
  semVer: string
}

type InboxEvidenceRecord = {
  pubkey: string
  cachedAt: number
  marker: string
}

type OwnContactListSnapshot = {
  pubkey: string
  event: {
    id: string
    pubkey: string
    created_at: number
    kind: number
    tags: string[][]
    content: string
    sig: string
  }
  sourceRelayUrls: string[]
  state: "pending"
  cachedAt: number
}

function hasSameSerializedValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

test("market Dexie 4 preserves additive v12 data across a declared-v11 rollback @market", async ({
  page,
}) => {
  const dexieMessages: string[] = []
  page.on("console", (message) => {
    if (!["warning", "error"].includes(message.type())) return
    if (/dexie/i.test(message.text())) dexieMessages.push(message.text())
  })

  await page.route(`${marketUrl}/__dexie-rollback-fixture`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Dexie rollback fixture</title>",
    })
  })
  await page.goto(`${marketUrl}/__dexie-rollback-fixture`)
  await page.addScriptTag({ path: dexieBrowserBundlePath })

  const result = await page.evaluate(async () => {
    const Dexie = (window as typeof window & { Dexie: BrowserDexieConstructor })
      .Dexie
    const databaseName = `conduit-dexie-rollback-${crypto.randomUUID()}`
    const ownerPubkey = "b".repeat(64)
    const inboxBefore: InboxEvidenceRecord = {
      pubkey: ownerPubkey,
      cachedAt: 1,
      marker: "written-by-v12",
    }
    const inboxAfter: InboxEvidenceRecord = {
      pubkey: ownerPubkey,
      cachedAt: 2,
      marker: "written-by-v11",
    }
    const contactListSnapshot: OwnContactListSnapshot = {
      pubkey: ownerPubkey,
      event: {
        id: "a".repeat(64),
        pubkey: ownerPubkey,
        created_at: 1_700_000_000,
        kind: 3,
        tags: [["p", "c".repeat(64)]],
        content: "",
        sig: "d".repeat(128),
      },
      sourceRelayUrls: [],
      state: "pending",
      cachedAt: 3,
    }

    const v12 = new Dexie(databaseName)
    const v11Rollback = new Dexie(databaseName)
    const v12Restored = new Dexie(databaseName)

    const declareV12 = (database: BrowserDexieDatabase): void => {
      database.version(11).stores({
        inboxDeclarationEvidence: "pubkey, cachedAt",
      })
      database.version(12).stores({
        ownContactListSnapshots: "pubkey, state, cachedAt",
      })
    }

    try {
      declareV12(v12)
      await v12.open()
      const initialDeclaredVersion = v12.verno
      await v12.table("inboxDeclarationEvidence").put(inboxBefore)
      await v12.table("ownContactListSnapshots").put(contactListSnapshot)
      v12.close()

      v11Rollback.version(11).stores({
        inboxDeclarationEvidence: "pubkey, cachedAt",
      })
      await v11Rollback.open()
      const rollbackDeclaredVersion = v11Rollback.verno
      const v11DeclaredTables = v11Rollback.tables
        .map((table) => table.name)
        .sort()
      const inboxReadByV11 = await v11Rollback
        .table("inboxDeclarationEvidence")
        .get<InboxEvidenceRecord>(inboxBefore.pubkey)
      let installedOnlyTableError: string | null = null
      try {
        v11Rollback.table("ownContactListSnapshots")
      } catch (error) {
        installedOnlyTableError =
          error instanceof Error ? error.name : String(error)
      }
      await v11Rollback.table("inboxDeclarationEvidence").put(inboxAfter)
      v11Rollback.close()

      const nativeState = await new Promise<{
        contactListSnapshot: OwnContactListSnapshot | undefined
        inboxEvidence: InboxEvidenceRecord | undefined
        nativeVersion: number
        stores: string[]
      }>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const stores = Array.from(database.objectStoreNames).sort()
          const transaction = database.transaction(
            ["inboxDeclarationEvidence", "ownContactListSnapshots"],
            "readonly"
          )
          const inboxRequest = transaction
            .objectStore("inboxDeclarationEvidence")
            .get(inboxBefore.pubkey)
          const contactListRequest = transaction
            .objectStore("ownContactListSnapshots")
            .get(contactListSnapshot.pubkey)
          transaction.oncomplete = () => {
            resolve({
              contactListSnapshot: contactListRequest.result as
                OwnContactListSnapshot | undefined,
              inboxEvidence: inboxRequest.result as
                InboxEvidenceRecord | undefined,
              nativeVersion: database.version,
              stores,
            })
            database.close()
          }
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        }
      })

      declareV12(v12Restored)
      await v12Restored.open()
      const restoredDeclaredVersion = v12Restored.verno
      const [contactListReadByV12, inboxReadByV12] =
        await v12Restored.transaction(
          "r",
          ["ownContactListSnapshots", "inboxDeclarationEvidence"],
          () =>
            Promise.all([
              v12Restored
                .table("ownContactListSnapshots")
                .get<OwnContactListSnapshot>(contactListSnapshot.pubkey),
              v12Restored
                .table("inboxDeclarationEvidence")
                .get<InboxEvidenceRecord>(inboxBefore.pubkey),
            ])
        )

      return {
        contactListReadByV12,
        contactListSnapshot,
        dexieVersion: Dexie.semVer,
        inboxAfter,
        inboxBefore,
        inboxReadByV11,
        inboxReadByV12,
        initialDeclaredVersion,
        installedOnlyTableError,
        nativeState,
        restoredDeclaredVersion,
        rollbackDeclaredVersion,
        v11DeclaredTables,
      }
    } finally {
      v12.close()
      v11Rollback.close()
      v12Restored.close()
      await Dexie.delete(databaseName)
    }
  })

  expect(result.dexieVersion).toBe("4.4.4")
  expect(result.initialDeclaredVersion).toBe(12)
  expect(result.rollbackDeclaredVersion).toBe(11)
  expect(result.restoredDeclaredVersion).toBe(12)
  expect(result.v11DeclaredTables).toEqual(["inboxDeclarationEvidence"])
  expect(result.installedOnlyTableError).toBe("InvalidTableError")
  expect(
    hasSameSerializedValue(result.inboxReadByV11, result.inboxBefore)
  ).toBe(true)
  expect(
    hasSameSerializedValue(
      result.nativeState.contactListSnapshot,
      result.contactListSnapshot
    ) &&
      hasSameSerializedValue(
        result.nativeState.inboxEvidence,
        result.inboxAfter
      ) &&
      result.nativeState.nativeVersion === 120 &&
      hasSameSerializedValue(result.nativeState.stores, [
        "inboxDeclarationEvidence",
        "ownContactListSnapshots",
      ])
  ).toBe(true)
  expect(
    hasSameSerializedValue(
      result.contactListReadByV12,
      result.contactListSnapshot
    )
  ).toBe(true)
  expect(hasSameSerializedValue(result.inboxReadByV12, result.inboxAfter)).toBe(
    true
  )
  expect(dexieMessages.length).toBe(0)
})

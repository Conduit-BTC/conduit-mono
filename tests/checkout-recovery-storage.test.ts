import { afterEach, describe, expect, spyOn, test } from "bun:test"
import Dexie from "dexie"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import { createCheckoutRecoveryStorage } from "@conduit/core/protocol/checkout-recovery-storage"

const OUTBOX = "conduit:checkout-spark-recovery-outbox:v1"
const RETRIES = "conduit:checkout-spark-recovery-snapshot-retries:v1"
const ARCHIVE = "conduit:checkout-spark-completed-recovery:v1:synthetic:plan"
const MARKER = '{"checkoutRecoveryStorage":"indexeddb","version":1}'
const databases: ConduitDB[] = []

class LegacyStorage {
  readonly values = new Map<string, string>()
  failWrites = false
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.failWrites)
      throw new DOMException("Quota exceeded", "QuotaExceededError")
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

function fixture() {
  const database = new ConduitDB(
    `checkout-recovery-storage-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  databases.push(database)
  const legacy = new LegacyStorage()
  return {
    database,
    legacy,
    storage: createCheckoutRecoveryStorage(legacy, database),
  }
}

afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})

describe("encrypted checkout recovery storage", () => {
  test("exact outbox reads work during a caller's disjoint retirement transaction", async () => {
    const { database, storage } = fixture()
    await storage.setItem(OUTBOX, "retained exact record")
    await database.transaction(
      "rw",
      database.checkoutSparkPlanBindings,
      async () => {
        expect(await Dexie.waitFor(storage.getItem(OUTBOX))).toBe(
          "retained exact record"
        )
      }
    )
  })
  test("reads unchanged legacy bytes, migrates on write, and survives reopening", async () => {
    const { database, legacy, storage } = fixture()
    legacy.setItem(OUTBOX, "original synthetic encrypted records")
    expect(await storage.getItem(OUTBOX)).toBe(
      "original synthetic encrypted records"
    )
    expect(await database.checkoutRecoveryStorage.count()).toBe(0)
    await storage.setItem(OUTBOX, "updated synthetic encrypted records")
    expect(legacy.getItem(OUTBOX)).toBe(MARKER)
    database.close()
    await database.open()
    expect(
      await createCheckoutRecoveryStorage(legacy, database).getItem(OUTBOX)
    ).toBe("updated synthetic encrypted records")
    expect(await database.checkoutRecoveryStorage.count()).toBe(1)
  })

  test("copies and verifies original bytes before replacing legacy storage", async () => {
    const { database, legacy, storage } = fixture()
    legacy.setItem(OUTBOX, "original")
    legacy.failWrites = true
    await expect(storage.setItem(OUTBOX, "replacement")).rejects.toThrow(
      "Quota exceeded"
    )
    expect(legacy.getItem(OUTBOX)).toBe("original")
    expect((await database.checkoutRecoveryStorage.get(OUTBOX))?.value).toBe(
      "original"
    )
    expect(await storage.getItem(OUTBOX)).toBe("original")
    legacy.failWrites = false
    await storage.setItem(OUTBOX, "replacement")
    expect(await storage.getItem(OUTBOX)).toBe("replacement")
  })

  test("an IndexedDB failure leaves legacy recovery untouched", async () => {
    const { database, legacy, storage } = fixture()
    legacy.setItem(OUTBOX, "original")
    const put = spyOn(
      database.checkoutRecoveryStorage,
      "put"
    ).mockRejectedValue(
      new DOMException("Database quota exceeded", "QuotaExceededError")
    )
    try {
      await expect(storage.setItem(OUTBOX, "replacement")).rejects.toThrow(
        "Database quota exceeded"
      )
      expect(legacy.getItem(OUTBOX)).toBe("original")
    } finally {
      put.mockRestore()
    }
    expect(await storage.getItem(OUTBOX)).toBe("original")
  })

  test("failure after migration retains the original durable value", async () => {
    const { database, legacy, storage } = fixture()
    legacy.setItem(OUTBOX, "original")
    const realPut = database.checkoutRecoveryStorage.put.bind(
      database.checkoutRecoveryStorage
    )
    let writes = 0
    const put = spyOn(
      database.checkoutRecoveryStorage,
      "put"
    ).mockImplementation((value) => {
      if (++writes === 2)
        return Promise.reject(new Error("Interrupted update")) as ReturnType<
          typeof realPut
        >
      return realPut(value)
    })
    try {
      await expect(storage.setItem(OUTBOX, "replacement")).rejects.toThrow(
        "Interrupted update"
      )
      expect(legacy.getItem(OUTBOX)).toBe(MARKER)
    } finally {
      put.mockRestore()
    }
    expect(await storage.getItem(OUTBOX)).toBe("original")
    await storage.setItem(OUTBOX, "replacement")
    expect(await storage.getItem(OUTBOX)).toBe("replacement")
  })

  test("new records leave an old-client rejection marker, not apparent absence", async () => {
    const { legacy, storage } = fixture()
    await storage.setItem(OUTBOX, "new record")
    expect(legacy.getItem(OUTBOX)).toBe(MARKER)
    expect(Array.isArray(JSON.parse(legacy.getItem(OUTBOX)!))).toBe(false)
  })

  test("missing migrated data fails closed instead of reporting an empty outbox", async () => {
    const { legacy, storage } = fixture()
    legacy.setItem(OUTBOX, MARKER)
    await expect(storage.getItem(OUTBOX)).rejects.toThrow("Do not pay again")
    await expect(storage.setItem(OUTBOX, "replacement")).rejects.toThrow(
      "Do not pay again"
    )
  })

  test("conflicting writes from an old tab cannot replace or hide durable work", async () => {
    const { database, legacy, storage } = fixture()
    legacy.setItem(OUTBOX, "original")
    await storage.setItem(OUTBOX, "current")
    legacy.setItem(OUTBOX, "older tab changed records")
    await expect(storage.getItem(OUTBOX)).rejects.toThrow("older tab")
    await expect(storage.setItem(OUTBOX, "replacement")).rejects.toThrow(
      "older tab"
    )
    expect((await database.checkoutRecoveryStorage.get(OUTBOX))?.value).toBe(
      "current"
    )
    expect(legacy.getItem(OUTBOX)).toBe("older tab changed records")
  })

  test("cleanup keeps a tombstone and cannot resurrect the old queue", async () => {
    const { database, legacy, storage } = fixture()
    legacy.setItem(OUTBOX, "original")
    await storage.setItem(OUTBOX, "current")
    await storage.removeItem(OUTBOX)
    expect(await storage.getItem(OUTBOX)).toBeNull()
    expect(
      (await database.checkoutRecoveryStorage.get(OUTBOX))?.value
    ).toBeNull()
    legacy.setItem(OUTBOX, "original")
    expect(await storage.getItem(OUTBOX)).toBeNull()
    legacy.setItem(OUTBOX, "conflicting old queue")
    await expect(storage.getItem(OUTBOX)).rejects.toThrow("older tab")
  })

  test("archive and retry data use the same boundary without touching other storage", async () => {
    const { database, legacy, storage } = fixture()
    legacy.setItem("unrelated", "retained")
    await storage.setItem(RETRIES, "retry evidence")
    await storage.setItem(ARCHIVE, "completed evidence")
    expect(await storage.getItem(RETRIES)).toBe("retry evidence")
    expect(await storage.getItem(ARCHIVE)).toBe("completed evidence")
    await expect(storage.setItem("unrelated", "changed")).rejects.toThrow(
      "Unsupported"
    )
    expect(legacy.getItem("unrelated")).toBe("retained")
    expect(await database.checkoutRecoveryStorage.count()).toBe(2)
  })
})

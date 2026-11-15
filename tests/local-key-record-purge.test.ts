import { beforeEach, describe, expect, it } from "bun:test"
import { indexedDB } from "fake-indexeddb"
import { LocalKeyStorage } from "../packages/core/src/protocol/local-key/storage"
import {
  inspectLocalKeyRecords,
  purgeLocalKeyRecords,
} from "../packages/core/src/protocol/local-key"

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("conduit-local-key")
    request.onsuccess = request.onblocked = () => resolve()
    request.onerror = () => reject(request.error)
  })
})

function storage() {
  return new LocalKeyStorage({ factory: indexedDB })
}

function record(revision: string, fill: number) {
  return {
    version: 1 as const,
    revision,
    secret: new Uint8Array(32).fill(fill),
  }
}

async function seedActive(revision: string) {
  const db = storage()
  await db.write(record(revision, 1), () => true)
  await db.commit(revision, () => true)
}

async function seedCandidate(revision: string) {
  const db = storage()
  await db.write(record(revision, 2), () => true)
}

describe("local key record inspection", () => {
  it("reports no records on empty storage", async () => {
    expect(await inspectLocalKeyRecords({ factory: indexedDB })).toEqual({
      active: null,
      candidate: null,
    })
  })

  it("reports active and candidate revisions without secret bytes", async () => {
    await seedActive("rev-active")
    await seedCandidate("rev-candidate")
    const revisions = await inspectLocalKeyRecords({ factory: indexedDB })
    expect(revisions).toEqual({
      active: "rev-active",
      candidate: "rev-candidate",
    })
    expect(Object.keys(revisions).sort()).toEqual(["active", "candidate"])
  })
})

describe("local key record purge", () => {
  it("deletes every record when nothing is retained", async () => {
    await seedActive("rev-active")
    await seedCandidate("rev-candidate")
    await purgeLocalKeyRecords(undefined, { factory: indexedDB })
    expect(await inspectLocalKeyRecords({ factory: indexedDB })).toEqual({
      active: null,
      candidate: null,
    })
  })

  it("retains only the claimed revision", async () => {
    await seedActive("rev-active")
    await seedCandidate("rev-candidate")
    await purgeLocalKeyRecords("rev-active", { factory: indexedDB })
    expect(await inspectLocalKeyRecords({ factory: indexedDB })).toEqual({
      active: "rev-active",
      candidate: null,
    })
  })

  it("deletes records with unreadable revisions", async () => {
    const db = storage()
    await db.write(record("rev-active", 3), () => true)
    await db.commit("rev-active", () => true)
    // Corrupt the stored revision directly; the record can no longer sign.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("conduit-local-key", 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = raw.transaction("record", "readwrite")
      tx.objectStore("record").put(
        { version: 1, revision: "not a revision!", secret: new Uint8Array(32) },
        "active"
      )
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    raw.close()
    await purgeLocalKeyRecords(undefined, { factory: indexedDB })
    expect(await inspectLocalKeyRecords({ factory: indexedDB })).toEqual({
      active: null,
      candidate: null,
    })
  })

  it("is a no-op on empty storage", async () => {
    await expect(
      purgeLocalKeyRecords(undefined, { factory: indexedDB })
    ).resolves.toBeUndefined()
  })
})

import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import Dexie from "dexie"
import { db, type ConduitDB } from "../db"

type LegacyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
const MIGRATED = '{"checkoutRecoveryStorage":"indexeddb","version":1}'
const ALLOWED_KEYS = new Set([
  "conduit:checkout-spark-recovery-outbox:v1",
  "conduit:checkout-spark-recovery-snapshot-retries:v1",
])
const ARCHIVE_PREFIX = "conduit:checkout-spark-completed-recovery:v1:"

function assertKey(key: string): void {
  if (!ALLOWED_KEYS.has(key) && !key.startsWith(ARCHIVE_PREFIX))
    throw new Error("Unsupported checkout recovery storage key.")
}

function digest(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)))
}

/**
 * Persist the existing encrypted outbox/archives outside Web Storage's small
 * shared quota. Callers keep their same-origin mutation locks and validation.
 * Legacy bytes are copied and read back before replacing them with a marker;
 * old clients reject that marker instead of treating migrated work as absent.
 */
export function createCheckoutRecoveryStorage(
  legacy: LegacyStorage,
  database: ConduitDB = db
) {
  const table = database.checkoutRecoveryStorage
  // This outbox has its own mutation lock. A caller may be checking it from
  // inside a plan-retirement transaction that does not include this store.
  const get = (key: string) => Dexie.ignoreTransaction(() => table.get(key))
  const put = (row: {
    key: string
    value: string | null
    legacyDigest: string | null
  }) => Dexie.ignoreTransaction(() => table.put(row))
  async function read(key: string) {
    assertKey(key)
    const row = await get(key)
    const previous = legacy.getItem(key)
    if (previous === MIGRATED && !row)
      throw new Error(
        "Saved checkout recovery is unavailable. Do not pay again."
      )
    if (
      row &&
      previous !== null &&
      previous !== MIGRATED &&
      digest(previous) !== row.legacyDigest
    )
      throw new Error(
        "Checkout recovery changed in an older tab. Reload that tab before continuing."
      )
    return { row, previous }
  }
  async function save(key: string, value: string | null): Promise<void> {
    const { row, previous } = await read(key)
    const legacyDigest =
      row?.legacyDigest ??
      (previous !== null && previous !== MIGRATED ? digest(previous) : null)
    if (!row) {
      await put({ key, value: previous, legacyDigest })
      if ((await get(key))?.value !== previous)
        throw new Error("Existing checkout recovery could not be retained.")
    }
    if (previous !== MIGRATED) {
      legacy.setItem(key, MIGRATED)
      if (legacy.getItem(key) !== MIGRATED)
        throw new Error("Checkout recovery migration could not be verified.")
    }
    await put({ key, value, legacyDigest })
    const saved = await get(key)
    if (!saved || saved.value !== value || saved.legacyDigest !== legacyDigest)
      throw new Error("Checkout recovery was not durably saved.")
  }
  return {
    async getItem(key: string): Promise<string | null> {
      const { row, previous } = await read(key)
      return row ? row.value : previous
    },
    setItem: save,
    // Retain a tombstone so stale legacy data cannot resurrect removed work.
    removeItem: (key: string): Promise<void> => save(key, null),
  }
}

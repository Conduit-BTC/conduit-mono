import Dexie, { type EntityTable, type DexieOptions } from "dexie"
import type { SignedNostrEvent } from "../protocol/nostr-event-signer"
import { compareSettingsEvents } from "./events"
import { SettingsError } from "./documents"

export interface SettingsRow {
  key: string
  head?: SignedNostrEvent
  usable?: SignedNostrEvent
  pending?: { event: SignedNostrEvent; baseline?: SignedNostrEvent }
  delivery?: "local" | "acknowledged" | "observed" | "conflict"
}
export interface SettingsStore {
  get(key: string): Promise<SettingsRow>
  put(row: SettingsRow, expectedHead: string | undefined): Promise<void>
}
/** Separate database: no migration of wallet, policy or operational stores. */
export class OrdinarySettingsDB extends Dexie {
  records!: EntityTable<SettingsRow, "key">
  constructor(name = "conduit-ordinary-settings-v1", options?: DexieOptions) {
    super(name, options)
    this.version(1).stores({ records: "key" })
  }
}
export function createSettingsStore(
  database = new OrdinarySettingsDB()
): SettingsStore {
  return {
    async get(key) {
      try {
        return (await database.records.get(key)) ?? { key }
      } catch {
        throw new SettingsError("storage")
      }
    },
    async put(row, expectedHead) {
      try {
        await database.transaction("rw", database.records, async () => {
          const current = await database.records.get(row.key)
          if (current?.head?.id !== expectedHead)
            throw new SettingsError("conflict")
          if (
            current?.head &&
            row.head &&
            compareSettingsEvents(row.head, current.head) > 0
          )
            throw new SettingsError("conflict")
          await database.records.put(row)
        })
      } catch (error) {
        throw error instanceof SettingsError
          ? error
          : new SettingsError("storage")
      }
    },
  }
}
const queues = new Map<string, Promise<unknown>>()
export async function serializeSettingsWrite<T>(
  key: string,
  action: () => Promise<T>
): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve()
  const work = prior
    .catch(() => undefined)
    .then(() => {
      if (typeof navigator !== "undefined" && navigator.locks)
        return navigator.locks.request(`ordinary-settings:${key}`, action)
      // A persistent compare-and-swap still protects staging if Web Locks is absent.
      return action()
    })
  queues.set(key, work)
  try {
    return await work
  } finally {
    if (queues.get(key) === work) queues.delete(key)
  }
}

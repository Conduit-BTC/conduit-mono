import { NostrSignerError } from "../nostr-event-signer"

// Security-critical. This database contains account secret bytes. Never expose
// records through a barrel, application store, diagnostic or migration payload.
const DATABASE = "conduit-local-key"
const RECORD = "active"

export interface LocalKeyRecord {
  version: 1
  revision: string
  secret: Uint8Array
}

export interface LocalKeyStorageOptions {
  factory?: IDBFactory
  timeoutMs?: number
}

export function clearRecord(value: unknown): void {
  if (value && typeof value === "object" && "secret" in value) {
    const secret = value.secret
    if (secret instanceof Uint8Array) secret.fill(0)
  }
}

function validRecord(value: unknown): value is LocalKeyRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<LocalKeyRecord>
  return (
    record.version === 1 &&
    typeof record.revision === "string" &&
    /^[a-zA-Z0-9-]{1,80}$/.test(record.revision) &&
    record.secret instanceof Uint8Array &&
    record.secret.length === 32
  )
}

/** Internal only. No general application code may receive a stored record. */
export class LocalKeyStorage {
  readonly #factory: IDBFactory | undefined
  readonly #timeoutMs: number

  constructor(options: LocalKeyStorageOptions = {}) {
    this.#factory = options.factory ?? globalThis.indexedDB
    this.#timeoutMs = options.timeoutMs ?? 2500
  }

  async #open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest
      try {
        if (!this.#factory) throw new Error()
        request = this.#factory.open(DATABASE, 1)
      } catch {
        reject(new NostrSignerError("unavailable"))
        return
      }
      let failed = false
      const fail = () => {
        failed = true
        clearTimeout(timer)
        reject(new NostrSignerError("unavailable"))
      }
      const timer = setTimeout(fail, this.#timeoutMs)
      request.onblocked = request.onerror = fail
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("record"))
          request.result.createObjectStore("record")
      }
      request.onsuccess = () => {
        clearTimeout(timer)
        if (failed) request.result.close()
        else resolve(request.result)
      }
    })
  }

  async #transaction<T>(
    mode: IDBTransactionMode,
    apply: (value: unknown, store: IDBObjectStore) => T,
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal
  ): Promise<T> {
    const db = await this.#open()
    try {
      if (signal?.aborted || !isCurrent())
        throw new NostrSignerError("authority_changed")
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("record", mode)
        const store = tx.objectStore("record")
        const read = store.get(RECORD)
        let result: T
        let failure: NostrSignerError | undefined
        let settled = false
        const clearRead = () => {
          if (read.readyState === "done") clearRecord(read.result)
        }
        const fail = (error = new NostrSignerError("unavailable")) => {
          failure = error
          settled = true
          clearRead()
          reject(error)
          try {
            tx.abort()
          } catch {
            /* Already settled transaction. */
          }
        }
        const cancel = () => fail(new NostrSignerError("authority_changed"))
        const timer = setTimeout(() => fail(), this.#timeoutMs)
        const finish = () => {
          clearTimeout(timer)
          signal?.removeEventListener("abort", cancel)
        }
        signal?.addEventListener("abort", cancel, { once: true })
        read.onsuccess = () => {
          if (settled || signal?.aborted || !isCurrent()) {
            clearRead()
            cancel()
            return
          }
          try {
            result = apply(read.result, store)
          } catch (error) {
            fail(
              error instanceof NostrSignerError
                ? error
                : new NostrSignerError("unavailable")
            )
          }
        }
        tx.oncomplete = () => {
          finish()
          if (settled) {
            clearRead()
            return
          }
          settled = true
          resolve(result)
        }
        tx.onerror = tx.onabort = () => {
          finish()
          clearRead()
          settled = true
          reject(failure ?? new NostrSignerError("unavailable"))
        }
      })
    } catch (error) {
      throw error instanceof NostrSignerError
        ? error
        : new NostrSignerError("unavailable")
    } finally {
      db.close()
    }
  }

  read(): Promise<LocalKeyRecord | null> {
    return this.#transaction("readonly", (value) => {
      if (value === undefined) return null
      if (!validRecord(value)) {
        clearRecord(value)
        throw new NostrSignerError("unavailable")
      }
      return value
    })
  }

  write(
    record: LocalKeyRecord,
    isCurrent: () => boolean,
    signal?: AbortSignal
  ): Promise<void> {
    return this.#transaction(
      "readwrite",
      (previous, store) => {
        clearRecord(previous)
        store.put(record, RECORD)
      },
      isCurrent,
      signal
    )
  }

  /** Atomic comparison/deletion: stale cleanup can never remove a later import. */
  remove(revision: string): Promise<void> {
    return this.#transaction("readwrite", (value, store) => {
      try {
        if (value === undefined) return
        // Preserve every identifiable later revision, including an unknown
        // schema or damaged body. A record without a revision cannot authorize
        // any signer and can be explicitly removed.
        const storedRevision =
          value && typeof value === "object" && "revision" in value
            ? value.revision
            : undefined
        if (
          typeof storedRevision !== "string" ||
          !/^[a-zA-Z0-9-]{1,80}$/.test(storedRevision) ||
          storedRevision === revision
        )
          store.delete(RECORD)
      } finally {
        clearRecord(value)
      }
    })
  }
}

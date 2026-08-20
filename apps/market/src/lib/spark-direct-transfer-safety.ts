export interface SparkDirectTransferSafetyMarker {
  attemptId: string
  createdAt: number
}

export interface SparkDirectTransferSafetyStore {
  get(safetyScope: string): SparkDirectTransferSafetyMarker | null
  put(safetyScope: string, marker: SparkDirectTransferSafetyMarker): void
  delete(safetyScope: string): void
}

// The v2 storage key remains stable so an unresolved direct transfer from an
// earlier Conduit build also blocks the unified Spark send flow after upgrade.

const STORAGE_KEY_PREFIX = "conduit:spark-direct-transfer-safety:v2:"

export class BrowserSparkDirectTransferSafetyStore implements SparkDirectTransferSafetyStore {
  readonly #providedStorage:
    Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined

  constructor(storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
    this.#providedStorage = storage
  }

  get(safetyScope: string): SparkDirectTransferSafetyMarker | null {
    const value = this.#storage().getItem(getStorageKey(safetyScope))
    if (value === null) {
      return null
    }
    const marker = parseMarker(value)
    if (!marker) {
      throw new Error(
        "Spark transfer safety state is invalid. Spark sends are disabled on this device."
      )
    }
    return marker
  }

  put(safetyScope: string, marker: SparkDirectTransferSafetyMarker): void {
    this.#storage().setItem(
      getStorageKey(safetyScope),
      JSON.stringify({
        version: 2,
        attemptId: marker.attemptId,
        createdAt: marker.createdAt,
      })
    )
  }

  delete(safetyScope: string): void {
    this.#storage().removeItem(getStorageKey(safetyScope))
  }

  #storage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
    if (this.#providedStorage) {
      return this.#providedStorage
    }
    if (typeof window === "undefined") {
      throw new Error(
        "Spark transfer safety storage is unavailable. Spark sends are disabled."
      )
    }
    return window.localStorage
  }
}

export class MemorySparkDirectTransferSafetyStore implements SparkDirectTransferSafetyStore {
  readonly #markers = new Map<string, SparkDirectTransferSafetyMarker>()

  get(safetyScope: string): SparkDirectTransferSafetyMarker | null {
    return this.#markers.get(safetyScope) ?? null
  }

  put(safetyScope: string, marker: SparkDirectTransferSafetyMarker): void {
    this.#markers.set(safetyScope, marker)
  }

  delete(safetyScope: string): void {
    this.#markers.delete(safetyScope)
  }
}

export function createSparkDirectTransferSafetyStore(): SparkDirectTransferSafetyStore {
  return typeof window === "undefined"
    ? new MemorySparkDirectTransferSafetyStore()
    : new BrowserSparkDirectTransferSafetyStore()
}

function getStorageKey(safetyScope: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(safetyScope)}`
}

function parseMarker(value: string): SparkDirectTransferSafetyMarker | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      parsed.version !== 2 ||
      typeof parsed.attemptId !== "string" ||
      !parsed.attemptId ||
      typeof parsed.createdAt !== "number" ||
      !Number.isSafeInteger(parsed.createdAt) ||
      parsed.createdAt <= 0
    ) {
      return null
    }
    return {
      attemptId: parsed.attemptId,
      createdAt: parsed.createdAt,
    }
  } catch {
    return null
  }
}

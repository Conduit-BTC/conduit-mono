/**
 * Serialize a device's signed writes and exact relay sends for the same
 * product coordinates. The durable Dexie intent/frontier remains the source
 * of truth; this lock only closes the read-to-send cross-tab window.
 *
 * A missing Web Locks implementation is not permission to send using a stale
 * frontier. Callers fail closed until a durable alternative is available.
 */
export interface LocalProductCoordinateLockOptions {
  /** Test seam; production always uses the browser's cross-tab Web Locks. */
  requestLock?: <T>(name: string, operation: () => Promise<T>) => Promise<T>
}

function requestBrowserLock<T>(
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error("Cross-tab product-write lock is unavailable")
  }
  return navigator.locks.request(name, async (lock) => {
    if (!lock) throw new Error("Cross-tab product-write lock was not acquired")
    return operation()
  })
}

export async function withLocalProductCoordinateLocks<T>(
  addressIds: readonly string[],
  operation: () => Promise<T>,
  options: LocalProductCoordinateLockOptions = {}
): Promise<T> {
  const sorted = [...new Set(addressIds)].sort()
  if (
    sorted.length === 0 ||
    sorted.some((addressId) => !/^30402:[0-9a-f]{64}:.+$/.test(addressId))
  ) {
    throw new Error("Product-write lock coordinates are invalid")
  }
  const requestLock = options.requestLock ?? requestBrowserLock
  const enter = async (index: number): Promise<T> => {
    if (index === sorted.length) return operation()
    return requestLock(`conduit:product-write:${sorted[index]}`, () =>
      enter(index + 1)
    )
  }
  return enter(0)
}

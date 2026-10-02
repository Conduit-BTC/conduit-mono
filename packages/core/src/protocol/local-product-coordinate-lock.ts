import { db } from "../db"

/**
 * Serialize device-local product mutations. Never hold this lock across signer
 * or relay I/O; after a remote wait, revalidate the durable current frontier.
 *
 * A missing Web Locks implementation is not permission to send using a stale
 * frontier. Callers fail closed until a durable alternative is available.
 */
export interface LocalProductCoordinateLockOptions {
  /** Test seam; production always uses the browser's cross-tab Web Locks. */
  requestLock?: <T>(name: string, operation: () => Promise<T>) => Promise<T>
}

export async function readCurrentProductWriteRevision(
  addressId: string
): Promise<{
  eventId: string | null
  eventCreatedAt: number | null
  deletionCreatedAt: number
  exactEventDeleted: boolean
}> {
  const [frontier, cached, addressTombstone] = await Promise.all([
    db.localProductWriteFrontiers.get(addressId),
    db.products.get(addressId),
    db.productTombstones.get(`a:${addressId}`),
  ])
  const frontierCreatedAt = frontier?.eventCreatedAt ?? -1
  const cachedCreatedAt = cached?.eventCreatedAt ?? -1
  const frontierWins =
    frontierCreatedAt > cachedCreatedAt ||
    (frontierCreatedAt === cachedCreatedAt &&
      !!frontier?.eventId &&
      (!cached?.eventId || frontier.eventId < cached.eventId))
  const eventId = frontierWins ? frontier!.eventId : (cached?.eventId ?? null)
  const exactTombstone = eventId
    ? await db.productTombstones.get(`e:${addressId.split(":")[1]}:${eventId}`)
    : undefined
  return {
    eventId,
    exactEventDeleted: exactTombstone !== undefined,
    eventCreatedAt: frontierWins
      ? frontier!.eventCreatedAt
      : (cached?.eventCreatedAt ?? null),
    deletionCreatedAt: Math.max(
      frontier?.deletionCreatedAt ?? -1,
      addressTombstone?.deletedAt ?? -1
    ),
  }
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

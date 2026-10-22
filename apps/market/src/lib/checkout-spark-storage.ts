const isolatedWriteTails = new Map<string, Promise<unknown>>()

/** Serialize each shared-array mutation, including its durability readback. */
export async function withCheckoutSparkStorageLock<T>(
  storageKey: string,
  mutation: () => T
): Promise<T> {
  // Non-browser callers supply isolated storage. Browser writes always need
  // the same-origin lock; a process-local fallback cannot protect other tabs.
  if (typeof window === "undefined") {
    // Isolated callers still have concurrent Merchant/Organizer ACK saves.
    // Async persistence must not turn those read/merge/write steps into a race.
    const previous = isolatedWriteTails.get(storageKey) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(mutation)
    isolatedWriteTails.set(storageKey, next)
    try {
      return await next
    } finally {
      if (isolatedWriteTails.get(storageKey) === next)
        isolatedWriteTails.delete(storageKey)
    }
  }
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new Error(
      "This browser cannot safely coordinate checkout recovery storage across tabs."
    )
  }
  return navigator.locks.request(
    `conduit:checkout-spark-storage:${storageKey}`,
    { mode: "exclusive" },
    mutation
  )
}

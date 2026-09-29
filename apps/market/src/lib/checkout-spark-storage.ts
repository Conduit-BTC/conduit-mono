/** Serialize each shared-array mutation, including its durability readback. */
export async function withCheckoutSparkStorageLock<T>(
  storageKey: string,
  mutation: () => T
): Promise<T> {
  // Non-browser callers supply isolated storage. Browser writes always need
  // the same-origin lock; a process-local fallback cannot protect other tabs.
  if (typeof window === "undefined") return mutation()
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

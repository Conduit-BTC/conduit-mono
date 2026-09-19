export interface VisibilityDocument {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
}

export interface SignerOperationQueue<SessionScope> {
  get(sessionScope: SessionScope): Promise<void> | undefined
  set(sessionScope: SessionScope, queued: Promise<void>): unknown
  delete(sessionScope: SessionScope): boolean
}

/** Keep one externally backed signer interaction active per account session. */
export async function serializeSignerOperation<T, SessionScope>(
  signerQueues: SignerOperationQueue<SessionScope>,
  sessionScope: SessionScope,
  task: () => Promise<T>
): Promise<T> {
  const previous = signerQueues.get(sessionScope) ?? Promise.resolve()
  let release!: () => void
  const slot = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => undefined).then(() => slot)
  signerQueues.set(sessionScope, queued)
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (signerQueues.get(sessionScope) === queued) {
      signerQueues.delete(sessionScope)
    }
  }
}

function getBrowserDocument(): VisibilityDocument | undefined {
  return typeof document === "undefined" ? undefined : document
}

/**
 * Keep a foreground-only signer sequence paused while the app is hidden.
 * This helper coordinates visibility only; it never dispatches or retries a
 * signer request.
 */
export async function waitForVisibleDocument(
  visibilityDocument: VisibilityDocument | undefined = getBrowserDocument(),
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("Signer visibility wait cancelled.")
  }
  if (!visibilityDocument || visibilityDocument.visibilityState === "visible") {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      visibilityDocument.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      )
      signal?.removeEventListener("abort", handleAbort)
    }
    const handleVisibilityChange = () => {
      if (visibilityDocument.visibilityState !== "visible") return
      cleanup()
      resolve()
    }
    const handleAbort = () => {
      cleanup()
      reject(new Error("Signer visibility wait cancelled."))
    }

    visibilityDocument.addEventListener(
      "visibilitychange",
      handleVisibilityChange
    )
    signal?.addEventListener("abort", handleAbort, { once: true })
    if (signal?.aborted) {
      handleAbort()
      return
    }
    handleVisibilityChange()
  })
}

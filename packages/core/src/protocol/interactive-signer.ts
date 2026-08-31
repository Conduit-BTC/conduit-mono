export interface VisibilityDocument {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
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
  visibilityDocument: VisibilityDocument | undefined = getBrowserDocument()
): Promise<void> {
  if (!visibilityDocument || visibilityDocument.visibilityState === "visible") {
    return
  }

  await new Promise<void>((resolve) => {
    const handleVisibilityChange = () => {
      if (visibilityDocument.visibilityState !== "visible") return
      visibilityDocument.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      )
      resolve()
    }

    visibilityDocument.addEventListener(
      "visibilitychange",
      handleVisibilityChange
    )
    handleVisibilityChange()
  })
}

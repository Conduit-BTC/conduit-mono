/** Write-only cleanup: never read, retain, or return pasted secret text. */
export async function clearLocalKeyClipboard(
  input: HTMLInputElement
): Promise<boolean> {
  if (!input.isConnected || input.disabled) return false
  try {
    const clipboard = input.ownerDocument.defaultView?.navigator.clipboard
    if (!clipboard?.writeText) return false
    await clipboard.writeText("")
    return true
  } catch {
    // Browser exceptions are deliberately not exposed to UI or diagnostics.
    return false
  }
}

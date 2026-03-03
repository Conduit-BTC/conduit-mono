/**
 * WebLN integration for browser-based Lightning invoice generation.
 *
 * The Alby browser extension (and other WebLN-compatible wallets) expose
 * `window.webln` with a `makeInvoice()` method. This provides zero-config
 * invoice generation — no NWC URI needed.
 */

export interface WebLNProvider {
  enable(): Promise<void>
  makeInvoice(args: {
    amount?: number | string
    defaultAmount?: number | string
    defaultMemo?: string
  }): Promise<{ paymentRequest: string }>
}

declare global {
  interface Window {
    webln?: WebLNProvider
  }
}

/**
 * Check if a WebLN provider (e.g. Alby extension) is available in the browser.
 */
export function hasWebLN(): boolean {
  return typeof window !== "undefined" && !!window.webln
}

/**
 * Generate a Lightning invoice using WebLN (Alby extension or similar).
 * Throws if WebLN is not available or the user rejects.
 */
export async function weblnMakeInvoice(params: {
  amountSats: number
  memo?: string
}): Promise<{ invoice: string }> {
  if (!window.webln) {
    throw new Error("WebLN provider not available")
  }

  await window.webln.enable()

  const result = await window.webln.makeInvoice({
    amount: params.amountSats,
    defaultMemo: params.memo,
  })

  return { invoice: result.paymentRequest }
}

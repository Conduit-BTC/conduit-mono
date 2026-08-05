/**
 * WebLN integration for browser-based Lightning invoice generation and payment.
 *
 * The Alby browser extension (and other WebLN-compatible wallets) expose
 * `window.webln` with Lightning payment methods. This provides zero-config
 * invoice generation and payment — no NWC URI needed.
 */

export interface WebLNProvider {
  enable(): Promise<void>
  makeInvoice(args: {
    amount?: number | string
    defaultAmount?: number | string
    defaultMemo?: string
  }): Promise<{ paymentRequest: string }>
  sendPayment(paymentRequest: string): Promise<{
    preimage?: string
    paymentHash?: string
  }>
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
 * Which phase of a WebLN payment attempt failed.
 *
 * - `unavailable`, `enable`: the invoice never reached the wallet, so the
 *   payment cannot have moved and another rail may take it.
 * - `submitted`: the wallet held the invoice and then rejected. The outcome is
 *   unknown, so no rail may retry automatically, but the shopper may still be
 *   offered the same invoice to settle manually.
 * - `settled_without_proof`: the wallet reported success yet returned no
 *   preimage, so it most likely paid. Treat as ambiguous and offer nothing.
 */
export type WeblnPaymentFailurePhase =
  "unavailable" | "enable" | "submitted" | "settled_without_proof"

export const WEBLN_MISSING_PROOF_MESSAGE =
  "WebLN payment did not return a payment proof"

export class WeblnPaymentError extends Error {
  readonly phase: WeblnPaymentFailurePhase

  constructor(
    message: string,
    phase: WeblnPaymentFailurePhase,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = "WeblnPaymentError"
    this.phase = phase
  }
}

const WEBLN_PAYMENT_FAILURE_PHASES: readonly WeblnPaymentFailurePhase[] = [
  "unavailable",
  "enable",
  "submitted",
  "settled_without_proof",
]

function isWeblnPaymentFailurePhase(
  value: unknown
): value is WeblnPaymentFailurePhase {
  return (
    typeof value === "string" &&
    (WEBLN_PAYMENT_FAILURE_PHASES as readonly string[]).includes(value)
  )
}

/**
 * Read the failure phase of a WebLN payment error.
 *
 * Duck-typed on purpose: a duplicated module instance would break `instanceof`,
 * and treating a real pre-submit failure as ambiguous only costs a fallback.
 * Returns `null` for anything that does not carry a phase, so callers must
 * treat unknown failures as ambiguous.
 */
export function getWeblnPaymentFailurePhase(
  error: unknown
): WeblnPaymentFailurePhase | null {
  if (error instanceof WeblnPaymentError) return error.phase
  if (!error || typeof error !== "object") return null
  const candidate = error as {
    name?: unknown
    phase?: unknown
    message?: unknown
  }
  if (candidate.name === "WeblnPaymentError") {
    return isWeblnPaymentFailurePhase(candidate.phase) ? candidate.phase : null
  }
  // A caller-supplied provider may report the missing-proof case untyped.
  if (
    typeof candidate.message === "string" &&
    candidate.message.includes(WEBLN_MISSING_PROOF_MESSAGE)
  ) {
    return "settled_without_proof"
  }
  return null
}

/**
 * True only when the invoice provably never reached the wallet, so another
 * payment rail may attempt it without risking a double payment.
 */
export function isWeblnPreSubmitFailure(error: unknown): boolean {
  const phase = getWeblnPaymentFailurePhase(error)
  return phase === "unavailable" || phase === "enable"
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

/**
 * Pay a BOLT11 invoice using WebLN (Alby extension or similar).
 *
 * Always throws `WeblnPaymentError` so callers can tell a pre-submit failure
 * from an unknown outcome after the wallet received the invoice.
 */
export async function weblnSendPayment(params: {
  invoice: string
}): Promise<{ preimage: string; paymentHash?: string }> {
  if (typeof window === "undefined" || !window.webln) {
    throw new WeblnPaymentError("WebLN provider not available", "unavailable")
  }

  const provider = window.webln

  if (typeof provider.sendPayment !== "function") {
    throw new WeblnPaymentError(
      "WebLN provider cannot pay invoices",
      "unavailable"
    )
  }

  try {
    await provider.enable()
  } catch (error) {
    throw new WeblnPaymentError(
      error instanceof Error
        ? error.message
        : "Browser wallet rejected the connection request",
      "enable",
      { cause: error }
    )
  }

  let result: Awaited<ReturnType<WebLNProvider["sendPayment"]>>
  try {
    result = await provider.sendPayment(params.invoice)
  } catch (error) {
    throw new WeblnPaymentError(
      error instanceof Error
        ? `${error.message} The browser wallet may already have sent this payment.`
        : "Browser wallet payment outcome is unknown.",
      "submitted",
      { cause: error }
    )
  }

  const preimage =
    typeof result.preimage === "string" ? result.preimage.trim() : ""

  // A spec-conforming provider rejects when it does not pay, so resolving
  // without a preimage most likely means it paid. A provider that instead
  // resolves empty on cancel is indistinguishable here, and WebLN offers no
  // lookup to settle the question.
  if (!preimage) {
    throw new WeblnPaymentError(
      WEBLN_MISSING_PROOF_MESSAGE,
      "settled_without_proof"
    )
  }

  return {
    preimage,
    paymentHash:
      typeof result.paymentHash === "string" ? result.paymentHash : undefined,
  }
}

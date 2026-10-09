import {
  isValidLightningInvoice,
  normalizeLightningInvoice,
  validateLightningInvoiceForPayment,
} from "@conduit/core"
import { getCashAppLightningUrl } from "../lib/cash-app-lightning"

export type ExternalInvoicePaymentAction =
  "cash_app" | "lightning" | "copy" | "qr"
export type ExternalInvoicePaymentActionResult =
  | "wallet_requested"
  | "wallet_request_failed"
  | "copied"
  | "copy_failed"
  | "qr_ready"
  | "unavailable"

/** Browser handoff only: never requests an invoice or confirms a payment. */
export async function performExternalInvoicePaymentAction(input: {
  action: ExternalInvoicePaymentAction
  invoice: string
  expectedAmountSats: number
  onBeforeInvoiceUse: () => boolean
  now?: () => number
  browser?: {
    open: (url: string, target: "_blank" | "_self") => void
    copy: (invoice: string) => Promise<void>
  }
}): Promise<ExternalInvoicePaymentActionResult> {
  const nowMs = (input.now ?? Date.now)()
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(input.expectedAmountSats * 1_000) ||
    input.expectedAmountSats <= 0 ||
    !isValidLightningInvoice(input.invoice) ||
    !validateLightningInvoiceForPayment({
      invoice: input.invoice,
      expectedAmountMsats: input.expectedAmountSats * 1_000,
      nowSeconds: Math.floor(nowMs / 1_000),
    }).ok
  )
    return "unavailable"

  try {
    if (!input.onBeforeInvoiceUse()) return "unavailable"
  } catch {
    return "unavailable"
  }

  const invoice = normalizeLightningInvoice(input.invoice)
  const browser = input.browser ?? {
    open: (url: string, target: "_blank" | "_self") => {
      window.open(
        url,
        target,
        target === "_blank" ? "noopener,noreferrer" : undefined
      )
    },
    copy: (value: string) => navigator.clipboard.writeText(value),
  }
  if (input.action === "qr") return "qr_ready"
  if (input.action === "copy") {
    try {
      await browser.copy(invoice)
      return "copied"
    } catch {
      return "copy_failed"
    }
  }
  const url =
    input.action === "cash_app"
      ? getCashAppLightningUrl(
          invoice,
          input.expectedAmountSats,
          Math.floor(nowMs / 1_000)
        )
      : `lightning:${invoice}`
  if (!url) return "unavailable"
  try {
    browser.open(url, input.action === "cash_app" ? "_blank" : "_self")
    return "wallet_requested"
  } catch {
    return "wallet_request_failed"
  }
}

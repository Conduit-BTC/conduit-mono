import {
  isValidLightningInvoice,
  normalizeLightningInvoice,
  validateLightningInvoiceForPayment,
} from "@conduit/core"
import { getCashAppLightningUrl } from "../lib/cash-app-lightning"

export type ExternalInvoicePaymentAction =
  "cash_app" | "lightning" | "copy" | "qr"
export type ExternalInvoicePaymentActionResult =
  "wallet_ready" | "copied" | "copy_failed" | "qr_ready" | "unavailable"

/** Finish invoice preparation; wallet launch requires a fresh native link click. */
export async function performExternalInvoicePaymentAction(input: {
  action: ExternalInvoicePaymentAction
  invoice: string
  expectedAmountSats: number
  onBeforeInvoiceUse: () => boolean
  now?: () => number
  browser?: {
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
  // Async reservation can outlast transient activation. InvoicePayment owns
  // the guarded native links; preparation never claims that a wallet opened.
  return "wallet_ready"
}

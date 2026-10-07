import { useEffect, useState } from "react"
import type { BtcUsdRateQuote, ShopperPricePreference } from "@conduit/core"
import { subscribeToTimeBoundaries } from "@conduit/ui"

import type { CheckoutSparkExternalFundingInvoice } from "../lib/checkout-spark-settled-funding"
import {
  InvoicePayment,
  type ExternalInvoicePaymentAction,
} from "./InvoicePayment"
import type { ExternalInvoicePaymentActionResult } from "./invoice-payment-action"

export type CheckoutSparkExternalFundingPreparation = {
  amountSats: number
  cashAppAvailable: boolean
  disabled: boolean
  onApprove: (action: ExternalInvoicePaymentAction) => void
}

export function CheckoutSparkExternalFunding({
  externalInvoice,
  enabled,
  onBeforeInvoiceUse,
  preference,
  quote,
  preparation,
  actionResult,
  now = Date.now,
}: {
  externalInvoice: CheckoutSparkExternalFundingInvoice | null
  enabled: boolean
  onBeforeInvoiceUse: () => boolean
  preference: ShopperPricePreference
  quote: BtcUsdRateQuote | null
  preparation?: CheckoutSparkExternalFundingPreparation
  actionResult?: ExternalInvoicePaymentActionResult
  now?: () => number
}) {
  const [boundaryNow, setBoundaryNow] = useState(now)
  const [revokedInvoice, setRevokedInvoice] =
    useState<CheckoutSparkExternalFundingInvoice | null>(null)
  const exposedAt = externalInvoice?.exposedAt ?? Number.NaN
  // Merchant handoff ends buyer payout authority, not this exact funding
  // invoice's lifetime. Parent guards still own session/order disclosure.
  const cutoff = externalInvoice?.expiresAt ?? Number.NaN
  const validWindow =
    Number.isSafeInteger(exposedAt) &&
    exposedAt > 0 &&
    Number.isSafeInteger(externalInvoice?.expiresAt) &&
    Number.isSafeInteger(externalInvoice?.takeoverAt) &&
    (externalInvoice?.takeoverAt ?? 0) > 0 &&
    exposedAt < cutoff

  useEffect(() => {
    if (!enabled || !validWindow) return
    return subscribeToTimeBoundaries({
      boundaries: [exposedAt, cutoff],
      currentNowMs: boundaryNow,
      onBoundary: setBoundaryNow,
      now,
    })
  }, [enabled, validWindow, exposedAt, cutoff, boundaryNow, now])

  function isCurrent() {
    const currentTime = now()
    return (
      enabled &&
      externalInvoice !== revokedInvoice &&
      validWindow &&
      Number.isSafeInteger(currentTime) &&
      exposedAt <= currentTime &&
      currentTime < cutoff
    )
  }

  function canUseInvoice() {
    const allowed = isCurrent() && onBeforeInvoiceUse()
    // A rejected parent guard revokes this exact disclosure, even if time has
    // not advanced. Only a fresh parent-authorized object may reopen it.
    if (!allowed) setRevokedInvoice(externalInvoice)
    return allowed
  }

  // Unmount every disclosure surface, including an already-open QR/details.
  if (!externalInvoice) {
    if (
      !enabled ||
      !preparation ||
      preparation.amountSats <= 0 ||
      !Number.isSafeInteger(preparation.amountSats * 1_000)
    )
      return null
    return (
      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
        <p className="text-sm font-medium text-[var(--text-secondary)]">
          External wallet
        </p>
        <InvoicePayment
          invoice={null}
          expectedAmountSats={preparation.amountSats}
          preference={preference}
          quote={quote}
          guestSession={false}
          onBeforeInvoiceUse={() => false}
          onPrepareInvoice={preparation.onApprove}
          preparationDisabled={preparation.disabled}
          cashAppPreparationAvailable={preparation.cashAppAvailable}
        />
      </section>
    )
  }
  if (!isCurrent()) return null

  return (
    <section
      className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4"
      onClickCapture={(event) => {
        // Cover QR/details toggles too, before any child action can run.
        if (!canUseInvoice()) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
    >
      <p className="text-sm leading-6 text-[var(--text-secondary)]">
        Pay once, then return here to check progress.
      </p>
      <InvoicePayment
        key={externalInvoice.invoice}
        invoice={externalInvoice.invoice}
        expectedAmountSats={externalInvoice.amountSats}
        preference={preference}
        quote={quote}
        guestSession={false}
        onBeforeInvoiceUse={canUseInvoice}
        actionResult={actionResult}
      />
    </section>
  )
}

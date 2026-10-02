import { useEffect, useState } from "react"
import type { BtcUsdRateQuote, ShopperPricePreference } from "@conduit/core"
import { subscribeToTimeBoundaries } from "@conduit/ui"

import type { CheckoutSparkExternalFundingInvoice } from "../lib/checkout-spark-settled-funding"
import { InvoicePayment } from "./InvoicePayment"

export function CheckoutSparkExternalFunding({
  externalInvoice,
  enabled,
  onBeforeInvoiceUse,
  preference,
  quote,
  now = Date.now,
}: {
  externalInvoice: CheckoutSparkExternalFundingInvoice | null
  enabled: boolean
  onBeforeInvoiceUse: () => boolean
  preference: ShopperPricePreference
  quote: BtcUsdRateQuote | null
  now?: () => number
}) {
  const [boundaryNow, setBoundaryNow] = useState(now)
  const [revokedInvoice, setRevokedInvoice] =
    useState<CheckoutSparkExternalFundingInvoice | null>(null)
  const exposedAt = externalInvoice?.exposedAt ?? Number.NaN
  const cutoff = Math.min(
    externalInvoice?.expiresAt ?? Number.NaN,
    externalInvoice?.takeoverAt ?? Number.NaN
  )
  const validWindow =
    Number.isSafeInteger(exposedAt) &&
    exposedAt > 0 &&
    Number.isSafeInteger(externalInvoice?.expiresAt) &&
    Number.isSafeInteger(externalInvoice?.takeoverAt) &&
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
  if (!externalInvoice || !isCurrent()) return null

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
        Pay this invoice only once from your external wallet. Then return here
        to finish your order. Your payment is checked while this order is
        visible; if paused, choose Resume payment. Opening a wallet is not
        payment confirmation.
      </p>
      <InvoicePayment
        key={externalInvoice.invoice}
        invoice={externalInvoice.invoice}
        expectedAmountSats={externalInvoice.amountSats}
        preference={preference}
        quote={quote}
        guestSession={false}
        onBeforeInvoiceUse={canUseInvoice}
      />
    </section>
  )
}

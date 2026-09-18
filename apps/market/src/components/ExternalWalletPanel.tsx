import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  decodeLightningInvoiceMetadata,
  getOrderPublicZapSigner,
  type BtcUsdRateQuote,
  type ShopperPricePreference,
} from "@conduit/core"
import { Button } from "@conduit/ui"
import type { OrderViewModel } from "../lib/order-view"
import { InvoicePayment } from "./InvoicePayment"

/** External-wallet QR fallback (CND-120): shown when payment is manual_required. */
export function ExternalWalletPanel({
  vm,
  onMarkPaid,
  onBeforeInvoiceUse,
  onPrepareMerchantInvoice,
  preparationScope,
  merchantInvoicePrepared,
  boundMerchantInvoiceExpiresAt,
  busy,
  guestSession,
  autoDetectReceipt,
  pricing,
}: {
  vm: OrderViewModel
  onMarkPaid: () => void
  onBeforeInvoiceUse: () => boolean
  onPrepareMerchantInvoice: () => Promise<void>
  preparationScope: string
  merchantInvoicePrepared: boolean
  boundMerchantInvoiceExpiresAt: number | null
  busy: boolean
  guestSession: boolean
  autoDetectReceipt: boolean
  pricing: {
    preference: ShopperPricePreference
    quote: BtcUsdRateQuote | null
  }
}) {
  const prepareRef = useRef(onPrepareMerchantInvoice)
  useLayoutEffect(() => {
    prepareRef.current = onPrepareMerchantInvoice
  }, [onPrepareMerchantInvoice])
  const [preparation, setPreparation] = useState<{
    scope: string
    invoice: string
    error: string | null
  } | null>(null)
  const [retryPreparation, setRetryPreparation] = useState(0)
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1_000)
  )
  const invoice = vm.invoice
  const merchantInvoice = vm.merchantInvoiceAction
  const hasBoundMerchantInvoice =
    vm.checkoutMode === "pay_later" &&
    vm.paymentStatus === "manual_required" &&
    !!invoice &&
    boundMerchantInvoiceExpiresAt !== null
  const isMerchantInvoice = !!merchantInvoice || hasBoundMerchantInvoice
  const invoiceExpiry = invoice
    ? decodeLightningInvoiceMetadata(invoice).expiresAt
    : null
  const publicReceiptInvoice =
    autoDetectReceipt ||
    !!(
      vm.publicZapSigner ??
      (vm.checkoutMode ? getOrderPublicZapSigner(vm.checkoutMode) : null)
    )
  useEffect(() => {
    if (invoiceExpiry === null) return
    const remainingMs = invoiceExpiry * 1_000 - Date.now()
    if (remainingMs <= 0) return
    const timer = window.setTimeout(
      () => setNowSeconds(Math.floor(Date.now() / 1_000)),
      Math.min(remainingMs, 2_147_483_647)
    )
    return () => window.clearTimeout(timer)
  }, [invoiceExpiry, nowSeconds])
  const requiresPreparation =
    merchantInvoice?.status === "payable" && !merchantInvoicePrepared
  const preparationInvoice = merchantInvoice?.invoice ?? ""
  useEffect(() => {
    if (!requiresPreparation) return
    let current = true
    const prepare = prepareRef.current
    setPreparation({
      scope: preparationScope,
      invoice: preparationInvoice,
      error: null,
    })
    void prepare().catch((error: unknown) => {
      if (!current) return
      setPreparation({
        scope: preparationScope,
        invoice: preparationInvoice,
        error:
          error instanceof Error
            ? error.message
            : "The invoice could not be prepared. Try again.",
      })
    })
    return () => {
      current = false
    }
  }, [
    requiresPreparation,
    preparationScope,
    preparationInvoice,
    retryPreparation,
  ])
  const preparationError =
    preparation?.scope === preparationScope &&
    preparation.invoice === preparationInvoice
      ? preparation.error
      : null
  if (!invoice) return null
  if (requiresPreparation) {
    return (
      <section className="rounded-[1.5rem] border border-amber-500/40 bg-amber-500/5 p-5">
        <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
          {preparationError ? "Invoice unavailable" : "Preparing your invoice"}
        </h2>
        <p
          role={preparationError ? "alert" : "status"}
          className="mt-1 text-pretty text-sm text-[var(--text-secondary)]"
        >
          {preparationError ??
            "Your payment details will appear automatically."}
        </p>
        {preparationError && (
          <Button
            className="mt-4 h-10 px-4 text-sm"
            disabled={busy}
            onClick={() => setRetryPreparation((attempt) => attempt + 1)}
          >
            Retry invoice
          </Button>
        )}
      </section>
    )
  }
  const invoiceExpired =
    invoiceExpiry !== null &&
    invoiceExpiry <= Math.max(nowSeconds, Math.floor(Date.now() / 1_000))
  const invoiceBlocked =
    merchantInvoice?.status === "blocked" ||
    invoiceExpiry === null ||
    invoiceExpired
  const invoiceCanReport =
    merchantInvoice?.status === "blocked"
      ? merchantInvoice.canReport
      : invoiceExpired
  const invoiceError =
    merchantInvoice?.status === "blocked"
      ? merchantInvoice.reason
      : invoiceExpiry === null
        ? "This invoice has an invalid expiry and cannot be used for payment."
        : "This invoice has expired. Do not pay it again."
  const receiptNotice = (
    <p className="text-xs leading-5 text-[var(--text-secondary)]">
      {autoDetectReceipt
        ? "Waiting for the matching receipt. If your wallet confirms payment, do not pay this invoice again. You can report it to the merchant while detection continues."
        : "No matching receipt has been observed yet. If your wallet confirms payment, do not pay again. Report it to the merchant for verification."}
    </p>
  )
  if (invoiceBlocked) {
    return (
      <section className="rounded-[1.5rem] border border-amber-500/40 bg-amber-500/5 p-5">
        <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
          Invoice unavailable
        </h2>
        <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">
          {invoiceError}
        </p>
        {publicReceiptInvoice && <div className="mt-4">{receiptNotice}</div>}
        {invoiceCanReport && (
          <div className="mt-4 space-y-2">
            <Button
              variant="outline"
              className="h-10 px-4 text-sm"
              disabled={busy}
              onClick={onMarkPaid}
            >
              Report a payment already made
            </Button>
            <p className="text-pretty text-xs text-[var(--text-secondary)]">
              Only report this if your wallet confirms it paid this exact
              invoice before expiry.
            </p>
          </div>
        )}
      </section>
    )
  }
  const canUseInvoice = () => {
    const currentSeconds = Math.floor(Date.now() / 1_000)
    if (invoiceExpiry === null || invoiceExpiry <= currentSeconds) {
      setNowSeconds(currentSeconds)
      return false
    }
    return onBeforeInvoiceUse()
  }
  return (
    <section className="rounded-[1.5rem] border border-amber-500/40 bg-amber-500/5 p-5">
      <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
        {isMerchantInvoice
          ? "Pay merchant invoice"
          : "Pay with an external wallet"}
      </h2>
      <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">
        {publicReceiptInvoice
          ? "Check your wallet first if an automatic payment was already attempted. Otherwise scan or copy this invoice and pay it once. Conduit will keep checking for a public Lightning receipt, and you can report the payment to the merchant directly."
          : isMerchantInvoice
            ? "Scan, copy, or open this merchant invoice. After your wallet confirms payment, report it to the merchant for verification."
            : "Automatic payment did not complete. Check your wallet first, then pay this same invoice once and report it to the merchant for verification. This invoice can only settle once, so paying it again is safe if nothing was sent."}
      </p>
      {guestSession && (
        <p className="mt-3 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
          {publicReceiptInvoice
            ? "Return to this same tab after paying and report it once your wallet confirms. Conduit will keep checking for a receipt while this tab remains open. Closing it ends local access to this guest order."
            : "Keep this tab open until the payment is reported. Closing it ends local access to this guest order. The merchant can use the private recovery contact submitted at checkout."}
        </p>
      )}
      <InvoicePayment
        key={invoice}
        invoice={invoice}
        expectedAmountSats={vm.totalSats}
        preference={pricing.preference}
        quote={pricing.quote}
        guestSession={guestSession}
        onBeforeInvoiceUse={canUseInvoice}
      />
      <div className="mt-4 space-y-3">
        {publicReceiptInvoice && receiptNotice}
        <Button
          variant="primary"
          className="h-10 px-4 text-sm"
          disabled={busy}
          onClick={onMarkPaid}
        >
          Report payment to merchant
        </Button>
        <p className="text-xs text-[var(--text-secondary)]">
          Only report after your wallet confirms payment. This does not verify
          settlement; the merchant will confirm it.
        </p>
      </div>
    </section>
  )
}

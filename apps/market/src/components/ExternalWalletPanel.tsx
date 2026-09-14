import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Copy, ExternalLink } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { normalizeLightningInvoice } from "@conduit/core"
import { Button } from "@conduit/ui"
import type { OrderViewModel } from "../lib/order-view"

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
}) {
  const [copied, setCopied] = useState(false)
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
  const merchantInvoiceExpiry =
    merchantInvoice?.expiresAt ??
    (hasBoundMerchantInvoice ? boundMerchantInvoiceExpiresAt : null)
  useEffect(() => {
    if (merchantInvoiceExpiry === null) return
    const remainingMs = merchantInvoiceExpiry * 1_000 - Date.now()
    const timer = window.setTimeout(
      () => setNowSeconds(Math.floor(Date.now() / 1_000)),
      Math.max(0, Math.min(remainingMs, 2_147_483_647))
    )
    return () => window.clearTimeout(timer)
  }, [merchantInvoiceExpiry, nowSeconds])
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
  const merchantInvoiceExpired =
    isMerchantInvoice &&
    merchantInvoiceExpiry !== null &&
    merchantInvoiceExpiry <= nowSeconds
  const merchantInvoiceBlocked =
    merchantInvoice?.status === "blocked" || merchantInvoiceExpired
  const merchantInvoiceCanReport =
    merchantInvoice?.status === "blocked"
      ? merchantInvoice.canReport
      : merchantInvoiceExpired
  const merchantInvoiceError =
    merchantInvoice?.status === "blocked"
      ? merchantInvoice.reason
      : merchantInvoiceExpired
        ? "The invoice returned by the merchant is already expired."
        : null
  if (merchantInvoiceBlocked) {
    return (
      <section className="rounded-[1.5rem] border border-amber-500/40 bg-amber-500/5 p-5">
        <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
          Invoice unavailable
        </h2>
        <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">
          {merchantInvoiceError}
        </p>
        {merchantInvoiceCanReport && (
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
  const bolt11 = normalizeLightningInvoice(invoice)
  const copy = async () => {
    if (!onBeforeInvoiceUse()) return
    try {
      await navigator.clipboard.writeText(invoice)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <section className="rounded-[1.5rem] border border-amber-500/40 bg-amber-500/5 p-5">
      <h2 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
        {isMerchantInvoice
          ? "Pay merchant invoice"
          : "Pay with an external wallet"}
      </h2>
      <p className="mt-1 text-pretty text-sm text-[var(--text-secondary)]">
        {autoDetectReceipt
          ? "Check your wallet first if an automatic payment was already attempted. Otherwise scan or copy this invoice and pay it once. Conduit will match the public Lightning receipt and notify the merchant automatically."
          : isMerchantInvoice
            ? "Scan, copy, or open this merchant invoice. After your wallet confirms payment, report it to the merchant for verification."
            : "Automatic payment did not complete. Check your wallet first, then pay this same invoice once and report it to the merchant for verification. This invoice can only settle once, so paying it again is safe if nothing was sent."}
      </p>
      {guestSession && (
        <p className="mt-3 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs leading-5 text-warning">
          {autoDetectReceipt
            ? "Return to this same tab after paying so Conduit can finish receipt detection. Closing it ends local access to this guest order."
            : "Keep this tab open until the payment is reported. Closing it ends local access to this guest order. The merchant can use the private recovery contact submitted at checkout."}
        </p>
      )}
      <div className="mt-4 flex flex-col items-start gap-4 sm:flex-row">
        <div className="rounded-xl bg-white p-3">
          <QRCodeSVG value={bolt11} size={156} level="M" />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button asChild className="h-10 px-4 text-sm">
              <a
                href={`lightning:${bolt11}`}
                onClick={(event) => {
                  if (!onBeforeInvoiceUse()) event.preventDefault()
                }}
              >
                <ExternalLink className="h-4 w-4" />
                Open in wallet
              </a>
            </Button>
            <Button
              variant="outline"
              className="h-10 px-4 text-sm"
              onClick={copy}
            >
              <Copy className="h-4 w-4" />
              {copied ? "Copied" : "Copy invoice"}
            </Button>
          </div>
          <div className="max-h-24 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs leading-5 break-all text-[var(--text-secondary)]">
            {invoice}
          </div>
          {autoDetectReceipt ? (
            <p className="text-xs leading-5 text-[var(--text-secondary)]">
              Waiting for the matching receipt. If your wallet confirms payment,
              do not pay this invoice again while detection completes.
            </p>
          ) : (
            <>
              <Button
                variant="primary"
                className="h-10 px-4 text-sm"
                disabled={busy}
                onClick={onMarkPaid}
              >
                Report payment to merchant
              </Button>
              <p className="text-xs text-[var(--text-secondary)]">
                Only report after your wallet confirms payment. This does not
                verify settlement; the merchant will confirm it.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

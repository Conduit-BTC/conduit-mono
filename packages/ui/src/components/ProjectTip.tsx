import { useId, useRef, useState } from "react"
import { Copy, ExternalLink, Heart, QrCode } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  formatApproxUsdFromSats,
  getCashAppLightningUrl,
  decodeLightningInvoiceMetadata,
  isPricingRateQuoteFresh,
  normalizeLightningInvoice,
  PROJECT_TIP_AMOUNTS_SATS,
  PROJECT_TIP_MESSAGE,
  PROJECT_TIP_MIN_SATS,
  validateLightningInvoiceForPayment,
  validateProjectTipAmount,
  type BtcUsdRateQuote,
  type PreparedProjectTip,
} from "@conduit/core"
import { Button } from "./Button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./Dialog"
import { Input } from "./Input"
import { useTimeBoundaryNow } from "../hooks/useTimeBoundaryNow"

export type ProjectTipPayResult =
  | { status: "paid" }
  | { status: "manual"; reason?: string }
  | { status: "ambiguous"; reason: string }

export type ProjectTipProps = {
  prepare: (amountSats: number) => Promise<PreparedProjectTip>
  payInvoice?: (tip: PreparedProjectTip) => Promise<ProjectTipPayResult>
  onOpenChange?: (open: boolean) => void
  onReceiptWatchChange?: (tip: PreparedProjectTip | null) => void
  confirmedZapRequestId?: string | null
  anonymous?: boolean
  rateQuote?: BtcUsdRateQuote | null
  rateIsFetching?: boolean
  onRefreshRate?: () => void
  className?: string
}

export function ProjectTip({
  prepare,
  payInvoice,
  onOpenChange,
  onReceiptWatchChange,
  confirmedZapRequestId = null,
  anonymous = false,
  rateQuote = null,
  rateIsFetching = false,
  onRefreshRate,
  className,
}: ProjectTipProps) {
  const [open, setOpen] = useState(false)
  const [amountInput, setAmountInput] = useState<string>(
    String(PROJECT_TIP_AMOUNTS_SATS[0])
  )
  const [customAmount, setCustomAmount] = useState(false)
  const [tip, setTip] = useState<PreparedProjectTip | null>(null)
  const [phase, setPhase] = useState<
    "select" | "preparing" | "paying" | "manual" | "ambiguous" | "thanks"
  >("select")
  const [error, setError] = useState<string | null>(null)
  const [showQr, setShowQr] = useState(false)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const operationRef = useRef(0)
  const openRef = useRef(false)
  const customAmountId = useId()
  const qrId = useId()
  const invoiceExpiresAt = tip
    ? decodeLightningInvoiceMetadata(tip.invoice).expiresAt
    : null
  const rateExpiresAtMs =
    rateQuote && rateQuote.source !== "env"
      ? rateQuote.fetchedAt + DEFAULT_PRICING_RATE_MAX_AGE_MS + 1
      : null
  const nowMs = useTimeBoundaryNow(
    [
      invoiceExpiresAt === null ? null : invoiceExpiresAt * 1_000,
      rateExpiresAtMs,
    ].filter((boundary): boundary is number => boundary !== null)
  )
  const freshRateQuote = isPricingRateQuoteFresh(
    rateQuote,
    Math.max(nowMs, Date.now())
  )
    ? rateQuote
    : null

  const receiptConfirmed =
    open &&
    tip !== null &&
    (phase === "manual" || phase === "ambiguous") &&
    confirmedZapRequestId === tip.zapRequestId

  function reset() {
    operationRef.current += 1
    openRef.current = false
    onReceiptWatchChange?.(null)
    setOpen(false)
    onOpenChange?.(false)
    setPhase("select")
    setCustomAmount(false)
    setAmountInput(String(PROJECT_TIP_AMOUNTS_SATS[0]))
    setTip(null)
    setError(null)
    setCopyStatus(null)
    setShowQr(false)
  }

  async function submit() {
    const amountSats = Number(amountInput)
    try {
      validateProjectTipAmount(amountSats)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid amount.")
      return
    }
    setError(null)
    onReceiptWatchChange?.(null)
    setTip(null)
    setPhase("preparing")
    const operation = ++operationRef.current
    try {
      const prepared = await prepare(amountSats)
      if (operationRef.current !== operation) return
      setTip(prepared)
      if (!payInvoice) {
        if (openRef.current) onReceiptWatchChange?.(prepared)
        setPhase("manual")
        return
      }
      setPhase("paying")
      let result: ProjectTipPayResult
      try {
        result = await payInvoice(prepared)
      } catch {
        result = {
          status: "ambiguous",
          reason:
            "The wallet did not confirm the result. Check it before trying another payment path.",
        }
      }
      if (operationRef.current !== operation) return
      if (result.status === "paid") {
        onReceiptWatchChange?.(null)
        setPhase("thanks")
      } else if (result.status === "ambiguous") {
        if (openRef.current) onReceiptWatchChange?.(prepared)
        setError(result.reason)
        setPhase("ambiguous")
      } else {
        if (openRef.current) onReceiptWatchChange?.(prepared)
        setError(result.reason ?? null)
        setPhase("manual")
      }
    } catch (cause) {
      if (operationRef.current !== operation) return
      setError(
        cause instanceof Error
          ? cause.message
          : "The tip could not be prepared."
      )
      setPhase("select")
    }
  }

  async function copyInvoice() {
    if (!tip) return
    if (
      !validateLightningInvoiceForPayment({
        invoice: tip.invoice,
        expectedAmountMsats: tip.amountMsats,
      }).ok
    ) {
      setCopyStatus("This invoice expired. Start a new tip.")
      return
    }
    try {
      await navigator.clipboard.writeText(
        normalizeLightningInvoice(tip.invoice)
      )
      setCopyStatus("Invoice copied.")
    } catch {
      setCopyStatus(
        "Copy failed. Select the invoice below to copy it manually."
      )
    }
  }

  const amountSats = Number(amountInput)
  const bolt11 = tip ? normalizeLightningInvoice(tip.invoice) : null
  const invoiceValid =
    tip !== null &&
    validateLightningInvoiceForPayment({
      invoice: tip.invoice,
      expectedAmountMsats: tip.amountMsats,
      nowSeconds: Math.floor(Math.max(nowMs, Date.now()) / 1_000),
    }).ok
  const cashAppUrl = tip
    ? getCashAppLightningUrl(
        tip.invoice,
        tip.amountMsats / 1_000,
        Math.floor(Math.max(nowMs, Date.now()) / 1_000)
      )
    : null

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className={className}
        onClick={() => {
          openRef.current = true
          setOpen(true)
          onOpenChange?.(true)
          if (tip && (phase === "manual" || phase === "ambiguous")) {
            onReceiptWatchChange?.(tip)
          }
        }}
      >
        <Heart
          className="size-5 fill-current text-[var(--project-tip-heart)]"
          aria-hidden="true"
        />
        Leave a Tip
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          openRef.current = next
          setOpen(next)
          onOpenChange?.(next)
          if (!next) onReceiptWatchChange?.(null)
          if (!next && phase === "preparing") {
            operationRef.current += 1
            setPhase("select")
          }
        }}
      >
        <DialogContent>
          <DialogHeader className="flex-row items-start gap-3 space-y-0 text-left">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--project-tip-heart)_14%,transparent)]">
              <Heart
                className="size-6 fill-current text-[var(--project-tip-heart)]"
                aria-hidden="true"
              />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle className="text-balance">Leave a tip</DialogTitle>
              <DialogDescription className="text-pretty">
                Help us build a more open market.
              </DialogDescription>
            </div>
          </DialogHeader>
          {phase === "thanks" || receiptConfirmed ? (
            <div
              role="status"
              className="space-y-3 text-pretty text-sm leading-6"
            >
              <p className="font-semibold text-[var(--text-primary)]">
                Thank you for supporting our mission to build a more open
                market.
              </p>
              <p className="text-[var(--text-secondary)]">
                Your tip helps independent merchants and shoppers connect and
                transact directly.
              </p>
              <Button type="button" onClick={reset}>
                Done
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {phase === "select" && (
                <>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {PROJECT_TIP_AMOUNTS_SATS.map((amount) => (
                      <Button
                        key={amount}
                        type="button"
                        variant={
                          !customAmount && amountInput === String(amount)
                            ? "primary"
                            : "outline"
                        }
                        aria-pressed={
                          !customAmount && amountInput === String(amount)
                        }
                        className="min-h-11 w-full justify-between px-4 py-2 text-sm tabular-nums sm:min-h-14 sm:flex-col sm:justify-center sm:gap-0.5 sm:px-2"
                        onClick={() => {
                          setCustomAmount(false)
                          setAmountInput(String(amount))
                        }}
                      >
                        <span>{amount.toLocaleString()} sats</span>
                        {freshRateQuote && (
                          <span className="text-xs font-normal leading-4">
                            {formatApproxUsdFromSats(amount, freshRateQuote)}
                          </span>
                        )}
                      </Button>
                    ))}
                  </div>
                  {!freshRateQuote && (
                    <div className="flex min-h-11 flex-wrap items-center gap-x-2 text-xs text-[var(--text-secondary)]">
                      <p role="status" className="text-pretty">
                        {rateIsFetching
                          ? "Updating USD estimate…"
                          : "USD estimate unavailable. Sat amounts are exact."}
                      </p>
                      {!rateIsFetching && onRefreshRate && (
                        <Button
                          type="button"
                          variant="link"
                          className="min-h-11 px-1 text-xs"
                          onClick={onRefreshRate}
                        >
                          Retry
                        </Button>
                      )}
                    </div>
                  )}
                  <Button
                    type="button"
                    variant="link"
                    className="min-h-11 px-0 text-sm"
                    aria-expanded={customAmount}
                    aria-controls={customAmountId}
                    onClick={() => {
                      setCustomAmount(!customAmount)
                      setAmountInput(
                        customAmount ? String(PROJECT_TIP_AMOUNTS_SATS[0]) : ""
                      )
                    }}
                  >
                    {customAmount
                      ? "Use a preset amount"
                      : "Choose another amount"}
                  </Button>
                  <div
                    id={customAmountId}
                    hidden={!customAmount}
                    className="space-y-1"
                  >
                    <label className="block space-y-1 text-sm text-[var(--text-primary)]">
                      <span>Custom amount (sats)</span>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={PROJECT_TIP_MIN_SATS}
                        step="1"
                        value={amountInput}
                        onChange={(event) => setAmountInput(event.target.value)}
                      />
                    </label>
                    {freshRateQuote &&
                      Number.isSafeInteger(amountSats) &&
                      amountSats >= PROJECT_TIP_MIN_SATS && (
                        <p className="text-xs text-[var(--text-secondary)]">
                          {formatApproxUsdFromSats(amountSats, freshRateQuote)}
                        </p>
                      )}
                  </div>
                  <Button
                    type="button"
                    className="h-11 w-full tabular-nums"
                    onClick={() => void submit()}
                    disabled={
                      !Number.isSafeInteger(amountSats) ||
                      amountSats < PROJECT_TIP_MIN_SATS
                    }
                  >
                    Send{" "}
                    {Number.isSafeInteger(amountSats) &&
                    amountSats >= PROJECT_TIP_MIN_SATS
                      ? `${amountSats.toLocaleString()} sats`
                      : "tip"}
                  </Button>
                </>
              )}
              {(phase === "preparing" || phase === "paying") && (
                <p
                  role="status"
                  className="text-sm text-[var(--text-secondary)]"
                >
                  {phase === "preparing"
                    ? "Preparing your zap invoice…"
                    : "Sending payment through your connected wallet…"}
                </p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {phase === "ambiguous" && (
                <p className="text-sm text-[var(--text-secondary)]">
                  Check your wallet before trying another payment path. We’ll
                  keep looking for the matching zap receipt.
                </p>
              )}
              {phase === "manual" && tip && bolt11 && (
                <div className="space-y-3">
                  <p className="text-sm text-[var(--text-secondary)]">
                    Invoice ready. Payment is not yet confirmed. We’ll show a
                    thank-you when its matching zap receipt appears.
                  </p>
                  {invoiceValid ? (
                    <>
                      {cashAppUrl && (
                        <Button
                          asChild
                          className="h-12 w-full bg-[var(--cash-app-green)] text-[var(--neutral-950)] hover:opacity-90"
                        >
                          <a
                            href={cashAppUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                            onClick={(event) => {
                              if (
                                !validateLightningInvoiceForPayment({
                                  invoice: tip.invoice,
                                  expectedAmountMsats: tip.amountMsats,
                                }).ok
                              )
                                event.preventDefault()
                            }}
                          >
                            Pay with Cash App{" "}
                            <ExternalLink className="size-4" />
                          </a>
                        </Button>
                      )}
                      <Button asChild variant="outline" className="h-12 w-full">
                        <a
                          href={`lightning:${bolt11}`}
                          onClick={(event) => {
                            if (
                              !validateLightningInvoiceForPayment({
                                invoice: tip.invoice,
                                expectedAmountMsats: tip.amountMsats,
                              }).ok
                            )
                              event.preventDefault()
                          }}
                        >
                          <ExternalLink className="size-4" />
                          Open Lightning wallet
                        </a>
                      </Button>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void copyInvoice()}
                        >
                          <Copy className="size-4" />
                          Copy invoice
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          aria-expanded={showQr}
                          aria-controls={qrId}
                          onClick={() => setShowQr(!showQr)}
                        >
                          <QrCode className="size-4" />
                          {showQr ? "Hide QR" : "Show QR"}
                        </Button>
                      </div>
                      {copyStatus && (
                        <p
                          role="status"
                          className="text-xs text-[var(--text-secondary)]"
                        >
                          {copyStatus}
                        </p>
                      )}
                      {showQr && (
                        <div
                          id={qrId}
                          className="mx-auto w-fit rounded-xl bg-white p-3"
                        >
                          <QRCodeSVG
                            value={bolt11}
                            size={156}
                            level="M"
                            title="Lightning invoice"
                          />
                        </div>
                      )}
                      <details className="text-xs text-[var(--text-secondary)]">
                        <summary className="cursor-pointer py-2">
                          Payment details
                        </summary>
                        <p className="select-all break-all rounded-xl bg-[var(--surface)] p-3 font-mono">
                          {bolt11}
                        </p>
                      </details>
                    </>
                  ) : (
                    <div className="space-y-2">
                      <p role="alert" className="text-sm text-destructive">
                        The invoice expired or no longer matches this tip.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          onReceiptWatchChange?.(null)
                          setTip(null)
                          setPhase("select")
                          setError(null)
                        }}
                      >
                        Start a new tip
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <div className="space-y-1 text-xs text-[var(--text-secondary)]">
                <p>
                  A public zap to Conduit · Signed{" "}
                  {anonymous
                    ? "as Anon Conduit Shopper"
                    : "with your Nostr account"}
                </p>
                <details>
                  <summary className="w-fit cursor-pointer py-1 text-primary-400 underline-offset-4 hover:underline">
                    What gets posted?
                  </summary>
                  <p className="text-pretty">
                    Your public note: “{PROJECT_TIP_MESSAGE}” Tips are separate
                    from orders.
                  </p>
                </details>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

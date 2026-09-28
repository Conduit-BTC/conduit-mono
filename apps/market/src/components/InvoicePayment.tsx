import { useId, useState } from "react"
import { Copy, ExternalLink, QrCode } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import {
  DEFAULT_PRICING_RATE_MAX_AGE_MS,
  decodeLightningInvoiceMetadata,
  formatBitcoinBaseUnits,
  getShopperSatsDisplay,
  normalizeLightningInvoice,
  type BtcUsdRateQuote,
  type ShopperPricePreference,
} from "@conduit/core"
import { Button, useTimeBoundaryNow } from "@conduit/ui"
import cashAppLogo from "../assets/cash-app.svg"
import { getCashAppLightningUrl } from "../lib/cash-app-lightning"

export function InvoicePayment({
  invoice,
  expectedAmountSats,
  preference,
  quote,
  guestSession,
  onBeforeInvoiceUse,
}: {
  invoice: string
  expectedAmountSats: number | null
  preference: ShopperPricePreference
  quote: BtcUsdRateQuote | null
  guestSession: boolean
  onBeforeInvoiceUse: () => boolean
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [showQr, setShowQr] = useState(false)
  const qrId = useId()
  const bolt11 = normalizeLightningInvoice(invoice)
  const metadata = decodeLightningInvoiceMetadata(invoice)
  const nowMs = useTimeBoundaryNow([
    ...(metadata.expiresAt === null ? [] : [metadata.expiresAt * 1_000]),
    ...(quote ? [quote.fetchedAt + DEFAULT_PRICING_RATE_MAX_AGE_MS + 1] : []),
  ])
  const cashAppUrl = getCashAppLightningUrl(
    invoice,
    expectedAmountSats,
    Math.floor(Math.max(nowMs, Date.now()) / 1_000)
  )
  const sats = metadata.msats === null ? null : metadata.msats / 1_000
  const exactAmount =
    sats === null ? null : formatBitcoinBaseUnits(sats, "sats")
  const display =
    sats === null
      ? null
      : getShopperSatsDisplay(
          sats,
          guestSession ? { currency: "USD", bitcoinUnit: "sats" } : preference,
          quote,
          { nowMs: Math.max(nowMs, Date.now()) }
        )
  const estimated = display?.state === "ready" && display.approximate
  const primaryAmount =
    display?.state === "ready" ? display.primary : exactAmount

  async function copyInvoice() {
    if (!onBeforeInvoiceUse()) return
    try {
      await navigator.clipboard.writeText(bolt11)
      setCopyStatus("Invoice copied.")
    } catch {
      setCopyStatus(
        "Could not copy. Select the invoice in Payment details and copy it manually."
      )
    }
  }

  return (
    <div className="mt-5 min-w-0 space-y-4">
      {primaryAmount && (
        <div>
          <p className="text-sm text-[var(--text-secondary)]">
            {estimated ? "Estimated payment" : "Amount to pay"}
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
            {primaryAmount}
          </p>
        </div>
      )}
      <div className="min-w-0 space-y-3">
        {cashAppUrl && (
          <>
            <Button
              asChild
              className="h-12 w-full bg-[var(--cash-app-green)] text-[var(--neutral-950)] hover:bg-[var(--cash-app-green)] hover:opacity-90"
            >
              <a
                href={cashAppUrl}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                onClick={(event) => {
                  if (
                    !getCashAppLightningUrl(invoice, expectedAmountSats) ||
                    !onBeforeInvoiceUse()
                  )
                    event.preventDefault()
                }}
              >
                <img src={cashAppLogo} alt="" className="h-6 w-6" />
                Pay with Cash App
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
            <details className="text-xs leading-5 text-[var(--text-secondary)]">
              <summary className="cursor-pointer py-1">
                Cash App didn’t open?
              </summary>
              <p>
                Try Open Lightning wallet or copy the invoice. Cash App must be
                installed and Lightning payments available for your account.
              </p>
            </details>
          </>
        )}
        <Button asChild variant="outline" className="h-12 w-full">
          <a
            href={`lightning:${bolt11}`}
            onClick={(event) => {
              if (!onBeforeInvoiceUse()) event.preventDefault()
            }}
          >
            <ExternalLink className="h-4 w-4" />
            Open Lightning wallet
          </a>
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            className="h-11 min-w-0 px-3"
            onClick={() => void copyInvoice()}
          >
            <Copy className="h-4 w-4" />
            Copy invoice
          </Button>
          <Button
            variant="outline"
            className="h-11 min-w-0 px-3"
            aria-expanded={showQr}
            aria-controls={qrId}
            onClick={() => setShowQr(!showQr)}
          >
            <QrCode className="h-4 w-4" />
            {showQr ? "Hide QR code" : "Show QR code"}
          </Button>
        </div>
        {copyStatus && (
          <p
            role="status"
            className="text-pretty text-xs text-[var(--text-secondary)]"
          >
            {copyStatus}
          </p>
        )}
        {showQr && (
          <div id={qrId} className="mx-auto w-fit rounded-xl bg-white p-3">
            <QRCodeSVG
              value={bolt11}
              size={156}
              level="M"
              title="Lightning invoice"
            />
          </div>
        )}
      </div>
      <details className="border-t border-[var(--border)] pt-2 text-sm text-[var(--text-secondary)]">
        <summary className="cursor-pointer py-2">Payment details</summary>
        {exactAmount && <p className="py-2">Invoice amount: {exactAmount}</p>}
        <p className="mb-2 text-xs">Payment network: Lightning</p>
        <p className="select-all break-all rounded-xl bg-[var(--surface)] p-3 font-mono text-xs leading-5">
          {bolt11}
        </p>
      </details>
    </div>
  )
}

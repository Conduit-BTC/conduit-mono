import { useEffect, useState } from "react"
import {
  AlertTriangle,
  CalendarDays,
  MapPin,
  Printer,
  RefreshCw,
} from "lucide-react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  QRCodeSVG,
} from "@conduit/ui"
import {
  getEventSignEvidenceNotice,
  getEventSignImageFallback,
  type EventQrSignSheet,
} from "../lib/event-signage"
import type { MerchantOrganizerEventMarketState } from "../lib/event-market"

function DecorativeImage({
  src,
  alt,
  className,
  fallback,
  fallbackClassName,
}: {
  src?: string
  alt: string
  className: string
  fallback: string
  fallbackClassName: string
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showImage = !!src && failedSrc !== src

  return showImage ? (
    <img
      src={src}
      alt={alt}
      className={className}
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
    />
  ) : (
    <div
      className={fallbackClassName}
      data-testid="event-sign-image-fallback"
      aria-hidden="true"
    >
      {fallback}
    </div>
  )
}

export function PrintableEventQrSign({ sheet }: { sheet: EventQrSignSheet }) {
  const merchant = sheet.merchant

  return (
    <article
      className="event-sign-sheet flex w-full max-w-[8.5in] flex-col overflow-hidden bg-white text-neutral-950 shadow-xl"
      data-testid="event-sign-sheet"
      data-event-sign-kind={sheet.kind}
      data-qr-value={sheet.qrValue}
    >
      <header className="event-sign-brand flex items-center justify-between gap-6 border-b-4 border-primary-500 px-10 py-6">
        <img
          src="/images/logo/logo-full.svg"
          alt="Conduit"
          className="h-auto w-44"
        />
        <span className="text-lg font-semibold text-primary-700">
          conduit.market
        </span>
      </header>

      <DecorativeImage
        src={sheet.bannerUrl}
        alt=""
        className="event-sign-banner h-40 w-full bg-neutral-950 object-contain"
        fallback={getEventSignImageFallback(sheet.eventTitle)}
        fallbackClassName="event-sign-banner flex h-40 w-full items-center justify-center bg-primary-50 font-display text-7xl font-semibold text-primary-700"
      />

      <div className="event-sign-body flex flex-1 flex-col items-center px-12 py-8 text-center">
        {merchant ? (
          <div className="mb-5 flex max-w-full items-center justify-center gap-4">
            <DecorativeImage
              src={merchant.imageUrl}
              alt=""
              className="event-sign-avatar size-20 rounded-full border-2 border-primary-500 object-cover"
              fallback={merchant.fallback}
              fallbackClassName="event-sign-avatar flex size-20 shrink-0 items-center justify-center rounded-full border-2 border-primary-500 bg-primary-50 text-2xl font-semibold text-primary-800"
            />
            <div className="min-w-0 text-left">
              <p className="text-pretty text-sm font-semibold text-primary-700">
                Shop this merchant at the event
              </p>
              <h2 className="text-balance break-words font-display text-3xl font-semibold leading-tight text-neutral-950">
                {merchant.name}
              </h2>
            </div>
          </div>
        ) : (
          <p className="mb-3 text-pretty text-base font-semibold text-primary-700">
            Shop the event
          </p>
        )}

        <h1 className="max-w-2xl text-balance break-words font-display text-4xl font-semibold leading-tight text-neutral-950">
          {sheet.eventTitle}
        </h1>

        <dl className="mt-5 grid w-full max-w-2xl gap-3 text-left text-base">
          <div className="flex items-start gap-3 rounded-xl bg-neutral-100 px-4 py-3">
            <CalendarDays
              className="mt-0.5 size-5 shrink-0 text-primary-700"
              aria-hidden="true"
            />
            <div>
              <dt className="font-semibold text-neutral-950">When</dt>
              <dd className="text-pretty leading-6 text-neutral-700">
                {sheet.schedule}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl bg-neutral-100 px-4 py-3">
            <MapPin
              className="mt-0.5 size-5 shrink-0 text-primary-700"
              aria-hidden="true"
            />
            <div>
              <dt className="font-semibold text-neutral-950">Where</dt>
              <dd className="text-pretty leading-6 text-neutral-700">
                {sheet.location}
              </dd>
            </div>
          </div>
        </dl>

        <div
          className="event-sign-qr-frame mt-6 size-[19rem] max-w-full rounded-2xl border-2 border-neutral-950 bg-white p-5"
          role="img"
          aria-label={
            merchant
              ? `${merchant.name} event catalog QR code`
              : "Event catalog QR code"
          }
        >
          <QRCodeSVG
            value={sheet.qrValue}
            size={272}
            level="M"
            marginSize={4}
            className="size-full"
          />
        </div>

        <p className="mt-5 max-w-xl text-balance font-display text-2xl font-semibold text-neutral-950">
          Scan to shop on conduit.market
        </p>
        <p className="mt-2 max-w-xl text-pretty text-sm leading-6 text-neutral-600">
          Scan for current availability and event details. Listings and event
          participation can change.
        </p>
      </div>
    </article>
  )
}

export function EventQrPrintPages({
  sheets,
}: {
  sheets: readonly EventQrSignSheet[]
}) {
  return (
    <div
      className="event-sign-print-pages grid justify-items-center gap-6 bg-[var(--background)] p-4 sm:p-6"
      data-event-sign-page-count={sheets.length}
    >
      {sheets.map((sheet) => (
        <PrintableEventQrSign key={sheet.id} sheet={sheet} />
      ))}
    </div>
  )
}

export function EventQrPrintPreview({
  open,
  onOpenChange,
  title,
  sheets,
  eventState,
  refreshing,
  onRefresh,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  sheets: readonly EventQrSignSheet[]
  eventState: MerchantOrganizerEventMarketState
  refreshing: boolean
  onRefresh: () => void | Promise<void>
}) {
  const batch = sheets.length > 1
  const evidenceNotice = getEventSignEvidenceNotice(eventState, batch)

  useEffect(() => {
    if (!open) return
    document.body.classList.add("event-sign-print-preview-open")
    return () => {
      document.body.classList.remove("event-sign-print-preview-open")
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="event-sign-print-dialog max-w-[min(72rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0"
        data-testid="event-sign-print-preview"
        data-event-sign-print-root
      >
        <div className="event-sign-print-controls space-y-4 border-b border-[var(--border)] bg-[var(--surface-dialog)] p-6 pr-14">
          <DialogHeader>
            <DialogTitle className="text-balance">{title}</DialogTitle>
            <DialogDescription className="text-pretty leading-6">
              Review each US Letter portrait page, then use your browser’s
              native print dialog to print or save a PDF.
            </DialogDescription>
          </DialogHeader>

          {evidenceNotice ? (
            <div
              className="flex gap-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3 text-[var(--text-primary)]"
              role="status"
              data-testid="event-sign-evidence-notice"
            >
              <AlertTriangle
                className="mt-0.5 size-5 shrink-0 text-[var(--warning)]"
                aria-hidden="true"
              />
              <div>
                <p className="font-semibold">{evidenceNotice.title}</p>
                <p className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
                  {evidenceNotice.message}
                </p>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={refreshing}
              onClick={() => void onRefresh()}
            >
              <RefreshCw
                className={refreshing ? "size-4 animate-spin" : "size-4"}
                aria-hidden="true"
              />
              Refresh evidence
            </Button>
            <Button
              type="button"
              disabled={sheets.length === 0}
              onClick={() => window.print()}
            >
              <Printer className="size-4" aria-hidden="true" />
              Print / Save as PDF
            </Button>
          </div>
        </div>

        {sheets.length > 0 ? (
          <EventQrPrintPages sheets={sheets} />
        ) : (
          <div className="event-sign-print-controls p-8 text-center">
            <p className="text-pretty text-sm text-[var(--text-secondary)]">
              This sign is no longer eligible. Close the preview and refresh the
              event before trying again.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

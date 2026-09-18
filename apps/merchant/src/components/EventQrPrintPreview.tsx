import { Component, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  CalendarDays,
  MapPin,
  Printer,
  RefreshCw,
  X,
} from "lucide-react"
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  QRCodeSVG,
} from "@conduit/ui"
import {
  getEventSignEvidenceNotice,
  getEventSignImageFallback,
  isEventSignQrValueWithinBudget,
  type EventQrSignSheet,
} from "../lib/event-signage"
import type { MerchantOrganizerEventMarketState } from "../lib/event-market"

const LETTER_WIDTH_PX = 816
const LETTER_HEIGHT_PX = 1_056

class PrintableQrCode extends Component<
  { value: string; label: string },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true }
  }

  componentDidUpdate(
    previousProps: Readonly<{ value: string; label: string }>
  ) {
    if (previousProps.value !== this.props.value && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render() {
    if (
      this.state.failed ||
      !isEventSignQrValueWithinBudget(this.props.value)
    ) {
      return (
        <div
          className="flex size-full items-center justify-center p-6 text-center text-base font-semibold text-neutral-700"
          data-testid="event-sign-qr-fallback"
          role="alert"
        >
          QR code unavailable. Visit conduit.market to find this event.
        </div>
      )
    }

    return (
      <div className="size-full" role="img" aria-label={this.props.label}>
        <QRCodeSVG
          value={this.props.value}
          size={272}
          level="M"
          marginSize={4}
          className="size-full"
        />
      </div>
    )
  }
}

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
  const stageRef = useRef<HTMLDivElement>(null)
  const [screenScale, setScreenScale] = useState(1)

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const updateScale = () => {
      const width = stage.getBoundingClientRect().width
      if (width <= 0) return
      const nextScale = Math.min(width / LETTER_WIDTH_PX, 1)
      setScreenScale((currentScale) =>
        Math.abs(currentScale - nextScale) < 0.001 ? currentScale : nextScale
      )
    }

    updateScale()
    const observer = new ResizeObserver(updateScale)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={stageRef}
      className="event-sign-sheet-stage w-full max-w-[8.5in] overflow-hidden"
      style={{ height: LETTER_HEIGHT_PX * screenScale }}
      data-testid="event-sign-sheet-stage"
    >
      <article
        className="event-sign-sheet flex h-[11in] w-[8.5in] origin-top-left flex-col overflow-hidden bg-white text-neutral-950 shadow-xl"
        style={{ transform: `scale(${screenScale})` }}
        data-testid="event-sign-sheet"
        data-event-sign-kind={sheet.kind}
        data-qr-value={sheet.qrValue}
      >
        <header className="event-sign-brand flex items-center justify-between gap-6 border-b-4 border-primary-500 px-10 py-4">
          <img
            src="/images/logo/logo-full.svg"
            alt="Conduit"
            className="h-auto w-40"
          />
          <span className="text-lg font-semibold text-primary-700">
            https://conduit.market
          </span>
        </header>

        {!merchant ? (
          <DecorativeImage
            src={sheet.bannerUrl}
            alt=""
            className="event-sign-banner aspect-[3/1] w-full shrink-0 bg-neutral-950 object-cover"
            fallback={getEventSignImageFallback(sheet.eventTitle)}
            fallbackClassName="event-sign-banner flex aspect-[3/1] w-full shrink-0 items-center justify-center bg-primary-50 font-display text-7xl font-semibold text-primary-700"
          />
        ) : null}

        <div className="event-sign-body flex flex-1 flex-col items-center px-12 pt-3 pb-2 text-center">
          <h1
            className={`event-sign-event-title max-w-2xl break-words font-display font-semibold leading-tight text-neutral-950 ${merchant ? "line-clamp-1 text-2xl" : "line-clamp-2 text-4xl"}`}
          >
            {sheet.eventTitle}
          </h1>

          <dl className="mt-3 grid w-full max-w-2xl grid-cols-2 gap-3 text-left text-sm">
            <div className="flex items-start gap-3 rounded-xl bg-neutral-100 px-4 py-2">
              <CalendarDays
                className="mt-0.5 size-5 shrink-0 text-primary-700"
                aria-hidden="true"
              />
              <div>
                <dt className="font-semibold text-neutral-950">When</dt>
                <dd className="event-sign-schedule line-clamp-2 break-words leading-5 text-neutral-700">
                  {sheet.schedule}
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl bg-neutral-100 px-4 py-2">
              <MapPin
                className="mt-0.5 size-5 shrink-0 text-primary-700"
                aria-hidden="true"
              />
              <div>
                <dt className="font-semibold text-neutral-950">Where</dt>
                <dd className="event-sign-location line-clamp-2 break-words leading-5 text-neutral-700">
                  {sheet.location}
                </dd>
              </div>
            </div>
          </dl>

          {merchant ? (
            <div className="event-sign-merchant-lockup -mx-12 mt-3 w-[calc(100%+6rem)] overflow-hidden bg-white text-left">
              <DecorativeImage
                src={merchant.bannerUrl}
                alt=""
                className="event-sign-banner event-sign-merchant-banner aspect-[3/1] w-full bg-neutral-900 object-cover"
                fallback=""
                fallbackClassName="event-sign-banner event-sign-merchant-banner aspect-[3/1] w-full bg-gradient-to-r from-neutral-900 via-neutral-700 to-neutral-600"
              />
              <div className="relative flex h-32 items-center bg-neutral-100 pr-10 pl-64">
                <DecorativeImage
                  src={merchant.imageUrl}
                  alt=""
                  className="event-sign-avatar absolute bottom-4 left-10 size-44 shrink-0 rounded-full border-8 border-neutral-100 bg-white object-cover shadow-lg"
                  fallback={merchant.fallback}
                  fallbackClassName="event-sign-avatar absolute bottom-4 left-10 flex size-44 shrink-0 items-center justify-center rounded-full border-8 border-neutral-100 bg-neutral-900 text-5xl font-semibold text-white shadow-lg"
                />
                <h2 className="event-sign-merchant-name line-clamp-2 break-words font-display text-[3.5rem] font-semibold leading-[1.02] text-neutral-950">
                  {merchant.name}
                </h2>
              </div>
            </div>
          ) : null}

          <div className="event-sign-qr-frame mt-2.5 size-[18.75rem] shrink-0 rounded-2xl border-2 border-neutral-950 bg-white p-5">
            <PrintableQrCode
              value={sheet.qrValue}
              label={
                merchant
                  ? `${merchant.name} event catalog QR code`
                  : "Event catalog QR code"
              }
            />
          </div>

          <p className="event-sign-scan-heading mt-2 max-w-xl text-balance font-display text-2xl font-semibold text-neutral-950">
            {merchant ? "Scan to shop this merchant" : "Scan to shop the event"}
          </p>
          <p className="event-sign-scan-copy max-w-xl text-pretty text-sm leading-5 text-neutral-600">
            Scan for current availability and event details.
          </p>
        </div>
      </article>
    </div>
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
        className="event-sign-print-dialog max-w-[min(72rem,calc(100vw-2rem))] translate-x-0 translate-y-0 gap-0 p-0"
        data-testid="event-sign-print-preview"
        data-event-sign-print-root
        showCloseButton={false}
      >
        <div className="event-sign-print-controls space-y-4 border-b border-[var(--border)] bg-[var(--surface-dialog)] p-6">
          <div className="flex items-start justify-between gap-4">
            <DialogHeader>
              <DialogTitle className="text-balance">{title}</DialogTitle>
              <DialogDescription className="text-pretty leading-6">
                Review each US Letter portrait page, then use your browser’s
                native print dialog to print or save a PDF.
              </DialogDescription>
            </DialogHeader>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label="Close"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </DialogClose>
          </div>

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

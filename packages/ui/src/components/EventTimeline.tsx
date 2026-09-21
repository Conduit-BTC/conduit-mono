import { useId, useState, type ReactNode, type Ref } from "react"
import { ImageOff } from "lucide-react"
import { normalizePublicMediaUrl } from "@conduit/core"
import { Button } from "./Button"
import { cn } from "../utils"

export interface EventTimelineDateParts {
  dateTime: string
  day: string
  month: string
  year: string
}

export interface EventTimelineEntryProps {
  date: EventTimelineDateParts
  imageUrl?: string | null
  onOpen: () => void
  organizerName: string
  organizerPending?: boolean
  schedule: string
  title: string
}

export function EventTimelineEntry({
  date,
  imageUrl,
  onOpen,
  organizerName,
  organizerPending = false,
  schedule,
  title,
}: EventTimelineEntryProps) {
  const normalizedImageUrl = normalizePublicMediaUrl(imageUrl ?? undefined)
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  const showImage =
    !!normalizedImageUrl && normalizedImageUrl !== failedImageUrl

  return (
    <li className="grid grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] gap-x-2 pb-5 sm:grid-cols-[5.5rem_1rem_minmax(0,1fr)] sm:gap-x-4">
      <time
        dateTime={date.dateTime || undefined}
        className="flex flex-col items-end pt-3 text-right text-[var(--text-secondary)]"
      >
        <span className="text-xs font-medium">{date.month}</span>
        <span className="text-xl font-semibold tabular-nums leading-none text-[var(--text-primary)] sm:text-2xl">
          {date.day}
        </span>
        <span className="mt-1 text-xs tabular-nums text-[var(--text-muted)]">
          {date.year}
        </span>
      </time>

      <span className="relative" aria-hidden="true">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border)]" />
        <span className="absolute left-1/2 top-5 size-2 -translate-x-1/2 rounded-full border-2 border-[var(--background)] bg-primary-500 ring-1 ring-[var(--border)]" />
      </span>

      <button
        type="button"
        aria-label={`Open ${title}. ${schedule}. Organized by ${organizerName}.`}
        onClick={onOpen}
        className="group min-w-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-left text-[var(--text-primary)] shadow-sm outline-none hover:border-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]"
      >
        <span className="relative block aspect-[3/1] overflow-hidden border-b border-[var(--border)] bg-[var(--surface-elevated)]">
          {showImage ? (
            <img
              src={normalizedImageUrl}
              alt=""
              width={1200}
              height={400}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="size-full object-cover"
              onError={() => setFailedImageUrl(normalizedImageUrl)}
            />
          ) : (
            <span className="flex size-full items-center justify-center text-[var(--text-muted)]">
              <ImageOff className="size-5" aria-hidden="true" />
            </span>
          )}
        </span>

        <span className="block space-y-2 p-4">
          <span className="block text-balance font-heading text-lg font-semibold leading-snug sm:text-xl">
            {title}
          </span>
          <span
            className={cn(
              "block truncate text-sm text-[var(--text-muted)]",
              organizerPending && "italic"
            )}
          >
            Organized by {organizerName}
          </span>
        </span>
      </button>
    </li>
  )
}

export function EventTimelineLoading({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-5" role="status" aria-label="Loading events">
      <span className="sr-only">Loading events</span>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[5.5rem_1rem_minmax(0,1fr)] sm:gap-x-4"
          aria-hidden="true"
        >
          <div className="h-14 rounded-lg bg-[var(--surface-elevated)]" />
          <div className="relative">
            <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--border)]" />
          </div>
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="aspect-[3/1] bg-[var(--surface-elevated)]" />
            <div className="space-y-3 p-4">
              <div className="h-5 w-2/3 rounded bg-[var(--surface-elevated)]" />
              <div className="h-4 w-1/2 rounded bg-[var(--surface-elevated)]" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export interface EventTimelineViewportProps {
  busy?: boolean
  currentAndFutureEvents: ReactNode
  hiddenEarlierCount: number
  hiddenLaterCount: number
  nowAnchorRef: Ref<HTMLDivElement>
  onLoadEarlier: () => void
  onLoadLater: () => void
  pageSize: number
  pastEvents: ReactNode
  viewportRef: Ref<HTMLDivElement>
}

function paginationControlLabel(
  direction: "earlier" | "later",
  hiddenCount: number,
  pageSize: number
): string {
  const count = Math.min(hiddenCount, pageSize)
  return `Load ${count} ${direction} ${count === 1 ? "event" : "events"}`
}

export function EventTimelineViewport({
  busy = false,
  currentAndFutureEvents,
  hiddenEarlierCount,
  hiddenLaterCount,
  nowAnchorRef,
  onLoadEarlier,
  onLoadLater,
  pageSize,
  pastEvents,
  viewportRef,
}: EventTimelineViewportProps) {
  const timelineId = useId()

  return (
    <div
      ref={viewportRef}
      id={`${timelineId}-results`}
      role="region"
      aria-label="Chronological events"
      tabIndex={0}
      className="max-h-[70dvh] overflow-y-auto overscroll-contain rounded-2xl border border-[var(--border)] bg-[var(--background)] px-3 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] sm:px-5"
      aria-busy={busy}
    >
      {hiddenEarlierCount > 0 ? (
        <div className="grid grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] gap-x-2 pb-4 sm:grid-cols-[5.5rem_1rem_minmax(0,1fr)] sm:gap-x-4">
          <span />
          <span className="relative" aria-hidden="true">
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border)]" />
          </span>
          <div className="flex justify-center sm:justify-start">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-controls={`${timelineId}-past-events`}
              onClick={onLoadEarlier}
            >
              {paginationControlLabel("earlier", hiddenEarlierCount, pageSize)}
            </Button>
          </div>
        </div>
      ) : null}

      <ol id={`${timelineId}-past-events`} aria-label="Past events">
        {pastEvents}
      </ol>

      <div
        ref={nowAnchorRef}
        id={`${timelineId}-now`}
        role="separator"
        aria-label="Now"
        className="grid grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] gap-x-2 py-2 sm:grid-cols-[5.5rem_1rem_minmax(0,1fr)] sm:gap-x-4"
      >
        <span className="self-center text-right text-sm font-semibold text-primary-500">
          Now
        </span>
        <span className="relative min-h-8" aria-hidden="true">
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary-500" />
          <span className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--background)] bg-primary-500 ring-1 ring-primary-500" />
        </span>
        <span
          className="self-center h-px bg-primary-500/50"
          aria-hidden="true"
        />
      </div>

      <ol
        id={`${timelineId}-current-and-future-events`}
        aria-label="Current and upcoming events"
      >
        {currentAndFutureEvents}
      </ol>

      {hiddenLaterCount > 0 ? (
        <div className="grid grid-cols-[3.5rem_0.75rem_minmax(0,1fr)] gap-x-2 pt-1 sm:grid-cols-[5.5rem_1rem_minmax(0,1fr)] sm:gap-x-4">
          <span />
          <span className="relative" aria-hidden="true">
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--border)]" />
          </span>
          <div className="flex justify-center sm:justify-start">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-controls={`${timelineId}-current-and-future-events`}
              onClick={onLoadLater}
            >
              {paginationControlLabel("later", hiddenLaterCount, pageSize)}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

import { useState } from "react"
import { ImageOff } from "lucide-react"
import { normalizePublicMediaUrl } from "@conduit/core"
import { cn } from "@conduit/ui"
import type { MerchantOrganizerEventMarket } from "../lib/event-market"
import {
  formatMerchantEventTimelineSchedule,
  getMerchantEventTimelineDateParts,
} from "../lib/merchant-event-timeline"

export interface MerchantEventTimelineEntryProps {
  market: MerchantOrganizerEventMarket
  organizerName: string
  organizerPending?: boolean
  onOpen: () => void
}

export function MerchantEventTimelineEntry({
  market,
  organizerName,
  organizerPending = false,
  onOpen,
}: MerchantEventTimelineEntryProps) {
  const normalizedImageUrl = normalizePublicMediaUrl(market.imageUrl)
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null)
  const showImage =
    !!normalizedImageUrl && normalizedImageUrl !== failedImageUrl
  const schedule = formatMerchantEventTimelineSchedule(market)
  const date = getMerchantEventTimelineDateParts(market)

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
        aria-label={`Open ${market.title}. ${schedule}. Organized by ${organizerName}.`}
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
            {market.title}
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

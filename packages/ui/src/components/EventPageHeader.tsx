import { type ReactNode, useId, useState } from "react"
import { CalendarDays, ChevronDown, MapPin } from "lucide-react"
import { normalizePublicMediaUrl } from "@conduit/core"
import { Button } from "./Button"
import { ShareLinkButton } from "./ShareLinkButton"
import { cn } from "../utils"

export interface EventPageHeaderProps {
  title: string
  summary?: string | null
  imageUrl?: string | null
  imageAlt?: string
  schedule: ReactNode
  location: ReactNode
  organizer: ReactNode
  actions?: ReactNode
  shareUrl?: string
  shareTitle?: string
  shareLabel?: string
  children?: ReactNode
  className?: string
}

export function EventPageHeader({
  title,
  summary,
  imageUrl,
  imageAlt,
  schedule,
  location,
  organizer,
  actions,
  shareUrl,
  shareTitle,
  shareLabel = "Share event",
  children,
  className,
}: EventPageHeaderProps) {
  const [aboutOpen, setAboutOpen] = useState(false)
  const summaryId = useId()
  const normalizedImageUrl = normalizePublicMediaUrl(imageUrl ?? undefined)

  return (
    <header className={cn("space-y-3", className)}>
      {normalizedImageUrl ? (
        <img
          src={normalizedImageUrl}
          alt={imageAlt ?? `${title} banner`}
          width={1200}
          height={400}
          referrerPolicy="no-referrer"
          className="aspect-[3/1] w-full rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] object-contain"
        />
      ) : null}

      <h1 className="min-w-0 break-words text-balance text-3xl font-semibold text-[var(--text-primary)] sm:text-4xl">
        {title}
      </h1>

      {summary || actions || shareUrl ? (
        <div className="flex flex-wrap items-center gap-2">
          {summary ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={aboutOpen}
              aria-controls={summaryId}
              onClick={() => setAboutOpen((open) => !open)}
            >
              About
              <ChevronDown
                aria-hidden="true"
                className={cn("size-4", aboutOpen && "rotate-180")}
              />
            </Button>
          ) : null}
          {actions}
          {shareUrl ? (
            <ShareLinkButton
              url={shareUrl}
              shareTitle={shareTitle ?? title}
              idleLabel={shareLabel}
              size="sm"
              variant="outline"
            />
          ) : null}
        </div>
      ) : null}

      {summary && aboutOpen ? (
        <p
          id={summaryId}
          className="max-w-3xl whitespace-pre-wrap text-pretty text-sm leading-6 text-[var(--text-secondary)]"
        >
          {summary}
        </p>
      ) : null}

      <dl className="flex flex-col gap-x-6 gap-y-2 text-sm text-[var(--text-secondary)] sm:flex-row sm:flex-wrap">
        <div className="flex min-w-0 items-start gap-2">
          <CalendarDays
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-secondary-400"
          />
          <dt className="sr-only">Date and time</dt>
          <dd className="text-pretty">{schedule}</dd>
        </div>
        <div className="flex min-w-0 items-start gap-2">
          <MapPin
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-secondary-400"
          />
          <dt className="sr-only">Location</dt>
          <dd className="break-words text-pretty">{location}</dd>
        </div>
      </dl>

      <div className="min-w-0 text-sm text-[var(--text-secondary)]">
        {organizer}
      </div>
      {children}
    </header>
  )
}

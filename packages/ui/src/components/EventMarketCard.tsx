import { CalendarDays, ImageOff, MapPin } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { normalizePublicMediaUrl } from "@conduit/core"
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar"
import { StatusPill } from "./StatusPill"
import { cn } from "../utils"

export type EventMarketCardStatusTone =
  "success" | "warning" | "secondary" | "outline"

const STATUS_VARIANTS = {
  success: "success",
  warning: "warning",
  secondary: "neutral",
  outline: "neutral",
} as const

export interface EventMarketCardProps {
  title: string
  summary?: string
  imageUrl?: string
  organizerName: string
  organizerImageUrl?: string
  organizerFallback?: ReactNode
  organizerPending?: boolean
  schedule: string
  location?: string
  statusLabel: string
  statusTone?: EventMarketCardStatusTone
  topics?: readonly string[]
  action: ReactNode
  className?: string
}

export function EventMarketCard({
  title,
  summary,
  imageUrl,
  organizerName,
  organizerImageUrl,
  organizerFallback,
  organizerPending = false,
  schedule,
  location,
  statusLabel,
  statusTone = "outline",
  topics = [],
  action,
  className,
}: EventMarketCardProps) {
  const normalizedImageUrl = normalizePublicMediaUrl(imageUrl)
  const [imageFailed, setImageFailed] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)

  useEffect(() => {
    setImageFailed(false)
    setImageLoaded(false)
  }, [normalizedImageUrl])

  return (
    <article
      className={cn(
        "flex h-full min-w-0 flex-col text-[var(--text-primary)]",
        className
      )}
    >
      <div className="relative aspect-[16/7] overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--background)]">
        {normalizedImageUrl && !imageFailed ? (
          <>
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-0 bg-[var(--surface-elevated)] transition-opacity duration-300",
                !imageLoaded && "animate-pulse",
                imageLoaded ? "opacity-0" : "opacity-100"
              )}
            />
            <img
              src={normalizedImageUrl}
              alt=""
              width={960}
              height={420}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className={cn(
                "h-full w-full object-cover transition-opacity duration-300",
                imageLoaded ? "opacity-100" : "opacity-0"
              )}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-[var(--surface-elevated)] text-[var(--text-secondary)]">
            <ImageOff className="h-6 w-6" aria-hidden="true" />
            <span className="text-sm">Event image unavailable</span>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-4 py-4">
        <div className="space-y-2">
          <StatusPill variant={STATUS_VARIANTS[statusTone]}>
            {statusLabel}
          </StatusPill>
          <h2 className="text-balance font-display text-xl font-semibold leading-snug">
            {title}
          </h2>
          {summary ? (
            <p className="break-words text-pretty text-base leading-6 text-[var(--text-secondary)]">
              {summary}
            </p>
          ) : null}
        </div>

        <div className="space-y-2 text-sm text-[var(--text-secondary)]">
          <div className="flex items-start gap-2">
            <CalendarDays
              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
            <span>{schedule}</span>
          </div>
          {location ? (
            <div className="flex items-start gap-2">
              <MapPin
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-secondary)]"
                aria-hidden="true"
              />
              <span className="break-words">{location}</span>
            </div>
          ) : null}
        </div>

        {topics.length > 0 ? (
          <ul
            className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-[var(--text-secondary)]"
            aria-label="Event topics"
          >
            {topics.slice(0, 4).map((topic) => (
              <li key={topic}>{topic}</li>
            ))}
          </ul>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar className="h-8 w-8">
              {organizerImageUrl ? (
                <AvatarImage src={organizerImageUrl} alt="" />
              ) : null}
              <AvatarFallback>{organizerFallback ?? "C"}</AvatarFallback>
            </Avatar>
            <span
              className={cn(
                "break-words text-sm font-medium",
                organizerPending && "animate-pulse text-[var(--text-secondary)]"
              )}
            >
              {organizerName}
            </span>
          </div>
          <div className="shrink-0">{action}</div>
        </div>
      </div>
    </article>
  )
}

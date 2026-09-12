import { CalendarDays, ImageOff, MapPin } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { normalizePublicMediaUrl } from "@conduit/core"
import { Avatar, AvatarFallback, AvatarImage } from "./Avatar"
import { Badge } from "./Badge"
import { cn } from "../utils"

export type EventMarketCardStatusTone =
  "success" | "warning" | "secondary" | "outline"

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
        "group flex h-full flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-md)] transition-[border-color,box-shadow,transform,background-color] duration-200 hover:border-[var(--text-secondary)] hover:bg-[var(--surface-elevated)] hover:shadow-[var(--shadow-lg)]",
        className
      )}
    >
      <div className="relative aspect-[16/7] overflow-hidden border-b border-[var(--border)] bg-[var(--background)]">
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
                "h-full w-full object-cover transition-[opacity,transform] duration-300 group-hover:scale-[1.02]",
                imageLoaded ? "opacity-100" : "opacity-0"
              )}
              onLoad={() => setImageLoaded(true)}
              onError={() => setImageFailed(true)}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-[linear-gradient(135deg,var(--surface-elevated),var(--surface))] text-[var(--text-muted)]">
            <ImageOff className="h-6 w-6" aria-hidden="true" />
            <span className="text-xs">Event image unavailable</span>
          </div>
        )}
        <Badge
          variant={statusTone}
          className="absolute left-3 top-3 backdrop-blur-sm"
        >
          {statusLabel}
        </Badge>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="space-y-2">
          <h2 className="text-balance font-display text-xl font-semibold leading-tight tracking-tight">
            {title}
          </h2>
          {summary ? (
            <p className="line-clamp-2 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
              {summary}
            </p>
          ) : null}
        </div>

        <div className="space-y-2 text-sm text-[var(--text-secondary)]">
          <div className="flex items-start gap-2">
            <CalendarDays
              className="mt-0.5 h-4 w-4 shrink-0 text-secondary-400"
              aria-hidden="true"
            />
            <span>{schedule}</span>
          </div>
          {location ? (
            <div className="flex items-start gap-2">
              <MapPin
                className="mt-0.5 h-4 w-4 shrink-0 text-secondary-400"
                aria-hidden="true"
              />
              <span className="line-clamp-2">{location}</span>
            </div>
          ) : null}
        </div>

        {topics.length > 0 ? (
          <div className="flex flex-wrap gap-1.5" aria-label="Event topics">
            {topics.slice(0, 4).map((topic) => (
              <Badge key={topic} variant="outline" className="font-medium">
                {topic}
              </Badge>
            ))}
          </div>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar className="h-8 w-8">
              {organizerImageUrl ? (
                <AvatarImage src={organizerImageUrl} alt="" />
              ) : null}
              <AvatarFallback>{organizerFallback ?? "C"}</AvatarFallback>
            </Avatar>
            <span
              className={cn(
                "truncate text-sm font-medium",
                organizerPending && "animate-pulse text-[var(--text-muted)]"
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

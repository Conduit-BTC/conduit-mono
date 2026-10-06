import type { HTMLAttributes, ReactNode } from "react"
import { cn } from "../utils"

/** Shared page gutter and content width; routing and app chrome stay in apps. */
export function PageLayout({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "mx-auto min-w-0 w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 sm:py-8",
        className
      )}
      {...props}
    />
  )
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        "flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
    >
      <div className="min-w-0 space-y-2">
        <h1 className="text-balance font-heading text-3xl font-semibold">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-pretty text-base text-[var(--text-secondary)]">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <ActionRow>{actions}</ActionRow> : null}
    </header>
  )
}

export function ActionRow({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
}

/** Two equal sections on desktop; preserve reading order on phones. */
export function SectionGrid({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-2",
        className
      )}
      {...props}
    />
  )
}

export function SummaryList({
  className,
  ...props
}: HTMLAttributes<HTMLDListElement>) {
  return <dl className={cn("space-y-3 text-sm", className)} {...props} />
}

export function SummaryRow({
  label,
  children,
  total = false,
}: {
  label: ReactNode
  children: ReactNode
  total?: boolean
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4",
        total && "border-t border-[var(--border)] pt-3 text-base font-semibold"
      )}
    >
      <dt className="min-w-0 text-pretty text-[var(--text-secondary)]">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-right tabular-nums">
        {children}
      </dd>
    </div>
  )
}

export function SettingsRow({
  label,
  description,
  controlId,
  children,
}: {
  label: string
  description: string
  controlId?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        {controlId ? (
          <label htmlFor={controlId} className="text-sm font-medium">
            {label}
          </label>
        ) : (
          <p className="text-sm font-medium">{label}</p>
        )}
        <p className="text-pretty text-sm text-[var(--text-secondary)]">
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

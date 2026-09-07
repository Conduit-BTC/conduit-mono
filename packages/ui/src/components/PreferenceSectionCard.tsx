import type { HTMLAttributes, ReactNode } from "react"
import { cn } from "../utils"

export interface PreferenceSectionCardProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  headingId: string
  title: ReactNode
  description?: ReactNode
  headerAction?: ReactNode
}

export function PreferenceSectionCard({
  headingId,
  title,
  description,
  headerAction,
  className,
  children,
  ...props
}: PreferenceSectionCardProps) {
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "overflow-hidden rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-glass-inset)]",
        className
      )}
      {...props}
    >
      <header className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <h2
            id={headingId}
            className="text-balance text-lg font-semibold text-[var(--text-primary)]"
          >
            {title}
          </h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-pretty text-sm leading-6 text-[var(--text-secondary)]">
              {description}
            </p>
          ) : null}
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </header>
      {children}
    </section>
  )
}

export function PreferenceSectionDivider({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("border-t border-[var(--border)]", className)}
      {...props}
    />
  )
}

export function PreferenceSectionBody({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 sm:p-5", className)} {...props} />
}

export interface PreferenceSectionFooterProps extends HTMLAttributes<HTMLDivElement> {
  attention?: boolean
}

export function PreferenceSectionFooter({
  attention = false,
  className,
  ...props
}: PreferenceSectionFooterProps) {
  return (
    <div
      className={cn(
        "p-4 sm:p-5",
        attention && "bg-[color-mix(in_srgb,var(--warning)_8%,var(--surface))]",
        className
      )}
      {...props}
    />
  )
}

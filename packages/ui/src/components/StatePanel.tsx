import type { ReactNode } from "react"
import { PackageOpen, TriangleAlert, Clock3 } from "lucide-react"
import { cn } from "../utils"

/** Explicit copy and actions preserve the difference between empty and unavailable. */
export function StatePanel({
  title,
  description,
  tone = "neutral",
  action,
}: {
  title: string
  description: string
  tone?: "neutral" | "error" | "pending"
  action?: ReactNode
}) {
  const Icon =
    tone === "error" ? TriangleAlert : tone === "pending" ? Clock3 : PackageOpen
  return (
    <div className="flex flex-col items-start gap-3 border-l-2 border-[var(--border)] py-2 pl-4">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-6",
          tone === "error"
            ? "text-[var(--error-text)]"
            : "text-[var(--text-secondary)]"
        )}
      />
      <div className="space-y-1">
        <h3 className="text-balance text-base font-semibold">{title}</h3>
        <p className="max-w-prose text-pretty text-base leading-6 text-[var(--text-secondary)]">
          {description}
        </p>
      </div>
      {action}
    </div>
  )
}

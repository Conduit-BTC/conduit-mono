import type { ReactNode } from "react"
import { cn } from "../utils"

export interface DoubleSideStatusPillProps {
  /** Left (filled) label. */
  left: ReactNode
  /** Right (tinted) label. */
  right: ReactNode
  className?: string
}

/**
 * A two-tone pill: the left half is filled with the primary color, the right
 * half is a faint primary tint with a primary border. Used for a labelled
 * value, e.g. "Public zap" + "generic".
 */
export function DoubleSideStatusPill({
  left,
  right,
  className,
}: DoubleSideStatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-stretch text-[10px] font-medium leading-none",
        className
      )}
    >
      <span className="rounded-l-full bg-primary-500 px-2.5 py-1 text-white">
        {left}
      </span>
      <span className="rounded-r-full border border-l-0 border-primary-500/30 bg-primary-500/10 px-2.5 py-1 text-[var(--text-primary)]">
        {right}
      </span>
    </span>
  )
}

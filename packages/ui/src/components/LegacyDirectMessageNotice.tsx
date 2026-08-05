import { LockKeyhole } from "lucide-react"
import { cn } from "../utils"

export interface LegacyDirectMessageNoticeProps {
  className?: string
}

export function LegacyDirectMessageNotice({
  className,
}: LegacyDirectMessageNoticeProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-sm text-[var(--text-primary)]",
        className
      )}
    >
      <LockKeyhole className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
      <span>
        Legacy NIP-04 conversation. This history is read-only. Start a current
        NIP-17 conversation to reply.
      </span>
    </div>
  )
}

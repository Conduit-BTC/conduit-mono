import { ProtectedInboxNotice } from "./ProtectedInboxNotice"

export interface LiveReadNoticeProps {
  state: "cached" | "partial" | "unavailable"
  onRetry?: () => void
  retrying?: boolean
  className?: string
}

export function LiveReadNotice({
  state,
  onRetry,
  retrying,
  className,
}: LiveReadNoticeProps) {
  return (
    <ProtectedInboxNotice
      state={state}
      onRetry={onRetry}
      retrying={retrying}
      className={className}
    />
  )
}

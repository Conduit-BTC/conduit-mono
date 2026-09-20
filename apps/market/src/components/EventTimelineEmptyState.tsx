import type { FollowedEventMarketDiscoveryState } from "@conduit/core"
import { Button, getResultPresentation } from "@conduit/ui"

export interface EventTimelineEmptyStateProps {
  discoveryState: FollowedEventMarketDiscoveryState | undefined
  hasError: boolean
  refreshIncomplete: boolean
  onRetry?: () => void
  retrying?: boolean
}

export function EventTimelineEmptyState({
  discoveryState,
  hasError,
  refreshIncomplete,
  onRetry,
  retrying,
}: EventTimelineEmptyStateProps) {
  const presentation = getResultPresentation({
    resultCount: 0,
    reliability:
      !hasError && !refreshIncomplete && discoveryState === "complete_empty"
        ? "complete"
        : "degraded",
  })
  const loadFailed = presentation.kind === "degraded_empty"

  return (
    <div
      role={loadFailed ? "alert" : undefined}
      className={`py-10 text-center text-sm ${
        loadFailed ? "text-[var(--warning)]" : "text-[var(--text-muted)]"
      }`}
    >
      <p>
        {loadFailed
          ? "Events couldn't be loaded. Retry to check again."
          : "No events found."}
      </p>
      {loadFailed && onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          disabled={retrying}
          onClick={onRetry}
        >
          Retry
        </Button>
      ) : null}
    </div>
  )
}

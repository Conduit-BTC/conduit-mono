import type { FollowedEventMarketDiscoveryState } from "@conduit/core"

export interface EventTimelineEmptyStateProps {
  discoveryState: FollowedEventMarketDiscoveryState | undefined
  hasError: boolean
  refreshIncomplete: boolean
}

export function EventTimelineEmptyState({
  discoveryState,
  hasError,
  refreshIncomplete,
}: EventTimelineEmptyStateProps) {
  const loadFailed =
    hasError || refreshIncomplete || discoveryState !== "complete_empty"

  return (
    <p
      role={loadFailed ? "alert" : undefined}
      className={`py-10 text-center text-sm ${
        loadFailed ? "text-[var(--warning)]" : "text-[var(--text-muted)]"
      }`}
    >
      {loadFailed
        ? "Events couldn't be loaded. Refresh to try again."
        : "No events found."}
    </p>
  )
}

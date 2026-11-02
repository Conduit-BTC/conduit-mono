import { Badge } from "@conduit/ui"
import {
  getEventRequestBadgeDescription,
  type EventRequestBadgeState,
} from "../lib/event-market-request-badge"

/** The parent link keeps its stable name; this description is separate. */
export function EventMarketRequestBadge({
  state,
  descriptionId,
}: {
  state: EventRequestBadgeState
  descriptionId: string
}) {
  const description = getEventRequestBadgeDescription(state)
  if (!description) return null
  return (
    <>
      <Badge
        variant={state.unresolved ? "warning" : "secondary"}
        aria-hidden="true"
        title={description}
        data-event-request-badge=""
        className="ml-auto shrink-0 px-2 py-0 text-xs tabular-nums"
      >
        {state.pending
          ? `${Math.min(state.pending, 99)}${state.pending > 99 || state.unresolved ? "+" : ""}`
          : "!"}
      </Badge>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </>
  )
}

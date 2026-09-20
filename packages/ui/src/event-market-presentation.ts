import type {
  EventMarketRelayCoverage,
  EventMarketResolution,
  EventMarketResolutionState,
} from "@conduit/core"

export type EventActionability =
  "actionable" | "limited" | "read_only" | "blocked"

export type EventActionabilityPresentation = {
  actionability: EventActionability
  label: string
  message: string
  role?: "alert"
  tone: "success" | "secondary" | "warning" | "destructive"
  visibility: "silent" | "inline" | "prominent"
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function eventMarketRequiredRecordsResolved(
  event: Pick<
    EventMarketResolution,
    "calendar" | "collection" | "pickup" | "pickupCoordinate"
  >
): boolean {
  return Boolean(
    event.collection &&
    event.calendar &&
    (!event.pickupCoordinate || event.pickup)
  )
}

function availableProductsMessage(
  availableProductCount: number,
  unresolvedProductCount: number
): string {
  const available = `${countLabel(availableProductCount, "product")} available.`
  if (unresolvedProductCount === 0) return available
  return `${available} ${countLabel(unresolvedProductCount, "product")} remain${unresolvedProductCount === 1 ? "s" : ""} unresolved and unavailable.`
}

export function getEventActionabilityPresentation(input: {
  state: EventMarketResolutionState
  orderAcceptance?: "open" | "closed"
  availableProductCount: number
  unresolvedProductCount?: number
  requiredEventRecordsResolved?: boolean
}): EventActionabilityPresentation {
  const availableProductCount = Math.max(0, input.availableProductCount)
  const unresolvedProductCount = Math.max(0, input.unresolvedProductCount ?? 0)

  switch (input.state) {
    case "active":
      return {
        actionability: "actionable",
        label: "Event loaded",
        message: availableProductsMessage(
          availableProductCount,
          unresolvedProductCount
        ),
        tone: "success",
        visibility: "silent",
      }
    case "partial":
      if (input.requiredEventRecordsResolved === false) {
        return {
          actionability: "limited",
          label: "Event records unresolved",
          message: `A required signed event record is unresolved. ${availableProductsMessage(availableProductCount, unresolvedProductCount)} Exact current product and pickup evidence still determines which product actions are available.`,
          role: "alert",
          tone: "warning",
          visibility: "prominent",
        }
      }
      return {
        actionability: "actionable",
        label: "Event loaded",
        message: availableProductsMessage(
          availableProductCount,
          unresolvedProductCount
        ),
        tone: "success",
        visibility: "silent",
      }
    case "ended":
      return {
        actionability: "read_only",
        label:
          input.orderAcceptance === "closed" ? "Event closed" : "Event ended",
        message:
          input.orderAcceptance === "closed"
            ? "The organizer has closed this event to new orders. Existing orders and pickup remain available."
            : `${availableProductsMessage(availableProductCount, unresolvedProductCount)} Checkout is closed.`,
        tone: "secondary",
        visibility: "inline",
      }
    case "missing":
      return {
        actionability: "blocked",
        label: "Event unavailable",
        message:
          "No current signed event collection was found in the completed read. Try again or ask the organizer for its canonical event link.",
        role: "alert",
        tone: "warning",
        visibility: "prominent",
      }
    case "unavailable":
      return {
        actionability: "blocked",
        label: "Event unavailable",
        message:
          "The organizer's signed event records could not be confirmed. Try again when relay access recovers.",
        role: "alert",
        tone: "warning",
        visibility: "prominent",
      }
    case "stale":
      return {
        actionability: "blocked",
        label: "Event evidence is stale",
        message:
          "Only earlier signed evidence is available. Refresh before relying on the schedule, pickup terms, or product availability.",
        role: "alert",
        tone: "warning",
        visibility: "prominent",
      }
    case "deleted":
      return {
        actionability: "blocked",
        label: "Event deleted",
        message:
          "The organizer's signed deletion is authoritative. Products and checkout are no longer available through this event.",
        role: "alert",
        tone: "destructive",
        visibility: "prominent",
      }
    case "malformed":
      return {
        actionability: "blocked",
        label: "Event reference or records are malformed",
        message:
          "This event reference or its signed records cannot be interpreted safely. Products and checkout remain unavailable.",
        role: "alert",
        tone: "destructive",
        visibility: "prominent",
      }
    case "conflicting":
      return {
        actionability: "blocked",
        label: "Event records conflict",
        message:
          "The signed records do not agree on this event. Conduit will not choose between them or offer consequential actions.",
        role: "alert",
        tone: "destructive",
        visibility: "prominent",
      }
    case "unsupported":
    default:
      return {
        actionability: "blocked",
        label: "Event unsupported",
        message:
          "This event uses signed references that this version of Conduit cannot safely interpret.",
        role: "alert",
        tone: "warning",
        visibility: "prominent",
      }
  }
}

export function formatEventRelayReadCoverage(
  coverage: EventMarketRelayCoverage | undefined
): string | null {
  if (!coverage || coverage.attemptedRelayCount <= 0) return null
  const planned = coverage.attemptedRelayCount
  const completed = Math.min(planned, Math.max(0, coverage.completeRelayCount))
  const incomplete = planned - completed
  if (incomplete === 0) {
    return `${completed} of ${planned} planned relay reads completed.`
  }
  return `${completed} of ${planned} planned relay reads completed; ${incomplete} ${incomplete === 1 ? "was" : "were"} incomplete.`
}

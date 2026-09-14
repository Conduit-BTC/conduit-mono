import type {
  EventMarketCandidateReadCoverage,
  EventMarketPerspectiveSnapshot,
  EventMarketRelayCoverage,
  EventMarketResolution,
  EventMarketResolutionState,
  FollowedEventMarketDiscoveryState,
} from "@conduit/core"

export type EventActionability =
  "actionable" | "limited" | "read_only" | "blocked"

export type EventActionabilityPresentation = {
  actionability: EventActionability
  label: string
  message: string
  role: "status" | "alert"
  tone: "success" | "secondary" | "warning" | "destructive"
  prominent: boolean
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
        role: "status",
        tone: "success",
        prominent: false,
      }
    case "partial":
      if (input.requiredEventRecordsResolved === false) {
        return {
          actionability: "limited",
          label: "Event records unresolved",
          message: `A required signed event record is unresolved. ${availableProductsMessage(availableProductCount, unresolvedProductCount)} Exact current product and pickup evidence still determines which product actions are available.`,
          role: "alert",
          tone: "warning",
          prominent: true,
        }
      }
      return {
        actionability: "actionable",
        label: "Event loaded",
        message: availableProductsMessage(
          availableProductCount,
          unresolvedProductCount
        ),
        role: "status",
        tone: "success",
        prominent: false,
      }
    case "ended":
      return {
        actionability: "read_only",
        label: "Event ended",
        message: `${availableProductsMessage(availableProductCount, unresolvedProductCount)} Checkout is closed.`,
        role: "status",
        tone: "secondary",
        prominent: false,
      }
    case "missing":
      return {
        actionability: "blocked",
        label: "Event unavailable",
        message:
          "No current signed event collection was found in the completed read. Try again or ask the organizer for its canonical event link.",
        role: "alert",
        tone: "warning",
        prominent: true,
      }
    case "unavailable":
      return {
        actionability: "blocked",
        label: "Event unavailable",
        message:
          "The organizer's signed event records could not be confirmed. Try again when relay access recovers.",
        role: "alert",
        tone: "warning",
        prominent: true,
      }
    case "stale":
      return {
        actionability: "blocked",
        label: "Event evidence is stale",
        message:
          "Only earlier signed evidence is available. Refresh before relying on the schedule, pickup terms, or product availability.",
        role: "alert",
        tone: "warning",
        prominent: true,
      }
    case "deleted":
      return {
        actionability: "blocked",
        label: "Event deleted",
        message:
          "The organizer's signed deletion is authoritative. Products and checkout are no longer available through this event.",
        role: "alert",
        tone: "destructive",
        prominent: true,
      }
    case "malformed":
      return {
        actionability: "blocked",
        label: "Event reference or records are malformed",
        message:
          "This event reference or its signed records cannot be interpreted safely. Products and checkout remain unavailable.",
        role: "alert",
        tone: "destructive",
        prominent: true,
      }
    case "conflicting":
      return {
        actionability: "blocked",
        label: "Event records conflict",
        message:
          "The signed records do not agree on this event. Conduit will not choose between them or offer consequential actions.",
        role: "alert",
        tone: "destructive",
        prominent: true,
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
        prominent: true,
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

export type OrganizerDiscoveryPresentation = {
  message: string
  role: "status" | "alert"
  prominent: boolean
}

function eventMarketPerspectiveLabel(
  source: EventMarketPerspectiveSnapshot["source"]
): string {
  switch (source) {
    case "conduit":
      return "Conduit perspective"
    case "combined":
      return "Following + Conduit perspective"
    case "following":
    default:
      return "Following perspective"
  }
}

export function getOrganizerDiscoveryPresentation(input: {
  state: FollowedEventMarketDiscoveryState
  eventCount: number
  perspective: Pick<
    EventMarketPerspectiveSnapshot,
    "source" | "authorCount" | "coverage"
  >
  candidateScanCoverage: Pick<
    EventMarketCandidateReadCoverage,
    "plannedReadCount" | "completeReadCount"
  >
  searchedOrganizerCount: number
  incompleteOrganizerCount: number
}): OrganizerDiscoveryPresentation {
  const eventCount = Math.max(0, input.eventCount)
  const perspectiveLabel = eventMarketPerspectiveLabel(input.perspective.source)
  const perspectiveAuthorCount = Math.max(0, input.perspective.authorCount)
  const plannedReadCount = Math.max(
    0,
    input.candidateScanCoverage.plannedReadCount
  )
  const completeReadCount = Math.min(
    plannedReadCount,
    Math.max(0, input.candidateScanCoverage.completeReadCount)
  )
  const searchedOrganizerCount = Math.max(0, input.searchedOrganizerCount)
  const incompleteOrganizerCount = Math.min(
    searchedOrganizerCount,
    Math.max(0, input.incompleteOrganizerCount)
  )

  if (input.state === "unavailable") {
    return {
      message: `Event discovery is unavailable for the ${perspectiveLabel}. Saved event links can still be opened directly.`,
      role: "alert",
      prominent: true,
    }
  }

  const outcome =
    eventCount > 0
      ? input.state === "complete"
        ? `Showing ${countLabel(eventCount, "event")}.`
        : `Showing ${countLabel(eventCount, "event")} found so far.`
      : input.state === "complete_empty"
        ? `No events were found in the completed bounded relay reads for the ${perspectiveLabel}.`
        : `No events found so far in the ${perspectiveLabel}; more may appear.`
  const relayCoverage =
    perspectiveAuthorCount === 0
      ? `The ${perspectiveLabel} currently contains no public organizers to check.`
      : plannedReadCount > 0
        ? `Completed ${completeReadCount} of ${plannedReadCount} planned bounded relay collection reads.`
        : "No bounded relay collection reads were planned."
  const incompleteCandidateReads =
    incompleteOrganizerCount > 0
      ? ` ${countLabel(incompleteOrganizerCount, "discovered organizer check")} ${incompleteOrganizerCount === 1 ? "was" : "were"} incomplete.`
      : ""
  const perspectiveCoverage =
    input.perspective.coverage === "complete"
      ? ""
      : ` The available ${perspectiveLabel} snapshot may be incomplete.`

  return {
    message: `${outcome} ${relayCoverage}${incompleteCandidateReads}${perspectiveCoverage}`,
    role: "status",
    prominent: false,
  }
}

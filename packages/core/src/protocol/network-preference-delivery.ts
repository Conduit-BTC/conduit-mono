import type {
  NetworkPreferencePublishStatus,
  NetworkPreferenceReadbackStatus,
  NetworkPreferenceRelayOutcome,
} from "../db"

export interface NetworkPreferencePublishObservation {
  relayUrl: string
  status: Exclude<NetworkPreferencePublishStatus, "pending">
}

export interface NetworkPreferenceReadbackObservation {
  relayUrl: string
  status: Exclude<NetworkPreferenceReadbackStatus, "pending">
}

export interface NetworkPreferenceDistributionOutcomeUpdate {
  publish?: readonly NetworkPreferencePublishObservation[]
  readback?: readonly NetworkPreferenceReadbackObservation[]
  observedAt: number
}

const PUBLISH_STRENGTH: Record<NetworkPreferencePublishStatus, number> = {
  pending: 0,
  timed_out: 1,
  rejected: 2,
  acked: 3,
}

const READBACK_STRENGTH: Record<NetworkPreferenceReadbackStatus, number> = {
  pending: 0,
  timed_out: 1,
  absent: 2,
  observed: 3,
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Network preference observation time must be valid")
  }
}

function indexObservations<T extends { relayUrl: string }>(
  observations: readonly T[] | undefined,
  plannedRelayUrls: ReadonlySet<string>,
  label: string
): Map<string, T> {
  const byRelay = new Map<string, T>()
  for (const observation of observations ?? []) {
    if (
      !plannedRelayUrls.has(observation.relayUrl) ||
      byRelay.has(observation.relayUrl)
    ) {
      throw new Error(`${label} observations must target the immutable plan`)
    }
    byRelay.set(observation.relayUrl, observation)
  }
  return byRelay
}

/** Apply monotonic attempt evidence without changing the immutable plan. */
export function applyNetworkPreferenceDistributionOutcomes(
  outcomes: readonly NetworkPreferenceRelayOutcome[],
  update: NetworkPreferenceDistributionOutcomeUpdate
): NetworkPreferenceRelayOutcome[] {
  assertTimestamp(update.observedAt)
  const plannedRelayUrls = new Set(outcomes.map((outcome) => outcome.relayUrl))
  if (plannedRelayUrls.size !== outcomes.length) {
    throw new Error("Network preference distribution plan must be unique")
  }
  const publishByRelay = indexObservations(
    update.publish,
    plannedRelayUrls,
    "Publish"
  )
  const readbackByRelay = indexObservations(
    update.readback,
    plannedRelayUrls,
    "Readback"
  )
  return outcomes.map((current) => {
    const next = structuredClone(current)
    const publish = publishByRelay.get(current.relayUrl)
    if (
      publish &&
      next.publishStatus !== "acked" &&
      next.readbackStatus !== "observed"
    ) {
      next.publishAttemptCount += 1
      next.publishAttemptedAt = update.observedAt
      if (
        PUBLISH_STRENGTH[publish.status] >= PUBLISH_STRENGTH[next.publishStatus]
      ) {
        next.publishStatus = publish.status
      }
    }
    const readback = readbackByRelay.get(current.relayUrl)
    if (readback && next.readbackStatus !== "observed") {
      next.readbackAttemptCount += 1
      next.readbackAttemptedAt = update.observedAt
      if (
        READBACK_STRENGTH[readback.status] >=
        READBACK_STRENGTH[next.readbackStatus]
      ) {
        next.readbackStatus = readback.status
        if (readback.status === "observed") {
          next.observedAt = update.observedAt
        }
      }
    }
    return next
  })
}

export function unresolvedNetworkPreferencePublishRelayUrls(
  outcomes: readonly NetworkPreferenceRelayOutcome[]
): string[] {
  return outcomes.flatMap((outcome) =>
    outcome.publishStatus === "acked" || outcome.readbackStatus === "observed"
      ? []
      : [outcome.relayUrl]
  )
}

export function unresolvedNetworkPreferenceReadbackRelayUrls(
  outcomes: readonly NetworkPreferenceRelayOutcome[]
): string[] {
  return outcomes.flatMap((outcome) =>
    outcome.readbackStatus === "observed" ? [] : [outcome.relayUrl]
  )
}

/** Complete bounded exact readback: no unknown target and at least one source. */
export function hasCompletedExactNetworkPreferenceReadback(
  outcomes: readonly NetworkPreferenceRelayOutcome[]
): boolean {
  return (
    outcomes.length > 0 &&
    outcomes.some((outcome) => outcome.readbackStatus === "observed") &&
    outcomes.every(
      (outcome) =>
        outcome.readbackStatus === "observed" ||
        outcome.readbackStatus === "absent"
    )
  )
}

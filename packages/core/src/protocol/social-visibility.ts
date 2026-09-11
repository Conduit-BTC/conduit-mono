export type SocialVisibilitySurface =
  | "activity_row"
  | "comment"
  | "discovery_feed"
  | "following_feed"
  | "notification"
  | "thread"

export type SocialTrustContext =
  | {
      relationship: "self" | "direct_follow" | "second_hop"
      freshness: "current" | "stale" | "partial"
    }
  | {
      relationship: "outside_trust"
      freshness: "current"
    }
  | {
      relationship: "unavailable"
      freshness: "partial" | "unavailable"
    }

export type SocialViewerContext =
  | { kind: "guest" }
  | {
      kind: "signed_in" | "named_read_only"
      trust: SocialTrustContext
    }

export type SocialMuteMatches = {
  profile?: boolean
  threadOrPost?: boolean
  word?: boolean
}

export type SocialVisibilityReason =
  | "public_activity"
  | "guest_body_restricted"
  | "following_scope"
  | "profile_muted"
  | "thread_or_post_muted"
  | "trust_unavailable"
  | "word_muted"
  | "self"
  | "direct_follow"
  | "second_hop"
  | "outside_trust"

export type SocialVisibilityDecision = {
  decision: "visible" | "activity_only" | "revealable" | "hidden"
  reason: SocialVisibilityReason
  source: "guest" | "signed_in_follow_list" | "named_read_only_follow_list"
  freshness: "not_applicable" | SocialTrustContext["freshness"]
}

export type SocialVisibilityInput = {
  mutes?: SocialMuteMatches
  viewer: SocialViewerContext
  surface: SocialVisibilitySurface
}

/**
 * Applies row-level social visibility without fetching relays, reading storage,
 * or accepting commerce surfaces. Callers precompute trust and mute matches.
 * Mutes win first, followed by public activity, explicit Following scope, and
 * then the trust decision for the requested social surface.
 *
 * Aggregate activity totals are computed separately, so hiding a muted row
 * does not rewrite an honest public count. This presentational result must
 * never authorize product discovery, checkout, payment, or settlement.
 */
export function evaluateSocialVisibility({
  mutes,
  viewer,
  surface,
}: SocialVisibilityInput): SocialVisibilityDecision {
  const source =
    viewer.kind === "guest"
      ? "guest"
      : viewer.kind === "signed_in"
        ? "signed_in_follow_list"
        : "named_read_only_follow_list"
  const freshness =
    viewer.kind === "guest" ? "not_applicable" : viewer.trust.freshness
  const muteReason = mutes?.profile
    ? "profile_muted"
    : mutes?.threadOrPost
      ? "thread_or_post_muted"
      : mutes?.word
        ? "word_muted"
        : undefined

  if (muteReason) {
    return {
      decision: "hidden",
      reason: muteReason,
      source,
      freshness,
    }
  }

  if (surface === "activity_row") {
    return {
      decision: "visible",
      reason: "public_activity",
      source,
      freshness,
    }
  }

  if (viewer.kind !== "guest") {
    if (surface === "following_feed") {
      return {
        decision: "visible",
        reason: "following_scope",
        source,
        freshness,
      }
    }

    if (
      viewer.trust.relationship === "outside_trust" ||
      viewer.trust.relationship === "unavailable"
    ) {
      const reason =
        viewer.trust.relationship === "unavailable"
          ? "trust_unavailable"
          : "outside_trust"
      const revealable =
        surface === "comment" ||
        surface === "notification" ||
        surface === "thread"

      if (revealable) {
        return {
          decision: "revealable",
          reason,
          source,
          freshness,
        }
      }

      return {
        decision: "hidden",
        reason,
        source,
        freshness,
      }
    }

    return {
      decision: "visible",
      reason: viewer.trust.relationship,
      source,
      freshness,
    }
  }

  return {
    decision: "activity_only",
    reason: "guest_body_restricted",
    source: "guest",
    freshness: "not_applicable",
  }
}

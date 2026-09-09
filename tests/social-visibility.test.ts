import { describe, expect, it } from "bun:test"
import { evaluateSocialVisibility } from "@conduit/core"

describe("social visibility policy", () => {
  it("keeps public activity visible for guests while suppressing social bodies", () => {
    expect(
      evaluateSocialVisibility({
        viewer: { kind: "guest" },
        surface: "activity_row",
      })
    ).toEqual({
      decision: "visible",
      reason: "public_activity",
      source: "guest",
      freshness: "not_applicable",
    })

    for (const surface of [
      "comment",
      "discovery_feed",
      "following_feed",
      "notification",
      "thread",
    ] as const) {
      expect(
        evaluateSocialVisibility({
          viewer: { kind: "guest" },
          surface,
        })
      ).toEqual({
        decision: "activity_only",
        reason: "guest_body_restricted",
        source: "guest",
        freshness: "not_applicable",
      })
    }
  })

  it("explains direct and second-hop trust for account perspectives", () => {
    expect(
      evaluateSocialVisibility({
        viewer: {
          kind: "signed_in",
          trust: { relationship: "direct_follow", freshness: "current" },
        },
        surface: "discovery_feed",
      })
    ).toEqual({
      decision: "visible",
      reason: "direct_follow",
      source: "signed_in_follow_list",
      freshness: "current",
    })

    expect(
      evaluateSocialVisibility({
        viewer: {
          kind: "named_read_only",
          trust: { relationship: "second_hop", freshness: "stale" },
        },
        surface: "thread",
      })
    ).toEqual({
      decision: "visible",
      reason: "second_hop",
      source: "named_read_only_follow_list",
      freshness: "stale",
    })

    expect(
      evaluateSocialVisibility({
        viewer: {
          kind: "signed_in",
          trust: { relationship: "self", freshness: "partial" },
        },
        surface: "comment",
      })
    ).toEqual({
      decision: "visible",
      reason: "self",
      source: "signed_in_follow_list",
      freshness: "partial",
    })
  })

  it("keeps an explicit Following row visible when wider trust is unavailable", () => {
    expect(
      evaluateSocialVisibility({
        viewer: {
          kind: "signed_in",
          trust: { relationship: "unavailable", freshness: "unavailable" },
        },
        surface: "following_feed",
      })
    ).toEqual({
      decision: "visible",
      reason: "following_scope",
      source: "signed_in_follow_list",
      freshness: "unavailable",
    })
  })

  it("requires an explicit reveal outside trusted discovery", () => {
    expect(
      evaluateSocialVisibility({
        viewer: {
          kind: "signed_in",
          trust: { relationship: "outside_trust", freshness: "current" },
        },
        surface: "comment",
      })
    ).toEqual({
      decision: "revealable",
      reason: "outside_trust",
      source: "signed_in_follow_list",
      freshness: "current",
    })

    expect(
      evaluateSocialVisibility({
        viewer: {
          kind: "named_read_only",
          trust: { relationship: "unavailable", freshness: "partial" },
        },
        surface: "notification",
      })
    ).toEqual({
      decision: "revealable",
      reason: "trust_unavailable",
      source: "named_read_only_follow_list",
      freshness: "partial",
    })

    expect(
      evaluateSocialVisibility({
        viewer: {
          kind: "signed_in",
          trust: { relationship: "outside_trust", freshness: "current" },
        },
        surface: "discovery_feed",
      })
    ).toEqual({
      decision: "hidden",
      reason: "outside_trust",
      source: "signed_in_follow_list",
      freshness: "current",
    })

    expect(
      evaluateSocialVisibility({
        viewer: {
          kind: "signed_in",
          trust: { relationship: "unavailable", freshness: "partial" },
        },
        surface: "discovery_feed",
      })
    ).toEqual({
      decision: "hidden",
      reason: "trust_unavailable",
      source: "signed_in_follow_list",
      freshness: "partial",
    })
  })

  it("applies mute precedence before social trust", () => {
    const viewer = {
      kind: "signed_in" as const,
      trust: {
        relationship: "direct_follow" as const,
        freshness: "current" as const,
      },
    }

    expect(
      evaluateSocialVisibility({
        viewer,
        surface: "thread",
        mutes: { profile: true, threadOrPost: true, word: true },
      })
    ).toEqual({
      decision: "hidden",
      reason: "profile_muted",
      source: "signed_in_follow_list",
      freshness: "current",
    })

    expect(
      evaluateSocialVisibility({
        viewer,
        surface: "notification",
        mutes: { threadOrPost: true, word: true },
      })
    ).toEqual({
      decision: "hidden",
      reason: "thread_or_post_muted",
      source: "signed_in_follow_list",
      freshness: "current",
    })

    expect(
      evaluateSocialVisibility({
        viewer,
        surface: "following_feed",
        mutes: { word: true },
      })
    ).toEqual({
      decision: "hidden",
      reason: "word_muted",
      source: "signed_in_follow_list",
      freshness: "current",
    })
  })

  it("keeps public activity rows visible when wider trust is unavailable", () => {
    expect(
      evaluateSocialVisibility({
        viewer: {
          kind: "named_read_only",
          trust: { relationship: "unavailable", freshness: "partial" },
        },
        surface: "activity_row",
      })
    ).toEqual({
      decision: "visible",
      reason: "public_activity",
      source: "named_read_only_follow_list",
      freshness: "partial",
    })
  })
})

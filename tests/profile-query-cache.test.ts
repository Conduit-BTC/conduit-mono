import { describe, expect, it } from "bun:test"
import type {
  CommerceQueryMeta,
  ProfileBatchResult,
  SelectedProfileContext,
  Profile,
  ProfileFormValues,
} from "@conduit/core"
import { reconcileProfileFormDraft } from "../packages/core/src/protocol/profiles"
import { updateProfileQueryCache } from "../packages/core/src/hooks/useUpdateProfile"
import { getProfileRelayHintKey } from "../packages/core/src/hooks/useProfiles"

const PUBKEY = "a".repeat(64)

function selectedContext(
  lud16: string | undefined,
  eventId = "selected",
  eventCreatedAt = 20
): SelectedProfileContext {
  return {
    profile: { pubkey: PUBKEY, name: "Merchant", lud16 },
    frontier: {
      eventId,
      eventCreatedAt,
      rawContent: JSON.stringify({ name: "Merchant", lud16 }),
      validity: "valid",
    },
    freshness: "observed",
    persistence: "durable",
    readComplete: true,
  }
}

describe("profile query cache", () => {
  it("keeps profile reads stable when unrelated catalog relay hints arrive", () => {
    const otherPubkey = "b".repeat(64)
    const current = { [PUBKEY]: ["wss://visible.example"] }
    const key = getProfileRelayHintKey([PUBKEY], current)

    expect(
      getProfileRelayHintKey([PUBKEY], {
        ...current,
        [otherPubkey]: ["wss://other.example"],
      })
    ).toBe(key)
    expect(
      getProfileRelayHintKey([PUBKEY], {
        [PUBKEY]: ["wss://updated.example"],
      })
    ).not.toBe(key)
    expect(
      getProfileRelayHintKey([PUBKEY], {
        [otherPubkey]: ["wss://other.example"],
      })
    ).toBe(getProfileRelayHintKey([PUBKEY], undefined))
  })

  it("normalizes requested profile and relay hint order without restarting reads", () => {
    const otherPubkey = "b".repeat(64)
    expect(
      getProfileRelayHintKey([otherPubkey, PUBKEY, PUBKEY], {
        [PUBKEY]: [
          "wss://second.example",
          "wss://first.example",
          "wss://first.example",
        ],
        [otherPubkey]: ["wss://other.example"],
      })
    ).toBe(
      getProfileRelayHintKey([PUBKEY, otherPubkey], {
        [PUBKEY]: ["wss://first.example", "wss://second.example"],
        [otherPubkey]: ["wss://other.example"],
      })
    )
  })

  it("replaces published projection and selected authority together without retaining fresh-read metadata", () => {
    const meta = {
      stale: false,
      degraded: false,
      capped: false,
    } as CommerceQueryMeta
    const current: ProfileBatchResult = {
      data: {
        [PUBKEY]: { pubkey: PUBKEY, name: "Before" },
      },
      meta,
      profileContexts: {
        [PUBKEY]: selectedContext("old@wallet.example", "old", 10),
      },
    }
    const profile: Profile = {
      pubkey: PUBKEY,
      name: "After",
      about: "Updated locally after publish",
    }

    const published = selectedContext(undefined, "published", 20)
    published.profile = profile
    const updated = updateProfileQueryCache(current, published)

    expect(updated?.data[PUBKEY]).toEqual(profile)
    expect(updated?.profileContexts[PUBKEY]).toBe(published)
    expect(updated?.meta).toMatchObject({
      source: "local_cache",
      stale: true,
      degraded: true,
      profileFrontierStates: { [PUBKEY]: "observed_valid" },
    })
    expect(current.profileContexts[PUBKEY].frontier?.eventId).toBe("old")
    expect(updated).not.toHaveProperty(PUBKEY)
  })

  it("leaves an unpopulated query cache alone", () => {
    expect(
      updateProfileQueryCache(undefined, selectedContext(undefined))
    ).toBeUndefined()
  })

  it("does not replace a stronger query context when an older publish callback finishes", () => {
    const stronger = selectedContext(undefined, "removal", 30)
    const current: ProfileBatchResult = {
      data: { [PUBKEY]: stronger.profile },
      profileContexts: { [PUBKEY]: stronger },
      meta: { source: "public", stale: false } as CommerceQueryMeta,
    }
    expect(
      updateProfileQueryCache(
        current,
        selectedContext("old@wallet.example", "published", 20)
      )
    ).toBe(current)
    expect(current.data[PUBKEY].lud16).toBeUndefined()
  })

  it("keeps other authors selected contexts intact when publishing one profile", () => {
    const other = "b".repeat(64)
    const otherContext = selectedContext("other@wallet.example")
    otherContext.profile = { ...otherContext.profile, pubkey: other }
    const current: ProfileBatchResult = {
      data: { [other]: otherContext.profile },
      profileContexts: { [other]: otherContext },
      meta: { source: "public", stale: false } as CommerceQueryMeta,
    }
    const updated = updateProfileQueryCache(
      current,
      selectedContext(undefined)
    )!
    expect(updated.profileContexts[other]).toBe(otherContext)
    expect(updated.data[other]).toBe(otherContext.profile)
    expect(updated.profileContexts[PUBKEY].profile.lud16).toBeUndefined()
  })

  it("rebases untouched draft fields onto the latest signed profile", () => {
    const baseline: ProfileFormValues = {
      name: "before",
      displayName: "Before",
      about: "Before about",
      picture: "",
      banner: "",
      nip05: "",
      lud16: "before@wallet.example",
      website: "",
    }
    const draft = { ...baseline, displayName: "Local display edit" }
    const latest = {
      ...baseline,
      about: "Remote about update",
      lud16: "current@wallet.example",
    }

    expect(reconcileProfileFormDraft(draft, baseline, latest)).toEqual({
      ...latest,
      displayName: "Local display edit",
    })
  })

  it("waits for profile evidence and reconciles active edits", async () => {
    const merchantRoute = (
      await Bun.file("apps/merchant/src/routes/profile.tsx").text()
    ).replaceAll("\r\n", "\n")
    const marketRoute = (
      await Bun.file("apps/market/src/routes/profile.tsx").text()
    ).replaceAll("\r\n", "\n")

    for (const route of [merchantRoute, marketRoute]) {
      expect(route).toContain("reconcileProfileFormDraft(")
      expect(route).toContain("canEditProfile")
      expect(route).toContain("isCommerceReadIncomplete(profileQuery.meta)")
      expect(route).toContain('evidenceScope: "profile_edit"')
      expect(route).toContain("editingPubkey === accountPubkey")
      expect(route).toContain("profileWorkOwnerRef.current = accountPubkey")
      expect(route).toContain(
        "if (!previousOwner || previousOwner === accountPubkey) return"
      )
      expect(route).toContain("!editing ||\n      !signerReady ||")
      expect(route).toContain("!hasProfileChanges ||")
    }
    expect(merchantRoute).toContain(
      "!profileQuery.isLoading &&\n              !complete"
    )
  })
})

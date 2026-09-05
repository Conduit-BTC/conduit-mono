import { describe, expect, it } from "bun:test"
import type {
  CommerceQueryMeta,
  CommerceResult,
  Profile,
  ProfileMap,
  ProfileFormValues,
} from "@conduit/core"
import { reconcileProfileFormDraft } from "../packages/core/src/protocol/profiles"
import { updateProfileQueryCache } from "../packages/core/src/hooks/useUpdateProfile"

const PUBKEY = "a".repeat(64)

describe("profile query cache", () => {
  it("updates the profile inside the Commerce result without replacing metadata", () => {
    const meta = {
      stale: false,
      degraded: false,
      capped: false,
    } as CommerceQueryMeta
    const current: CommerceResult<ProfileMap> = {
      data: {
        [PUBKEY]: { pubkey: PUBKEY, name: "Before" },
      },
      meta,
    }
    const profile: Profile = {
      pubkey: PUBKEY,
      name: "After",
      about: "Updated locally after publish",
    }

    const updated = updateProfileQueryCache(current, profile)

    expect(updated?.data[PUBKEY]).toEqual(profile)
    expect(updated?.meta).toBe(meta)
    expect(updated).not.toHaveProperty(PUBKEY)
  })

  it("leaves an unpopulated query cache alone", () => {
    expect(
      updateProfileQueryCache(undefined, { pubkey: PUBKEY })
    ).toBeUndefined()
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
    const merchantRoute = await Bun.file(
      "apps/merchant/src/routes/profile.tsx"
    ).text()
    const marketRoute = await Bun.file(
      "apps/market/src/routes/profile.tsx"
    ).text()

    for (const route of [merchantRoute, marketRoute]) {
      expect(route).toContain("reconcileProfileFormDraft(")
      expect(route).toContain("canEditProfile")
      expect(route).toContain("isCommerceReadIncomplete(profileQuery.meta)")
    }
    expect(merchantRoute).toContain(
      "!profileQuery.isLoading &&\n              !complete"
    )
  })
})

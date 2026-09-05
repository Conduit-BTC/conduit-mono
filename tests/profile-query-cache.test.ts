import { describe, expect, it } from "bun:test"
import type {
  CommerceQueryMeta,
  CommerceResult,
  Profile,
  ProfileMap,
} from "@conduit/core"
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

  it("keeps background profile refreshes from overwriting an active edit", async () => {
    const merchantRoute = await Bun.file(
      "apps/merchant/src/routes/profile.tsx"
    ).text()
    const marketRoute = await Bun.file(
      "apps/market/src/routes/profile.tsx"
    ).text()

    for (const route of [merchantRoute, marketRoute]) {
      expect(route).toContain("if (editing || !profileQuery.data) return")
      expect(route).toContain("[editing, profileQuery.data]")
    }
    expect(merchantRoute).toContain(
      "!profileQuery.isLoading &&\n              !complete"
    )
  })
})

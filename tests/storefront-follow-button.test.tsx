import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { StorefrontFollowButton } from "../apps/market/src/components/StorefrontFollowButton"

describe("storefront follow button", () => {
  it("keeps the initial Follow state enabled", () => {
    const markup = renderToStaticMarkup(
      <StorefrontFollowButton
        isFollowing={false}
        merchantName="Bitcoin Bazar"
        onClick={() => undefined}
        saveState="idle"
        writesAvailable
      />
    )

    expect(markup).toContain("bg-primary-500")
    expect(markup).toContain("lucide-user-plus")
    expect(markup).toContain(">Follow<")
    expect(markup).toContain('aria-label="Follow Bitcoin Bazar"')
    expect(markup).not.toContain('disabled=""')
  })

  it("shows an undimmed loading state while a follow is saving", () => {
    const markup = renderToStaticMarkup(
      <StorefrontFollowButton
        isFollowing={false}
        merchantName="Bitcoin Bazar"
        onClick={() => undefined}
        saveState="saving_follow"
        writesAvailable
      />
    )

    expect(markup).toContain("bg-[var(--surface-elevated)]")
    expect(markup).toContain("disabled:opacity-100")
    expect(markup).toContain("lucide-loader-circle")
    expect(markup).toContain("animate-spin")
    expect(markup).toContain("motion-reduce:animate-none")
    expect(markup).not.toContain("lucide-check")
    expect(markup).toContain("Following…")
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('aria-label="Following Bitcoin Bazar"')
  })

  it("keeps the settled Following state actionable as Unfollow", () => {
    const markup = renderToStaticMarkup(
      <StorefrontFollowButton
        isFollowing
        merchantName="Bitcoin Bazar"
        onClick={() => undefined}
        saveState="idle"
        writesAvailable
      />
    )

    expect(markup).toContain("lucide-check")
    expect(markup).toContain(">Following<")
    expect(markup).toContain(">Unfollow<")
    expect(markup).toContain('aria-label="Unfollow Bitcoin Bazar"')
    expect(markup).not.toContain('disabled=""')
  })

  it("keeps unfollow writes visibly pending and guarded", () => {
    const markup = renderToStaticMarkup(
      <StorefrontFollowButton
        isFollowing={false}
        merchantName="Bitcoin Bazar"
        onClick={() => undefined}
        saveState="saving_unfollow"
        writesAvailable
      />
    )

    expect(markup).toContain("bg-[var(--surface-elevated)]")
    expect(markup).toContain("disabled:opacity-100")
    expect(markup).toContain("lucide-loader-circle")
    expect(markup).toContain("motion-reduce:animate-none")
    expect(markup).toContain("Unfollowing…")
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('aria-label="Unfollowing Bitcoin Bazar"')
    expect(markup).toContain('disabled=""')
  })

  it("preserves the contact-list maintenance gate and its explanation", () => {
    const markup = renderToStaticMarkup(
      <StorefrontFollowButton
        isFollowing
        merchantName="Bitcoin Bazar"
        onClick={() => undefined}
        saveState="idle"
        unavailableDescriptionId="storefront-follow-maintenance"
        writesAvailable={false}
      />
    )

    expect(markup).toContain("lucide-check")
    expect(markup).toContain(">Following<")
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('aria-describedby="storefront-follow-maintenance"')
  })
})

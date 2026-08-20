import { describe, expect, it } from "bun:test"
import type { ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { StorefrontFollowButton } from "../apps/market/src/components/StorefrontFollowButton"

type FollowButtonProps = ComponentProps<typeof StorefrontFollowButton>

function renderButton(overrides: Partial<FollowButtonProps> = {}): string {
  return renderToStaticMarkup(
    <StorefrontFollowButton
      isFollowing={false}
      merchantName="Bitcoin Bazar"
      onClick={() => undefined}
      retryAction={null}
      saveState="idle"
      writesAvailable
      {...overrides}
    />
  )
}

describe("storefront follow button", () => {
  it("keeps the initial Follow state enabled", () => {
    const markup = renderButton()

    expect(markup).toContain("bg-primary-500")
    expect(markup).toContain("lucide-user-plus")
    expect(markup).toContain(">Follow<")
    expect(markup).toContain('aria-label="Follow Bitcoin Bazar"')
    expect(markup).not.toContain('disabled=""')
  })

  it("shows an undimmed loading state while a follow is saving", () => {
    const markup = renderButton({ saveState: "saving_follow" })

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
    const markup = renderButton({ isFollowing: true })

    expect(markup).toContain("lucide-check")
    expect(markup).toContain(">Following<")
    expect(markup).toContain(">Unfollow<")
    expect(markup).toContain("Following · Unfollow")
    expect(markup).toContain("group-focus-visible:opacity-0")
    expect(markup).toContain("group-focus-visible:opacity-100")
    expect(markup).toContain("[@media(hover:none)]:inline")
    expect(markup).toContain('aria-label="Following Bitcoin Bazar; Unfollow"')
    expect(markup).not.toContain('disabled=""')
  })

  it("keeps an ambiguous follow available as an exact retry", () => {
    const markup = renderButton({ isFollowing: true, retryAction: "follow" })

    expect(markup).toContain("lucide-rotate-ccw")
    expect(markup).toContain("Retry follow")
    expect(markup).toContain('aria-label="Retry follow Bitcoin Bazar"')
    expect(markup).not.toContain(">Unfollow<")
  })

  it("keeps an ambiguous unfollow available as an exact retry", () => {
    const markup = renderButton({ retryAction: "unfollow" })

    expect(markup).toContain("lucide-rotate-ccw")
    expect(markup).toContain("Retry unfollow")
    expect(markup).toContain('aria-label="Retry unfollow Bitcoin Bazar"')
    expect(markup).not.toContain(">Follow<")
  })

  it("keeps unfollow writes visibly pending and guarded", () => {
    const markup = renderButton({ saveState: "saving_unfollow" })

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
    const markup = renderButton({
      isFollowing: true,
      unavailableDescriptionId: "storefront-follow-maintenance",
      writesAvailable: false,
    })

    expect(markup).toContain("lucide-check")
    expect(markup).toContain(">Following<")
    expect(markup).not.toContain(">Unfollow<")
    expect(markup).toContain('aria-label="Following Bitcoin Bazar"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('aria-describedby="storefront-follow-maintenance"')
  })
})

import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { renderToStaticMarkup } from "react-dom/server"
import { ProfileBanner } from "../apps/market/src/components/ProfileBanner"

describe("ProfileBanner", () => {
  it("renders a responsive decorative profile banner", () => {
    const html = renderToStaticMarkup(
      <ProfileBanner src="https://example.com/banner.jpg" />
    )

    expect(html).toContain("https://example.com/banner.jpg")
    expect(html).toContain("h-28")
    expect(html).toContain("sm:h-40")
    expect(html).toContain("lg:h-48")
    expect(html).toContain("object-cover")
    expect(html).toContain('aria-hidden="true"')
  })

  it("keeps the same stable banner surface when no image is published", () => {
    const html = renderToStaticMarkup(<ProfileBanner />)

    expect(html).toContain("data-profile-banner")
    expect(html).toContain("h-28")
    expect(html).toContain("bg-gradient-to-r")
    expect(html).toContain("from-[var(--surface-elevated)]")
    expect(html).toContain("to-[var(--surface)]")
    expect(html).not.toContain("<img")
  })

  it("keeps both public profile routes wired to the shared banner", async () => {
    const routePaths = [
      "apps/market/src/routes/store/$pubkey.tsx",
      "apps/market/src/routes/u/$profileRef.tsx",
    ]

    for (const routePath of routePaths) {
      const route = await readFile(routePath, "utf8")
      expect(route).toContain(
        'import { ProfileBanner } from "../../components/ProfileBanner"'
      )
      expect(route).toContain("<ProfileBanner src={profile?.banner} />")
    }
  })
})

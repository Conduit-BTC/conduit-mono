import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { LegalFooter } from "@conduit/ui"

describe("LegalFooter", () => {
  it("keeps only the legal links and bug report action in one row", () => {
    const markup = renderToStaticMarkup(
      <LegalFooter reportBugHref="https://example.test/issues/new?app=market" />
    )

    expect(markup).toContain("About")
    expect(markup).toContain("Terms")
    expect(markup).toContain("Privacy")
    expect(markup).toContain("Report a Bug")
    expect(markup).toContain("flex-nowrap")
    expect(markup).toContain("whitespace-nowrap")
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('referrerPolicy="no-referrer"')
    expect(markup).not.toContain("Conduit landing page")
    expect(markup).not.toContain("Resource links")
    expect(markup).not.toContain("GitHub")
    expect(markup).not.toContain("Nostr")
    expect(markup).not.toContain("Support")
  })

  it("removes off-screen mobile controls from interaction", () => {
    const markup = renderToStaticMarkup(
      <LegalFooter
        reportBugHref="https://example.test/issues/new?app=market"
        hidden
      />
    )

    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain("inert")
    expect(markup).toContain("translate-y-full")
  })

  for (const [activeHref, label] of [
    ["/about", "About"],
    ["/terms-of-service", "Terms"],
    ["/privacy-policy", "Privacy"],
  ] as const) {
    it(`marks ${label} as the non-interactive current page`, () => {
      const markup = renderToStaticMarkup(
        <LegalFooter
          activeHref={`${activeHref}/`}
          reportBugHref="https://example.test/issues/new?app=market"
        />
      )

      expect(markup).toMatch(
        new RegExp(`<span[^>]*aria-current="page"[^>]*>${label}</span>`)
      )
      expect(markup).not.toContain(`href="${activeHref}"`)
    })
  }
})

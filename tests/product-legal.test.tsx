import { createHash } from "node:crypto"
import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  PRODUCT_LEGAL_EFFECTIVE_DATE,
  PRODUCT_LEGAL_LAST_UPDATED_DATE,
  PRODUCT_LEGAL_VERSION,
  PRODUCT_LEGAL_VERSION_HISTORY,
  PRODUCT_PRIVACY_CANONICAL_URL,
  PRODUCT_TERMS_CANONICAL_URL,
  ProductPrivacyPolicy,
  ProductTermsOfService,
  WEBSITE_PRIVACY_URL,
  WEBSITE_TERMS_URL,
  getProductLegalHostMode,
  isConduitProductLegalPreviewHostname,
  isOfficialProductHostname,
  isProductLegalPath,
} from "../packages/ui/src/components"

const RELEASED_LEGAL_SOURCE =
  "packages/ui/src/legal/versions/product-legal-v1.0-2026-08-09.tsx"
const RELEASED_LEGAL_SOURCE_SHA256 =
  "fbd4105cf934f324b22d9b78c3debafd85e8f47553d7ad6d312348d502459636"

function renderOfficialDocuments(hostname: string) {
  return {
    privacy: renderToStaticMarkup(
      <ProductPrivacyPolicy deploymentHostname={hostname} />
    ),
    terms: renderToStaticMarkup(
      <ProductTermsOfService deploymentHostname={hostname} />
    ),
  }
}

describe("shared Product legal documents", () => {
  it("renders byte-identical shared documents for Shop and Sell", () => {
    const shop = renderOfficialDocuments("shop.conduit.market")
    const sell = renderOfficialDocuments("sell.conduit.market")

    expect(sell.privacy).toBe(shop.privacy)
    expect(sell.terms).toBe(shop.terms)
    expect(shop.privacy).toContain(PRODUCT_LEGAL_VERSION)
    expect(shop.terms).toContain(PRODUCT_LEGAL_VERSION)
  })

  it("puts the official-host scope notice before section 1", () => {
    const { privacy, terms } = renderOfficialDocuments("shop.conduit.market")

    for (const markup of [privacy, terms]) {
      expect(markup).toContain("shop.conduit.market")
      expect(markup).toContain("sell.conduit.market")
      expect(markup.indexOf('aria-label="Policy scope"')).toBeGreaterThan(-1)
      expect(markup.indexOf('aria-label="Policy scope"')).toBeLessThan(
        markup.indexOf("1. ")
      )
      expect(markup).toContain("conduit.market")
    }
    expect(privacy).toContain(
      "It does not describe Conduit’s marketing, educational, investor, Updates, administration, or Website analytics at conduit.market."
    )
    expect(terms).toContain(
      "They do not govern the informational Website at conduit.market"
    )
  })

  it("uses exact parameter-free Website links with no-referrer protection", () => {
    const documents = renderOfficialDocuments("shop.conduit.market")

    for (const markup of Object.values(documents)) {
      for (const href of [WEBSITE_PRIVACY_URL, WEBSITE_TERMS_URL]) {
        expect(href).not.toContain("?")
        expect(href).not.toContain("#")
        expect(markup).toContain(`href="${href}"`)
      }
      expect(markup.match(/referrerPolicy="no-referrer"/g)?.length).toBe(3)
      expect(markup.match(/rel="noopener noreferrer"/g)?.length).toBe(3)
    }
  })

  it("shows a neutral operator notice on nonofficial hosts", () => {
    const privacy = renderToStaticMarkup(
      <ProductPrivacyPolicy deploymentHostname="preview.example" />
    )

    expect(privacy).toContain("This host needs its own legal documents")
    expect(privacy).toContain("Those documents do not govern this deployment")
    expect(privacy).not.toContain(PRODUCT_LEGAL_VERSION)
    expect(privacy).not.toContain("1. Who We Are")
    expect(privacy).toContain(`href="${PRODUCT_PRIVACY_CANONICAL_URL}"`)
    expect(privacy).toContain(`href="${PRODUCT_TERMS_CANONICAL_URL}"`)

    const forkPreview = renderToStaticMarkup(
      <ProductTermsOfService
        deploymentHostname="feature.some-fork.pages.dev"
        deploymentProfile="preview"
      />
    )
    expect(forkPreview).toContain("This host needs its own legal documents")
    expect(forkPreview).not.toContain(PRODUCT_LEGAL_VERSION)
  })

  it("renders the documents for Conduit-controlled preview builds without extending their scope", () => {
    const privacy = renderToStaticMarkup(
      <ProductPrivacyPolicy
        deploymentHostname="feat-product-legal-pages.conduit-market-coo.pages.dev"
        deploymentProfile="preview"
      />
    )

    expect(privacy).toContain("Review preview")
    expect(privacy).toContain(PRODUCT_LEGAL_VERSION)
    expect(privacy).toContain("1. Who We Are")
    expect(privacy).toContain("shop.conduit.market")
    expect(privacy).toContain("sell.conduit.market")
    expect(privacy).toContain("does not make these documents applicable")
    expect(privacy).not.toContain("This host needs its own legal documents")
  })

  it("matches router-normalized legal paths and exact official hosts", () => {
    expect(isProductLegalPath("/privacy-policy")).toBe(true)
    expect(isProductLegalPath("/terms-of-service")).toBe(true)
    expect(isProductLegalPath("/privacy-policy/")).toBe(true)
    expect(isProductLegalPath("/terms-of-service///")).toBe(true)
    for (const lookalike of [
      "/privacy-policy/anything",
      "/products/privacy-policy",
      "/Privacy-Policy",
      "/privacy-policy?source=other",
      "/",
    ]) {
      expect(isProductLegalPath(lookalike)).toBe(false)
    }

    expect(isOfficialProductHostname("shop.conduit.market")).toBe(true)
    expect(isOfficialProductHostname("SELL.CONDUIT.MARKET")).toBe(true)
    expect(isOfficialProductHostname("preview.shop.conduit.market")).toBe(false)
    expect(isOfficialProductHostname("conduit.market")).toBe(false)
    expect(isOfficialProductHostname("shop.conduit.market.example")).toBe(false)

    expect(
      isConduitProductLegalPreviewHostname(
        "feat-product-legal-pages.conduit-market-coo.pages.dev"
      )
    ).toBe(true)
    expect(
      isConduitProductLegalPreviewHostname(
        "abc123.conduit-merchant-33n.pages.dev"
      )
    ).toBe(true)
    expect(
      isConduitProductLegalPreviewHostname(
        "nested.preview.conduit-market-coo.pages.dev"
      )
    ).toBe(false)
    expect(
      isConduitProductLegalPreviewHostname(
        "preview.conduit-market-coo.pages.dev.evil.example"
      )
    ).toBe(false)

    expect(
      getProductLegalHostMode(
        "feat-product-legal-pages.conduit-market-coo.pages.dev",
        "preview"
      )
    ).toBe("review-preview")
    expect(
      getProductLegalHostMode(
        "feat-product-legal-pages.conduit-market-coo.pages.dev",
        "production"
      )
    ).toBe("independent")
    expect(getProductLegalHostMode("shop.conduit.market", "unknown")).toBe(
      "official"
    )
  })

  it("pins dates and the immutable archive to the released version", async () => {
    const archive = await Bun.file(RELEASED_LEGAL_SOURCE).text()
    const digest = createHash("sha256").update(archive).digest("hex")

    expect(PRODUCT_LEGAL_EFFECTIVE_DATE).toBe("2026-08-09")
    expect(PRODUCT_LEGAL_LAST_UPDATED_DATE).toBe("2026-08-09")
    expect(PRODUCT_LEGAL_VERSION_HISTORY).toEqual([
      {
        version: PRODUCT_LEGAL_VERSION,
        effectiveDate: PRODUCT_LEGAL_EFFECTIVE_DATE,
        lastUpdatedDate: PRODUCT_LEGAL_LAST_UPDATED_DATE,
        archivedSource: RELEASED_LEGAL_SOURCE,
      },
    ])
    expect(digest).toBe(RELEASED_LEGAL_SOURCE_SHA256)
  })
})

describe("deployed Product policy accuracy", () => {
  it("documents strict kind-10050 delivery and never kind-14 fallback", async () => {
    const archive = await Bun.file(RELEASED_LEGAL_SOURCE).text()
    const profiles = await Bun.file("deploy/pages-profiles.json").json()

    expect(
      profiles.profiles.production.publicFeatures
        .dmCompatibilityOrderRoutingEnabled
    ).toBe(false)
    expect(archive).toContain(
      "A usable recipient kind-10050 private-inbox declaration controls"
    )
    expect(archive).toContain("Ordinary kind-14 direct messages do not")
    expect(archive).toContain("receive a compatibility delivery fallback")
    expect(archive).not.toContain(
      "the Product Apps may use a bounded, code-approved set"
    )
  })

  it("does not overclaim encryption, relay deletion, or telemetry retention", async () => {
    const archive = await Bun.file(RELEASED_LEGAL_SOURCE).text()

    expect(archive).toContain("unwrap and decrypt these messages locally")
    expect(archive).toContain("persistent storage")
    expect(archive).toContain("Conduit had not verified a fixed gift-wrap")
    expect(archive).toContain("event retention window of 84")
    expect(archive).toContain("months. PostHog controls that plan field")
    expect(archive).not.toContain("Conduit does not decrypt")
    expect(archive).not.toContain("only the intended recipient")
    expect(archive).not.toContain("short-lived retention")
  })
})

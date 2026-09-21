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

const PRODUCT_LEGAL_V1_0 = Object.freeze({
  version: "conduit-product-legal-v1.0-2026-08-09",
  effectiveDate: "2026-08-09",
  lastUpdatedDate: "2026-08-09",
  archivedSource:
    "packages/ui/src/legal/versions/product-legal-v1.0-2026-08-09.tsx",
  sha256: "fbd4105cf934f324b22d9b78c3debafd85e8f47553d7ad6d312348d502459636",
})
const PRODUCT_LEGAL_V1_1 = Object.freeze({
  version: "conduit-product-legal-v1.1-2026-08-09",
  effectiveDate: "2026-08-09",
  lastUpdatedDate: "2026-08-09",
  archivedSource:
    "packages/ui/src/legal/versions/product-legal-v1.1-2026-08-09.tsx",
  sha256: "94d3447fcbcf435f59fd17d21a897c76eceff44a94a33f4a58277cc39c168aaa",
})
const PRODUCT_LEGAL_V1_2 = Object.freeze({
  version: "conduit-product-legal-v1.2-2026-09-17",
  effectiveDate: "2026-09-17",
  lastUpdatedDate: "2026-09-17",
  archivedSource:
    "packages/ui/src/legal/versions/product-legal-v1.2-2026-09-17.tsx",
  sha256: "337b019bb4f56f85ca9f2f6d9142497c7dab2c733f1ac4178b06462a0c24c343",
})
const PRODUCT_LEGAL_V1_3 = Object.freeze({
  version: "conduit-product-legal-v1.3-2026-09-17",
  effectiveDate: "2026-09-17",
  lastUpdatedDate: "2026-09-17",
  archivedSource:
    "packages/ui/src/legal/versions/product-legal-v1.3-2026-09-17.tsx",
  sha256: "d2f8f097ad5446dba1e28aae4035332320f1d52177974714eb9603574b280696",
})
const PRODUCT_LEGAL_V1_4 = Object.freeze({
  version: "conduit-product-legal-v1.4-2026-09-20",
  effectiveDate: "2026-09-20",
  lastUpdatedDate: "2026-09-20",
  archivedSource:
    "packages/ui/src/legal/versions/product-legal-v1.4-2026-09-20.tsx",
  sha256: "99739eb470b0fbe0e5340283167cb68caf92af2c220722822f7499b879114c16",
})

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ")
}

async function readCurrentReleasedLegalSource(): Promise<string> {
  return normalizeWhitespace(
    await Bun.file(PRODUCT_LEGAL_V1_4.archivedSource).text()
  )
}

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

  it("pins dates and every immutable archive to the released history", async () => {
    expect(PRODUCT_LEGAL_VERSION).toBe(PRODUCT_LEGAL_V1_4.version)
    expect(PRODUCT_LEGAL_EFFECTIVE_DATE).toBe("2026-09-20")
    expect(PRODUCT_LEGAL_LAST_UPDATED_DATE).toBe("2026-09-20")
    expect(PRODUCT_LEGAL_VERSION_HISTORY).toEqual([
      {
        version: PRODUCT_LEGAL_V1_0.version,
        effectiveDate: PRODUCT_LEGAL_V1_0.effectiveDate,
        lastUpdatedDate: PRODUCT_LEGAL_V1_0.lastUpdatedDate,
        archivedSource: PRODUCT_LEGAL_V1_0.archivedSource,
      },
      {
        version: PRODUCT_LEGAL_V1_1.version,
        effectiveDate: PRODUCT_LEGAL_V1_1.effectiveDate,
        lastUpdatedDate: PRODUCT_LEGAL_V1_1.lastUpdatedDate,
        archivedSource: PRODUCT_LEGAL_V1_1.archivedSource,
      },
      {
        version: PRODUCT_LEGAL_V1_2.version,
        effectiveDate: PRODUCT_LEGAL_V1_2.effectiveDate,
        lastUpdatedDate: PRODUCT_LEGAL_V1_2.lastUpdatedDate,
        archivedSource: PRODUCT_LEGAL_V1_2.archivedSource,
      },
      {
        version: PRODUCT_LEGAL_V1_3.version,
        effectiveDate: PRODUCT_LEGAL_V1_3.effectiveDate,
        lastUpdatedDate: PRODUCT_LEGAL_V1_3.lastUpdatedDate,
        archivedSource: PRODUCT_LEGAL_V1_3.archivedSource,
      },
      {
        version: PRODUCT_LEGAL_V1_4.version,
        effectiveDate: PRODUCT_LEGAL_V1_4.effectiveDate,
        lastUpdatedDate: PRODUCT_LEGAL_V1_4.lastUpdatedDate,
        archivedSource: PRODUCT_LEGAL_V1_4.archivedSource,
      },
    ])

    for (const release of [
      PRODUCT_LEGAL_V1_0,
      PRODUCT_LEGAL_V1_1,
      PRODUCT_LEGAL_V1_2,
      PRODUCT_LEGAL_V1_3,
      PRODUCT_LEGAL_V1_4,
    ]) {
      const archive = await Bun.file(release.archivedSource).text()
      const digest = createHash("sha256").update(archive).digest("hex")
      expect(digest).toBe(release.sha256)
    }
  })

  it("selects the current archived prose in both shared document wrappers", async () => {
    const [privacyWrapper, termsWrapper] = await Promise.all([
      Bun.file("packages/ui/src/components/ProductPrivacyPolicy.tsx").text(),
      Bun.file("packages/ui/src/components/ProductTermsOfService.tsx").text(),
    ])

    for (const wrapper of [privacyWrapper, termsWrapper]) {
      expect(wrapper).toContain("product-legal-v1.4-2026-09-20")
      expect(wrapper).not.toContain("product-legal-v1.3-2026-09-17")
    }
  })

  it("pins the settlement disclosure in the v1.2 release", async () => {
    const normalizedRelease = normalizeWhitespace(
      await Bun.file(PRODUCT_LEGAL_V1_2.archivedSource).text()
    )

    expect(normalizedRelease).toContain(
      "exact positive whole-satoshi invoice amount"
    )
    expect(normalizedRelease).toContain(
      "an unusually distinctive amount and day may be correlatable"
    )
    expect(normalizedRelease).toContain(
      "It does not forward the receipt, request, invoice, or public identifiers to PostHog."
    )
  })

  it("pins the first-party aggregate commerce measurement in the v1.3 release", async () => {
    const normalizedRelease = normalizeWhitespace(
      await Bun.file(PRODUCT_LEGAL_V1_3.archivedSource).text()
    )

    expect(normalizedRelease).toContain(
      "narrowly scoped first-party service metric"
    )
    expect(normalizedRelease).toContain(
      "GPC does not suppress the first-party aggregate commerce measurement"
    )
    expect(normalizedRelease).toContain(
      "The raw order UUID is not sent to PostHog."
    )
    expect(normalizedRelease).toContain(
      "A shopper report is an estimate signal, not settlement proof."
    )
    expect(normalizedRelease).toContain(
      "a later observation may replace the earlier estimate for that same opaque event"
    )
    expect(normalizedRelease).not.toContain(
      "aggregate settled volume for verified public Zap Outs"
    )
  })

  it("pins daily aggregation and bounded dedupe retention in the v1.4 release", async () => {
    const normalizedRelease = await readCurrentReleasedLegalSource()

    expect(normalizedRelease).toContain("It does not keep a per-order amount.")
    expect(normalizedRelease).toContain(
      "It does not receive an order UUID, opaque per-order fingerprint, or per-order amount."
    )
    expect(normalizedRelease).toContain(
      "the first accepted positive estimate is retained"
    )
    expect(normalizedRelease).toContain(
      "retained through 30 days after the UTC order date"
    )
    expect(normalizedRelease).toContain(
      "provider-managed point-in-time recovery window"
    )
    expect(normalizedRelease).toContain(
      "later reconciliation is batched into fixed 12-hour windows"
    )
    expect(normalizedRelease).toContain(
      "the Worker retries the same frozen snapshot"
    )
    expect(normalizedRelease).toContain(
      "Until daily aggregation is activated for a future UTC cutover"
    )
    expect(normalizedRelease).toContain(
      "the bounded prior path sends PostHog an opaque per-order UUID"
    )
    expect(normalizedRelease).toContain(
      "PostHog receives immutable aggregate revision snapshots"
    )
    expect(normalizedRelease).toContain(
      "immediately transforms the random order UUID with a dedicated secret-keyed HMAC"
    )
    expect(normalizedRelease).toContain(
      "For daily aggregation, the HMAC input and domain are scoped to the order’s UTC calendar date."
    )
    expect(normalizedRelease).toContain(
      "Reporting selects the greatest total for each UTC order date and must not sum those snapshots."
    )
  })
})

describe("deployed Product policy accuracy", () => {
  it("documents strict kind-10050 delivery and never kind-14 fallback", async () => {
    const archive = await Bun.file(PRODUCT_LEGAL_V1_4.archivedSource).text()
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
    const archive = await Bun.file(PRODUCT_LEGAL_V1_4.archivedSource).text()

    expect(archive).toContain("unwrap and decrypt these messages locally")
    expect(archive).toContain("persistent storage")
    expect(archive).toContain("Conduit had not verified a fixed gift-wrap")
    expect(archive).toContain("event retention window of 84")
    expect(archive).toContain("months. PostHog controls that plan field")
    expect(archive).not.toContain("Conduit does not decrypt")
    expect(archive).not.toContain("only the intended recipient")
    expect(archive).not.toContain("short-lived retention")
  })

  it("states that every queried inbox relay sees its filter without requiring AUTH", async () => {
    const archive = await readCurrentReleasedLegalSource()

    expect(archive).toContain(
      "Each queried relay can observe the request filter"
    )
    expect(archive).toContain(
      "even if it returns no event and even if NIP-42 is not used."
    )
    expect(archive).toContain(
      "every queried relay can observe the recipient-scoped filter."
    )
  })

  it("does not treat NIP-42 support or a prior response as proof of enforcement", async () => {
    const archive = await readCurrentReleasedLegalSource()

    expect(archive).toContain(
      "does not by itself prove that a relay prevents every unauthorized request."
    )
    expect(archive).toContain(
      "a relay that does not challenge may still return encrypted gift wraps without authentication."
    )
  })

  it("distinguishes no public-read account proof from network anonymity", async () => {
    const archive = await readCurrentReleasedLegalSource()

    expect(archive).toContain(
      "do not intentionally send an NIP-42 account proof or prompt the signer."
    )
    expect(archive).toContain("They are not anonymous at the network layer")
    expect(archive).toContain(
      "Ordinary public reads do not request that account proof, but they are not anonymous at the network layer."
    )
  })

  it("documents the legacy NIP-04 lane as read-only and outside protected reads", async () => {
    const archive = await readCurrentReleasedLegalSource()

    expect(archive).toContain("may also retrieve legacy NIP-04 direct messages")
    expect(archive).toContain(
      "They do not publish new legacy kind-4 direct messages."
    )
    expect(archive).toContain("does not protect these legacy reads.")
  })

  it("separates logout cleanup from retained account-scoped caches", async () => {
    const archive = await readCurrentReleasedLegalSource()

    expect(archive).toContain(
      "When the Product Apps process a sign-out or disconnect, or detect an account switch or loss of signer authority, they close that session’s authenticated relay connections"
    )
    expect(archive).toContain(
      "This does not necessarily delete account-scoped messages, orders, relay settings, wallet information, or other browser caches"
    )
    expect(archive).toContain(
      "attempt to erase saved authentication-session and NIP-46 client-key material"
    )
  })
})

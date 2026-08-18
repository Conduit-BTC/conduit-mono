# Product Legal Documents

This note records the public implementation boundary for the Product Privacy
Policy and Product Terms of Service. It does not replace either document.

## Official Products And URLs

- Conduit Shop is the `apps/market` deployment at `shop.conduit.market`.
- Conduit Sell is the `apps/merchant` deployment at `sell.conduit.market`.
- Shop hosts the canonical Product Privacy Policy and Product Terms URLs.
- Sell renders the same shared version at `/privacy-policy` and
  `/terms-of-service`; its canonical metadata points to the corresponding Shop
  URL.
- Website documents at `conduit.market` are separate and are linked with exact,
  parameter-free URLs and a no-referrer policy.

The existing NIP-89 source identities `Conduit Market` and `Conduit Merchant
Portal` remain protocol provenance names. They do not change the public Product
names above.

## Shared Source And Releases

`packages/ui/src/legal/versions/` contains released, append-only legal prose.
`ProductPrivacyPolicy.tsx` and `ProductTermsOfService.tsx` select the released
archived prose for both apps. `ProductLegalVersion.ts` supplies the matching
stable version identifier, dates, canonical URLs, host rules, and append-only
release history. Thin app routes render the shared components; they must not
copy legal prose into app-local files.

A wording change is a proposal until a maintainer creates a new archived source,
assigns its effective date, preserves every prior history entry and archive hash,
updates both shared document wrappers and the matching version metadata, and
publishes both apps. Do not edit an archived version in place or allow a merge
alone to imply a new effective version.

The legal prose is excluded from the repository's MIT grant. Forks and other
hosts must provide documents appropriate to their operator. At runtime, unknown
hosts show a neutral operator notice instead of representing that Conduit
operates the deployment or that the official Product terms govern it.

Conduit-controlled Cloudflare branch previews are a narrow review exception.
The client requires both the checked-in `preview` deployment profile and a
known, single-label Conduit Pages project hostname before rendering the exact
shared documents with a conspicuous review-only banner and `noindex` metadata.
The banner states that the preview is not an official Product App host and that
displaying the text there does not extend the documents' official-host scope.
Arbitrary `pages.dev` hosts, nested/lookalike hostnames, and non-preview builds
continue to receive the neutral operator notice.

## Public Route Isolation

`/privacy-policy` and `/terms-of-service` are the only public legal paths. Each
app checks that exact set before starting its ordinary providers and workers. A
direct legal load renders only the router and shared legal document: no signer
restoration, Conduit session, Nostr connection, cache pruning, delivery worker,
price warmup, readiness, payment automation, or product telemetry.

All links into and between Product legal pages are ordinary anchors so navigation
performs a full document load and re-evaluates the startup boundary. Cross-origin
links use `referrerPolicy="no-referrer"` and `rel="noopener noreferrer"`.

## Coordinated Publication

Deploy and verify all four Product URLs before replacing the Website documents.
Then publish the Website policies and reciprocal links promptly, verify the
canonical and no-referrer behavior, and announce the effective versions
together. Avoid leaving conflicting Product and Website scope notices live for
an extended period.

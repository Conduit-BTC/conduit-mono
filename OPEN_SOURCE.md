# Open Source And Reproducible Build Notes

This repository is intended to be public, inspectable, and rebuildable from source.

## Licensing Posture

- Code and redistributable bundled assets in this repository are MIT-licensed unless noted otherwise.
- Released Product Privacy Policy and Product Terms prose under
  `packages/ui/src/legal/versions/` is not licensed under MIT. See the Legal
  Content and Trademarks Exception in [LICENSE](./LICENSE).
- Conduit trademarks and logos are reserved under the trademark policy in [TRADEMARKS.md](./TRADEMARKS.md).

Forks may reuse the surrounding software under MIT, but must provide notices and
terms appropriate to their own operator. The official Product documents apply
only to `shop.conduit.market` and `sell.conduit.market`.

Released files in `packages/ui/src/legal/versions/` are append-only. Community
wording changes are proposals until a maintainer publishes a new version with an
explicit effective date; editing an archived version does not revise the terms
that were released under that identifier.

## Reproducible Build Goal

Conduit aims to keep the shipped client apps rebuildable from the public repository without requiring private build inputs.

That means:

- production font assets used by the app bundle must be public and redistributable
- app source, shared package code, and bundled assets required for the build should live in this repository
- official deployments should map back to a public commit

## Current Build Inputs

The current client build expects:

- Bun
- workspace dependencies from `package.json` and `bun.lock`
- checked-in app and package source
- checked-in public font assets used by the design system

## Provenance Direction

For released client builds, Conduit should expose:

- app version
- commit SHA
- source repository URL

This keeps deployments auditable and makes it easier for reviewers, contributors, and funders to verify what is running.

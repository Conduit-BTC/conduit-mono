# Documentation Index

This directory contains public implementation context for the `conduit-mono` client repository. It is not a product strategy doc, ticket tracker, or private planning archive.

## Source of Truth

- `docs/ARCHITECTURE.md`: system design, protocol boundaries, and data flow
- `docs/DESIGN.md`: shared design system and theming guidance
- `docs/specs/*`: active feature, protocol, and product requirements
- `docs/nips/*`: compact Nostr implementation notes that point back to active specs and canonical public NIPs
- `docs/knowledge/*`: supporting notes, research, and references that may inform implementation but do not replace the source-of-truth docs above

## Working Model

1. Use this repo's docs for implemented behavior, accepted implementation contracts, and agent preflight context.
2. Keep product strategy, ownership, priority, private commercial plans, and private operating context outside tracked public docs.
3. Use `docs/specs/*` when product, protocol, or shared implementation behavior needs a stable contract.
4. Merge the relevant docs/spec PR to `main` before implementation when work changes requirements, protocol behavior, or shared expectations.
5. If an external tracker conflicts with `docs/specs/*` or `docs/ARCHITECTURE.md` on implementation behavior, stop and update the repo contract before coding.

## Reviewer-Owned Context Follow-Up

Implementation PRs should stay focused on implementation unless they are explicitly docs/spec PRs or the docs edit is directly local and required for correctness.

Reviewers own the judgment about whether a merged implementation changed durable repo context. During review, choose one of:

- `No docs follow-up needed`
- `Docs-only PR after merge`
- `Docs/spec PR required before merge`

Use `Docs/spec PR required before merge` when the implementation changes product requirements, protocol behavior, shared UX rules, architecture, or cross-team implementation expectations that are not already covered by repo contracts.

Use `Docs-only PR after merge` when the implementation fits the current contract but reveals that docs, agent routing, source references, or examples should be clarified. That follow-up PR should reference the merged implementation PR and relevant tracker issue when available, contain docs-only changes, and be reviewed separately.

Agents may surface possible docs drift and draft the follow-up when asked, but they should not silently bundle broad repo-context updates into ordinary code PRs.

## Where To Put New Docs

- Add new architecture-level material to `docs/ARCHITECTURE.md` only with explicit approval.
- Add stable feature or protocol requirements under `docs/specs/`.
- Add compact Nostr implementation notes under `docs/nips/`; keep them short and link back to `docs/specs/protocol.md` plus canonical public sources.
- Add shared visual and theming guidance to `docs/DESIGN.md`.
- Add public-safe research notes, interop references, and non-authoritative supporting context under `docs/knowledge/`.

Do not add product strategy, private commercial, private service, release coordination, or team operating-system notes to this repository.

## Nostr Source Policy

Before changing Nostr protocol, relay, signer, payment, messaging, product-event, cache, or outbox behavior, read `docs/knowledge/external-nostr-references.md` and the relevant repo spec. Public protocol sources must be checked before implementation, not after review.

## Public Repo Posture

Tracked docs should remain safe for a public `conduit-mono` repo:

- keep language centered on Market, Merchant, Store Builder, shared packages, and protocol/spec implementation
- avoid private company planning language in tracked docs
- keep non-implemented business plans and private service concepts outside this repository

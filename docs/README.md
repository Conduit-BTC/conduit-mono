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
4. When work changes requirements, protocol behavior, shared UX rules, or shared expectations, update the relevant repo contract in the implementation PR before merge.
5. If an external tracker conflicts with `docs/specs/*` or `docs/ARCHITECTURE.md`, resolve the contract mismatch before merge.

## Same-PR Contract Gate

Implementation PRs should distinguish `Contract changes` from `Implementation changes`. Include required changes to `docs/specs/*`, `docs/ARCHITECTURE.md`, or `docs/DESIGN.md` in the same PR so reviewers can evaluate the contract and code together.

During review, choose one of:

- `Contract updated in this PR`
- `No contract change needed`
- `Separate decision/docs-only PR required`

Block merge when a required contract change is missing or disagrees with the implementation. Do not require a separate PR solely because the contract and implementation changed together.

Use `Separate decision/docs-only PR required` only for broad cross-PR architecture or external consensus that must be settled before implementation.

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

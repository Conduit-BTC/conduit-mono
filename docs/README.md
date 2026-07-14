# Documentation Index

This directory contains public implementation context for the `conduit-mono` client repository. It is not a product strategy doc, ticket tracker, or private planning archive.

## Source of Truth

- `docs/ARCHITECTURE.md`: system design, protocol boundaries, and data flow
- `docs/DESIGN.md`: shared design system and theming guidance
- `docs/specs/*`: durable feature, protocol, and product contracts where the repository maintains one
- `docs/nips/*`: compact Nostr implementation notes linked to canonical public NIPs
- `docs/knowledge/*`: public-safe implementation notes, research, interoperability references, and reusable agent context

## Working Model

1. Use this repo's docs for implemented behavior, accepted implementation contracts, and agent preflight context.
2. Keep product strategy, ownership, priority, private commercial plans, and private operating context outside tracked public docs.
3. Read an existing `docs/specs/*` contract when it applies, but do not create or update a spec for ordinary implementation work by default.
4. Add or update `docs/knowledge/*` in the implementation PR when public-safe context will materially help future contributors or agents.
5. Update a durable spec, architecture, or design contract when a maintainer requests it or the change genuinely requires a stable public contract.

## Implementation Context

Non-trivial internal work should begin with a concise implementation plan. When the work has a Linear issue and the agent has authenticated access, post the plan as a Linear comment before or alongside opening the implementation PR. Keep that private planning context and private tracker links out of public Git history.

Public PRs should identify the existing implementation context they checked and any public context they changed. Useful `docs/knowledge/*.md` notes may land with the code. A new spec document is not a default merge gate.

Reviewers may request a durable contract update when the behavior has broad or long-lived public implications, but should not block an otherwise complete change solely because it lacks spec churn.

## Where To Put New Docs

- Add new architecture-level material to `docs/ARCHITECTURE.md` only with explicit approval.
- Add stable feature or protocol requirements under `docs/specs/` when a maintainer requests a durable contract.
- Add compact Nostr implementation notes under `docs/nips/`; keep them short and link to canonical public sources.
- Add shared visual and theming guidance to `docs/DESIGN.md`.
- Add public-safe research notes, interop references, and non-authoritative supporting context under `docs/knowledge/`.

Do not add product strategy, private commercial, private service, release coordination, or team operating-system notes to this repository.

## Nostr Source Policy

Before changing Nostr protocol, relay, signer, payment, messaging, product-event, cache, or outbox behavior, read `docs/knowledge/external-nostr-references.md`, any applicable existing repo contract, and the relevant public protocol source. Public protocol sources must be checked before implementation, not after review.

## Public Repo Posture

Tracked docs should remain safe for a public `conduit-mono` repo:

- keep language centered on Market, Merchant, Store Builder, shared packages, and protocol/spec implementation
- avoid private company planning language in tracked docs
- keep non-implemented business plans and private service concepts outside this repository

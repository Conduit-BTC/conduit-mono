# Documentation Index

This directory contains public implementation context for the `conduit-mono` client repository. It is not a product strategy doc, ticket tracker, or private planning archive.

## Source of Truth

- `docs/PROTOCOLS.md`: public, status-aware inventory of NIPs and other open protocols used by the clients
- `docs/OPEN_MARKETS.md`: commerce implementation map, compatibility differences, examples, and experimental proposal status
- `docs/ARCHITECTURE.md`: system design, protocol boundaries, and data flow
- `docs/DESIGN.md`: shared design system and theming guidance
- `docs/specs/*`: durable feature, protocol, and product contracts where the repository maintains one
- `docs/nips/*`: compact Nostr implementation notes linked to canonical public NIPs
- `docs/knowledge/*`: public-safe implementation notes, research, interoperability references, and reusable agent context

## Task routes

Read `AGENTS.md` at startup. This index is for finding applicable context,
not a required second startup read.

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

### Shared Protocol Boundaries

- `docs/specs/universal-checkout-router.md`: coordinated upfront checkout,
  frozen payment authority, isolated-wallet Merchant recovery and historical
  order compatibility
- `docs/knowledge/public-event-verification.md`: immutable public admission,
  typed parser and restore boundaries, caller inventory, and browser evidence
- `docs/knowledge/commerce-inbox-recovery.md`: account-owned encrypted inbox,
  history recovery, commerce codecs, immutable delivery and runtime evidence
- `docs/knowledge/signed-event-publication.md`: plain signed-event writer,
  fixed relay targets, retry ownership, and per-relay delivery evidence
- `docs/specs/event-markets.md`: organizer-authored Event Market and NIP-52
  calendar, causal merchant authorization, product association, checkout and
  private handoff provenance; current-model cutover and repost-only old links
- `docs/knowledge/event-market-collection-extension.md`: retirement notice for
  the removed collection-based Event Market extension
- `docs/knowledge/decentralized-network-product-posture.md`: product decisions
  under partial, delayed, divergent, and unevenly adopted network state
- `docs/knowledge/compatibility-exception-template.md`: required governance for
  named, bounded protocol-migration exceptions
- `docs/knowledge/product-deletion-convergence.md`: durable NIP-09 evidence,
  source-aware delivery, retry, and cross-surface product resolution
- `docs/knowledge/product-legal-documents.md`: official-host scope, shared legal
  source, versioning, release, and public-route isolation
- `docs/knowledge/nip42-protected-read-rollout.md`: recipient-scoped protected
  inbox authentication, relay operator contract, and client-first rollout

- `docs/knowledge/merchant-shipping-tables.md`: signed shipping tables, local
  combined-weight calculation, fixed-option compatibility, and order evidence

### QA Runbooks

- `docs/knowledge/checkout-spark-native-treasury.md`: one final native Spark
  collection, exact residual accounting, recovery and funded-validation boundary
- `docs/knowledge/quantum-router-deployment.md`: public activation and treasury
  configuration, frozen destination rotation and current checkout admission scope
- `docs/knowledge/checkout-with-conduit.md`: public V1 product/cart link format,
  validation limits, relay hints, and checkout authority.
- `docs/knowledge/product-search-ranking.md`: ranked product search, scoped
  author requests, signed reconciliation, and observed category-filter limits

- `docs/knowledge/event-catalog-progressive-loading.md`: progressive browsing,
  scoped query sharing, and the boundary between display and pickup authorization
- `docs/knowledge/merchant-product-mutation-boundary.md`: owned-product editing
  without organizer verification, unchanged fulfillment, and regression coverage

- `docs/knowledge/event-market-lifecycle.md`: signed open/closed acceptance,
  current-model history, printable QR signs, and coordinated release/rollback
- `docs/knowledge/event-market-validation-evidence.md`: stable event-market
  acceptance/evidence IDs, candidate-head test mapping, and live-validation gaps
- `docs/knowledge/mobile-safari-qa-baseline.md`: repeatable mobile browser and
  physical-device matrix for Market, Merchant, Wallet, and booth flows

### Active Compatibility Exceptions

- `docs/knowledge/checkout-spark-recipient-verification-compat.md`: provider-neutral
  ordinary receiver qualification, exact invoice association, independent
  settlement evidence, historical compatibility and live acceptance gates
- `docs/knowledge/commerce-inbox-recovery.md`: bounded authenticated client-seal
  metadata read compatibility, accounting and maintainer activation/removal gates
- `docs/knowledge/nip17-inbox-bootstrap-migration.md`: temporary validated-order
  compatibility routing while users migrate to discoverable NIP-17 inbox
  declarations
- `docs/knowledge/nip46-connected-relay-retention.md`: temporary retention of
  established secure NIP-46 relays until relay migration can complete or cancel
  without mutating a returned signer after timeout

## Where To Put New Docs

- Add new architecture-level material to `docs/ARCHITECTURE.md` only with explicit approval.
- Add stable feature or protocol requirements under `docs/specs/` when a maintainer requests a durable contract.
- Add compact Nostr implementation notes under `docs/nips/`; keep them short and link to canonical public sources.
- Add shared visual and theming guidance to `docs/DESIGN.md`.
- Add public-safe research notes, interop references, and non-authoritative supporting context under `docs/knowledge/`.

Do not add product strategy, private commercial, private service, release coordination, or team operating-system notes to this repository.

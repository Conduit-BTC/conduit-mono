# Documentation Index

This directory is organized by document intent so the team can keep live execution in Linear while keeping durable implementation contracts in the repo.

## Source of Truth

- `docs/ARCHITECTURE.md`: system design, protocol boundaries, and data flow
- `docs/DESIGN.md`: shared design system and theming guidance
- `docs/plans/*`: phase boundaries, exit criteria, and temporary delivery contracts
- `docs/specs/*`: active feature, protocol, and product requirements
- `docs/knowledge/*`: supporting notes, research, references, future concepts, and working context that may inform implementation but do not replace the source-of-truth docs above
- `docs/knowledge/future/*`: parked future product/service ideas that are intentionally not current `conduit-mono` implementation contracts

## Working Model

1. Use Linear for live execution status, ownership, sequencing, priority, and merge order.
2. Use `docs/plans/*` only for phase boundaries, exit criteria, and temporary delivery contracts.
3. Use `docs/specs/*` when product, protocol, or shared implementation behavior needs a stable contract.
4. Merge the relevant docs/spec PR to `main` before starting the implementation `feat/*` branch when the work changes requirements or shared expectations.
5. When a phase document's exit criteria appear complete, agents should prompt the user to archive or delete the temporary phase document and move the next phase fully to Linear-owned planning.
6. If Linear conflicts with `docs/plans/*` on live execution, Linear wins. If Linear conflicts with `docs/specs/*` or `docs/ARCHITECTURE.md` on implementation behavior, stop and ask for a docs/spec update before coding.

## Where To Put New Docs

- Add new architecture-level material to `docs/ARCHITECTURE.md` only with explicit approval.
- Add new phase or delivery planning material under `docs/plans/` only when the repo needs a temporary public delivery contract. Keep ticket status and sequencing in Linear.
- Add stable feature or protocol requirements under `docs/specs/`.
- Add shared visual and theming guidance to `docs/DESIGN.md`.
- Add research notes, interop references, future ideas, and non-authoritative supporting context under `docs/knowledge/`.

## Nostr Source Policy

Before changing Nostr protocol, relay, signer, payment, messaging, product-event, cache, or outbox behavior, read `docs/knowledge/external-nostr-references.md` and the relevant repo spec. Public protocol sources must be checked before implementation, not after review.

## Public Repo Posture

Tracked docs should remain safe for a public `conduit-mono` repo:

- keep language centered on Market, Merchant, Store Builder, shared packages, and protocol/spec implementation
- avoid private company planning language in tracked docs
- keep future services, billing, monetization, and generated-store discussions out of active specs unless the repo structure and accepted scope change

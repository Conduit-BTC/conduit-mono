# Documentation Index

This directory is organized by document intent so the team can keep execution in Linear while keeping implementation contracts in the repo.

## Source of Truth

- `docs/ARCHITECTURE.md`: system design, protocol boundaries, and data flow
- `docs/DESIGN.md`: shared design system and theming guidance
- `docs/plans/*`: roadmap and execution plans
- `docs/specs/*`: feature, protocol, and product requirements
- `docs/knowledge/*`: supporting notes, research, references, and working context that may inform implementation but do not replace the source-of-truth docs above

## Working Model

1. Use Linear for execution status, ownership, and sequencing.
2. Use `docs/plans/*` to describe delivery scope and the current phase.
3. Use `docs/specs/*` when product, protocol, or shared implementation behavior needs a stable contract.
4. Merge the relevant docs/spec PR to `main` before starting the implementation `feat/*` branch when the work changes requirements or shared expectations.

## Where To Put New Docs

- Add new architecture-level material to `docs/ARCHITECTURE.md` only with explicit approval.
- Add new phase or delivery planning material under `docs/plans/`.
- Add stable feature or protocol requirements under `docs/specs/`.
- Add shared visual and theming guidance to `docs/DESIGN.md`.
- Add research notes, interop references, and non-authoritative supporting context under `docs/knowledge/`.

## Public Repo Posture

Tracked docs should remain safe for a public `conduit-mono` repo:

- keep language centered on Market, Merchant, Store Builder, shared packages, and protocol/spec implementation
- avoid private company planning language in tracked docs
- keep future `conduit-services` discussion clearly separate from the current repo unless the repo structure changes

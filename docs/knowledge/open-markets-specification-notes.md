# Open Markets Specification: Maintained Interop Notes

This is the maintained, implementation-oriented commerce specification note for Conduit engineers and agents.

Last reviewed: 2026-08-30

## Active Working And Governance Venue

- Repository and specification home:
  - https://github.com/OpenMarketsFoundation/specification
- Current default-branch working specification:
  - https://github.com/OpenMarketsFoundation/specification/blob/main/README.md
- Purpose: an evolving interoperable commerce framework on Nostr, including `kind:30402` product listings and related marketplace flows.
- Lineage: the Open Markets work derives from the earlier GammaMarkets `market-spec`, which remains useful for historical and deployed compatibility context.

The current default-branch README describes a draft. Conduit treats the repository as the active public working and governance venue while preserving NIP-99 as the upstream Nostr reference. Branch-only proposals are non-normative until accepted on the default branch.

## Navigation Transition

[Open Markets PR #1](https://github.com/OpenMarketsFoundation/specification/pull/1) proposes a reorganized navigation model with:

- `SPEC.md` for specification text
- `pillars/items.md` for item and listing semantics
- `pillars/delivery.md` for delivery semantics

As of this review, PR #1 is open, non-draft, and unmerged. Those paths do not exist on the default branch, are non-normative, and are not stable canonical links. After PR #1 merges, verify each path on the default branch before changing Conduit references.

## Accepted Source And Proposal Boundary

- NIP-99 remains the upstream Nostr protocol reference for commerce listings.
- Current default-branch Open Markets material is the active working commerce reference.
- Branch-only proposal documents are experimental and non-normative until accepted on the default branch.
- Do not implement proposal-only event kinds, tag grammar, schemas, or validation rules merely because a proposal exists.
- When a proposal is accepted, cite its final stable location and review the behavior change separately from reference-governance cleanup.

[Open Markets PR #13](https://github.com/OpenMarketsFoundation/specification/pull/13) proposes versioned `destination_schema` tags and typed destination constraints. As of this review, it is an open draft stacked on PR #1. It is experimental, branch-only, and non-normative.

Conduit reads only the exact proposed version `1` grammar and fails closed for
malformed or unknown versions. Detailed subdivision and postal authoring is a
preview-only deployment feature; production and staging authoring remain off.
This allows interoperability testing without presenting the proposal as
accepted public specification behavior. Country-only per-destination rates do
not depend on the proposal.

## Conduit Implementation Policy

- Prefer working-spec-aligned behavior in `@conduit/core` before app-local implementations.
- Be liberal in safe compatibility parsing and conservative in emitted events.
- Keep external quirks behind explicit compatibility handling and document them in [external-market-interop-policy.md](./external-market-interop-policy.md).
- Treat backwards-incompatible changes as exceptional and require an explicit decision and migration plan.
- Recheck the current public Open Markets and NIP sources before changing event kinds, tag grammar, parsing, publishing, or validation.

## Current Kind-30402 Anchors

The current default-branch working specification describes:

- product listings as addressable `kind:30402` events
- human-readable Markdown-capable product descriptions in `content`
- required `d`, `title`, and `price` tags
- optional structured product, media, location, category, collection, and shipping references in tags

These anchors summarize the public working source; they do not replace it.

## External Compatibility Targets

- Plebeian Market: https://github.com/PlebeianApp/market
- Earlier GammaMarkets specification and compatibility note:
  - [gamma-market-spec-notes.md](./gamma-market-spec-notes.md)
- Conduit interoperability policy:
  - [external-market-interop-policy.md](./external-market-interop-policy.md)

# Open Markets Specification: Maintained Interop Notes

This is the maintained, implementation-oriented commerce specification note for Conduit engineers and agents.

Last reviewed: 2026-08-07

## Active Source

- Repository and specification home:
  - https://github.com/OpenMarketsFoundation/specification
- Current default-branch specification document:
  - https://github.com/OpenMarketsFoundation/specification/blob/main/README.md
- Purpose: an evolving interoperable commerce framework on Nostr, including `kind:30402` product listings and related marketplace flows.
- Lineage: the Open Markets work derives from the earlier GammaMarkets `market-spec`, which remains useful for historical and deployed compatibility context.

The current default-branch document is marked as a draft. Conduit still treats it as the active public commerce reference while preserving NIP-99 as the upstream Nostr reference and verifying the public source before protocol-sensitive changes.

## Navigation Transition

[Open Markets PR #1](https://github.com/OpenMarketsFoundation/specification/pull/1) proposes a reorganized navigation model with:

- `SPEC.md` for normative text
- `pillars/items.md` for item and listing semantics
- `pillars/delivery.md` for delivery semantics

As of this review, PR #1 is open, non-draft, and unmerged. Those paths do not exist on the default branch and are not stable canonical links yet. After PR #1 merges, verify each path on the default branch before changing Conduit references.

## Normative And Proposal Boundary

- Default-branch specification text and accepted pillars are the active implementation inputs.
- Proposal documents are experimental until accepted into the normative specification.
- Do not implement proposal-only event kinds, tag grammar, schemas, or validation rules merely because a proposal exists.
- When a proposal is accepted, cite its final stable location and review the behavior change separately from reference-governance cleanup.

[Open Markets PR #13](https://github.com/OpenMarketsFoundation/specification/pull/13) proposes versioned `destination_schema` tags and typed destination constraints. As of this review, it is a stacked draft, is explicitly experimental, and does not modify the current normative specification.

## Conduit Implementation Policy

- Prefer spec-aligned behavior in `@conduit/core` before app-local implementations.
- Be liberal in safe compatibility parsing and conservative in emitted events.
- Keep external quirks behind explicit compatibility handling and document them in [external-market-interop-policy.md](./external-market-interop-policy.md).
- Treat backwards-incompatible changes as exceptional and require an explicit decision and migration plan.
- Recheck the current public Open Markets and NIP sources before changing event kinds, tag grammar, parsing, publishing, or validation.

## Current Kind-30402 Anchors

The current default-branch specification describes:

- product listings as addressable `kind:30402` events
- human-readable Markdown-capable product descriptions in `content`
- required `d`, `title`, and `price` tags
- optional structured product, media, location, category, collection, and shipping references in tags

These anchors summarize the public source; they do not replace it.

## External Compatibility Targets

- Plebeian Market: https://github.com/PlebeianApp/market
- Earlier GammaMarkets specification and compatibility note:
  - [gamma-market-spec-notes.md](./gamma-market-spec-notes.md)
- Conduit interoperability policy:
  - [external-market-interop-policy.md](./external-market-interop-policy.md)

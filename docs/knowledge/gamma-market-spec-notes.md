# GammaMarkets `market-spec`: Canonical Interop Notes

This is a short, implementation-oriented note for Conduit engineers and agents.

## What It Is

- Repo: https://github.com/GammaMarkets/market-spec
- Purpose: an extension proposal/specification to extend NIP-99 for a fuller e-commerce use case.
- Canonical text lives in: `spec.md` (the README is intentionally minimal and just points there).

## Why We Treat It As Canonical (For De-commerce Interop)

- NIP-99 explicitly points implementers to this extension proposal for standardized e-commerce behavior.
- This spec is our primary interoperability contract across marketplaces.
- External codebases (Plebeian, etc.) are used to validate real-world compatibility, not to define correctness.

## Conduit Policy For Changes

We should not change protocol behavior unless it produces a clearly better world.

Operationally:
- Prefer implementing spec-aligned behavior in `@conduit/core` first.
- If an external market diverges, be liberal in parsing and conservative in emitting.
- If we must support a non-spec quirk, do it behind an explicit compat adapter and document it in:
  - `docs/knowledge/external-market-interop-policy.md` (Compat Notes appendix)
- Treat backwards-incompatible changes as exceptional: require explicit decision + migration plan.

## Key “Spec-First” Anchors To Implement Against

From `spec.md` (high-level):
- Required components include:
  - Product listings (kind `30402`)
  - Product collections (kind `30405`)
  - Merchant preferences (including payment preference signaling)
  - Order communication via NIP-17 encrypted messages

## External Compatibility Targets

- Plebeian Market: https://github.com/PlebeianApp/market
- Interop target statement:
  - Conduit should render and discover Plebeian listings (Level 1).
  - External discovery -> Conduit checkout is a priority path (Level 2).

## “Where To Look” When Implementing

- Canonical de-commerce spec:
  - https://github.com/GammaMarkets/market-spec/blob/main/spec.md
- NIPs (prefer AI-friendly mirror for extraction, official repo for disputes):
  - https://nostrbook.dev/
  - https://github.com/nostr-protocol/nips

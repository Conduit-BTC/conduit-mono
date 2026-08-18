# GammaMarkets `market-spec`: Historical And Compatibility Notes

This note preserves provenance and deployed compatibility context from the earlier GammaMarkets commerce specification. The maintained active reference is [open-markets-specification-notes.md](./open-markets-specification-notes.md).

## What It Is

- Repo: https://github.com/GammaMarkets/market-spec
- Historical purpose: an extension proposal/specification to extend NIP-99 for a fuller e-commerce use case.
- Historical specification text: `spec.md` (the README is intentionally minimal and points there).
- Current governance: the Open Markets repository is the active working venue. Do not use this repository as the governing source for new protocol behavior.

## Why We Retain It

- It records the lineage of the commerce model now maintained through the Open Markets venue.
- Deployed marketplaces and Conduit compatibility handling may still reflect this earlier wire behavior.
- External codebases (Plebeian, etc.) are used to validate real-world compatibility, not to define correctness.

## Conduit Compatibility Policy

Do not derive new protocol behavior from this historical source when the current default-branch Open Markets working specification differs or is silent.

Operationally:

- Prefer implementing Open Markets/NIP-99-aligned behavior in `@conduit/core` first.
- If an external market diverges, be liberal in parsing and conservative in emitting.
- If we must support a non-spec quirk, do it behind an explicit compat adapter and document it in:
  - `docs/knowledge/external-market-interop-policy.md` (Compat Notes appendix)
- Treat backwards-incompatible changes as exceptional: require explicit decision + migration plan.

## Earlier Wire Anchors To Preserve In Compatibility Review

The earlier `spec.md` described:

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

## Where To Look

- Active commerce working specification:
  - https://github.com/OpenMarketsFoundation/specification
- Earlier GammaMarkets specification text:
  - https://github.com/GammaMarkets/market-spec/blob/main/spec.md
- NIPs (prefer AI-friendly mirror for extraction, official repo for disputes):
  - https://nostrbook.dev/
  - https://github.com/nostr-protocol/nips

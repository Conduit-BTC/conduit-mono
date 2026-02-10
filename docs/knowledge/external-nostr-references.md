# External Nostr References (AI + Engineering)

This document is a curated set of external references we rely on for protocol details, implementation patterns, and interoperability.

## Nostr NIPs (Protocol Specs)

- Nostrbook (AI-friendly NIPs mirror)
  - https://nostrbook.dev/
  - Source repo: https://gitlab.com/soapbox-pub/nostrbook
- Official NIPs repo (canonical, less AI-friendly)
  - https://github.com/nostr-protocol/nips

Guidance:
- Prefer Nostrbook for fast, accurate extraction of NIP requirements during implementation.
- When behavior is disputed, treat the official NIPs repo as the final arbiter.

## Libraries and Tools

- Nostrify (common tools/utilities)
  - https://gitlab.com/soapbox-pub/nostrify
- Nostr UX patterns (product + UX conventions)
  - https://github.com/shawnyeager/nostr-ux-patterns
- Nostr WS Inspector (Chrome extension, debugging relays)
  - https://chromewebstore.google.com/detail/nostr-ws-inspector/pchfingijipdcdimblhpahbolijmblmn

## De-commerce Interop: GammaMarkets Market Spec

- Market spec repo (interoperability baseline for de-commerce apps)
  - https://github.com/GammaMarkets/market-spec

Notes:
- This repo is referenced by NIP-99 and is effectively the cross-app compatibility contract for de-commerce.
- We can propose and land changes (with rough consensus), but must preserve interoperability.
- Prefer backwards-compatible evolution. Breaking changes should be treated as exceptional and will be scrutinized heavily.


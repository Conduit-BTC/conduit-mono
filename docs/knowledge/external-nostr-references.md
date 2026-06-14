# External Nostr References (AI + Engineering)

This document is a curated set of external references we rely on for protocol details, implementation patterns, and interoperability.

Last reviewed: 2026-06-14

## Agent Preflight

Use this file before changing any Nostr-sensitive code or docs:

- event kinds, tags, product parsing/emission, order payloads, or public event content
- relay discovery, relay health, relay routing, WebSocket behavior, fallback, or source freshness
- NIP-17/NIP-44/NIP-59 private messages, order messages, DMs, unwrap/decrypt logic, or message diagnostics
- external signer auth, NIP-46 signer UX, relay AUTH, NWC, Lightning payment requests, or payment proof handling
- Dexie/local-cache/outbox behavior that affects signed events, relay convergence, retry, or local truth projection

Before implementation:

1. Read the relevant repo contract in `docs/specs/*` or `docs/ARCHITECTURE.md`.
2. Read the relevant public NIP or GammaMarkets source below.
3. State the public source in the PR under `Source docs/specs`.
4. Keep protocol construction and relay planning in `@conduit/core` unless the PR explains why route-local behavior is unavoidable.
5. If a public protocol source and a repo doc disagree, stop and update the repo doc before coding.

## Nostr NIPs (Protocol Specs)

- Nostrbook (AI-friendly NIPs mirror)
  - https://nostrbook.dev/
  - Source link: hosted site only (upstream repo location may change)
- Official NIPs repo (canonical, less AI-friendly)
  - https://github.com/nostr-protocol/nips

Guidance:

- Prefer Nostrbook for fast, accurate extraction of NIP requirements during implementation.
- When behavior is disputed, treat the official NIPs repo as the final arbiter.
- Do not treat library examples, blog posts, or external app behavior as authoritative over NIPs or GammaMarkets `market-spec`.

## Current Conduit Protocol Map

### Core relay and event model

- NIP-01 defines event shape, tags, filters, client/relay messages, replaceable/addressable kind ranges, and WebSocket semantics.
- Relays are not a database authority. They store, forward, reject, or omit events, and clients must model partial reads, `OK`/`CLOSED` failures, `EOSE`, relay lag, and conflicting relay views.
- Addressable product events use the full coordinate `30402:<merchant_pubkey>:<d_tag>`. Do not dedupe only by `d` tag.

### Products and commerce listings

- Conduit product listings are NIP-99 + GammaMarkets `market-spec` `kind:30402` events.
- Do not introduce alternate product-listing protocol terminology, schemas, or assumptions for commerce listings.
- Public product event `content` should follow the relevant public spec. Do not publish Conduit-internal JSON in public event content unless that NIP or market spec explicitly defines that JSON content.
- Be liberal in what Conduit parses for interoperability, but conservative and spec-aligned in what it emits.

### Relay preferences and capability detection

- NIP-11 relay information documents are capability evidence, not proof. Capability scans and write/read probes may be needed.
- NIP-65 `kind:10002` advertises general read/write relay preferences:
  - use an author's write relays when downloading that author's events
  - use a tagged user's read relays when downloading events about that user
  - keep published relay lists small and understandable
- Conduit-local commerce priority is an app setting, not a Nostr protocol role.
- Route-aware read/write plans belong in shared code, not reconstructed in app routes.

### Private messages and commerce conversations

- NIP-17 private direct messages use NIP-59 seals/gift wraps and NIP-44 encryption.
- NIP-44 version 2 is the current public NIP-44 encryption version in the official NIP.
- NIP-44 v3 readiness is an intentional Conduit planning track because the ecosystem is moving in that direction and clients are experimenting. Do not remove v3 planning just because the official NIP still defines v2.
- Treat NIP-44 v3 implementation as source-gated: before code uses it, link the public draft/client references from this file or the relevant repo spec, keep v2 fallback, and require explicit capability detection.
- NIP-17 uses kind `10050` private-message relay lists for recipient inbox relays. Do not substitute general NIP-65 relay lists as the only DM routing model once kind `10050` support is in scope.
- A sender copy should be wrapped separately when local encrypted recovery is required.
- Do not add NIP-04 sending. Legacy read-only recovery must stay narrow and explicitly documented.
- Logs, telemetry, analytics, PR evidence, and diagnostics must not include plaintext, ciphertext, invoices, order contents, addresses, phone/email, signer secrets, NWC URIs, or message bodies.

### Auth and payments

- Conduit client auth remains external-signer-only. NIP-07 and NIP-46 are signer paths, not key-custody permission.
- NIP-42 relay AUTH is ephemeral relay-session authentication, not an app login system or persisted identity layer.
- NWC/NIP-47 payment behavior remains non-custodial. Do not introduce balance management, custody, or wallet-secret handling.
- Keep NWC encryption behavior conservative; do not move wallet flows to a newer encryption version without explicit wallet capability discovery and an accepted source.

## Libraries and Tools

- Nostrify (common tools/utilities)
  - https://github.com/soapbox-pub/nostrify
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

Additional guidance:

- Treat `spec.md` as the canonical normative text. The README provides high-level intent and links.
- External implementations (e.g. Plebeian) are compatibility targets, not authorities.

## External Markets (Compatibility Targets)

### Plebeian Market (Primary reference for now)

- Repo: https://github.com/PlebeianApp/market
- Notes:
  - Reported to interoperate via NIP-99 listings. Use it to catch real-world parsing/compat footguns.
  - Do not copy non-spec behavior into core logic; isolate quirks behind explicit compat adapters.

# External Nostr References (AI + Engineering)

This document is a curated set of external references we rely on for protocol details, implementation patterns, and interoperability.

Last reviewed: 2026-08-16

## Agent Preflight

Use this file before changing any Nostr-sensitive code or docs:

- event kinds, tags, product parsing/emission, order payloads, or public event content
- relay discovery, relay health, relay routing, WebSocket behavior, fallback, or source freshness
- NIP-17/NIP-44/NIP-59 private messages, order messages, DMs, unwrap/decrypt logic, or message diagnostics
- external signer auth, NIP-46 signer UX, relay AUTH, NWC, Lightning payment requests, or payment proof handling
- Dexie/local-cache/outbox behavior that affects signed events, relay convergence, retry, or local truth projection

Before implementation:

1. Read `docs/knowledge/decentralized-network-product-posture.md` and classify
   any proposed hard gate or compatibility behavior.
2. Read the relevant repo contract in `docs/specs/*` or `docs/ARCHITECTURE.md`.
3. Read the relevant public NIP or Open Markets source below.
4. State the public source in the PR under `Source docs/specs`.
5. Keep protocol construction and relay planning in `@conduit/core` unless the PR explains why route-local behavior is unavoidable.
6. If a public protocol source and a repo doc disagree, stop and update the repo doc before coding.

## Nostr NIPs (Protocol Specs)

- Nostrbook (AI-friendly NIPs mirror)
  - https://nostrbook.dev/
  - Source link: hosted site only (upstream repo location may change)
- Official NIPs repo (canonical, less AI-friendly)
  - https://github.com/nostr-protocol/nips

Guidance:

- Prefer Nostrbook for fast, accurate extraction of NIP requirements during implementation.
- When behavior is disputed, treat the official NIPs repo as the final arbiter.
- Do not treat library examples, blog posts, external app behavior, or unmerged proposals as authoritative over NIPs or the current default-branch Open Markets working specification.
- Protocol sources arbitrate event meaning and canonical emission. They do not,
  by themselves, prove that ecosystem adoption is sufficient to make unevenly
  adopted or incompletely discoverable metadata a product availability gate.

## Open Markets Specification (Commerce)

- Repository and active working/governance venue:
  - https://github.com/OpenMarketsFoundation/specification
- Current default-branch working specification:
  - https://github.com/OpenMarketsFoundation/specification/blob/main/README.md
- Maintained Conduit implementation note:
  - [open-markets-specification-notes.md](./open-markets-specification-notes.md)

Source boundary:

- The Open Markets repository is the active public working and governance venue for the commerce specification. Its current default-branch material is Conduit's working reference; this does not make branch-only proposals normative.
- [Open Markets PR #1](https://github.com/OpenMarketsFoundation/specification/pull/1) proposes stable `SPEC.md` and pillar navigation but remains open and unmerged as of this review. Its branch-only paths are non-normative and must not be cited as canonical links.
- [Open Markets PR #13](https://github.com/OpenMarketsFoundation/specification/pull/13) is an open draft stacked on PR #1. Its versioned destination constraints are experimental, branch-only, and non-normative.
- After PR #1 merges, reverify the repository root and any new default-branch paths before updating stable links or protocol behavior.

## Current Conduit Protocol Map

### Core relay and event model

- NIP-01 defines event shape, tags, filters, client/relay messages, replaceable/addressable kind ranges, and WebSocket semantics.
- Relays are not a database authority. They store, forward, reject, or omit events, and clients must model partial reads, `OK`/`CLOSED` failures, `EOSE`, relay lag, and conflicting relay views.
- Addressable product events use the full coordinate `30402:<merchant_pubkey>:<d_tag>`. Do not dedupe only by `d` tag.

### Products and commerce listings

- Conduit product listings are NIP-99 plus the Open Markets working specification for `kind:30402` commerce events, derived from the earlier GammaMarkets `market-spec` work.
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
- A temporary, bounded Conduit exception (validated-order compatibility routing for kind-16 traffic during declaration migration) is documented in `docs/knowledge/nip17-inbox-bootstrap-migration.md`. It is not NIP-17 routing; do not widen it or present it as protocol behavior.
- A sender copy should be wrapped separately when local encrypted recovery is required.
- Do not add NIP-04 sending. Legacy read-only recovery must stay narrow and explicitly documented.
- Logs, telemetry, analytics, PR evidence, and diagnostics must not include plaintext, ciphertext, invoices, order contents, addresses, phone/email, signer secrets, NWC URIs, or message bodies.

### Auth and payments

- Conduit Market and Merchant durable account auth remains external-signer-only. NIP-07 and NIP-46 are signer paths, not key-custody permission. Approved browser-generated exceptions are the outbound-only `guest_ephemeral` order sender in `docs/specs/protocol.md`, scoped to one guest order and its payment report, and the encrypted browser-local client connection key used to establish a NIP-46 signer session. Neither is a Conduit-custodied user account key. The only approved server-side private-key exception is the Anon Conduit Shopper public zap signer in `docs/specs/protocol.md`, scoped to authenticated, merchant-authorized public zap request signing. See `docs/knowledge/anon-zap-signer-handoff.md` for the public-safe signer config and request boundary.
- NIP-42 relay AUTH is ephemeral relay-session authentication, not an app login
  system or persisted Conduit identity layer. The Conduit client keeps challenge
  and auth-event state in memory, but sends the signing request to the selected
  external signer and the signed auth event to the selected relay; those
  signers and relays may retain records under their own policies.
- NWC/NIP-47 payment behavior remains non-custodial. NWC secrets stay in the
  isolated Connected Wallet provider path. Portable Wallet seed handling is a
  distinct client-side exception governed by `docs/specs/wallets.md`; it does
  not authorize Nostr account-key custody.
- Keep NWC encryption behavior conservative; do not move wallet flows to a newer encryption version without explicit wallet capability discovery and an accepted source.

## Libraries and Tools

- Nostrify (common tools/utilities)
  - https://github.com/soapbox-pub/nostrify
- Nostr UX patterns (product + UX conventions)
  - https://github.com/shawnyeager/nostr-ux-patterns
- Nostr WS Inspector (Chrome extension, debugging relays)
  - https://chromewebstore.google.com/detail/nostr-ws-inspector/pchfingijipdcdimblhpahbolijmblmn

## Historical Interop: GammaMarkets Market Spec

- Earlier market spec repository:
  - https://github.com/GammaMarkets/market-spec
- Historical specification text:
  - https://github.com/GammaMarkets/market-spec/blob/main/spec.md
- Compatibility note:
  - [gamma-market-spec-notes.md](./gamma-market-spec-notes.md)

Notes:

- GammaMarkets is the origin of the commerce work now maintained through the Open Markets venue. It is not the active governance source.
- Keep Gamma links where they substantiate historical provenance or deployed legacy/interoperability behavior.
- External implementations such as Plebeian remain compatibility targets, not authorities.
- Prefer backwards-compatible evolution. Treat breaking changes as exceptional and require explicit protocol review and migration planning.

## External Markets (Compatibility Targets)

### Plebeian Market (Primary reference for now)

- Repo: https://github.com/PlebeianApp/market
- Notes:
  - Reported to interoperate via NIP-99 listings. Use it to catch real-world parsing/compat footguns.
  - Do not copy non-spec behavior into core logic; isolate quirks behind explicit compat adapters.

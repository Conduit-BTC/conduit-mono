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

- [Current working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md)
- [Conduit implementation guide](../OPEN_MARKETS.md): support, source baseline,
  compatibility, historical provenance, and unmerged proposal dependencies

The working source defines commerce meaning. Conduit implementation and proposal
status are maintained in the guide rather than duplicated here.

## Current Conduit Protocol Map

### Core relay and event model

- NIP-01 defines event shape, tags, filters, client/relay messages, replaceable/addressable kind ranges, and WebSocket semantics.
- Relays are not a database authority. They store, forward, reject, or omit events, and clients must model partial reads, `OK`/`CLOSED` failures, `EOSE`, relay lag, and source disagreement.
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
- Commerce-first ordering is a Conduit planning convention derived from
  configured or scoped observed compatibility evidence. It is not a manual
  app-local preference or a Nostr protocol priority.
- Route-aware read/write plans belong in shared code, not reconstructed in app routes.
- Shared acceleration, cache, index, and routing systems may derive only from
  relay-visible state and must never expose hidden APIs for private messages,
  orders, payments or invoices, signer or auth material, wallet credentials or
  recovery material, or wallet balances.

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

- Conduit Market and Merchant currently use external NIP-07/NIP-46 signers.
  The approved optional installed-PWA NSEC path imports an existing account key
  only in the separate `conduit-signer` repository's dedicated signer origin.
  That origin owns import, persistence, automatic restore, ordinary operations
  without per-action approvals, and key deletion/session revocation on explicit
  logout. Apps receive public identity and operation results, never the raw key,
  backup or independent unwrapping material; services never receive the key.
  Implementation and composed preview testing may precede production device
  sign-off. Exact-origin isolation, session integrity, privacy and maintainer
  security review plus physical-iPhone validation remain production requirements;
  origin, deployment and release approval remain separate. No product account
  creation, server custody, wallet derivation, settings sync or recovery.
  Automatic restore is not independent at-rest protection. See
  `docs/specs/protocol.md` for the bounded contract.
- Approved browser-generated exceptions remain the outbound-only
  `guest_ephemeral` order sender and encrypted browser-local NIP-46 client
  connection key. Test identities are ordinary newly generated CSPRNG Nostr
  keys in controlled test processes or the signer-owned test surface, including
  composed previews. They are not a product key-creation feature. Fixed
  credentials in source/history and raw-key app/service/diagnostic/artifact sinks
  remain prohibited.
  The guest capability in `docs/specs/protocol.md` is limited to one guest
  order, same-order payment reports and separately constrained Merchant-only
  router recovery sealing. Sealing binds the same order, Merchant, canonical
  payload and existing deadline; generic messages, direct rumors and other
  recipients are prohibited. Existing Portable Wallet boundaries and
  protected-smoke checks remain enforced.
- The approved server-side signing exceptions are the Anon Conduit Shopper
  public zap signer, scoped to authenticated merchant-
  authorized checkout zap and fixed-recipient Conduit.Market project-tip zap
  requests, and a separate pricing-only live-rate attestation signer. The
  pricing signer cannot sign Nostr events, authorize payments or hold user keys;
  its contract does not itself authorize key creation or deployment. See
  `docs/specs/protocol.md` and `docs/knowledge/anon-zap-signer-handoff.md`.
- NIP-42 relay AUTH is ephemeral relay-session authentication, not an app login
  system or persisted Conduit identity layer. The Conduit client keeps challenge
  and auth-event state in memory, but sends the signing request to the selected
  account signer and the signed auth event to the selected relay; those
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

## External Markets (Compatibility Targets)

See [peer verification](../OPEN_MARKETS.md#examples-and-peer-verification) for
compatibility targets and checks. External clients inform compatibility; they
are not protocol authorities.

# Conduit Relay Specification

## Overview

Conduit treats relays as Nostr infrastructure, not fixed app roles. Apps expose user preferences (`IN`, `OUT`, and Conduit-local commerce priority), while Conduit detects relay capabilities and categorizes relays as:

- **Commerce Enabled Relays**
- **Other Public Relays**

The detailed product and client architecture lives in [Relay Architecture](./relay/conduit_relay_architecture.md).

This document defines the minimum behavior expected from a relay that wants to be considered commerce-compatible by Conduit.

## Commerce-Compatible Relay Profile

A commerce-compatible relay should support ordinary Nostr relay behavior plus the capabilities Conduit needs for products, orders, and buyer/merchant communication.

Minimum expectations:

- NIP-01 relay protocol support
- NIP-11 relay information document
- NIP-65 relay list compatibility via `kind:10002`
- NIP-99 / GammaMarkets market-spec product events, especially `kind:30402`
- NIP-17 suitability for buyer/merchant messages when the relay is used for DMs
- NIP-42 support for recipient-protected inbox reads, or an honest
  untested/advertised/unavailable warning state
- reliable reads and writes for supported commerce event kinds
- replaceable or parameterized replaceable event handling for product state

Optional capabilities:

- NIP-50 search support
- `kind:30405` collections
- `kind:30406` shipping options
- product reviews and richer commerce extensions

## Detection

Conduit should determine commerce compatibility from:

- NIP-11 `supported_nips` and relay limitations
- bounded read probes
- bounded write probes where safe
- known commerce relay host allowlists
- local or operator-managed compatibility registries
- recent local success/failure telemetry

NIP-11 alone is evidence, not proof. Relays with partial support should remain in **Other Public Relays** until Conduit determines they meet the commerce profile.

Auth capability has separate evidence states: untested, advertised by NIP-11,
challenge observed, a matching positive auth `OK` observed, and
rejected/unavailable. UI and compatibility decisions must not label an
advertised relay as verified or successfully authenticated without runtime
evidence from the current behavior.

## Implementation Guidance

Commerce-compatible relays may be implemented with existing relay software such as Congee, `strfry`, `nostr-rs-relay`, or `khatru`, with policy and indexing tuned for commerce event kinds.

Useful implementation areas:

- signature validation
- rate limiting per pubkey
- NIP-11 information endpoint
- product-event indexing for `kind:30402`
- deletion handling for `kind:5`
- relay authentication for protected or restricted behavior
- health monitoring

Commerce indexes may include:

```sql
CREATE INDEX idx_products_merchant ON events (pubkey)
  WHERE kind = 30402;

CREATE INDEX idx_products_tags ON events USING GIN (tags)
  WHERE kind = 30402;

CREATE INDEX idx_products_created ON events (created_at DESC)
  WHERE kind = 30402;
```

## Protected Inbox Relay Contract

For Conduit-operated protected messaging behavior, the relay contract is
recipient-scoped rather than a blanket requirement that every relay read be
authenticated:

- public product, profile, declaration, relay-list, and other public reads stay
  available without NIP-42 prompts;
- a protected inbox `REQ` contains only `kind:1059` filters and exactly one
  `#p` recipient equal to the authenticated client pubkey;
- mixed-kind, missing-recipient, malformed, or cross-recipient filters are
  rejected with a stable `CLOSED` reason such as `restricted:`;
- the relay sends a connection-bound challenge and validates kind `22242`, its
  id/signature, current timestamp, empty content, exact current `challenge`
  tag, and exact normalized `relay` tag;
- the relay returns an `OK` whose event id matches the auth event, and serves
  protected events only after a positive result;
- authentication is discarded on reconnect and cannot transfer between
  connections or accounts;
- `auth-required:` is used when authentication can satisfy the request;
  `restricted:` is used when the authenticated identity/filter is not allowed.
- legitimate encrypted order/message writes from buyers, including guest-order
  ephemeral senders, remain accepted without the merchant's read
  authorization; recipient-scoped read enforcement is not a global
  authenticated-write policy;
- auth-failure rate limits are isolated from public reads and legitimate
  commerce writes so rejected authentication cannot cause a checkout or
  delivery outage.

The client contract is intentionally challenge-capable before relay enforcement
is enabled, so rollout is client-first and older anonymous-compatible inbox
relays continue to work during migration. A canary first sends challenges
without denying anonymous-compatible reads; recipient enforcement begins only
after deployed Market and Merchant clients demonstrate authentication. It is
then enabled one inbox relay at a time. Rollback disables relay enforcement without
removing the client's protected executor or weakening its account isolation.
Production relay configuration/deployment is outside this repository change.

See `docs/knowledge/nip42-protected-read-rollout.md` for the exact client state
machine, typed outcomes, deterministic validation matrix, rollout, and
rollback.

## Privacy

NIP-17 relays receive encrypted gift wraps rather than plaintext message
contents, but they can retain or copy ciphertext and observe outer recipient
tags, event size, timing, traffic volume, connection behavior, direct-connection
IP addresses, and—when NIP-42 is used—authentication pubkeys and request
filters. Operational metrics should remain aggregated and should avoid
behavioral profiling. Do not claim that encryption eliminates relay or network
metadata.

For private or restricted messaging behavior, Conduit should prefer relays that
demonstrate NIP-42 authentication support. Advertisement is weaker evidence and
must be labeled as such. Relays that support DMs without auth can still exist in
the settings UI and client-first compatibility read plan, but Conduit should
show an honest warning and may limit protected messaging use there after the
operator rollout reaches that relay.

## Integration

Apps should not hard-code a single relay as the network authority. Relay plans should come from:

- user `IN` / `OUT` preferences
- Commerce Enabled Relay priority
- detected capabilities and warnings
- public relay fallback for broader Nostr reach
- local cache only as a stale/degraded fallback

Environment configuration should use:

```bash
VITE_DEFAULT_RELAYS=
VITE_PUBLIC_RELAY_URLS=
VITE_COMMERCE_RELAY_URLS=
VITE_APP_WRITE_RELAY_URLS=
```

`VITE_RELAY_URL` remains a default relay hint for legacy and NIP-89-related flows, not a user-facing relay role.

The canonical reset/fallback list is code-owned in `packages/core/src/config.ts` and currently starts with `wss://relay.conduit.market`. Retired Conduit relay hosts must not be used in active examples.

New source-aware relay outcome work should be documented before replacing current shared helpers with a custom relay substrate.

## Success Metrics

- reliable NIP-11 availability
- consistent acceptance of supported commerce event kinds
- low-latency commerce reads under normal load
- clear warning states for unreachable or partially compatible relays
- no reliance on a single relay for baseline Nostr interoperability

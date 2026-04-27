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
- NIP-42 support or a clear warning path when auth is not advertised
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

## Implementation Guidance

Commerce-compatible relays may be implemented with existing relay software such as `strfry`, `nostr-rs-relay`, or `khatru`, with policy and indexing tuned for commerce event kinds.

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

## Privacy

Relays must not inspect encrypted message content. Operational metrics should remain aggregated and should avoid behavioral profiling.

For private or restricted messaging behavior, Conduit should prefer relays that advertise or demonstrate NIP-42 authentication support. Relays that support DMs without auth can still exist in the settings UI, but Conduit should show a warning and may limit protected messaging use there.

## Integration

Apps should not hard-code a single relay as the network authority. Relay plans should come from:

- user `IN` / `OUT` preferences
- Commerce Enabled Relay priority
- detected capabilities and warnings
- public relay fallback for broader Nostr reach
- local cache only as a stale/degraded fallback

Environment configuration should use:

```bash
VITE_DEFAULT_RELAYS=wss://relay.damus.io,wss://nos.lol
VITE_PUBLIC_RELAY_URLS=wss://relay.damus.io,wss://nos.lol
VITE_COMMERCE_RELAY_URLS=wss://relay.conduit.market,wss://relay.plebeian.market
```

`VITE_RELAY_URL` remains a default relay hint for legacy and NIP-89-related flows, not a user-facing relay role.

## Success Metrics

- reliable NIP-11 availability
- consistent acceptance of supported commerce event kinds
- low-latency commerce reads under normal load
- clear warning states for unreachable or partially compatible relays
- no reliance on a single relay for baseline Nostr interoperability

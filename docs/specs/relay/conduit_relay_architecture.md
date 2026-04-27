# Conduit Relay Architecture

## Executive Summary

Conduit's relay architecture should follow Nostr conventions instead of inventing user-managed relay roles.

Users configure relay preferences:

- `IN` for relays Conduit may read from
- `OUT` for relays Conduit may publish to
- commerce priority order for Conduit commerce flows only

Conduit detects relay capabilities:

- relay information availability
- search/indexing support
- private DM suitability
- relay authentication support
- commerce compatibility

The relay settings product surface should expose two groups:

1. **Commerce Enabled Relays**
2. **Other Public Relays**

Users should not manually categorize relays. Conduit categorizes relays from NIP-11 relay information documents, active probes, cached scan results, and a versioned commerce compatibility profile. Commerce priority is a Conduit-local app preference. It is not a Nostr-level preference and must not be described as a universal relay ranking.

This document defines the product and implementation contract for that model.

---

## References

- [GammaMarkets market-spec](https://github.com/GammaMarkets/market-spec): interoperability baseline for NIP-99 commerce flows, including `kind:30402` product listings, `kind:30405` collections, merchant preferences, and NIP-17 order communication.
- [NIP-11 Relay Information Document](https://github.com/nostr-protocol/nips/blob/master/11.md): relay metadata, including `supported_nips` and relay limitations.
- [NIP-17 Private Direct Messages](https://github.com/nostr-protocol/nips/blob/master/17.md): modern private DMs using NIP-44 encryption and NIP-59 seals/gift wraps.
- [NIP-42 Authentication of clients to relays](https://github.com/nostr-protocol/nips/blob/master/42.md): relay authentication using signed ephemeral auth events.
- [NIP-50 Search Capability](https://github.com/nostr-protocol/nips/blob/master/50.md): relay search support via the `search` filter field.
- [NIP-65 Relay List Metadata](https://github.com/nostr-protocol/nips/blob/master/65.md): `kind:10002` relay list metadata with optional `read` and `write` markers.

---

## Product Principle

Users configure preferences. Conduit detects capabilities.

The relay settings screen must not ask users to assign relays to custom Conduit roles. In Nostr, relays are network infrastructure. A user may advertise relays they generally read from or write to, but capability and suitability are properties Conduit should detect.

### User-controlled preferences

- Read participation: `IN`
- Write participation: `OUT`
- Commerce priority order for Conduit only

### System-detected capabilities

- NIP-11 availability
- NIP-50 search support
- NIP-17 DM support
- NIP-42 auth support
- Conduit commerce compatibility
- warning states such as unreachable, stale relay information, or partial commerce support

### Product language

Use these labels:

- `Commerce Enabled Relays`
- `Other Public Relays`
- `Priority`
- `Commerce priority`
- `Relay order`
- `Preferred order`

Avoid these labels:

- `Primary relay`
- `Master relay`
- `Source of truth relay`
- user-facing `merchant`, `l2`, or `general` relay roles

---

## Relay Preference Model

### IN and OUT

`IN` and `OUT` are the only major user-facing relay toggles.

`OUT` means Conduit may publish supported events to this relay.

`IN` means Conduit may read or subscribe to relevant events from this relay.

These controls map to NIP-65 `kind:10002` relay list metadata:

```jsonc
{
  "kind": 10002,
  "tags": [
    ["r", "wss://relay.example.com"],
    ["r", "wss://write.example.com", "write"],
    ["r", "wss://read.example.com", "read"],
  ],
  "content": "",
}
```

Serialization rules:

- `readEnabled: true` and `writeEnabled: true`: omit the marker.
- `readEnabled: true` and `writeEnabled: false`: use the `read` marker.
- `readEnabled: false` and `writeEnabled: true`: use the `write` marker.
- `readEnabled: false` and `writeEnabled: false`: keep the relay in local settings only, not in the published NIP-65 relay list.

Clients should keep published NIP-65 lists small and user-understandable. Conduit may track additional scanned relays locally without publishing all of them.

### Commerce priority

Commerce priority is an ordered local setting for relays that Conduit has categorized as commerce-compatible.

Commerce priority affects how Conduit prefers relays for commerce behavior, including:

- product and stock sync
- product updates
- order-related event delivery
- buyer/merchant messages
- selecting which compatible relays to query first
- selecting where to prioritize publishing commerce events
- fallback when otherwise valid relay results disagree

Commerce priority does not change how other Nostr apps use a user's relays.

Recommended UI copy:

> Higher-ranked commerce relays are preferred by Conduit when syncing products, stock, orders, and messages. This does not change how other Nostr apps use your relays.

---

## Capability Detection

Relay capabilities are read-only facts in the UI. They are not manual toggles.

### Detection order

1. Normalize the relay URL.
2. Attempt a bounded connection.
3. Fetch the NIP-11 relay information document.
4. Read `supported_nips` and relay limitations.
5. Run active probes needed for Conduit commerce compatibility.
6. Cache scan results with freshness metadata.
7. Categorize the relay as `commerce` or `public`.
8. Surface capability indicators and warning states.

NIP-11 `supported_nips` is evidence, not proof. Some relays may advertise support incompletely, and some commerce requirements require active read/write probes or a registry/allowlist.

### Scan performance

Capability scans must be bounded and cacheable:

- use per-relay timeouts for HTTP and WebSocket checks
- scan relays concurrently with a global limit
- cache NIP-11 responses and probe results with timestamps
- mark old results as stale instead of blocking the settings screen
- allow the UI to render with cached or partial capability data
- avoid repeated active probes on every route load

### Capability indicators

#### Search / Index

Meaning: the relay supports search or discovery functions useful for finding events.

Primary detection:

- NIP-11 `supported_nips` contains `50`

Active tooltip:

> Search supported

Expanded tooltip:

> This relay advertises search support, so Conduit can use it for discovery and lookup.

Inactive tooltip:

> Search not advertised

#### DM

Meaning: the relay appears suitable for modern private direct messages.

Primary detection:

- NIP-11 `supported_nips` contains `17`

Active tooltip:

> DM support detected

Expanded tooltip:

> This relay advertises support for modern encrypted direct messages.

#### Auth / Security

Meaning: the relay supports or requires client authentication.

Primary detection:

- NIP-11 `supported_nips` contains `42`
- NIP-11 `limitation.auth_required` may add supporting evidence
- relay `AUTH` challenges during connection may add supporting evidence

Active tooltip:

> Auth supported

Expanded tooltip:

> This relay supports client authentication, which can help protect restricted or sensitive relay access.

#### DM without auth warning

If a relay appears DM-capable but does not advertise or demonstrate NIP-42 auth support, show a warning state.

Tooltip:

> DM relay without auth

Expanded tooltip:

> This relay appears to support DMs but does not advertise relay authentication. Conduit may limit DM use here because access controls may be weaker.

This warning must not say the relay is categorically unsafe. It only explains that Conduit may limit DM usage because access control signals are weaker.

---

## Commerce Compatibility

Commerce compatibility is Conduit-detected. The user does not choose whether a relay is a commerce relay.

Conduit should use a versioned commerce compatibility profile so requirements can evolve without turning the UI into a manual role picker.

### Baseline commerce event set

The commerce profile should align with the GammaMarkets market-spec and Conduit's current protocol contracts.

Baseline requirements:

- `kind:30402` product listings
- `kind:30405` product collections where collections are used
- merchant preferences, including relevant NIP-89 and kind `0` preference data
- NIP-17 order communication and buyer/merchant messages

Optional or extended requirements:

- `kind:30406` shipping options
- product reviews
- richer payment and service-assisted order processing flows
- Conduit-specific commerce probes or registry checks

### Minimum compatibility checks

A relay should appear under **Commerce Enabled Relays** only when Conduit determines it is suitable for commerce activity.

Minimum checks:

- NIP-11 is responsive or an equivalent probe succeeds.
- The relay can perform normal Nostr reads for Conduit's commerce event set.
- The relay accepts writes for supported commerce event kinds when `OUT` is enabled and user policy allows publishing there.
- The relay handles replaceable or parameterized replaceable commerce state needed for product and inventory updates.
- The relay meets baseline reliability expectations for commerce flows.
- If used for DMs, the relay is suitable for NIP-17 delivery and warning states are surfaced when auth support is absent.

Compatibility may be determined by:

- NIP-11 `supported_nips`
- active read probes
- active write probes using safe test events where appropriate
- relay compatibility registry
- allowlist for known commerce relays
- recent success/failure telemetry stored locally or in an operator-managed registry

### Partial support

If a relay supports some but not all commerce requirements, keep it under **Other Public Relays** and show a `commercePartialSupport` warning or detail state where useful.

Partial support should not create a third user-facing section.

---

## Internal Status Model

This model is implementation guidance for Conduit clients. It is not a Nostr protocol event schema.

```typescript
interface RelaySettingsEntry {
  url: string
  readEnabled: boolean
  writeEnabled: boolean
  section: "commerce" | "public"
  commercePriority?: number
  capabilities: {
    nip11: boolean
    search: boolean
    dm: boolean
    auth: boolean
    commerce: boolean
  }
  warnings: {
    dmWithoutAuth: boolean
    staleRelayInfo: boolean
    unreachable: boolean
    commercePartialSupport: boolean
  }
}
```

Implementation notes:

- `section` is derived from scan results.
- `commercePriority` is present only for commerce-compatible relays.
- `readEnabled` and `writeEnabled` are user preferences.
- `capabilities` and `warnings` are scan outputs.
- URL normalization must be stable before deduplication.

---

## Settings UI Contract

### Header

Title:

> Relay Settings

Header sentence:

> Relays store and deliver data across the Nostr network.

Footer sentence:

> Conduit automatically categorizes relays based on supported NIPs.

### Commerce Enabled Relays

Commerce relays are shown first because they are operationally important for:

- merchant listings
- inventory and stock updates
- product updates
- order-related events
- buyer/merchant communications
- Conduit commerce flows

This section allows drag-to-rank commerce priority.

Section tooltip:

> Relays that Conduit can use for commerce events like products, stock updates, orders, and merchant messages.

Expanded tooltip:

> These relays meet Conduit's commerce requirements. Drag to set Conduit's preferred order for syncing and publishing commerce data. This priority only affects Conduit.

Ranking tooltip:

> Drag to change Conduit's commerce priority.

Expanded ranking tooltip:

> Higher-ranked commerce relays are preferred by Conduit when reading, publishing, and resolving commerce data. This does not change relay behavior in other Nostr apps.

### Other Public Relays

Public relays may be useful for general Nostr reads, writes, discovery, or visibility, but they do not currently meet Conduit's full commerce requirements.

They should not be rankable for commerce priority.

Section tooltip:

> General Nostr relays used for broader network reading, publishing, and discovery.

Expanded tooltip:

> These relays may be useful across Nostr, but they do not currently meet Conduit's full commerce requirements.

### IN / OUT toggle copy

`OUT` tooltip:

> Publish events to this relay.

Expanded:

> When enabled, Conduit can publish supported events to this relay.

`IN` tooltip:

> Read events from this relay.

Expanded:

> When enabled, Conduit can read relevant events from this relay.

### Add Relay behavior

There should be one **Add Relay** action.

When a user adds a relay:

1. Normalize the relay URL.
2. Attempt connection.
3. Fetch NIP-11 relay information.
4. Read `supported_nips`.
5. Probe Conduit-required commerce behavior.
6. Categorize automatically as commerce or public.
7. Show capability indicators.
8. Apply safe default IN/OUT settings.

The UI must not ask whether the user is adding a commerce relay or a public relay.

### Safe defaults

Default IN/OUT behavior should be conservative:

- If a relay is reachable and public, default `IN` to enabled.
- Default `OUT` to enabled only when the relay is known to accept relevant writes or the user explicitly chooses to publish there.
- For commerce-compatible relays, default `IN` to enabled and place the relay at the end of the commerce priority list.
- If a relay is unreachable, add it disabled with a warning rather than silently discarding it.

---

## Read and Write Planning

Conduit should use relay preferences and capability scans to build route-aware read and write plans.

### General Nostr reads

For general reads, Conduit should prefer relays where:

- `readEnabled` is true
- the relay is reachable or has fresh cached capability data
- the route's requested capability is available

### General Nostr writes

For general writes, Conduit should publish to relays where:

- `writeEnabled` is true
- the relay is reachable
- the relay accepts the event kind
- user policy allows publishing there

### Commerce reads

For commerce reads, Conduit should:

1. Prefer commerce-compatible relays in commerce priority order.
2. Use public relays as fallback or discovery sources when commerce relays are unavailable or incomplete.
3. Use NIP-50 search capability only when the route needs search behavior.
4. Use cached local data only as a performance fallback with stale-state awareness.

### Commerce writes

For commerce writes, Conduit should:

1. Prefer commerce-compatible relays in commerce priority order where `writeEnabled` is true.
2. Publish to additional user-enabled write relays when appropriate for reach and interoperability.
3. Surface partial publish failures when they materially affect commerce behavior.
4. Avoid treating a Conduit-local priority list as a universal relay preference.

### Messaging

For NIP-17 buyer/merchant communication, Conduit should:

- prefer relays that advertise or demonstrate DM suitability
- prefer auth-capable relays for protected or restricted access patterns
- warn when DM support exists without auth support
- limit DM usage on weaker relays when policy requires stronger access control

---

## Conflict and Fallback Rules

When multiple relays return competing commerce state, Conduit should resolve results in this order:

1. Prefer valid signed events.
2. Prefer newer replaceable or parameterized replaceable events when applicable.
3. If otherwise valid events still disagree or some relays return stale data, prefer the result from the higher-ranked commerce relay.
4. If the highest-ranked commerce relay is unavailable, fall back to the next ranked valid commerce relay.
5. If no commerce relay returns a usable result, fall back to user-enabled public relays and clearly mark stale or degraded states when user decisions depend on freshness.

Commerce priority is only a Conduit fallback and planning signal. It does not redefine event validity.

---

## Privacy and Security Requirements

### DM privacy

NIP-17 protects message content and hides much of the direct message structure inside seals and gift wraps. Relay choice still matters because relay access policy can affect message metadata exposure.

Conduit should prefer auth-capable relays for private or restricted messaging behavior and should avoid overclaiming privacy guarantees in UI copy.

### Authentication

NIP-42 support is a capability signal and may be required for Conduit-controlled protected relay behavior. Relays that serve protected message or metadata queries should require authenticated sessions before exposing restricted data.

### Derived data

Any internal acceleration, cache, index, or relay routing system must remain derived from relay-visible state and must not become a hidden private-data API.

Derived systems may improve performance, hydration, search, or routing, but they must not be presented in the selector as user-managed relay roles.

---

## Implementation Guidance

### Keep shared relay logic centralized

Relay normalization, NIP-65 serialization, capability scanning, commerce categorization, and route-aware read/write planning should live in shared code rather than being reconstructed in each route.

### Keep UI simple

The settings screen should communicate:

- relays are Nostr infrastructure
- Conduit automatically detects capabilities
- users control read/write participation and commerce priority
- commerce priority only affects Conduit
- capability icons are informational
- warning states explain risk without creating fear

### Keep implementation extensible

The model should support future improvements without changing the user contract:

- compatibility registry
- active relay probes
- operator-managed relay recommendations
- improved stale-state handling
- additional commerce event kinds
- optional Conduit acceleration paths

---

## Open Implementation Decisions

These decisions are intentionally left for the implementation spec or code PR:

- exact URL normalization function and accepted input formats
- scan cache TTLs and stale thresholds
- active write-probe strategy and safety constraints
- compatibility profile version naming
- default curated relay list
- whether commerce priority is stored per app, per identity, or shared across Conduit apps
- whether Conduit later defines a publishable event for commerce priority

Until a publishable event is defined, commerce priority remains local/app-specific.

---

## Summary

The relay architecture should be Nostr-native:

- NIP-65 expresses user read/write relay preferences.
- NIP-11 and active probes detect relay capabilities.
- GammaMarkets market-spec anchors the commerce event set.
- Conduit categorizes relays automatically.
- Users rank only commerce-compatible relays for Conduit-local commerce priority.
- Capability icons are read-only.
- Internal acceleration remains an implementation detail, not a user-facing relay role.

Core rule:

> Users configure preferences. Conduit detects capabilities. The app orchestrates relay usage without pretending the network has fixed relay roles.

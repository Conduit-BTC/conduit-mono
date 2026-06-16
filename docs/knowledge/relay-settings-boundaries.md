# Relay Settings Boundaries

Tracking context: CND-72 and Phase 2A relay settings closeout.

This note clarifies the current implementation boundary without replacing the
relay architecture spec. It is intentionally narrow: Phase 2A should make relay
settings honest and recoverable, while broader source-aware frontier work stays
future architecture.

## Current Boundary

Conduit works with three different relay sets:

- User relay settings: the local representation of the user's NIP-65
  `kind:10002` relay preferences. This is the Network Settings surface and the
  only set that can be published as the user's relay list.
- Discovery hints: cached NIP-65 lists for other pubkeys, product authors, or
  message recipients. These hints may guide reads and writes, but they must not
  be merged into the user's relay settings.
- Execution frontier: the future source-aware planning layer that can combine
  user settings, cached hints, relay health, observed read/write outcomes, and
  active probes.

The user relay list is the sacred cross-client object. Conduit may add local
metadata around it, but should not pollute it with relays learned while browsing
the marketplace or hydrating other actors' events.

## Commerce Priority

Commerce priority is Conduit-local execution ordering for relays that are
already categorized as commerce-compatible. It is not a Nostr protocol role and
it does not define event truth.

Current behavior should use commerce priority only as a planning bias:

- prefer lower `commercePriority` values first for commerce reads
- prefer lower `commercePriority` values first for commerce writes
- append enabled public relays as fallback according to existing settings order
- keep NIP-65 serialization based on IN/OUT controls, not Conduit priority

Signed events, replaceable/addressable semantics, deletion events, timestamps,
and cross-relay evidence remain the basis for resolving product state.

## Capability Evidence

NIP-11 relay information documents are capability evidence, not proof. They are
useful for detecting relay-visible capabilities such as NIP-50 search, NIP-59
gift-wrap transport, NIP-09 deletion support, NIP-62 vanish support, and NIP-42
auth requirements.

NIP-11 should not be used to require client/application/event NIPs such as
NIP-17, NIP-33, NIP-65, NIP-99, or GammaMarkets product semantics.

Until active probes land, current commerce compatibility remains conservative
metadata:

- a configured Conduit commerce profile can provide known listing/profile
  evidence
- current NIP-11 can provide relay-visible capability evidence
- runtime reads and writes should continue recording health observations
- broad active probing should not run on every discovered relay

## Probe Scope

Active probing belongs with the future execution frontier. When that work lands,
probes should be bounded:

- dedupe by normalized relay URL
- respect TTLs and avoid route-load probe storms
- run in the background for user-managed or repeatedly encountered candidates
- cache failures and successes as observations
- never mutate the user's NIP-65 settings from probe discovery alone

Phase 2A should prefer passive runtime observations and explicit user-managed
scans over broad probing.

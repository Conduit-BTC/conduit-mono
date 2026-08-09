# Relay Settings Boundaries

This note clarifies the current implementation boundary without replacing the
relay architecture spec. It is intentionally narrow: relay settings should stay
honest and recoverable without pulling broader source-aware execution work into
the settings surface.

## Current Boundary

Conduit works with three different relay sets:

- User relay settings: the local representation of the user's NIP-65
  `kind:10002` relay preferences. This is the Network Settings surface and the
  only set that can be published as the user's relay list.
- Discovery hints: cached NIP-65 lists for other pubkeys, product authors, or
  message recipients. These hints may guide reads and writes, but they must not
  be merged into the user's relay settings.
- Execution planning: shared runtime behavior that can combine user settings,
  cached hints, relay health, observed read/write outcomes, and active probes.

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

NIP-42 evidence needs finer language than a generic supported/unsupported
badge:

- **Untested:** no current capability evidence.
- **Advertised:** NIP-11 lists NIP-42 or an auth limitation.
- **Challenge observed:** a runtime connection received `AUTH`.
- **Succeeded:** a valid auth event received its matching positive `OK` on the
  current connection.
- **Rejected:** the relay returned a matching negative auth `OK`.
- **Unavailable:** another bounded auth failure prevented current-connection
  success.

Advertisement is never “verified” authentication. A challenge is not success,
and success on one connection does not prove the relay will authorize every
filter or enforce recipient isolation. Active proof comes only from an explicit
signed-in protected operation; generic scans, public reads, and route hydration
must not prompt NIP-07 or NIP-46 solely to improve a settings badge.

Auth evidence shown in settings must remain privacy-safe. Do not persist or
display the challenge, auth event, signature, account pubkey, full protected
filter, authenticated socket, or a stable account-derived session key. Clear
connection-bound success/challenge state when its session is closed. The exact
protected-read evidence and rollout contract lives in
`docs/knowledge/nip42-protected-read-rollout.md`.

Until active probes land, current commerce compatibility remains conservative
metadata:

- a configured Conduit commerce profile can provide known listing/profile
  evidence
- current NIP-11 can provide relay-visible capability evidence
- runtime reads and writes should continue recording health observations
- broad active probing should not run on every discovered relay

## Probe Scope

Active probing should be bounded:

- dedupe by normalized relay URL
- respect TTLs and avoid route-load probe storms
- run in the background for user-managed or repeatedly encountered candidates
- cache failures and successes as observations
- never mutate the user's NIP-65 settings from probe discovery alone

Cached observations may include coarse NIP-11 advertisement and bounded
reachability. Connection-bound NIP-42 challenge/success evidence must be
downgraded or cleared when that connection/session ends rather than presented as
a current authenticated state.

Current relay settings should prefer passive runtime observations and explicit
user-managed scans over broad probing.

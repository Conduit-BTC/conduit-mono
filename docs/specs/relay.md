# Conduit Relay Specification

## Overview

Conduit treats relays as Nostr infrastructure, not fixed app roles. Market and
Merchant expose one account-level Network experience projected from the user's
latest validated signed NIP-65 `kind:10002` and NIP-17 `kind:10050` events.

The UI presents one flat, automatically ordered relay list. Each row may
participate in Read, Publish, Private inbox, or any combination, and may show
configured, advertised, or observed capability evidence. Only configured or
scoped observed commerce compatibility can move a relay into the Commerce tier.
Advertised relay-protocol capabilities remain weaker supporting evidence; users
do not categorize or manually rank relays.

The detailed product and client architecture lives in [Relay Architecture](./relay/conduit_relay_architecture.md).

This document defines the minimum behavior expected from a relay that wants to be considered commerce-compatible by Conduit.

## Commerce-Compatible Relay Profile

A commerce-compatible relay should support ordinary Nostr relay behavior plus the capabilities Conduit needs for products, orders, and buyer/merchant communication.

Minimum expectations:

- NIP-01 relay protocol support
- NIP-11 relay information document
- NIP-65 relay list compatibility via `kind:10002`
- NIP-99 plus the Open Markets working specification for product events,
  especially `kind:30402`, derived from the earlier GammaMarkets `market-spec`
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

Current capability presentation may use:

- bounded NIP-11 metadata discovery;
- a versioned configured compatibility registry;
- scoped runtime observations that already exist for the relevant operation.

Every badge must retain its evidence class and freshness. NIP-11 alone is
advertised evidence, not proof of current health, successful reads or writes,
or application behavior. Its `supported_nips` list must not be used to require
client/application/event NIPs such as NIP-17, NIP-33, NIP-65, NIP-99, or Open
Markets product semantics.

Adding a relay currently performs URL normalization, deduplication, and bounded
metadata discovery. Active connection, read, write, and protected-auth checks
belong to a separate future **Optimize my relays** flow. That scan and its
recommendations remain non-mutating until the user reviews and accepts a
proposed configuration.

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
authenticated. These bullets describe the target enforced relay behavior; the
client-first `when_challenged` policy can still complete against a
non-challenging relay until operator rollout enables enforcement:

- public product, profile, declaration, relay-list, and other public reads stay
  available without NIP-42 prompts, but relays still see the request filters
  sent to them and connection metadata;
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
is enabled, so rollout is client-first and older pre-authentication-compatible
inbox relays continue to work during migration. A canary first sends challenges
without denying pre-authentication-compatible reads; recipient enforcement
begins only after deployed Market and Merchant clients demonstrate
authentication. It is then enabled one inbox relay at a time. Rollback disables
relay enforcement without removing the client's protected executor or weakening
its account isolation. Production relay configuration/deployment is outside this
repository change.

See `docs/knowledge/nip42-protected-read-rollout.md` for the exact client state
machine, typed outcomes, deterministic validation matrix, rollout, and
rollback.

## Privacy

NIP-17 relays receive encrypted gift wraps rather than plaintext message
contents, but they can retain or copy ciphertext and observe every request
filter sent to them—including the recipient `#p` filter—plus outer recipient
tags, event size, timing, traffic volume, connection behavior, and
direct-connection IP addresses. When NIP-42 is used, the relay additionally
receives the authentication pubkey and signed kind `22242` auth event.
Operational metrics should remain aggregated and should avoid behavioral
profiling. Do not claim that encryption or absence of NIP-42 account proof
eliminates relay or network metadata.

For private or restricted messaging behavior, Conduit should prefer relays that
demonstrate NIP-42 authentication support. Advertisement is weaker evidence and
must be labeled as such. Private inbox membership comes from the user's
`kind:10050` event, not from a NIP-11 claim or generic NIP-65 relay membership.
Conduit should show honest warnings and may limit protected messaging use where
the required access-control evidence is absent.

## Integration

Apps should not hard-code a single relay as the network authority. Relay plans
should come from:

- the latest usable validated signed `kind:10002` and `kind:10050` frontiers;
- evidence-labelled capabilities and warnings;
- deterministic automatic ordering, with signed declaration order as a stable
  tie-breaker;
- bounded code-owned fallback for bootstrap or recovery when no usable signed
  evidence exists;
- cached signed evidence only as an explicitly stale or degraded fallback.

NIP-65 tag order is not a cross-client protocol priority. An unsigned draft does
not affect runtime planning. Once every requested event is signed and its exact
bytes and immutable target plan are durably staged, the runtime may honor that
pending projection immediately while reporting that network confirmation is
pending. Newer reconciled signed evidence supersedes an obsolete pending event
and cancels its retry.

Every fresh signer connection reconciles both replaceable-event frontiers over
a bounded discovery plan independent of legacy local preferences. Partial or
unavailable coverage is unknown, not absence. Valid signed state always wins;
legacy data may only seed a reviewed unpublished draft after complete bounded
discovery establishes scoped absence for `kind:10002`.

That draft-import gate is independent of legacy inbox-read recovery. A valid
signed `kind:10002` suppresses draft import but does not end a bounded read-only
recovery lane captured from old secure-IN settings. Only a usable
`kind:10050` replacement with one to three secure relays that is fully signed
and durably staged, or an explicit discard recorded by a durable migration
tombstone, ends that lane. It never authorizes writes or publication.

Both frontiers use the canonical NIP-01 replaceable-event order after
validation: greater `created_at` wins, then the lexicographically lowest event
id. A valid equal-timestamp pair is deterministic, not conflicting.

The current resolver cannot emit a conflict state for valid replaceable events.
Conflict remains a fail-closed reserved outcome only if a future richer evidence
model can validate an internal inconsistency after canonical ordering.

A single reviewed ordinary update may change one or both event kinds. Explicit
whole-setup removal always prepares, signs, and stages replacements for both
`kind:10002` and `kind:10050`, even when the URL appears in only one current
frontier. This deliberate exception records complete-removal intent in both
signed account objects. All required event drafts must be signed and their exact
bytes and immutable target plans staged before either is published. Publication
and readback remain independent and must expose truthful partial outcomes and
exact retry because Nostr provides no cross-event transaction.

For an ordinary Private inbox change, new writes use the fully signed and staged
pending declaration while prior valid inboxes remain a hidden read-only recovery
lane through exact shared-set readback and a bounded stale-sender grace period.
An explicit whole-setup removal excludes the removed URL from reads and writes
immediately after every required signature is staged. Unsigned drafts,
cancelled signer flows, and missing signatures change nothing.

One-kind membership still yields two whole-setup replacement events. Cancel or
any missing signature yields neither publication nor runtime cutover.

Shared acceleration, cache, index, and routing systems may derive only from
relay-visible state and must never expose a hidden API for private messages,
orders, payments or invoices, signer or auth material, wallet credentials or
recovery material, or wallet balances.

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
- identical account-level Network behavior in Market and Merchant
- truthful reconciliation, publication, readback, and retry state for both
  signed relay declarations

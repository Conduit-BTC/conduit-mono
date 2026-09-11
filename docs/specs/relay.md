# Conduit Relay Specification

## Overview

Conduit treats relays as Nostr infrastructure, not fixed app roles. Market and
Merchant expose one account-level Network experience projected from the user's
latest validated signed NIP-65 `kind:10002` and NIP-17 `kind:10050` events.

The UI presents one flat relay list. Each row may
participate in Read, Publish, Private inbox, or any combination, and may show
configured, advertised, or observed capability evidence. Only configured or
scoped observed commerce compatibility can move a relay into the Commerce tier.
Advertised relay-protocol capabilities remain weaker supporting evidence. A
signer-free Conduit-local preference may order otherwise eligible and equivalent
operations, but cannot change signed membership or protocol routing.

Transport eligibility is authority-scoped. An authenticated owner may
explicitly select either `ws://` or `wss://` relays in Network for eligible
activity on that owner's account, including keeping an existing selection. The
UI keeps Review and Save available for `ws://`, while showing **Unencrypted
connection** and explaining that transport encryption is absent and the relay
should be used only when the owner controls it or explicitly trusts the relay
and network path.

No remote source transfers that permission. A `ws://` URL learned through
discovery, metadata, event hints, cache provenance, fallback configuration, or
another account's declaration, including a recipient's `kind:10050`, must never
be contacted automatically. Remote `wss://` URLs remain eligible under normal
routing, evidence, validity, and exclusion rules. Relay executors enforce the
authority test again immediately before final I/O; this narrow Network Settings
and inbox-recovery rule is not a generic transport abstraction.

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
- evidence groups followed by signer-free Conduit-local ordering only among
  otherwise eligible and equivalent operations;
- bounded code-owned fallback for bootstrap or recovery when no usable signed
  evidence exists;
- cached signed evidence only as an explicitly stale or degraded fallback.

NIP-65 tag order is not a cross-client protocol priority. An unsigned draft does
not affect runtime planning. Once every requested event is signed and its exact
bytes and immutable target plan are durably staged, the runtime may honor that
pending projection immediately while reporting that network confirmation is
pending. Newer reconciled signed evidence supersedes an obsolete pending event
and cancels its retry.

Local order is shared wherever Conduit storage is shared. It is not synchronized
as a new authority across isolated devices and never overrides protocol event
ordering, signed authority, `kind:10050` routing, whole-relay exclusions,
validity, or evidence rules.

Every fresh signer connection reconciles both replaceable-event frontiers over
a bounded discovery plan independent of legacy local preferences. Partial or
unavailable coverage is unknown, not absence. Reconnect or reset reconstructs
account membership from validated published `kind:10002` and `kind:10050`
evidence. Unpublished legacy local Network settings and migration records are
ignored; they do not seed drafts, recovery, retries, or relay I/O. When valid
published state is absent, Network provides explicit setup or repair.

A persisted legacy singleton cutover record up-converts to one batch without
resetting its established readback or expiry. Whole-relay removal filters the
URL from every batch's active recovery set immediately while retaining it only
as policy-blocked historical confirmation-plan evidence. The batch cannot query
or reactivate that URL. Recovery never authorizes writes or publication.

Both frontiers use the canonical NIP-01 replaceable-event order after
validation: greater `created_at` wins, then the lexicographically lowest event
id. A valid equal-timestamp pair is deterministic, not conflicting.

The current resolver cannot emit a conflict state for valid replaceable events.
Conflict remains a fail-closed reserved outcome only if a future richer evidence
model can validate an internal inconsistency after canonical ordering.

A single reviewed signed-role update may change one or both event kinds. A
signer-free local reorder changes neither. Explicit whole-relay removal clears
the URL from every applicable desired role and prepares only the signed
frontiers whose semantics change. All required event drafts must be signed and
their exact bytes and immutable target plans staged before either is published.
Publication and readback remain independent and must expose truthful partial
outcomes and exact retry because Nostr provides no cross-event transaction.

For an ordinary Private inbox change, new writes use the fully signed and staged
pending declaration while prior valid inboxes enter the independent recovery
batch owned by that replacement. Reads union every batch awaiting its own exact
shared-set readback or still within its own seven-day grace. A stronger signed
frontier, including one produced by another client, preserves those batches but
does not create one without a local immutable replacement plan. Signer-free
same-event redistribution may append an inbox-only immutable confirmation
attempt for the current shared set. An attempt completes only after the exact
event is observed on at least one target, every target has a conclusive result,
and no target has become policy-blocked. Whole-relay removal never
retroactively shrinks or completes that historical attempt; redistribution may
add a fresh attempt for the then-current unblocked shared set. Any one complete
attempt starts the owning batch's clock only once, and later observations or
attempts never reset it.
For example, if replacement B starts recovery of inbox A and replacement C is
staged before B's grace expires, C creates a separate batch for inbox B. Reads
include A and B until each owning batch independently confirms and expires;
confirming or restaging C cannot reset, truncate, or delete B's batch for A.
An explicit
whole-relay removal excludes the removed URL from reads, writes, and every
recovery batch immediately after the atomic local commit. Unsigned drafts,
cancelled signer flows, and missing required signatures change nothing.

The desired configuration retains at least one Publish relay. A single Publish
relay is valid with a redundancy warning. A reviewed change cannot eliminate the
last usable Private inbox without selecting a replacement. An account that
already has no usable Private inbox may still change Read or Publish roles; this
does not force inbox setup for an unrelated change. Removing a current Private
inbox always requires selecting a current replacement, even when a different
recovery-only read route survives. For an account that is already signed-empty,
the guard also prevents removing its final recovery-only read route.

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

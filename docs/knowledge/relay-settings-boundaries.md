# Relay Settings Boundaries

This note separates signed account configuration, discovery evidence, and
runtime execution planning. It does not replace the relay architecture spec.

## Account Configuration Boundary

Conduit projects one account-level Network configuration from two independent
replaceable Nostr events:

- NIP-65 `kind:10002` supplies Read and Publish membership.
- NIP-17 `kind:10050` supplies Private inbox membership.

The latest validated signed frontier for each kind is authoritative. Market and
Merchant render the same shared projection and mutation workflow; their routes
are navigation shells, not separate settings products.

The combined UI does not create a combined protocol event. A reviewed change
may require one or two signatures and produces one replacement event for each
changed frontier.

## Distinct Relay Data Sets

Conduit works with three classes of relay data:

- **Signed account configuration:** the user's validated `kind:10002` and
  `kind:10050` events. Only this data defines account relay membership.
- **Discovery evidence:** signed relay declarations for other pubkeys, cached
  events, NIP-11 documents, configured capability evidence, and scoped runtime
  observations. This evidence may guide planning or badges but cannot mutate
  the user's configuration.
- **Execution plans:** bounded runtime choices derived from signed membership,
  actual route requirements, capability evidence, and explicit bootstrap or
  recovery policy.

Relays learned while browsing products, resolving authors, or routing to a
recipient must not be merged into the signed account configuration. NIP-65
membership also must not be treated as a private-message fallback. NIP-17
delivery follows the recipient's valid `kind:10050` declaration; named
compatibility exceptions remain bounded by their own registries and removal
gates.

## Reconciliation Evidence

Every fresh NIP-07 or NIP-46 signer connection reconciles both signed frontiers
through a bounded shared discovery plan independent of legacy local
preferences. Each result preserves source, freshness, coverage, event id, and
validation evidence.

The state model distinguishes:

- **Current:** fresh bounded discovery establishes the valid signed winner
  under greater `created_at`, then lexicographically lowest event id.
- **Stale:** prior valid signed evidence remains available without fresh
  confirmation.
- **Partial:** some planned sources completed and others did not.
- **Unavailable:** current evidence could not be established.
- **Scoped absence:** every source in a completed bounded plan returned no
  matching event.
- **Signed empty:** the latest valid event intentionally has no usable relay
  tags.
- **Malformed:** a candidate signed event cannot form the required declaration.
- **Reserved conflict:** not emitted by the current resolver. It is a
  fail-closed placeholder only if a future richer evidence model validates an
  internal inconsistency that canonical ordering cannot resolve.

A completed bounded result is not proof of global Nostr state. Partial and
unavailable results are unknown, not absence. A stale cached event must not be
presented as freshly confirmed, but stronger prior signed evidence should not
be discarded because a new attempt is incomplete.

The same reconciliation runs again when the user commits a change. Destructive
replacement pauses when a safe current frontier cannot be established.

For both `kind:10002` and `kind:10050`, frontier selection validates event id,
signature, kind, and author, then applies the canonical NIP-01 order: greater
`created_at` wins; when timestamps tie, the lexicographically lowest event id
wins. Re-observation of the same event unions provenance. An equal-timestamp
pair of valid events is ordered and does not enter the reserved conflict state.

NIP-01 therefore totally orders all valid current inputs. Source disagreement
and incomplete coverage remain partial or unavailable; the current resolver
must not synthesize a conflict state from them.

## Local Persistence Boundary

Device-local settings are neither a product concept nor an authority. Local
persistence is limited to:

- cached exact signed events with source and freshness;
- unpublished drafts while a change is being reviewed;
- capability observations with scope and observation time;
- exact signed-event retry checkpoints with immutable target plans;
- bounded account-and-device-scoped legacy inbox-read recovery records that
  persist across incomplete migration and restart until their lifecycle ends;
- durable account-and-device-scoped migration discard tombstones that persist
  across restart for the legacy migration reader's lifetime and prevent
  discarded recovery from being reconstructed.

None of these records may outrank a newer validated signed frontier. An unsigned
draft does not change runtime behavior. Once every requested event is signed
and its exact bytes and immutable target plan are durably staged, the runtime
may honor the pending projection immediately while network confirmation remains
visible. Cross-app convergence still comes from signed Nostr events, not shared
browser storage.

### Legacy migration

Valid signed state always wins. Legacy app-scoped relay data is not merged into
or allowed to override a signed frontier.

Legacy NIP-65 draft import and legacy inbox-read recovery have separate gates:

- Complete bounded scoped absence for `kind:10002` may seed a one-time
  unpublished NIP-65 draft. Any valid signed `kind:10002` suppresses that draft
  import.
- Normalized legacy secure-IN relays are captured as bounded read-only inbox
  recovery regardless of the `kind:10002` frontier. Signed NIP-65 state does not
  end that lane.

Migration persists and verifies every eligible replacement record before
retiring the legacy key. An incomplete migration retains or recovers the prior
read path and remains retryable; partial replacement records are neither
authority nor active state.

The recovery record and tombstone are account-and-device-scoped local migration
evidence. Neither is signed account authority or current membership, and neither
defines a write target or supplies publication input. The recovery record
survives incomplete migration and restart. It ends only after a usable
`kind:10050` replacement with one to three secure relays is fully signed and
durably staged, or after explicit discard recorded by a durable local migration
tombstone. That tombstone survives restart for the lifetime of the legacy
migration reader and prevents retained or reappearing legacy data from
resurrecting privacy-sensitive recovery. A signed or staged `kind:10002`, an
unusable `kind:10050`, cancellation, or signer refusal does not end recovery.
Whole-setup removal records the equivalent explicit tombstone for the captured
URL after all required signatures are staged.

Malformed, partial, unavailable, stale, or a future reserved fail-closed
conflict cannot trigger NIP-65 draft import. The replacement does not keep a
dormant second settings authority for a later cleanup release.

## Flat List and Automatic Ordering

Each normalized relay appears once in one flat list. The row may expose Read,
Publish, and Private inbox membership plus evidence-labelled capability badges.

Conduit automatically orders rows using:

1. current configured commerce evidence;
2. scoped observed commerce compatibility;
3. other active relays with applicable advertised relay-protocol evidence;
4. remaining active relays;
5. unpublished candidates or drafts.

Only configured or scoped observed evidence can place a relay in a Commerce
tier. Advertised relay-protocol capability is a weaker supporting tier or badge,
not advertised commerce compatibility.

Stable signed declaration order is the tie-breaker, followed by normalized URL
when no signed position exists. There is no manual commerce ranking.

This order is a Conduit display and execution convention. NIP-65 does not make
tag order a cross-client priority, and ordering never changes event validity.

## Capability Evidence Boundary

NIP-11 relay information documents are advertised capability evidence, not
proof. They are useful for relay-visible capabilities such as NIP-50 search and
NIP-42 authentication claims.

NIP-11 must not be used to require client/application/event NIPs such as
NIP-17, NIP-33, NIP-65, NIP-99, or Open Markets product semantics.

NIP-42 evidence needs literal states:

- **Untested:** no current evidence.
- **Advertised:** NIP-11 lists NIP-42 or an auth limitation.
- **Challenge observed:** a runtime connection received `AUTH`.
- **Succeeded:** a valid auth event received its matching positive `OK` on the
  current connection.
- **Rejected:** the relay returned a matching negative auth `OK`.
- **Unavailable:** another bounded auth failure prevented success.

Advertisement is never verified authentication. A challenge is not success,
and one successful connection does not prove recipient isolation for every
filter. Connection-bound evidence expires or downgrades when the connection
ends.

Current Add Relay behavior is limited to normalization, deduplication, and
bounded NIP-11 metadata discovery. It does not run active read, write, or auth
tests and must not label a relay healthy.

Active tests and recommendation policy belong to the future, user-triggered
**Optimize my relays** wizard. Opening, scanning, cancelling, and reviewing are
non-mutating. Signed probes require explicit context, and configuration changes
occur only after reviewed acceptance.

## Mutation and Retry Boundary

One reviewed ordinary action may update `kind:10002`, `kind:10050`, or both.
Explicit whole-setup removal always updates both kinds, even when the URL is
present in only one current frontier. Before the first network write, the shared
coordinator:

1. reconciles both frontiers;
2. derives every changed event for an ordinary edit, or both replacement kinds
   for whole-setup removal;
3. obtains all required signatures;
4. stores the exact signed bytes and immutable relay target plans.

If a required signer request fails or is cancelled, no event is published.
After every requested event is signed and durably staged, the local runtime may
apply the role-specific pending projection below. Each event then publishes and
reads back independently. Accepted, rejected, timed out, readback-pending, and
confirmed outcomes remain distinct. Partial completion is truthful and
retryable using the exact signed bytes; it is not reconstructed as a new event.

Newer reconciled signed evidence for an event kind supersedes an obsolete
pending event for that kind, cancels its retry, and causes the runtime projection
to be recomputed.

Nostr has no atomic transaction across the two events or across relays.

Removing a relay from the whole setup removes it from every applicable role in
the desired projection and emits both replacement events. This is a deliberate
exception to minimal changed-event selection and records complete-removal intent
in both signed account objects. The action stops reads and writes through that
URL immediately after all required signatures are staged, before ACK or
readback. Its concise proceed/cancel warning states that stale clients may still
send there and those messages can be missed. Cancel or a missing signature
changes nothing and removes no recovery behavior.

One-kind membership still yields two whole-setup replacement events. Cancel or
any missing signature yields neither publication nor runtime cutover.

If removal would violate the minimum usable configuration, the UI gives one
direct replacement instruction rather than a multi-step impact review.

### Private inbox cutover

For an ordinary Private inbox role change, new writes use the fully signed and
staged pending declaration. Previous valid inboxes remain a hidden read-only
recovery lane. They are not shown as current membership and never authorize
writes.

Exact readback of the pending event from the bounded shared discovery set starts
a bounded, versioned stale-sender grace period. The recovery lane closes when
that grace period expires. The pending record retains the policy version,
readback evidence, and expiry.

Explicit whole-setup removal overrides this recovery behavior for the removed
URL. After all required signatures are staged, that URL is excluded from active
reads and writes immediately. This privacy cutoff accepts the warned risk of
missing messages sent by stale clients.

## Conduit Relay Recommendation Boundary

After authoritative reconciliation, an eligible account may be offered
**Add the Conduit relay?** Acceptance adds the canonical relay for NIP-65 Read
and Publish membership and for NIP-17 Private inbox membership. Existing roles
are preserved and only missing roles are added.

The prompt activates only after a separate relay-operator gate verifies the
deployed protected-read and public behavior. It never evicts an existing relay
from a full three-relay inbox declaration. Dismissal changes no signed state.

## Privacy Boundary

Capability evidence, UI state, diagnostics, logs, and telemetry stay
content-free. They must not contain message contents, ciphertext, invoices,
order data, protected filters, addresses, account pubkeys, auth challenges or
events, signatures, signer secrets, NWC URIs, or stable account-derived session
identifiers.

This prohibition does not prevent caching a validated signed public frontier.
Exact signed public declarations retained to resume publication are permitted
only inside the bounded retry checkpoint; they must not be copied into
capability evidence, UI state, diagnostics, logs, or telemetry.

Shared acceleration, cache, index, and routing systems may derive only from
relay-visible state and must remain rebuildable. They must never become hidden
APIs for private message content or ciphertext, order contents, payment or
invoice data, signer or auth material, wallet credentials or recovery material,
or wallet balances. Device-local user caches remain within their existing
account and device boundary and do not authorize copying private material into
shared derived infrastructure.

The detailed protected-read evidence and rollout contract lives in
`docs/knowledge/nip42-protected-read-rollout.md`. The validated-order
compatibility exception lives in the relay architecture spec and
`docs/knowledge/nip17-inbox-bootstrap-migration.md`; unified Network settings
must not broaden it.

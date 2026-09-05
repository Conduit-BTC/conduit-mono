# Conduit Relay Architecture

## Executive Summary

Conduit presents relay configuration as one account-level Network experience.
Market and Merchant use the same shared screen, state model, mutation workflow,
and language. Their app routes are navigation shells only.

The account configuration is projected from two independent signed Nostr
objects:

- NIP-65 `kind:10002` expresses general read and publish participation.
- NIP-17 `kind:10050` expresses private inbox relays.

These events remain separate protocol objects, but users manage their combined
meaning through one flat relay list. A row may participate in Read, Publish,
Private inbox, or any combination. One reviewed action may therefore require
one or two honest signer requests.

The latest validated signed frontier for each event kind is authoritative.
Device-local relay settings are not an account preference or user-facing
concept. Local persistence is limited to cached signed evidence, unpublished
drafts, capability observations, exact signed-event retry checkpoints, bounded
account-and-device-scoped legacy inbox-read recovery records, and durable
migration discard tombstones that prevent discarded recovery from being
resurrected.

Conduit automatically orders the flat list. Relays with current configured or
scoped observed commerce compatibility appear first, with stable signed order
as the tie-breaker. Advertised relay-protocol capabilities may support badges
and order the remaining rows, but they do not establish commerce compatibility.
Users do not sort commerce relays, and NIP-65 tag order is not presented as a
cross-client protocol priority.

Capability badges must name their evidence. Configuration and NIP-11 metadata
can support badges in the current experience, but neither proves current relay
health or successful application behavior. Active capability tests and relay
recommendations belong to a separate, future **Optimize my relays** flow.

---

## References

- [NIP-01 Basic protocol flow](https://github.com/nostr-protocol/nips/blob/master/01.md): relay subscriptions, events, and publish outcomes.
- [NIP-11 Relay Information Document](https://github.com/nostr-protocol/nips/blob/master/11.md): relay metadata, including `supported_nips` and relay limitations.
- [NIP-17 Private Direct Messages](https://github.com/nostr-protocol/nips/blob/master/17.md): modern private DMs, recipient routing through `kind:10050`, NIP-44 encryption, and NIP-59 seals and gift wraps.
- [NIP-42 Authentication of clients to relays](https://github.com/nostr-protocol/nips/blob/master/42.md): relay authentication using signed ephemeral auth events.
- [NIP-50 Search Capability](https://github.com/nostr-protocol/nips/blob/master/50.md): relay search support via the `search` filter field.
- [NIP-65 Relay List Metadata](https://github.com/nostr-protocol/nips/blob/master/65.md): `kind:10002` relay list metadata with optional `read` and `write` markers.
- [Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md): current working reference for commerce flows, including `kind:30402` product listings, derived from the earlier GammaMarkets `market-spec` work.

---

## Product Principle

Users configure where Conduit participates. Conduit explains what it knows
about each relay.

### User-controlled membership

- **Read:** Conduit may read or subscribe through this relay.
- **Publish:** Conduit may publish supported events to this relay.
- **Private inbox:** Other NIP-17 clients may deliver the user's private
  messages through this relay.

### Evidence-labelled capabilities

- **Configured:** supplied by Conduit's versioned compatibility configuration.
- **Advertised:** claimed by current NIP-11 metadata.
- **Observed:** demonstrated by a bounded operation, including its scope and
  observation time.

Configured and advertised evidence are useful but are not live health checks.
An observation proves only the exact operation that ran; it does not establish
universal relay availability or interoperability.

The Network screen must not use separate Commerce and Other sections, manual
commerce ranking, or app-specific relay roles. Capability evidence informs
automatic ordering and planner decisions without becoming another preference.

---

## Signed Account Configuration

### NIP-65 read and publish membership

Read and Publish controls map to NIP-65 `kind:10002` relay list metadata:

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

- Read and Publish enabled: omit the marker.
- Read enabled and Publish disabled: use the `read` marker.
- Read disabled and Publish enabled: use the `write` marker.
- Both disabled: omit the relay from `kind:10002`.

An unpublished candidate may remain in an unsigned draft while the screen is
open, but it is not an account setting and must not affect runtime planning.
After every requested event is signed and its exact bytes and immutable target
plan are durably staged, the local runtime may honor the resulting pending
projection immediately while showing that network confirmation is pending.

### NIP-17 private inbox membership

Private inbox controls map to `kind:10050` relay tags:

```jsonc
{
  "kind": 10050,
  "tags": [
    ["relay", "wss://inbox-one.example.com"],
    ["relay", "wss://inbox-two.example.com"],
  ],
  "content": "",
}
```

Conduit follows NIP-17's recommendation to publish one to three inbox relays.
Private inbox membership is recipient routing, not a claim that NIP-11 proves
NIP-17 client behavior.

### Unified projection

The shared screen joins the latest validated `kind:10002` and `kind:10050`
frontiers by normalized relay URL. It does not merge the two events into a new
wire format.

Each frontier retains:

- signed event id and author;
- creation time and replaceable-event ordering evidence;
- discovery sources;
- freshness and cache provenance;
- bounded coverage and failures;
- parse and validation outcomes.

The two frontiers advance independently. A current `kind:10002` result does not
make an unavailable `kind:10050` result current, or vice versa.

Both kinds use the canonical NIP-01 replaceable-event order after event id,
signature, kind, and author validation: greater `created_at` wins; when
timestamps tie, the lexicographically lowest event id wins. Re-observing the
same event unions source provenance. Two valid equal-timestamp candidates are
therefore ordered, not conflicting or implementation-defined.

### Reconciliation on fresh connections

Every fresh NIP-07 or NIP-46 signer connection in Market or Merchant starts the
same reconciliation workflow. Discovery uses a bounded shared relay plan that
does not depend on legacy local preferences.

The state model distinguishes:

- **Current:** fresh bounded discovery establishes the valid signed winner:
  greater `created_at`, then lexicographically lowest event id.
- **Stale:** prior valid signed evidence is usable but lacks fresh confirmation.
- **Partial:** some planned discovery sources completed and others did not.
- **Unavailable:** bounded discovery could not establish sufficient current
  evidence.
- **Scoped absence:** every source in a completed bounded plan returned no
  matching event.
- **Signed empty:** the latest valid event intentionally contains no usable
  relay tags.
- **Malformed:** a candidate signed event cannot be interpreted as the required
  declaration.
- **Reserved conflict:** not emitted by the current resolver. It is a
  fail-closed placeholder only if a future richer evidence model can validate
  an internal inconsistency that remains after canonical ordering.

NIP-01 totally orders every valid replaceable event available to the current
resolver. Equal timestamps, source disagreement, and incomplete coverage do not
produce a conflict state; they resolve by event id or remain partial or
unavailable.

Scoped absence is a statement about the completed plan, not proof of global
Nostr absence. Partial or unavailable discovery is unknown and must never be
collapsed into absence. Cached signed evidence remains visible with honest
stale or degraded status when a fresh attempt is incomplete.

### Legacy migration

Valid signed state always wins. Legacy app-scoped relay data must never
override, merge into, or silently republish a signed frontier.

Legacy NIP-65 draft import and legacy inbox-read recovery are independent:

- **NIP-65 draft import:** only complete bounded reconciliation that establishes
  scoped absence for `kind:10002` may seed a one-time unpublished draft. Any
  valid signed `kind:10002` suppresses this import; legacy values never merge
  into signed NIP-65 state.
- **Inbox-read recovery:** normalized legacy secure-IN relays are captured in a
  bounded read-only recovery record whether or not signed `kind:10002` exists.
  A signed NIP-65 frontier does not cancel that recovery lane.

Cleanup uses a failure-safe sequence. Migration first persists and verifies the
recovery record and, only when eligible, the unpublished NIP-65 draft. Only then
may it retire the legacy key. An incomplete migration retains or recovers legacy
reads and remains retryable; a partial new record is neither account authority
nor an active replacement.

The inbox-recovery record is not signed account truth. It is limited to the
captured secure read relays, never authorizes writes or publication, and is not
shown as current membership. It ends only after a usable `kind:10050`
replacement with one to three secure relays is fully signed and durably staged,
or after the user explicitly discards it and a durable local migration tombstone
records that choice. A signed or staged `kind:10002`, an unusable
`kind:10050`, signer refusal, or cancellation does not end it. Whole-setup
removal of a captured URL records the equivalent explicit tombstone for that
URL after all required signatures are staged.

The recovery record and tombstone are account-and-device-scoped and survive
restart for their bounded migration lifecycle. The tombstone remains for the
lifetime of the legacy migration reader so retained or reappearing legacy data
cannot resurrect privacy-sensitive recovery after explicit discard. Neither
record becomes signed account authority or membership, defines a write target,
or supplies publication input.

Malformed, partial, unavailable, stale, or a future reserved fail-closed
conflict cannot trigger NIP-65 draft import. No compatibility release keeps a
second authoritative settings system alive.

---

## Capability Evidence

### Current Add Relay behavior

There is one **Add Relay** action next to the flat list. It:

1. Normalizes and validates the relay URL.
2. Deduplicates against the current projection and draft.
3. Performs bounded NIP-11 metadata discovery.
4. Shows evidence-labelled capability badges and lets the user choose
   membership.

Adding a candidate does not silently publish, run signed probes, or declare it
healthy. A missing or unreachable NIP-11 document may be shown as unavailable
metadata without inventing a successful capability result.

### NIP-11 limits

NIP-11 describes relay-visible protocol and policy claims. Its
`supported_nips` list may support advertised badges for relay protocol
capabilities such as NIP-42 authentication or NIP-50 search.

It must not be used to prove client/application/event semantics such as
NIP-17, NIP-33, NIP-65, NIP-99, or Open Markets product behavior. In
particular:

- NIP-42 advertisement is not a successful authenticated request.
- An observed AUTH challenge is not a positive auth `OK`.
- One successful authenticated connection does not prove recipient isolation
  for every filter.
- Metadata reachability is not relay read or publish health.

Literal evidence copy should be used where detail matters, such as
`Auth advertised`, `Auth challenge observed`, `Auth succeeded`,
`Auth rejected`, or `Auth unavailable`.

### Automatic ordering

The flat list uses deterministic presentation and planning order:

1. Active relays with current configured commerce evidence.
2. Active relays with scoped observed commerce compatibility.
3. Other active relays with applicable advertised relay-protocol evidence.
4. Remaining active relays.
5. Unpublished candidates or drafts.

Only the first two tiers claim commerce compatibility. Advertised protocol
evidence is a weaker supporting tier or badge and must not be labelled as
advertised commerce compatibility.

Within a tier, the stable order from the signed declarations is the
tie-breaker, followed by normalized URL when no signed order exists. There is
no drag-to-rank interaction.

This order is a Conduit convention. NIP-65 does not define relay tag order as a
cross-client priority signal, and Conduit must not describe it that way.

### Future Optimize my relays flow

Active relay checks and recommendation policy belong to a separate,
user-triggered **Optimize my relays** wizard. That flow may define bounded
connection, read, write, and protected-auth tests; scan capability evidence;
and recommend good defaults.

Opening, scanning, cancelling, or reviewing the wizard is non-mutating. A
signed or publishable test requires explicit user context and must disclose
what it will do. Proposed configuration changes use the normal reviewed update
workflow only after acceptance. The optimizer must not silently remove relays
or convert incomplete evidence into a health verdict.

---

## Shared Network UI Contract

### One experience

Market and Merchant render the same shared Network screen and controller.
App-specific routes may supply navigation context, such as a return target,
but may not alter relay state, controls, wording, ordering, reconciliation, or
mutation behavior.

Title:

> Network

Header sentence:

> Choose where Conduit reads, publishes, and receives private messages on
> Nostr.

The UI does not mention device-local settings. Cached or degraded signed
evidence is described by freshness and coverage, not as a second preference
source.

### Flat relay list

Each normalized relay appears once. A row may show:

- Read membership;
- Publish membership;
- Private inbox membership;
- configured, advertised, or observed capability badges;
- freshness, partial-result, or availability warnings when supported by
  evidence.

Media-server preferences remain a separate section because Blossom servers
are not Nostr relays and are outside `kind:10002` and `kind:10050`.

### One reviewed update

The user reviews one desired account configuration and selects one update
action. The signer may then show one or two requests because Nostr requires
separate signed events. The UI may explain this plainly, but it must not
pretend the signer requests or network publications are atomic.

### Removing a relay

The explicit **Remove from my whole setup** action removes the normalized URL
from every applicable role in the desired account configuration. It always
prepares, signs, and durably stages replacement `kind:10002` and `kind:10050`
events, even when the URL appears in only one current frontier. This deliberate
exception to minimal changed-event selection records the user's complete-removal
intent in both signed account objects.

The confirmation is one concise proceed/cancel warning:

> Remove this relay from your whole setup? After you complete every signer
> request, Conduit will stop reading, publishing, and checking it for private
> messages immediately. Stale clients may still send messages there, and those
> messages can be missed.

There is no multi-step impact-review workflow. Cancel, signer refusal, or any
missing required signature changes no runtime route and deletes no working
recovery lane.

Acceptance is explicit: one-kind membership still produces two replacement
events; Cancel or any missing signature produces neither publication nor runtime
cutover.

If the result would violate the current minimum usable Network configuration,
the UI gives one direct instruction to add a replacement rather than exposing
an elaborate dependency analysis. In particular, private inbox declarations
retain NIP-17's one-to-three relay guidance.

### Private inbox cutover

An ordinary Private inbox role change is distinct from explicit whole-setup
removal. After every event required by the reviewed action is signed and durably
staged:

- new gift-wrap writes target the pending `kind:10050` declaration;
- the previous valid inboxes remain a hidden read-only recovery lane;
- those previous inboxes are not current membership and never authorize a new
  write;
- an exact readback of the pending event from the bounded shared discovery set
  starts a bounded, versioned stale-sender grace period;
- the recovery lane closes after that grace period expires.

The grace-policy version, readback evidence, and expiry are stored with the
pending cutover. A relay explicitly removed from the user's whole setup is
excluded immediately from this recovery lane after all signatures are staged,
even before ACK or readback. This privacy cutoff intentionally accepts that
messages from stale clients can be missed.

### Add the Conduit relay

After authoritative reconciliation, an eligible account may see:

> Add the Conduit relay?

Acceptance adds the canonical Conduit relay to NIP-65 Read and Publish
membership and to the `kind:10050` private inbox declaration. If it is already
present in some roles, only the missing roles and changed event kinds are
updated.

This prompt activates only after a separate relay-operator gate verifies the
deployed protected-read and public relay behavior. It is not proof that every
future relay operation will succeed. If the account already declares three
private inbox relays, the prompt does not evict one automatically and should
not offer a misleading one-click result.

Dismissing the prompt changes no signed preference.

---

## Mutation and Distribution Contract

An account update is one user action over two independently replaceable event
frontiers. Before any relay write, the coordinator must:

1. Reconcile both frontiers again at action time.
2. Reject or pause destructive replacement when current safe frontiers cannot
   be established.
3. Derive the minimal changed event set for ordinary edits, or require both
   replacement kinds for explicit whole-setup removal.
4. Prepare every changed event draft.
5. Obtain every required signature.
6. Persist the exact signed bytes and immutable target relay plans.

Only after all required signatures and retry checkpoints exist may publication
begin or the runtime change. At that point, the runtime applies the role-specific
pending cutover above while the UI shows that network confirmation is pending.
If the second signer request is cancelled or fails, neither event is published,
no pending projection is activated, and existing recovery behavior remains
unchanged.

Each signed event is then published and read back independently. Outcomes must
distinguish at least:

- accepted;
- rejected;
- timeout or unavailable;
- accepted but readback pending;
- exact event confirmed by readback.

One event may confirm while the other remains retryable. The UI reports that
partial state without calling the combined action complete. Retries reuse the
exact signed bytes and immutable target plan; they do not reconstruct or
silently re-sign a newer event.

If reconciliation later establishes a newer valid signed frontier for an event
kind, that evidence supersedes the pending event for that kind. Its obsolete
retry is cancelled and the runtime projection is recomputed from the remaining
current and pending frontiers.

Nostr offers no cross-event or cross-relay transaction. The user action is
unified, but network distribution remains independently observable and
recoverable.

---

## Read, Publish, and Messaging Planning

### General reads and publishes

Runtime planners consume the latest usable validated signed projection, with
explicit stale or degraded provenance when only cached evidence is available.
An unsigned draft does not change runtime behavior. A fully signed and durably
staged pending projection may do so before network confirmation, with that
pending status kept visible and subject to supersession by newer reconciled
signed evidence.

General reads prefer signed Read members that satisfy the route's actual
requirements. General publishes target signed Publish members and retain
per-relay acceptance, rejection, and timeout outcomes. Code-owned fallbacks may
provide bounded bootstrap or recovery when no usable signed evidence exists,
but they do not become hidden user settings.

### Commerce behavior

Commerce planners may use the automatic capability order as a bounded planning
bias. Valid signatures, replaceable/addressable semantics, deletion events,
timestamps, source coverage, and cross-relay evidence remain the basis for
event truth.

A commerce-evidence tier cannot redefine event validity. When sources disagree
or fail, Conduit preserves source, freshness, and coverage instead of treating
the first preferred relay as network authority.

### NIP-17 messaging

NIP-17 delivery uses the recipient's valid `kind:10050` declaration. Protected
inbox reads may require NIP-42 authentication, but public declarations and
relay lists do not.

During an ordinary fully signed and staged inbox change, new writes use the
pending declaration. Reads temporarily include the previous valid inboxes as a
hidden recovery lane through exact shared-set readback and the versioned
stale-sender grace period. A whole-setup removal excludes its URL from reads and
writes immediately after staging; general NIP-65 membership never substitutes
for this narrowly defined cutover lane.

Conduit follows the declared one-to-three inbox relays when available. An empty,
malformed, stale, partial, or unavailable declaration remains a distinct state;
the runtime must not silently treat all of them as the same fallback case.

#### Temporary validated-order compatibility role (CND-208)

While users migrate to valid `kind:10050` declarations, a bounded set of
private-inbox-compatible relays serves two roles:

- **Compatibility reads:** clients union the bounded compatibility read set
  with declared inboxes when reading their own gift wraps.
- **Compatibility order writes:** behind an independent deployment-profile
  flag, validated kind-16 order gift wraps may be written to at most three
  relays from the operator-approved registry when the recipient has no usable
  declaration.

Both roles preserve NIP-44/NIP-59 encryption. A selected relay can observe the
request filters sent to it, including the recipient `#p` filter, plus the
encrypted gift wrap, outer recipient tag, event size, timing, traffic volume,
connection behavior, and direct-connection IP address. When NIP-42 is used,
the relay additionally receives the authentication pubkey and signed
`kind:22242` auth event.

No fixed retention, automatic deletion, no-logging behavior, or complete
metadata privacy is assumed. This is a migration exception, not NIP-17 routing,
and its removal gate lives in
`docs/knowledge/nip17-inbox-bootstrap-migration.md`. Eligibility is the secure
intersection of the write registry and the compatibility read set. Recipient
NIP-65 read evidence may only reorder that intersection; it never widens it to
arbitrary NIP-65, legacy local settings, commerce evidence, source hints, or
other public relays. One ACK succeeds; other failures remain retryable.

---

## Privacy and Protected Inbox Requirements

NIP-17 protects message content and hides much of the direct message structure
inside seals and gift wraps. Relay choice still affects metadata exposure and
access policy. Encryption does not hide request filters, outer recipient tags,
timing, traffic volume, or ordinary connection metadata from the relay.

For the Conduit-operated protected inbox contract:

- Public product, profile, declaration, relay-list, and other public reads stay
  available without NIP-42 prompts.
- A protected inbox `REQ` contains only `kind:1059` filters and exactly one
  `#p` recipient equal to the authenticated client pubkey.
- Mixed-kind, missing-recipient, malformed, or cross-recipient filters are
  rejected with a stable `CLOSED` reason such as `restricted:`.
- The relay sends a connection-bound challenge and validates `kind:22242`, its
  id and signature, current timestamp, empty content, exact current
  `challenge` tag, and exact normalized `relay` tag.
- The relay returns an `OK` whose event id matches the auth event and serves
  protected events only after a positive result.
- Authentication is discarded on reconnect and cannot transfer between
  connections or accounts.
- `auth-required:` is used when authentication can satisfy the request;
  `restricted:` is used when the authenticated identity or filter is not
  allowed.
- Legitimate encrypted order and message writes, including guest-order
  ephemeral senders, remain accepted without the merchant's read
  authorization.
- Auth-failure rate limits are isolated from public reads and legitimate
  commerce writes.

Authentication failure is a typed authorization or availability outcome, not
EOSE and not an empty inbox. One successful relay plus one failed relay is
partial; cached messages remain visible as stale or degraded. Only NIP-07 and
NIP-46 account sessions are eligible for protected reads. Guest or unsigned
sessions have no protected-read fallback.

The client remains challenge-capable before each relay enables enforcement.
Operator rollout and rollback details live in
`docs/knowledge/nip42-protected-read-rollout.md`.

Capability evidence, UI state, diagnostics, logs, and telemetry must remain
content-free. They must not include signed events or signatures, message
contents, ciphertext, protected filters, invoices, addresses, signer secrets,
NWC URIs, authentication challenges, auth events, or stable account-derived
session identifiers.

This prohibition does not prevent caching a validated signed public frontier.
Exact signed public declarations retained to resume publication are permitted
only inside the bounded retry checkpoint; they must not be copied into
capability evidence, UI state, diagnostics, logs, or telemetry.

### Derived systems

Any shared acceleration, cache, index, or routing system may derive only from
relay-visible state and must remain rebuildable rather than becoming hidden
network authority. It must never become a hidden API for private message
content or ciphertext, order contents, payment or invoice data, signer or auth
material, wallet credentials or recovery material, or wallet balances.

Device-local user caches that legitimately hold decrypted user data remain
inside their existing account and device boundary. They do not authorize moving
that material into shared derived infrastructure.

---

## Implementation Guidance

### Shared ownership

Relay normalization, signed-frontier resolution, NIP-65 and NIP-17
serialization, unified mutations, capability evidence, automatic ordering, and
route-aware planning live in shared code. Market and Merchant routes compose
the same shared feature rather than rebuilding it or supplying behavior flags.

### Protected executor boundary

Protected-read transport is a Conduit-owned relay executor. It accepts and
returns plain clone-safe Nostr filters and events and owns WebSocket lifecycle,
subscription ids, NIP-42 challenge and `OK` state, bounded retries, reconnect
authentication, validation, source provenance, and typed outcomes. It does not
import NDK.

NDK remains only at named edges that adapt the active external signer or unwrap
gift wraps. An authenticated connection is keyed by normalized relay URL plus
a random process-local account-session scope, never shared with public read
connections or another account, and closed on logout or account switch, signer
changes, relay removal or Read disable, auth failure, lease replacement, and
reconnect.

### Local persistence boundary

Permitted local records are implementation evidence, not settings:

- cached exact signed events with provenance and freshness;
- unpublished in-progress drafts;
- capability observations with timestamps and scope;
- exact signed-event retry checkpoints with immutable target plans;
- bounded account-and-device-scoped legacy inbox-read recovery records that
  survive incomplete migration and restart until a usable `kind:10050` is fully
  signed and durably staged or the user explicitly discards recovery;
- durable account-and-device-scoped migration discard tombstones that survive
  restart for the legacy migration reader's lifetime and prevent discarded
  recovery from being reconstructed.

No local record may outrank a newer validated signed frontier. The migration
records are not signed account authority or membership and never define write
targets or publication input. Cross-app convergence comes from Nostr, not from
attempting to share browser storage.

---

## Open Implementation Decisions

The product contract is settled. Bounded implementation choices remain:

- exact URL normalization and accepted input formats;
- discovery coverage plan, timeouts, and stale thresholds;
- cache and capability-observation TTLs;
- retry checkpoint retention and expiry;
- future optimizer probe safety, disclosure, and policy versioning.

These decisions may not reintroduce app-local authority, separate Market and
Merchant behavior, manual commerce ranking, silent probes, or automatic relay
removal.

---

## Summary

The Network experience is a shared projection over signed Nostr state:

- `kind:10002` expresses Read and Publish membership.
- `kind:10050` expresses Private inbox membership.
- Both frontiers reconcile on every fresh signer connection.
- One flat list presents their combined meaning.
- Evidence-labelled capabilities drive automatic ordering without claiming
  health.
- One reviewed action may create two separately signed and recoverable events.
- Active capability testing and recommendations remain a future, explicit
  optimizer flow.

Core rule:

> Signed account state defines relay participation. Conduit presents and
> updates that state as one coherent Network experience.

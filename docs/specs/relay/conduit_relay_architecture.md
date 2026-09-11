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
Private inbox, or any combination. A reviewed signed-role action may therefore
require one or two honest signer requests. Reordering otherwise equivalent
relay operations is Conduit-local and requires none.

The latest validated signed frontier for each event kind is authoritative.
Unsigned local desired roles are not account authority; the active review draft
exists only in memory. Local persistence is limited to cached signed evidence,
capability observations, exact signed-event retry checkpoints, causal
whole-relay exclusions, a signer-free preferred order, and independent
account-and-device-scoped recovery batches for locally staged `kind:10050`
replacements.

Conduit groups the flat list by current membership and scoped capability
evidence. A signer-free Conduit-local preference may order only otherwise
eligible and equivalent rows or operations within those groups. It is shared
where Conduit storage is shared but is not synchronized as another authority
across isolated devices. Advertised relay-protocol capabilities may support
badges and group remaining rows, but they do not establish commerce
compatibility. NIP-65 tag order is not presented as a cross-client protocol
priority.

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

### Authority-scoped transport eligibility

For an authenticated owner's own account activity, a relay explicitly selected
in Network may use `ws://` or `wss://`. This includes a new selection and an
existing relay in that owner's Network configuration. A `ws://` selection does
not block Review or Save, but the shared UI identifies it as **Unencrypted
connection** and calmly explains that transport encryption is absent and it
should be used only when the owner controls the relay or explicitly trusts the
relay and network path.

The exception follows the active owner's explicit Network authority, not the
URL alone. Conduit must never automatically contact a `ws://` URL learned from
remote discovery, metadata, event hints, cache provenance, compatibility or
fallback configuration, or another account's signed declaration. In
particular, a recipient's `ws://` `kind:10050` relay is not an eligible delivery
target for the sender. Remote `wss://` relays remain eligible under the normal
routing, evidence, validity, and whole-relay-exclusion rules.

Keeping or displaying a remote `ws://` URL as evidence does not authorize a
connection. Every executor must reapply the active-account and explicit
Network-selection test immediately before final I/O. This is a narrow Network
Settings and inbox-recovery rule, not a generic transport abstraction.

### Evidence-labelled capabilities

- **Configured:** supplied by Conduit's versioned compatibility configuration.
- **Advertised:** claimed by current NIP-11 metadata.
- **Observed:** demonstrated by a bounded operation, including its scope and
  observation time.

Configured and advertised evidence are useful but are not live health checks.
An observation proves only the exact operation that ran; it does not establish
universal relay availability or interoperability.

The Network screen must not use separate Commerce and Other sections,
app-specific relay roles, or any ordering control that overrides eligibility or
evidence. Capability evidence defines the groups inside which the local
preference may order equivalent operations.

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

### Signed reconstruction

Reconnect or reset reconstructs account membership from validated published
`kind:10002` and `kind:10050` evidence. Unpublished legacy local Network settings
and their migration markers are disposable and ignored. They do not seed a
review draft, recovery batch, retry, or relay I/O. If valid published state is
absent, the user explicitly sets up or repairs their configuration in Network.
Partial or unavailable discovery remains unknown, not absence.

Current-protocol signed evidence, exact pending checkpoints, causal exclusions,
and private-inbox cutover recovery retain their existing persistence and
lifecycle. Stronger verified current signed authority can clear its causal
exclusion without depending on legacy localStorage cleanup.

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

Entering a `ws://` candidate is an explicit owner selection for this bounded
Network workflow, so metadata discovery may use it for the authenticated
owner's own account. The unencrypted-connection notice remains informational
through Review and Save.

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

### Conduit-local ordering

The flat list first uses these presentation and planning groups:

1. Active relays with current configured commerce evidence.
2. Active relays with scoped observed commerce compatibility.
3. Other active relays with applicable advertised relay-protocol evidence.
4. Remaining active relays.
5. Unpublished candidates or drafts.

Only the first two tiers claim commerce compatibility. Advertised protocol
evidence is a weaker supporting tier or badge and must not be labelled as
advertised commerce compatibility.

Within a tier, a signer-free Conduit-local preference may order only otherwise
eligible and equivalent rows or operations. The preference is shared wherever
Conduit storage is shared and otherwise remains isolated to the device. Stable
signed declaration order and normalized URL provide deterministic fallbacks
when no local preference applies.

This order is only a Conduit display and execution preference. It never
overrides protocol event ordering, signed authority, `kind:10050` routing,
whole-relay exclusions, validity, or evidence rules. NIP-65 does not define
relay tag order as a cross-client priority signal, and Conduit must not create
another synchronized authority merely to make this order portable.

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

A row whose normalized URL uses `ws://` also shows **Unencrypted connection**
and the transport-trust guidance above. The notice does not disable its role
controls, Review, or Save.

Media-server preferences remain a separate section because Blossom servers
are not Nostr relays and are outside `kind:10002` and `kind:10050`.

### One reviewed update

The user reviews one desired account configuration and selects one update
action. A signed role update may show one or two signer requests because Nostr
requires separate signed events. A local reorder shows none. The UI may explain
this plainly, but it must not pretend the signer requests or network
publications are atomic.

### Removing a relay

The explicit **Remove from my whole setup** action removes the normalized URL
from every applicable role in the desired account configuration and durably
records a causal local exclusion. It prepares only the signed frontiers whose
semantics change. After the required checkpoints are staged, every later read,
publish, retry, private-inbox route, and recovery operation must fail closed for
that account and URL until stronger own signed evidence explicitly re-adds it.

The confirmation is one concise proceed/cancel warning:

> Remove this relay from your whole setup? After you complete any required
> signer requests, Conduit will stop reading, publishing, and checking it for
> private messages immediately. Stale clients may still send messages there,
> and those messages can be missed.

There is no multi-step impact-review workflow. Cancel, signer refusal, or any
missing required signature changes no runtime route and deletes no working
recovery lane.

Acceptance is explicit: only frontiers whose signed semantics change produce
replacement events; Cancel or any missing required signature produces neither
publication nor runtime cutover.

The desired configuration must retain at least one Publish relay. One Publish
relay is valid but receives a redundancy warning. A reviewed change must not
eliminate the last usable Private inbox without selecting a replacement, and
private inbox declarations retain NIP-17's one-to-three relay guidance. An
account that already has no usable Private inbox may still change Read or
Publish roles. Removing a current Private inbox always requires selecting a
current replacement, even when a different recovery-only read route survives.
For an account that is already signed-empty, the guard also prevents an action
from removing its final recovery-only read route, but does not force inbox setup
for an unrelated Read or Publish change. The UI gives one direct replacement instruction
rather than an elaborate dependency analysis.

### Private inbox cutover

An ordinary Private inbox role change is distinct from explicit whole-setup
removal. After every event required by the reviewed action is signed and durably
staged:

- new gift-wrap writes target the pending `kind:10050` declaration;
- the previous valid inboxes enter an independent read-only recovery batch owned
  by that locally staged replacement;
- those previous inboxes are not current membership and never authorize a new
  write;
- an exact readback of the pending event from the bounded shared discovery set
  starts that batch's seven-day, versioned stale-sender grace period;
- reads union every batch whose exact readback is pending or whose own grace has
  not expired.

The owning replacement identity, grace-policy version, readback evidence, and
expiry are stored with each batch. Until that replacement's exact readback, its
previous inboxes remain read-only and its clock has not started. A stronger
signed frontier, including one produced by another client, preserves existing
batches but creates none without a matching locally staged immutable replacement
plan. A signer-free redistribution of the same exact event may append an
inbox-only immutable confirmation attempt for the current shared set. An attempt
completes only after the exact event is observed on at least one target, every
target has a conclusive result, and no target has become policy-blocked. A
whole-relay removal never retroactively shrinks or completes that historical
attempt; the same exact event may be redistributed signer-free to add a fresh
attempt for the then-current unblocked shared set. Any one completed attempt
starts the batch clock exactly once; later attempts or observations never reset
it. An explicitly removed relay is
filtered from every batch's active recovery set immediately after the atomic
local commit, even before ACK or readback. Its immutable confirmation-plan entry
remains only as policy-blocked historical evidence and cannot be queried or
reactivated.
This privacy cutoff intentionally accepts that messages from stale clients can
be missed. Persisted legacy singleton cutover records up-convert to one batch
without resetting any established readback or expiry.

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
frontiers. Before any relay write, the account Network mutation module must:

1. Reconcile both frontiers again at action time.
2. Reject or pause destructive replacement when current safe frontiers cannot
   be established.
3. Derive every and only changed signed event.
4. Prepare every changed event draft.
5. Obtain every required signature.
6. Persist the exact signed bytes and immutable target relay plans.

Only after all required signatures and retry checkpoints exist may publication
begin or the runtime change. At that point, the runtime applies the role-specific
pending cutover above while the UI shows that network confirmation is pending.
If any required signer request is cancelled or fails, no event is published, no
pending projection is activated, and existing recovery behavior remains
unchanged.

Before opening any relay connection, each final executor filters the immutable
plan again through the authority-scoped transport rule. Earlier normalization,
discovery, signed-event validation, retained evidence, or plan construction does
not authorize automatic contact with a remotely supplied `ws://` URL.

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

Commerce planners may use capability groups and the Conduit-local order inside
an otherwise equivalent group as a bounded planning bias. Valid signatures,
replaceable/addressable semantics, deletion events,
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
pending declaration. The locally staged replacement owns an independent batch
of previous valid inboxes. Reads union all batches awaiting their own exact
shared-set readback or still within their own seven-day stale-sender grace. A
stronger signed frontier, including one produced by another client, preserves
existing batches but creates no batch without a local immutable replacement
plan. If replacement B creates a batch for inbox A and replacement C is staged
before B's grace expires, C creates another batch for inbox B. Reads include
both A and B until their owning batches independently confirm and expire;
confirmation or redistribution for C cannot reset, truncate, or delete B's
batch for A. A whole-relay removal filters its URL from reads, writes, and every
batch immediately after the atomic local commit; general NIP-65 membership
never substitutes for this narrowly defined cutover policy.

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
serialization, unified mutations, capability evidence, bounded local ordering,
and route-aware planning live in shared code. Market and Merchant routes
compose the same shared feature rather than rebuilding it or supplying behavior
flags.

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
- one in-memory reviewed draft, which is not a persisted authority;
- capability observations with timestamps and scope;
- exact signed-event retry checkpoints with immutable target plans;
- causal whole-relay exclusions that gate every later account operation;
- a signer-free preferred order limited to otherwise eligible and equivalent
  Conduit operations;
- independent account-and-device-scoped inbox-recovery batches, each owned by a
  locally staged immutable `kind:10050` replacement plan and carrying its own
  exact shared-set readback and seven-day expiry state; legacy singleton records
  up-convert to one such batch.

No local record may outrank a newer validated signed frontier. Recovery batches
are not current membership and never define write targets or publication input.
Signed membership converges through Nostr. Local ordering is shared only where
Conduit storage is already shared; isolated devices do not gain another
synchronized authority.

---

## Open Implementation Decisions

The product contract is settled. Bounded implementation choices remain:

- exact URL normalization and accepted input formats;
- discovery coverage plan, timeouts, and stale thresholds;
- cache and capability-observation TTLs;
- retry checkpoint retention and expiry;
- future optimizer probe safety, disclosure, and policy versioning.

These decisions may not reintroduce app-local authority, separate Market and
Merchant behavior, ordering that overrides eligibility or evidence, silent
probes, or automatic relay removal.

---

## Summary

The Network experience is a shared projection over signed Nostr state:

- `kind:10002` expresses Read and Publish membership.
- `kind:10050` expresses Private inbox membership.
- Both frontiers reconcile on every fresh signer connection.
- One flat list presents their combined meaning.
- Evidence-labelled capabilities define groups; a signer-free local preference
  may order only equivalent eligible operations without claiming health.
- One reviewed signed-role action may create one or two separately signed and
  recoverable events; a reorder creates none.
- Active capability testing and recommendations remain a future, explicit
  optimizer flow.

Core rule:

> Signed account state defines relay participation. Conduit presents and
> updates that state as one coherent Network experience.

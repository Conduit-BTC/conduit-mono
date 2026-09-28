# Conduit Relay Architecture

## Executive Summary

Conduit presents relay configuration as one account-level Network experience.
Market and Merchant share the Network state model and mutation workflow.
Their app routes provide account-level access without changing authority. The effective relay
plan has two transparent layers:

- **App Relays:** a versioned, code-owned Conduit registry that is enabled by
  default and supplies bounded baseline read, publish, and compatibility-inbox
  routes for the operations assigned to each entry.
- **Your Relays:** one account editor for the account's signed NIP-65
  `kind:10002` read/publish preferences and owner NIP-17 `kind:10050` private
  inboxes. Its local toggle controls only NIP-65 participation alongside App
  Relays; it never suppresses or hides valid owner inbox membership.

The account configuration is projected from two independent signed Nostr
objects:

- NIP-65 `kind:10002` expresses general read and publish participation.
- NIP-17 `kind:10050` expresses private inbox relays.

These events remain separate protocol objects. App policy is not published as
the user's Nostr preference and signed personal preferences are not relabelled
as Conduit defaults. A reviewed personal-setup action may therefore require one
or two honest signer requests. Enabling or disabling either local layer requires
none.

The latest validated signed frontier for each event kind is authoritative for
the user's published NIP-65 and NIP-17 declarations. A versioned, unsigned,
account-and-device-scoped policy records whether App Relays and personal NIP-65
relays participate in Conduit's own runtime plan. It cannot alter either signed
event, authorize recipient delivery outside NIP-17, or suppress reads from the
owner's valid signed `kind:10050` inbox declaration.

App Relays and Your Relays remain distinguishable account-level sources.
Every effective route retains source provenance, and normalized URLs are
deduplicated without losing the fact that more than one enabled source selected
them. Advertised relay metadata may supply a display name, square icon, and
evidence-labelled capability claims, but it does not establish commerce compatibility or
current health. NIP-65 tag order is not presented as a cross-client protocol
priority.

Capability claims must name their evidence. Configuration and NIP-11 metadata
can support claims in the current experience, but neither proves current relay
health or successful application behavior. Conduit does not run an end-user
optimizer, active relay scan, or silent probe. Operator qualification of the
versioned App Relay registry is separate release evidence, not a user workflow.

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

Conduit supplies a safe baseline while keeping every routing source visible and
giving users control over participation. Signed Nostr declarations remain the
portable personal setup.

### Relay participation

- **App Read / Publish:** Conduit may use the operation-specific routes assigned
  by the versioned App Relay registry while App Relays are enabled.
- **Personal Read / Publish:** Conduit may use the account's NIP-65 Read and
  Publish members while Your Relays are enabled.
- **Private inbox:** Other NIP-17 clients may deliver the user's private
  messages through relays declared by the account's `kind:10050`. A valid owner
  declaration remains active for Conduit inbox reads regardless of the Your
  Relays toggle.

### Authority-scoped transport eligibility

For an authenticated owner's own account activity, a relay explicitly selected
in Network may use `ws://` or `wss://`. This includes a new selection and an
existing relay in that owner's Network configuration. A `ws://` selection remains available only after the owner is informed
that transport encryption is absent and the relay should be used only when
the owner controls it or explicitly trusts the relay and network path.

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

The account-level Network model distinguishes App Relays from Your Relays, but does not invent
separate signed Commerce and Other roles. Registry assignments and capability
evidence must not override signed recipient routing, exclusions, transport
eligibility, or event validity.

### Versioned App Relay registry

The code-owned registry gives each normalized secure relay URL an explicit,
bounded set of roles such as general read, public write, commerce read/write,
compatibility inbox read, or validated-order compatibility write. Registry
order may break ties inside one operation, but does not make a relay network
authority. General-purpose and private-message roles are not inferred from one
another.

Every release records a registry policy version. Adding a relay to a sensitive
role requires operator-owned evidence for that role; NIP-11 advertisement alone
is insufficient. Registry changes affect the Conduit App Relays layer after an
ordinary application update. They do not rewrite a user's signed events, remove
personal routes, clear exclusions, or silently enable an owner-disabled App
Relays layer.

The initial role matrix is:

| Relay                 | App roles                                                                     | Match Defaults preset     |
| --------------------- | ----------------------------------------------------------------------------- | ------------------------- |
| Conduit Relay         | General read/write, commerce, private inbox                                   | NIP-65 read/write; NIP-17 |
| Ditto Relay           | General read/write, commerce, private inbox                                   | NIP-65 read/write; NIP-17 |
| Dreamith Relay        | General read/write; no commerce or protected inbox until separately qualified | NIP-65 read/write         |
| Primal Public Relay   | Public write                                                                  | NIP-65 write              |
| `nos.lol`             | Scoped general read                                                           | None                      |
| Plebeian Market Relay | Scoped commerce discovery read                                                | None                      |

The registry stores normalized URLs; display names above are descriptive and
may be replaced by validated NIP-11 presentation metadata without changing the
role assignment.

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

The shared state projection joins the latest validated `kind:10002` and `kind:10050`
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
collapsed into absence. Cached signed evidence retains honest stale or degraded status when a fresh
attempt is incomplete; it must not be presented as freshly confirmed.

### Signed reconstruction

Reconnect or reset reconstructs personal account membership from validated
published `kind:10002` and `kind:10050` evidence, then composes it with the
current App Relay registry according to the versioned local layer policy.
Unpublished legacy local Network settings and their migration markers are
disposable and ignored. They do not seed a review draft, recovery batch, retry,
or signed relay membership.

App Relays initialize enabled. Personal NIP-65 routing initializes disabled only
after a complete bounded reconciliation establishes `kind:10002` absence within
the queried plan and no retained valid frontier exists. A valid existing NIP-65
frontier initializes or migrates personal routing enabled. Partial or unavailable
discovery remains unknown and preserves an existing local choice. A valid owner
`kind:10050` declaration remains available for inspection and editing and
eligible for private inbox reads independently of both initialization and the
Your Relays toggle.

Current-protocol signed evidence, exact pending checkpoints, causal exclusions,
layer choices, and private-inbox cutover recovery retain their existing
persistence and lifecycle. Stronger verified current signed authority can clear
its causal exclusion without depending on legacy localStorage cleanup.

---

## Capability Evidence

### Current Add Relay behavior

Adding a relay to the account setup:

1. Normalizes and validates the relay URL.
2. Deduplicates against the current projection and draft.
3. Performs bounded NIP-11 metadata discovery.
4. Preserves evidence-labelled capability claims and lets the owner choose
   membership.

Adding a candidate does not silently publish, run signed probes, or declare it
healthy. A missing or unreachable NIP-11 document remains unavailable metadata
and cannot invent a successful capability result.

Entering a `ws://` candidate is an explicit owner selection for this bounded
Network workflow, so metadata discovery may use it for the authenticated
owner's own account. The unencrypted transport risk remains part of the owner's
review before commitment.

### NIP-11 limits

NIP-11 describes relay-visible protocol and policy claims. Its
`supported_nips` list may support advertised badges for relay protocol
capabilities such as NIP-42 authentication or NIP-50 search. Its `name` and
square `icon` may identify a relay in the Network UI after URL and media-policy
validation, with the normalized relay URL still available and a local fallback
when metadata is absent, invalid, unavailable, or fails to load.
Remote icons must use bounded secure HTTPS URLs, load lazily without a referrer,
and never block the row or relay operation. Loopback development URLs may use
the same explicit local-development exception as other browser assets.

It must not be used to prove client/application/event semantics such as
NIP-17, NIP-33, NIP-65, NIP-99, or Open Markets product behavior. In
particular:

- NIP-42 advertisement is not a successful authenticated request.
- An observed AUTH challenge is not a positive auth `OK`.
- One successful authenticated connection does not prove recipient isolation
  for every filter.
- Metadata reachability is not relay read or publish health.
- A relay name or icon is advertised presentation metadata, not verified
  operator identity, ownership, endorsement, or capability.

Detailed capability claims must distinguish advertised, challenge-observed,
succeeded, rejected, and unavailable authentication evidence without implying
that one class proves another.

### Conduit-local ordering

Within each section, presentation and planning use these evidence groups:

1. Active relays with current configured commerce evidence.
2. Active relays with scoped observed commerce compatibility.
3. Other active relays with applicable advertised relay-protocol evidence.
4. Remaining active relays.
5. Unpublished candidates or drafts.

Only the first two tiers claim commerce compatibility. Advertised protocol
evidence is a weaker supporting tier and must not be labelled as commerce
compatibility.

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

### No end-user optimizer

The Network surface does not actively scan relays, run signed probes, or ask the
user to complete an optimization wizard. It presents signed configuration,
versioned registry evidence, NIP-11 metadata, and scoped observations already
produced by real operations.

Adding a relay may fetch bounded NIP-11 metadata, but does not label the relay
healthy. Operator qualification may use release-time read, write, replacement,
deletion, protected-read, and acknowledgement checks before a relay enters an
App Relay role. Those checks remain external release evidence and must not be
recast as user-specific proof or silently mutate a user's signed setup.

---

## Shared Network UI Contract

### Account-level Network behavior

Market and Merchant use the same shared Network state model, controller, and
mutation workflow. Their presentation may vary, but neither app may change
relay authority, evidence classification, ordering rules, reconciliation, or
safety gates. Account owners can distinguish the code-owned App Relay layer
from portable signed NIP-65 and NIP-17 Your Relays membership. Local layer
toggles must never be represented as published Nostr events. Cached, partial,
and degraded signed evidence retains its source, freshness, and coverage.

An owner can inspect effective routes and their source provenance, including a
URL selected by both layers. Normalized URLs are deduplicated for execution
without discarding either source. A URL declared only in owner `kind:10050`
remains available for inspection and editing when personal NIP-65 routing is
off. The Your Relays switch affects only additive NIP-65 participation; it
never suppresses valid owner Private inbox reads. App Relays remain enabled by
default. Media-server preferences remain separate from Nostr relay membership.

Capability and health claims must identify their evidence class and freshness.
NIP-11 names and icons are advertised metadata, not verified ownership,
endorsement, compatibility, or health. The normalized URL remains available
when that metadata is absent or invalid. A `ws://` selection remains possible
for the authenticated owner, but before committing it the owner must understand
that transport encryption is absent and that use requires control of, or
explicit trust in, the relay and network path.

### Layer changes and readiness

Changing a local layer toggle requires no signer. Before turning App Relays off,
the owner must understand any material loss of coverage when Your Relays is
disabled, no enabled personal Publish member has positively established
commerce compatibility, or no valid Private inbox is current. Partial or
unavailable capability is unverified, not broken. The owner may explicitly
proceed. The choice is persisted before a later operation can use an App Relay,
and every final executor rechecks layer policy and whole-relay exclusions before
I/O. Disabling Your Relays removes personal NIP-65 members from general read
and publish plans without changing either signed event, owner inbox reads, or
recipient-declared delivery routes.

The owner reviews one desired account configuration and explicitly accepts its
update. Changed signed frontiers may require separate signer requests and
independent publications; a local reorder requires none. The experience must
not imply those requests or publications are atomic.

### Whole-relay removal

A whole-relay removal excludes the normalized URL from every applicable role
and durably records a causal local exclusion. Only changed signed frontiers
produce replacement events. After all required exact signed checkpoints are
staged, every read, publish, retry, Private inbox route, and recovery operation
for that account and URL fails closed until stronger own signed evidence
explicitly re-adds it.

Before accepting this destructive action, the owner must understand that the
client stops using the relay after required signatures, while stale clients may
still send private messages there that Conduit will miss. Cancellation, signer
refusal, or any missing required signature produces no publication, runtime
cutover, or loss of a working recovery lane.

The desired configuration retains at least one Publish relay. A single Publish
relay is valid, but its reduced redundancy must be clear before the relevant
change. A reviewed change cannot eliminate the last usable Private inbox
without a replacement; Private inbox declarations retain NIP-17's one-to-three
relay guidance. An account already lacking a usable Private inbox can still
change unrelated Read or Publish roles. Removing a current Private inbox
requires selecting a current replacement even when a recovery-only read route
survives. For a signed-empty account, the guard also preserves the final
recovery-only read route. The owner receives an actionable replacement path.

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

### Match Conduit defaults

After complete bounded reconciliation observes neither required setup object
within the queried plan, finds no retained valid frontier, and has no pending
distribution, Network may offer an explicit setup action. Before accepting it,
the owner reviews the exact proposed NIP-65 Read and Publish tags and NIP-17
Private inbox tags. Acceptance uses the sole Network mutation owner and
publishes only changed event kinds. This may require zero,
one, or two honest signer requests. Every required signed event is durably
staged before publication begins; retry reuses the exact signed bytes.

For an existing signed setup, the setup action adds missing Conduit defaults
without destructive replacement. Existing tags and durable whole-relay
exclusions are preserved, inbox guidance remains capped at one to three relays, and no
relay is evicted automatically. The exact registry version used for the
proposal is part of the review and immutable target plan.

This state is scoped absence, not proof that the account never published either
replaceable event. The exact review warns that signing may supersede preferences
stored outside the queried plan. Partial or unavailable discovery cannot
authorize replacement-shaped setup; it remains retryable. A current
`signed_empty` or `malformed` frontier is explicit signed evidence and is never silently
overwritten by this prompt.

Declining the setup action changes no signed preference. Successful staging
enables Your Relays locally while App Relays remain enabled. Publishing both
objects improves portable relay and private-inbox discovery, but no
customer-facing claim may promise
that another app understands Conduit's kind-16 commerce messages.

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
pending cutover above while network confirmation remains explicitly pending in
state and in any account-owner decision that depends on it.
If any required signer request is cancelled or fails, no event is published, no
pending projection is activated, and existing recovery behavior remains
unchanged.

Before opening any relay connection, each final executor filters the immutable
plan again through the current layer toggles, durable whole-relay exclusions,
and authority-scoped transport rule. Earlier normalization, discovery,
signed-event validation, retained evidence, or plan construction does not
authorize a disabled App Relay, a disabled personal NIP-65 route, an excluded
URL, or automatic contact with a remotely supplied `ws://` URL. Recipient
`kind:10050` delivery remains independent of the sender's layer toggles, but is
still subject to secure-transport and exclusion rules at final I/O.

Each signed event is then published and read back independently. Outcomes must
distinguish at least:

- accepted;
- rejected;
- timeout or unavailable;
- accepted but readback pending;
- exact event confirmed by readback.

One event may confirm while the other remains retryable. The partial state
remains observable to the account owner and must not be reported as a complete
combined action. Retries reuse the
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

Runtime planners consume enabled sources explicitly. App Relay entries supply
only the operation roles assigned by the current registry while App Relays are
enabled. Personal NIP-65 members supply general reads and publishes while Your
Relays are enabled. A normalized URL selected by both sources is contacted once
and retains both provenance labels.

The latest usable validated signed projection keeps explicit stale or degraded
provenance when only cached evidence is available. An unsigned draft does not
change runtime behavior. A fully signed and durably staged pending projection
may do so before network confirmation, with that pending status retained and
observable and subject to supersession by newer reconciled signed evidence. General
publishes retain per-relay acceptance, rejection, and timeout outcomes.

### Commerce behavior

Commerce planners may use the operation-specific App Relay registry,
evidence-labelled capability groups, and the Conduit-local order inside an
otherwise equivalent group as a bounded planning bias. Valid signatures,
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

Conduit follows the recipient's declared one-to-three inbox relays exclusively
for delivery when a valid declaration is available. A valid owner's declaration
also remains active for inbox reads even when Your Relays is disabled. An empty,
malformed, stale, partial, or unavailable declaration remains a distinct state;
the runtime must not silently treat all of them as the same fallback case.

#### Temporary validated-order compatibility role (CND-208)

While users migrate to valid `kind:10050` declarations, a bounded set of
private-inbox-compatible relays serves two roles:

- **Compatibility reads:** clients union the bounded compatibility read set
  with declared inboxes when reading their own gift wraps.
- **Compatibility order writes:** behind an independent deployment-profile
  flag, validated kind-16 order gift wraps may be written to at most three
  relays from the operator-approved registry only when a completed bounded
  lookup resolves to `not_observed` and no retained signed frontier exists.

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
`signed_empty`, `malformed`, `lookup_partial`, and `lookup_unavailable` never
authorize the compatibility write lane. Kind-14 general DMs never use it.

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
serialization, unified mutations, versioned App Relay policy, layer-state
migration, capability evidence, bounded local ordering, and route-aware
planning live in shared code. Market and Merchant routes compose the same
shared feature rather than rebuilding it or supplying behavior flags.

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

Permitted local records include implementation evidence and the narrow,
versioned Conduit layer policy:

- cached exact signed events with provenance and freshness;
- one in-memory reviewed draft, which is not a persisted authority;
- capability observations with timestamps and scope;
- exact signed-event retry checkpoints with immutable target plans;
- causal whole-relay exclusions that gate every later account operation;
- a signer-free preferred order limited to otherwise eligible and equivalent
  Conduit operations;
- account-and-device-scoped App Relays enabled, Your Relays enabled, setup
  notice dismissal/touched state, and the policy-schema version;
- independent account-and-device-scoped inbox-recovery batches, each owned by a
  locally staged immutable `kind:10050` replacement plan and carrying its own
  exact shared-set readback and seven-day expiry state; legacy singleton records
  up-convert to one such batch.

No local record may rewrite or outrank a newer validated signed frontier. The
layer policy decides whether Conduit's own general runtime plans include the
registry and personal NIP-65 sources; it is not published account authority and
cannot disable a valid owner inbox declaration or widen recipient delivery.
Recovery batches are not current membership and never define write targets or
publication input. Signed membership converges through Nostr. Local policy is
shared only where Conduit storage is already shared; isolated devices do not
gain another synchronized authority.

---

## Open Implementation Decisions

The product contract is settled. Bounded implementation choices remain:

- exact URL normalization and accepted input formats;
- discovery coverage plan, timeouts, and stale thresholds;
- cache and capability-observation TTLs;
- retry checkpoint retention and expiry;
- App Relay registry qualification evidence, role limits, and policy versioning.

These decisions may not create separate Market and Merchant behavior, ordering
that overrides eligibility or evidence, silent end-user probes, automatic relay
removal, or compatibility routing outside its validated kind-16 boundary.

---

## Summary

The Network experience combines a safe, transparent Conduit baseline with
portable signed Nostr state:

- `kind:10002` expresses Read and Publish membership.
- `kind:10050` expresses Private inbox membership.
- Both frontiers reconcile on every fresh signer connection.
- App Relays are enabled by default from a versioned operation-specific
  registry.
- Your Relays displays signed NIP-65 and owner `kind:10050` membership; its
  switch adds only NIP-65 routes alongside App Relays and initializes off only
  after complete scoped absence with no retained NIP-65 frontier.
- Separate App Relays and Your Relays sections present source and consequence.
- Valid signed owner inbox reads remain active independent of the personal
  layer toggle; valid recipient inbox declarations remain exclusive for writes.
- Evidence-labelled capabilities define groups; a signer-free local preference
  may order only equivalent eligible operations without claiming health.
- One reviewed signed-role action may create one or two separately signed and
  recoverable events; a reorder creates none.
- Exact reviewed Match Defaults may publish both NIP-65 and NIP-17 through the
  sole mutation owner; there is no optimizer or active end-user scan.

Core rule:

> Conduit provides safe app defaults, preserves signed relay authority, and
> keeps every routing source and unsafe cutoff explicit.

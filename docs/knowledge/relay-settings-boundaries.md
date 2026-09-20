# Relay Settings Boundaries

This note separates signed account configuration, discovery evidence, and
runtime execution planning. It does not replace the relay architecture spec.

## Account Configuration Boundary

Conduit composes one account-level Network experience from a transparent app
baseline, narrow local layer policy, and two independent replaceable Nostr
events:

- A versioned App Relay registry supplies operation-specific Conduit defaults.
- NIP-65 `kind:10002` supplies Read and Publish membership.
- NIP-17 `kind:10050` supplies Private inbox membership.

The latest validated signed frontier for each kind is authoritative for the
portable personal declaration. App Relays start enabled; Your Relays includes
NIP-65 members alongside them when enabled. Your Relays starts disabled only
after complete bounded discovery confirms that no valid or retained NIP-65
frontier exists. Market and Merchant render the same shared projection and
mutation workflow; their routes are navigation shells, not separate settings
products.

The combined UI does not create a combined protocol event. A reviewed signed
role change may require one or two signatures and produces one replacement
event for each changed frontier. Layer toggles and reordering otherwise
equivalent relays are Conduit-local and require no signer request. A valid owner
`kind:10050` remains active for inbox reads regardless of the Your Relays toggle.

## Distinct Relay Data Sets

Conduit works with four classes of relay data:

- **App Relay registry and layer policy:** a versioned code-owned role registry
  plus account-and-device-scoped enablement. This affects Conduit's own runtime
  plans but is not signed account authority.
- **Signed account configuration:** the user's validated `kind:10002` and
  `kind:10050` events. Only this data defines portable personal membership and
  recipient inbox authority.
- **Discovery evidence:** signed relay declarations for other pubkeys, cached
  events, NIP-11 documents, configured capability evidence, and scoped runtime
  observations. This evidence may guide planning or badges but cannot mutate
  the user's configuration.
- **Execution plans:** bounded runtime choices derived from signed membership,
  actual route requirements, enabled layers, capability evidence, and explicit
  compatibility or recovery policy.

Relays learned while browsing products, resolving authors, or routing to a
recipient must not be merged into the signed account configuration. NIP-65
membership also must not be treated as a private-message fallback. NIP-17
delivery follows the recipient's valid `kind:10050` declaration; named
compatibility exceptions remain bounded by their own registries and removal
gates.

For the validated-order exception, only complete bounded `not_observed` with no
retained signed frontier permits compatibility writes. `signed_empty`,
`malformed`, `lookup_partial`, and `lookup_unavailable` cannot. The lane remains
kind-16-only; general kind-14 DMs never use it.

## Transport Authority Boundary

Transport eligibility is authority-scoped. For an authenticated owner's own
account activity, a relay that the owner explicitly selects in Network, whether
newly added or already present in that account's Network configuration, may use
`ws://` or `wss://`. A `ws://` selection remains eligible for Review and Save,
but the shared UI labels it **Unencrypted connection** and explains that
transport encryption is absent and the relay should be used only when the owner
controls it or explicitly trusts the relay and network path.

That permission is not transferable through discovery. Conduit must never
automatically contact a `ws://` URL learned from NIP-11 metadata, event hints,
cached provenance, fallback configuration, or another account's signed relay
declaration, including a recipient's `kind:10050`. Remotely learned `wss://`
relays remain eligible under the normal routing, evidence, validity, and
whole-relay-exclusion rules.

Parsing, retaining, or presenting a remote `ws://` URL does not authorize a
connection. Every relay executor rechecks the active authenticated account and
the URL's explicit Network-selection authority immediately before final I/O.
This is a narrow Network Settings and inbox-routing rule, not a generic
transport abstraction.

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

Local persistence contains implementation evidence plus a narrow, visible
Conduit runtime policy. It is limited to:

- cached exact signed events with source and freshness;
- one in-memory draft while a change is being reviewed; it is not persisted as
  account authority;
- capability observations with scope and observation time;
- exact signed-event retry checkpoints with immutable target plans;
- causal whole-relay exclusions that block later I/O until stronger own signed
  evidence explicitly re-adds the URL;
- a signer-free preferred relay order that can rank only otherwise eligible and
  equivalent Conduit operations;
- account-and-device-scoped App Relays enabled, Your Relays enabled, setup
  notice touched/dismissed state, and the policy-schema version;
- independent account-and-device-scoped recovery batches owned by locally
  staged `kind:10050` replacements, with exact readback and expiry evidence.

None of these records may rewrite or outrank a newer validated signed frontier.
The layer policy decides whether Conduit's general runtime plan includes App
Relay or personal NIP-65 sources; it cannot disable valid owner inbox reads or
widen recipient delivery. An unsigned draft does not change runtime behavior.
Once every requested event is signed and its exact bytes and immutable target
plan are durably staged, the runtime may honor the pending projection
immediately while network confirmation remains visible. Signed membership
converges through Nostr. Local ordering is shared only where Conduit storage is
already shared; isolated devices do not gain a second synchronized ordering
authority.

### Signed reconstruction

Reconnect or reset reconstructs personal membership from validated published
`kind:10002` and `kind:10050` evidence and composes it with the current App
Relay registry. App Relays initialize enabled. Your Relays initializes disabled
only after complete scoped absence with no retained NIP-65 frontier; a valid
existing frontier migrates enabled, and partial or unavailable discovery
preserves the existing local choice. Unpublished legacy local Network
membership, migration markers, and legacy inbox-read recovery records are
disposable and ignored. They do not seed signed review drafts, recovery, or
retries.

Stronger verified current signed evidence clears its causal exclusion without
depending on legacy localStorage cleanup. Permanent signed evidence, exact
pending checkpoints, and private-inbox cutover recovery retain their existing
persistence and lifecycle.

## App Relays, Your Relays, and Local Ordering

The shared screen presents separate **App Relays** and **Your Relays** sections.
A URL may appear in both so provenance remains clear; execution normalizes and
deduplicates the URL while retaining every enabled source. Rows may expose
Read, Publish, signed Private inbox membership, NIP-11 identity metadata, and
evidence-labelled capability badges.

Conduit first groups rows using:

1. current configured commerce evidence;
2. scoped observed commerce compatibility;
3. other active relays with applicable advertised relay-protocol evidence;
4. remaining active relays;
5. unpublished candidates or drafts.

Only configured or scoped observed evidence can place a relay in a Commerce
tier. Advertised relay-protocol capability is a weaker supporting tier or badge,
not advertised commerce compatibility.

Within otherwise eligible and equivalent groups, the user may set a
Conduit-local preferred order without a signer request. The preference is shared
where Conduit storage is shared and otherwise remains isolated to the device.
Stable signed declaration order and normalized URL provide deterministic
fallbacks when no local preference applies.

This order is only a Conduit display and execution preference. It never changes
protocol event ordering, signed authority, `kind:10050` routing, whole-relay
exclusions, validity, or evidence rules. NIP-65 does not make tag order a
cross-client priority, and Conduit does not create another synchronized
authority merely to make local order portable.

Turning App Relays off is an explicit signer-free cutoff. The confirmation
warns when Your Relays is disabled, the enabled personal list has no positively
qualified commerce Publish relay, or no current valid private inbox exists.
Partial or unavailable evidence is **Not verified**, not broken. The primary
action keeps defaults on, while **Turn off anyway** persists the cutoff. Every
executor re-reads layer policy and whole-relay exclusions immediately before
final I/O. Disabling Your Relays affects only personal NIP-65 general routes;
it does not suppress valid owner inbox reads or recipient-declared delivery.

## Capability Evidence Boundary

NIP-11 relay information documents are advertised capability evidence, not
proof. They are useful for relay-visible capabilities such as NIP-50 search and
NIP-42 authentication claims. A validated NIP-11 name and square icon may
identify a row, but remain advertised presentation metadata rather than
verified identity, ownership, endorsement, capability, or health.

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

There is no end-user optimizer, active scan, or silent probe. Operator-owned
qualification may test an App Relay's bounded role before release, but those
results are not user-specific proof and do not mutate signed configuration.

## Mutation and Retry Boundary

One reviewed signed-role action may update `kind:10002`, `kind:10050`, or both.
A local reorder updates neither. Explicit whole-relay removal clears the URL
from every applicable desired role, but prepares only the signed frontiers whose
semantics change. Before the first network write, the account Network mutation
module:

1. reconciles both frontiers;
2. derives every and only changed signed event;
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

Signer-free layer toggles persist independently of signed-event mutation.
Before any final connection, subscription, or publish, the executor rechecks
the current layer choice, causal whole-relay exclusions, route authority, and
transport eligibility. A stale plan cannot contact a newly disabled App Relay
or personal NIP-65 route. Recipient `kind:10050` remains independent of the
sender's layer choices but still passes final transport and exclusion checks.

Removing a relay from the whole setup removes it from every applicable role in
the desired projection and durably records a causal local exclusion. Only a
frontier whose signed semantics change produces a replacement event. The action
stops reads and writes through that URL immediately after every required exact
signed checkpoint is staged, before ACK or readback. Its concise proceed/cancel
warning states that stale clients may still send there and those messages can be
missed. Cancel or a missing required signature changes nothing and removes no
recovery behavior.

The desired configuration must retain at least one Publish relay. One Publish
relay is valid but receives a redundancy warning. A reviewed change may not
eliminate the last usable Private inbox without selecting a replacement. The UI
gives one direct replacement instruction rather than a multi-step impact review.
An account that already has no usable Private inbox may still change Read or
Publish roles. Removing a current Private inbox always requires selecting a
current replacement, even when a different recovery-only read route survives.
For an account that is already signed-empty, the guard also prevents an action
from removing its final recovery-only read route, but does not force inbox setup
for an unrelated Read or Publish change.

### Private inbox cutover

For an ordinary Private inbox role change, new writes use the fully signed and
staged pending declaration. Each locally staged replacement owns an independent
batch of previous valid inboxes. They are not shown as current membership and
never authorize writes.

Exact readback of each replacement event from its bounded shared discovery set
starts only that batch's seven-day, versioned stale-sender grace period. Reads
union every batch awaiting its own readback or still within its own grace. Each
batch retains its owning replacement identity, policy version, readback
evidence, and expiry. Until its own exact readback, that batch remains read-only
and its clock has not started. Stronger signed evidence, including a replacement
produced by another client, preserves existing batches but creates none without
a matching locally staged immutable replacement plan.

These windows may overlap. If replacement B creates a batch for inbox A and
replacement C is staged while A's batch is still pending or unexpired, C creates
a separate batch for inbox B. Reads union A and B as applicable, and neither
C's readback nor any later redistribution changes A's batch clock or expiry.

A signer-free redistribution of the same exact staged event may append another
immutable confirmation attempt to its existing batch when the shared set has
changed. An attempt completes only after the exact event is observed on at least
one target, every target has a conclusive result, and no target is policy-blocked.
Whole-relay removal leaves an affected historical attempt incomplete rather
than shrinking it; signer-free redistribution may add a fresh attempt for the
same exact event and current shared set. Completion of any one attempt starts
the batch clock exactly once. Later attempts or observations cannot restart it.

Explicit whole-relay removal overrides this recovery behavior for the removed
URL. After all required exact checkpoints are staged, that URL is excluded from
active reads, writes, and every batch's active recovery set immediately at the
atomic local commit. The batch retains its immutable confirmation plan and
records the URL as policy-blocked historical evidence; it is never queried or
made eligible again by that batch. This privacy cutoff accepts the warned risk
of missing messages sent by stale clients. Persisted legacy singleton cutover
records up-convert to one batch without resetting any established readback or
expiry.

## Match Defaults Boundary

After complete bounded reconciliation confirms scoped absence and no retained
frontier for both setup objects, Network may offer **Match Conduit defaults**.
The action shows an exact reviewed diff and may publish NIP-65 Read/Publish plus
NIP-17 Private inbox declarations through the sole Network mutation owner. Only
changed kinds are signed, every required exact event and immutable target plan
is staged before publication, and retries reuse those bytes.

For an existing signed setup, **Add missing Conduit defaults** preserves
personal tags and durable exclusions. It never silently evicts an inbox from a
full one-to-three-relay declaration. Partial/unavailable discovery and current
`signed_empty` or `malformed` frontiers permit Retry or manual review, not a
one-click replacement. Dismissal changes no signed state. Successful staging
enables Your Relays while leaving App Relays enabled.

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

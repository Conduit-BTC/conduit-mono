# Decentralized Network Product Posture

**Status:** Active engineering doctrine
**Applies to:** Nostr reads and writes, relay planning, cache and outbox state,
messaging, checkout, payments, identity, and interoperability behavior

## Core Rule

A protocol specification defines what valid protocol data means and how a
canonical implementation should emit it. It does not, by itself, establish
that ecosystem adoption or relay visibility is sufficient to make that data a
prerequisite for a user task.

Conduit keeps protocol truth and product availability as separate decisions:

- validate signatures, authorship, authorization, privacy, payment terms, and
  event semantics strictly;
- emit canonical protocol data by default;
- treat relay responses as bounded observations, not database authority;
- preserve safe user outcomes when discovery metadata is missing, delayed, or
  unevenly adopted;
- move users toward the canonical state through repair UX and measured,
  removable compatibility rather than punishment.

Product availability never authorizes weaker cryptography, ambiguous payment
terms, incorrect recipients, invalid events, or false delivery claims.

## Deterministic Assumptions To Reject

Traditional web systems often assume one authoritative server, complete reads,
atomic deployment, and a direct mapping from response status to application
truth. Those assumptions do not hold across independent relays and clients.

Do not assume:

- an empty relay response proves that an event does not exist;
- every planned relay is reachable at the same time;
- every client publishes newly recommended metadata;
- sender and recipient use overlapping discovery relays;
- a relay `OK` proves recipient receipt or application-level completion;
- current cache state is globally current, or current relay state is globally
  complete;
- retries are harmless unless the operation is idempotent;
- protocol adoption changes atomically across the ecosystem.

## Requirement Classes

Classify a requirement before turning it into a product gate.

| Requirement class                                                                                 | Default product behavior                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cryptographic validity, authorization, privacy, recipient identity, payment amount or destination | Fail closed. Do not add compatibility that weakens the invariant.                                                                    |
| Data integrity and monotonic signed evidence                                                      | Reject invalid new evidence and preserve stronger previously validated evidence. Relay omission cannot revoke it.                    |
| Discovery, capability, relay preference, or optional metadata                                     | Represent uncertainty explicitly. Use bounded reads, degraded state, and safe compatibility where justified.                         |
| Ecosystem migration                                                                               | Write canonically, read permissively within safety bounds, provide repair UX, measure adoption, and define an explicit removal gate. |

When a change spans classes, apply the strongest rule only to the fact it
protects. A payment-sensitive checkout can require positive live listing terms
without requiring exhaustive proof that no deletion exists anywhere.

## Reference Identity Is Not Relay Reachability

A product reference can be deterministically valid even when the current relay
plan cannot resolve it. For an addressable kind `30402` product, identity is the
exact kind, author public key, and `d` tag. A canonical
[`naddr`](https://github.com/nostr-protocol/nips/blob/master/19.md) preserves that
identity.

Relay and source hints are optional discovery aids. They are not part of product
identity and do not guarantee current availability, complete parent-and-variation
reconstruction, cart validation, checkout readiness, or global convergence.

Name the product outcome before adding relay behavior:

1. **Reference identity:** create, parse, validate, and share the exact address.
2. **Discovery or reachability:** attempt bounded resolution and report the
   observed coverage.
3. **Presentation completeness:** assemble related events when available and
   render an honest partial or degraded state when they are not.
4. **Action readiness:** require the positive current evidence needed for a
   consequential action such as checkout.

Completing one layer does not silently require the next. A reference-sharing
feature does not need new relay planning, source provenance, cache, cart, or
checkout behavior unless its accepted user outcome explicitly includes that
layer. When optional discovery hardening would expand into another subsystem,
remove or defer it as a separate capability unless a safety invariant or
canonical protocol requirement makes it necessary.

Deterministic tests can prove client decisions, bounded planner behavior, and
degraded-state transitions against controlled fixtures. They cannot prove
public-relay availability or global convergence.

## Network Evidence Model

Relay data is evidence with provenance, freshness, and coverage. It is not a
single authoritative snapshot.

Distributed read boundaries should preserve domain-appropriate versions of
these states instead of collapsing them into a boolean or empty array:

- `not_queried`: no observation attempt has completed;
- `present_current`: valid evidence was observed and is current enough for the
  decision;
- `present_stale`: previously valid evidence exists but freshness is degraded;
- `absent_within_scope`: a defined bounded plan completed without observing the
  item;
- `lookup_partial`: some planned sources completed and some did not;
- `lookup_unavailable`: no planned source completed;
- `conflicting`: valid sources disagree and resolution is not yet safe;
- `malformed`: data was observed but cannot safely express the claimed state;
- `revoked`: stronger valid protocol evidence explicitly invalidates an older
  state.

Domain names may differ, but the distinctions must survive through shared
state and user-facing decisions.

### Absence is scoped

A finite relay fanout cannot prove global Nostr absence. `absent_within_scope`
means only that a documented plan completed without observing the event. Code
and UI may translate that state into a domain action, but must not silently
promote it to a global fact.

Stronger negative evidence can exist, for example a valid signed deletion, an
explicit signed empty replaceable event, or a cryptographically valid
revocation. Preserve that evidence according to its protocol semantics.

Previously validated positive signed evidence is monotonic while it is
retained. Relay omission, settings changes, and discovery-topology changes may
make it stale or conflicting, but an empty or failed lookup does not erase it.
Only stronger valid protocol evidence or an explicit user action defined by the
protocol may supersede it. If a product decision must preserve that evidence
across restart, store it durably and account-scope it; an in-memory cache cannot
claim restart monotonicity.

Malformed data is not an implicit opt-out. It proves that the observed event is
unusable; it does not prove that the author intended to refuse a safe migration
path unless the protocol defines that event as an explicit disable signal. A
domain may still fail closed when malformed routing data leaves recipient,
privacy, or authorization ambiguous, but that is a named safety decision, not
inferred user intent. Keep a valid signed empty or revocation state distinct
from an unparseable event.

### Evidence requirements are action-specific

Define the minimum positive and negative evidence for the action being taken.

- Browsing may use cached or partial data with honest freshness state.
- Checkout requires adequate positive live evidence for payment-sensitive
  listing terms.
- Known valid deletion evidence blocks a deleted listing and remains monotonic.
- Incomplete deletion discovery does not, by itself, veto checkout.
- Sending private data requires a valid recipient and encrypted transport.
- Missing discovery metadata may enter a named compatibility lane only when
  its safety and privacy boundaries remain intact.

One unavailable relay receives veto power only when it was the sole source of a
required positive fact, not merely because it might have held unknown negative
evidence.

## Canonical Writes, Permissive Reads

Conduit should normally:

1. emit canonical, signed protocol events;
2. validate every event used for a consequential decision;
3. read across a bounded, source-aware plan;
4. retain stronger known evidence through temporary omission or outage;
5. parse safe historical or external variants behind explicit compatibility
   boundaries;
6. keep non-standard writes exceptional, narrower than permissive reads, and
   documented through the compatibility-exception process.

Permissive reads do not mean accepting invalid signatures, cross-author
deletions, malformed payment terms, untrusted recipient changes, or plaintext
fallbacks.

## Durable Operations And Delivery Truth

Design important operations for intermittent connectivity:

- persist signed or encrypted intent before the first delivery attempt when
  recovery matters;
- retry the same immutable operation instead of creating a second semantic
  action;
- deduplicate late, repeated, and out-of-order observations;
- classify permanent rejection separately from retryable timeout or outage;
- use bounded retry with backoff and jitter;
- preserve local usable state while background convergence continues;
- expose delivery truth in layers rather than one success boolean.

Recommended delivery vocabulary:

1. `locally_persisted`: the exact operation can survive restart;
2. `relay_accepted`: at least one intended relay acknowledged it;
3. `recipient_observed`: the recipient or its read path later observed it;
4. `semantically_confirmed`: the counterparty produced the expected protocol or
   business response.

A relay acknowledgement is not recipient receipt, read state, payment, or
fulfillment.

These patterns follow established intermittent-network practice: persistent
store-and-forward, asynchronous endpoints, idempotency, late binding, explicit
failure classes, and recovery without synchronized retry storms.

## Product Gate Checklist

Before adding or tightening a blocker, answer all of the following:

1. What irreversible or unsafe outcome does the gate prevent?
2. Which requirement class applies?
3. What exact positive evidence is required?
4. What exact negative evidence can dominate that positive evidence?
5. Is an apparent negative fact signed/explicit, or merely not observed?
6. What previously working user cohort becomes blocked?
7. What happens when reads are partial, unavailable, stale, conflicting, or
   complete-but-empty within the selected plan?
8. Can the safe part of the user task continue in degraded mode?
9. Which surface owns repair, and can the user understand it without knowing
   event kinds?
10. If compatibility is required, where are its scope, rollout control,
    diagnostics, rollback, measurement, owner, and removal gate documented?

Hard-block when a required security, privacy, authorization, identity, or
payment fact cannot be established; when required positive evidence is absent;
or when stronger known negative evidence invalidates the action. Do not
hard-block solely because optional discovery metadata is missing or some
sources did not respond when a safe, bounded path remains.

## Compatibility Exceptions

Compatibility is a migration tool, not a new implicit protocol.

Every exception must:

- name the canonical target behavior;
- record the observed ecosystem divergence and evidence date;
- describe the user harm caused by strict enforcement;
- preserve non-negotiable security, privacy, authorization, and payment
  invariants;
- define bounded read and write behavior separately;
- list prohibited sources and explicit fanout limits;
- use an auditable rollout control and rollback path;
- surface truthful degraded state;
- implement privacy-safe aggregate measurements before production activation;
- specify an owner, review date, and measurable removal gate;
- require an explicit maintainer change to widen, renew, or remove the lane.

Use `docs/knowledge/compatibility-exception-template.md`. Active exceptions
must be indexed from `docs/README.md`.

## Repair UX

- Put configuration in the surface that owns the setting.
- Let other surfaces explain state and link to repair; do not duplicate signing
  or configuration workflows across routes.
- Continue the critical user flow when a safe path exists and recommend
  cleanup without shaming or blocking the user.
- Distinguish unknown, degraded, stale, malformed, and absent-within-scope.
- Avoid requiring users to understand NIP numbers or event kinds to recover.
- Never claim delivery, absence, freshness, or compatibility beyond the
  evidence the client actually has.

Repair for discovery metadata is not complete merely because the owner can
read back its own event. The publish and verification plans must overlap the
bounded discovery plan that unrelated clients actually query, or the UI must
truthfully report that cross-client discoverability is still unknown.

Capability claims must name their evidence class. Distinguish configured,
advertised, probed, observed-working, and currently reachable. A secure `IN`
relay or a NIP-11 claim is useful evidence, not proof that it is a reliable
private inbox.

## Testing Standard

Relay-sensitive behavior needs counterexamples, not only a compliant happy
path. Test the user outcome under:

- complete empty results versus partial empty results;
- one source unavailable versus all sources unavailable;
- delayed events and delayed `EOSE`;
- stale cache plus current relay evidence;
- conflicting replaceable events on different relays;
- explicit rejection, authentication requirement, timeout, and lost or late
  acknowledgement;
- duplicate and out-of-order delivery;
- browser restart with pending signed work;
- an older client that never published newly expected metadata;
- producer and consumer clients with non-overlapping relay views.

Deterministic local fault scenarios belong in CI. Read-only public-network
probes may inform implementation reality, but public relays must not become a
required CI dependency.

## Current Applications And Known Gaps

### Product deletion and checkout

`docs/knowledge/product-deletion-convergence.md` preserves valid NIP-09
tombstones as monotonic evidence. Checkout requires exact positive live listing
evidence. Known tombstones block; a failed deletion lookup alone does not prove
a tombstone exists and does not become an outage veto.

### NIP-17 inbox migration

`docs/knowledge/nip17-inbox-bootstrap-migration.md` keeps kind `10050` as the
canonical route, moves repair to Network, permits broader safe reads, and names
a bounded order-only compatibility write lane. The exception does not redefine
NIP-17 and cannot silently widen to general DMs or arbitrary relays. Declaration
evidence is durable and account-scoped, preserves the exact signed event and
source observations, follows the NIP-01 replaceable-event frontier, and keeps a
last-usable read set separate from the current write-authorizing state. Empty,
partial, unavailable, and relay-settings-change observations can make evidence
stale or degraded but cannot erase it. Network repair uses bounded shared
discovery and exact-event readback so owner-only visibility is not mistaken for
cross-client discovery. The remaining production blocker is the unimplemented
privacy-safe measurement and removal gate documented by the migration note.

## Agent And Reviewer Preflight

For Nostr-sensitive changes:

1. Read this posture, the applicable repo contract, and the canonical public
   protocol source.
2. State the user outcome and requirement class before selecting strict or
   degraded behavior.
3. Preserve source, freshness, coverage, and stronger prior evidence through
   the shared protocol boundary.
4. Add counterexamples for incomplete and divergent network views.
5. Document any compatibility exception before enabling it.
6. Keep diagnostics and evidence public-safe and content-free.

## Engineering References

These sources inform the reliability posture; canonical Nostr behavior still
comes from the public NIPs and applicable commerce specifications.

- [RFC 4838: Delay-Tolerant Networking Architecture](https://www.rfc-editor.org/rfc/rfc4838.html)
- [RFC 9171: Bundle Protocol Version 7](https://www.rfc-editor.org/rfc/rfc9171.html)
- [RFC 1958: Architectural Principles of the Internet](https://www.rfc-editor.org/rfc/rfc1958.html)
- [RFC 7252: Constrained Application Protocol](https://www.rfc-editor.org/rfc/rfc7252.html)
- [GSMA IoT Device Connection Efficiency Guidelines](https://www.gsma.com/solutions-and-impact/technologies/internet-of-things/gsma_resources/iot-device-connection-efficiency-guidelines-version-3-0/)

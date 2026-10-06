# Signed-event publication

`packages/core/src/protocol/relay-publish.ts` owns publication policy and
per-relay delivery. Its APIs accept plain `SignedPublicNostrEvent` values.
`publishSignedEventPlan` executes an explicit target set through
`relay-writer.ts`; standard, progressive and exact durable writes share that
transport. No app writer uses NDK publication, relay sets or publish errors.

## Ownership and retry

Sign once in the existing account workflow. Retain the signed event and relay
plan in the domain checkpoint before delivery when the workflow requires
recovery. The transport snapshots the seven signed event fields and serializes
one NIP-01 `EVENT` frame. Retries preserve the event ID, signature, tags, content
and exact serialized frame; they never ask the signer for another event.
Optional foreground NIP-42 authentication signs a separate kind-22242 event.
A proactive challenge waits for the initial target-policy check to succeed.
Policy is checked again around signer waits and before transmitting the AUTH
proof, as well as before resending the original EVENT.

An exact plan cannot widen on retry. Standard planning captures any existing
configured fallback candidates before publication. Retries can remove targets
under live account policy; they cannot discover new targets mid-flight. Source
switches and whole-relay exclusions are rechecked before connecting and before
sending, including the resend after relay authentication. Private or insecure
owner-selected targets require matching active-account authority. Remote hints
cannot confer that authority. E2E isolation permits only the configured local
relay.

Read connections and NDK resets do not own write sockets. Every write socket
closes on a terminal outcome, deadline or account cancellation. Account
cancellation after sending cannot retract an event already received by a relay.
Saved signed retries use provider-owned account identity updated synchronously,
including revocation before disconnect cleanup. They do not depend on delayed
relay-settings effects, panel mounting or fresh signer readiness.

## Delivery evidence

A result separates the fixed plan, admitted targets, attempted targets and
per-relay outcomes. Outcomes retain the event ID and attempt number:

- `acked`: positive NIP-01 `OK` for this event, or its idempotent `duplicate:` response.
- `rejected`: stable machine-readable rejection of this event.
- `timed_out`: no usable acknowledgement, including interrupted transport or an unclassified response.
- `auth_required`: relay authorization is required and unavailable for the write.
- `cancelled`: the operation or active account was cancelled.
- `policy_blocked`: live target policy prevents delivery.
- `error`: a local policy read or executor failed before a usable relay outcome.

Local errors, cancellation, policy exclusions and signer/authentication failures
do not penalize relay health. Only transport timeouts and relay event rejections
increment its failure counter. Local policy reads still fail closed: an error
cannot authorize an EVENT or AUTH frame. Exact writes and durable checkpoints
retain local `error` evidence rather than substituting a relay timeout.
Best-effort broadcast policy errors cannot revoke a primary acknowledgement.
They retain unattempted broadcast targets as local error evidence without
opening sockets or authorizing sends.

Rejection of a separate NIP-42 AUTH event is authorization failure, not rejection
of the original signed event.

Earlier acknowledgements remain positive delivery evidence across retries.
Attempt history preserves other earlier outcomes; absence of an ACK never
proves absence from a relay. Diagnostics contain statuses and relay URLs, never
relay response text, event content or event/identity identifiers. The diagnostic
error boundary removes event IDs from attempts; local domain delivery records
retain their signed-event identity separately.

Order checkpoints project typed attempt outcomes rather than legacy URL buckets.
Planned targets blocked before socket I/O are recorded as `policy_blocked`, and
those targets are excluded from exact saved-order retries. Authentication and
cancellation outcomes remain distinct from transport timeouts.

Progressive recipient publication exposes separate `accepted` and `settled`
transport promises: the first relay ACK and the complete bounded relay result.
Neither means merchant confirmation, order acceptance, payment settlement or
completion of a domain workflow. Standard publication retains its existing
wait-for-fanout behavior.

## Preserved boundaries

The existing workflows still own replaceable frontiers, shipping before product
publication, product deletion provenance, Network recovery, and durable message
checkpoints. This transport change does not introduce another publication
journal or redesign those workflows. NDK adapters used by existing readers and
NIP-17 envelope construction remain separate boundaries. Developer/operator
scripts and the NIP-46 remote-signer control protocol are separate from app
event publication.

Public references: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md),
[NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md),
[NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md),
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md), and the
[Open Markets working specification](https://github.com/OpenMarketsFoundation/specification).
Public NIP-44 remains v2. Future v3 messaging capability work requires public
references and explicit capability detection; this change does not alter
encryption or envelope construction.

Current Event Market roster, authorization and calendar publications pass plain
signed events to the shared writer. Saved enrollment and private-handoff retries
also pass their retained signed wraps directly. NDK adapters remain only where
the existing envelope construction and authenticated unwrapping require them.
The retired collection-based Event Market publishers and panels stay removed;
publication does not restore their former recovery or fulfillment model.

Shipping-policy creation and withdrawal use plain unsigned drafts and validated
signer results. Their current-revision checks and signed-evidence retention remain
owned by the shipping workflow.

## Occurrence-scoped inventory and acceptance

This implementation uses the experimental Open Markets PR #15 revision
`8aa6d83331c750be22bf01413a1f932778e64568`. It is not a normative standard.

Three durable records own inventory: Product (remaining total stock), Assignment
(remaining occurrence allocation and methods), and Accepted order (order-ID
identity, accepted terms/evidence and resulting quantities). Pending drafts and
signed publication bytes remain attached to these records in the existing Dexie
database, outside commerce cache pruning/reset.

One local transaction commits every item debit and the accepted decision.
Pickup consumes total stock and its occurrence allocation once; ordinary
acceptance respects all effective reservations. Unpaid acceptance already holds
units. Signing interruptions, retries, reload and relay failures finish the
recorded decision. No relay ACK, self-copy or convergence gate blocks the next
acceptance. Independent devices have no global atomicity guarantee.

A merchant signs one 30410 tuple per existing sellable product, market and
concrete occurrence. Its d is SHA-256 of compact UTF-8 JSON
[market, occurrence, product]. Product market tags remain discovery hints only.
Assignment operations do not rewrite ordinary shipping or product content.
New purchase evidence retains the exact signed assignment in encrypted kind-16
orders. Historical orders retain their original terms.

The integrated writer is merchant-owned pickup. New-profile pseudonymous
purchasing has no product opt-in; shipping contact remains separate. Approved
organizer authority permits entrusted-goods acceptance, settlement verification
and handout without a live merchant. Its exact advance delegation, writer
handover and order-ID reconciliation contract remains an integration dependency;
this slice does not invent that wire format or alter the payment executor.

After allocation, actual start/end changes or a different pickup venue require
an explicit replacement occurrence, merchant notice and confirmation of
remaining allocations. Typo, directions and booth changes remain ordinary.
Ended/cancelled coordinates stay ended, and accepted commitments require
appropriate buyer communication. The full Reschedule/Relocate workflow remains
unfinished, as do rollover, shipping/digital assignment UI, complete unavailable-device
order recovery and independent-writer repair. Bounded first-use signed assignment
reads restore observed reservations across markets; their coverage does not prove
global absence, and intact local inventory bypasses those reads. Core arithmetic tests alone do not prove
those composed flows. External signer/relay/device, funded payment and physical
handout evidence remain separate maintainer validation.

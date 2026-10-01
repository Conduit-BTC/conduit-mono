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

## Delivery evidence

A result separates the fixed plan, admitted targets, attempted targets and
per-relay outcomes. Outcomes retain the event ID and attempt number:

- `acked`: positive NIP-01 `OK` for this event, or its idempotent `duplicate:` response.
- `rejected`: stable machine-readable rejection of this event.
- `timed_out`: no usable acknowledgement, including interrupted transport or an unclassified response.
- `auth_required`: relay authorization is required and unavailable for the write.
- `cancelled`: the operation or active account was cancelled.
- `policy_blocked`: live target policy prevents delivery.
- `error`: the executor failed before a usable relay outcome.

Earlier acknowledgements remain positive delivery evidence across retries.
Attempt history preserves other earlier outcomes; absence of an ACK never
proves absence from a relay. Diagnostics contain statuses and relay URLs, never
relay response text or event content.

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

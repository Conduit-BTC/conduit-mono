# Product Deletion Convergence

Conduit treats product deletion as durable, signed Nostr evidence rather than as
a transient relay response. This note documents the implementation boundary
shared by Merchant product management, storefront reads, Market catalog reads,
product detail and batch reads, progressive reads, and the local cache.

The canonical protocol source is
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md). Product
coordinates use the parameterized replaceable event rules from
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), and author
relay discovery follows
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md).

## Evidence and Resolution

Only a cryptographically valid, signed kind `5` event becomes deletion
evidence. Both locally signed events and deletion events observed from relays
are submitted to durable storage before resolution. If storage is temporarily
unavailable, validated remote evidence remains in a monotonic in-memory
frontier for the session, continues suppressing stale products, and is retried
on later reads.

The shared resolver applies these rules:

- An `e` tag deletes the exact referenced event when the deletion author is also
  the referenced product author. The deletion event's timestamp is not a
  freshness gate for an exact reference.
- An `a` tag must contain the full `30402:<author-pubkey>:<d-tag>` coordinate.
  It applies only when the coordinate author matches the deletion author.
- An address deletion suppresses product versions whose `created_at` is less
  than or equal to the deletion event's `created_at`. A genuinely newer version
  remains visible.
- Equal `d` tags from different authors are independent products and cannot
  delete one another.
- A legacy product with missing or malformed address metadata may still be
  deleted through a valid exact event ID. The client does not invent a
  coordinate, broaden a malformed target, or publish a deletion with no valid
  product target.

Persisted tombstones are monotonic evidence. A relay returning no matching
event does not prove that an earlier observed tombstone disappeared. Removing
or weakening validated evidence requires stronger protocol evidence, not relay
omission.

The post-commit local notification carries the transaction's selected evidence,
including an existing winner when an older incoming deletion needs no write.
The asynchronous storage observer is not the only path for adopting evidence
already discovered by a transaction. Persistence tests exercise this production
branch so their notification behavior cannot be stronger than runtime behavior.

## Read-Surface Contract

All product read surfaces resolve candidate product records through the same
core deletion boundary. A stale cache entry cannot bypass a tombstone merely
because a live relay returned the product again.

Progressive reads publish resolved snapshots, not append-only product deltas.
This matters in both arrival orders:

1. A known tombstone suppresses a product that arrives later.
2. A tombstone that arrives after a product retracts that product from the next
   snapshot.

The accumulated candidate set remains available while relay responses arrive,
so an individual relay's omission is not interpreted as removal of either a
product observation or deletion evidence.

### Retained exact family eligibility

An exact read may return only a requested variation even though its eligibility
was established using a parent and other family members. The retained result
keeps those signed revision inputs and the original merchant-hidden allowance
in an in-memory `exactReadContext`, separate from the returned product set.
Context does not make a parent or sibling organizer-accepted, and it is not
persisted as a new signed listing or checkout authorization.

Local deletion reconciliation removes contradicted revisions from that context
and runs the same exact eligibility selector used by fresh reads. This covers
both parent deletion and removal of a sibling supplying required family image
context. Affected family targets share one reevaluation; unaffected records and
network freshness are preserved. Late snapshots pass through the same deletion
frontier. A subsequent successful read of a valid newer revision can restore
eligibility without weakening the retained deletion evidence.

Regression coverage must compose the real exact reader, retained query, local
signed deletion and catalog action projection. Separate tests of grouped
families and mocked standalone children do not establish this lifecycle.

## Delivery and Durable Retry

Merchant persists the exact signed kind `5` event and its immutable relay plan
before attempting delivery. The target plan is a deterministic union of:

- the merchant's current write relays, including NIP-65 discovery;
- all validated source relays previously observed for the product; and
- the canonical Conduit commerce relay.

Source observations are coordinate-level provenance: observing a newer version
on one relay does not discard relays that previously served an older version of
the same product coordinate.

Delivery records per-relay acknowledgement, rejection, timeout, and retry
state. Pending and partially delivered jobs survive route changes, page
reloads, and browser restarts. A retry republishes the same signed event bytes;
it does not silently create a second semantic deletion. An explicit rejection,
even from every planned relay, remains an unacknowledged target in the durable
exact-byte retry lane. Merchant reports a deletion as partial/retryable until
every planned target ACKs. Repairing relay settings may allow the same signed
deletion to reach a previously rejecting target; it does not require or offer
a second signature with a broader `created_at` cutoff.

For a mixed replacement and deletion, both exact signed jobs must be durable
before either is sent. The deletion remains queued without relay attempts until
one relay has acknowledged every event in the replacement listing family.
Explicit retry and background recovery apply the same gate after reload. A
timeout or rejection on another relay cannot substitute for that common ACK;
once it arrives, the original signed deletion can be retried without another
signer request, including when every planned relay explicitly rejects it.
If the replacement family has no relay that acknowledged every signed listing
and every event/relay pair has a final ACK or explicit rejection, the untouched
companion deletion cannot be delivered independently. This includes crossed
ACKs where individual listings reached different relays but the family never
reached one common relay. After reload, Merchant compares that terminal signed
family with the current same-author local revision and offers a deliberate
paired start-over. Both intents are newly signed and staged together; the
replacement deletion retains the original NIP-09 `created_at` cutoff and
targets, and remains gated on a common ACK for the new listing family. Neither
old listing bytes nor the old queued deletion are retried as the new operation.
Once a replacement family does have a common ACK, a rejected companion kind
`5` deletion follows the ordinary exact-byte retry lane rather than the
listing family's terminal-rejection policy. Standalone deletions retain that
same independent exact-byte delivery path.

Workers use a durable expiring claim to avoid duplicate cross-tab delivery.
Acknowledgements are monotonic, so a late timeout or rejection from a stale
worker cannot overwrite an ACK. Only a NIP-01 machine-readable `OK false`
reason is recorded as a rejection; ambiguous transport failures remain
retryable timeout state.

The canonical relay is a required convergence target, not an exclusive source
of truth. Partial delivery remains visible and retryable until every planned
target has acknowledged the persisted event.

## Privacy and Diagnostics

Deletion diagnostics describe bounded operational state only, such as target
counts and acknowledgement outcome classes. Telemetry and logs must not include
event content, product or merchant identifiers, pubkeys, addresses, messages,
invoices, signer details, or other user content.

## Regression Expectations

The deletion regression matrix covers:

- exact event deletion for older listings and clock-skewed timestamps;
- author isolation for equal `d` tags;
- address cutoffs and newer replacements;
- durable remote tombstones after relay omission;
- tombstone-before-product and product-before-tombstone ordering;
- agreement between cache, catalog, storefront, detail, batch, and progressive
  reads; and
- durable delivery of the same signed event after partial or all-rejected
  failure and browser restart, without reporting full deletion delivery until
  every planned relay ACKs, including the v8-to-v9 cache migration.

These are convergence properties. Adding a new product read surface requires
routing it through the shared resolver and extending the agreement matrix.

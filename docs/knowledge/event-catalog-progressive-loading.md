# Progressive event catalog loading

Market event browsing uses one scoped, rate-independent catalog query. Product
pickup consumers observe the same query when collection, relay hints, relay
scope, principal and authentication generation match. Price conversion is a
local projection of signed source terms and does not restart relay reads.

## Display and authorization

The shared event reader emits cumulative verified organizer snapshots as relays
finish. Local event evidence can render before relay planning completes. Safe
cached product details load through a bounded author-scoped pipeline. Cached
snapshots support browsing only: cached requests never grant current merchant
participation or pickup authorization. Each progress header starts without
product records; only its own deletion-aware cache batch or a current network
product snapshot can restore cards. A missing or failed cache batch must not
borrow records from an earlier progress or query result.

For cold detail loads, the organizer product coordinates start both hydration
and exact participation-frontier reads while broad collection-tag discovery and
pickup verification continue. Later-discovered pending requests join the final
resolution without rereading organizer-listed coordinates. Browse snapshots may
paint as transport batches arrive. An author becomes action-authoritative only
after that author's product, variation family, deletion frontier and current
cache reconciliation settle. Settled callbacks reconcile only the newly
completed author and compose already-reconciled author results; one final
aggregate reconciliation preserves cross-author ordering. A newer signed
listing revision or tombstone advances that author's local authority generation;
before the next cumulative callback, only changed settled authors are
reconciled again. The matching event-market author frontier and the selected
organizer or merchant pickup must also be current. That completed subset can
enable Add while an unrelated merchant remains in progress; retained sibling
cards stay visible but browse-only. Normal settled artifacts are reused by the
final aggregate result. If final event acceptance advances beyond an
already-settled missing, older or cache-only product snapshot, the loader waits
for both broad reads to settle and performs one exact recovery for the complete
accepted set of each affected author. This preserves that author's family and
deletion context without rereading healthy authors elsewhere in the event or
merging overlapping recovery progress. The broad read and final recovery share
one two-author coordinator. Pickup results are also reused without duplicate
reads. Existing target limits and relay budgets remain in force.

The final read still resolves collection/calendar revisions, exact product and
pickup frontiers, known withdrawals and same-author deletions. Independent
product and organizer pickup checks overlap without reducing read budgets.
Completed merchant pickup pipelines run concurrently within the shared bound;
one slow merchant does not serialize another merchant behind its timeout.
Product and deletion frontier filters share one four-query coordinator across
all active author pipelines. A product-stage relay failure retires that relay
only from later product reads, while a deletion-stage failure retires it only
from later deletion reads; skipped reads retain partial coverage and therefore
remain fail-closed.

While a query refreshes, fails or pauses, its display projection removes pickup
authorization from retained completed data. Previously rendered content remains
useful, but old readiness is not reused. During an active invocation, only the
exact coordinates completed by that same invocation may regain readiness while
the wider read continues. Cancellation, remount and retry synchronously clear
that incomplete grant before replacement I/O starts. A failed or paused refresh
marks retained active or partial evidence stale and exposes retry; terminal
protocol states stay intact. Window focus does not automatically restart this
expensive catalog read. Explicit user refresh and checkout's separate live
freshness read remain available. Query keys and cancellation prevent old account
or relay-scope requests from updating the current view.

Product surfaces also compare source terms with the shared catalog. A newer
revision, differing terms at the same timestamp, or a newly observed product
missing from the catalog requests one scoped reconciliation and cannot reuse
older pickup readiness. Display-only currency conversion does not count as a
source change.

Variable families retain safe display choices independently of their exact
child pickup snapshots. Parent acceptance does not authorize a child. Newer
signed withdrawals and deletions must dominate both the event evidence cache
and the general product cache, including intermediate previews.

## Checkout is independent of catalog browsing

Checkout displays the selected cart pickup snapshot and uses the normal
merchant-scoped product availability checks while the buyer enters details.
It does not subscribe to the event browse query or wait for catalog-wide
participation, other merchants' pickups, or organizer inbox discovery before
the buyer can review the order.

At submission, `resolveCheckoutProductFulfillments` shares one event read per
collection across the selected products. `getEventMarket` accepts
`selectedProductCoordinates` to read their exact participation and pickup
references without discovering the rest of the catalog. Product hydration is
limited to those accepted coordinates. The full catalog remains the default
for browsing; a scoped result must not populate the shared browse query.

This moves validation to the action that needs it. Current signed collection
and calendar evidence, selected product and pickup revisions, price/stock,
known withdrawals/deletions and reviewed snapshot parity still authorize the
order or invoice request. Organizer handoff checks the organizer inbox at
submission. Merchant-booth handoff does not need that inbox. Payment retries
also restrict event reads to the selected product. Fulfillment readiness and
pickup receipts remain part of the later merchant workflow.

## Timeline discovery and relay lifecycle

The Events timeline reads retained signed organizer headers alongside its bounded
candidate scan, then streams each organizer's header before pickup checks finish.
A cumulative organizer snapshot replaces earlier evidence, including terminal
removals. A newer candidate unlink or signed deletion must retract an older card;
late cache reads cannot restore it. Cancelled account, perspective or relay scopes
cannot update the current timeline. A timeout preserves the latest safe browsing
snapshot and remains an incomplete read.

Deliberate local connection teardown cancels pending subscriptions without
recording relay failure. Remote disconnects and timeouts still contribute to
relay health. This distinction prevents account or network-setting transitions
from cooling down healthy relays merely because several reads were interrupted.
Candidate limits, relay scope and discovery deadlines remain unchanged.

## Validation

Measure header visibility, product visibility and purchase readiness separately.
Use gated synthetic relay responses to prove that display does not wait for
product/pickup completion. Test warm navigation separately from a full reload,
which also includes app/account startup.

Coverage includes shared reads and local repricing, failed refreshes, scope
changes, cancellation/remount, cache-only browsing, hidden event products,
variable choices, cross-cache withdrawals/deletions, bounded author and filter
concurrency, stage-local relay retirement, and one final affected-author
accepted-revision recovery. A core regression holds broad collection-tag
discovery and proves an organizer-listed merchant can still become actionable.
Browser checks exercise a cold merchant-booth product becoming Add-enabled while
a sibling merchant read is held. They also cover header progress, warm
product-to-event navigation, retained cards, variation selection and deletion
after a cached preview. Timeline checks cover delayed sibling reads, cache
progress, deadline retention, signed removal and local connection teardown
followed by successful discovery retry.

Public network latency is not a CI dependency. Synthetic signer/relay results
do not replace maintainer preview validation with the relevant real accounts
and relays. No new cache schema, deployment setting or migration is required.

Sources: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md),
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md), and the
[Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md).

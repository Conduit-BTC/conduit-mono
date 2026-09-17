# Progressive event catalog loading

Market event browsing uses one scoped, rate-independent catalog query. Product
pickup consumers observe the same query when collection, relay hints, relay
scope, principal and authentication generation match. Price conversion is a
local projection of signed source terms and does not restart relay reads.

## Display and authorization

The shared event reader emits cumulative verified organizer snapshots as relays
finish. Local event evidence can render before relay planning completes. Safe
cached product details load through the shared exact product reader. These
snapshots support browsing only: cached requests never grant current merchant participation or
pickup authorization. Each new target read starts without product records;
only a reconciled snapshot from that reader can restore cards. Later event
progress for the same targets keeps those safe previews, including a final
stale graph with unavailable live participation evidence. A changed target set
or terminal graph clears them. The adapter does not start a duplicate cache
read or borrow records from an earlier query or obsolete product read.

For cold detail loads, the organizer product coordinates start an exact product
read while participation and pickup verification continue. Completed merchant
batches emit cumulative snapshots without waiting for slower merchants. Each
merchant read keeps its family checks together. The shared `getProductsByIds`
reader owns the author queue, cumulative snapshots and exact diagnostics. At
most two complete author pipelines run concurrently. The Market adapter calls
that reader directly, without a second app scheduler or cache-seeding pass.
Initial cached products and relay-list preparation are shared across the read.
Safe cached cards and child-only families for queued merchants remain visible
with cache-only diagnostics. Uncached coordinates awaiting a read carry a
`pending` diagnostic, including mixed cached and uncached targets for one author.
Once event verification finishes, each completed exact product can become
actionable while other merchants continue loading. These snapshots reconcile
current signed revisions and
local deletions before display; final reconciliation must not restore older
terms. The overlapping read is reused at completion. If final accepted evidence
identifies a missing or newer product, one exact read reconciles it. Coordinate
changes cancel obsolete progress, and the existing target limits, author
concurrency and relay budgets remain in force.

The final read still resolves collection/calendar revisions, exact product and
pickup frontiers, known withdrawals and same-author deletions. Independent
product and organizer pickup checks overlap without reducing read budgets.
Deletion checks remain isolated by product target so busy siblings cannot
consume another product's response. A relay may return fewer events than the
requested limit; result counts do not prove complete deletion coverage. The
existing exact-target reads and bounded concurrency remain unchanged.

Completed catalog reads are reused for 60 seconds across matching mounts and
return visits. The in-memory query retains browsing evidence for 30 minutes;
full reloads still hydrate signed browser-cache records and verify them live.
Regaining browser focus does not restart a successfully completed catalog read
with usable relay coverage. Incomplete, failed, or all-relay-unavailable reads
remain stale and use focus as a recovery signal, including refresh failures
that retain an older completed snapshot. Users can
refresh explicitly, while a stale remount still follows the normal query
refresh path.
Retained event queries also observe the shared local product-deletion frontier.
A signed deletion retracts affected cards, family choices and pickup actions on
mounted pages and warm returns, without a relay read or extending network
freshness. The observer stays active while catalog queries remain cached.
Initial local reconciliation briefly withholds pickup authority, and late
progress/final snapshots are reconciled against the same monotonic evidence.
Storage failures preserve already observed deletion evidence. Other same-origin
contexts are observed through Dexie; in-process validated evidence is announced
before persistence can fail. Unaffected products keep their live read evidence.

Retained queries also watch the selected local signed product revisions for
all their product and family dependencies. Scoped primary-key observation keeps
new stock, prices, withdrawals and topology changes ahead of older catalog
snapshots. The selected transaction winner is retained even when an incoming
row loses or persistence fails. Changed records pass through the same exact
family selector; their old live diagnostic cannot authorize the new revision.
A fresh exact read restores authority. Until then safe details remain visible
with pickup unavailable, rather than an ongoing network-check indicator.

Collection, calendar, pickup and participant evidence lives in a separate
organizer-scoped store. Retained catalog queries observe that store as well.
Stronger signed collection/calendar revisions revoke the old graph; stronger
pickup or participant evidence revokes only the affected product authority.
Local evidence never grants new graph authority, and relay omission cannot
restore superseded evidence. Initial local reads settle through the existing
subscriptions, without duplicate reads. Each query retains its dependency IDs
after a card is removed, releasing them when that query leaves the cache.
These updates do not renew network freshness or initiate full catalog rechecks.

Incomplete reads remain stale. A new read clears any verification marker left
by interrupted progress before accepting fresh progress.

While a query refreshes, its display projection removes prior pickup
authorization. Current-read progress can restore individual pickup actions only
after the event graph and that product have been verified. Failed or paused
refreshes remove pickup authorization. Previously rendered content remains useful, but old readiness
is not reused. A failed or paused refresh marks retained active or partial
evidence stale and exposes retry; terminal protocol states stay intact. This
changes the display projection, not the shared raw evidence. Explicit checkout
freshness verification remains a separate
live read. Query keys and cancellation prevent old account or relay-scope
requests from updating the current view.

Product surfaces also compare source terms with the shared catalog. A newer
revision, differing terms at the same timestamp, or a newly observed product
missing from the catalog requests one scoped reconciliation and cannot reuse
older pickup readiness. Display-only currency conversion does not count as a
source change.

Variable families retain safe display choices independently of their exact
child pickup snapshots. Parent acceptance does not authorize a child. Newer
signed withdrawals and deletions must dominate both the event evidence cache
and the general product cache, including intermediate previews.

## Shared exact product progress

An author becomes complete only after its direct listing reads, family
reconciliation and exact deletion checks finish. Its final diagnostics can then
support pickup actions while another author is still pending. Provisional direct
results remain non-authorizing. A completed author frees a queue slot immediately.
Cache preparation is ordered within each author pipeline. An author awaiting
its cache operation does not put other authors behind a shared promise queue.
Read results merge synchronously into the current invocation evidence after
each await, preserving newer revisions and deletions learned in the meantime.
This removes application-level serialization; a database-wide stall can still
affect multiple independent operations.
The shared reader retains alias diagnostics and compatible relay-hint plans.
Calls without a progress observer retain cross-author bulk family batching.
Both modes use the same prepared read pipeline; progressive callers schedule
that pipeline per author so an unrelated family cannot delay completion.

Exact cache hydration uses primary-key lookups for requested coordinates and
adds same-author parent/sibling context when a variation family needs it. Rows
are selected before normalization, so unrelated merchant inventory does not
repeat through every progress snapshot. Known family child IDs remain in later
lookups even if a child changes parent or becomes a simple listing. Newly
observed live family references contribute context when persistence fails.

Later publication still checks current cached revisions and monotonic deletions;
a newer withdrawal or deletion must retract an earlier completed snapshot.
Shared initial preparation removes duplicate setup, but does not remove those
freshness checks. Cancellation stops queued authors and late publication.

The two-author limit applies to author pipelines, whose existing transport
helpers retain their own bounded fanout. It is not a global app connection limit.
Batched relay-list preparation and current event-graph verification remain
prerequisites; this change does not guarantee public-relay response times.

The event graph's verified simple-product preview can keep a pending card visible
while its exact product read continues. It is display-only, with no pickup or
purchase authority. These preview records enter the existing local revision and
deletion reconciliation before projection; projection never reconstructs a removed
preview from older graph evidence. Completed, excluded, unsafe, malformed-price
and unsupported family previews do not gain this pending-card fallback. This
reuses evidence already read and adds no relay or cache read. Source safety comes
from the canonical full product parser, preserving signed tags and legacy-content
checks even when the display projection omits those fields.

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
changes, cancellation, cache-only browsing, hidden event products, variable
choices, cross-cache withdrawals/deletions and a later live re-request. Browser
checks exercise cold product progress with empty caches and a held sibling
merchant, a completed graph with a fast merchant Add-enabled while a sibling
exact product read remains held, header progress, warm product-to-event
navigation, retained cards, variation selection and deletion after a cached preview. Timeline checks
cover delayed sibling reads, cache progress, deadline retention, signed removal
and local connection teardown followed by successful discovery retry. Signed
revision regressions cover mounted and warm withdrawal, stock, price, topology,
separate event evidence, delayed snapshots, and fresh restoration. Real
same-origin cross-tab browser coverage persists signed withdrawals through the
core writer and verifies that unrelated cards remain actionable with zero
catalog relay rechecks.

Public network latency is not a CI dependency. Synthetic signer/relay results
do not replace maintainer preview validation with the relevant real accounts
and relays. No new cache schema, deployment setting or migration is required.

Sources: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md),
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md), and the
[Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md).

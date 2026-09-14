# Progressive event catalog loading

Market event browsing uses one scoped, rate-independent catalog query. Product
pickup consumers observe the same query when collection, relay hints, relay
scope, principal and authentication generation match. Price conversion is a
local projection of signed source terms and does not restart relay reads.

## Display and authorization

The shared event reader emits cumulative verified organizer snapshots as relays
finish. Local event evidence can render before relay planning completes. Safe
cached product details load in one author-scoped batch. These snapshots support
browsing only: cached requests never grant current merchant participation or
pickup authorization. Each progress header starts without product records;
only its own deletion-aware cache batch or a current network product snapshot
can restore cards. A missing or failed cache batch must not borrow records from
an earlier progress or query result.

For cold detail loads, the organizer product coordinates start an exact product
read while participation and pickup verification continue. Completed merchant
batches emit cumulative snapshots without waiting for slower merchants. Each
merchant read keeps its family checks together. Safe cached cards for queued
merchants remain visible with cache-only diagnostics. Once event verification
finishes, each completed exact product can become actionable while other
merchants continue loading. These snapshots reconcile current signed revisions and
local deletions before display; final reconciliation must not restore older
terms. The overlapping read is reused at completion. If final accepted evidence
identifies a missing or newer product, one exact read reconciles it. Coordinate
changes cancel obsolete progress, and the existing target limits, author
concurrency and relay budgets remain in force.

The final read still resolves collection/calendar revisions, exact product and
pickup frontiers, known withdrawals and same-author deletions. Independent
product and organizer pickup checks overlap without reducing read budgets.
Deletion filters batch up to 32 targets of the same author and tag type. A
response reaching its result limit is refined to individual target reads, so
a busy sibling cannot hide an older deletion.

Completed catalog reads are reused for 60 seconds across matching mounts and
return visits. The in-memory query retains browsing evidence for 30 minutes;
full reloads still hydrate signed browser-cache records and verify them live.
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
merchant, header progress, warm product-to-event navigation, retained
cards, variation selection and deletion after a cached preview. Timeline checks
cover delayed sibling reads, cache progress, deadline retention, signed removal
and local connection teardown followed by successful discovery retry.

Public network latency is not a CI dependency. Synthetic signer/relay results
do not replace maintainer preview validation with the relevant real accounts
and relays. No new cache schema, deployment setting or migration is required.

Sources: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md),
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md), and the
[Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md).

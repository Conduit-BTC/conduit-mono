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
pickup authorization.

The final read still resolves collection/calendar revisions, exact product and
pickup frontiers, known withdrawals and same-author deletions. Independent
product and organizer pickup checks overlap without reducing read budgets.

While a query refreshes, fails or pauses, its display projection removes pickup
authorization. Previously rendered content remains useful, but old readiness
is not reused. Explicit checkout freshness verification remains a separate
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

## Validation

Measure header visibility, product visibility and purchase readiness separately.
Use gated synthetic relay responses to prove that display does not wait for
product/pickup completion. Test warm navigation separately from a full reload,
which also includes app/account startup.

Coverage includes shared reads and local repricing, failed refreshes, scope
changes, cancellation, cache-only browsing, hidden event products, variable
choices, cross-cache withdrawals/deletions and a later live re-request. Browser
checks exercise header progress, warm product-to-event navigation, retained
cards, variation selection and deletion after a cached preview.

Public network latency is not a CI dependency. Synthetic signer/relay results
do not replace maintainer preview validation with the relevant real accounts
and relays. No new cache schema, deployment setting or migration is required.

Sources: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md),
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md), and the
[Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md).

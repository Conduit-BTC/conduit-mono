# Market Product Search Ranking

Product queries of at least two characters use one NIP-50 request to the first configured product
search-index relay: `{ kinds: [30402], search: term, limit: 100 }`. No authors,
category tags, or custom ranking extensions are sent. The client filters the
returned list against the resolved catalog whitelist and selected merchants or
categories. Guest, Following, Conduit, and combined perspectives retain their
existing display boundaries.

The reader preserves that relay's response order through signature verification.
Ordinary relay reads retain their timestamp ordering. Search hits are discovery
evidence. Verified hits merge with newer cached revisions and known deletions
before the first snapshot. The existing exact-product reader then refreshes
revisions, deletions, and family context in the background. Shared family
preparation checks listing visibility and safety before each snapshot.
Families take the rank of their first eligible surviving coordinate. Only ranked
coordinates and required family context enter the search response. Catalog or
local text matches are never blended into a successful ranked response.
While live search is loading or unavailable, existing catalog text matches may
appear separately as **Cached matches**. They switch to **Best match** once a
ranked response arrives, including an empty response.

Market filters survivors without reordering them and shows **Best match**.
Freshness, merchant diversity, shipping preferences, and price sort apply again
when the query clears. Existing sort URL parameters remain usable for browsing.
Category and profile suggestions retain their separate lookup paths.

Cancellation closes the search subscription and prevents obsolete background
reads from publishing into a newer query or account scope. An
unavailable refresh rejects so the query cache can retain the ranked response
for the exact query, account, perspective, and author scope. Merchant and category
selection filters this response locally, without another search request.
Completed empty, partial empty, capped, and unavailable reads remain distinct.
No full catalog sweep is required to prepare a ranked response. Search Refresh
updates discovery, cached evidence, and ranked results without starting a broad
catalog read. Clearing the query restores catalog refresh. Partial or capped
empty results offer Retry instead of claiming that no matching products exist.

## Request Suppression and Throttle Recovery

Header search waits 350 ms after typing stops. One-character queries use cached
text matches and show guidance to enter another character. Header suggestions
reuse the cached catalog and observe later page cache commits. When a route
does not supply a catalog, an eligible settled query can run one bounded
discovery pass. This includes cold product search links, empty carts, and carts
whose related-product read covers only the selected merchant or purchase.
Retained fallback records reconcile with locally observed signed deletions before
building header categories and sellers. A deletion retracts its product without
opening another product read.
Product and profile search disable automatic retry, focus refetch, and reconnect
refetch. Explicit Refresh and Retry update eligible remote queries. One-character
queries can retry author discovery and cached evidence without a product network
request.

Cancellation reaches queued and active catalog, discovery, and exact-product
reads. Obsolete reads cannot continue background hydration or publish snapshots.

The shared reader recognizes NIP-01 `rate-limited:` rejections and the
`rate limited:` prefix used by Congee. A throttling `NOTICE` ends active reads
on that connection. A throttling `CLOSED` ends the named subscription.
Both responses pause new reads to that relay for 60 seconds, including explicit
relay plans. A successful sibling read cannot clear this pause. NIP-01 provides
no retry delay, so this interval is a client recovery policy.
A queued request suppressed during this pause does not consume a bounded
fanout slot. A later healthy relay can fill that slot; throttle diagnostics remain visible.

Detailed read results expose only `failureReason: "rate_limited"`, without the
relay message. Verified events received before throttling remain partial results;
zero events remain a failed read. Neither establishes that a listing is absent.

## Bounded Search Coverage

Filtering happens after Congee's result limit. Matching whitelist or category
products below that limit may be omitted. Scoped and capped responses therefore
remain explicitly incomplete; an empty filtered response is not proof that no
matching listing exists. EOSE establishes completion of this request, not
corpus completeness, synchronization freshness, or semantic ranking quality.

Protocol references: [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md),
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md), and the
[Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md).

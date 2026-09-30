# Market Product Search Ranking

Nonempty product queries use one NIP-50 request to the first configured product
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
for the exact query, account, perspective, author scope, and category constraints.
Completed empty, partial empty, capped, and unavailable reads remain distinct.
No full catalog sweep is required to prepare a ranked response. Search Refresh
updates discovery, cached evidence, and ranked results without starting a broad
catalog read. Clearing the query restores catalog refresh. Partial or capped
empty results offer Retry instead of claiming that no matching products exist.

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

# Category-led product browsing

The products page defaults to **Discover**. It reads a bounded selection across
merchants, displays 24 cards, and prepares at least one next display page. It
never applies a publication-date cutoff. **Recently updated** uses signed listing
publication/revision activity from the last 30 days, with an explicit option to
include older listings. A revision is not evidence that a product was newly
created. **Explore all products** deliberately starts wider browsing.

## Scope and metadata

A category, merchant, or text query owns its product reads independently of the
homepage selection. Explicit facets remove the home feed and recency policy.
Filters combine as merchant AND category AND text; multiple merchants and
multiple categories each use OR semantics. Text search defaults to relay
relevance. Price sorting is available for explicit scopes and sorts the loaded
results using shared comparable prices and family minimum prices. It does not
claim a globally cheapest listing across unobserved pages or currencies.

Selector metadata uses the entire resolved eligible author set and cursor reads
of cached catalog metadata. It does not construct a full display catalog or
start a parallel product sweep. Merchant identity/name search retains that full
scope, including merchants absent from Discover. Identity projection and picker labels
are prepared only for exposed rows; keeping the full author set does not
eagerly format every identity while the picker is closed. Counts are labeled as cached;
unknown catalogs do not show a zero-product claim. Known cached categories stay
available across feed/filter changes. Common entry points and an arbitrary
category field also work before metadata is available. Metadata is a navigation
hint, never listing eligibility or checkout authority.

## Read budgets and coverage

Initial budgets are deliberately tunable after measurements:

- Discover: twelve merchants per batch, at most two batches; eight raw
  candidates per merchant, at most four display products per merchant, and
  48–96 display products per read page, interleaved across merchants.
  Dense catalogs start with 48 display candidates, enough for the first 24
  cards and one prepared page.
  Two authors run concurrently, with at most two relay attempts per listing read.
  Signed deletion checks are batched once per page through the existing shared
  revocation reader, avoiding per-merchant relay-list and deletion requests.
- Explicit category/recent/all browsing: one filter across the full eligible
  author set, initially 96 candidates per relay and at most two relay attempts.
- Explicit merchant browsing keeps the shared NIP-65 author-write relay lookup
  with at most eight attempts. It has no homepage author or date restriction.
- Text search: one ranked NIP-50 request, including the complete eligible author
  and selected category scope, with 100 candidates. Client scope validation
  remains mandatory when a relay ignores filters.
- Family candidates reuse the existing exact-coordinate reader, with at most
  32 family targets per browse page. Known signed revisions, deletion evidence,
  grouping, source provenance, and exact action-time checkout reads remain
  shared Core responsibilities.
- Browse and search operations have a 20-second deadline covering planning,
  queue admission, verification, and transport. Navigation/account changes
  cancel queued and active reads. Automatic query retries are disabled.

Scrolling expands product reads only when the loaded results cannot supply the
next display page, with at most one extra read page prepared for each revealed
display page even when results are sparse. A button retains keyboard and observer-fallback access. The feed opts out of
scroll anchoring so appended cards do not drag shoppers to the bottom and
cascade page reveals.
A bounded empty or capped result is not global absence. Recent/all/facet pages
use inclusive timestamp overlap from verified candidates before deletion filtering.
The next cursor respects each saturated relay's window, so a sparse source cannot
skip a denser source's unseen listings. Saturated timestamp ties expand to at most 384
candidates; if that boundary still cannot be traversed, the UI asks shoppers to
narrow the scope instead of silently skipping unseen tied events. NIP-50 has no
portable ranking cursor; capped search results remain explicitly incomplete.

Broad discovery intentionally uses a bounded commerce relay plan. Merchant
navigation and exact product/detail/action reads retain the existing author
relay paths. Two commerce relays cannot establish network-wide catalog coverage.
No service, runtime dependency, cache schema migration, event emission, signer,
payment, or checkout-authority change is introduced.

## Controlled initial-work comparison

Compared against the open #632 head `161ff69cc374928ad71837b20279643a9a6b8c58`.
Three fresh Chromium contexts per branch used the same 64 merchants, 1,536 signed
listings, and controlled 20ms WebSocket responses. Medians below include the first
visible card plus 2.5 seconds of observation. The equal-card comparison disables
IntersectionObserver on both branches and reveals the baseline's second twelve-card
page explicitly. The baseline's shipped twelve-card mode was also measured.

| Measure                      | #632, 24 cards | Discover, 24 cards |
| ---------------------------- | -------------: | -----------------: |
| Delivered listing candidates |            600 |                 96 |
| Listing response bytes       |        337,638 |             53,976 |
| Listing requests             |              1 |                 12 |
| All initial requests         |             21 |                 27 |
| Time to first card           |        1,729ms |            1,524ms |
| Main-thread long-task time   |          213ms |              213ms |
| Maximum animation-frame gap  |        116.6ms |            133.4ms |

Listing admission and bytes fall by approximately 84%; first-card time improves by
12%. Merchant diversity uses more small requests. Startup responsiveness remains a
tradeoff: aggregate long-task time is unchanged, but the largest frame gap rises by
16.8ms. The shipped twelve-card baseline delivered the same 600 candidates and
337,638 bytes, with a 1,753ms first card. These development-browser measurements
do not establish a uniform responsiveness improvement. Live relay conditions,
warm large caches, built-preview performance, and physical devices need separate
maintainer measurements before treating the budgets as final.

## Validation boundary

`e2e/category-led-products.playwright.ts` composes real signed synthetic listing
admission, controlled WebSocket delivery, browser queries, selectors, and cards.
It covers absent-sample reachability, longstanding listings, combined filters,
price order, recency opt-in, keyboard/mobile behavior, cancellation, and aggregate
initial-work measurements. `tests/marketplace-browse-page.test.ts` covers bounded
reads, revision/deletion convergence, cursor saturation, and account fences.

Synthetic browser measurements establish comparable client scheduling and work,
not production relay latency, physical-device responsiveness, or global catalog
completeness. Preview and physical-device checks remain maintainer-owned.

Sources: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md),
[NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md),
[NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md),
[NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md), and the
[Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md).

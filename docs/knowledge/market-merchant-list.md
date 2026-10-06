# Market merchant discovery list

Market's Conduit catalog uses the public merchant keys in
`apps/market/src/data/market-merchants.json`. This is a repository-owned
discovery condition. It is not a signed follow list or a payment, identity,
inventory, or fulfillment guarantee.

Guest product discovery, product search, seller suggestions, and event
discovery share this scope. Connected Conduit and combined feeds also use this
list; personal following feeds still read the connected account's own signed
follow evidence. The Conduit catalog does not need an account signer, a
particular npub, a kind-3 refresh, or a saved follow-list override.

## Updating the list

1. Add or remove lowercase 64-character public keys in the JSON array, keeping
   it sorted and unique. Submit the change through ordinary PR review.
2. Include the public listing evidence, observation date, relay coverage, and
   reason for each change. Distinguish eligible, excluded, and pending evidence.
   Missing profile fields, small catalogs, old publication dates, or incomplete
   relay reads alone are not reasons to exclude an otherwise real merchant.
3. Review current listing revisions, deletions, expiration, readable commerce
   offers, and explicit test/spam or unsuitable content. Inspect ambiguous
   cases directly. Treat scores and automatic classification as advisory.
4. Run the merchant-list tests and Market browse smoke tests. Merging and
   deploying the PR releases the new scope. A browser refresh reloads listing
   data; it does not update the bundled merchant list.

The catalog cache and discovery queries include the resolved author set.
Changing the list therefore changes their scope. Old
`conduit.market.defaultPerspectiveFollows.v3` browser data is unused.
The checked-in merchant scope is the catalog's content policy. The client does
not classify listing text/tags or apply warning, block, or review states.
Merchant visibility, usable images, supported variation structure, signed
revisions, expiration, and deletion reconciliation still apply.
Product reads use the existing bounded author batches. Event discovery retains
its existing 64-organizer bound and reports partial coverage for larger scopes;
the shared list does not imply that every organizer was queried.

## Browse loading

The category-led `/products` feed uses separate bounded pages and full-scope
selector metadata; see [category-led product browsing](category-led-product-browsing.md).
The merchant directory retains the progressive catalog path below.

Market shares one progressive catalog query across matching consumers, scoped
by catalog authors, source, account/session authority, and relay settings. A
warm query is reused for one minute; an explicit refresh starts one replacement
read while retaining its previous result until a current cumulative snapshot
arrives. Empty deletion-resolved snapshots remain authoritative.

Validated public product batches are written through the existing monotonic
cache as they arrive. Browse persistence does not wait for every product and
deletion relay to finish, and cached data remains discovery evidence rather
than purchase authority. Every progressive projection and final resolution
reconciles currently known deletion evidence.

Relay arrivals are consumed as deltas and coalesced before parsing, cache
writes, and catalog projection. Parsing yields between small time slices.
Prepared progressive snapshots bypass recursive query structural comparison;
signed deletion evidence still retracts products during and after the read.
Each reconciliation indexes its deletion-evidence snapshot once by author and
event or address, then reuses that lookup across products and retained families.
Exact-event precedence, address timestamp cutoffs, and evidence validation remain
unchanged. Cache update selection likewise uses indexed membership rather than
scanning every requested ID for every existing row.

The shared plain public relay reader owns transport admission. It returns only
canonical signed fields and keeps actual relay-source observations separately
by object identity. Cryptographic proof may transfer across identical signed
snapshots; relay provenance never transfers merely because an event has a
matching ID or signature. Distinct-event and duplicate counts, cancellation,
authority fences, coverage, and protected inbox isolation retain their reader
contracts. Public NDK readers and fanout wrappers are not part of this path.

Browser public-event admission computes the canonical event hash and verifies
the signature in a worker. Parsing and schema validation reuse proof only when
every signed field matches an immutable verified snapshot. Proof is local to
the process, never inferred from persisted display data or an event ID alone.
The cross-object lookup cache is bounded; admitted objects retain their proof
while in use. The worker posts one batch at a time, bounds queued work, and
starts its execution deadline only when a batch is posted. A timeout permits
one worker replacement and retry. Persistent failure reports unavailability;
browser queue overflow or worker failure never switches crypto to the UI thread.

Client content rules and their caches have been removed. Listing availability
only describes merchant visibility, usable images, and supported variation
structure. It is not a content assessment or a review decision. The merchant
list controls Conduit catalog content discovery; personal follow feeds retain
their own merchant scope.

Products hydrate merchants for visible cards and one next page. Store-menu and directory
identities hydrate the displayed rows plus one next page; shoppers can reveal
additional rows by scrolling without hydrating the entire catalog at once. A
load-more action remains available for keyboard and observer fallback use.
The multi-select merchant picker searches names through the existing scoped
device/relay profile search, including merchants beyond its displayed page;
typing does not restart product discovery. Menu profile prefetch follows its
display order. Each merchant option names its matching product count; “All
merchants” has no aggregate count, and the products page has no results total.
Refresh, loading, degraded and empty-state feedback remain visible. Directory
totals count matching merchants. For short, partial or unavailable name searches,
a check-more action advances staged hydration of undisplayed discovered sellers,
even with no matching rows. Matching rows retain automatic scroll paging.
Completed empty profile searches report absence only on the searched relays;
device-only, partial and unavailable evidence retains incomplete feedback.
Inline seller-name search
uses a bounded preview and links to the merchant directory. Unchecked names
remain explicitly incomplete rather than implying no matches. Profile query keys
include relay hints only for their requested merchants, so unrelated catalog
arrivals do not restart those reads. Long directory/menu lists mount avatar
images near the viewport; profile banners mount on the
profile route. Kind-0 profile metadata is a complete event, so fetching names
also receives other metadata fields, but receiving an image URL does not
download that image.

The directory and merchant menu retain their existing catalog scope and relay
selection. Their row paging is display pagination. Products use the bounded
relay pagination described in the category-led browsing note. A first page
does not establish complete relay coverage.

## Initial review basis

The 2026-10-03 anonymous public read of `wss://relay.conduit.market` returned
12,829 signed product rows from 1,885 authors. Bounded, overlapping pagination
reached a terminal page. Signatures, current coordinate winners, signed
deletions, expiration, product parsing, and existing client display eligibility
were checked before text review.

The initial list contains 889 keys: 634 merchants with reviewed current offers,
plus 339 retained prior entries, with 84 overlapping. This adds 550 merchants
and removes three entries with explicit test-only catalogs from the prior
curation. Of the 634 reviewed merchants, 376 had display-eligible listings and
258 needed listing-format or visibility repair. Inclusion does not bypass those
display rules. The 251 retained entries absent from this relay read have prior
curation evidence rather than fresh content review.

The read covers one relay's returned public corpus, not global Nostr absence.
Text review used titles, representative descriptions, and targeted full text;
image pixels and every description were not inspected. Future listings and
mutable images are outside this snapshot. A merchant list also permits mixed
catalogs: four visible test fixtures were identified within otherwise eligible
catalogs. These limits remain relevant until listing-level filtering replaces
merchant-level curation.

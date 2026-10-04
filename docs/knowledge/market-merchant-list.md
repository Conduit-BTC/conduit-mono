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
Existing item-level visibility and safety filters continue to apply.
Product reads use the existing bounded author batches. Event discovery retains
its existing 64-organizer bound and reports partial coverage for larger scopes;
the shared list does not imply that every organizer was queried.

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

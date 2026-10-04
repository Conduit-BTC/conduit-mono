# Progressive Event Market discovery

Browsing and purchase authority are separate. The current implementation uses
shared Core readers in `event-market-roster-read.ts` and the scoped
`useProgressiveEventMarketDiscovery` query boundary.

## Timeline and catalog

Timeline discovery starts with retained signed headers and a bounded organizer
scan. Current bounds are 64 organizer authors, 128 market coordinates and four
concurrent header reads. Hitting a bound remains incomplete coverage. Account,
relay, perspective and authentication generation belong to the query scope;
cancelled or superseded progress cannot update the active view. Unrefreshed
retained rows are marked stale, not promoted to fresh authority.

The catalog paints provisional product candidates before per-merchant admission
checks. A bounded market-tag query, cached candidates, search and Load more
support fast browsing. Signed product ownership, visibility and known negative
evidence still constrain what can be shown. An unavailable optional source is
not proof of absence. A known revoke, deletion or newer untagged revision cannot
be undone by a stale response.

`FutureEventMarketPage` renders incremental results in its scoped query and
states that availability is checked on selection. Search and merchant filters
share the event context. Recurring markets require a selected occurrence; share
links and QR signs retain merchant and occurrence filters.

## Consequential actions

Adding an event product reads its current market and exact product authority
and builds a signed pickup snapshot. Direct product links use the same current
model. Candidate display alone never grants cart or payment authority.

Checkout resolves only the selected purchase and checks current open market,
merchant row, causal grant, calendar or selected occurrence, product and payee.
Missing required facts and known conflicts block. An unrelated optional relay
failure does not veto positive required evidence. Mode, assignment, date,
product, price or payee changes require review; unrelated roster revisions do
not. Shipping can be selected while preserving event context for switching back.

Created orders retain accepted signed bytes. Private handoff recovery uses
those exact order terms rather than discovering a new catalog revision and
applying it to already-purchased goods.

## Validation

Measure first header, first product and purchase readiness separately. Test
cold and warm reads, held siblings, bounded completion, failed refreshes,
account/scope cancellation, retained negative evidence, and current exact action
checks. Relevant suites include `event-market-discovery-progress`,
`event-market-discovery-boundaries`, `progressive-event-market-discovery-query`,
`event-market-checkout-authorization` and `event-market-cutover-snapshot`.

The composed browser suite is `e2e/event-market.playwright.ts`. Run the Market
and Merchant areas from the same frozen candidate. Synthetic signer and relay
results establish local behavior; record preview, live relay, external signer,
wallet, device and physical pickup evidence separately.

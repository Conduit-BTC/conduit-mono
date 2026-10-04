# Progressive Event Market discovery

Browsing and purchase authority are separate. The current implementation uses
shared Core readers in `event-market-roster-read.ts` and the scoped
`useProgressiveEventMarketDiscovery` query boundary.

## Timeline and catalog

Timeline discovery starts with retained signed headers and one shared public
relay plan. Following and curated perspectives scan every organizer in batches
of 64; 64 is a request size, not an audience limit. Market guests browse kind
30409 candidates without an author filter on the selected public relays. An
empty Following list remains an empty audience.

Candidate reads run four at a time with a budget of 128 requests per pass.
Saturated pages descend by signed creation time, checking the entire final
timestamp before moving to older records. A saturated same-second range stays
partial and retryable because NIP-01 offers no event-ID cursor. Partial or failed
pages retain their position. Exact roster and calendar hydration runs four at a
time, for up to 128 coordinates per pass. Only discovered or retained coordinates
need organizer relay planning. Observed relay sources accompany exact reads.
Remaining pages and coordinates are scoped continuations exposed by Market's
Find more events action; refreshing starts a new scan at the newest records.
These are bounded reads, not proof of global Nostr absence. Account,
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

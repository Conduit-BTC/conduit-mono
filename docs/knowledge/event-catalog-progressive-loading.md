# Progressive Event Market discovery

Browsing and purchase authority are separate. The current implementation uses
shared Core readers in `event-market-roster-read.ts` and the scoped
`useProgressiveEventMarketDiscovery` query boundary.

## Timeline and catalog

Timeline discovery starts with retained signed headers and one shared public
relay plan. Following and curated perspectives scan every organizer in batches
of 64; 64 is a request size, not an audience limit. One batched NIP-65 lookup
adds explicit organizers' advertised write relays to that same bounded plan,
with their source grants retained through final network admission. Unavailable,
stale or partial relay metadata keeps discovery coverage limited. Market guests browse kind
30409 candidates without an author filter on the selected public relays. An
empty Following list remains an empty audience. Established session identity owns
that audience even while a remote signer is recovering. Only a settled guest
session uses author-free discovery and public-browsing messaging; signer readiness
does not turn a retained account into a guest.
Retained account scope does not admit owner-only relay grants. Those reads also
require the matching connected signer and a current authority generation.
When that authenticated owner belongs to the explicit organizer audience,
discovery also includes the owner's signed write-only relay selections. This
preserves cold discovery on explicitly selected non-TLS transports without
granting them to other audiences or recovering accounts.

Candidate reads run four at a time with a budget of 128 requests per pass.
The relay planner's distinct admitted-source cap applies to the whole scan,
including subsequent pages and continuations. Live source-policy admission stays
in the shared public reader; suppressed candidates do not consume an admitted
source or request slot, so later eligible sources can fill the plan. Changing the
plan's cap invalidates its continuation.
Saturated pages descend by signed creation time, checking the entire final
timestamp before moving to older records. A saturated same-second range stays
partial and retryable because NIP-01 offers no event-ID cursor. Partial or failed
pages retain their position. Verified observations on an incomplete page can
also advance through its final timestamp to older records without clearing the
retryable range or claiming complete coverage. Duplicate cursors share one
request in a pass. Exact roster and calendar hydration runs four at a
time, for up to 128 coordinates per pass. Only discovered or retained coordinates
need exact organizer hydration. Observed relay sources accompany exact reads.
A new signed revision or newly observed source refreshes exact hydration, even
when that source delivers an already-seen event ID. Source provenance is separate
from signed event identity.
Remaining pages and coordinates are scoped continuations exposed by Market's
Find more events action. Each pending coordinate keeps its observed relay hints
through continuation so exact reads prioritize its actual sources within the
bounded plan; the selected discovery relay set is not evidence that every
coordinate was observed on every relay. Refreshing starts a new scan at the
newest records.
These are bounded reads, not proof of global Nostr absence. Account,
relay, perspective and authentication generation belong to the query scope;
cancelled or superseded progress cannot update the active view. Unrefreshed
retained rows are marked stale, not promoted to fresh authority.

The catalog paints provisional product candidates before per-merchant admission
checks. Bounded kind `30410` reads select the exact market and occurrence from
the roster's merchant authors, then resolve ordinary product coordinates.
Cached candidates, search and Load more support fast browsing. Signed ownership,
visibility and known negative evidence still constrain what can be shown. An
unavailable optional source is not proof of absence. A known grant or assignment
revoke, deletion, or stronger product visibility state cannot be undone by a
stale response. Removing an ordinary product's discovery hint alone does not
revoke a valid assignment.

`FutureEventMarketPage` renders incremental results in its scoped query and
states that availability is checked on selection. Search and merchant filters
share the event context. Recurring markets require a selected occurrence; share
links and QR signs retain merchant and occurrence filters.

## Discovery storage

Candidate signatures enter persistent storage only after their coordinate is
admitted to the 128-coordinate hydration set. Excess candidates retain their
coordinates and observed relay sources in continuation, without writing their
signed bodies. Continued hydration fetches those exact coordinates from their
observed sources.

The shared evidence store accounts for discovery headers, exact roster revisions,
calendars and deletions together. Background discovery can retain at most 2,048
records and 8 MiB of serialized UTF-8 rows across scans, audiences and accounts.
The capacity check and writes share one IndexedDB transaction. At capacity,
live browsing continues; failed retention yields partial coverage rather than
claiming durable cache custody. A newly verified scoped deletion has priority
over reconstructible discovery presentation. The transaction may remove cached
calendars for a now-deleted market while keeping every roster witness, deletion
and authorization record. It may also remove an entire empty initial open
candidate with no history or durable evidence. Closed markets, multiple
revisions, enrollment, negatives, malformed records and legacy/durable rows
remain protected. Replacement and negative retention commit atomically; a
failed write rolls back both. When no safe space remains, retention is explicitly
incomplete rather than dropping protected evidence or expanding the budget.

Organizer publication and consequential exact reads retain durable evidence.
Verified scoped deletions of that evidence join the same durable custody,
including when background discovery observes them at a full cache. This does
not create durable coordinates from unrelated public candidates.
Unclassified legacy rows are also treated as durable; discovery cannot demote
or prune them. A durable write promotes a matching discovery record. These
records are outside the background discovery budget and keep the existing
2,048-record per-coordinate safety limit. This is an admission policy, not a
retention guarantee for all browser storage. Dexie v27 adds an index for the
optional discovery size field without rewriting retained rows. Routine quota
checks read size keys; negative-priority replacement inspects bounded cache rows.
Main and discovery previews independently used v26. The fresh v27 schema
preserves both lineages and the assignment preview's populated v25 stores.
Dexie replays the installed version's schema during an upgrade, so the v25 union
also names those stores to avoid deletion and recreation before v27. These
declarations preserve data. The occurrence writer separately enables merchant
assignment and inventory behavior through the existing product-write transaction
and listing outbox; this schema declaration alone grants no purchase authority.
Tests use exact frozen main and preview schemas, nonempty rows in every store,
signed deletion rehydration, native browser reloads, and encrypted recovery
journals. Structural preservation is separate from inventory/payment acceptance.
`merchant-inventory-schema-upgrade` additionally exercises actual stock,
allocation and order-ID acceptance across those installed histories and reload.
An upgraded profile requires a build that retains the v27 schema. A rollback
must preserve that schema and saved evidence, without resetting IndexedDB.

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

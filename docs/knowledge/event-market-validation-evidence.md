# Event Market validation evidence

This index maps stable acceptance and evidence IDs to current-model regression
coverage. A PR must record the candidate commit, commands or CI URLs, and actual
results. A named test is not proof for a newer head. Historical collection-based
fixtures are retired; the corresponding user outcomes use current signed data.

| Acceptance | Evidence | Observable outcome                                                                          | Automated coverage                                                                                                        | Separate human evidence                                    |
| ---------- | -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| AC-EM-01   | EV-EM-01 | Create an empty market with concrete dates and retry the same signed operation              | `event-market-creation-retry`, `event-market-calendar-retry`, composed browser creation                                   | NIP-07 and NIP-46 on independent devices                   |
| AC-EM-02   | EV-EM-02 | Merchant-present pickup uses the assigned merchant and no organizer release message         | `order-event-market-fulfillment`, `market-event-fulfillment`, `event-market-cart-snapshot`                                | Preview merchant booth journey                             |
| AC-EM-03   | EV-EM-03 | Organizer pickup requires authenticated merchant authority and exact goods                  | `event-market-order-evidence`, `event-market-handoff`, `merchant-order-pickup-authorization`                              | Live private delivery and physical release                 |
| AC-EM-04   | EV-EM-04 | Known revoke, conflict, deletion or absent current authority blocks new commerce            | `event-market-authorization`, `event-market-roster`, `event-market-checkout-authorization`                                | Independent-session revoke/reapprove                       |
| AC-EM-05   | EV-EM-05 | Provisional discovery stays fast and cannot authorize a purchase                            | `event-market-discovery-progress`, `event-market-discovery-boundaries`, Market `progressive-event-market-discovery-query` | Cold mobile event discovery                                |
| AC-EM-06   | EV-EM-06 | Material purchase changes require review; unrelated roster revisions do not                 | `event-market-cutover-snapshot`, `event-market-checkout-authorization`, `event-cart-current-model`                        | Preview changed-price/date/assignment review               |
| AC-EM-07   | EV-EM-07 | Exact encrypted retries survive reload and do not duplicate release                         | `event-market-handoff`, `future-market-private-read-cancellation`, composed private handoff browser journey               | Interrupted live delivery and fresh-device recovery        |
| AC-EM-08   | EV-EM-08 | Private receipt contents remain minimal; merchant retains payment authority                 | `event-market-handoff`, `event-market-order-evidence`, `event-market-e2e-privacy`                                         | Inspect organizer and buyer UI without collecting payloads |
| AC-EM-09   | EV-EM-09 | Known revocation blocks release; authenticated acknowledgement supports merchant completion | `merchant-order-phase`, `merchant-order-action-view`, composed handoff browser journey                                    | Physical handout and completion                            |
| AC-EM-10   | EV-EM-10 | Assignment pickup permits contact-free checkout; historical immediate pickup retains opt-in | `buyer-checkout`, `event-contact-free`, `market-event-fulfillment`                                                        | Mobile guest receipt retention and recovery                |
| AC-EM-11   | EV-EM-11 | Host, merchant, buyer and organizer flows work together                                     | `e2e/event-market.playwright.ts` in both app areas                                                                        | Candidate preview with independent real accounts           |
| AC-EM-12   | EV-EM-12 | Ordinary shipping, digital products and non-event collections still work                    | `buyer-checkout`, `cart-model`, `commerce-gateway`, `merchant-product-publishing`                                         | Ordinary nonzero purchase and wallet settlement            |
| AC-EM-13   | EV-EM-13 | Finite recurrence and shipping/pickup choices retain exact selected date                    | `event-market-schedule`, `event-fulfillment-choice`, `future-event-market-timeline`, composed browser cases               | Timezone and device checks                                 |
| AC-EM-14   | EV-EM-14 | Event and merchant QR signs support preview, batch and Print / Save as PDF                  | `merchant-event-signage`, `merchant-event-market-route-contract`                                                          | Print both PDFs and scan each on a phone                   |
| AC-EM-15   | EV-EM-15 | Old event links ask for reposting and never authorize old-model commerce                    | `event-cart-current-model`, `checkout-authorization`, composed repost browser case                                        | Confirm new posted links replace old signs                 |

All named unit suites are under `tests/` unless noted. Browser evidence uses
synthetic external signers and controlled relays; it is not cryptographic wallet,
live relay, preview, real signer or physical pickup evidence. Disable screenshots,
trace and video in private-order fixtures. Public evidence must omit identities,
orders, contact details, invoices, wallet material and private message contents.

The composed private-handoff journey also checks merchant receipt and organizer
handed-out retries after signer readiness is lost: fresh actions remain disabled,
altered saved wraps are rejected, and the original recipient and self-copy IDs
are replayed without new signing. Organizer recovery is scoped to the retained
owner and pending deliveries; a different account cannot access its retry control.
Owner-retirement cancellation is covered separately at the shared delivery
boundary. Real relay authentication can still require a connected signer.

The cart-to-order journey adds two products across an unrelated signed roster
revision and verifies one order and private release. Signed recurring dates
remain selectable after an interrupted calendar read; a retained date absent
from the next live read stays disabled in the buyer selector. The product-detail
selector reaches the same action-time signed-evidence gate.

The variable-product journey opens the existing variation selector before adding
an Event Market product. The composed checkout verifies that the signed order
contains the purchasable variation and its specifications, retaining Event Market
pickup terms rather than placing the variable parent in the cart.

Shipping-choice and guest-receipt fixtures use the shared calendar builder so
timed events retain every required UTC day tag when the test runs near midnight.
A fixed midnight unit case verifies both complete and incomplete signed calendars.

The weekly-date authoring journey holds the post-publication roster refresh and
checks that another edit or removal cannot start until the refreshed schedule
arrives. Publication alone does not mean the editing state has caught up.

Organizer handoff authenticates the original signed roster, occurrence, optional
schedule and causal merchant grant carried in the private ready receipt. This
is an offline check of the organizer-handoff role, not another merchant or
product approval. Current roster removal, public grant revocation, closure,
calendar expiry and relay pruning do not reinterpret an already-created order.
The exact authenticated private release and its private revocation/conflict
state remain authoritative for physical handoff. Receipts without the signed
approval bundle remain decodable, but cannot authorize a new handoff ACK.
The composed journey prunes the original approval and publishes a later closed
roster and revoked grant before handing out the paid order; no exact approval
relay reads occur. `future-market-merchandise` also rejects fabricated or
mismatched approval evidence before reads, signing or persistence.

Signed market open/closed state and occurrence expiry are separate gates.
New assignment purchases require an unended concrete occurrence, including a
single-date market; series also require verified selected-date membership.
`event-market-checkout-authorization` and assignment admission cover snapshot
creation and submit. One occurrence ending does not close the whole market or
reinterpret historical accepted orders.

Catalog discovery resolves the signed roster before querying kind `30410` by
its bounded merchant author set and exact market/occurrence, then resolving the
ordinary product coordinates. An empty roster sends no assignment query. Product
discovery tags establish no assignment authority. Cached signed cards still appear before the network wait;
candidate display adds no per-merchant grant reads or purchase authority.
`event-market-roster` covers 48 and 256 newer unapproved listings ahead of an
approved product, including partial relay coverage and saturated responses.
Retained organizer revocation, conflict, deletion and unresolved causal evidence
suppress candidate cards; a complete causal regrant can restore them. No
additional network read is needed to honor this already-observed evidence.

Direct product pickup checks the current signed roster, selected occurrence,
merchant grant and exact product revision at both Add and increment. The browser
regression changes revocation, closure, product association, deletion, price and
pickup assignment after rendering, and preserves unrelated roster edits. A
rejected action leaves the cart quantity unchanged and refreshes the displayed
terms before another action.

Private handoff recovery is bounded per owner using serialized UTF-16 sizes:
768 KiB pending deliveries, 1 MiB exact archives, 1 MiB observed encrypted wraps
and 512 KiB compact terminal history. New ready receipts leave 256 KiB of byte
headroom; the pending queue allows 96 ready admissions and 128 total updates.
Active exact bytes are never evicted to make room for a new release. Storage
failure preserves saved retries and blocks new issuance.

Authenticated organizer terminal observations compact encrypted history while
retaining claim, graph-conflict and revocation denial fences. Merchant exact
receipt and ACK evidence remain until an authenticated merchant-authored final
order status permits compaction. Compact markers cannot establish payment,
handoff acknowledgement or order completion. `future-market-handoff-storage`
covers quota volume, restart/degraded reads, interrupted writes and reserved
terminal-update capacity. Other owners/features share the origin quota, so a
bounded handoff allocation does not guarantee every storage write succeeds.
Retention and completed-history compaction use the same account-scoped Web Lock
where available, with a serialized runtime queue as fallback. This coordinates
the asynchronous decrypt/merge window with compaction across browser tabs;
environments without Web Locks only have runtime-local serialization.

New assignment checkout permits contact-free pickup without a product opt-in
until the selected occurrence ends. Historical pre-assignment immediate pickup
retains its currently-occurring date and merchant-signed opt-in checks. Historical decoding checks the claimed creation-time terms;
buyer-authored payload and rumor timestamps do not independently prove when a
merchant observed the order. Receiver time cannot distinguish backdating from
delayed delivery or another device's recovery. `event-contact-free` preserves
receipt verification after the date has ended. Decoding and bearer receipt
possession establish neither payment nor fulfillment authorization.

## Occurrence writer integration evidence

`merchant-inventory-product-write` composes actual signed acceptance, the existing
`commitLocalProductWrite` owner and listing delivery adapter. It covers atomic
ordinary edits, allocation floors, rollback, failed publication, repeated orders,
subsequent acceptance and preservation of newer ordinary product metadata.
`merchant-inventory-schema-upgrade` uses the exact main-v26, discovery-v26 and
assignment-v25 histories, commits real stock/allocation/order records, upgrades,
accepts concurrent repeated orders, rejects oversell, and reloads retained signed
retry work without another debit or signature. The installed assignment-v25
state is created with its frozen v25 writer before the current writer runs on
the upgraded database. Structural union preservation in
`event-market-schema-upgrade` remains a separate check.

These are synthetic cryptographic/database integration tests. They do not prove
external signer compatibility, independent-device reconciliation, live relay
convergence, funded settlement or physical handout. Same-event rescheduling retains original order terms and updates unused
allocation deadlines. Atomic rollover remains incomplete. New delegated organizer acceptance is gated;
historical organizer receipt tests cannot stand in for that integration.

## Order continuity regression coverage

`merchant-occurrence-regressions` composes signed products, actual checkout
pricing, existing local product writes, reopened inventory and acceptance. It
covers order source-currency consistency, original quotes after later listing
price edits, prior stock decisions and shortfalls,
pending pre-assignment orders, concurrent material product edits, retained
variation-parent withdrawal evidence, and cold/warm assignment reads with
missing superseded history and known-fork controls. Both ordinary product
edits and existing order stock actions honor a retained postponement before
any assignment-panel read. `merchant-order-publish`
verifies immutable acceptance notification identity after interruption.

The `@occurrence-orders` cases in `e2e/event-market.playwright.ts` run in the
Chromium, mobile Chromium and mobile WebKit smoke projects. They exercise the
direct assignment and order flow, prepaid first confirmation before/after a
same-event reschedule, paid pickup and original receipt continuity after the old
end, revised unused-allocation deadlines in both directions, publication retry
after payment, selected-order resolution beyond the product-search cap, and
reload of off-graph assigned events in Selling At without product association
tags. The selected-order case holds the requested order while another saved
conversation is available: no acceptance action may target that other order,
and release commits exactly one acceptance for the requested order.
Browser payment reports, merchant confirmations and signer/relay interactions
are synthetic; these checks establish client behavior, not funded settlement.

Saved inventory acceptance is bound to the original order identity and complete
terms. Merchant display and fulfillment recheck that binding; another valid,
same-ID payload cannot inherit acceptance or unlock zero-cost completion.
Explicit merchant acceptance and payment confirmation retain the original quote
after a later listing-price edit. The current signed listing remains the stock
projection baseline, and concurrent material edits still reject the whole debit.
The composed browser controls cover both the conflicting-order rejection and
first confirmation at the original price after a published listing edit.

The legacy stock-credit browser case interrupts notification signing before
transport staging, then reloads and retries against the same saved acceptance.
A reload during an in-flight private send retains its delivery claim until
release or expiry; an immediate successful retry is not guaranteed during that
lease. Tests must establish their interruption boundary without bypassing the
shared delivery owner's claim or increasing assertion timeouts.
The first-payment controls hold the recipient ACK to distinguish observed
publication bytes from a completed confirmation, then wait for the completed
confirmation before reload and inventory-publication retry.

Ordinary acceptance must preserve the product editor's tracking-mode controls
when there are no incompatible active assignments. Composed shared-writer tests
cover both mode changes after acceptance and publication, with active-assignment
rejection controls. Checkout evidence retains the complete supported signed
authorization history; the shared encrypted transport-size limit bounds the
whole message rather than imposing a smaller recovery-event count. The signed
61-event ancestry control retains all 65 required evidence events.

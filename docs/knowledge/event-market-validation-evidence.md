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
| AC-EM-10   | EV-EM-10 | Signed-in and guest contact pickup remain; immediate contact-free pickup is opt-in          | `buyer-checkout`, `event-contact-free`, `market-event-fulfillment`                                                        | Mobile guest receipt retention and recovery                |
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

The composed private-handoff journey also checks exact retry after signer
readiness is lost: fresh actions remain disabled, altered saved wraps are rejected,
and the original recipient and self-copy IDs are replayed without new signing.
Owner-retirement cancellation is covered separately at the shared delivery
boundary. Real relay authentication can still require a connected signer.

The cart-to-order journey adds two products across an unrelated signed roster
revision and verifies one order and private release. Signed recurring dates
remain selectable after an interrupted calendar read; a retained date absent
from the next live read stays disabled in the buyer selector. The product-detail
selector reaches the same action-time signed-evidence gate.

The weekly-date authoring journey holds the post-publication roster refresh and
checks that another edit or removal cannot start until the refreshed schedule
arrives. Publication alone does not mean the editing state has caught up.

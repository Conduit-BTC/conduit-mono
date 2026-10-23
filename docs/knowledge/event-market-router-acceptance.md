# Event Market router acceptance

This checklist covers the current Event Market extension, not deployment or
release approval. Record the exact candidate commit, environment and results
with the implementation PR. Simulated providers, browser-sized layouts and
local relay acknowledgements do not establish live payments, physical-device
behavior or recipient observation.

## Supported path

Use current signed roster, occurrence, merchant authorization, product and
assignment revisions. Merchandise can use the existing supported native-unit,
signed fiat-rate and selected-variation quotes. Shipping remains independently
governed. Organizer handout requires finite tracked stock, an explicit private
grant and the matching public assignment commitment. Untracked stock is not an
unlimited organizer pool.

The buyer reviews merchandise, organizer fee, Conduit fee and fixed funding
total. One checkout wallet and invoice fund the existing ordered executor:
merchant/supplier commerce, organizer allocation, then native Conduit
collection. A genuinely zero-cost purchase uses no financial plan, wallet or
invoice. A positive organizer minimum on free goods is a disclosed fee-only
payment, not a free pickup.

When coordinated payments are unavailable, a positive organizer fee or unusable
current fee terms block new checkout; they never permit commerce-only direct
payment. Direct order/payment submission rechecks the fresh authorized terms
before retaining or publishing an order. Ordinary and positively zero-fee event
flows keep their existing behavior; retained funded plans remain recoverable.

Goods payment, physical handout, routing completion, receiver claim and safe
wallet retirement are separate facts. An independently verified sender-committed
native transfer can finish its payment obligation while its receiver is offline;
retain evidence until the separate retirement requirements are met.

## Automated evidence map

| Boundary                                                               | Primary local coverage                                                                                                                                  | Fidelity                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Signed event/price/variation binding and additive fees                 | `checkout-spark-event-market-sources`, `checkout-spark-event-allocation`, `checkout-spark-event-entry`, `checkout-spark-event-fiat`                     | Real runtime-generated signatures; deterministic quotes/providers                                                  |
| Disabled-profile organizer fee admission and fresh direct-submit guard | `checkout-spark-checkout-admission`, `checkout-event-direct-admission`, disabled-router cases in `e2e/event-market.playwright.ts`                       | Real signed fixture terms and actual checkout controls; no live payment                                            |
| Actual Buyer preparation and payment continuation                      | `checkout-spark-event-execution`                                                                                                                        | Existing app preparation/runner and SDK adapter; controlled external wallet/provider/relay                         |
| Organizer recovery, exact progress and current writer                  | `checkout-spark-organizer-authority`, `checkout-spark-organizer-progress`, `checkout-spark-organizer-routing`                                           | Real NIP-44/NIP-59, shared executor, fake IndexedDB and controlled providers                                       |
| Merchant financial fallback and reciprocal actor progress              | `checkout-spark-event-actor-recovery`, `checkout-spark-event-order-witness`, `checkout-spark-merchant-event-progress`, `checkout-spark-event-execution` | Authenticated original Buyer order, role-authentic encrypted checkpoints and exact provider reconciliation         |
| Free purchase and bounded guest delivery                               | `event-market-free-purchase`, `event-market-free-purchase-delivery`, `event-market-free-purchase-authority`                                             | Real cryptography, exact ciphertext retry, no payment wallet                                                       |
| Claim, once-only handout, stock import and cold history                | `event-market-stock-handout`, `event-market-stock-import`, `event-market-stock-merchant-inbox`                                                          | Authenticated private envelopes and existing inventory transaction                                                 |
| Active replacement device and old-device fence                         | `event-market-stock-writer-handover`, `event-market-stock-writer-fence`, `event-market-stock-device-projection`                                         | Complete real-crypto multipart journal, independent recipient ACKs, atomic restore and controlled in-flight checks |
| Stock checkpoint before listing publication                            | `event-market-stock-import`, `product-listing-delivery`                                                                                                 | Existing product outbox and real encrypted checkpoint                                                              |
| Screen-to-screen stock, free pickup, reload and seller reconciliation  | `e2e/event-market.playwright.ts`, “reserved organizer stock carries a free purchase…”                                                                   | Runner-held NIP-07 keys; real crypto; controlled signature-validating relay; no funds                              |
| Buyer, Organizer and Merchant routing through actual screens           | Event Market cases in `e2e/commerce-router-recovery.playwright.ts`                                                                                      | Real local signatures and SDK identity derivation; controlled providers; no live funds                             |

Names above identify suites, not a claim that their latest execution passed.
Use current-head check output for results. Historical Merchant release receipts
remain readable; new finite-pool orders use the organizer stock/claim workflow
instead of requesting another live Merchant release signature.

`checkout-spark-event-merchant-worker` additionally exercises the real Merchant
discovery and automatic worker after a partial Organizer payout, using an
independent database and controlled external providers. The handout presentation
is covered by `event-market-organizer-merchandise` and
`event-market-organizer-pickup`: exact signed product/parent revisions, selected
options and per-line quantities come from the frozen purchase, not a current
catalog fetch. Missing or conflicting item details do not permit physical release.

`checkout-spark-event-concurrent-actors` exercises independent Merchant and
Organizer stores at the real preparation/executor seam. Its controlled provider
deduplicates the identical transfer ID; divergent invoices remain a paused
conflict without another economic payout. This does not establish deployed
provider concurrency behavior or a distributed client lock.

## Final preview acceptance

Use independent approved test identities and the exact candidate preview.
Keep keys, recovery files, invoices, claims and payment details out of shared
screenshots, logs and public evidence. Obtain explicit approval for live funds
and the test spending limit separately.

1. Create an event with a concrete date, approve a seller for organizer pickup,
   assign tracked goods and set a disclosed organizer fee. On the organizer's
   intended device create its handover ID; the seller reserves a finite quantity
   to that device. Receive the exact grant. Check ordinary seller availability
   excludes those entrusted units.
2. As a fresh buyer choose the date, product and variation. Check the fixed
   amount and organizer disclosure. For contact-free checkout save the private
   receipt and verify no shipping contact fields are required.
3. Fund once from an approved source and keep the buyer visible. Verify automatic
   merchant/supplier, organizer and Conduit payment processing without manual
   payout clicks. Confirm exact provider evidence, not a screenshot or balance
   subtraction alone. Offline native receiver claim must not produce an endless
   routing spinner or a second send.
4. Repeat the approved recovery scenario: suspend/close the buyer after funding
   or a partial payout, leave the seller offline, then open the organizer's saved
   order after the original buyer cutoff. Continue the same attempts; independently
   verify paid legs are skipped. Verify the buyer's exact code before one physical
   handout, matching each displayed product, variation and quantity to the goods.
   A wrong or repeated claim cannot release another item.
   Exercise Merchant financial fallback separately after an interrupted Organizer
   payout. A fresh Merchant session authenticates the original Buyer order and
   Organizer checkpoints, reconciles exact attempts, and publishes its own
   separately encrypted progress before further sends. The original Organizer
   stock device can then verify the same attempts without paying again. Merchant
   financial recovery neither requires nor grants the Organizer stock-writer
   role, a claim, physical handout, or a second inventory debit.
5. Reload organizer history. The saved handout is retry-only. Have the seller
   import the original Buyer order and organizer acceptance once, then retry it;
   stock must not decrement again. Close the pool and reconcile the complete
   accepted prefix before returning unused stock.
6. On a fresh seller session recover the encrypted stock checkpoint and confirm
   holds/imported frontiers remain intact. On a replacement organizer device,
   first register its recovery target without granting it writer authority.
   The original device must stop its entire active market writer and retain an
   exact encrypted complete-journal transfer for that target. Restore it on the
   target, verify pending handouts and original pool/claim identifiers survive,
   and verify the original device cannot resume stock writes or handout.
   Completed closed history can also restore read-only. An empty/partial inbox
   cannot reset the former writer or start another active pool. Without the
   positive complete transfer/frontier, unresolved active history requires
   explicit reconciliation rather than automatic writer adoption.
7. Check free goods with no organizer fee separately: no wallet/invoice, one
   stock reservation, exact claim and one handout. Check a signed positive
   minimum on free goods still requires its fee-only payment.
8. Use a physical phone and supported signer. In Safari, fund externally, kill
   the page while the seller is offline, then finish from organizer recovery.
   Browser mobile emulation does not replace this check. Also verify a normal
   non-event purchase remains unchanged.

Pricing service availability, supported receiving endpoints, active recovery
clients and retaining relays remain operational dependencies. Public remaining
stock can lag private organizer sales: a funded order without enough remaining
pool stock needs attention, not a second handout or an automatic refund promise.

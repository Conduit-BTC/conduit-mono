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

Goods payment, physical handout, routing completion, receiver claim and safe
wallet retirement are separate facts. An independently verified sender-committed
native transfer can finish its payment obligation while its receiver is offline;
retain evidence until the separate retirement requirements are met.

## Automated evidence map

| Boundary                                                              | Primary local coverage                                                                                                              | Fidelity                                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Signed event/price/variation binding and additive fees                | `checkout-spark-event-market-sources`, `checkout-spark-event-allocation`, `checkout-spark-event-entry`, `checkout-spark-event-fiat` | Real runtime-generated signatures; deterministic quotes/providers                          |
| Actual Buyer preparation and payment continuation                     | `checkout-spark-event-execution`                                                                                                    | Existing app preparation/runner and SDK adapter; controlled external wallet/provider/relay |
| Organizer recovery, exact progress and current writer                 | `checkout-spark-organizer-authority`, `checkout-spark-organizer-progress`, `checkout-spark-organizer-routing`                       | Real NIP-44/NIP-59, shared executor, fake IndexedDB and controlled providers               |
| Free purchase and bounded guest delivery                              | `event-market-free-purchase`, `event-market-free-purchase-delivery`, `event-market-free-purchase-authority`                         | Real cryptography, exact ciphertext retry, no payment wallet                               |
| Claim, once-only handout, stock import and cold history               | `event-market-stock-handout`, `event-market-stock-import`, `event-market-stock-merchant-inbox`                                      | Authenticated private envelopes and existing inventory transaction                         |
| Stock checkpoint before listing publication                           | `event-market-stock-import`, `product-listing-delivery`                                                                             | Existing product outbox and real encrypted checkpoint                                      |
| Screen-to-screen stock, free pickup, reload and seller reconciliation | `e2e/event-market.playwright.ts`, “reserved organizer stock carries a free purchase…”                                               | Runner-held NIP-07 keys; real crypto; controlled signature-validating relay; no funds      |

Names above identify suites, not a claim that their latest execution passed.
Use current-head check output for results. Historical Merchant release receipts
remain readable; new finite-pool orders use the organizer stock/claim workflow
instead of requesting another live Merchant release signature.

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
   handout. A wrong or repeated claim cannot release another item.
5. Reload organizer history. The saved handout is retry-only. Have the seller
   import the original Buyer order and organizer acceptance once, then retry it;
   stock must not decrement again. Close the pool and reconcile the complete
   accepted prefix before returning unused stock.
6. On a fresh seller session recover the encrypted stock checkpoint and confirm
   holds/imported frontiers remain intact. On a replacement organizer device,
   recover complete closed history read-only. An empty/partial inbox cannot reset
   the former writer or start another active pool; unresolved active history
   requires explicit reconciliation/handover, not automatic writer adoption.
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

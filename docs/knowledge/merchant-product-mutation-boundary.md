# Merchant product maintenance and fulfillment authority

Products are ordinary shop listings. A current Event Market association uses
`eventMarketRefs` on the signed product and does not replace its shipping or
digital fulfillment. Adding an association requires current merchant approval;
a saved association alone does not authorize checkout.

## Two explicit publication paths

Merchant's product publication boundary distinguishes:

- `preserve_existing`: bind the baseline and candidate to the same merchant,
  product coordinate, and `d` tag. Keep the existing format, visibility,
  collection references, shipping references and extra costs, shipping metadata,
  and resolution flags. Publish only changed listings. Ordinary digital and
  coordinate-after-order listings need no event calendar, roster, or merchant
  grant rediscovery for maintenance. Current Event Market references survive
  stock and other ordinary product edits.
- Explicit fulfillment authoring: choosing **Change fulfillment** establishes
  or changes ordinary shipping or digital fulfillment using its validation and
  publication rules. New products and variations cannot inherit an existing
  product's preservation authority.

Canonical fixed shipping is a separate signed kind `30406`. A maintenance write
resolves the exact product-scoped option, rejects newer, conflicting,
unavailable, unsupported, or currency-incompatible evidence before signing,
and publishes and receives an ACK for kind `30406` before kind `30402`.
Legacy inline shipping requires an explicit fulfillment upgrade because its
parsed projection does not round-trip through the canonical writer. Unsupported
shipping references also require an explicit change; retired event pickup
references are not interpreted as ordinary shipping.

The Products editor defaults existing listings to preservation. Drafts stay
bound to the original merchant and source product revision. Retired
`local_pickup` drafts show a clear error and keep their saved bytes rather than
being reinterpreted. Ordinary shipping, digital, stock, image, variation, and
current Event Market association drafts remain supported.

Each existing variation keeps its own fulfillment references. A common
fulfillment category does not prove that a child's references equal its
parent's. Existing canonical fixed shipping keeps its targeted save-time
verification. An unchanged existing free listing may remain free; assigning a
new zero price is rejected. Changes that affect preserved shipping extra-cost
currency require explicit fulfillment changes.

## Stock updates from Orders

A stock update uses the owned listing in the current local product view and
validates its identity, quantity, and stock values. Calculated adjustments
rebase on that listing; custom targets remain explicit. Existing applied-decision
and pending-delivery checks prevent duplicate application. Signed delivery
retries reuse the same event.

A stock update does not authorize payment, receipt sharing, organizer handoff,
or order completion. Current Event Market checkout and handoff continue to
validate the signed roster, merchant grant, selected date, and product evidence
independently.

## Validation boundary

Focused tests exercise ordinary product and order stock updates through signing,
current Event Market association retention, exact reference and visibility
preservation, existing free prices, currency extra costs, and separate variation
fulfillment. Negative cases stop retired pickup references before signer or
relay side effects. Fixed-shipping cases cover newer option revisions, currency
changes, saturated reads, legacy inline terms, and the required shipping ACK
before product publication.

These are controlled local tests. External signer behavior and public-relay
convergence remain separate runtime validation concerns.

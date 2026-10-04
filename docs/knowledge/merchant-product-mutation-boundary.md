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

## Local write coordination and recovery

New Products and Orders writes commit their exact signed listing/deletion
intent, local revision frontier, projected product state, delivery jobs and any
stock checkpoint together in IndexedDB. Signing and relay waits stay outside
the cross-tab coordinate lock. The commit rechecks the captured revisions after
those waits; family edits also check unchanged siblings. A missing Web Locks
implementation stops the write rather than silently dropping serialization.

The delivery journal records relay outcomes separately from current listing
authority. A valid newer local edit may supersede an older listing's replay
authority without waiting for every historical relay to acknowledge it. The
older signed bytes and delivery observations remain intact. Replay eligibility
is per event, so superseding one product does not cancel unrelated siblings in
the same delivery job. Known newer external revisions and deletion evidence
also stop stale retries. A late acknowledgment cannot restore a superseded
cache row, including after that row was pruned. Its relay remains a historical
source hint for a later matching deletion, not owner-selected relay authority.

Stock decisions and shipping/deletion dependencies retain their own exact
recovery boundaries. Retrying a stock delivery does not subtract stock again.
An explicitly rejected legacy listing can be republished from its current
failed tip using the current relay plan; this is distinct from retrying the
original signed event. A staged intent can be retired as unpublished only when
the local evidence establishes that it has not been sent. Local coordination
does not establish global relay convergence.

Supplier allocation edits use the same write boundary. Explicitly changing
family-wide terms requires a complete current family baseline; unchanged terms
remain attached to each product's exact revision. Signed public allocation
declarations do not enable public zap execution or change historical orders.

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

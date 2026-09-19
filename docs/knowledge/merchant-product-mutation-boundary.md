# Merchant product maintenance and fulfillment authority

An existing merchant-owned listing with product-local fulfillment can be edited
without resolving the organizer calendar, collection, accepted products, or
pickup availability again. Preserving the merchant's references is not proof
that the organizer currently accepts the product or that a buyer can check out.
Canonical fixed shipping uses a narrower save-time verification path described
below.

## Two explicit publication paths

Merchant's product publication boundary distinguishes:

- `preserve_existing`: bind the baseline and candidate to the same merchant,
  product coordinate, and `d` tag. Keep the existing format, visibility,
  collection references, shipping references and extra costs, shipping metadata,
  and resolution flags. Publish only changed listings. Coordinate-after-order
  shapes that do not directly name a pickup require no organizer, catalog, or
  pickup read. A direct event-pickup reference requires one exact, positive,
  deletion-aware kind `30406` read before the replacement kind `30402` is
  signed. The latest live revision must satisfy the event-pickup contract,
  including a public location or geohash and no proposal-only destination
  predicates. A successful pickup or deletion response that reaches its
  bounded filter limit is incomplete evidence and stops before signing. This
  does not require the broader organizer graph to be rediscovered.
- Existing fulfillment authoring intents: establish or change fulfillment using
  their current validation and publication rules. New product and variation
  coordinates cannot use an existing product's preservation authority.

Canonical fixed shipping is a separate signed kind `30406`, so it cannot use
the product-only preservation path. A maintenance write resolves the exact
product-scoped option, rejects newer, conflicting, unavailable, unsupported, or
currency-incompatible evidence before signing, and then uses the canonical
writer: publish and ACK kind `30406` before kind `30402`. Legacy inline shipping
requires an explicit fulfillment upgrade because its parsed projections do not
round-trip through the canonical product writer.

The Products editor defaults existing listings to preservation. Choosing
**Change fulfillment** opens the authoring path. Drafts remain bound to the
original merchant and source product revision. Event detail reads may provide
context, but their loading or failure state does not authorize maintenance.

Each existing variation keeps its own fulfillment references. A common broad
fulfillment category does not establish that a child's references equal its
parent's. Coordinate-after-order references do not require rediscovery when
left unchanged. Direct event-pickup and fixed-shipping references each retain
their targeted save-time evidence check.

An existing valid free listing may remain free while stock or other fields are
edited. Setting a new zero price requires the existing local-pickup authoring
validation. Currency changes that affect preserved shipping extra costs require
explicit fulfillment changes rather than silently reinterpreting those costs.

## Stock updates from Orders

A stock update uses the owned listing in the current local product view and
validates its identity, quantity, and stock values. Calculated adjustments rebase
on that listing; custom targets remain explicit. Existing applied-decision and
pending-delivery checks prevent duplicate application. Signed delivery retries
reuse the same event.

Order pickup authorization is still required for order actions that depend on
it. A stock update does not authorize payment, receipt sharing, organizer handoff,
or order completion. Checkout continues to validate current product terms,
organizer acceptance, and required pickup evidence independently.

## Validation boundary

Regression tests cover the product-family planner through signed publication,
with organizer reads rejected or left pending while exact pickup evidence stays
available; Products editor stock saves before, at, during, and after event time
boundaries; exact reference and visibility preservation; existing free products;
separate variation associations; and strict validation after explicit
fulfillment changes. Negative cases prove unresolved, deleted, or unavailable
direct pickup evidence stops the replacement before signing. Orders tests
exercise stock preparation through signing while retaining order authorization
coverage.
Fixed-shipping counterexamples cover a newer unseen option revision, a
cross-unit currency change, and legacy inline terms, while a positive case
proves the canonical option is ACKed before the maintained product is published.

These are controlled local tests. External signer behavior and public-relay
convergence remain separate runtime validation concerns.

# Proposed Open Markets Event-Commerce Clarifications

**Status:** upstream-ready proposal; not yet normative

This note prepares a narrow backwards-compatible proposal for the Open Markets
specification. It connects existing NIP-52 calendar events to existing product
collections and pickup options. It adds no event kind and no application-owned
registry or tag.

## Proposed normative changes

### Event-backed collections

A kind `30405` product collection MAY contain one `a` tag whose coordinate kind
is NIP-52 `31922` or `31923`. This declares that the collection organizes
commerce for that calendar event. Because `a` is relay-indexable and the kind
is part of the coordinate, clients can distinguish the calendar link from
kind-`30402` product membership.

### Empty upcoming collections

Product `a` references in a kind `30405` collection are zero-or-more. A creator
MAY publish an upcoming event collection before accepting any products.

### Two-sided membership

A product's `a` reference to a collection is a discoverability claim or
inclusion request. It does not grant membership. For a collection author, the
authoritative membership list is the set of exact kind-`30402` coordinates in
the current valid collection revision.

A client MAY describe a product as accepted only when the product references
the collection and the collection references the product. A one-sided product
reference MUST NOT be presented as organizer approval.

### Organizer provenance

When a collection and its linked NIP-52 calendar event have the same author,
clients MAY describe the collection as organizer-authored. A different author
is third-party curation unless another explicit trust mechanism establishes a
relationship. Cryptographic authorship alone does not establish reputation.

An event collection MAY advertise an organizer-authored kind-`30406` pickup
option as a standing offer for organizer handoff. It may also omit that option
while participating products select merchant-authored pickup records for their
own booths. Clients MUST preserve every author coordinate and MUST NOT infer a
handoff party merely from collection membership.

### Pickup-option inheritance

A participating product MAY select the fixed pickup option either by referring
directly to the exact kind-`30406` coordinate or by using the event collection
as its `shipping_option` reference. In the collection-reference form, clients
MUST resolve the current collection revision and use only its exact
`shipping_option` coordinate; ordinary collection membership alone does not
grant or imply a fulfillment option.

Clients MUST NOT treat an unrelated kind-`30406` reference as event pickup.
The product, collection, and resolved pickup authors and coordinates remain
distinct identities throughout checkout and order handling.

When the selected pickup author is the product merchant, clients MAY present
merchant-operated booth pickup. When it is the event organizer and the current
collection advertises that exact option, clients MAY present organizer-operated
handoff. A third-party option needs another explicit trust/authorization
contract and MUST NOT silently receive either role.

### Pickup checkout

An order selecting a kind-`30406` option whose service is `pickup` carries the
selected `shipping` coordinate. It does not require a buyer delivery-address
tag or carrier/tracking flow. Private contact is workflow-dependent and MUST NOT
be inferred as a public pickup requirement. The pickup option MUST contain a
public `location` and/or `g` as already required by the shipping-option
contract.

### Complete example

Organizer `O` publishes:

```text
31923:O:event-2026
  ["d", "event-2026"]
  ["title", "Community Market"]
  ["start", "1786208400"]
  ["end", "1786230000"]
  ["D", "20673"]
  ["start_tzid", "America/New_York"]
  ["location", "Public Hall, Main Entrance"]

30406:O:event-2026-pickup
  ["d", "event-2026-pickup"]
  ["title", "Event pickup"]
  ["price", "0", "SAT"]
  ["country", "US"]
  ["service", "pickup"]
  ["location", "Public Hall, Main Entrance"]

30405:O:event-2026-market
  ["d", "event-2026-market"]
  ["title", "Community Market"]
  ["a", "31923:O:event-2026"]
  ["shipping_option", "30406:O:event-2026-pickup"]
```

Merchant `M` requests inclusion:

```text
30402:M:product-1
  ["a", "30405:O:event-2026-market"]
  ["shipping_option", "30406:O:event-2026-pickup"]
```

The request is pending because the collection is empty. Organizer `O` accepts
it by replacing the collection with the same `d` tag plus:

```text
["a", "30402:M:product-1"]
```

Clients now have two-sided evidence of participation. Removing that product
coordinate from a newer organizer collection revision removes official
membership without changing the merchant's product event.

A merchant-operated booth uses the same event and membership records, but the
product directly selects a merchant-authored pickup instead:

```text
30406:M:booth-pickup
  ["d", "booth-pickup"]
  ["title", "Merchant booth pickup"]
  ["price", "0", "SAT"]
  ["country", "US"]
  ["service", "pickup"]
  ["location", "Public Hall, Booth 12"]

30402:M:product-1
  ["a", "30405:O:event-2026-market"]
  ["shipping_option", "30406:M:booth-pickup"]
```

The collection's acceptance of the product does not make the organizer the
merchant, payment recipient, or private-order recipient. Any encrypted
fulfillment-receipt delegation remains an application/private-commerce concern
outside these public collection clarifications.

## Compatibility

Existing clients that ignore the NIP-52 `a` coordinate can continue reading
the collection's products and shipping option. Existing calendar and pickup
events remain independently valid. Implementations should read safe additional
references permissively and emit this relationship conservatively while the
proposal is under review.

This proposal is independent of experimental shipped-destination schemas. A
fixed pickup location is not a buyer-address eligibility predicate.

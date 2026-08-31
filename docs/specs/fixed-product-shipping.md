# Fixed Product Shipping

This contract defines Conduit's launch support for fixed physical-product
shipping using GammaMarkets kind `30406`.

Canonical public sources:

- GammaMarkets product listing kind `30402`
- GammaMarkets shipping option kind `30406`
- NIP-01 relay `OK` acceptance acknowledgements

Kind `30406` is Gamma market-spec behavior, not a Conduit extension.

## Fulfillment intent

Shared product fulfillment intent has exactly three launch states:

- `digital`: shipping is not required
- `coordinate_after_order`: the buyer sends an order before shipping and
  payment are agreed
- `fixed_standard`: one or more product-scoped standard options each have a
  known price, currency, and destination policy

Merchant's "use preset destinations" and "custom destinations" controls are
authoring inputs only. Destinations with the same amount and currency compile
into one rate group; different rates compile into separate options. Given the
same complete destination and rate configuration, presets and custom
destinations compile to the same `fixed_standard` intent and public event
shape. Custom destinations do not depend on a merchant preset.

Production and staging authoring remain country-level. Detailed subdivision or
postal constraints use the versioned `destination_schema=1` grammar and are
enabled only in the preview deployment profile. Elsewhere, Merchant must
remove those constraints or use `coordinate_after_order`.

## Canonical fixed writer

For a fixed physical product with product `d` tag `<product-d>`, Merchant
prepares one product-scoped kind `30406` per canonical destination-policy and
rate group. A single country-level group that uses the product fallback amount
keeps the legacy-compatible `d` tag `<product-d>-shipping-standard`. Other
groups use a deterministic `d` tag whose suffix is derived from the canonical
destination policy:

```text
<product-d>-shipping-standard-<policy-hash>
```

Each event contains:

```text
["d", "<shipping-option-d>"]
["title", "Standard Shipping"]
["price", "<actual amount>", "<actual currency>"]
["country", "<ISO 3166-1 alpha-2>", "..."]
["service", "standard"]
```

Preview-only detailed policies additionally contain
`["destination_schema", "1"]` and typed `destination` tags. Fixed shipping
does not contain carrier, pickup, package, duration, live-rate, or
calculated-price fields in this launch slice.

Merchant signs the shipping options and product, publishes every kind `30406`
sequentially, and waits for at least one positive NIP-01 relay `OK`
acknowledgement for each option. Merchant durably retains each acknowledged
signed option and its acknowledgement relay provenance before publishing the
referencing kind `30402`.

The product event contains one exact two-field tag per option:

```text
["shipping_option", "30406:<merchant-pubkey>:<shipping-option-d>"]
```

New product writes do not emit:

- Conduit `shipping_cost`, `shipping_country`, `shipping_restrict`, or
  `shipping_exclude` tags
- Gamma's optional product-level shipping extra-cost value

Failure to acknowledge or retain any fixed option stops the product write. If
all options are acknowledged but product delivery fails, retry may deliver the
already-signed product event without creating another option identity.

### Canonical withdrawal

A canonical withdrawal of a product-scoped shipping option is a same-author
NIP-09 kind `5` event containing:

```text
["a", "30406:<merchant-pubkey>:<shipping-option-d>"]
["k", "30406"]
```

The withdrawal may additionally carry `["e", "<shipping-event-id>"]`, but the
address tag is mandatory. An exact-id-only tombstone is not a canonical
shipping withdrawal: once a relay suppresses the targeted replaceable event, a
bounded reader cannot recover its coordinate and cannot prove that an older
event returned for that coordinate remains active. Address provenance lets
Market keep the coordinate withdrawn even when the latest `30406` itself is no
longer visible.

An edit, removed variation, or full product-family deletion must withdraw every
obsolete exact shipping-option coordinate. Merchant freezes the acknowledged
option relays, observed source relays, and current write relays into the durable
deletion outbox before delivery so a later reload or relay-list change cannot
narrow the withdrawal plan.

## Resolution and prepared state

Market resolves only the exact coordinate referenced by each product. It does
not substitute other options from the same merchant.

The launch resolver accepts fixed shipping only when:

- the coordinate is a kind `30406` address
- the option is authored by the product merchant
- the latest coordinate is unambiguous
- all Gamma-required fields are present and well formed
- service is `standard`
- price currency matches the product currency
- at least one valid country destination exists
- no unsupported launch fields are present
- the option is not newer than the product listing that references it

The final rule is the launch revision-staleness guard. A newer replaceable
option can no longer be proven to be the option acknowledged by the older
product listing. It therefore fails closed until Merchant republishes the
product through the canonical writer.

Missing, malformed, conflicting, unresolved, unsupported, or revision-stale
fixed shipping disables direct payment and uses the order-first path.

Checkout produces one prepared fulfillment snapshot per item. Pricing,
destination eligibility, order construction, and lifecycle persistence consume
that same snapshot. Cart may remain neutral until the exact option is resolved.

## Compatibility and orders

Legacy Conduit inline shipping tags remain a read-only parsing input. They must
not make a listing eligible for direct payment and must never flow back into the
canonical writer. Republishing a merchant-owned legacy listing upgrades it to
the product-scoped kind `30406` representation.

Orders snapshot the selected fixed shipping coordinate, agreed per-item cost,
and country destinations used for checkout reconciliation. Digital and
coordinate-after-order items have no selected fixed shipping coordinate or
agreed fixed cost.

## Deferred Gamma gaps

This launch slice does not define:

- postal-prefix constraints outside the preview-only versioned grammar
- multiple buyer-selectable service methods
- carriers or live rates
- package aggregation or per-order pricing
- collections or third-party option providers
- product-level extra cost
- durable revision identity or quote semantics beyond the launch staleness
  guard

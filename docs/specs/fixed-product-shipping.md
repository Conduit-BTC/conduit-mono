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
- `fixed_standard`: one or more product-scoped standard options define known
  flat prices, currencies, and non-overlapping country-level zones

Merchant's "use preset destinations" and "custom destinations" controls are
authoring inputs only. Countries with the same effective amount and currency
compile into one deterministic rate zone. A country-level rate takes precedence
over the optional product fallback amount; a country without its own rate uses
that fallback. Every destination must therefore have either a zone rate or a
product fallback before direct checkout can be published. Custom destinations
do not depend on a merchant preset.

Postal-prefix restrictions cannot be represented by this launch writer.
Merchant must remove those restrictions or use `coordinate_after_order`.

## Canonical fixed writer

For a fixed physical product with product `d` tag `<product-d>`, Merchant
prepares one product-scoped kind `30406` for each distinct rate zone. Its `d`
tag is `<product-d>-shipping-standard-<sorted-country-codes>`.

The event contains:

```text
["d", "<product-d>-shipping-standard-ca-us"]
["title", "Standard Shipping (CA, US)"]
["price", "<actual amount>", "<actual currency>"]
["country", "<ISO 3166-1 alpha-2>", "..."]
["service", "standard"]
```

The event does not contain carrier, region, pickup, postal-prefix, package,
duration, live-rate, or calculated-price fields in this launch slice.

Merchant signs the product and every option, publishes every kind `30406`
first, and waits for at least one positive NIP-01 relay `OK` acknowledgement
for each option. Only then may it publish the referencing kind `30402`.

The product event contains one exact two-field reference per zone:

```text
["shipping_option", "30406:<merchant-pubkey>:<product-d>-shipping-standard-us"]
["shipping_option", "30406:<merchant-pubkey>:<product-d>-shipping-standard-de-fr"]
```

New product writes do not emit:

- Conduit `shipping_cost`, `shipping_country`, `shipping_restrict`, or
  `shipping_exclude` tags
- Gamma's optional product-level shipping extra-cost value

Publishing any referenced option without an acknowledgement fails the product
write. If every option is acknowledged but the product delivery fails, retry
may deliver the already-signed product event without creating another option
identity.

### Canonical withdrawal

A canonical withdrawal of a product-scoped shipping option is a same-author
NIP-09 kind `5` event containing:

```text
["a", "30406:<merchant-pubkey>:<product-d>-shipping-standard-<sorted-country-codes>"]
["k", "30406"]
```

The withdrawal may additionally carry `["e", "<shipping-event-id>"]`, but the
address tag is mandatory. An exact-id-only tombstone is not a canonical
shipping withdrawal: once a relay suppresses the targeted replaceable event, a
bounded reader cannot recover its coordinate and cannot prove that an older
event returned for that coordinate remains active. Address provenance lets
Market keep the coordinate withdrawn even when the latest `30406` itself is no
longer visible.

## Resolution and prepared state

Market resolves only the exact coordinates referenced by each product. It does
not substitute other options from the same merchant. All referenced options
must resolve before direct payment is available.

The launch resolver accepts fixed shipping only when:

- every coordinate is a kind `30406` address
- every option is authored by the product merchant
- every latest coordinate is unambiguous
- all Gamma-required fields are present and well formed
- service is `standard`
- every price currency matches the product currency
- at least one valid country destination exists
- no unsupported launch fields are present
- no option is newer than the product listing that references it
- the buyer destination matches exactly one referenced option

The final rule is the launch revision-staleness guard. A newer replaceable
option can no longer be proven to be the option acknowledged by the older
product listing. It therefore fails closed until Merchant republishes the
product through the canonical writer.

Missing, malformed, conflicting, unresolved, unsupported, revision-stale,
uncovered, or overlapping fixed shipping disables direct payment and uses the
order-first path.

Checkout produces one prepared fulfillment snapshot per item. Pricing,
destination eligibility, order construction, and lifecycle persistence consume
that same snapshot. Cart may remain neutral until the exact option is resolved.

## Compatibility and orders

Legacy Conduit inline shipping tags remain a read-only parsing input. They are
shown as an explicit order-first fallback, must not make a listing eligible for
direct payment, and must never flow back into the canonical writer.
Republishing a merchant-owned legacy listing upgrades it to product-scoped kind
`30406` rate zones.

Orders snapshot the selected fixed shipping coordinate, agreed per-item cost,
and country destinations used for checkout reconciliation. Digital and
coordinate-after-order items have no selected fixed shipping coordinate or
agreed fixed cost.

## Deferred Gamma gaps

This launch slice does not define:

- postal-prefix constraints
- multiple selectable service methods for the same destination
- carriers or live rates
- package aggregation or per-order pricing
- collections or third-party option providers
- product-level extra cost
- durable revision identity or quote semantics beyond the launch staleness
  guard

# Reusable Merchant Shipping

**Status:** implementation contract; implementation may begin after merge

This contract defines the smallest public shipping model that lets a merchant
publish one standard shipping policy, lets many products reference it, and lets
Market calculate one shipping amount per compatible merchant fulfillment group.

It deliberately does not invent a new Nostr event kind or tag grammar. Public
writes use the current Open Markets product and shipping-option shapes. Conduit
adds deterministic local composition and a private result that checkout can
retain and authorize.

## Public sources

- [Open Markets specification](https://github.com/OpenMarketsFoundation/specification/blob/24313d75bb6ebf3ba37266a504980340308b4dc8/README.md),
  revision `24313d75bb6ebf3ba37266a504980340308b4dc8`
- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) for
  addressable event identity and replacement
- [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) for
  same-author deletion evidence
- `docs/specs/fixed-product-shipping.md` for the existing product-scoped
  compatibility path
- `docs/knowledge/decentralized-network-product-posture.md` for bounded relay
  reads and monotonic signed evidence

The Open Markets revision above already defines physical product facts,
repeated `shipping_option` references, and addressable kind `30406` shipping
options. It does not define a merchant default, multi-item price composition,
automatic package splitting, or a private quote identity. Those are the local
decisions locked below.

## Outcome and boundaries

For the first reusable-policy implementation:

- Merchant publishes one same-author kind `30406` at the stable coordinate
  `30406:<merchant-pubkey>:conduit-default`.
- Every physical product that wants reusable shipping explicitly references
  that coordinate.
- Market resolves the current exact product and profile revisions, combines
  them with the shopper's private destination and cart quantities, and applies
  the profile base price once per compatible merchant group.
- Digital products do not enter a shipping group.
- Missing, stale, partial, conflicting, malformed, unsupported, or
  cross-currency evidence never becomes free shipping. Checkout coordinates
  with the merchant instead.

This contract does not add a default-inheritance tag. Explicit product
references are required because Open Markets does not cascade collection or
merchant settings automatically.

## Public input contract

### Product listing

A reusable-shipping product is a valid signed kind `30402` authored by merchant
`M` with:

```text
["d", "<product-d>"]
["type", "<simple|variable|variation>", "physical"]
["price", "<amount>", "<currency>", "<optional-frequency>"]
["shipping_option", "30406:<M>:conduit-default"]
```

The minimum shipping facts carried by the product are:

| Fact             | Normalization                                                            | Invalid or conflicting behavior                                                                   |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Merchant         | Lowercase 64-character event author pubkey                               | Reject the event                                                                                  |
| Product identity | Full `30402:<merchant>:<d>` coordinate plus exact event ID               | `malformed_product`                                                                               |
| Physical format  | Exactly one effective `type` whose format is `physical`                  | Conflicting values are `malformed_product`; an omitted format follows Open Markets and is digital |
| Product currency | Trimmed, uppercase currency identity                                     | Empty or malformed is `currency_unresolved`                                                       |
| Policy selection | Exactly one direct, same-author `30406` coordinate with no third element | Any other shape is `unsupported_policy`                                                           |

Cart quantity is not a public product fact. It is a positive safe integer from
the private cart/order input and is frozen in the result.

Open Markets also permits product `weight` and `dim` tags. A reader may parse
and retain valid values, but this base-price contract does not consume them.
Profiles that require weight, dimensions, volume, distance, or package
aggregation are `unsupported_policy`, so a missing or malformed optional
measurement cannot silently change a reusable base price.

The direct-calculation lane does not accept:

- a product `shipping_option` third-element extra cost;
- a kind `30405` collection as a shipping option;
- multiple or repeated shipping-option tags;
- a third-party `30406` author;
- a recurring product-price frequency;
- a pickup option or event-market fulfillment reference; or
- legacy inline `shipping_cost`, `shipping_country`, `shipping_restrict`, or
  `shipping_exclude` as reusable-policy authority.

These forms remain parseable where existing compatibility contracts allow, but
they do not enter this calculation.

### Merchant shipping profile

The profile is a valid signed addressable kind `30406` authored by the same
merchant:

```text
["d", "conduit-default"]
["title", "Standard Shipping"]
["price", "<base-amount>", "<currency>"]
["country", "<ISO-3166-1-alpha-2>", "..."]
["service", "standard"]
```

The profile may have human-readable `content` and one valid Conduit `client`
tag. Direct calculation otherwise accepts only the five semantic tags above.
Repeated `country` tags are flattened, uppercased, deduplicated, and sorted.
At least one country is required.

The following current Open Markets fields are valid protocol data but outside
the initial direct-calculation grammar:

- `region`, `location`, `g`, `carrier`, and `duration`;
- `weight-min`, `weight-max`, `dim-min`, and `dim-max`; and
- `price-weight`, `price-volume`, and `price-distance`.

Their presence produces `unsupported_policy`, not an approximate amount. Local
pickup and event pickup remain governed by `docs/specs/event-markets.md`.

### Source ownership

| Contract element                                                                           | Authority                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Product kind, physical format, currency, and direct `shipping_option` reference            | Existing Open Markets public signed evidence                                   |
| Profile kind, coordinate, title, base price, currency, countries, and service              | Existing Open Markets public signed evidence                                   |
| `conduit-default` stable `d` value                                                         | Conduit authoring convention inside the existing Open Markets coordinate shape |
| Exact event IDs, replacement frontier, and deletion evidence                               | Existing NIP-01/NIP-09 signed evidence plus bounded local observations         |
| Private destination, quantities, grouping, exact-once base calculation, state, and plan ID | Private Conduit application/order evidence                                     |

This contract proposes no new public kind or tag. Every valid Open Markets form
outside the calculation subset remains protocol-valid and resolves as
unsupported rather than being reinterpreted.

### Stable coordinate, revisions, and deletion

`conduit-default` is the single reusable standard-policy coordinate for the
merchant. Publishing a new event at the same coordinate revises the policy for
all products that reference it; products do not need republishing merely
because the profile changed.

Readers retain both:

- the stable coordinate; and
- the exact signed event ID selected for a calculation.

The current revision is the valid event with the greatest `created_at` at that
coordinate. Distinct valid event IDs tied at the greatest timestamp are
`conflicting`. A valid same-author NIP-09 deletion targeting the coordinate or
selected event is authoritative according to NIP-09 and the repository's
durable deletion-evidence rules.

A bounded relay lookup cannot prove global absence. A complete bounded lookup,
a partial lookup, and an unavailable lookup remain distinct. Previously valid
profile evidence may still be displayed as a last-known estimate after a
partial read, but it cannot authorize direct payment as current evidence.

## Private input contract

Market combines the public signed inputs with only these private calculation
inputs:

```typescript
interface ReusableShippingPrivateInputV1 {
  destinationCountry: string
  lines: Array<{
    productCoordinate: string
    productEventId: string
    quantity: number
  }>
}
```

`destinationCountry` is trimmed and uppercased and must be exactly two ASCII
letters. `quantity` must be a positive safe integer. The street address,
postal code, contact details, cart contents, and calculation result never enter
a public product or profile event.

## Money normalization

Currency identity is trimmed and uppercased. `SAT` and `SATS` normalize to
`SATS`; `MSAT` and `MSATS` normalize to `MSATS`; `BTC` and `XBT` normalize to
`BTC`. Other currencies must be three ASCII letters.

Public amounts must be non-negative plain decimal strings: no sign, exponent,
separator, whitespace, `NaN`, or infinity. Implementations use decimal or
integer arithmetic, never binary floating-point arithmetic, for contract
calculation.

Canonical output removes unnecessary leading integer zeroes and trailing
fractional zeroes. `SATS` and `MSATS` require integral amounts. Every other
currency permits at most eight fractional digits in this source-amount
contract. Excess precision is rejected rather than rounded; a downstream
payment quote may apply a stricter currency rule when it freezes a conversion.

The product and profile currencies must normalize to the same identity.
Reusable shipping performs no currency conversion. A cart with more than one
output currency is `currency_unresolved` for direct payment until a separate,
exact conversion quote is accepted and frozen.

## Resolution states

Every retained merchant shipping evaluation group resolves to exactly one
state:

| State                     | Meaning                                                                                                               | Amount present                | Direct-payment shipping gate |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------- |
| `priced`                  | Current complete evidence yields a supported destination and positive base price                                      | Yes                           | Eligible                     |
| `included_free`           | Current complete evidence explicitly yields base price zero                                                           | Yes, exactly `0`              | Eligible                     |
| `unsupported_destination` | The private country is not in the profile                                                                             | No                            | Coordinate with merchant     |
| `missing_evidence`        | The bounded plan completed and did not find a required product or profile revision                                    | No                            | Coordinate with merchant     |
| `lookup_partial`          | Some planned sources failed, timed out, or did not complete                                                           | No authoritative amount       | Coordinate with merchant     |
| `lookup_unavailable`      | No planned source completed                                                                                           | No                            | Coordinate with merchant     |
| `stale_revision`          | A stored plan names a product/profile revision that is no longer the selected current revision                        | Stored historical amount only | Recalculate and reauthorize  |
| `conflicting`             | Valid current evidence disagrees, has a tied replacement frontier, or combines digital format with shipping authority | No                            | Coordinate with merchant     |
| `malformed_product`       | Required product facts cannot be normalized safely                                                                    | No                            | Coordinate with merchant     |
| `malformed_profile`       | Required profile facts cannot be normalized safely                                                                    | No                            | Coordinate with merchant     |
| `malformed_input`         | Destination country or cart quantity is invalid                                                                       | No                            | Correct private input        |
| `unsupported_policy`      | Valid tags require semantics outside this v1 grammar                                                                  | No                            | Coordinate with merchant     |
| `currency_unresolved`     | Currency identity, precision, equality, or conversion is unresolved                                                   | No                            | Coordinate with merchant     |
| `incompatible_items`      | One merchant's physical lines do not select the same compatible profile                                               | No                            | Coordinate with merchant     |

`not_required` is a cart-line classification for valid digital items, not a
physical-group result. An explicit zero-price profile is the only reusable
shipping state that means free.

## Grouping and calculation

The calculation is deterministic and ordered:

1. Validate signatures and normalize every exact product revision.
2. Exclude valid digital lines that carry no shipping authority. A line whose
   effective format is digital and carries any shipping reference remains in
   its merchant's evaluation group, makes that group `conflicting`, and never
   produces an amount.
3. Resolve each physical line's one explicit same-author profile coordinate.
4. Resolve the current exact profile revision and its deletion evidence using
   the bounded read plan.
5. Group physical lines by merchant only when every line selects the same
   profile coordinate, exact profile event ID, `standard` service, and
   normalized currency.
6. Sort group lines by product coordinate, then exact product event ID.
7. Match the private destination country against the profile country set.
8. Apply the profile base amount exactly once to the whole compatible group,
   regardless of line count or quantity.

Different merchants always produce different groups. If one merchant's lines
select different policies, revisions, services, or currencies, v1 returns
`incompatible_items`; it does not guess a package split or add multiple base
charges.

For example, two products from merchant `M`, both referencing exact profile
revision `R` with a base price of `500 SATS`, produce one `500 SATS` shipping
amount whether the quantities are `1 + 1` or `2 + 3`.

## Frozen private result

Checkout, authorization, and encrypted order construction consume the same
immutable result:

```typescript
interface ReusableShippingPlanV1 {
  calculationVersion: "conduit-reusable-shipping-v1"
  planId: string
  destinationCountry: string
  groups: Array<{
    merchantPubkey: string
    status: ReusableShippingResolutionState
    lines: Array<{
      productCoordinate: string
      productEventId: string
      quantity: number
    }>
    profileCoordinate: string | null
    profileEventId: string | null
    service: "standard" | null
    currency: string | null
    amount: string | null
  }>
}
```

Groups are sorted by merchant pubkey. A conflicting digital line is retained in
the affected merchant group so its exact product revision and failed state are
frozen rather than disappearing from the authorization input. When it is the
only line for that merchant, the profile coordinate, profile event ID, service,
currency, and amount are `null`. When physical lines also exist, otherwise
resolved profile fields may remain, but the group amount is `null`.

After individual group resolution, if two or more otherwise eligible groups
have distinct normalized output currencies, each `priced` or `included_free`
group becomes `currency_unresolved` and its amount is set to `null`. Its known
currency remains in the group for diagnosis and coordination. Groups that were
already in a more specific non-payment state retain that state. This is the
frozen representation of a cart-wide currency conflict; there is no separate
implicit cart status.

The `planId` is `sha256:` plus the lowercase hexadecimal SHA-256 of the
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON form of the
object without `planId`. Event IDs bind the plan to exact signed public inputs;
the signed events and relevant deletion evidence remain available to recovery
code.

The destination country and entire result are private. They may be stored
locally and included inside the encrypted buyer/merchant order evidence, but
must not be logged, emitted through telemetry, or published as public Nostr
events.

No wall-clock TTL is invented here. Direct-payment authorization must refresh
the bounded evidence immediately before payment. If it observes a different
current product/profile event ID or dominating deletion, the stored plan
becomes `stale_revision` and the buyer must accept a newly calculated plan.
A later durable quote contract owns expiration and payment-attempt freezing.

## Checkout behavior

Direct payment may proceed on the shipping dimension only when every retained
shipping evaluation group is `priced` or `included_free` and the plan still
names the current exact revisions. Address validity, stock, product price,
recipient, and payment-method checks remain separate gates.

Any other shipping state leaves order-first merchant coordination available.
The UI may show a last-known estimate with truthful stale/partial labeling, but
must not convert it into an authorized amount.

## Bounded compatibility

The completed fixed-product contract remains supported during migration:

- A product-scoped coordinate ending in `<product-d>-shipping-standard` is
  resolved according to `docs/specs/fixed-product-shipping.md`.
- Its amount remains an agreed per-item cost and therefore follows that
  contract's quantity behavior.
- It is not grouped as a reusable merchant base price.
- Legacy inline Conduit tags remain read-only, order-first compatibility and
  are never reusable-policy authority.
- A merchant cart mixing reusable and product-scoped shipping coordinates is
  `incompatible_items` for direct payment.

New reusable-policy authoring must not create one kind `30406` per product.
Republishing through the future reusable writer migrates a merchant-owned
product by replacing its shipping reference with
`30406:<merchant>:conduit-default`; it does not mutate an external merchant's
listing.

## Deterministic fixtures

Unless overridden, fixtures use:

- merchant `M1`, profile coordinate `A`, exact profile revision `A1`,
  `standard`, countries `US`, and base `500 SATS`;
- physical products `P1` and `P2` authored by `M1`, both explicitly referencing
  `A` with no extra cost;
- digital product `D1` authored by `M1` with no shipping reference; and
- physical product `P3` authored by merchant `M2`, whose profile revision `B1`
  covers `US` with base `700 SATS`.

| ID           | Inputs                                                                        | Required result                                                                                            |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `RSP-FX-01`  | `P1` quantity 1, destination `US`, current `A1`                               | One `M1` group, `priced`, `500 SATS`                                                                       |
| `RSP-FX-02`  | `P1` quantity 3, destination `US`, current `A1`                               | One `M1` group, base still applied once, `500 SATS`                                                        |
| `RSP-FX-03`  | `P1` quantity 1 plus `P2` quantity 2, destination `US`, current `A1`          | One compatible `M1` group, `500 SATS`                                                                      |
| `RSP-FX-04`  | `D1` plus `P1`, destination `US`                                              | `D1` excluded; one physical group, `500 SATS`                                                              |
| `RSP-FX-04A` | Digital `D1` carries a shipping reference, with or without `P1`               | One retained `M1` evaluation group, `conflicting`, amount `null`; exact `D1` revision remains in its lines |
| `RSP-FX-05`  | `M1/P1` plus `M2/P3`, destination `US`, current `A1` and `B1`                 | Two groups, `500 SATS` and `700 SATS`; payment fanout remains separate                                     |
| `RSP-FX-06`  | Current profile is valid and explicitly has base `0 SATS`                     | `included_free`, amount exactly `0`                                                                        |
| `RSP-FX-07`  | `P1`, destination `CA`, current `A1` covers only `US`                         | `unsupported_destination`, no amount                                                                       |
| `RSP-FX-08`  | Complete bounded read finds `P1` but no `A`                                   | `missing_evidence`, no amount                                                                              |
| `RSP-FX-09`  | Stored valid `A1`; refresh completes only part of the read plan               | `lookup_partial`; `A1` may be displayed only as a last-known estimate                                      |
| `RSP-FX-10`  | Stored plan names `A1`; complete refresh selects newer `A2`                   | `stale_revision`; old amount remains historical and direct payment requires reauthorization                |
| `RSP-FX-11`  | Two different valid profile IDs tie at the newest `created_at`                | `conflicting`, no amount                                                                                   |
| `RSP-FX-12`  | Product has an invalid physical type, invalid coordinate, or repeated option  | `malformed_product`, no amount                                                                             |
| `RSP-FX-13`  | Profile has malformed price/country/service or an invalid signature           | `malformed_profile` or `missing_evidence` according to whether malformed evidence was observed, never free |
| `RSP-FX-14`  | `P1` and `P2` select different profiles for `M1`                              | `incompatible_items`, no automatic split                                                                   |
| `RSP-FX-15`  | Profile currency differs from product currency                                | Affected group is `currency_unresolved`; currency and amount are `null`                                    |
| `RSP-FX-15A` | Two otherwise eligible merchant groups output different normalized currencies | Both groups become `currency_unresolved`; known group currencies remain and both amounts are `null`        |
| `RSP-FX-16`  | Destination is malformed or a line has a non-positive/non-integer quantity    | `malformed_input`, no amount                                                                               |
| `RSP-FX-17`  | Product uses the existing product-scoped fixed option                         | Bounded fixed-product compatibility result; not a reusable group                                           |

## Acceptance traceability

| Requirement        | Contract evidence                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHIP-CONTRACT-01` | Public product/profile shapes and `RSP-FX-03` contain two physical products plus one merchant profile                                           |
| `SHIP-CONTRACT-02` | Money normalization, ordered grouping, exact-once calculation, and frozen output are deterministic from signed inputs plus private country      |
| `SHIP-CONTRACT-03` | `RSP-FX-02` and `RSP-FX-03` prove quantity and multiple lines do not multiply the reusable base                                                 |
| `SHIP-CONTRACT-04` | `RSP-FX-04` through `RSP-FX-16` give distinct digital, merchant, free, destination, evidence, stale, conflict, malformed, and currency outcomes |
| `SHIP-CONTRACT-05` | `ReusableShippingPlanV1` binds exact product/profile event IDs, quantity, currency, amount, state, version, and deterministic plan ID           |
| `SHIP-CONTRACT-06` | Bounded compatibility and `RSP-FX-17` preserve fixed product shipping without making it the new authoring model                                 |
| `SHIP-CONTRACT-07` | Private input/result sections prohibit public destination or order data                                                                         |

## Deferred behavior

The following require a later accepted contract or an upstream clarification
before they can authorize direct payment:

- product extra-cost quantity semantics;
- multiple selectable carrier services or third-party providers;
- collection-provided shipping and precedence merging;
- regions, postal rules, weights, dimensions, volumes, distance rates, package
  optimization, and automatic shipment splitting;
- currency conversion and quote expiration; and
- live carrier rates, labels, tracking, or a hosted shipping backend.

Until then, valid but unsupported public evidence coordinates with the merchant
instead of being ignored or treated as zero.

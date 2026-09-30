# Merchant shipping tables

Market calculates shipping locally from merchant-signed destination and combined-weight tables. Each merchant has one reusable policy and one combined shipping charge per order. Physical products supply positive whole-gram weights. Custom domestic and international tables work without carrier presets or a hosted calculator.

## Public event shape and interoperability

Products remain NIP-99 plus the [Open Markets working specification](https://github.com/OpenMarketsFoundation/specification) for kind `30402`. They reference the merchant-owned addressable kind `30406` coordinate `30406:<merchant>:conduit-shipping-policy` through `shipping_option`. Product `weight` tags contain grams; optional `dim` tags contain three centimetre measurements. Merchant can enter grams, kilograms, pounds, or ounces. Entered weights round upward to whole grams; changing the display unit alone never changes signed gram values.

The policy keeps the standard `d`, `title`, `price`, `country`, and `service` tags and human-readable content. The explicit `conduit_shipping_table` tag carries version `2` and a JSON policy. Version 2 moves packing adjustments from the policy to individual products and supports independent product and policy currencies. Version 1 remains readable for retained orders; updating an old policy publishes version 2. The editor warns when old shared buffers need moving to products. This is a Conduit extension, not an upstream shipping-table standard. Its standard price tag summarizes the first band; it is insufficient evidence for a basket quote. The parser requires the standard summary tags to agree with the extension.

Conduit's earlier fixed-only reader rejects the unfamiliar extension and falls back to merchant coordination. Other clients must detect the extension before offering automatic shipping. Existing product-scoped fixed kind `30406` options continue to use their existing pricing and destination rules. Switching or deleting one product never withdraws a reusable policy used by other products.

Sharing a rate table across variations does not share measurements. Merchant preserves each existing variation's signed weight, dimensions, packing, and handling. Individual mode requires a positive weight for every physical variation using the table; optional dimensions must include all three measurements. Merchants can explicitly choose the same parent weight and dimensions for all physical variations, using the heaviest and largest variation for a conservative estimate. Packing and handling remain separate per variation. This choice is retained in local authoring state; publication still signs explicit measurements on each product. Digital variations publish without physical shipping terms.

## Calculation and eligibility

A compatible group shares merchant, policy coordinate, and exact policy event revision. The calculation is:

```
combined grams = sum((item grams + item packing grams) × quantity)
shipping = matching weight-band total + sum(item handling × quantity)
```

Per-product adjustments use the explicit `conduit_shipping_adjustments` version `1` product tag. It carries optional `weightAllowanceGrams` and `handling` source-price terms; handling uses the product currency. Unsupported or malformed adjustments require coordination. Free shipping waives the full combined charge, including handling. Upper band boundaries are inclusive. Destination matching uses the longest matching postal prefix, then subdivision specificity, then country. Country identifiers are uppercase; subdivision and postal matching removes spaces and hyphens. Duplicate normalized rules and non-increasing bands cannot be published.

Domestic and international free thresholds are separate. Eligibility and a matching band are required before a free threshold can apply. The threshold uses shipped merchandise subtotal, excluding shipping, tax, digital items, and pickup items. The current checkout has no signed discount source, so production quotes validate subtotal against signed product price times quantity. A future discount flow must supply verified discounted terms before changing this check.

Missing weight, unsupported destination, overweight baskets, malformed or withdrawn policies, conflicting revisions, missing signed evidence, and unavailable conversion rates require coordination. None implies a zero price. Dimensions only produce authoring warnings; they never introduce dimensional-weight pricing or package optimization.

Amounts use safe integer minor units and the existing currency precision. Shipping currency is a merchant choice; publication warns when it differs from the product currency. Market uses existing exchange-rate providers. It converts each quantity-aware merchandise subtotal and handling subtotal once to policy minor units, rounding nearest with halves upward, then converts the final group charge once to sats. Whole-sat line allocations sum exactly to that charge. Quotes retain the exact currency rates, timestamp, converted subtotals, handling amounts, and final sats; payment and recovery use the retained amounts. Missing rates never imply free shipping. Version 1 quotes retain their original same-currency calculation.

## Evidence, replacement and recovery

Reads distinguish relay coverage and retained signed evidence. Sufficient positive evidence can support a quote during partial reads. Stronger retained revisions and author-owned NIP-09 deletion evidence survive stale or empty relay results. Policy replacement requires a completed current relay read and an accepted revision, so an editing session cannot silently overwrite unseen changes. Replacement timestamps advance beyond the accepted revision or withdrawal.

Checkout refreshes product and policy terms before authorization. A changed revision, quantity, weight, packing adjustments, price, conversion rate, destination, or calculation requires another review. Authorized order terms remain frozen for payment and delivery retries.

The encrypted order stores the exact signed product and policy events, revision IDs, destination, quantities, weights, subtotal, selected rule and band, per-item packing and handling adjustments, conversion snapshot, free-shipping decision, resulting charge, and line allocations. Validation recomputes the source calculation and checks group membership and destination. The order retains these bytes after public addressable events are replaced or withdrawn, including restart and same-account order recovery.

The versioned Conduit order-payload field `shippingPolicyQuotes` stores each group snapshot once; item `shippingPolicyQuoteRef` indices refer to those groups. Recipient parsing expands these references before normal order validation. Legacy inline snapshots remain readable. Missing, conflicting, unsupported, or unused references are rejected. This extension requires a current Conduit reader. It reduces duplicated evidence within the existing encrypted transport; it does not add fragmentation or remove relay size limits.

Buyer destinations stay on the device until included in the existing encrypted order flow. They are excluded from query keys, public events, telemetry, logs, and remote quote requests. Table orders use private payment because the existing anonymous hosted authorization contract prices fixed per-item shipping. External signers, non-custodial payment, and the existing NIP-17/NIP-44 capability boundaries remain in place. Public NIP-44 remains v2. Existing v3 readiness planning remains visible; a future implementation requires public draft/client references and explicit signer and recipient capability detection.

## Validation boundary

Focused calculation, publication, withdrawal, partial-read, revision, schema, rounding, pre-authorization, and persistence tests exercise the shared helpers and composed checkout. Merchant browser journeys use actual ephemeral Nostr signatures and an isolated local relay to publish rates and two products with independent currencies, switch metric and imperial units, customize a state or postal area, author per-product packing adjustments, recover the policy in new browser storage, revise it, and withdraw it at mobile and desktop widths. Market browser coverage checks combined cart and encrypted-order totals.

Local browser and cryptographic evidence do not prove physical-device signer behavior, public-relay convergence, actual Lightning settlement, or shipping costs charged by a carrier. Those remain maintainer-owned validation before release.

Sources checked before implementation: [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md), [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md), [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md), and the Open Markets shipping-option and product sections. The current [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) transport was also checked during integration.

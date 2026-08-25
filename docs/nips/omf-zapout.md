# OMF Zapout Marker

This note documents the public marker Conduit adds to checkout zap requests.
Canonical zap request and receipt behavior comes from NIP-57.

## Marker

Conduit marks public checkout zap requests with one tag:

```json
["omf", "zapout"]
```

The marker means only that the payment is an OMF zapout. It does not carry
cart, order, fulfillment, shipping, buyer, merchant, invoice, or settlement
data.

## Emission

- The marker is emitted on signed kind `9734` zap requests for public checkout
  zaps.
- Private checkout invoices do not create a kind `9734` zap request and do not
  carry this marker.
- Public zap comments remain the only buyer-editable public text in the current
  zap flow.

## Shopper Notes And Product Targets

A shopper-signed custom zap for one unique product may target that product.
The signed kind `9734` request then uses NIP-57 plus a NIP-19 `naddr` for the
NIP-01 addressable-event coordinate (formerly specified by NIP-33):

- `content` is the normalized shopper note followed by a blank line and a
  deterministic `nostr:naddr1...` product reference.
- `a` contains the canonical `30402:<merchant-pubkey>:<d-tag>` coordinate.
- `k` contains `30402`.
- `p` remains the Lightning recipient and must match the product author.

The shopper note is limited to 280 Unicode code points independently of the
product reference; the complete composed request has a separate 1,024-code-point
safety bound. Conduit normalizes CRLF/CR to LF, converts tabs to spaces, trims
the note boundary, and preserves intentional internal spaces, line breaks, and
emoji. Neither the note nor the product reference is cut through a Unicode
surrogate pair.

Product targeting is opt-in through a non-empty edited shopper note. A blank
note keeps the existing empty request shape. Anonymous zaps, merchant-required
generic messages, multi-product carts, and private checkout do not add product
references or product target tags. This preserves the existing checkout privacy
boundary. Conduit does not log shopper note content or attach it to telemetry
events.

Legacy or external products without a representable `d`-tag coordinate keep
the public note and payment flow but omit the optional product reference.

## Receipt Detection

NIP-57 zap receipts are kind `9735` events. A receipt must include a
`description` tag containing the JSON-encoded kind `9734` zap request. Conduit
detects OMF zapouts by parsing that `description` value and looking for the
`["omf", "zapout"]` tag in the embedded request.

The outer kind `9735` `content` remains empty, as recommended by NIP-57. Clients
such as Amethyst and Primal surface the shopper note from the kind `9734`
request embedded in `description`. For a product-targeted receipt, consumers
must also require the receipt's top-level `a` tag to match the signed request's
canonical `a` tag before associating the product reference.

Because the marker is inside the embedded request, relays are not expected to
index it as a top-level receipt tag. Feed readers should fetch a bounded recent
set of kind `9735` receipts, then filter client-side.

## Public Data Boundary

Do not add structured checkout data as public zapout tags. Keep these out of
the public marker and any Conduit-added public checkout fields:

- cart contents or product list
- order ids
- shipping/contact details
- fulfillment instructions
- NWC URIs or wallet secrets
- user/session/device context

The one exception is the single canonical product coordinate and its `naddr`
representation when a signed-in shopper explicitly customizes a single-product
zap note. Conduit never adds a coordinate for another cart line, an order id,
or any fulfillment data.

Normal NIP-57 receipt fields such as `bolt11`, and optional `preimage` tags
when emitted by the wallet, remain NIP-57 behavior. Conduit should not add
extra public invoice, settlement, or wallet metadata for checkout.

Order and fulfillment details belong in the encrypted buyer-merchant channel.

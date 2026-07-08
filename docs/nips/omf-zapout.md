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

## Receipt Detection

NIP-57 zap receipts are kind `9735` events. A receipt must include a
`description` tag containing the JSON-encoded kind `9734` zap request. Conduit
detects OMF zapouts by parsing that `description` value and looking for the
`["omf", "zapout"]` tag in the embedded request.

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

Normal NIP-57 receipt fields such as `bolt11`, and optional `preimage` tags
when emitted by the wallet, remain NIP-57 behavior. Conduit should not add
extra public invoice, settlement, or wallet metadata for checkout.

Order and fulfillment details belong in the encrypted buyer-merchant channel.

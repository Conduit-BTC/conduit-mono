# Checkout with Conduit V1

An external marketplace can link a shopper to Market checkout for one signed
kind `30402` product or a one-merchant cart. The link is a purchase request,
not a reservation, price lock, payment instruction, or proof of referral. Market
reads current signed listings and the shopper reviews the ordinary checkout
before submitting an order.

## Link formats

```text
https://shop.conduit.market/checkout#buy=<product-naddr>
https://shop.conduit.market/checkout#buy=<product-naddr>&qty=2
https://shop.conduit.market/checkout#cart=<URLSearchParams-encoded-JSON>
```

The optional `partner=<assigned-code>` fragment parameter can be included on
either form. A code is a public, claimed business source. It does not authorize
payment, a payout, or a settlement split. Unknown or inactive codes are ignored
without blocking checkout. To receive attributed reports, the code must be
assigned and active in the bounded registry and optional browser telemetry must
be enabled on the official Market host. Counts describe measured Market opens
and outcomes, not all partner clicks or unique visitors.

The `buy` form defaults to quantity one. The `cart` value is JSON with this
shape, encoded by `URLSearchParams`:

```json
{ "v": 1, "items": [{ "product": "naddr1...", "quantity": 2 }] }
```

The following reference is a syntactically valid kind `30402` `naddr` with a
relay hint. It is a parser test vector, not a live purchasable listing:

```text
naddr1qvzqqqrkcgpzp242424242424242424242424242424242424242424242424242qq88xctdwpkx2ttswfhkgatrwsf4vpzy
```

Use an actual product `naddr` from a signed listing to test checkout. Include
one or two public `wss://` relays where that listing was observed. Hints extend
the bounded read; they do not change Network settings or checkout terms.

## Copy-paste link builder and basic validator

```js
function conduitCheckoutUrl(items, partner) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw new Error("Use one to twenty products")
  }
  if (
    items.some(
      ({ product, quantity }) =>
        !/^naddr1[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(product) ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
    )
  )
    throw new Error("Invalid product reference or quantity")
  if (items.reduce((sum, item) => sum + item.quantity, 0) > 100) {
    throw new Error("Too many units")
  }
  if (partner && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(partner)) {
    throw new Error("Invalid assigned partner code")
  }
  const url = new URL("https://shop.conduit.market/checkout")
  url.hash = new URLSearchParams({
    ...(items.length === 1 && items[0].quantity === 1
      ? { buy: items[0].product }
      : { cart: JSON.stringify({ v: 1, items }) }),
    ...(partner ? { partner } : {}),
  }).toString()
  return url.toString()
}
```

This checks basic input shape. Market also decodes each `naddr`, rejects
duplicate coordinates and mixed merchants, resolves current signed product and
stock evidence, and checks compatible fulfillment. It accepts 1–20 distinct
products, 1–99 units per line, at most 100 units total, up to 6 KiB of cart
JSON, and up to 8 KiB for the full fragment. Variable parents without a selected
variation and event pickup without event context cannot use V1 links.

If lookup is incomplete, Market keeps the existing cart and offers a retry. A
different existing purchase for the same merchant requires the shopper to pick
**Use linked items** or **Keep my cart**. Market imports all lines together and
never starts signing, order publication, invoice creation, or payment from the
link alone.

For example, `#buy=not-a-product` opens a link error and leaves the cart
untouched. A valid `naddr` whose signed listing cannot be confirmed on the
checked relays opens a retryable lookup message; it does not establish that the
product is absent everywhere. A sold-out signed listing opens an unavailable
product message without importing any line.

Protocol references: [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md),
[NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md), and the
[Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md).

# Checkout with Conduit V1

An external marketplace can link a shopper to Market checkout for one signed
kind `30402` product or a one-merchant cart. The link is a purchase request,
not a reservation, price lock, payment instruction, or proof of referral. Market
reads current signed listings and the shopper reviews the ordinary checkout
before submitting an order.

## Link formats

```text
https://shop.conduit.market/checkout#buy=<product-naddr>
https://shop.conduit.market/checkout#buy=<product-naddr>&qty=2&source=example.com
https://shop.conduit.market/checkout#cart=<URLSearchParams-encoded-JSON>&source=example.com
```

The optional `source=<domain>` parameter works with both forms. Developers can
integrate and receive domain-based source attribution before registering or
requesting approval. If `source` is absent, Market uses the browser's referring
domain when available. An explicit source is a **claim**; a browser referrer is
an **observation**. Neither verifies domain control or establishes payment
entitlement. An invalid explicit source is ignored without blocking checkout
and does not fall back to the referrer.

Domains are lowercased and internationalized names become ASCII IDNA names.
Only a domain is accepted: no URL, path, query, fragment, credentials, port,
IP address, or local/private host. Public suffix rules reduce subdomains to the
registrable domain, including private hosted-domain suffixes: for example,
`shop.project.github.io` becomes `project.github.io`. Attribution is bounded;
malformed values are ignored, and valid domains beyond telemetry bounds count
as `other`. Unknown domains remain measurable, subject to the privacy
and abuse limits in [the analytics contract](../analytics/events.md).

Existing `partner=<assigned-code>` links remain compatible. Active registered
codes may still be used without a domain. When a domain is present, only its
reviewed active mapping determines the partner; another `partner` claim cannot
override it. Unknown or inactive partner codes do not block checkout. Approval
is separate from integration and source measurement.

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
function conduitCheckoutUrl(items, { source, partner } = {}) {
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
  if (
    source !== undefined &&
    (typeof source !== "string" ||
      source.length > 512 ||
      /[\s:/?#@\\%\[\]]/u.test(source.trim()))
  ) {
    throw new Error("Source must be a domain or hostname")
  }
  const url = new URL("https://shop.conduit.market/checkout")
  url.hash = new URLSearchParams({
    ...(items.length === 1 && items[0].quantity === 1
      ? { buy: items[0].product }
      : { cart: JSON.stringify({ v: 1, items }) }),
    ...(source !== undefined ? { source } : {}),
    ...(partner ? { partner } : {}),
  }).toString()
  return url.toString()
}
```

For example, use `{ source: "example.com" }` for either buy or cart input; omit
it to allow browser-referrer fallback. The basic validator is not a PSL or
ownership check. Integrations importing `@conduit/core` can use the shared
builders and domain normalizer:

```js
import {
  buildMarketCheckoutBuyUrl,
  buildMarketCheckoutCartUrl,
} from "@conduit/core"
const buyUrl = buildMarketCheckoutBuyUrl(
  origin,
  productNaddr,
  1,
  undefined,
  "example.com"
)
const cartUrl = buildMarketCheckoutCartUrl(
  origin,
  items,
  undefined,
  "example.com"
)
```

Set `origin` to the candidate preview for testing, or to the official Market
origin after release. Existing positional `partner` arguments are unchanged.

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

## Request partner activation

Email **[partnerships@conduit.market](mailto:partnerships@conduit.market)** with:

- Project or business name.
- Domain and website.
- Integration URL or a brief description of your checkout integration.
- A business contact for follow-up.

You can integrate and receive source attribution before approval. Requests are
reviewed manually, domain control is verified, and a maintainer explicitly
activates the public domain-to-partner mapping. The reviewed registry contains
only public partner identifiers, domains, and activation state. Private
correspondence, contact details, verification evidence, and commercial terms
stay outside the public repository.

Approval does not itself establish a commission agreement or enable payouts.
Source attribution is not payout accounting, settled-sales accounting, or a
retroactive commission promise. Payment splits require separate future work.

## Attribution and testing limits

Attribution belongs to the imported purchase and its exact buyer-local order.
Keeping a conflicting existing cart, changing the purchase quantities, switching
accounts, or expiring the handoff clears the temporary source. Retrying a
matching purchase keeps the original expiry; attribution never changes checkout
authority or signed product, quantity, delivery, or payment checks. It is not
sent in public Nostr events or to the merchant as order content.

Reports describe **measured checkout arrivals and outcomes**. They are not
unique visitors, settled sales, or payout accounting. Optional telemetry,
Global Privacy Control, missing browser referrers, blockers, and abuse bounds
leave accepted measurement gaps. No full referrer URL, fragment, path, query,
visitor identifier, product reference, order content, or payment detail is
included in source reports.

Test the candidate on its PR preview using that preview's origin in place of
`https://shop.conduit.market` in the examples. Preview checkout behavior does
not prove production availability: the domain extension must be reviewed,
merged, and released first. Production source telemetry is restricted to the
official Market host and is deliberately disabled on previews and localhost.
Use local tests and the ingest-proxy sanitizer tests for privacy verification;
a preview does not produce an official-host attribution report.

## Implementation acceptance and evidence

| ID        | Criterion                                                                               | Automated coverage                                 | Remaining manual validation                              |
| --------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| SOURCE-01 | Unregistered buy/cart links preserve exact products and quantities                      | Source parser and Chromium handoff tests           | Candidate preview with public signed listings            |
| SOURCE-02 | Explicit claim wins; referrer fallback and missing/invalid sources never block checkout | Source parser, staging and Chromium scenarios      | Chrome/Safari referrer-policy differences                |
| SOURCE-03 | PSL, hosted-domain, IDNA, malformed URL/IP/local input and subdomain bounds             | Domain and telemetry tests                         | Review pinned suffix data on dependency updates          |
| SOURCE-04 | Legacy partner links and unique active domain mapping                                   | Registry and client/proxy tests                    | Maintainer domain-control verification before activation |
| SOURCE-05 | Exact purchase/session/quantity binding, conflict choice, retries and expiry            | Referral, order staging and Chromium handoff tests | External-signer account switches on preview              |
| SOURCE-06 | Capture then scrub then emit; no attribution identifiers or content through ingest      | Staging, client/proxy, policy and Chromium tests   | Official-host aggregate report after release             |
| SOURCE-07 | Optional telemetry, GPC, official-host restrictions and finite abuse bounds             | Client/proxy, policy and source-budget tests       | Deployment configuration review                          |
| SOURCE-08 | Public email request, manual verification and activation; no payout promises            | Developer guide contract test                      | Maintainer review and private follow-up                  |

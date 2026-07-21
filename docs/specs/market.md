# Market Specification

## Overview

Conduit Market is the buyer-facing marketplace for discovering products, evaluating merchant trust context, managing a cart, placing orders, sending payments, and tracking buyer-merchant communication over Nostr-native protocols.

This spec covers current Market scope.

## References

**Figma** remains the primary visual reference when implementing screens:

```text
File: "Conduit High Fi - Website" in Conduit Market Team
URL: https://www.figma.com/design/adfNXYE3nBqr35frkl0b5q
Page: "High Fi - WIP"
```

Use Figma MCP tools to extract design context for screen work. Do not rely on old local filesystem paths as public implementation references.

## Core Flows

### Product Discovery

1. Browse products on `/` and `/products`
2. Filter/search where available
3. View `/products/$productId`
4. View merchant context on `/store/$pubkey`
5. Add items to cart

#### Product tag normalization

Product `t` tags follow the NIP-24 lowercase hashtag requirement. Every product
ingress path uses the shared Core normalizer to trim values, lowercase them,
remove blanks, and deduplicate them in first-seen canonical order. This applies
equally to legacy JSON content and GammaMarkets/NIP-99 kind `30402` `t` tags.

Prepared product models, including projections read from an existing IndexedDB
cache, expose only canonical lowercase tags. Raw event values may remain
available only as raw/provenance data. Search, tag filters, facet counts, and
shopper-facing tag chips consume the canonical values directly without
display-only title casing, so legacy mixed-case variants resolve to one category
without requiring shoppers to clear local storage.

#### Discovery ordering

The default Market catalog is a network-discovery surface, not a strictly
chronological archive. Its opening results should demonstrate the breadth and
activity of the available merchant network. Shoppers who want to explore one
merchant in depth can use that merchant's storefront or the store filter.

##### Current release policy: Fresh & diverse

The shopper-facing `Fresh & diverse` order applies after catalog-source,
search, tag, and store filters determine the eligible catalog and before the
visible result slice is selected.

- A product is fresh when its signed event `created_at` is within the inclusive
  previous 60 days and is not future-dated.
- Merchant identity comes from the product event's signed `pubkey`, not a
  profile name or client-provided product metadata.
- The newest fresh product from every discovered eligible merchant is emitted
  before any eligible merchant receives a second product. Additional fresh
  products are emitted in subsequent merchant rounds.
- Older and future-dated products remain available after the fresh catalog
  rather than being discarded.
- Explicit price ordering remains literal and does not use this discovery
  policy.
- During progressive catalog discovery, the prepared order may improve as
  additional valid merchants and products are discovered.

This guarantee applies to the currently discovered, market-visible catalog. It
does not imply that every merchant on the wider Nostr network has already been
discovered.

##### Why this policy exists

Bulk publication by one merchant must not monopolize the Market's primary
discovery surface. The default order favors recent merchant representation
while preserving freshness within each merchant's inventory. It is intended to
make the active commerce network legible, not to grant a permanent position to
any product or merchant.

##### Policy evolution

`Fresh & diverse` is the policy for the current release, not a permanent or
universal ranking formula. Future discovery policies may vary by surface and
shopper intent and may use signals such as catalog freshness, followed
merchants, provenance, availability, graph confidence, or deliberate
exploration of underexposed inventory.

The durable implementation boundary is:

- A discovery policy consumes prepared, normalized catalog state plus explicit
  ordering context.
- A discovery policy does not fetch relays, parse protocol events, or mutate
  catalog storage.
- Merchant and product identity remain grounded in signed event provenance.
- Shopper-facing labels describe the ordering semantics actually in use.
- A policy is deterministic and independently testable for a fixed catalog
  snapshot and clock.

The current release does not require a general-purpose ranking engine or policy
registry. When multiple contextual policies exist, their shared contract should
define policy identity, applicability, required inputs, fallbacks, and
explanation metadata without taking ownership of catalog ingestion or storage.

As catalog ingestion moves behind a prepared Commerce Graph, that graph can
provide product-frontier, freshness, provenance, and completeness state. Market
discovery policies can then order the prepared state without coupling the UI or
the ranking policy to graph storage and synchronization.

### Checkout

1. Review cart
2. Enter or confirm shipping/contact details (validated for internal consistency before direct payment — see address validity below)
3. Create a signed order message for each merchant, persist a durable order lifecycle record, and navigate to the status-first Orders tracker (`/orders?order=<orderId>`)
4. Use fast checkout when merchant readiness and buyer wallet capability allow it; otherwise the order still starts and Orders surfaces an external-wallet QR fallback
5. Payment, payment proof, and order/payment/shipping state are owned by Orders, not an inline checkout dead-end

Checkout collects intent and **starts** the order; Orders owns everything after an order exists. See `docs/specs/order-lifecycle.md` for the durable lifecycle record, status-first tracker, retry idempotency, external-wallet fallback, and the address-validity policy.

Guest external-wallet checkout is the bounded exception: a per-order
`guest_ephemeral` key submits the encrypted order and payment report, while
phone/email are required for all merchant follow-up. Guest Orders state is
local, payment-only, and retained for at most 24 hours; it does not create a
guest inbox or durable order history. See `docs/specs/protocol.md`.

### Messaging

1. Open `/messages` or an order-linked conversation
2. Read NIP-17 encrypted buyer/merchant messages
3. Receive payment requests, payment proof state, status updates, shipping updates, and receipts inline

This messaging flow requires a signed-in buyer identity. It does not apply to
`guest_ephemeral` checkout.

## Pages

| Route                  | Description                         |
| ---------------------- | ----------------------------------- |
| `/`                    | Home / browse entry                 |
| `/products`            | Product grid with filters           |
| `/products/$productId` | Single product view                 |
| `/cart`                | Shopping cart                       |
| `/checkout`            | Order and payment flow              |
| `/orders`              | Buyer order history/details surface |
| `/messages`            | DM inbox                            |
| `/network`             | Relay/network settings              |
| `/wallet`              | Buyer wallet / NWC setup            |
| `/profile`             | Buyer profile                       |
| `/store/$pubkey`       | Merchant storefront                 |
| `/u/$profileRef`       | Profile reference view              |
| `/about`               | App/source/provenance surface       |

Do not document `/orders/$orderId` unless that route exists again.

## Data Layer

### Shared Boundaries

- Auth state comes from shared auth context.
- Relay/product/profile/order helpers should come from `@conduit/core`.
- Shared interaction primitives should come from `@conduit/ui`.
- Route files own workflow composition and local UI state, not reusable protocol contracts.

### Persistence

- Dexie stores orders, messages, product/profile caches, relay lists, social summaries, and payment attempts.
- localStorage stores cart and small preferences.
- Sensitive payment/message/order contents should not be added to telemetry or browser storage outside the intended encrypted/local persistence paths.

## Cart System

Cart state is grouped by merchant so checkout can create merchant-specific order messages.

```typescript
interface CartItem {
  productId: string
  eventId: string
  name: string
  price: number
  currency: string
  quantity: number
  image?: string
}
```

Product references should preserve full addressable coordinates where possible:

```text
30402:<merchant_pubkey>:<product_d_tag>
```

## Checkout States

Market checkout should distinguish:

- cart empty
- shipping/contact invalid
- order signing/sending
- fast payment available
- fallback payment request required
- payment sent
- proof sent
- awaiting merchant confirmation
- paid/processing/shipped/complete
- failed, expired, disputed, or unverifiable payment state

Fast checkout must remain explicitly gated. The fallback merchant payment-request path is a required baseline, not a deprecated edge case.

### Public Zap Payment Option

Checkout may offer a public zap payment option only when all product policy,
pricing, shipping, merchant payment readiness, and buyer wallet gates pass.
The private invoice/payment-request path remains available as the conservative
fallback.

Product public-zap policy is cart-wide:

- If any cart item has an unknown, missing, malformed, or disabled public-zap
  policy, checkout must not offer public zap payment for that cart.
- If every cart item explicitly allows public zaps, checkout applies the most
  restrictive item message policy across the cart:
  `generic_only` before `custom`.
- `generic_only` locks the public comment to generic checkout copy with item
  count only. `custom` allows shopper-edited public comment text only when the
  shopper signs the zap request, still subject to the privacy boundary below.
- Anonymous public zaps always use server-owned copy such as
  `Zapped out 1 item at https://shop.conduit.market/` or
  `Zapped out 4 items at https://shop.conduit.market/`, using the actual summed
  cart quantity and the singular noun only for one item.
- Anonymous public-zap preparation is optional receipt infrastructure, not an
  order or payment availability dependency. Checkout delivers and persists one
  order first. If authorization, signing, public-invoice issuance, or
  public-invoice validation fails before an invoice reaches a payment rail, the
  same order continues through exactly one plain private LNURL invoice. The
  lifecycle records the fallback and must not claim that a public zap occurred.
- Once an invoice reaches a payment rail, timeout or ambiguous payment state
  must not request a second invoice or switch payment modes. The buyer must
  check the original payment state before retrying.
- The public Zapouts feed accepts only valid signed embedded zap requests whose
  recipient, sender, amount, and BOLT11 description binding agree with the
  receipt. Anonymous requests include an `omf_auth` proof bound to the exact
  server-authorized request, while the browser resolves the merchant's current
  LNURL provider directly before signing and invoice creation. The provider
  callback and receipt pubkey must match the authorized LNURL and amount, but
  are not accepted from the server authorization response. The public feed
  resolves provider authority server-side only during a bounded payment-time
  window; older evidence, lookup failure, or provider rotation is
  authority-unavailable, not invalid. Authority metadata egress is restricted
  to exact operator-allowed LNURL hosts, and feed visitors never contact
  receipt-selected wallet domains directly. Relay reads paginate independently,
  preserve same-second boundaries, cap relays/candidates/time, and distinguish
  empty results, invalid receipts, unavailable authority, and partial or total
  relay failure.
- Direct anonymous checkout may recheck the private destination locally against
  the latest signed listing's public country/postal rules before signing. A
  failed or unavailable optional recheck suppresses the public zap and falls
  back to the already-eligible private checkout path; it does not suppress the
  delivered order or ordinary invoice. The destination is not disclosed to the
  authorization or signer service.

Public zap comments are public protocol content. They must not include order
contents, shipping/contact data, invoices, payment request strings, product
names, product identifiers, or other private checkout details. Product details
are included only when the shopper writes a custom public comment.

## Orders Surface

Orders is the canonical status and order-history surface. It renders interpreted
order state from the durable lifecycle record (and relay messages), not a raw
conversation/message-count replay.

- Deep-linkable selection via `/orders?order=<orderId>`; the selected order is
  visible immediately from local state before relay readback.
- A status-first detail view: header status pill + next action, a 7-stage
  timeline (order sent → invoice received → payment sent → receipt sent →
  merchant confirmation → fulfillment/shipping → complete), items, shipping
  address, and collapsed technical details. No primary `Conversation` section.
- External-wallet QR/copy/open fallback for signed-in buyers who can request an
  invoice but lack automatic NWC/WebLN payment; after paying externally the buyer
  sends the receipt from the same order.
- Recovery actions appear only when safe (retry payment only when funds did not
  move; resend receipt only after payment moved); retries reuse the original
  `orderId` and never duplicate the merchant order.
- `Message merchant` / `Open in messages` remains as a secondary support escape
  hatch. Desktop is master/detail; mobile lands on the current order with a
  `Change order` selector and All/Pending/In progress/Completed filters.

### Address validity

Before order submission and direct payment / zap-out, physical-shipping
addresses and optional contact fields are validated locally and offline (no
third-party browser address calls; no address/contact data to analytics, logs, or
observability). This is distinct from merchant shipping-zone coverage.

Checkout uses v1 country profiles for `US`, `CA`, `GB`, `AU`, and `NZ`.
Profiled countries add local confidence when required field, postal-format,
contact, lightweight street-plausibility, and bundled postal-to-region or
postal-to-locality checks pass. Shared region metadata also marks destinations
where a state/province/region-style administrative area is expected and supplies
the country-specific checkout label. Missing blocking fields (`name`, `street`,
`city`, `postalCode`, or `country`), syntactically invalid contact details,
invalid postal formats, and obvious street/locality junk remain blocking errors.
Incomplete local confidence, unprofiled countries, missing expected region data,
missing street/building numbers, and known postal-to-region or
postal-to-locality contradictions are advisory warnings: checkout must tell the
buyer that the address could not be fully validated locally, but direct payment
remains available when merchant shipping-zone and payment gates pass.

The checkout UI must show address/contact validity separately from merchant
shipping-zone eligibility. Shipping-zone success must not be the only green/pass
state while address/contact validity is missing, invalid, or unverified. See
`docs/specs/order-lifecycle.md` for the full policy.

## Protocol Events

### Read

- Kind `0`: profiles
- Kind `3`: contact/follow graph for trust context
- Kind `30402`: product listings
- Kind `1059`: gift-wrapped NIP-17 messages
- Kind `9735`: zap receipts where relevant to proof handling
- Kind `10002`: relay lists

### Publish

- Kind `1059`: gift-wrapped order/payment/status messages
- Kind `9734`: zap requests when using zap-style payment flows
- NIP-89 events where app handler metadata/recommendations are explicitly implemented

## Trust Context

Checkout must not treat trust as binary. Buyer-facing trust context should show what is known, loading, unavailable, or absent before payment-sensitive actions. Slow hydration should not block browsing unless the buyer is about to send funds.

## Environment

Use the root `.env.example` and `packages/core/src/config.ts` as the source of truth for relay and payment env vars.

```bash
VITE_LIGHTNING_NETWORK=mainnet # mainnet | signet | testnet | mock
VITE_RELAY_URL=                # optional legacy/default relay hint
VITE_DEFAULT_RELAYS=
VITE_PUBLIC_RELAY_URLS=
VITE_COMMERCE_RELAY_URLS=
VITE_APP_WRITE_RELAY_URLS=
VITE_CACHE_API_URL=
```

Do not use retired Conduit relay hosts in active Market docs or examples.

## Privacy Constraints

- No behavioral tracking or profiling
- No message content inspection
- No cross-session correlation
- System and reliability metrics only, constrained by `docs/specs/privacy-observability.md`

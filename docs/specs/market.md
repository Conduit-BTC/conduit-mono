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

### Checkout

1. Review cart
2. Enter or confirm shipping/contact details (validated for internal consistency before direct payment — see address validity below)
3. Create a signed order message for each merchant, persist a durable order lifecycle record, and navigate to the status-first Orders tracker (`/orders?order=<orderId>`)
4. Use fast checkout when merchant readiness and buyer wallet capability allow it; otherwise the order still starts and Orders surfaces an external-wallet QR fallback
5. Payment, payment proof, and order/payment/shipping state are owned by Orders, not an inline checkout dead-end

Checkout collects intent and **starts** the order; Orders owns everything after an order exists. See `docs/specs/order-lifecycle.md` for the durable lifecycle record, status-first tracker, retry idempotency, external-wallet fallback, and the address-validity policy.

### Messaging

1. Open `/messages` or an order-linked conversation
2. Read NIP-17 encrypted buyer/merchant messages
3. Receive payment requests, payment proof state, status updates, shipping updates, and receipts inline

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
  `generic_only` before `product_reference` before `custom`.
- `generic_only` locks the public comment to generic checkout copy.
  `product_reference` may mention public listing context only. `custom` allows
  shopper-edited public comment text, still subject to the privacy boundary
  below.

Public zap comments are public protocol content. They must not include order
contents, cart contents, shipping/contact data, invoices, payment request
strings, or other private checkout details.

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

Before direct payment / zap-out, physical-shipping addresses are validated for
internal consistency locally and offline (no third-party browser calls; no
address/contact data to analytics). This is distinct from merchant shipping-zone
coverage. See `docs/specs/order-lifecycle.md` for the full policy.

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

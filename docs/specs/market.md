# Market Specification

## Overview

Conduit Market is the buyer-facing marketplace for discovering products, evaluating merchant trust context, managing a cart, placing orders, sending payments, and tracking buyer-merchant communication over Nostr-native protocols.

This spec covers current Market scope. Store Builder, monetization, billing, and service-operated checkout automation are parked under `docs/knowledge/future/` and are not Market implementation requirements.

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
2. Enter or confirm shipping/contact details
3. Create a signed order message for each merchant
4. Use fast checkout when merchant readiness and buyer wallet capability allow it
5. Fall back to merchant payment request/manual invoice flow when fast checkout is unavailable
6. Attach payment proof to the order conversation when payment is sent
7. Track order/payment/shipping state from the order conversation

### Messaging

1. Open `/messages` or an order-linked conversation
2. Read NIP-17 encrypted buyer/merchant messages
3. Receive payment requests, payment proof state, status updates, shipping updates, and receipts inline

## Pages

| Route                  | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `/`                    | Home / browse entry                                                |
| `/products`            | Product grid with filters                                          |
| `/products/$productId` | Single product view                                                |
| `/cart`                | Shopping cart                                                      |
| `/checkout`            | Order and payment flow                                             |
| `/orders`              | Buyer order history/details surface                                |
| `/messages`            | DM inbox                                                           |
| `/network`             | Relay/network settings                                             |
| `/wallet`              | Buyer wallet / NWC setup                                           |
| `/profile`             | Buyer profile                                                      |
| `/store/$pubkey`       | Merchant storefront                                                |
| `/u/$profileRef`       | Profile reference view                                             |
| `/about`               | App/source/provenance surface, expected after provenance PRs merge |

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

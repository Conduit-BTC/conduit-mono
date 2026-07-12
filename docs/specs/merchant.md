# Merchant Portal Specification

## Overview

The Merchant Portal is the seller workspace for product publishing, order handling, payment readiness, shipping readiness, profile setup, relay/network settings, and customer communication.

This spec covers current Merchant scope.

## References

**Figma** remains the primary visual reference when implementing screens:

```text
File: "Conduit High Fi - Website" in Conduit Market Team
URL: https://www.figma.com/design/adfNXYE3nBqr35frkl0b5q
Page: "High Fi - WIP" for Merchant Portal screens
```

Use Figma MCP tools to extract design context for screen work. Do not rely on old local filesystem paths as public implementation references.

## Core Flows

### Product Management

1. Create or edit products
2. Validate normalized product data with `@conduit/core`
3. Publish replaceable kind `30402` events to selected `OUT` relays
4. Delete/deprecate products with kind `5` deletion events and address tags
5. Reflect local signed state while relay convergence is still pending

### Readiness

Merchant readiness should make setup status explicit across:

- profile identity
- payment setup
- shipping setup
- relay/network setup
- product availability
- order/message access

The current product uses focused pages plus dashboard readiness. Do not re-open a monolithic settings route unless a product decision explicitly changes that direction.

### Order Processing

1. Receive order via NIP-17 message
2. View order details and buyer context
3. Inspect and verify a payment report or proof when the buyer sends payment
   evidence
4. Send a payment request only for an unpaid order whose flow requires an
   invoice
5. Confirm settlement; confirmed paid orders are accepted and move directly to
   fulfillment
6. Record processing, shipment, and completion through contextual actions

For `guest_ephemeral` orders, buyer contact occurs out of band using the required
phone/email shown in order details. The guest pubkey is an outbound order
sender, not a reply-capable Nostr inbox; Merchant must not claim to send Nostr
invoice, status, shipping, or reply messages to that key. Merchant may still
record decisions and fulfillment as encrypted messages addressed to itself so
the order has a durable operational trail. Guest actions must be labeled as
records of out-of-band work, not as buyer DMs or proof that the buyer was
notified.

A confirmed paid order does not require a separate accept action. Its ordinary
next step is fulfillment, with cancellation plus explicit manual-refund
coordination as the alternative. Buyer-reported payment and payment proof are
not equivalent to confirmed settlement and remain in a verification queue until
the merchant confirms payment or cancels the order. An ordinary invoice action is hidden
after settlement is confirmed; requesting additional funds for a paid order is
not part of the standard workflow.

### Communication

1. Keep buyer communication order-linked where possible
2. Reply via signed/encrypted NIP-17 messages
3. Preserve payment requests, payment proofs, status updates, shipping updates, and receipts as conversation evidence

The NIP-17 reply path applies to signed-in buyers. Guest order/payment reports
remain visible as inbound evidence, while follow-up uses the order contact
fields and merchant self-copy records preserve the operational history.

## Pages

| Route       | Description                           |
| ----------- | ------------------------------------- |
| `/`         | Readiness dashboard and overview      |
| `/products` | Product list/create/edit workspace    |
| `/orders`   | Order list and order detail workspace |
| `/profile`  | Merchant/store profile setup          |
| `/payments` | Payment and wallet readiness          |
| `/shipping` | Shipping readiness/options            |
| `/network`  | Relay/network settings                |
| `/about`    | App/source/provenance surface         |

Do not document `/products/new`, `/products/$id/edit`, `/orders/$id`, `/messages`, or `/settings/*` unless those routes exist again.

## Data Layer

- Auth state comes from shared auth context.
- Product, profile, relay, order, payment, and shipping schemas should come from `@conduit/core`.
- Reusable UI controls should come from `@conduit/ui`.
- Dexie stores orders, messages, product/profile caches, relay lists, social summaries, and payment attempts.
- Routes own workflow composition; shared protocol and readiness contracts belong in app libraries or `@conduit/core`.

## Product Event

Product listings use kind `30402`:

```typescript
const productEvent = {
  kind: 30402,
  tags: [
    ["d", productId],
    ["title", title],
    ["price", amount, currency],
    ["summary", summary],
    ["image", imageUrl],
    ["t", category],
  ],
  content: markdownDescription,
}
```

Product identity should preserve:

```text
30402:<merchant_pubkey>:<product_d_tag>
```

Merchant Portal publish validation requires a title, positive price, HTTPS image
URL, and at least 3 distinct tags. Tags serve both as the merchant's store
categories and as buyer search terms, so merchants should reuse a consistent
organization strategy across listings and aim for 5 to 12 relevant tags. The
hard limit is 24 tags, with 40 characters allowed per tag. Tags are trimmed and
deduplicated case-insensitively. Summary remains optional. These are Merchant
input constraints, not NIP-99 or GammaMarkets protocol limits; publishing
preserves one `t` tag per accepted product tag.

Conduit-generated product events also include checkout zap policy tags:

```typescript
tags: [
  ["checkout_public_zaps", "true"], // or "false"
  ["checkout_zap_message_policy", "generic_only"], // or "custom"
]
```

New products default to public zaps enabled with `generic_only` comment policy.
When editing an imported or legacy listing whose explicit policy tags are
missing or malformed, Merchant Portal should show the policy as unknown and
prefill the edit form with the private-safe choice. Saving the product writes
an explicit policy and sets the local policy confidence to known.

## Publishing Flow

1. Normalize form/workspace state
2. Validate with `@conduit/core` schemas
3. Build event tags/content
4. Sign with an external signer
5. Publish to selected `OUT` relays, prioritizing commerce-compatible relays for commerce events
6. Preserve local signed state while relay convergence completes

Current work may continue using the shared NDK-backed helpers. When new work needs explicit per-relay outcomes, source health, or source-aware convergence, prefer shared protocol and relay helpers instead of adding route-local NDK fanout.

## Deletion Flow

```typescript
const deletionEvent = {
  kind: 5,
  tags: [
    ["e", productEventId],
    ["k", "30402"],
    ["p", merchantPubkey],
    ["a", "30402:<merchant_pubkey>:<d_tag>"],
  ],
  content: "",
}
```

## Order States

```text
pending -> invoiced -> paid -> processing -> shipped -> complete
```

`cancelled` can occur when an order is abandoned, rejected, or otherwise closed. The UI should distinguish:

- unpaid
- payment requested
- proof received
- confirmed paid
- shipped
- complete
- cancelled
- mismatch/unverified

The merchant workspace projects this event history onto four independent axes:

- **Settlement:** `unpaid`, `reported`, `proof_observed`, or `confirmed`
- **Decision:** `unreviewed`, `accepted`, or `declined`; confirmed settlement
  implies `accepted`
- **Fulfillment:** `not_started`, `processing`, `shipped`, or `complete`
- **Communication:** `nostr_replyable`, `guest_out_of_band`, or `unknown`

The axes determine a contextual next action. The primary UI must not expose the
raw status vocabulary as a general-purpose manual console. Useful queue filters
are **Paid—fulfill**, **Payment reported—verify**, **Unpaid—review**, **Shipped**,
and **Closed**, plus an all-orders view.

Order-progress copy is state-aware: completed rows describe what happened, the
single active row names the current task and tells the merchant how to advance,
and waiting rows describe the later gate. A row must not use completed-state
wording such as `Shipped` while its status is still in progress. The Actions
surface presents the recommended **Next step** first. Cancellation and other
destructive alternatives appear afterward under **Other actions**, use
destructive styling, and retain confirmation plus refund-risk copy where funds
have already moved.

Shipment is one domain action: it requires a tracking code and carrier, accepts
an optional tracking URL and additional notes, records the shipping update, and
advances fulfillment to `shipped`. Merchants should not have to publish a
separate generic `shipped` status after recording the shipment. Digital-only
orders skip shipment and proceed directly to delivery confirmation; mixed
orders still follow the physical shipment path. Merchant may skip shipment only
after resolving every product reference to merchant-authored listings and
confirming both the order snapshot and current listing are digital. Either
source may preserve a physical requirement; missing, deleted, unresolved, or
legacy listings remain shipping-required.

## Order Message Types

Received via NIP-17 DMs:

| Type              | Description                           |
| ----------------- | ------------------------------------- |
| `order`           | Initial order from buyer              |
| `payment_request` | Invoice/payment request sent to buyer |
| `payment_proof`   | Buyer payment evidence                |
| `status_update`   | State transition                      |
| `shipping_update` | Tracking or shipping info             |
| `receipt`         | Final confirmation                    |

This iteration preserves the current kind `16` inner private commerce-message
encoding and existing read behavior. The known kind collision and migration to
a future Open Markets Foundation/Gamma commerce-message kind are tracked as a
separate interoperability change. Merchant fulfillment work in this iteration
must not mix old and proposed kinds or begin a partial migration.

## Store Profile

Profile metadata uses kind `0`.

```typescript
interface StoreProfile {
  name: string
  about: string
  picture: string
  banner?: string
  nip05?: string
  lud16?: string
  website?: string
}
```

Lightning address (`lud16`) and NWC/WebLN readiness can contribute to payment eligibility, but fast checkout must remain explicitly gated by readiness and buyer capability.

## Relay Settings

Relay list events use kind `10002`. Product UI should expose:

- Commerce Enabled Relays
- Other Public Relays
- `IN` / `OUT` preferences
- capability and warning indicators
- commerce priority as a local app planning signal

Example:

```typescript
const relayListEvent = {
  kind: 10002,
  tags: [
    ["r", "wss://relay.conduit.market", "read", "write"],
    ["r", "wss://relay.plebeian.market", "read"],
    ["r", "wss://nos.lol", "read"],
  ],
  content: "",
}
```

Do not use retired Conduit relay hosts in active Merchant docs or examples.

## Shipping Options

Shipping option events use kind `30406`:

```typescript
const shippingEvent = {
  kind: 30406,
  tags: [
    ["d", optionId],
    ["title", "Standard Shipping"],
    ["price", "5000", "SAT"],
    ["region", "US"],
    ["eta", "5-7", "days"],
  ],
  content: "Description of shipping option",
}
```

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

## Privacy Constraints

- No buyer behavior analytics
- No message content inspection
- Operational metrics only
- All buyer data stays on the buyer's device, merchant's device, or selected relays

# Order Lifecycle Specification

Status-first buyer order tracking for Conduit Market (CND-122, consolidating the
external-wallet fallback CND-120 and address-validity gates CND-127).

## Overview

Checkout collects intent and **starts** an order; everything after an order
exists is owned by Orders. The shared state model is a durable, buyer-local
**order lifecycle record** created before checkout navigates away. Orders renders
interpreted order state from this record — not a raw message/conversation replay —
so an order is visible immediately, before relay readback and while a fast-zap
payment is still in flight.

## Durable lifecycle record

Stored locally (Dexie `orderLifecycles`, keyed by `orderId`). Created by checkout
before long async work; enriched by relay-observed messages but never dependent on
them to display. Defined in `@conduit/core` (`OrderLifecycle`).

Fields:

- Identity: `orderId`, `buyerPubkey`, `merchantPubkey`, `checkoutMode`
  (`public_zap` | `private_checkout` | `pay_later` | `external_wallet`).
- Snapshot: `items` (productId, qty, price-at-purchase, source price, shipping
  option), `itemSubtotalSats`, `shippingCostSats`, `totalSats`, `totalMsats`,
  `currency`, `pricingQuote`.
- Local-only PII: `shippingAddress`, `contactNote`. **Never** sent to telemetry.
- Gates: `addressValidity`, `shippingZoneEligibility` (distinct — see below).
- Progress: `orderDeliveryStatus`, `invoiceStatus`, `paymentStatus`,
  `proofDeliveryStatus`, `zapReceiptStatus`.
- Evidence: `invoice`, `paymentHash`, `preimage`, `feeMsats`, `zapRequestId`,
  `zapReceiptId`.
- Meta: coarse `phase` (for list filtering), `lastError`, `deliveryNotice`,
  `createdAt`, `updatedAt`, `completedAt`.

Repository helpers: `createOrderLifecycle`, `getOrderLifecycle`,
`patchOrderLifecycle`, `listOrderLifecycles`, `deriveOrderLifecyclePhase`.

## State flow

1. Checkout publishes the order, then `createOrderLifecycle(...)` with
   `orderDeliveryStatus: "sent"`, and navigates to `/orders?order=<orderId>`.
2. Fast-zap hands payment to a route-independent service
   (`order-payment-service`) that, outside React, requests the invoice, pays via
   NWC/WebLN, publishes the proof, and writes each transition to the lifecycle
   record. With no automatic rail it stops at `paymentStatus: "manual_required"`
   and surfaces the invoice for an external wallet (CND-120).
3. Merchant-driven state (confirmation, shipping, completion) is read from the
   order conversation (`status_update` / `shipping_update`) and merged into the
   interpreted view-model.

## Interpreted view-model and timeline

`apps/market/src/lib/order-view.ts` merges lifecycle + conversation + payment
attempt into an `OrderViewModel`, and derives:

- A 7-stage **timeline** (`StatusStepper`): Order sent → Invoice received →
  Payment sent → Receipt sent → Merchant confirmation → Fulfillment/Shipping →
  Complete.
- A header **status pill** (`deriveOrderHeaderStatus`), e.g. `Paid · Receipt
sent`, `Pending · Awaiting invoice`, `Action needed · Pay with external
wallet`, `Completed · Delivered`, plus an `actionNeeded` flag for the list
  marker.

## Idempotency and recovery invariants

- Payment/order retries reuse the original `orderId`; the payment service never
  republishes the order, so a retry cannot create a duplicate merchant order.
- "Try payment again" is offered only when funds did not move
  (`paymentStatus: "failed"`).
- "Resend receipt" is offered only after payment moved and proof delivery is
  `retry_needed`/`failed`.
- External/manual payment is the same durable order in `manual_required` state,
  not a separate checkout branch.
- Paid carts clear at the durable checkpoint (order sent), so they are not live
  after refresh/close/navigation.

## Address validity policy (CND-127)

Buyer-input validity is a **local, offline** check, kept distinct from merchant
shipping-zone coverage:

- `validateAddressConsistency` (in `@conduit/core`) distinguishes `missing`,
  `inconsistent`, `unknown`, and `valid`.
- US addresses are cross-checked with a bundled, offline USPS SCF prefix → state
  table (each 3-digit ZIP prefix maps to a state; ambiguous prefixes resolve to
  multiple states and are treated leniently). Example: `90210 / Beverly Hills /
Texas` is `inconsistent` (90210 is California), and is **blocked** before
  direct payment / zap-out.
- Non-US addresses get structural + postal-format validation; locality agreement
  is `unknown` (non-blocking) where no offline data exists.
- No third-party / browser address-API calls. No address or contact data is sent
  to analytics. `unknown` never blocks.
- Direct payment / zap-out (and external manual payment) are blocked on a
  blocking validity result. Pay-later order-first records validity but does not
  hard-block (no funds move at checkout). Shipping-zone eligibility remains a
  separate fulfillment gate.

## Privacy

Sensitive fields (invoice, preimage, NWC URI, order contents, shipping address,
contact note, message content) stay on the user's device or relays and are
excluded from telemetry, per `docs/specs/privacy-observability.md`.

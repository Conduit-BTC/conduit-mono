# Order Lifecycle Specification

Status-first buyer order tracking for Conduit Market (CND-122, consolidating the
external-wallet fallback CND-120 and address-validity gates CND-127).

## Overview

Checkout collects intent and **starts** an order; everything after an order
exists is owned by Orders. The shared state model is a durable, buyer-local
**order lifecycle record** created before checkout navigates away. Orders renders
interpreted order state from this record, not a raw message/conversation replay,
so an order is visible immediately, before relay readback and while a fast-zap
payment is still in flight.

## Durable lifecycle record

Stored locally (Dexie `orderLifecycles`, keyed by `orderId`). Created by
checkout before long async work; enriched by relay-observed messages but never
dependent on them to display. Defined in `@conduit/core` (`OrderLifecycle`).

The durable model above applies to signed-in buyers. A `guest_ephemeral`
external-wallet order keeps only the redacted local fields needed to finish the
invoice/payment-report flow, receives no relay conversation enrichment, and is
eligible for pruning with related buyer-side cache/payment rows after 24 hours;
Market performs that pruning on startup.

Fields:

- Identity: `orderId`, `buyerPubkey`, `merchantPubkey`, `checkoutMode`
  (`public_zap` | `private_checkout` | `pay_later` | `external_wallet`).
- Snapshot: `items` (productId, qty, price-at-purchase, source price, shipping
  option), `itemSubtotalSats`, `shippingCostSats`, `totalSats`, `totalMsats`,
  `currency`, `pricingQuote`.
- Local-only PII: `shippingAddress`, `contactNote`. **Never** sent to telemetry.
- Gates: `addressValidity`, `shippingZoneEligibility` (distinct; see below).
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
3. For signed-in buyers, merchant-driven state (confirmation, shipping,
   completion) is read from the order conversation (`status_update` /
   `shipping_update`) and merged into the interpreted view-model. Guest orders
   stop at local receipt delivery; later merchant coordination occurs through
   the required phone/email contact fields.

## Interpreted view-model and timeline

`apps/market/src/lib/order-view.ts` merges lifecycle + conversation + payment
attempt into an `OrderViewModel`, and derives:

- A 7-stage **timeline** (`StatusStepper`): Order sent -> Invoice received ->
  Payment sent -> Receipt sent -> Merchant confirmation -> Fulfillment/Shipping
  -> Complete.
- A header **status pill** (`deriveOrderHeaderStatus`), e.g. `Paid - Receipt
sent`, `Pending - Awaiting invoice`, `Action needed - Pay with external
wallet`, `Completed - Delivered`, plus an `actionNeeded` flag for the list
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
- Guest recovery is same-tab and payment-only: it does not fetch merchant
  replies, expose a guest DM inbox, or retain the decrypted order/contact payload
  as durable buyer history.

## Address validity policy (CND-127)

Buyer-input validity is a **local, offline** check, kept distinct from merchant
shipping-zone coverage. The v1 implementation uses expandable country profiles
for `US`, `CA`, `GB`, `AU`, and `NZ`.

The validation boundary returns a coarse lifecycle status (`missing`,
`inconsistent`, `unknown`, or `valid`), normalized fields, issue and warning
codes, a confidence level, and two gates: `canSubmitOrder` and `canDirectPay`.
Profiled countries validate required fields, country postal formats, contact
syntax, lightweight street plausibility, and bundled postal-to-region or
postal-to-locality consistency where data exists.

Some destinations also require a state/province/region-style administrative
area for local address confidence. Checkout shows the country-specific label
from shared region metadata (for example `State`, `Province / Territory`, or
`Emirate`) and marks that field as expected. Missing expected region data is an
advisory confidence warning under the current policy, not a hard order or
payment blocker.

Direct-payment confidence is advisory rather than mandatory. Unsupported or
not-yet-profiled countries, profiled countries without enough bundled
consistency evidence, missing expected region data, missing street/building
numbers, and known postal/region/locality contradictions receive warnings when
the shared structural checks otherwise pass. Checkout must tell the buyer that
the address could not be fully validated locally and that the merchant may need
to confirm details, but the buyer may still choose direct payment when merchant
shipping-zone and payment gates pass. No third-party / browser address-API calls
are made; no address or contact data is sent to analytics, logs, or
observability; and local checks never claim full deliverability verification.

Order-first submission and direct payment are blocked for hard input failures:
missing blocking fields (`name`, `street`, `city`, `postalCode`, or `country`),
syntactically invalid contact data, obvious street/locality junk, invalid postal
formats, or unavailable merchant shipping/payment gates. Shipping-zone
eligibility remains a separate fulfillment gate.

## Privacy

Sensitive fields (invoice, preimage, NWC URI, order contents, shipping address,
contact note, message content) stay on the user's device or relays and are
excluded from telemetry, per `docs/specs/privacy-observability.md`.

Guest checkout is narrower: phone/email and fulfillment details are delivered
inside the merchant's encrypted order copy, removed from the checkout form after
successful delivery, and omitted from the buyer's durable lifecycle/message
cache. The remaining redacted guest lifecycle and invoice are bounded to the
24-hour guest recovery window.

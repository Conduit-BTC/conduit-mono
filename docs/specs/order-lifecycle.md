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
  (`anonymous_public_zap` | `public_zap_as_shopper` | `public_zap` |
  `private_checkout` | `pay_later` | `external_wallet`).
- Snapshot: `items` (productId, fulfillment format, qty, price-at-purchase,
  source price, shipping option), `itemSubtotalSats`, `shippingCostSats`,
  `totalSats`, `totalMsats`, `currency`, `pricingQuote`.
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

1. Every checkout mode publishes the encrypted order first, then calls
   `createOrderLifecycle(...)` with `orderDeliveryStatus: "sent"` and navigates
   to `/orders?order=<orderId>`. Anonymous public-zap preparation begins only
   after that durable checkpoint. Signer, authorization, pricing-attestation,
   or public-invoice failure can suppress the public receipt but cannot prevent
   order delivery or an ordinary private invoice.
2. Fast-zap hands payment to a route-independent service
   (`order-payment-service`) that, outside React, requests the invoice, pays via
   NWC/WebLN, publishes the proof, and writes each transition to the lifecycle
   record. With no automatic rail it stops at `paymentStatus: "manual_required"`
   and surfaces the invoice for an external wallet (CND-120).
3. For signed-in buyers, merchant-driven state (confirmation, shipping,
   completion) is read from the order conversation (`status_update` /
   `shipping_update`) and merged into the interpreted view-model. Guest orders
   stop at local receipt delivery; later merchant coordination occurs through
   the required phone/email contact fields. Merchant records of guest-order
   decisions and fulfillment are self-addressed operational messages, not
   replies to a guest Nostr inbox.

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

## Order flows and gates

Two checkout flows are first-class and produce the same NIP-17 order messages
(`order`, `payment_request`, `payment_proof`, `receipt`, `status_update`,
`shipping_update`) in a different order:

- **Prepaid (zap-out)** — a public-zap checkout mode (`anonymous_public_zap`,
  `public_zap_as_shopper`, or legacy `public_zap`): the buyer pays at checkout
  (payment proof published up front). Once the merchant confirms settlement,
  the order is accepted and ready for fulfillment; it must not require a second
  accept action. Payment confirmation precedes the fulfillment decision.
- **Invoice (order-first)** — `checkoutMode: private_checkout` / `pay_later`:
  the buyer places the order, the merchant accepts and sends a
  `payment_request` (invoice), then the buyer pays. Acceptance precedes payment.

Because the sequence differs, acceptance and payment are modeled independently
rather than as one linear status. Payment has two distinct signals:

- `paymentObserved`: valid buyer `payment_proof` evidence was received, but the
  merchant may still need to verify settlement.
- `paymentConfirmed` / `paid`: the merchant emitted a `paid`-or-beyond
  `status_update` after confirming settlement.
- `accepted`: a merchant `status_update` of accepted-or-beyond was observed.

A merchant-confirmed paid state implies acceptance for operational purposes.
Buyer-reported payment and buyer payment proof remain evidence to verify; they
do not by themselves authorize fulfillment or revenue accounting. This keeps a
forged, stale, mismatched, or otherwise unverified report from advancing the
merchant workflow while avoiding a redundant accept step after settlement has
actually been confirmed.

State is derived from which trusted, fixed-direction events exist, not their
arrival order.

- The buyer knows its flow from `checkoutMode`.
- The merchant infers it: observed buyer payment evidence **without** a merchant
  invoice ⇒ prepaid; otherwise invoice-first. Shared helper
  `deriveOrderFlow({ status, paid, paymentObserved, invoiceSent })` in
  `@conduit/core/order-status` encodes this and drives the merchant timeline
  ordering (payment↔acceptance). Payment evidence may update flow and timeline
  presentation, but only merchant-confirmed payment unlocks shipping and revenue
  accounting. After confirmation, the normal merchant choices are to fulfill
  the order or cancel it and coordinate a manual refund; an ordinary additional
  invoice is no longer a valid next step.

Status vocabulary is unified across schema and presentation: `pending`,
`invoiced`, `paid`, `accepted`/`processing`, `shipped`, `complete`/`delivered`,
`cancelled`, `refund_requested`; unknown strings remain forward-compatible.

## Merchant operational projection

Merchant order handling is derived from independent operational axes rather
than forcing every event into one strictly linear status:

- **Settlement:** `unpaid` | `reported` | `proof_observed` | `confirmed`.
- **Decision:** `unreviewed` | `accepted` | `declined`. Confirmed settlement
  projects to `accepted` even when no separate accepted event exists.
- **Fulfillment:** `not_started` | `processing` | `shipped` | `complete`.
- **Communication:** `nostr_replyable` | `guest_out_of_band` | `unknown`.

Explicit signed-in orders and loaded legacy order rumors without an identity
marker are `nostr_replyable`; explicit guest orders are `guest_out_of_band`;
orderless partial reads remain `unknown` and may write merchant self-copies but
must not claim buyer delivery.

These axes drive a single contextual next-action surface rather than exposing a
general-purpose status console as the primary workflow:

- `reported` or `proof_observed`: verify settlement, then confirm payment or
  cancel the order; no separate disputed wire status is introduced here.
- confirmed physical or mixed order and not shipped: record shipment or cancel
  and coordinate a manual refund.
- confirmed digital-only order: confirm delivery directly or cancel and
  coordinate a manual refund; no shipping milestone is shown or required.
- shipped: complete delivery when appropriate.
- unpaid and unreviewed: accept/request payment or decline.

The shipment action requires non-empty tracking-code and carrier values, may
include a tracking URL and additional notes, and advances fulfillment to
`shipped` as one operation. It must not require a separate generic status
update. Digital-only orders skip this action and advance from confirmed payment
to delivery confirmation. Mixed orders retain the physical shipment path. The
Merchant skip is authorized only by resolved merchant-authored product
listings that agree with the order snapshot that every item is digital. Either
source may preserve a physical requirement, while buyer-provided snapshots
alone cannot remove one; missing, deleted, unresolved, or legacy listings are
treated as requiring shipping. Normal invoice controls are suppressed after confirmed payment. For
backward compatibility, an authentic merchant-authored shipment event also
backfills the paid and accepted gates when older history lacks the now-required
explicit confirmation. Requesting extra funds because a displayed price or
shipping option was insufficient is not part of the ordinary paid-order flow.

The Merchant order queue exposes work-oriented filters: **Paid—fulfill**,
**Payment reported—verify**, **Unpaid—review**, **Shipped**, and **Closed**, with
an all-orders view available for browsing.

For guest orders, the merchant contacts the buyer out of band and records the
same decision, payment, shipment, and completion milestones through
merchant-addressed encrypted self-copies. Those records provide local/relay
operational history without claiming that the ephemeral guest pubkey is a
reply-capable DM inbox or that Conduit delivered the external phone/email
message.

This iteration preserves Conduit's current kind `16` private commerce-message
encoding and reads. Resolving the kind collision and migrating to a future
Open Markets Foundation/Gamma commerce-message kind is explicitly out of scope
and tracked separately; this work must not introduce a partial kind migration.

### Cancellation and refunds

Lightning payments are non-custodial and final, and escrow/refunds are explicit
protocol non-goals (`docs/specs/protocol.md`). Therefore:

- Cancelling a **paid** order does not reverse funds. The app sets `cancelled`
  and must tell the merchant a refund is a separate, manual step.
- Refund coordination and payout are currently **out of band**. Conduit does not
  create or pay a refund invoice, emit a standardized refund proof, custody
  funds, escrow payment, or guarantee repayment. `refund_requested` is reserved
  in the canonical status vocabulary for compatible clients and presentation;
  a tracked refund workflow requires a separate protocol/spec change.

## Idempotency and recovery invariants

- Payment/order retries reuse the original `orderId`; the payment service never
  republishes the order, so a retry cannot create a duplicate merchant order.
  Anonymous payment retry must also exact-match the stored signed fulfillment
  snapshot, including format, shipping option identity/cost, and country/postal
  rules. A changed or missing rule snapshot stops before signing or payment.
- Anonymous authorization, signing, public-invoice issuance, or invoice-binding
  failure before payment automatically transitions the same delivered order to
  a private invoice. The lifecycle clears public-receipt context and records
  `publicZapFallback: true`; it never claims a public zap occurred.
- Anonymous payment retries require the newly authorized item prices,
  quantities, fulfillment formats, shipping allocations, and shipping option
  identities to match the delivered lifecycle snapshot; aggregate-total
  equality alone is insufficient.
- Before signer, LNURL, or wallet work, the payment service atomically claims
  the durable lifecycle record and exact-matches buyer, merchant, Lightning
  destination, public/private mode, public content, totals, and item quantities.
  The durable delivered-order snapshot is authoritative; caller disagreement
  performs no external work.
- The durable claim rejects `paying`, `paid`, `manual_required`, and `ambiguous`
  payment states. The in-memory lock is only a same-tab optimization; the
  IndexedDB transaction is the cross-tab double-payment guard.
- No automatic fallback is allowed after an invoice reaches a payment rail.
  Ambiguous payment state retains the original invoice and requires the buyer
  to check that payment before any retry. The explicit private transition is
  retained only to recover legacy already-failed anonymous lifecycle records.
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

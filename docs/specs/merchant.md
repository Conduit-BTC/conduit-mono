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

For `guest_ephemeral` orders, buyer contact occurs out of band using the
structured recovery channel required by that checkout flow and available to the
merchant handling the order. Pickup requires at least one of email or phone;
shipping retains its stricter contact/address contract. The guest pubkey is an
outbound order sender, not a reply-capable Nostr inbox; Merchant must not claim
to send Nostr invoice, status, shipping, or reply messages to that key. Merchant may still
record decisions and fulfillment as encrypted messages addressed to itself so
the order has a durable operational trail. Guest actions must be represented
truthfully as records of out-of-band work, not as buyer DMs or proof that the
buyer was notified.

A confirmed paid order does not require a separate accept action. Its ordinary
next step is fulfillment, with cancellation plus explicit manual-refund
coordination as the alternative. Buyer-reported payment and payment proof are
not equivalent to confirmed settlement and remain identifiable for verification
until the merchant confirms payment or cancels the order. An ordinary invoice
action is unavailable after settlement is confirmed; requesting additional
funds for a paid order is not part of the standard workflow.

### Communication

1. Handle general buyer support conversations in the `/messages` workspace
   (NIP-17 kind-14 direct messages), kept distinct from order conversations
2. Keep order-specific communication order-linked (kind 16) in the Orders
   workspace, where order-linked previews link back to the order
3. Reply via signed/encrypted NIP-17 messages
4. Preserve payment requests, payment proofs, status updates, shipping updates, and receipts as conversation evidence
5. Preserve explicit loading, stale/degraded, and decrypt-failed/retry states;
   give the merchant actionable failure and retry information when messaging
   work is affected rather than silently omitting messages

General direct messages and order-linked conversations stay separate. See
`docs/specs/messaging.md`.

The NIP-17 reply path applies to signed-in buyers. Guest order/payment reports
remain visible as inbound evidence, while follow-up uses the order contact
fields and merchant self-copy records preserve the operational history.

### Organizer Event Markets

A signed-in merchant may also act as an event organizer without a separate
Conduit-controlled account. The organizer workspace composes shared Core
workflows to publish and update the NIP-52 calendar record, optional
organizer-handoff pickup option, and authoritative product collection with the
active external signer. It shows record-level relay acknowledgement and retry
state, participation requests, each accepted merchant booth's handoff party,
and the canonical collection `naddr` share link.

An accepted merchant chooses either a merchant-authored booth pickup, which
keeps orders and receipts merchant-only, or the organizer-authored pickup,
which opts future orders into the minimal private fulfillment-receipt workflow.
The organizer view exposes only those redacted delegated receipts addressed to
the active organizer and may issue only the scoped `handed_out`
acknowledgement. It never grants organizer access to full orders, buyer contact,
payment material, refunds, price changes, or ordinary merchant status actions.
The queue displays the same opaque short pickup code that the buyer derives
locally from the private order; it does not receive the order id or buyer
identity.
See
`docs/specs/event-markets.md`.

## Pages

| Route               | Description                           |
| ------------------- | ------------------------------------- |
| `/`                 | Readiness dashboard and overview      |
| `/products`         | Product list/create/edit workspace    |
| `/orders`           | Order list and order detail workspace |
| `/messages`         | Buyer support messaging workspace     |
| `/profile`          | Merchant/store profile setup          |
| `/payments`         | Payment and wallet readiness          |
| `/shipping`         | Shipping readiness/options            |
| `/events`           | Organizer event markets and requests  |
| `/network`          | Relay/network settings                |
| `/about`            | App/source/provenance surface         |
| `/privacy-policy`   | Public Product Privacy Policy         |
| `/terms-of-service` | Public Product Terms of Service       |

Do not document `/products/new`, `/products/$id/edit`, `/orders/$id`, or `/settings/*` unless those routes exist again.

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
hard limit is 24 tags, with 40 characters allowed per tag. Summary remains
optional. These are Merchant input constraints, not NIP-99 or GammaMarkets
protocol limits.

Product `t` tags follow the NIP-24 lowercase hashtag requirement. A shared Core
normalizer trims values, lowercases them, removes blanks, and deduplicates them
in first-seen canonical order. Merchant applies that same contract to imported
legacy JSON, received `t` tags, locally cached product projections, form state,
and publishing. Prepared product models and editor chips use the canonical
lowercase values without display-only title casing. Raw event values may remain
available only as raw/provenance data. Publishing emits one `t` tag per
canonical product tag, so editing and republishing a legacy listing also
migrates its public tags to the canonical form.

Product tag entry accepts multiple canonical values and freeform tags. It may
suggest canonical tags from the signed-in merchant's already-loaded product
catalog without starting another relay query. Suggestions exclude selected
tags and rank matching prefixes before catalog usage count and alphabetical
order. A non-empty draft is normalized and validated on form submission and
must not be lost when focus changes. Whatever control is used must support
keyboard, pointer, touch, and IME input accessibly without an accidental commit
or clipped choices on narrow viewports.

Conduit-generated product events also include checkout zap policy tags:

```typescript
tags: [
  ["checkout_public_zaps", "true"], // or "false"
  ["checkout_zap_message_policy", "generic_only"], // or "custom"
]
```

New products default to public zaps enabled with `generic_only` comment policy.
The `custom` setting permits shopper-written comments only for shopper-signed
public zaps. Anonymous public zaps always use Conduit's fixed item-count message,
so merchants cannot receive arbitrary anonymous comment text through that path.
When editing an imported or legacy listing whose explicit policy tags are
missing or malformed, Merchant Portal must retain the policy as unknown and
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

Before delivery, Merchant persists the exact signed deletion and an immutable,
deterministic target plan containing the merchant's configured and NIP-65 write
relays, every validated source relay observed for the product, and the canonical
Conduit commerce relay. Per-relay ACK, rejection, timeout, and retry state is
durable across route changes, reloads, and browser restarts. Retries publish the
same signed event and only revisit targets that have not acknowledged it.

Legacy products may be deleted by a valid exact event ID when trustworthy
address metadata is unavailable. Merchant may emit an address-only target when
the full same-author coordinate is trustworthy, but it must refuse to sign when
neither target is valid.

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

The axes determine eligible next actions. Merchants must be able to find orders
that need payment verification, decision, fulfillment, or communication, without
one prescribed queue or filter set. Progress information must distinguish
completed work, the current task, and later gates truthfully; an in-progress
shipment cannot be represented as completed. Cancelled and refund-requested
orders must not imply that a later fulfillment task is active.

Cancellation and other destructive actions require confirmation. Before
cancelling when funds have moved or payment evidence suggests they may have
moved, the merchant must understand that cancellation does not reverse payment
and any refund requires separate manual coordination. When the buyer has no
confirmed Nostr reply inbox, the merchant needs the order's out-of-band contact
path; an invoice action that cannot reach the buyer is unavailable. After
verifying out-of-band settlement, the merchant can record a self-copy payment
confirmation that unlocks fulfillment.

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

Merchant's `/network` route uses the same account-level Network state and
mutation rules as Market. Both apps preserve identical relay authority,
evidence, ordering, and safety decisions while presentation may vary. The
durable contract lives in
[Conduit Relay Architecture](./relay/conduit_relay_architecture.md).

The account-level Network experience distinguishes two runtime layers:

- **App Relays** is the versioned Conduit baseline and starts enabled.
- **Your Relays** displays signed NIP-65 `kind:10002` Read/Publish and owner
  NIP-17 `kind:10050` Private inbox membership. Its local switch controls only
  additive NIP-65 routing and starts disabled only after complete scoped absence
  with no retained NIP-65 frontier.

NIP-17 `kind:10050` remains the separate signed private-inbox authority. A valid
merchant declaration stays active for order/message reads regardless of the
Your Relays toggle. A valid recipient declaration is exclusive for delivery.
Signed events are portable account state; the layer toggles are versioned local
Conduit policy and do not rewrite those events.

Before turning App Relays off, the merchant understands any material loss of
coverage when Your Relays is disabled, the enabled personal list has no
positively qualified commerce Publish relay, or no valid private inbox is
current. Unknown evidence is unverified, not broken. The merchant may explicitly
proceed, and the cutoff is rechecked with durable exclusions
immediately before later I/O.

NIP-65 uses no marker when a relay is both Read and Publish, and exactly one
`read` or `write` marker for a single direction:

```typescript
const relayListEvent = {
  kind: 10002,
  tags: [
    ["r", "wss://relay.conduit.market"],
    ["r", "wss://nos.lol", "read"],
    ["r", "wss://relay.example.com", "write"],
  ],
  content: "",
}
```

Private inbox routing remains a separate signed object even though the user
manages it on the same Network surface:

```typescript
const inboxRelayEvent = {
  kind: 10050,
  tags: [["relay", "wss://relay.conduit.market"]],
  content: "",
}
```

Do not use retired Conduit relay hosts in active Merchant docs or examples.

When neither setup event is observed within a complete bounded plan and no valid
frontier is retained, **Match Conduit defaults** reviews the exact NIP-65 and
NIP-17 changes and warns that publishing may supersede preferences stored
outside that plan. It publishes only changed kinds through the sole shared
mutation owner. Every required signature and immutable retry checkpoint exists
before publication. Existing observed setups use **Add missing Conduit
defaults** and preserve personal tags and exclusions. Partial/unavailable
discovery and current `signed_empty` or `malformed` frontiers never authorize
silent repair.

When complete bounded discovery resolves a recipient to `not_observed`, a
separately flagged compatibility plan may deliver only validated kind-16 order
traffic through at most three operator-approved relays. `signed_empty`,
`malformed`, `lookup_partial`, and `lookup_unavailable` do not qualify. Kind-14
general DMs never use this lane.

Relay rows may use a validated NIP-11 name and square icon, while retaining the
normalized URL and a generic icon fallback. This is advertised presentation
metadata, not proof of identity, commerce behavior, protected reads, or health.
Merchant does not run a user-facing optimizer or active relay scan.

## Shipping Options

Kind `30406` shipping options follow the GammaMarkets market-spec. The Shipping
route stores a local destination preset for product authoring. It does not
publish a zero-priced merchant-wide option.

```typescript
const shippingEvent = {
  kind: 30406,
  tags: [
    ["d", `${productDTag}-shipping-standard`],
    ["title", "Standard Shipping"],
    ["price", "5.00", "USD"],
    ["country", "US", "CA"],
    ["service", "standard"],
  ],
  content: "",
}
```

For fixed physical shipping, Merchant publishes this complete product-scoped
option and requires a positive relay acknowledgement before publishing the
referencing product. Preset and custom destination inputs compile to the same
wire representation. See `docs/specs/fixed-product-shipping.md`.

Pickup options use the same kind with `service=pickup`, a non-negative price,
country metadata, and a public `location` and/or `g`. Product authoring exposes
Digital, Ship, and Local pickup as distinct intents. Event pickup references
and participation state use the shared contract in
`docs/specs/event-markets.md`; the ordinary shipped-destination editor must not
hydrate from pickup records.

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

- No buyer behavior profiling or persistent visitor/account identity in Product
  telemetry
- No message, order, address, invoice, signer, or wallet-secret content in
  telemetry, logs, or Conduit-operated Product servers
- Shared acceleration, cache, index, and routing systems may derive only from
  relay-visible state and must never expose hidden APIs for private messages,
  orders, payments or invoices, signer or auth material, wallet credentials or
  recovery material, or wallet balances
- Operational metrics only, constrained by `docs/specs/privacy-observability.md`
- Buyer data may be processed by buyer and merchant devices, counterparties,
  relays, signers, wallets, LNURL/payment providers, merchant-selected services,
  and the narrow Conduit-operated endpoints documented in the Product Privacy
  Policy; do not collapse those recipients into a device-or-relay-only claim

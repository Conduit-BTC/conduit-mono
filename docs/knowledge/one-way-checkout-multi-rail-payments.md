# One-Way Checkout and Multi-Rail Payments (Architecture Note)

Goal: enable a buyer-initiated, one-way checkout flow where:

- Buyer computes cart total
- Buyer pays immediately
- Merchant confirmation/fulfillment can happen later (async)
- Conduit never touches funds, generates invoices, or intermediates settlement

This is primarily about coordinating "payment intent" and "proof of payment", not operating payments.

## Principles

- No custody: Conduit never holds funds.
- No invoice issuance: Conduit does not generate Lightning invoices or stablecoin payment requests.
- Interop-first: merchant payment metadata should be publicly discoverable so any compatible client can pay.
- Thin abstraction: keep payment rails behind a minimal interface; advanced payment features are out of scope.

## Minimal Abstraction (Conceptual)

PaymentIntent
- `order_id`
- `amount` + `currency`
- `merchant_id` (nostr pubkey)
- `metadata_hash` (cart hash, shipping hash, etc)

PayHandle (provider-specific)
- Lightning: Lightning Address or LNURL-pay endpoint
- Stablecoin: address + token + memo convention
- Cards: hosted checkout URL (public) or a created checkout session (private API)

PaymentProof
- Lightning: zap receipt and/or payment hash, wallet confirmation
- Stablecoin: tx hash (+ chain/token) and memo/order reference
- Cards: provider order/session id + status (PAID, CONFIRMED, etc)

## Lightning (Non-custodial)

Key clarification: Lightning does not support true push payments, but LNURL-pay and zaps can make the UX behave like "buyer pays merchant" in one direction.

Flow:
1. Buyer computes cart total locally.
2. Buyer pays merchant Lightning Address via their wallet (LNURL-pay / zap UX).
3. Buyer sends a payment proof payload to the merchant over Nostr messaging (see below).
4. Merchant verifies independently and fulfills later.

Important framing:
- Conduit creates payment intents, not invoices.
- Invoice creation happens on merchant infrastructure (or their wallet provider) and is not a product-layer concern.

## Stablecoins (True Push Payments)

Account-based rails support true buyer-side "push" payments.

Flow:
1. Merchant publishes stablecoin receiving metadata: address, accepted tokens, memo convention.
2. Buyer computes cart total locally.
3. Buyer sends stablecoin directly to merchant address with `memo = order_id` (or `cart_hash`, per convention).
4. Buyer sends tx hash + metadata to merchant over Nostr messaging.
5. Merchant verifies on-chain and fulfills later.

## Cards via Zaprite (Still One-Way, Reversible)

Cards are inherently reversible; order state should distinguish "paid but reversible" vs "final".

Flow:
1. Conduit links to a Zaprite hosted checkout (public link) or creates one via Zaprite API (requires private API key).
2. Buyer pays via card or Lightning on Zaprite.
3. Zaprite settles funds to the merchant's configured rails.
4. Zaprite sends webhook status to Conduit (PAID/CONFIRMED).
5. Conduit relays a paid receipt to the merchant over Nostr messaging.

Notes:
- Conduit still never touches funds.
- Card chargebacks/refunds are explicitly out of Core; model them as order-state transitions.

## Merchant Public Metadata (So Any Client Can Pay)

Minimum merchant-published payment metadata (on Nostr relays or an otherwise discoverable location):
- Lightning Address (LNURL-pay)
- Optional: hosted checkout URL(s) for card providers (public)
- Optional: stablecoin address + accepted tokens + memo convention
- Accepted payment methods (lightning, stablecoin, card)
- Default currency
- Order reference expectations (memo = order_id, etc)
- Merchant pubkey and a messaging endpoint (DM support)

Anything requiring secrets (API keys, private webhook URLs) must remain private.

## Where Payment Proof Is Sent

The buyer (or Conduit client) must send a receipt/proof payload to the merchant asynchronously over Nostr messaging.

At minimum, it should include:
- `order_id`
- `amount` + `currency`
- proof fields (rail-specific)

The merchant verifies the proof independently, then acknowledges/fulfills.

## Explicitly Out of Scope (Core)

- refunds, disputes, chargebacks automation
- partial payments / split tender
- subscriptions
- escrow

## Roadmap Implication

Core should explicitly include:

One-Way Checkout (Buyer-Initiated, Non-Custodial)
- buyer pays merchant directly via supported rail
- Conduit coordinates intent and proof only
- merchant acceptance is asynchronous


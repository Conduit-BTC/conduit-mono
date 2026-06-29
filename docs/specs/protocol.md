# Protocol Specification

This document defines the active protocol surface used by Conduit Market and Merchant Portal for products, ordering, payment requests/proofs, and buyer-merchant messaging.

References:

- NIP-17 message wrapping (gift wrap + seal): `docs/specs/market.md`, `docs/ARCHITECTURE.md`
- NIP-99 classified listing events and GammaMarkets `market-spec` product listings
- One-way checkout architecture note: `docs/knowledge/one-way-checkout-multi-rail-payments.md`
- External protocol references: `docs/knowledge/external-nostr-references.md`

Non-goals for the current client repository:

- key custody, key generation, escrow, refunds, or balance management
- broad NIP-46 product UX beyond the external-signer policy already allowed by architecture
- service-operated checkout automation
- making NIP-44 v3 the default send path before public draft/client references, signer support, and recipient capability detection exist
- replacing the current shared protocol helpers with route-local relay substrates

## Authentication

Conduit apps use external signers only.

| Signer path           | Status                  | Notes                                         |
| --------------------- | ----------------------- | --------------------------------------------- |
| NIP-07 browser signer | Current client support  | Required path for current interactive signing |
| NIP-46 remote signer  | Architecture-compatible | Product UX depends on explicit implementation |
| App-generated keys    | Prohibited              | No key custody or private-key storage         |

## Event Kinds

| Kind    | Name                         | Direction    | Notes                                                    |
| ------- | ---------------------------- | ------------ | -------------------------------------------------------- |
| `0`     | Profile metadata             | both         | NIP-01                                                   |
| `3`     | Contact list                 | both         | NIP-02 follow graph/trust context                        |
| `5`     | Deletion                     | merchant     | NIP-09 deletion for products/shipping options            |
| `13`    | Seal                         | both         | NIP-59 / NIP-17 inner encrypted envelope                 |
| `14`    | Private direct message       | both         | NIP-17 direct message kind                               |
| `16`    | Order message payload        | both         | Conduit payload, always wrapped/encrypted before publish |
| `1059`  | Gift wrap                    | both         | NIP-17 outer envelope                                    |
| `9734`  | Zap request                  | buyer        | NIP-57                                                   |
| `9735`  | Zap receipt                  | relay/wallet | NIP-57                                                   |
| `10002` | Relay list                   | both         | NIP-65 relay hints                                       |
| `10050` | Private message relays       | both         | NIP-17 recipient relay and encryption hints              |
| `30402` | Product listing              | merchant     | NIP-99 + GammaMarkets market-spec                        |
| `30406` | Shipping option              | merchant     | Conduit commerce extension                               |
| `31989` | Application recommendation   | both         | NIP-89                                                   |
| `31990` | Application handler metadata | app/operator | NIP-89                                                   |

## Product Identity

Product listings are addressable events:

```text
30402:<merchant_pubkey>:<d_tag>
```

Implementations must not dedupe only by `d` tag because different merchants can publish the same `d` value. Product identity, cart references, order item tags, and cache records should preserve the full addressable coordinate.

## Product Zap Policy Tags

Conduit-generated kind `30402` product listings include explicit checkout zap
policy metadata alongside the NIP-99/GammaMarkets product tags:

| Tag                           | Values                                           | Meaning                                                        |
| ----------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `checkout_public_zaps`        | `true` or `false`                                | Whether checkout may offer a public zap payment for this item. |
| `checkout_zap_message_policy` | `generic_only`, `product_reference`, or `custom` | The most permissive public zap comment the merchant allows.    |

Both tags are required for Conduit to treat a product's public-zap policy as
known. Missing tags, malformed values, or legacy JSON-content fields without
explicit tags leave `publicZapPolicyKnown=false`. Parser defaults used for
display or compatibility do not authorize public-zap checkout by themselves.

Current parsers may accept the legacy aliases `public_zaps` and
`zap_message_policy` for already-published listings, but newly emitted Conduit
events must use `checkout_public_zaps` and `checkout_zap_message_policy`.

Checkout privacy behavior:

- If any cart item has `checkout_public_zaps=false`, missing policy tags, or
  malformed policy tags, public zap payment is not offered for that cart.
- For carts where every item explicitly permits public zaps, the effective zap
  message policy is the most restrictive item policy:
  `generic_only` before `product_reference` before `custom`.
- Public zap request/comment text must not include order contents, cart
  contents, shipping details, contact data, invoices, payment request strings,
  or other private checkout data. `product_reference` may reference public
  listing context only.

## Client Hydration And Relay Hints

Conduit clients should render commerce content from cache/progressive reads first, then hydrate surrounding identity and trust context without blocking the product surface.

Source relay URLs and encoded reference relay hints are client-side fetch hints:

- relays that delivered product/profile events
- relay hints from `nprofile`, `nevent`, and `naddr` references
- cached product/profile `sourceRelayUrls`
- NIP-65 relay-list data already loaded by the shared planner

These hints may bias fanout for related reads such as merchant profile hydration, product detail refreshes, and order/message trust context. They do not replace the relay planner, NIP-65 handling, default relay policy, or user relay settings.

Page-level ownership:

- Market browse owns visible/background merchant profile hydration for product cards and store facets.
- Storefront and product detail routes can force a bounded profile retry because the user explicitly navigated to that merchant or listing.
- Orders, messages, checkout, and merchant order surfaces should batch profile lookups and avoid per-row retry loops.
- Deletion checks should not hide already available products while profile/social metadata is still hydrating.

UX contract:

- show cached or progressively fetched products as soon as they are usable
- show stable skeleton/pending states for merchant names and avatars while lookup is active
- after bounded lookup attempts settle empty, show a final fallback such as `Store npub...` without pending animation
- do not shift product grid layout when profile names, avatars, tag counts, or trust metadata hydrate

Implementation notes live in `docs/nips/` for compact agent preflight context. Canonical protocol behavior still comes from the public NIPs and GammaMarkets `market-spec`.

## Messaging Transport: NIP-17

Buyer-merchant communication is sent as NIP-17 encrypted messages:

- Inner payload: Conduit order message event, kind `16`
- General direct message payload: kind `14`
- Seal: kind `13`
- Gift wrap: kind `1059`

The kind `16` payload is never published directly. It is encrypted and delivered through NIP-17 wrapping. Kind `14` general DMs should remain separate from order-linked kind `16` conversations in product state.

Current private-message code may continue to interoperate with NIP-44 v2, which is the current public NIP-44 encryption version. Any newer encryption-version work must be source-gated until public draft/client references and capabilities are explicit.

New secure messaging work should route sends and unwraps through a shared `@conduit/core` boundary that:

- preserves NIP-44 v2 fallback for existing signers and peers
- keeps NIP-44 v3 readiness visible without making it the default send path before source and capability gates are satisfied
- parses kind `10050` private-message relay events enough to read recipient relay and encryption hints
- rejects authenticated-context mismatches instead of returning plaintext when versioned encryption support adds that requirement
- reports decrypt/unwrap diagnostics without plaintext, ciphertext, invoices, shipping/contact data, order contents, or message bodies

NWC remains NIP-44 v2 by default unless wallet capability discovery and public draft/client references explicitly justify a safer NIP-44 v3 path.

## Order Message Payload

Required tags for all message types:

- `["p", "<counterparty_pubkey_hex>"]`
- `["order", "<order_id>"]`
- `["type", "<type>"]`

Standard message types:

| `type`            | Direction         | Meaning                            |
| ----------------- | ----------------- | ---------------------------------- |
| `order`           | buyer -> merchant | Initial order intent and details   |
| `payment_request` | merchant -> buyer | Invoice or payment request payload |
| `payment_proof`   | buyer -> merchant | Buyer payment evidence             |
| `status_update`   | merchant -> buyer | Order state transition             |
| `shipping_update` | merchant -> buyer | Tracking or shipping update        |
| `receipt`         | merchant -> buyer | Final confirmation/receipt         |

### `order`

Tags:

- `["p", merchant_pubkey]`
- `["subject", "order-info"]` or compatible subject text
- `["type", "order"]`
- `["order", order_id]`
- `["amount", "<integer_sats>"]`
- one per item: `["item", "30402:<merchant_pubkey>:<product_d_tag>", "<quantity>"]`
- optional shipping selection: `["shipping", "30406:<merchant_pubkey>:<shipping_d_tag>"]`
- optional buyer contact/shipping tags as supported by the current checkout schema

Content:

- human-readable buyer note or compact JSON payload when required by the implementation schema

### `payment_request`

Tags:

- `["p", buyer_pubkey]`
- `["type", "payment_request"]`
- `["order", order_id]`
- `["amount", "<integer_sats>"]`
- `["payment_method", "lightning"]`

Content:

- BOLT11 invoice or structured JSON defined by the shared schema

### `payment_proof`

Tags:

- `["p", merchant_pubkey]`
- `["type", "payment_proof"]`
- `["order", order_id]`
- `["amount", "<integer_sats>"]`
- `["currency", "SAT"]`
- `["rail", "lightning"]`

Content:

```json
{
  "rail": "lightning",
  "proof": {
    "payment_hash": "optional",
    "zap_receipt_event_id": "optional",
    "preimage": "optional",
    "provider": "optional",
    "status": "optional"
  },
  "note": "optional"
}
```

Payment proof is receipt-style evidence attached to the order conversation. It does not imply Conduit custody or automatic dispute resolution.

### `status_update`

Tags:

- `["p", buyer_pubkey]`
- `["type", "status_update"]`
- `["order", order_id]`
- `["status", "pending" | "invoiced" | "paid" | "processing" | "shipped" | "complete" | "cancelled"]`

Content:

- optional human-readable message

### `shipping_update`

Tags:

- `["p", buyer_pubkey]`
- `["type", "shipping_update"]`
- `["order", order_id]`
- `["carrier", "<carrier>"]` optional
- `["tracking", "<tracking_number_or_url>"]` optional

Content:

- optional message

### `receipt`

Tags:

- `["p", buyer_pubkey]`
- `["type", "receipt"]`
- `["order", order_id]`

Content:

- optional minimal receipt details

## Payment Metadata

Merchant payment readiness may come from:

- Lightning Address / LNURL-pay data on profile metadata such as `lud16`
- NWC/WebLN setup in the merchant workspace
- order-specific payment requests

Fast checkout should stay gated by explicit merchant readiness and buyer payment capability. The manual invoice/payment-request path remains the fallback baseline.

## Versioning And Provenance

Conduit clients should expose version/source context and may emit optional provenance tags on outbound events where Conduit is the emitter, for example:

```text
["client", "conduit-merchant/<version>"]
["v", "<protocol_version>"]
```

Open-source client releases should remain rebuildable from the public repository without private production assets.

## Interoperability

Commerce interoperability is a priority. Prefer backwards-compatible tag additions over breaking schema changes.

Primary external reference:

- GammaMarkets market spec: https://github.com/GammaMarkets/market-spec

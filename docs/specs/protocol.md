# Protocol Specification

This document defines the active protocol surface used by Conduit Market and Merchant Portal for products, ordering, payment requests/proofs, and buyer-merchant messaging.

References:

- NIP-17 message wrapping (gift wrap + seal): `docs/specs/market.md`, `docs/ARCHITECTURE.md`
- One-way checkout architecture note: `docs/knowledge/one-way-checkout-multi-rail-payments.md`
- External protocol references: `docs/knowledge/external-nostr-references.md`

Non-goals for current Phase 2A:

- key custody, key generation, escrow, refunds, or balance management
- broad NIP-46 product UX beyond the external-signer policy already allowed by architecture
- service-operated checkout automation
- requiring any non-standard or future NIP-44 version before a public accepted source and signer support exist
- replacing the current NDK-backed protocol helpers with a new relay substrate before the future architecture spec lands

Future direction:

- Phase 2B is expected to define a stronger local-first commerce/read architecture.
- New source-aware relay work should avoid leaking NDK objects into durable records or product contracts, but current Phase 2A work may continue using the existing shared NDK-backed helpers where that is the least risky path.
- Phase 2A secure messaging should introduce a shared Conduit-owned NIP-17/NIP-44 boundary before adding more route-local private-message send paths.

## Authentication

Conduit apps use external signers only.

| Signer path           | Status                  | Notes                                         |
| --------------------- | ----------------------- | --------------------------------------------- |
| NIP-07 browser signer | Current client support  | Required path for current interactive signing |
| NIP-46 remote signer  | Architecture-compatible | Broad product UX is not a Phase 2A blocker    |
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

Implementations must not dedupe only by `d` tag because different merchants can publish the same `d` value. Product identity, cart references, order item tags, cache records, and future source-aware graph records should preserve the full addressable coordinate.

## Messaging Transport: NIP-17

Buyer-merchant communication is sent as NIP-17 encrypted messages:

- Inner payload: Conduit order message event, kind `16`
- General direct message payload: kind `14`
- Seal: kind `13`
- Gift wrap: kind `1059`

The kind `16` payload is never published directly. It is encrypted and delivered through NIP-17 wrapping. Kind `14` general DMs should remain separate from order-linked kind `16` conversations in product state.

Current private-message code may continue to interoperate with NIP-44 v2, which is the current public NIP-44 encryption version. New Phase 2A secure messaging work should route sends and unwraps through a shared `@conduit/core` boundary that:

- preserves NIP-44 v2 fallback for existing signers and peers
- treats any future NIP-44 version as source-gated until a public accepted source is linked from `docs/knowledge/external-nostr-references.md`
- parses kind `10050` private-message relay events enough to read recipient relay and encryption hints
- rejects authenticated-context mismatches instead of returning plaintext when versioned encryption support adds that requirement
- reports decrypt/unwrap diagnostics without plaintext, ciphertext, invoices, shipping/contact data, order contents, or message bodies

NWC remains NIP-44 v2 by default unless wallet capability discovery and an accepted public source explicitly justify a safer future-version path.

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
- future structured payment metadata after a separate spec is accepted

Current Phase 2A should keep fast checkout gated by explicit merchant readiness and buyer payment capability. The manual invoice/payment-request path remains the fallback baseline.

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

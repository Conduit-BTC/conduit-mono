# Protocol Specification (MVP)

This document consolidates the protocol surface used by Conduit Market and Merchant Portal for MVP ordering and messaging.

References:
- NIP-17 message wrapping (gift wrap + seal): `docs/specs/market.md`, `docs/ARCHITECTURE.md`
- One-way checkout architecture note: `docs/knowledge/one-way-checkout-multi-rail-payments.md`
- External protocol references: `docs/knowledge/external-nostr-references.md`

Non-goals (MVP):
- NIP-46 remote signer auth (post-MVP, Phase 6)
- Custom relay requirements (post-MVP, Phase 5)
- Conduit services automation (post-MVP, Phase 6)
- Refunds/disputes/escrow

## Post-MVP: Client App Versioning + Open Source Note

After MVP, prioritize client-facing versioning and compatibility tracking for:
- Conduit Market
- Merchant Portal
- Store Builder

Planned approach:
- Version each client app with SemVer and publish release notes for protocol-impacting changes.
- Maintain a lightweight compatibility matrix (client app version -> supported protocol profile/version tags).
- Emit optional provenance/version tags on outbound events where Conduit is the emitter (for example `["client","conduit-merchant/<version>"]` and `["v","<protocol_version>"]`).
- Continue parsing legacy/no-version events as backward-compatible defaults during migration windows.

Open-source direction:
- We should open-source client protocol integration layers and reference implementations once post-MVP release/security workflows are stable, in the spirit of Nostr ecosystem collaboration (similar to Plebeian Market being open and inspectable).

## Authentication

MVP requires external signing via NIP-07 (`window.nostr`) only.

## Messaging Transport: NIP-17 DMs

All buyer-merchant order communication is sent as NIP-17 DMs:
- Outer event: Kind `1059` (gift wrap)
- Inner event: Kind `13` (seal)
- Payload: JSON-serialized "order message" event (Kind `16`) encrypted with NIP-44

See also: `docs/specs/market.md` "NIP-17 Wrapping".

## Event Kinds (MVP)

| Kind | Name | Direction | Notes |
|------|------|-----------|------|
| `0` | Profile metadata | both | Merchant publishes store metadata; buyer may publish profile |
| `5` | Deletion | merchant | Used for product deletion |
| `10002` | Relay list | both | Optional; used to discover relays (NIP-65) |
| `30402` | Product listing | merchant | Replaceable addressable product event |
| `13` | Seal | both | NIP-17 inner encrypted envelope |
| `1059` | Gift wrap | both | NIP-17 outer envelope |
| `16` | Order message payload | both | JSON payload event, always sent via NIP-17 |

## Order Message Payload (Kind 16)

### High-level

The payload is a Kind `16` event that is never published directly. It is encrypted and delivered via NIP-17.

The `tags` determine the message type and its routing.

### Required tags (all types)

- `["p", "<counterparty_pubkey_hex>"]`
- `["order", "<order_id>"]`
- `["type", "<type>"]`

### Standard message types

| `type` | Direction | Meaning |
|--------|-----------|---------|
| `order` | buyer -> merchant | Initial order intent and details |
| `payment_request` | merchant -> buyer | Invoice request payload (baseline MVP) |
| `payment_proof` | buyer -> merchant | Buyer-initiated proof for one-way checkout (milestone) |
| `status_update` | merchant -> buyer | Order state transition |
| `shipping_update` | merchant -> buyer | Tracking details |
| `receipt` | merchant -> buyer | Final confirmation/receipt |

### `order` message schema (MVP)

Tags:
- `["p", merchant_pubkey]`
- `["subject", "order-info"]` (legacy uses `order-info`; newer docs sometimes use "New Order")
- `["type", "order"]`
- `["order", order_id]`
- `["amount", "<integer_sats>"]`
- one per item:
  - `["item", "30402:<merchant_pubkey>:<product_d_tag>", "<quantity>"]`
- optional shipping selection:
  - `["shipping", "30406:<shipping_event_id>:<method_id>"]` (legacy)
- optional buyer info:
  - `["address", "<string>"]`
  - `["phone", "<string>"]`
  - `["email", "<string>"]`

Content:
- human-readable message/note string

Notes:
- Legacy uses `["type","1"]` in one place; Conduit MVP should use the descriptive string `order` for clarity.
- Validation should use Conduit's internal Zod schemas in `@conduit/core` (best-effort parsing for interop), but the on-wire format must remain compatible with existing tags.

### `payment_request` message schema (baseline MVP)

Tags:
- `["p", buyer_pubkey]`
- `["type", "payment_request"]`
- `["order", order_id]`
- `["amount", "<integer_sats>"]` (recommended)
- `["payment_method", "lightning"]` (recommended)

Content:
- `bolt11` invoice string (recommended)
  - If content must be structured, JSON string is acceptable, but prefer plain bolt11 for interop.

### `payment_proof` message schema (one-way checkout milestone)

Tags:
- `["p", merchant_pubkey]`
- `["type", "payment_proof"]`
- `["order", order_id]`
- `["amount", "<integer_sats>"]`
- `["currency", "SAT"]` (or ISO code)
- `["rail", "lightning" | "stablecoin" | "card"]`

Content (JSON string):
```json
{
  "rail": "lightning",
  "proof": {
    "payment_hash": "optional",
    "zap_receipt_event_id": "optional",
    "tx_hash": "optional",
    "provider": "optional",
    "status": "optional"
  },
  "note": "optional"
}
```

Verification:
- Merchant verifies proof independently (manual in MVP).
- Automation is post-MVP (Conduit services).

### `status_update` message schema

Tags:
- `["p", buyer_pubkey]`
- `["type", "status_update"]`
- `["order", order_id]`
- `["status", "pending" | "invoiced" | "paid" | "processing" | "shipped" | "complete" | "cancelled"]`

Content:
- optional human-readable message

### `shipping_update` message schema

Tags:
- `["p", buyer_pubkey]`
- `["type", "shipping_update"]`
- `["order", order_id]`
- `["carrier", "<carrier>"]` (optional)
- `["tracking", "<tracking_number_or_url>"]` (optional)

Content:
- optional message

### `receipt` message schema

Tags:
- `["p", buyer_pubkey]`
- `["type", "receipt"]`
- `["order", order_id]`

Content:
- optional JSON receipt details (keep minimal for privacy)

## NIP-17 Wrapping (Implementation Notes)

Order payload flow:
1. Build a Kind `16` payload event
2. Encrypt payload JSON to the recipient with NIP-44
3. Put encrypted payload in a Kind `13` seal event, sign it
4. Generate an ephemeral keypair for the wrapper
5. Encrypt the seal event JSON to the recipient with NIP-44
6. Put that ciphertext into a Kind `1059` gift wrap event tagged with `["p", recipient_pubkey]`
7. Sign the gift wrap with the ephemeral key and publish

The legacy implementation uses NDK signer encryption (`nip44`) and publishes only the gift wrap.

## Merchant-Published Payment Metadata (One-Way Milestone)

For one-way checkout, merchants must publish payment handles that are publicly discoverable.

Minimum recommended fields:
- Lightning Address / LNURL-pay handle
- Accepted methods list (lightning, stablecoin, card)
- Default currency

Where to publish (MVP recommendation):
- Merchant Kind `0` profile fields for lightning address (e.g. `lud16`)
- Extend with a replaceable event later if/when we need structured multi-rail metadata across clients

## Interoperability Notes

De-commerce interoperability is a priority. Prefer backwards-compatible tag additions over breaking schema changes.

Primary external reference:
- GammaMarkets market spec: https://github.com/GammaMarkets/market-spec

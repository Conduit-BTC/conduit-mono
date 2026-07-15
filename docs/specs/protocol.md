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
- service-operated checkout automation, except the scoped Anon Conduit Shopper public zap signer described below
- making NIP-44 v3 the default send path before public draft/client references, signer support, and recipient capability detection exist
- replacing the current shared protocol helpers with route-local relay substrates

## Authentication

Conduit Market and Merchant Portal user authentication use external signers only.

| Signer path           | Status                  | Notes                                                   |
| --------------------- | ----------------------- | ------------------------------------------------------- |
| NIP-07 browser signer | Current client support  | Required path for current interactive signing           |
| NIP-46 remote signer  | Architecture-compatible | Product UX depends on explicit implementation           |
| App-generated keys    | Prohibited by default   | Only the bounded guest-order exception below is allowed |

### Client Ephemeral Guest Order Key Exception

Guest external-wallet checkout may create a per-order browser-generated key to
sign the outbound private order and any external-payment report delivered to the
merchant. This key is an order-scoped sender identity, not a Nostr inbox,
account authentication, durable account-key or server-side custody, merchant
signing, product publishing, wallet custody, or public zap signing.

The exception is constrained as follows:

- The key must be generated in the browser for one guest order and stored only
  in same-tab session storage for local checkout/payment recovery. The key and
  guest local lifecycle data use a 24-hour recovery deadline: signing and
  restoration are rejected after the deadline, and expired local rows are
  pruned on Market startup.
- The key must not be sent to Conduit services, exposed through `VITE_*`, logs,
  telemetry, PR comments, tracked files, or analytics.
- The guest contact/address draft must remain in expiring same-tab storage and
  be cleared as soon as the encrypted order reaches the merchant.
- The client may expose the key only to the signing path for the initial private
  order and same-order payment reports addressed to that order's merchant. This
  is an application boundary; the extractable raw key is not cryptographically
  restricted to those events.
- Guest clients must not publish a buyer self-copy, advertise a `kind:10050`
  inbox, poll for merchant replies, or cache the decrypted order payload as
  durable order history.
- Merchant clients must treat `buyerIdentityKind: "guest_ephemeral"` as
  outbound-only and use the required structured phone/email fields for
  invoices, fulfillment updates, and other follow-up.
- Same-session recovery means local invoice/payment-report continuity only. It
  does not promise merchant status recovery, a private conversation, or durable
  order history.
- This exception does not replace NIP-07/NIP-46 for signed-in buyers and does
  not broaden the Anon Conduit Shopper public zap signer exception.
- Converting, claiming, or recovering a guest order into a durable identity is
  outside this exception and outside the current client flow.

### Service Signer Exception: Anon Public Zaps

The Anon Conduit Shopper public zap signer is the only approved server-side
private-key exception in this repository. It exists to sign NIP-57 zap request
events (`kind:9734`) only for checkout flows where a merchant explicitly allows
public anonymous zaps.

This exception is constrained as follows:

- The private key must live only in the Cloudflare Worker runtime secret for
  `apps/anon-zap-signer`; it must not be exposed through `VITE_*`, Pages client
  env vars, logs, telemetry, PR comments, or tracked files.
- The Worker may sign only validated public zap request drafts that are bound to
  an authorized checkout session and a merchant/product zap policy that
  explicitly permits anonymous public zaps. Request tags and content must exclude
  order identifiers, cart contents, shipping/contact data, invoices, NWC URIs,
  plaintext messages, or other private checkout data.
- The trusted server boundary derives the anonymous zap amount from current,
  signed product listings and a fresh server-owned conversion quote when fiat
  pricing is present. Browser-provided totals are not authorization evidence.
- Anonymous request content is server-owned and limited to copy such as
  `Zapped out 1 item at https://shop.conduit.market/` or
  `Zapped out 4 items at https://shop.conduit.market/`, using the actual summed
  item quantity. Merchant `custom` policy never makes anonymous content
  shopper-editable.
- Before exposing or paying a NIP-57 invoice, clients must verify that its
  BOLT11 `h` tag equals SHA-256 of the exact signed kind-9734 JSON supplied to
  the LNURL callback. Missing, duplicate, malformed, or mismatched bindings
  fail closed for the public-zap claim. Before any invoice reaches a payment
  rail, that failure may continue the same order through a plain LNURL invoice
  with no `nostr` parameter. The ordinary invoice must still pass exact amount,
  network, and expiry validation. Optional public-zap infrastructure must not
  become a checkout availability dependency.
- Public zap-receipt presentation must validate both the outer kind-9735 and
  embedded kind-9734 signatures, then require request/receipt recipient, sender
  (when `P` is present), and amount tags to agree. Server-authorized anonymous
  requests include an `omf_provider` tag plus a server-issued `omf_auth` proof
  bound to the exact public request. The proof preserves checkout-time provider
  authority across Anon Shopper key rotation without trusting retired shopper
  keys. Other receipts use a same-origin server authority check only during a
  bounded payment-time window, with egress restricted to exact operator-allowed
  LNURL hosts and no persistent provider cache. Historical mutable evidence,
  profile/provider rotation, and lookup failure are authority-unavailable, not
  invalid; neither outcome is presented as paid. Browsers must not contact
  receipt-selected wallet domains.
- The authorization response includes the latest signed listing's public
  fulfillment format, shipping option identity, and country/postal rules.
  The browser evaluates the private destination locally against that current
  snapshot before signing; shipping/contact data is never sent to the signer.
- Browser `Origin` checks are not authentication. Calls that request signing
  must include server-side request authentication shared only between the
  calling server runtime and the signer Worker.
- Pages sends HMAC-pseudonymous authorization/authority bucket keys through an
  authenticated service binding to the signer Worker, which owns the supported
  Cloudflare Rate Limiting binding. Raw source and merchant identifiers must not
  be passed to that binding.
- Authentication and rate limiting protect unpaid authorization, signing, and
  lookup work. Abuse that requires a settled Lightning payment has an inherent
  attacker cost and does not justify blocking commerce with additional
  receipt-only availability gates.
- This exception does not authorize user key custody, merchant signing,
  buyer-auth signing, order messaging, NIP-17/NIP-44 payload signing, product
  listing publishing, or wallet/NWC custody.

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

| Tag                           | Values                     | Meaning                                                        |
| ----------------------------- | -------------------------- | -------------------------------------------------------------- |
| `checkout_public_zaps`        | `true` or `false`          | Whether checkout may offer a public zap payment for this item. |
| `checkout_zap_message_policy` | `generic_only` or `custom` | The most permissive public zap comment the merchant allows.    |

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
  `generic_only` before `custom`.
- Anonymous zap request text always uses the fixed server-owned item-count copy.
  The `custom` policy applies only to shopper-signed public zaps.
- Public zap request/comment text must not include order contents, cart
  contents, shipping details, contact data, invoices, payment request strings,
  product names, product identifiers, or other private checkout data unless the
  shopper writes a custom public comment.

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

# Messaging Specification

Secure buyer/merchant marketplace messaging (CND-57). Defines the shared
private-message boundary, the separation between general direct messages and
order-linked conversations, and the visible degraded/retry contract that keeps
undecryptable messages from silently disappearing.

References:

- Transport and event kinds: `docs/specs/protocol.md` ("Messaging Transport: NIP-17")
- Buyer surface: `docs/specs/market.md`
- Merchant surface: `docs/specs/merchant.md`
- Privacy rules: `docs/specs/privacy-observability.md`
- External sources: `docs/knowledge/external-nostr-references.md` (NIP-17, NIP-44, NIP-07)

Non-goals (per CND-57): public social inbox, comments, follows, reactions,
notifications, discovery feeds, NIP-29 groups, NIP-04 sending, message-content
telemetry, full Phase 2B durability/read-frontier work, and defaulting to
NIP-44 v3 before signer/library/ecosystem support exists.

## Two conversation types

Buyer-merchant communication is NIP-17 gift-wrapped (seal kind `13`, gift wrap
kind `1059`) in both cases. The inner rumor kind decides the conversation type:

- **General direct message — kind `14`.** An order-independent support
  conversation between two pubkeys. Threaded by **counterparty pubkey**, not by
  order. Free-text content.
- **Order-linked message — kind `16`.** A Conduit order message threaded by
  `["order", <order_id>]` with a `["type", ...]` tag (`order`, `payment_request`,
  `payment_proof`, `status_update`, `shipping_update`, `receipt`, `message`).
  Owned by the order lifecycle (`docs/specs/order-lifecycle.md`); rendered in the
  Orders surfaces, not the general inbox.

The two must stay distinct in product state and UI. A general-DM thread may link
back to the counterparty's orders, and an order conversation may show a compact
order-linked preview, but a kind-14 thread is never folded into an order and a
kind-16 order message never appears as a general DM.

### Kind-16 payload shape (CND-128)

The kind-16 order rumor currently carries a JSON payload in `content` with
structured order tags. The CND-128 interop audit outcome for this phase is to
**keep the JSON payload unchanged**. Any move toward GammaMarkets-style
human-readable content plus tags is a separate, interop-reviewed protocol PR and
must not be bundled with the messaging surfaces.

## Shared core boundary

All private-message construction, wrapping, unwrapping, classification, and
capability decisions live behind `@conduit/core` (`protocol/messaging.ts`).
Market and Merchant routes must not hand-roll NDK gift-wrap/unwrap logic.

The boundary provides:

- **Wrap + publish.** A single primitive builds the rumor (kind 14 or 16),
  gift-wraps it to the recipient and a sender self-copy, publishes via the shared
  relay planner (`recipient_event` intent, critical delivery), and writes the
  local cache. Order sends and general-DM sends use the same primitive with a
  different rumor kind.
- **Unwrap + classify.** Each inbound gift wrap resolves to one of:
  - `ok` with the decrypted rumor and a `category` of `order` (kind 16) or
    `direct` (kind 14);
  - `decrypt_failed` with the wrap event id and a coarse reason
    (`nip44_failed`, `nip04_failed`, `timeout`, `malformed`).
    Non-order, non-direct kinds are ignored. Decrypt failures are **retained and
    surfaced**, never collapsed to silence.
- **NIP-44 capability seam.** NIP-44 v2 is the default/fallback wire version.
  Signer capability is probed (`window.nostr.nip44`, optional `nip44v3`) so v3
  can be negotiated later, but v3 is **source-gated OFF** as a send default until
  public draft/client references and recipient capability detection are in place.
  Legacy NIP-04 remains **read-only** decrypt fallback; Conduit never sends NIP-04.
  NWC/NIP-47 wallet traffic stays on its wallet-supported version regardless.
- **Private-message relay hints (kind `10050`).** When a counterparty advertises a
  kind-10050 private-message relay list, its relays bias DM read/write planning.
  Absent a `10050`, planning falls back to NIP-65 relay lists and the configured
  DM inbox defaults; kind-10050 is an input, not the only routing model.

## Conversation model and cache

- General DMs are cached in the Dexie `messages` table
  (`id, senderPubkey, recipientPubkey, kind, content, createdAt, read`) and read
  cache-first so the inbox is usable under relay slowness.
- A single inbound gift-wrap read classifies once and routes kind-16 rumors to the
  order-message cache and kind-14 rumors to the general-DM cache, so the relay
  inbox is not read or unwrapped twice.
- General conversation summaries are keyed by counterparty pubkey and expose the
  latest message preview, unread state, and the query source/staleness meta.
  Buyer↔merchant is symmetric; the same list model serves both apps.

## Degraded / retry UX contract

Messaging surfaces must render explicit states, never silent gaps:

- **Loading** while the first read is in flight.
- **Stale / degraded** when data is served from cache or a non-primary source
  (surfaced from the query `meta`, not inferred).
- **Decrypt failed** when one or more gift wraps could not be unwrapped: show a
  visible, retryable degraded affordance that reports how many messages need
  retry. Retry re-attempts only the failed wrap ids (transient signer/timeout
  failures should recover without a full refetch).
- **Empty** as a distinct terminal state from loading and error.

Raw Nostr event detail (gift-wrap ids, seal internals, ciphertext) must not be
the primary UX. Prepared conversation state is rendered instead.

## Privacy

Diagnostics, logs, telemetry, and analytics must never include message content,
ciphertext, plaintext, order contents, invoices, shipping/contact data, NWC URIs,
signer secrets, or pubkeys beyond local UI need. Decrypt-failure reporting is
limited to wrap event ids, coarse reason categories, and retry state. This
follows `docs/specs/privacy-observability.md`.

## Validation / testing

- Classify kind-14 general vs kind-16 order-linked from unwrapped rumors.
- Map decrypt/unwrap failure into a visible degraded state; retry targets only
  failed wrap ids.
- Parse kind-10050 relay lists into recipient relay hints.
- Capability detection reports v2 as default and keeps v3 gated off.
- Send helper emits the correct rumor kind and tags for each conversation type.
- General conversations group by counterparty pubkey.
- No message text or encrypted payload reaches any telemetry/log path.
- Slow/missing relay readback still leaves cached conversations understandable.

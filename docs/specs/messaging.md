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

## Secure conversation types

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
kind-16 order message never appears as a general DM. Thread identity is also
transport-qualified: NIP-17 and legacy NIP-04 messages between the same pubkeys
are separate threads and must not be merged into one chronology.

### Kind-16 payload shape (CND-128)

Current Conduit writers and readers use the legacy kind-16 order rumor: JSON in
`content` plus explicit `p`, named `type`, and `order` tags. They do not write or
expect a GammaMarkets kind-17 payment-proof rumor or the proposed OMF kind `1327`.

This differs from the GammaMarkets wire format, whose kind-16 messages use
numeric `type` values and human-readable `content`, and whose payment proof uses
kind `17`. Conduit must not claim wire compatibility with that format merely
because both use kind `16` inside NIP-17.

Kind-16 classification must be collision-safe. A reader accepts the Conduit
order-message shape only when its required Conduit payload and explicit `p`,
`type`, and `order` tags validate. NIP-18 generic reposts, which also use kind
`16`, are ignored by the order-message lane rather than rendered as orders or
failures.

### Order-message migration gate (CND-191)

The OMF order-message proposal remains unaccepted. Until it is accepted, Conduit
preserves legacy kind-16 writes and must not enable a new-kind writer or
dual-write. Acceptance gates the migration sequence:

1. Add the accepted codec.
2. Add strict dual-read with semantic deduplication across legacy and accepted
   representations.
3. Enable the accepted writer only for peers with explicit capability evidence.
4. Retire legacy writes after compatibility evidence is sufficient, while
   retaining bounded legacy reads for recovery.

## Shared core boundary

All private-message construction, wrapping, unwrapping, classification, and
capability decisions live behind `@conduit/core` (`protocol/messaging.ts`).
Market and Merchant routes must not hand-roll NDK gift-wrap/unwrap logic.

The boundary provides:

- **Wrap + publish.** A single primitive builds the rumor (kind 14 or 16),
  gift-wraps it to the recipient and a sender self-copy, publishes via the shared
  secure-message relay planner, and writes the local cache. The recipient wrap is
  published exclusively to the recipient's declared kind-10050 relays; the
  sender self-copy is published exclusively to the principal's declared
  kind-10050 relays. Order sends and general-DM sends use the same primitive with
  a different rumor kind.
- **Unwrap + classify.** Each inbound gift wrap resolves to one of:
  - `ok` with the decrypted rumor and a `category` of `order` (kind 16) or
    `direct` (kind 14);
  - `decrypt_failed` with the wrap event id and a coarse reason
    (`nip44_failed`, `nip04_failed`, `timeout`, `malformed`).
    Non-order, non-direct kinds are ignored. Decrypt failures are **retained and
    surfaced**, never collapsed to silence.
- **NIP-44 capability seam.** NIP-44 v2 is the default wire version.
  Signer capability is probed (`window.nostr.nip44`, optional `nip44v3`) so v3
  can be negotiated later, but v3 is **source-gated OFF** as a send default until
  public draft/client references and recipient capability detection are in place.
  NWC/NIP-47 wallet traffic stays on its wallet-supported version regardless.
- **Secure-message relays (kind `10050`).** NIP-17 gift-wrap reads use only the
  principal's declared kind-10050 relays, and each gift-wrap write uses only the
  wrap recipient's declared kind-10050 relays. NIP-65, configured relay lists,
  commerce priority, and general relay defaults are not secure-message
  fallbacks. An absent, malformed, stale-unusable, or unavailable declaration is
  an explicit readiness/degraded state; the client does not attempt delivery or
  imply that the secure inbox is complete.

## Legacy NIP-04 read lane

Legacy NIP-04 kind-4 events have a separate, read-only recovery lane. Conduit may
fetch and decrypt them for historical access, but never publishes kind `4` and
never treats NIP-04 as a NIP-17 encryption or relay fallback. Its reads follow
the bounded legacy-read policy rather than the kind-10050 secure-message lane.

Legacy conversations remain transport-qualified as NIP-04 and are never merged
with NIP-17 threads between the same participants. Fetch, signer, and decrypt
failures must produce a visible degraded/retry state. Diagnostics remain
content-free and must not expose plaintext, ciphertext, or participant pubkeys.

## Conversation model and cache

- General DMs are cached in the Dexie `messages` table
  (`id, senderPubkey, recipientPubkey, kind, content, createdAt, read`) and read
  cache-first so the inbox is usable under relay slowness.
- A single inbound gift-wrap read classifies once and routes kind-16 rumors to the
  order-message cache and kind-14 rumors to the general-DM cache, so the relay
  inbox is not read or unwrapped twice.
- General conversation summaries are keyed by transport and counterparty pubkey
  and expose the latest message preview, unread state, and the query
  source/staleness meta.
  Buyer↔merchant is symmetric; the same list model serves both apps.

## Degraded / retry UX contract

Messaging surfaces must render explicit states, never silent gaps:

- **Loading** while the first read is in flight.
- **Stale / degraded** when data is served from cache or a non-primary source
  (surfaced from the query `meta`, not inferred).
- **Not ready / relay unavailable** when the required principal or recipient
  kind-10050 declaration is absent or its declared relays are unusable. Do not
  hide this state behind NIP-65 or configured-relay fallback.
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
- Resolve NIP-17 reads and writes exclusively through the applicable principal or
  recipient kind-10050 declaration; missing or unavailable declarations degrade
  visibly without NIP-65/config fallback.
- Capability detection reports v2 as default and keeps v3 gated off.
- Send helper emits the correct rumor kind and tags for each conversation type.
- Legacy kind-4 events are read-only, never published, and remain in
  transport-qualified threads separate from NIP-17.
- Kind-16 parsing accepts the validated Conduit shape, rejects NIP-18 generic
  repost collisions, and does not claim GammaMarkets wire compatibility.
- General conversations group by transport and counterparty pubkey.
- No message text or encrypted payload reaches any telemetry/log path.
- Slow/missing relay readback still leaves cached conversations understandable.

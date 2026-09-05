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
- External sources: `docs/knowledge/external-nostr-references.md` (NIP-17,
  NIP-42, NIP-44, NIP-07)
- Protected-read contract and rollout:
  `docs/knowledge/nip42-protected-read-rollout.md`

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
  published to the recipient's authoritative declared kind-10050 relays, except
  for the gated validated-kind-16 compatibility lane below. The sender self-copy
  remains declaration-only. Kind-14 general DMs never use compatibility writes.
  Order sends and general-DM sends use the same primitive with a different rumor
  kind.
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
- **Secure-message relays (kind `10050`).** Each gift-wrap write uses only the
  wrap recipient's declared kind-10050 relays, except the bounded validated
  order compatibility lane below. NIP-65, configured relay lists, commerce
  capability order, and general relay defaults are not secure-message write
  fallbacks.
  Kind `10002` never supplies a gift-wrap write target. A `signed_empty` or
  `malformed` declaration is an explicit blocking state that the client never
  overrides with retained relay tags.
- **Typed routing states (`protocol/private-message-routing.ts`).** Declaration
  discovery distinguishes signed frontier states (`declared`, `signed_empty`,
  `malformed`) from bounded observation outcomes (`not_observed`,
  `lookup_partial`, `lookup_unavailable`). The state is account-scoped and backed
  by durable declaration evidence rather than process memory alone. A complete
  bounded read with no event and no retained frontier is `not_observed`, not
  proof of global absence; an all-failed lookup is `lookup_unavailable`, and a
  partial empty read is `lookup_partial`. When signed evidence is retained, the
  observation outcome degrades freshness without replacing the dominant signed
  state.
- **Monotonic declaration frontier.** The durable record stores the exact
  validated signed event and source-relay observations. Frontier selection
  follows NIP-01: greater `created_at` wins and the lexicographically lowest id
  wins a timestamp tie. Re-observation unions provenance. Only a complete
  bounded-plan observation advances the durable freshness used after restart;
  partial or unavailable fanout cannot turn retained evidence fresh.
  The latest lookup outcome is stored separately, so a later complete-empty,
  partial, or unavailable read remains stale after restart but never erases the
  signed frontier. The current resolver totally orders valid events and does not
  emit a conflict state. Conflict is reserved as a fail-closed outcome only if a
  future richer evidence model validates an internal inconsistency after
  canonical ordering. Relay-settings changes expire freshness rather than
  deleting evidence.
- **Current versus last usable.** A newer `signed_empty` or `malformed` event
  becomes the current frontier and blocks every declaration-based write. The
  last usable declared relay set remains available only for permissive inbox
  reads and recovery. Without retained signed evidence, only a completed empty
  bounded read resolves to `not_observed`.
- **Pending declaration cutover.** An unsigned draft, cancelled signer flow, or
  missing required signature changes no route and removes no recovery behavior.
  After every required event is signed and durably staged, new writes use the
  pending declaration. For an ordinary Private inbox role change, previous valid
  inboxes remain a hidden read-only lane until exact pending-event readback from
  the bounded shared discovery set and expiry of a bounded, versioned
  stale-sender grace period. They are not current membership and never authorize
  writes. Explicit whole-setup removal excludes its URL from reads and writes
  immediately after staging, before ACK or readback, accepting the warned risk
  of missing stale-client sends.
- **Cross-client declaration discovery.** Declaration publish and repair use a
  bounded shared discovery set that unrelated Conduit clients query. Repair is
  confirmed only after the exact signed event is observed from that shared set;
  process priming, durable local persistence, or owner-only readback does not
  establish cross-client discoverability. A complete shared lookup that observes
  no declaration may expose explicit same-set redistribution only for a retained
  current `declared` event. Redistribution republishes that exact signed event
  without asking the signer to mint a newer replacement. Retained
  `signed_empty`/`malformed`, partial, and unavailable observations, plus any
  future reserved fail-closed conflict, remain retry-only.
- **Permissive inbox reads.** The principal's gift-wrap read plan is the union
  of their current or pending declared inboxes, eligible retained last-usable or
  cutover-recovery inboxes, an active bounded legacy migration-recovery record,
  and the bounded Conduit compatibility read set. A fully staged whole-setup
  removal is excluded immediately. General NIP-65 membership never adds an
  inbox read target. Wraps are deduplicated by outer wrapper and inner rumor ids,
  and found or cached messages stay visible under partial failure. Reads report
  `complete`, `partial`, or `unavailable` coverage and an explicit source such as
  `declared`, `pending_declared`, `cutover_recovery`, `migration_recovery`,
  `compatibility`, `mixed`, or `cache`.
- **Legacy inbox-read recovery.** Capturing the bounded read-only secure-IN
  recovery record is independent of NIP-65 draft import. A valid signed
  `kind:10002` suppresses the draft but does not end recovery. The record is not
  current membership and never authorizes writes. It ends only after a usable
  `kind:10050` replacement with one to three secure relays is fully signed and
  durably staged, or after explicit discard recorded by a durable local
  migration tombstone.
- **Protected inbox execution.** The shared inbox path executes the principal's
  own `kind:1059`, `#p`-scoped filters through the NDK-neutral protected relay
  executor. The explicit account/session authorization boundary accepts only
  the active NIP-07 or NIP-46 signer; guest and anonymous sessions are rejected
  before connecting or signing. Public reads carry no NIP-42 account proof and
  never prompt a signer, but queried relays still see request filters and
  ordinary connection metadata. Authentication challenge/OK/retry state and
  per-relay failures are preserved as typed observations without putting
  challenge or account identifiers in logs or telemetry. NDK remains only at
  the existing signer and gift-unwrap edges.
- **Validated-order compatibility routing (temporary, CND-208).** When a validated
  kind-16 order-lifecycle send finds no usable recipient declaration, the write
  may use a maximum of three relays from the explicit private-inbox
  compatibility registry. A signed recipient NIP-65 read list may rank matches
  inside that registry but cannot widen it. Kind-14 general DMs never use this
  lane; a valid declaration always outranks it. A one-use order scope binds the
  rumor, order, sender, and recipient. The lane is recipient-only:
  the non-critical sender self-copy leg stays strict and fails soft. A
  bounded complete-empty observation never erases a retained signed frontier.
  A current `signed_empty` or `malformed` frontier still blocks the lane, and a
  current `declared` frontier still outranks it. See `docs/specs/protocol.md` and
  `docs/knowledge/nip17-inbox-bootstrap-migration.md`.

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
  hide this state behind NIP-65 or configured-relay fallback. Distinguish
  lookup failure (`lookup_partial` / `lookup_unavailable`, retryable), bounded
  complete-empty discovery (`not_observed`), a signed no-inbox frontier
  (`signed_empty`), and structurally unusable signed evidence (`malformed`).
  Setup and repair are owned by the Network surface, and Messages/Orders link
  there instead of publishing declarations. A stale retained signed state shows
  a retry affordance; retained last-usable relays are labeled as historical
  evidence rather than current write targets. Hidden cutover and migration
  recovery lanes never appear as current membership or authorize writes. Only
  complete shared-empty discovery exposes explicit redistribution of an
  unchanged declaration.
- **Decrypt failed** when one or more gift wraps could not be unwrapped: show a
  visible, retryable degraded affordance that reports how many messages need
  retry. Retry re-attempts only the failed wrap ids (transient signer/timeout
  failures should recover without a full refetch).
- **Empty** as a distinct terminal state from loading and error.

An inbox is empty only when every required relay attempt in its bounded read
plan reaches successful EOSE with no unresolved auth, connection, or protocol
failure. One success plus one auth or transport failure is degraded/partial;
all failures are unavailable. Cached conversations remain visible as
stale/degraded in either case. An auth rejection, missing challenge, signer
failure, `restricted:` close, or reconnect failure must never render "No
messages" or "No orders" by itself.

Raw Nostr event detail (gift-wrap ids, seal internals, ciphertext) must not be
the primary UX. Prepared conversation state is rendered instead.

## Privacy

Diagnostics, logs, telemetry, and analytics must never include message content,
ciphertext, plaintext, order contents, invoices, shipping/contact data, NWC URIs,
signer secrets, or pubkeys beyond local UI need. Decrypt-failure reporting is
limited to wrap event ids, coarse reason categories, and retry state. This
follows `docs/specs/privacy-observability.md`.

Protected-read diagnostics additionally exclude NIP-42 challenges, auth events,
signatures, full filters, authenticated socket material, and stable
account-derived session identifiers. Auth capability presentation must
distinguish untested, NIP-11-advertised, challenge-observed, succeeded, and
rejected/unavailable evidence. NIP-11 advertisement is not proof of successful
authentication or recipient enforcement.

Shared acceleration, cache, index, and routing infrastructure may derive only
from relay-visible state and must never expose a hidden API for private message
content or ciphertext, order contents, payment or invoice data, signer or auth
material, wallet credentials or recovery material, or wallet balances.

## Validation / testing

- Classify kind-14 general vs kind-16 order-linked from unwrapped rumors.
- Map decrypt/unwrap failure into a visible degraded state; retry targets only
  failed wrap ids.
- Resolve NIP-17 writes exclusively through the recipient kind-10050
  declaration; only validated kind-16 order sends may use the flagged bounded
  compatibility plan, and kind-14 is excluded from it. One relay ACK is a
  successful partial delivery; zero ACKs is an explicit failure.
- Declaration discovery separates `not_observed`, `lookup_partial`,
  `lookup_unavailable`, `signed_empty`, and `malformed`; permissive reads keep
  retained and partial results visible with coverage and source provenance.
- Retained evidence survives restart and settings changes, follows NIP-01
  frontier ordering, and cannot be erased by complete-empty, partial, or
  unavailable observations.
- A newer `signed_empty` or `malformed` frontier blocks writes while the last
  usable declaration remains read-only recovery evidence.
- Declaration repair confirms the exact signed event through the bounded shared
  discovery set rather than accepting local priming or owner-only readback.
- Partial and unavailable declaration observations do not advance durable
  complete-plan freshness across restart, and later degraded lookup evidence is
  retained. Complete shared-empty discovery may permit exact-event same-set
  redistribution; it never signs a new replacement. Partial or unavailable
  observations and any future reserved fail-closed conflict do not authorize
  it.
- Capability detection reports v2 as default and keeps v3 gated off.
- Send helper emits the correct rumor kind and tags for each conversation type.
- Legacy kind-4 events are read-only, never published, and remain in
  transport-qualified threads separate from NIP-17.
- Kind-16 parsing accepts the validated Conduit shape, rejects NIP-18 generic
  repost collisions, and does not claim GammaMarkets wire compatibility.
- General conversations group by transport and counterparty pubkey.
- No message text or encrypted payload reaches any telemetry/log path.
- Slow/missing relay readback still leaves cached conversations understandable.
- Public reads never call the auth signer; protected reads accept NIP-07 and
  NIP-46 and reject guest/cross-recipient filters before connection. When a
  current challenge exists, they authenticate, wait for the matching `OK`, and
  retry with a new subscription id. Under `when_challenged`, a relay that sends
  no challenge may complete the initial protected request without NIP-42.
- Deterministic relay tests cover challenge timing, negative/unrelated/missing
  `OK`, signer failures, reconnect, bounded challenge loops, `restricted:`
  responses, multi-relay partial success, account isolation, cleanup, and the
  complete-empty versus unavailable distinction. The canonical matrix lives in
  `docs/knowledge/nip42-protected-read-rollout.md`.

# Protocol Specification

This document defines the active protocol surface used by Conduit Market and Merchant Portal for products, ordering, payment requests/proofs, and buyer-merchant messaging.

References:

- NIP-17 message wrapping (gift wrap + seal): `docs/specs/market.md`, `docs/ARCHITECTURE.md`
- NIP-99 classified listing events and GammaMarkets `market-spec` product listings
- NIP-52 calendar events plus Open Markets / Gamma product collections and
  pickup options, as bounded by `docs/specs/event-markets.md`
- One-way checkout architecture note: `docs/knowledge/one-way-checkout-multi-rail-payments.md`
- External protocol references: `docs/knowledge/external-nostr-references.md`
- Protected relay reads and rollout:
  `docs/knowledge/nip42-protected-read-rollout.md`

Non-goals for the current client repository:

- durable Nostr user account-key custody or generation, server-side wallet
  custody, escrow, or refunds
- server-managed NIP-46 account custody or signer recovery beyond the current
  external-signer flow
- service-operated checkout automation, except the scoped Anon Conduit Shopper public zap signer described below
- making NIP-44 v3 the default send path before public draft/client references, signer support, and recipient capability detection exist
- replacing the current shared protocol helpers with route-local relay substrates

## Authentication

Conduit Market and Merchant Portal user authentication use external signers only.

| Signer path           | Status                 | Notes                                                   |
| --------------------- | ---------------------- | ------------------------------------------------------- |
| NIP-07 browser signer | Current client support | Required path for current interactive signing           |
| NIP-46 remote signer  | Current client support | Uses a revocable encrypted browser-local client key     |
| App-generated keys    | Prohibited by default  | Only the bounded guest-order exception below is allowed |

### Relay Read Authentication

NIP-42 is used only for an explicitly protected relay operation. The first
protected operation is the active principal reading their own `kind:1059` gift
wraps with filters constrained to `#p` equal to the active account pubkey.
Product, profile, declaration, relay-list, and other public reads remain
free of NIP-42 account proof and must not trigger a signer prompt. This is not
network anonymity: each queried relay sees the request filters, and relays,
hosts, and transport providers may observe ordinary connection metadata such as
source IP, destination, timing, and traffic volume.

The protected-read executor owns plain Nostr request/event contracts,
WebSockets, subscription lifecycles, authentication, reconnects, validation,
and typed per-relay outcomes without importing NDK. NIP-07 and NIP-46 are the
only eligible account signer adapters. Guest-order keys and unsigned sessions
cannot authenticate and have no fallback. NDK remains a named edge adapter for
existing signer and gift-wrap/unwrap work; protected reads must not deepen its
relay ownership.

Authenticated connections are isolated by normalized relay URL and a random,
process-local account-session scope. They are never shared with public reads
or another account, and are closed on logout, account/signer change, relay
removal/read disable, settings-scope change, auth failure, and reconnect.

When a protected connection has a current relay `AUTH` challenge, the client
creates kind `22242` with empty content, current time, and exact `relay` and
`challenge` tags, waits for the matching positive `OK`, then retries the
protected `REQ` with a new subscription id. Under the current client-first
`when_challenged` policy, a connection with no challenge receives an initial
protected `REQ` and may complete without NIP-42 when the relay permits it.
Challenge-before-request and challenge-plus-`auth-required:`-close are both
supported. Negative/missing `OK`, signer failure, `restricted:` close, repeated
challenges, reconnects, and timeouts have bounded typed outcomes rather than
becoming EOSE or empty data. Client support does not prove that a relay requires
or correctly enforces recipient authentication.

Across relays, valid results survive another relay's auth failure and coverage
is `partial`. All auth/unavailable failures are `unavailable`, never empty.
Zero messages is terminal only when every required attempt for the bounded plan
completes successfully with EOSE. Cached messages remain visible as
stale/degraded after an incomplete authenticated refresh.

The exact state machine, observation/privacy constraints, recipient-scoped
relay policy, validation matrix, and client-first rollout/rollback contract are
defined in `docs/knowledge/nip42-protected-read-rollout.md`.

Portable Wallet credentials are not Nostr authentication keys. A client-side
Portable Wallet provider may create or restore a separate self-custodial wallet
seed under the requirements in `docs/specs/wallets.md`; this does not authorize
generation, storage, or access to a user's Nostr account key.

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
  order, same-order payment reports, and one fixed, recipient-only advisory
  `kind:14` order notification addressed to that order's merchant after the
  authoritative order receives a relay acknowledgement. The advisory requires
  the merchant's declared inbox, must not use compatibility routing, and must
  contain no order, payment, contact, address, or item details. This is an
  application boundary; the extractable raw key is not cryptographically
  restricted to those events. Its review link must target the Merchant
  deployment paired with the Market deployment that created it; production,
  preview, signet, and supported local environments must not cross-link.
- Conduit clients must not project canonical advisory rumors carrying the exact
  versioned `["conduit", "order-companion", "1", "<kind-16-id>"]` marker, the
  `subject=conduit-order-notification` marker, and one non-empty `order` and `p`
  tag, exact fixed notification copy and review URL, and no extra tags into the
  generic Messages inbox or cache them as conversations only when
  they also carry Conduit Market client attribution and match an authoritative
  order event from the same sender to the same recipient. Missing, malformed,
  duplicated, unknown-version, or non-Conduit Merchant review URLs fail open to
  the generic Messages inbox and cache. A complete canonical marker without its
  matching order is visible but remains pending and is not counted as unread,
  so independent relay propagation can reconcile it when the order arrives
  later. It may be cached read-only with typed canonical provenance, then
  removed when matching authoritative order evidence exists; ambiguous legacy
  plaintext-only rows remain visible. The encrypted relay event remains
  available to external clients for local notification behavior.
- Guest clients must not publish a buyer self-copy, advertise a `kind:10050`
  inbox, poll for merchant replies, or cache the decrypted order payload as
  durable order history.
- Merchant clients must treat `buyerIdentityKind: "guest_ephemeral"` as
  outbound-only and use the structured recovery channel required by the exact
  checkout flow for invoices, fulfillment updates, and other follow-up. Pickup
  requires at least one of email or phone; shipping retains its stricter
  address/contact contract.
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
  requests include an `omf_auth` proof bound to the exact public request. During
  checkout, the browser resolves the merchant's LNURL provider directly and
  requires its callback, receipt pubkey, amount range, and encoded LNURL to
  agree with the server-authorized request before signing or invoice creation.
  Provider metadata is not accepted from the authorization response. Public
  receipt presentation uses a same-origin server authority check only during a
  bounded payment-time window, with egress restricted to exact operator-allowed
  LNURL hosts and no persistent provider cache. Historical mutable evidence,
  profile/provider rotation, and lookup failure are authority-unavailable, not
  invalid; neither outcome is presented as paid. Feed browsers must not contact
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
| `4`     | Legacy encrypted DM          | read-only    | NIP-04 recovery; never published by Conduit              |
| `5`     | Deletion                     | merchant     | NIP-09 deletion for products/shipping options            |
| `13`    | Seal                         | both         | NIP-59 / NIP-17 inner encrypted envelope                 |
| `14`    | Private direct message       | both         | NIP-17 direct message kind                               |
| `16`    | Order message payload        | both         | Conduit payload, always wrapped/encrypted before publish |
| `1059`  | Gift wrap                    | both         | NIP-17 outer envelope                                    |
| `9734`  | Zap request                  | buyer        | NIP-57                                                   |
| `9735`  | Zap receipt                  | relay/wallet | NIP-57                                                   |
| `10002` | Relay list                   | both         | NIP-65 relay hints                                       |
| `10050` | Private message relays       | both         | NIP-17 secure-message relay declarations                 |
| `22242` | Relay authentication         | client       | NIP-42 connection-bound auth event                       |
| `30402` | Product listing              | merchant     | NIP-99 + GammaMarkets market-spec                        |
| `30405` | Product collection           | organizer    | Open Markets / Gamma market-spec                         |
| `30406` | Shipping or pickup option    | both         | Open Markets / Gamma market-spec                         |
| `31922` | Date-based calendar event    | organizer    | NIP-52                                                   |
| `31923` | Time-based calendar event    | organizer    | NIP-52                                                   |
| `31989` | Application recommendation   | both         | NIP-89                                                   |
| `31990` | Application handler metadata | app/operator | NIP-89                                                   |

## Product Identity

Product listings are addressable events:

```text
30402:<merchant_pubkey>:<d_tag>
```

Implementations must not dedupe only by `d` tag because different merchants can publish the same `d` value. Product identity, cart references, order item tags, and cache records should preserve the full addressable coordinate.

Fixed physical products follow `docs/specs/fixed-product-shipping.md`: Merchant
publishes and receives a relay acknowledgement for one complete,
product-scoped Gamma kind `30406` before publishing the kind `30402` that
references it. New product writes use an exact two-field `shipping_option` tag
and do not emit legacy inline shipping tags or product-level extra cost.

Product parsers preserve repeated Open Markets `shipping_option` and kind-30405
collection references. A current app workflow may select one fulfillment mode,
but that UI limit must not discard protocol evidence received from other
clients.

## Event Markets And Local Pickup

The event-market protocol graph, organizer authority, `naddr` import, publish
ordering, failure states, and pickup checkout snapshot are defined in
`docs/specs/event-markets.md`. Implementations must not apply experimental
shipped-destination predicates to fixed-location pickup.

### Product Deletion Frontier

Validated kind `5` evidence is resolved before selecting the winning kind
`30402` version. An author-scoped `e` tag removes its exact event ID regardless
of relative timestamps. An author-scoped full `a` coordinate removes versions
whose `created_at` is less than or equal to the deletion event timestamp; a
genuinely newer version remains eligible. Missing or malformed legacy address
metadata never authorizes an inferred or broader coordinate deletion.

Local and remotely observed signed tombstones are durable, monotonic evidence
shared by catalog, storefront, detail, batch, progressive, and cache reads.
Relay omission does not revoke evidence. Progressive callbacks expose resolved
frontier snapshots so a later tombstone can retract an earlier product.

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

The kind `16` payload is never published directly. It is encrypted and delivered through NIP-17 wrapping. Kind `14` general DMs remain separate from order-linked kind `16` conversations in product state.

Kind `10050` declarations are authoritative for NIP-17 transport routing.
Gift-wrap writes, including a sender self-copy, target that wrap recipient's
declared secure-message relays unless the validated kind-16 compatibility
exception below is enabled by the deployment profile. Kind `14` never uses that
exception. NIP-65, configured relay lists, commerce capability order, and
general relay defaults are not secure-message write fallback routes. In
particular, a recipient's kind `10002` event may inform bounded discovery or
rank an already eligible compatibility target, but it never supplies a
gift-wrap write target.

After every event required by an ordinary Network update is signed and durably
staged, gift-wrap writes use the pending `kind:10050` declaration immediately.
The previous valid inbox set becomes a hidden read-only recovery lane until the
exact pending event is read back from the bounded shared discovery set and a
bounded, versioned stale-sender grace period expires. That prior set is not
current membership and never authorizes writes. An explicit whole-setup relay
removal instead cuts that URL out of all reads and writes immediately after all
required signatures are staged, even before ACK or readback. An unsigned draft,
cancelled signer flow, or missing signature changes no route and removes no
recovery behavior.

Declaration evidence is durable, account-scoped, and monotonic. The shared
protocol boundary retains the exact validated signed kind `10050` event, its
relay-tag interpretation, the relay sources that returned that event, and the
most recent observation time. A separate complete-plan observation time is
advanced only when every relay in the bounded lookup plan completes; partial or
unavailable fanout never makes the frontier fresh after restart. The latest
bounded lookup time, coverage, and whether it returned the current event are
stored separately; a later empty or incomplete lookup remains degraded across
process restart. Bounded lookup coverage does not overwrite the signed frontier.
Invalid signatures, event ids, kinds, or authorship are rejected before the
evidence frontier is updated. As a NIP-01 replaceable event, the winning frontier
has the greatest `created_at`; when timestamps tie, the lexicographically lowest
event id wins. Re-observing the same event unions its source-relay provenance
instead of creating a new version. The current resolver therefore has no
reachable conflict state for valid events. A conflict outcome is reserved for a
future richer evidence model that can validate a post-ordering internal
inconsistency, and it fails closed.

The current frontier and the last usable declared relay set are retained
separately. Declaration resolution exposes signed frontier states and bounded
observation-only states:

- `declared`: the winning signed event contains at least one usable secure
  `wss://` relay tag;
- `signed_empty`: the winning cryptographically valid signed event contains no
  `relay` tags, preserving an explicit signed no-inbox state separately from
  malformed input; it is not a usable NIP-17 declaration;
- `malformed`: a cryptographically valid signed event contains declaration data
  but its relay-tag shape cannot be interpreted safely, including an all-invalid
  relay-tag set;
- `not_observed`: the bounded discovery plan completed without an event and no
  signed frontier is retained;
- `lookup_partial`: only part of the bounded discovery plan completed;
- `lookup_unavailable`: none of the bounded discovery plan completed.

A complete-but-empty, partial, or unavailable lookup never deletes or
downgrades stronger retained signed evidence. With a retained frontier, those
observations make the resolution stale or degraded while preserving its
dominant signed state. A newer `signed_empty` or `malformed` frontier blocks
writes, but its retained last-usable relays may still support permissive inbox
reads. Relay-settings changes expire freshness and trigger rediscovery; they do
not delete account evidence.

Declaration publishing and repair use a bounded shared discovery set that is
stable across Conduit clients, in addition to bounded owner-selected
distribution targets. Repair is cross-client confirmed only when the exact
signed event is read back from the shared discovery set with source provenance;
an in-memory prime, durable local record, or owner-only relay readback is not
confirmation that another client can discover it. If that shared plan completes
without observing a retained current `declared` frontier, Network may explicitly
redistribute that exact signed event to the same relay set. A retained
`signed_empty` or `malformed` frontier remains retry-only until it is observed
directly; the client cannot safely mint a replacement from an empty bounded
view. Redistribution never signs a new replacement or advances its
`created_at`; a bounded empty view cannot prove that another client has not
published a newer event elsewhere. Partial and unavailable observations, plus
any future reserved fail-closed conflict, are retry-only and never authorize
that repair.

Gift-wrap reads are permissive: the principal reads the union of their valid
current or pending declared inboxes, eligible hidden cutover-recovery inboxes,
an active bounded legacy migration-recovery record, and the bounded
Conduit-operated compatibility read set. Whole-setup removals are excluded as
soon as all required signatures are staged. General NIP-65 membership never
adds an inbox read target. Read results carry coverage
(`complete | partial | unavailable`) and source provenance; an all-failed read
must never be reported as an authoritative empty inbox.

Legacy inbox-read recovery is independent of NIP-65 draft import. A signed
`kind:10002` suppresses legacy NIP-65 draft import but does not remove the
bounded read-only secure-IN recovery record. That record never authorizes writes
and ends only after a usable `kind:10050` replacement with one to three secure
relays is fully signed and durably staged, or after explicit discard recorded by
a durable local migration tombstone.

Shared acceleration, cache, index, and routing systems may derive only from
relay-visible state and must remain rebuildable rather than becoming hidden
network authority. They must never expose a hidden API for private message
content or ciphertext, order contents, payment or invoice data, signer or auth
material, wallet credentials or recovery material, or wallet balances.
Device-local user caches remain within their existing account and device
boundary and do not authorize copying private material into shared derived
infrastructure.

### Temporary exception: validated-order compatibility routing (CND-208)

A named, bounded, Conduit-owned exception exists while users migrate to valid
kind `10050` declarations. It is not NIP-17-conformant routing and must not be
presented as an extension of NIP-17. NIP-44/NIP-59 encryption is preserved.

- Scope: validated kind `16` order-lifecycle messages only. Kind `14` general
  DMs never use this lane.
- Writes: only when the recipient has no usable declaration. Eligible relays
  are the secure intersection of the operator-approved compatibility-write
  registry and relays Conduit inbox readers poll. Recipient NIP-65 read relays
  may reorder matching eligible entries but can never add a relay. The stable
  result is normalized, deduplicated, and capped at three.
- Arbitrary NIP-65, legacy local settings, product provenance, NIP-89 hints,
  commerce evidence, wrapper sources, and other public relays are never
  compatibility write targets.
- A current `declared` kind `10050` frontier always outranks the compatibility
  lane; a newly observed declared frontier returns subsequent writes to the
  declared route. A retained last-usable relay set under a newer `signed_empty`
  or `malformed` frontier is read evidence only and never authorizes writes or
  compatibility.
- The same recipient gift wrap is attempted on every planned target. One ACK is
  successful delivery with partial diagnostics and retry state for non-ACKed
  targets; zero ACKs is an explicit failure. ACK means relay acceptance, not
  recipient pickup.
- The lane requires a one-use validated-order scope bound to rumor id, order
  id, sender, and recipient. A caller boolean cannot authorize it.
- The lane ships through the repo-owned deployment profile. Preview enables it
  for review; production and staging remain independently false by default.
- Rationale, owner, evidence, and the removal checklist live in
  `docs/knowledge/nip17-inbox-bootstrap-migration.md`.

Current private-message code may continue to interoperate with NIP-44 v2, which is the current public NIP-44 encryption version. Any newer encryption-version work must be source-gated until public draft/client references and capabilities are explicit.

New secure messaging work should route sends and unwraps through a shared `@conduit/core` boundary that:

- preserves NIP-44 v2 as the default for existing signers and peers
- keeps NIP-44 v3 readiness visible without making it the default send path before source and capability gates are satisfied
- keeps kind `10050` authoritative and applies the separately gated, bounded
  validated-kind-16 compatibility lane only under the rules above
- rejects authenticated-context mismatches instead of returning plaintext when versioned encryption support adds that requirement
- reports decrypt/unwrap diagnostics without plaintext, ciphertext, invoices, shipping/contact data, order contents, or message bodies

NWC remains NIP-44 v2 by default unless wallet capability discovery and public draft/client references explicitly justify a safer NIP-44 v3 path.

### Legacy NIP-04 read lane

Conduit supports kind-4 NIP-04 only as a separate, bounded, read-only recovery
lane. It never publishes kind `4`, never uses NIP-04 as a NIP-17 fallback, and
never merges a legacy thread with a NIP-17 thread between the same participants.
Conversation identity is transport-qualified. Legacy fetch, signer, and decrypt
failures must remain visible and retryable, while logs and diagnostics remain
content-free.

## Legacy Conduit Order Message Payload (CND-128)

Current Conduit writers and readers use kind `16` with JSON `content` and
explicit `p`, named `type`, and `order` tags. There is no current Conduit kind
`17` payment-proof writer and no proposed OMF kind-`1327` writer.

This legacy format is not wire-compatible with the GammaMarkets order-message
format. GammaMarkets uses numeric kind-16 `type` values, human-readable
`content`, and kind `17` for payment proof. Shared use of kind `16` and NIP-17
transport must not be presented as wire compatibility.

Readers must discriminate kind-16 collisions before order parsing. A kind-16
rumor is a Conduit order message only when its JSON payload and required explicit
`p`, `type`, and `order` tags validate as the Conduit shape. NIP-18 generic
reposts, which also use kind `16`, are ignored by this lane and must not become
orders, messages, or user-visible parse failures.

### Migration gate (CND-191)

The OMF order-message proposal remains unaccepted. Conduit must preserve legacy
writes and must not enable a new-kind writer or dual-write before acceptance.
After acceptance, migration proceeds in this order:

1. Add a codec for the accepted format.
2. Add strict dual-read and semantic deduplication across accepted and legacy
   representations.
3. Enable the accepted writer only when peer capability is explicit.
4. Retire legacy writes after compatibility evidence is sufficient, while
   retaining bounded legacy reads for recovery.

### Current tags and message types

Required tags for all message types:

- `["p", "<counterparty_pubkey_hex>"]`
- `["order", "<order_id>"]`
- `["type", "<type>"]`

Standard message types:

| `type`                             | Direction             | Meaning                                 |
| ---------------------------------- | --------------------- | --------------------------------------- |
| `order`                            | buyer -> merchant     | Initial order intent and details        |
| `payment_request`                  | merchant -> buyer     | Invoice or payment request payload      |
| `payment_proof`                    | buyer -> merchant     | Buyer payment evidence                  |
| `status_update`                    | merchant -> buyer     | Order state transition                  |
| `shipping_update`                  | merchant -> buyer     | Tracking or shipping update             |
| `receipt`                          | merchant -> buyer     | Final confirmation/receipt              |
| `organizer_fulfillment_receipt`    | merchant -> organizer | Minimal ready-for-pickup delegation     |
| `organizer_fulfillment_revocation` | merchant -> organizer | Revoke one ready receipt before handoff |
| `organizer_handoff_ack`            | organizer -> merchant | Scoped physical-handoff acknowledgement |

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

- legacy JSON payload defined by the shared Conduit schema, including any buyer
  note represented by that schema
- fixed-shipping orders snapshot the exact selected kind `30406` coordinate and
  agreed cost from the prepared checkout fulfillment state

### `payment_request`

Tags:

- `["p", buyer_pubkey]`
- `["type", "payment_request"]`
- `["order", order_id]`
- `["amount", "<integer_sats>"]`
- `["payment_method", "lightning"]`

Content:

- legacy JSON payload defined by the shared Conduit schema, including the BOLT11
  invoice or payment request

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

- legacy JSON payload defined by the shared Conduit schema, including any
  optional status message

### `shipping_update`

Tags:

- `["p", buyer_pubkey]`
- `["type", "shipping_update"]`
- `["order", order_id]`
- `["carrier", "<carrier>"]` optional
- `["tracking", "<tracking_number_or_url>"]` optional

Content:

- legacy JSON payload defined by the shared Conduit schema, including any
  optional shipping message

### `receipt`

Tags:

- `["p", buyer_pubkey]`
- `["type", "receipt"]`
- `["order", order_id]`

Content:

- legacy JSON payload defined by the shared Conduit schema, including any
  optional receipt details

### `organizer_fulfillment_receipt`

This is a Conduit private-commerce extension for the organizer-handoff mode in
`docs/specs/event-markets.md`; it is not presented as Gamma order-message wire
compatibility. It is a separate rumor from the buyer's order, not a group copy
of that order.

Tags:

- `["p", organizer_pubkey]`
- `["type", "organizer_fulfillment_receipt"]`
- `["claim", opaque_claim_ref]`

Content is strict versioned JSON containing only the opaque claim reference,
merchant and organizer identities, exact calendar/collection/pickup/product
coordinates and signed revisions, quantities, an empty reserved option list,
literal `paymentConfirmed: true`, `orderReady: true`, and
`releaseAuthorized: true` assertions, `ready_for_pickup`, and issuance time.
Non-empty options remain invalid until cart selections can be bound to an exact
signed product revision. The full claim is a domain-separated SHA-256 value
derived from private order context; clients show the same 12-hex-character code
to the buyer and organizer without exposing the order id. Buyer
identity/contact, address, notes, invoices, proofs, payment hashes, preimages,
providers, wallet material, and unrelated order fields are invalid.

The merchant constructs it only for a current exact organizer-handoff snapshot
after explicit action-time confirmation that payment is settled or nothing is
owed, the order is ready, and organizer release is authorized. The organizer
recipient must have a usable kind-10050 inbox. The rumor remains unsigned under
NIP-59; its merchant identity is authenticated by the signed seal after the
reader verifies that seal and rumor authors match. The exact signed recipient
and sender-copy gift wraps plus their content-free delivery descriptor are
persisted before first relay I/O. Zero ACK and partial delivery remain retryable
without publishing another buyer order.

### `organizer_fulfillment_revocation`

Tags:

- `["p", organizer_pubkey]`
- `["type", "organizer_fulfillment_revocation"]`
- `["claim", opaque_claim_ref]`
- `["e", ready_receipt_rumor_event_id]`

Content repeats the strict version, claim, ready-receipt identity, exact graph,
merchant, and organizer, and carries only `revoked` plus issuance time. It has
no reason or note. Only the original merchant may revoke before a valid handoff
acknowledgement; conflicting same-frontier evidence fails closed. A known valid
revocation blocks handoff, but inability to prove that no unseen revocation
exists does not invalidate a valid ready authorization already found.

### `organizer_handoff_ack`

Tags:

- `["p", merchant_pubkey]`
- `["type", "organizer_handoff_ack"]`
- `["claim", opaque_claim_ref]`
- `["e", ready_receipt_rumor_event_id]`

Content is strict versioned JSON containing only the exact receipt reference,
claim reference, merchant and organizer identities, `handed_out`, and issuance
time. The organizer must be the receipt recipient and pickup author; the
merchant must be the original receipt author. This acknowledgement does not
authorize or encode paid, refund, cancellation, price, inventory, shipping, or
ordinary order-status transitions. Only the merchant may subsequently publish
the normal completion status to the buyer. Inbox coverage remains a discovery
diagnostic: it may make absence uncertain, but it cannot erase this exact
authenticated acknowledgement after the client finds it.

These three message types use strict kind-10050 routing. They do not enter the
bounded legacy kind-16 secure-message relay compatibility lane.
The distinct `claim` tag prevents this redacted organizer workflow from being
grouped into the buyer-to-merchant order conversation.

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

# Protected Commerce Delivery Frontier

Status: active requirements contract for the next PR104 protected-delivery
implementation slice.

This spec narrows the source-aware relay frontier into the critical protected
checkout, order, and message delivery lane. It defines what must be true before
Conduit moves the current route-local NIP-17 wrapping and critical publish
behavior into a shared `@conduit/core` boundary.

## Inputs

This spec incorporates:

- [Source-Aware Relay Frontier](./source-aware-frontier.md)
- the iOS PWA worst-case relay report from 2026-06-16
- Linear research from CND-93, CND-84, CND-57, CND-122, and CND-113
- the public Nostr references listed in
  `docs/knowledge/external-nostr-references.md`

The related protocol constraints are:

- NIP-01 relay publish results are per signed event and per relay. `OK`,
  `NOTICE`, `CLOSED`, timeout, and read-path observations are evidence, not a
  boolean completion flag.
- NIP-65 `kind:10002` relays remain the user's general read/write relay list.
  They are not Conduit app plumbing roles.
- NIP-17 private messages use NIP-59 gift wraps and NIP-44 encryption.
  Recipient recovery requires separately wrapped copies.
- NIP-17 `kind:10050` recipient inbox relays are first-class inputs for
  protected order/message routing. NIP-65, merchant metadata, source
  observations, and fallback relays are fallback evidence, not equivalent
  substitutes.
- For NIP-17/NIP-59 protected messages, the durable relay-visible signed retry
  unit is each per-recipient gift wrap event. The rumor is content-bearing local
  app state and must not be treated as a relay ACK unit.

## Capability

After this lane ships, a buyer or merchant can sign a protected commerce action
and trust that Conduit has durable local evidence before network delivery is
attempted. The action remains visible, retryable, and reconcilable even when an
iOS PWA has only one usable WebSocket, the route unmounts, the app backgrounds,
or relays partially ACK the publish.

The first implementation target is:

- checkout order sends
- buyer payment proof sends
- buyer order-linked messages
- merchant payment requests, receipts, status updates, shipping updates, and
  order-linked replies
- buyer and merchant self-copy delivery for local encrypted recovery

Product publish/delete, profile, shipping, relay-list, and follow writes must
stay compatible with the signed-write ledger model, but they are not the first
PR104 protected-delivery slice.

## Product Boundary

Protected commerce delivery is internal workflow infrastructure. It must not
expand the Network tab.

User-facing surfaces may show:

- order or message saved locally
- sending, retrying, failed, or delivered enough to continue
- checkout/order recovery actions
- collapsed technical details when useful for support or debugging

User-facing surfaces must not show:

- app backplane, fallback, DM, zap, or search buckets
- frontier queues, socket leases, probe jobs, or source-health internals
- raw gift-wrap events, ciphertext, relay matrix internals, or NDK object state
- protocol terminology as the primary checkout or messaging UX

Diagnostics, logs, telemetry, and durable operational records must remain
content-free. They must not include plaintext, ciphertext, invoices, NWC URIs,
order contents, addresses, phone or email values, signer secrets, message
bodies, or full private payloads.

## Current Gap

The current Market checkout, Market messages, and Merchant orders routes build
order-message rumors, call NDK/NIP-17 gift wrapping, publish with
`publishWithPlanner(... deliveryMode: "critical")`, and then cache the parsed
rumor for local UI recovery after publish succeeds.

That preserves some UI history after successful delivery, but it does not meet
the frontier contract:

- signed gift wraps are not persisted before network send
- route components own wrapping, publish sequencing, self-copy handling, and
  post-send caching
- failed publish after signing can lose a retryable signed event
- local parsed rumor cache is content-bearing UI state, not a signed delivery
  ledger
- relay ACK, reject, timeout, and partial success outcomes are not modeled as a
  durable policy result for order/message recovery
- foreground resume has no shared protected-delivery queue to retry before
  ambient hydration resumes
- `publishWithPlanner` returns useful planned, attempted, ACKed, failed, and
  per-relay failure outcomes, but current callers do not persist those outcomes
  as per-action delivery state

## Core Boundary

Protected commerce delivery must move behind a Conduit-owned core boundary.
Route code should create intent inputs and render projected state. It should
not own retry loops, relay arrays, publish thresholds, ACK reconciliation,
read-path confirmation reconciliation, or NIP-17 implementation details.

The first implementation may keep NDK as the signer and NIP-17 wrapping edge.
That usage must be hidden behind core-owned interfaces. No `NDKEvent`,
`NDKUser`, `NDKRelaySet`, or NDK cache objects may enter durable records,
frontier jobs, route-facing state contracts, or future graph snapshots.

No Nostrify dependency is required in this slice. This slice prepares the
plain-data delivery seam that a later Nostrify read/frontier adapter can use.

## Delivery Records

The protected delivery ledger should use a focused record shape that can deepen
into the broader signed-write outbox without being thrown away.

Each signed recipient copy must record:

- durable record id
- order id or conversation id
- app surface: `market_checkout`, `market_messages`, or `merchant_orders`
- protected intent: `order`, `payment_proof`, `message`,
  `payment_request`, `status_update`, `shipping_update`, or `receipt`
- sender pubkey and recipient pubkey
- recipient role: `primary_recipient` or `self_copy`
- full product coordinates for every referenced listing, using
  `30402:<merchant_pubkey>:<d_tag>` rather than a bare `d` tag or route-local
  product id
- signed wrap event id
- signed wrap event kind
- raw signed wrap event JSON
- optional local rumor id for joining to parsed local order/message cache
- source rationale and planned relay set
- publish policy snapshot
- delivery state
- confirmation state
- retry count
- created, updated, last attempt, and next retry timestamps

The record may link to local parsed order/message cache rows, payment attempts,
or order lifecycle rows. The signed wrap JSON remains the retryable delivery
artifact. The content-bearing local cache remains private local state and must
not be copied into diagnostics.

### Delivery State

Use these states for protected delivery:

| State                 | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `queued`              | signed wrap persisted; no network attempt yet                          |
| `publishing`          | relay attempts are in flight                                           |
| `partially_delivered` | at least one relay accepted, but required policy is not satisfied      |
| `delivered_required`  | required recipient-delivery policy is satisfied                        |
| `retry_needed`        | required policy is not satisfied and the signed wrap can be retried    |
| `failed`              | retries are exhausted or policy says the event needs user intervention |

### Confirmation State

Use these states separately from delivery state:

| State                    | Meaning                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `unconfirmed`            | no relay ACK or read-path evidence yet                       |
| `acked_by_relay`         | one or more relays accepted the signed wrap                  |
| `observed_via_read_path` | later protected-message read recovered the wrap or rumor     |
| `confirmed`              | the relevant order/message projection has reconciled locally |

Do not collapse delivery and confirmation into one boolean. Relay ACKs, local
cache, and read-path recovery answer different questions.

## Publish Policy

Protected delivery policy is recipient-aware.

Primary recipient copies:

- must be planned with `recipientRelayPolicy: "nip17_order"` where available
- should prefer recipient `kind:10050` inbox relays
- may use NIP-65 read/write relays, merchant metadata, source observations,
  buyer write relays, and commerce DM fallback only as explicit policy
  fallbacks
- require at least one required recipient relay ACK or an explicit durable
  retry state before checkout can be considered recoverable

Self-copy records:

- are required for local encrypted recovery
- must be signed, persisted, and attempted as their own recipient copy
- must not block primary buyer-to-merchant or merchant-to-buyer delivery once
  required recipient policy is satisfied
- should surface as a recovery warning when primary delivery succeeds but the
  self-copy still needs retry

Partial relay success must be interpreted through the policy snapshot. A route
must not decide delivery success by checking whether any publish promise
resolved.

If no relay confirms a checkout/order publish, a signed and persisted protected
delivery record may make the order locally durable and retryable. It is not a
relay-confirmed checkout. The UI must project it as saved locally and pending
delivery/recovery, not as delivered or merchant-confirmed.

## iOS PWA Checkout Rules

Checkout is a mode switch. When protected checkout delivery starts, Conduit
must:

1. persist cart/order draft or order lifecycle state
2. sign and persist all required protected delivery records before network send
3. pause ambient discovery and speculative ephemerals
4. reserve `critical_order_write` and `critical_order_read` capacity
5. publish primary recipient copies before noncritical work
6. attempt self-copy delivery after or alongside required recipient delivery
   according to socket capacity
7. record every relay outcome locally
8. resume ambient hydration only after critical queues settle or are safely
   persisted for retry

Socket roles are logical leases over relay work, not a requirement to open one
physical socket per role. A single physical WebSocket per relay should multiplex
multiple Nostr subscriptions and jobs when possible. The scarce resource is the
number of concurrently useful relay connections and in-flight critical jobs.

Single-socket operation is the correctness floor:

1. choose the highest-confidence merchant/order relay
2. publish the primary signed wrap
3. wait for OK or timeout
4. record the outcome
5. fetch confirmation or merchant response when possible
6. retry the same signed wrap idempotently on buyer/fallback relays only when
   policy requires it
7. attempt self-copy after the primary path has a durable outcome

Foreground resume must reopen protected delivery before browsing:

1. mark prior sockets untrusted
2. probe usable socket budget
3. load queued, retry-needed, and publishing-stale protected records
4. retry critical order/message records idempotently
5. resubscribe with a safety window for order/message recovery
6. reconcile local order/payment/message state
7. resume active-screen and ambient work

Checkout readiness should be projected separately from delivery confirmation:

| State                   | Meaning                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- |
| `ready`                 | required product, merchant, relay, signer, and local storage inputs are known     |
| `preflight_required`    | a short critical lookup is needed before the send path is reliable                |
| `locally_saved_pending` | signed records are durable locally but required relay policy is not yet satisfied |
| `relay_confirmed`       | required recipient-delivery policy is satisfied                                   |

`locally_saved_pending` is a recovery state, not a successful checkout state.
It may allow navigation to Orders with a retryable status, but it must not claim
merchant receipt or payment/order confirmation.

## Surfaces

### Market Checkout

Checkout owns the user intent to create an order or send a payment proof. It
does not own the delivery engine.

Required behavior:

- create durable order lifecycle state before long-running network work
- persist primary merchant delivery and buyer self-copy records before publish
- keep the original order id for all retries
- show order/proof saved locally before relay readback
- navigate completed or durable in-flight order flows to Orders rather than
  treating checkout as the terminal status surface
- never duplicate merchant orders during retry

### Market Orders And Messages

Buyer order history and messages should render local outgoing protected records
before relay readback.

Required behavior:

- show sent, sending, retry-needed, and failed projections from the delivery
  ledger
- keep products/orders/messages renderable when profile hydration is pending
- keep order-linked kind `16` messages distinct from general kind `14` DMs
- expose `Message merchant` as a support path without making raw protocol
  events primary UX

### Merchant Orders

Merchant orders are the highest reliability read surface in Merchant Portal.

Required behavior:

- prioritize protected wrap recovery over product/profile backfill
- render received, outgoing, retry-needed, and degraded message states
- preserve payment requests, receipts, status updates, shipping updates, and
  message replies as order evidence
- keep content-free diagnostics available only as collapsed technical detail

### Merchant Messages

The future merchant messaging workspace must consume the same protected
delivery boundary. It may add general DM surfaces, but it must not duplicate
route-local wrapping or retry policy.

## Privacy And Diagnostics

Allowed diagnostic fields:

- record id
- event id
- event kind
- surface and protected intent
- recipient role
- relay URL
- planned source bucket or source rationale category
- delivery state
- confirmation state
- ACK, reject, timeout, CLOSED, NOTICE, and retry counters
- last attempt and next retry timestamps
- policy result category

Forbidden diagnostic fields:

- decrypted rumor content
- encrypted wrap content
- invoice, preimage, payment hash, NWC URI, or wallet secrets
- shipping address, email, phone, note, or message body
- full order contents or item details
- signer connection strings or private keys

Developer-facing logs must log categories, counts, and event ids only. If an
exception object may contain forbidden content, the protected delivery boundary
must sanitize it before storing or logging.

## Implementation Slices

Implement this spec in small slices:

1. Add a `protectedDeliveryRecords` Dexie table, plain TypeScript types, and
   state projection helpers in `@conduit/core`.
2. Add a protected delivery helper that wraps existing NDK signer/NIP-17
   behavior but persists signed wrap records before publish.
3. Migrate Market checkout order and payment proof sends onto the helper.
4. Migrate Market buyer messages and Merchant order replies/status updates onto
   the helper.
5. Add foreground resume retry and read-path confirmation reconciliation.
6. Add UI projections for local outgoing and retry states where the relevant
   surfaces already render order/message state.

Do not add Nostrify or replace the broader NDK read substrate in these slices.

The helper must prevent plan drift between persistence and publish. Either
`publishWithPlanner` should accept a precomputed plan/policy snapshot, or core
should add a lower-level publish path that sends a signed event using the exact
relay plan already stored in the protected delivery record.

## Test Requirements

Future implementation must add focused tests for:

- protected delivery records are persisted before the first publish attempt
- a signed wrap survives refresh and can be retried without rebuilding content
- single-socket checkout serializes primary recipient delivery before ambient
  work or self-copy
- primary recipient success with self-copy failure projects a recovery warning,
  not total failure
- merchant reply/status update uses the same protected delivery boundary
- relay ACK, reject, timeout, and partial success map to policy states rather
  than boolean publish success
- retry after foreground resume is idempotent by signed wrap event id and
  order id
- diagnostics exclude plaintext, ciphertext, invoices, addresses, NWC URIs,
  and message bodies

Likely test homes:

- `tests/relay-publish.test.ts` for planner and publish outcome policy
- `tests/dm-relay-list.test.ts` for `kind:10050` recipient relay inputs
- `tests/relay-network-budget.test.ts` for critical preemption and
  single-relay serialization
- `packages/core/src/protocol/protected-commerce-outbox.test.ts` for
  pre-publish persistence, idempotent resume retry, duplicate OK merging,
  storage-failure publish blocking, and retry metadata
- `packages/core/src/protocol/protected-commerce-frontier.test.ts` for
  single-socket checkout serialization and ambient queue deferral
- `packages/core/src/protocol/protected-message-delivery.test.ts` for primary
  recipient versus self-copy policy
- `packages/core/src/protocol/frontier-diagnostics.test.ts` for content-free
  protected delivery diagnostics
- buyer checkout and payment proof tests for order idempotency and local
  outgoing projections
- a route-level contract test may be added after the shared helper exists to
  prevent checkout from reintroducing direct `publishWithPlanner` calls for
  wrapped protected delivery

## Acceptance Criteria

- The shared protected delivery boundary is specified before code migration.
- The first implementation target is limited to checkout orders, payment
  proofs, buyer messages, merchant replies/status updates, and self-copy
  delivery.
- Signed per-recipient gift wraps, not only parsed local rumors, are durable
  before network send.
- Delivery, confirmation, and local parsed UI cache are distinct states.
- Primary recipient delivery and self-copy delivery have separate policy.
- Checkout/order/message reliability wins over browsing hydration under
  constrained sockets.
- Diagnostics remain content-free.
- Network settings remain NIP-65 and local commerce priority only.

## References

- [Source-Aware Relay Frontier](./source-aware-frontier.md)
- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md):
  event, relay publish, `OK`, `EOSE`, `CLOSED`, and `NOTICE` behavior.
- [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md):
  private direct messages and per-recipient recovery model.
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md):
  encrypted payloads.
- [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md):
  gift wrap structure and `kind:1059` delivery behavior.
- [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md):
  user relay list metadata.

# Source-Aware Relay Frontier Specification

Status: active implementation contract for PR104 and Phase 2B relay work.

This spec defines how Conduit should hydrate Nostr commerce surfaces from
relays while preserving user relay boundaries, source provenance, checkout
reliability, and hostile mobile-browser behavior. It extends the relay settings
architecture without turning relays into user-managed app roles.

## Inputs

This spec incorporates:

- the PR104 relay bucket work and its current default-relay intent
- the iOS PWA worst-case relay report from 2026-06-16
- Linear planning research from CND-59, CND-72, CND-113, CND-20, CND-99,
  CND-107, CND-108, CND-109, CND-110, CND-111, CND-112, CND-133, CND-57,
  CND-29, CND-93, CND-97, CND-84, CND-98, CND-100, CND-102, CND-105,
  CND-114, CND-115, and CND-119
- the public Nostr references listed in `docs/knowledge/external-nostr-references.md`

The durable rule is that Conduit models relays as partial sources and execution
paths. A relay result is evidence, not authority. Cache state is also evidence,
not completion.

## Product Boundary

The Network tab is for the user's NIP-65 relay list and local commerce priority
only. It must not expose the app's internal relay frontier.

User-facing relay settings may show:

- user `IN` and `OUT` preferences
- Conduit-local commerce priority for commerce-compatible relays
- capability and warning indicators derived from scans
- the two sections defined by the relay architecture: Commerce Enabled Relays
  and Other Public Relays

User-facing relay settings must not show:

- app backplane relays
- default fallback buckets
- search, DM, zap, or inbox bucket names
- frontier queues, socket leases, probe jobs, or source-health internals
- conduit plumbing diagnostics that are not directly actionable by the user

Engineering tools may inspect frontier state, but diagnostics must remain
content-free. They must not include plaintext, ciphertext, invoices, NWC URIs,
order contents, addresses, phone or email values, signer secrets, message
bodies, or full private payloads.

## Library Boundary

Conduit should converge on a Conduit-owned relay execution boundary that uses
plain Nostr events, filters, relay URLs, and source outcomes.

Preferred long-term substrate:

- Nostrify for relay execution, pooling, routing, and frontier iteration.
- `nostr-tools` for low-level event, filter, signature, and protocol
  primitives.

Allowed NDK usage:

- signer compatibility while current auth code depends on NDK signer types
- temporary adapters at the edge of existing hooks and protocol helpers
- NIP-17 helper behavior only behind Conduit-owned private-message interfaces

NDK objects must not become durable graph records, IndexedDB records, source
snapshots, search records, frontier jobs, or route-facing contracts. New
frontier code should expose plain event-like records and typed source outcomes.

NWC/NIP-47 remains a payment transport and is separate from relay substrate
selection. Replacing or reducing NDK usage must not imply a payment transport
change.

## Relay Intent Buckets

Current code defaults are internal execution inputs. They are not user relay
settings.

| Bucket                 | Current source                                                          | Primary use                                                                             | User-facing? |
| ---------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------ |
| `app_backplane`        | `appBackplaneRelayUrls` / `CANONICAL_APP_BACKPLANE_RELAYS`              | app-assisted bootstrap, app-owned write path, and safety-net commerce discovery         | No           |
| app write              | `appWriteRelayUrls` / `CANONICAL_APP_WRITE_RELAYS`                      | app-scoped publish target where a Conduit-owned event path needs it                     | No           |
| `core_public_fallback` | `corePublicFallbackRelayUrls` / `CANONICAL_CORE_PUBLIC_FALLBACK_RELAYS` | broad Nostr visibility and fallback reads when source hints are missing                 | No           |
| `search_index`         | `searchIndexRelayUrls` / `CANONICAL_SEARCH_INDEX_RELAYS`                | NIP-50/search-index reads and broad discovery                                           | No           |
| `commerce_dm_fallback` | `commerceDmFallbackRelayUrls` / `CANONICAL_COMMERCE_DM_FALLBACK_RELAYS` | protected order and DM delivery fallback when recipient inbox hints are missing or weak | No           |
| `dm_inbox_default`     | `dmInboxDefaultRelayUrls` / `CANONICAL_DM_INBOX_DEFAULT_RELAYS`         | suggested default `kind:10050` private-message inbox relays                             | No           |
| `zap_public`           | `zapRelayUrls` / `CANONICAL_ZAP_PUBLIC_RELAYS`                          | public zap request or receipt visibility where payment UX needs it                      | No           |
| user NIP-65            | published `kind:10002` plus local relay settings                        | user-controlled read/write preferences                                                  | Yes          |
| commerce priority      | local settings derived from user-ranked commerce-compatible relays      | preference order for Conduit commerce reads and writes                                  | Yes          |

The frontier may combine these buckets with NIP-65, NIP-17 `kind:10050`, event
source hints, recent source observations, merchant-specific evidence, and local
cache state. The final relay plan must preserve where each relay came from.

## Capability And Commerce Evidence

Relay `supported_nips` are only one input. Conduit must distinguish:

- protocol capabilities advertised by NIP-11
- relay limitations and auth requirements
- active read/write probe results
- observed acceptance of commerce event kinds
- observed source usefulness for a specific surface
- recipient inbox suitability for protected wraps

Do not require relays to advertise NIP-17 or NIP-44 as NIP-11 capabilities for
protected message transport. NIP-17 is a client-side private-message protocol
using NIP-59 gift wraps and NIP-44 encryption. The relay-visible evidence is
whether the relay handles the relevant public wrapper traffic, especially kind
`1059`, and whether recipient inbox hints such as `kind:10050` are available.

NIP-42 auth support is a separate signal. It can raise confidence for protected
or restricted relay use, but lack of auth does not prove that a relay is unsafe.
The UI may warn or limit use when policy requires stronger access-control
signals.

## Graph And Source Model

The frontier hydrates graph state, not route-local arrays. Route code should
render prepared snapshots and send user intent, viewport heat, and workflow
state into the graph engine.

Required identity rules:

- Product identity is the full addressable coordinate
  `30402:<merchant_pubkey>:<d_tag>`.
- Never dedupe products by bare `d` tag.
- Source relay URLs are observations attached to events and records, not source
  of truth.
- Deletion and tombstone state must be resolved by coordinate and source
  freshness.

Public and private state must remain separated:

- Public market graph: product listings, public profiles, merchant storefront
  state, public source observations, media readiness, public search state, and
  public social/trust summaries.
- Merchant workspace graph: merchant-owned signed truth, product publish/delete
  outcomes, order inbox state, message state, checkout sessions, pending
  publishes, and private search/workspace projections.

Private order and message state must not leak into public graph diagnostics,
generic source health, screenshots, logs, telemetry, or route params.

## Priority Classes

The scheduler should use explicit priority classes rather than per-route relay
arrays.

| Class                      | Level | Use                                                                                              | Preempts                          |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| `critical_order_write`     | P0    | signed checkout order, payment proof, and protected message publishes                            | everything non-critical           |
| `critical_order_read`      | P0    | order confirmation, merchant response, inbox recovery, support thread recovery                   | everything non-critical           |
| `user_publish`             | P1    | user-initiated signed actions outside checkout, including product edits and relay-list publishes | ambient and low-yield screen work |
| `interactive_detail`       | P2    | active product, merchant, cart, order, or profile detail reads                                   | ambient and prefetch              |
| `interactive_search`       | P2    | explicit user search and filter changes                                                          | ambient and prefetch              |
| `visible_marketplace_read` | P3    | visible catalog, storefront, and grid hydration                                                  | background and prefetch           |
| `zap_receipt_wait`         | P1/P3 | P1 when part of checkout/payment, P3 for ordinary public zap visibility                          | ambient and prefetch when P1      |
| `background_hydration`     | P4    | profile, media, social, review, and source-health backfill                                       | preemptible                       |
| `capability_scan`          | P5    | NIP-11, search, auth, and commerce suitability checks                                            | preemptible                       |
| `prefetch`                 | P5    | offscreen speculative fetches                                                                    | first to pause                    |

Each frontier job must declare:

- priority class
- surface or workflow lens
- event kinds and filters
- candidate relay sources
- deadline or timeout
- whether it needs an ACK
- whether it can be preempted
- privacy class: public, workspace-private, protected-message, or payment

## Socket Scheduler Classes

The relay pool should lease sockets by role:

- Critical sockets: checkout, payment, order messages, order confirmations,
  publish ACKs, merchant support, and order relay recovery.
- Active-screen sockets: current merchant page, product page, cart, order
  detail, inventory or availability checks, and shipping/payment option reads.
- Ambient browsing sockets: homepage discovery, broad search, profiles,
  reviews, reactions, zaps, recommendations, and offscreen media metadata.
- Ephemeral sockets: one-off event fetches, author relay discovery, publish
  fanout, capability scans, missing profile/product hydration, and relay-health
  probes.

Ephemeral sockets must auto-close after EOSE, OK/NOTICE, job timeout, idle
timeout, or priority preemption.

When P0 or P1 work needs capacity, the scheduler must:

1. stop opening new ambient sockets
2. close speculative ephemeral sockets
3. close ambient browsing sockets
4. close duplicate-heavy or low-yield visible-read sockets
5. close active-screen sockets not required for checkout
6. preserve checkout, order, user-pinned critical, and merchant-required relays

Never evict a socket that is waiting for a checkout publish ACK, receiving an
order/payment confirmation, carrying a protected order/support message, or is
the only currently working merchant/order relay.

## iOS PWA Operating Modes

The browser runtime must be treated as hostile. The app must work correctly with
one usable relay socket and improve opportunistically when more sockets work.

| Mode                | Active socket budget | Behavior                                                                              |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| Single-socket floor | 1                    | checkout/order recovery only; browsing from cache; noncritical publishes queued       |
| Minimum useful      | 2                    | checkout/order relay plus user write or best fallback                                 |
| Healthy foreground  | 3-4                  | active screen live, visible market hydration, limited ambient work                    |
| Burst               | 5-6                  | short-lived user-visible action, publish fanout, merchant load, or checkout preflight |
| Experimental        | 7+                   | never required for correctness; only after runtime success                            |

Foreground sockets can work, but background execution is not reliable. Hidden,
backgrounded, locked, frozen, or discarded app states must make sockets
untrusted.

Socket accounting states:

- `CONNECTING`
- `OPEN`
- `CLOSING`
- `CLOSED`
- `ZOMBIE_OR_TIMED_OUT`

Recommended timeouts:

- fast connect timeout: 2500 ms
- slow connect timeout: 5000 ms
- close accounting timeout: 3000 ms

`WebSocket.close()` is not immediate capacity recovery. A socket being closed
must remain in accounting until `onclose` fires or the local accounting timeout
expires.

## Checkout Mode

Checkout is a mode switch, not another screen.

Entering checkout mode must:

1. persist the cart and order draft locally
2. pause ambient discovery and homepage subscriptions
3. close speculative ephemeral sockets
4. identify merchant order relays
5. identify merchant read/write relays from NIP-65, `kind:10050`, merchant
   metadata, source observations, and fallback policy
6. identify buyer write relays
7. reserve critical socket budget
8. enqueue order publish, payment proof, confirmation read, and protected
   message jobs before any ambient work resumes

Checkout must not cold-start broad discovery. The shopping journey should cache
merchant profile, merchant relay hints, product event, price and shipping state,
payment methods, support/order pubkey, recent merchant relay health, and buyer
write relays before checkout whenever possible.

Before enabling or entering fast checkout, the app should compute checkout
readiness from:

- merchant profile cached
- product event cached by full coordinate
- price current enough for the selected payment path
- payment methods cached
- merchant order relays known or recoverable
- user signer ready
- local storage available for durable signed events

Low readiness may trigger a short high-priority preflight. It must not trigger
ambient browsing hydration ahead of checkout work.

## Single-Socket Checkout Path

If only one socket works, use it for the highest-confidence checkout path:

1. merchant-declared order relay
2. merchant write/read relay from NIP-65, `kind:10050`, or merchant metadata
3. buyer write relay if the merchant can later find the event there
4. known shared fallback relay used by both parties

The single-socket flow is serialized:

1. connect to the selected merchant/order relay
2. publish the signed checkout/order event
3. wait for OK or timeout
4. fetch order confirmation or merchant response
5. record the per-relay outcome locally
6. close or reuse the socket according to priority
7. connect to buyer write or fallback relay if required
8. republish the same signed event idempotently if policy requires it
9. persist all outcomes and retry metadata

This path may be slower, but it is the correctness floor.

## Durability And Resume

Critical user actions must be durable before network send.

Before publishing a checkout order, protected message, payment proof, product
edit, deletion, or relay-list change:

1. sign the event
2. compute the event id
3. store the signed event locally
4. store the intended relay set and source rationale
5. store job priority and retry policy
6. then send to relays

After publishing:

- record OK, NOTICE, CLOSED, timeout, and error per relay
- record last attempt timestamp
- retry failed relays with bounded backoff
- reconcile duplicate OKs idempotently
- keep local pending state visible to the relevant workflow

On hidden/background/locked state:

- persist frontier state and pending signed events
- close speculative ephemerals where possible
- mark sockets as untrusted for resume

On foreground resume:

1. probe socket budget
2. reopen critical checkout/order/message relays first
3. retry pending signed events idempotently
4. resubscribe with `since = last_seen - safety_window`
5. reconcile local order/payment state with relay responses
6. resume visible screen work
7. resume ambient work only after critical queues settle

## Surface Priority Contract

### Market

| Surface          | Primary priority                               | Frontier focus                                                                                                  | Deferred under checkout                                    |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Homepage/catalog | `visible_marketplace_read`                     | cache-first visible products, broad commerce discovery, source diversity, profile and media hydration           | social context, profile backfill, reviews, recommendations |
| Search/results   | `interactive_search`                           | search/index relays first, then exact product/profile hydration from coordinates and source hints               | ambient discovery and offscreen hydration                  |
| Storefront       | `interactive_detail`                           | merchant-authored products, merchant relay hints, merchant profile, storefront freshness                        | broad discovery and unrelated profiles                     |
| Product detail   | `interactive_detail`                           | exact `30402:<pubkey>:<d>` resolution, deletion/freshness, merchant identity, media, shipping/payment readiness | social/trust backfill not needed for checkout              |
| Cart             | `interactive_detail`                           | selected products, merchant readiness, shipping/payment state, duplicate-order protection inputs                | catalog refresh and recommendations                        |
| Checkout         | `critical_order_write` / `critical_order_read` | signed order, payment proof, protected message publish, confirmation read, local durability                     | all noncritical browsing                                   |
| Orders/messages  | `critical_order_read` / `critical_order_write` | recipient inbox lists, protected wraps, commerce DM fallback, self-copy, retry evidence, resume recovery        | ambient marketplace work                                   |
| Wallet/zaps      | `zap_receipt_wait`                             | NWC/NIP-47 capability and zap receipt visibility where relevant                                                 | ordinary zap/social visibility                             |

Homepage is intentionally the broadest and most expensive surface. As the user
moves toward a specific merchant, product, cart, checkout, order, or message
thread, the frontier must narrow from broad discovery to exact source recovery
and publish/read reliability.

### Merchant Portal

| Surface            | Primary priority                               | Frontier focus                                                                                      | Deferred under critical order work |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Dashboard          | `interactive_detail`                           | local signed truth, own products, order counts, inbox state, publish health                         | broad public discovery             |
| Orders/inbox       | `critical_order_read`                          | receive all order messages, model partial inbox coverage, stale state, wrap failures, retry windows | product/profile backfill           |
| Product management | `user_publish`                                 | local signed truth, publish ACKs, tombstones/deletions, exact merchant coordinates                  | non-visible catalog hydration      |
| Messages           | `critical_order_write` / `critical_order_read` | NIP-17/NIP-59 wrapping, self-copy, recipient inbox discovery, content-free diagnostics              | ambient marketplace reads          |
| Network/settings   | `user_publish`                                 | user NIP-65 relay-list reads/writes and local commerce priority                                     | all internal frontier plumbing     |
| Store Builder      | `interactive_detail`                           | future public storefront/product-detail subset                                                      | merchant workspace internals       |

Merchant Portal differs from Market because the merchant workspace is anchored
around reliable operation, not broad discovery. Its highest priority is making
sure orders and order messages are received, preserved, and recoverable.

## Source Outcomes

Every relay job should emit structured outcomes. At minimum:

- planned relay URL and source bucket
- surface lens and priority class
- filter or publish intent
- connection state and timing
- EOSE, CLOSED, NOTICE, OK, timeout, and error observations
- event counts, duplicate counts, malformed counts, and useful-yield counts
- source hints discovered
- freshness and confidence metadata
- whether the relay was parked, retained, or evicted

The graph engine should use these outcomes to rank relays, decide when a
frontier is good enough for the active surface, and decide what can be deferred.

Positive relay score inputs:

- current checkout relevance
- current screen relevance
- unique event yield
- author or merchant coverage
- low latency to useful data or EOSE
- publish success rate
- user-pinned critical relay
- merchant-required relay

Negative relay score inputs:

- duplicate-heavy output
- slow EOSE
- frequent NOTICE, CLOSED, or OK failures
- failed handshakes
- high reconnect churn
- no current-screen relevance
- stale subscription only

## Implementation Acceptance Scenarios

Future implementation work against this spec must cover:

- one-socket checkout publishes an order, records relay outcomes, and recovers
  after foreground resume
- two-socket checkout reserves order and buyer/fallback capacity while browsing
  hydration pauses
- homepage hydration renders cache-first and continues with partial relay
  failures
- product detail resolves by full coordinate and does not merge two merchants
  with the same `d` tag
- Merchant orders/inbox prioritizes protected wrap recovery over product
  backfill
- relay-list settings do not expose app backplane, search, DM, zap, or
  frontier bucket diagnostics
- capability scans distinguish NIP-11 evidence from observed commerce
  usefulness
- diagnostics and telemetry remain content-free

## References

- [NIP-01](https://nips.nostr.com/1): relay WebSocket flow, client messages,
  relay messages, and relay limits.
- [NIP-65](https://nips.nostr.com/65): `kind:10002` relay list metadata.
- [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md): private
  direct messages using NIP-44 and NIP-59.
- [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md): gift wrap
  event structure.
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md): encrypted
  payloads for private messages.
- [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md): Nostr
  Wallet Connect payment transport.
- [GammaMarkets market-spec](https://github.com/GammaMarkets/market-spec):
  NIP-99 commerce event compatibility baseline.
- [Nostrify](https://nostrify.dev/): preferred future relay execution and
  frontier substrate.
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools): low-level Nostr
  primitives.
- [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API):
  browser visibility lifecycle.
- [WebSocket close event](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/close_event):
  close accounting behavior.
- [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html): WebSocket protocol.
- [WebKit bug 302561](https://bugs.webkit.org/show_bug.cgi?id=302561):
  pathological multiple WebSocket connection behavior on iOS paths.

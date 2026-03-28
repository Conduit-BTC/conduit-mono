# Conduit L2 Relay Layer - Scope 2 Functional Specification

## Purpose

This document defines the **functional contract** for Scope 2 of the Conduit relay architecture: the Conduit-operated L2 relay layer.

It exists to answer a practical question:

**What specific relay behaviors should engineering build so Conduit apps can stop depending on generic public relays for core UX performance, while still degrading safely back to ordinary relay behavior when L2 is unavailable?**

This is a Scope 2 document, not a full system architecture document. The architectural model and layer boundaries remain defined in [conduit_relay_architecture.md](./conduit_relay_architecture.md).

---

## Executive Summary

Scope 2 should be built first as a **commerce-aware relay acceleration layer** for the read paths that already exist in this repo:

- Market product browse
- Market merchant storefront browse
- Product detail lookup
- Merchant order inbox
- Buyer merchant-thread inbox
- profile lookups needed to decorate those surfaces

The current apps mostly rely on:

- fanout to public relays
- client-side deduplication
- client-side filtering and sorting
- client-side thread assembly for order conversations
- repeated profile lookups

That works for MVP, but large public relays do not reliably provide the behavior Conduit needs:

- deterministic commerce sorting
- consistent text search behavior
- cross-relay deduplication for replaceable commerce events
- reliable deletion/tombstone handling for merchant product state
- protected metadata access for private merchant threads
- stable, app-shaped query performance under load

Scope 2 should solve those gaps while preserving the rule that **L2 is still only a performance layer**. If L2 is down, clients must still be able to fall back to merchant relays and public relays using ordinary Nostr reads, with degraded speed and weaker UX.

---

## Design Constraints

### L2 is optional for correctness

If L2 becomes unavailable:

- commerce events still exist on merchant relays
- apps can still fan out to merchant relays and public relays
- clients may resume client-side filtering, sorting, and thread assembly

### L2 is not the canonical write target

Merchant-authored truth still belongs to merchant relays. L2 may accept mirrored events and may optionally accept convenience writes for forwarding, but it must not become the only valid place to publish merchant state.

### L2 stays relay-native

L2 may add capability-advertised query behavior, bounded server-side sorting, and protected subscriptions, but it must not turn into a separate bespoke application API that clients cannot replace with ordinary relay fallback.

### L2 should remain operator-portable

Scope 2 should be implementable as open-source relay software that another operator can run with their own routing, moderation, and trust policy choices.

To preserve that portability:

- L2 query extensions should be optional and capability-advertised
- merchant relays must remain sufficient for baseline publish and recovery
- Conduit app UX may improve when L2 is available, but must not require hidden Conduit-only backend behavior

### Protected data must preserve privacy

Any messaging or thread-summary acceleration must preserve the `NIP-17` privacy expectations called out in [conduit_relay_architecture.md](./conduit_relay_architecture.md). Protected reads require `NIP-42` authentication, and unauthorized clients must not be able to discover hidden message metadata by probing filters.

---

## Repo-Driven Scope

This spec is grounded in the current repo behavior.

### Current product-read patterns

Today the Market app:

- fetches raw `kind 30402` events from relay fanout
- parses products client-side
- filters by merchant, text query, and tags client-side
- sorts by newest or comparable price client-side
- derives tag sets and merchant sets client-side
- looks up product detail by address or event id
- handles related products via another product fetch

### Current message-read patterns

Today the Market and Merchant apps:

- fetch `kind 1059` gift wraps from relay fanout
- unwrap and parse messages client-side
- cache messages locally in Dexie
- reconstruct order conversations client-side
- derive latest status, totals, and conversation ordering client-side
- fetch merchant profiles separately to decorate conversation lists

### Implication

Scope 2 does not need to invent entirely new product surfaces. It should first accelerate the existing ones with predictable query semantics and lower latency.

---

## What Public Relays Usually Do Not Guarantee

Generic public relays are useful transport, but Conduit should not assume they provide these behaviors consistently:

- deterministic commerce sort modes beyond reverse chronological order
- reliable full-text or merchant-aware search
- replaceable-event dedupe tuned for product listings
- `NIP-09` deletion handling that matches Conduit storefront expectations
- stable query latency for wide marketplace reads
- protected thread summaries for order conversations
- unread or latest-status projections for private merchant threads
- relay selection and health-aware fan-in for commerce-critical reads

In practical terms, ordinary relays are good at **returning events that match filters**. Conduit Scope 2 needs to be good at **returning the right commerce results quickly and safely**.

---

## Scope 2 MVP Goals

The first production version of Scope 2 should support these app-visible outcomes:

1. `/products` loads from a Conduit relay path without client fanout to multiple public relays.
2. `/store/$pubkey` loads from a Conduit relay path with deterministic filtering and sort behavior.
3. `/products/$productId` resolves quickly from mirrored product state.
4. Buyer and merchant thread lists load faster and with fewer client-side operations.
5. Conduit can tolerate public relay slowness or partial outage without collapsing product browse UX.
6. If Scope 2 goes down, clients can still fall back to direct relay reads and continue to operate.

---

## Functional Areas

Scope 2 is split into five functional areas:

1. Commerce event mirroring
2. Commerce query execution
3. Conversation and notification acceleration
4. Relay routing and health
5. Policy and abuse controls

---

## 1. Commerce Event Mirroring

### Supported event classes in MVP

L2 MVP must mirror and serve reads for:

- `kind 0` profile metadata
- `kind 5` deletions
- `kind 10002` relay lists where useful for routing
- `kind 30402` product listings
- `kind 1059` gift wraps for protected order-message workflows
- inner order payloads only after authorized unwrap on the client side or other privacy-preserving processing paths

### Mirroring sources

L2 should ingest from:

- merchant dedicated relays
- Conduit-managed relays
- selected public relays used as ecosystem reach points

### Mirroring requirements

- deduplicate by event id
- track first-seen and last-seen relay sources
- preserve replaceable-address identity for products using `kind:pubkey:d-tag`
- retain deletion events and apply them during query evaluation
- support replay and backfill from upstream relays

### Product-state materialization inside L2

For `kind 30402`, L2 should maintain an internal current-view projection for fast relay-native reads:

- latest event by product address
- latest update timestamp
- deletion/tombstone status
- parsed product fields needed for bounded filtering and sort

This projection is internal to L2 and does not make L2 the source of truth. It exists only to accelerate reads.

---

## 2. Commerce Query Execution

This is the core functional requirement for Scope 2.

L2 should answer a narrow set of **deterministic commerce query primitives** that correspond directly to app screens.

### Query design rule

Every L2 query must have:

- a fallback path using ordinary relay reads
- bounded result size
- deterministic sort semantics
- a clear stale-data tolerance

Additional interoperability rule:

- if a query requires Conduit-specific semantics, those semantics must be documented as an optional relay capability rather than assumed to exist on all relays

### Query primitive A - marketplace product browse

Used by:

- `apps/market/src/routes/products/index.tsx`

Inputs:

- merchant pubkey optional
- text query optional
- tag list optional
- sort mode optional
- limit
- cursor optional

Outputs:

- deduplicated product events
- deterministic order
- optional lightweight query metadata:
  - next cursor
  - freshness timestamp
  - result count estimate if cheap

Required filters:

- by merchant pubkey
- by tag
- by text query over title and summary
- by product address or event id when present

Required sort modes:

- `newest`
- `price_asc`
- `price_desc`
- `updated_at_desc`

Sorting semantics:

- `newest`: descending product event creation time
- `updated_at_desc`: descending parsed product `updatedAt`, else event `created_at`
- `price_asc` and `price_desc`: only allowed when values are comparable under query policy

Price-sort policy:

- if all products share one currency, compare directly
- if mixed currencies are present and a trusted conversion context is available to L2, compare normalized values
- if mixed currencies are present and no trusted normalization is available, L2 must either:
  - reject the sort mode with a capability error, or
  - omit non-comparable items only if the client explicitly opts into partial results

Tie-breakers:

1. higher `updatedAt`
2. newer event `created_at`
3. lexical ascending event id

### Query primitive B - merchant storefront browse

Used by:

- `apps/market/src/routes/store/$pubkey.tsx`

Inputs:

- merchant pubkey required
- text query optional
- single tag or category optional
- sort mode optional
- limit
- cursor optional

Outputs:

- merchant-scoped deduplicated products
- deterministic order
- optional tag facets for that merchant when cheap

Required behavior:

- same sort semantics as marketplace product browse
- faster merchant-only reads than generic marketplace browse
- authoritative merchant filter applied before text filtering and sort

### Query primitive C - product detail resolution

Used by:

- `apps/market/src/routes/products/$productId.tsx`

Inputs:

- product address id preferred
- event id fallback

Outputs:

- latest visible product event or not found
- deletion-aware result

Required behavior:

- resolve addressable product ids without scanning all merchant events client-side
- if a product was deleted, return not found rather than stale visible state
- support related-product lookup by merchant as a second query

### Query primitive D - buyer merchant-thread list

Used by:

- `apps/market/src/routes/messages.tsx`
- `apps/market/src/routes/orders.tsx`

Inputs:

- authenticated buyer pubkey
- optional merchant filter
- optional text query
- limit
- cursor optional

Outputs:

- authorized conversation summaries keyed by order id
- latest message timestamp
- latest status summary if present
- merchant pubkey
- unread indicator if implemented

Required behavior:

- require `NIP-42` before query execution
- do not expose whether hidden conversations exist to unauthorized clients
- return thread summaries without requiring the client to unwrap and group every message first

Allowed summary fields:

- order id
- merchant pubkey
- latest message type
- latest visible timestamp
- latest status value
- total summary if derivable from the first order message

Disallowed unauthenticated fields:

- existence of a specific thread
- message counts
- participant metadata
- timestamps

### Query primitive E - merchant order inbox

Used by:

- `apps/merchant/src/routes/orders.tsx`

Inputs:

- authenticated merchant pubkey
- optional status filter
- optional buyer filter
- optional text query
- limit
- cursor optional

Outputs:

- authorized conversation summaries by order id
- latest status
- latest message timestamp
- buyer pubkey
- optional total summary

Required behavior:

- same privacy rules as buyer merchant-thread list
- optimize merchant reads of their own order conversations
- allow latest-first ordering without client-side regrouping of full message history

### Query primitive F - profile decoration lookups

Used by:

- product grids
- storefronts
- message lists

Inputs:

- pubkey list

Outputs:

- latest visible `kind 0` metadata per pubkey

Required behavior:

- batch profile resolution
- bounded caching inside L2
- do not introduce custom profile semantics beyond latest visible metadata event

---

## 3. Conversation and Notification Acceleration

Scope 2 may accelerate private workflows, but only under strict privacy rules.

### Conversation summary acceleration

L2 may maintain authorized per-principal conversation-summary projections for:

- buyer merchant threads
- merchant order inbox threads

These summaries must be treated as protected derived data and must only be exposed after successful `NIP-42` auth and authorization checks.

### Live subscription acceleration

L2 should support low-latency subscriptions for:

- new mirrored product events
- merchant product updates
- authorized new merchant-thread activity
- status-update activity

### Notifications

MVP Scope 2 notification support should remain minimal:

- detect new thread activity for authorized principals
- detect status changes for existing orders
- support live subscription delivery over relay connections

L2 should not yet own a separate durable notification product model. That belongs later, or in Scope 3 if a richer app-oriented notification center is needed.

---

## 4. Relay Routing and Health

L2 should hide public-relay unreliability from clients where possible.

### Required routing behavior

- maintain health scores for upstream relays
- prefer merchant relays for merchant-authored truth
- use public relays as supplemental inputs, not the only source
- back off unhealthy upstreams automatically
- support replay when upstream relays recover

### Read-source precedence

For merchant-authored commerce state, L2 should prefer:

1. merchant relay copies
2. other trusted Conduit relay mirrors
3. public relay copies

### Freshness targets

Initial engineering targets for L2:

- product event replication lag p95: under 10 seconds
- product browse query latency p95: under 500 ms
- product detail resolution p95: under 250 ms
- authorized thread-summary query latency p95: under 500 ms

These are operational targets, not protocol guarantees.

---

## 5. Policy and Abuse Controls

Scope 2 must include enough policy to keep commerce reads useful.

### Required controls

- per-connection rate limiting
- per-pubkey publish rate limiting where writes are accepted
- max event size policy
- malformed-event rejection
- bounded query limits
- spam suppression hooks for public-ingest product events

### Internal web-of-trust policy

Scope 2 should include an **internal graph-policy module** rather than depending on an external reputation service in the critical path.

Recommended approach:

- maintain a Conduit-owned seed set of trusted pubkeys
- crawl outward through follow graphs and other explicitly supported trust edges
- compute simple policy classes from seed distance and local policy signals
- use those policy classes as soft inputs to L2 visibility, throttling, and prioritization

### Seed set sources

Initial trusted seeds may include:

- Conduit-controlled operator pubkeys
- explicitly onboarded merchants
- approved partner or ecosystem pubkeys
- manually curated moderation seeds

### Seed-based trust classes

Initial implementation should stay simple:

- `trusted`
  - explicitly onboarded merchants
  - Conduit-controlled or manually approved pubkeys
- `connected`
  - pubkeys with a strong graph connection to trusted seeds
- `unknown`
  - pubkeys with no meaningful trust path yet
- `suppressed`
  - pubkeys blocked by abuse rules or operator action

### Example policy behavior

- `trusted`
  - normal ingest
  - normal marketplace visibility
  - minimal throttling
- `connected`
  - normal ingest
  - eligible for marketplace browse visibility
  - standard rate limits
- `unknown`
  - allow storage or direct retrieval where product policy permits
  - deprioritize in broad marketplace browse
  - apply stricter rate limits and spam review thresholds
- `suppressed`
  - reject or quarantine according to abuse policy
  - do not surface in marketplace browse

### Important constraint

This policy must be **soft trust**, not a hard existence gate.

That means:

- directly addressed merchant/store/product reads may still be allowed even when a pubkey is `unknown`
- explicit merchant onboarding overrides weak or absent graph reputation
- marketplace-wide browse and ranking may use trust class as a quality filter
- if the graph-policy module is degraded, L2 falls back to explicit allowlists and local abuse rules

### Commerce-specific rule

Spam filtering may suppress ranking or visibility in L2 query results, but it must not mutate canonical merchant truth on merchant relays.

---

## Query Semantics

This section defines how L2 should behave for sorting, filtering, deduplication, and pagination.

### Filtering semantics

For product browse queries:

- merchant filter is exact pubkey match
- tag filter is case-insensitive exact tag match
- text query is case-insensitive match against:
  - title
  - summary
- text query should not require full NIP-50 support across all event kinds

### Search scope rule

In Scope 2 MVP, search means **bounded commerce search**, not general network search.

That means:

- product title and summary search is in scope
- merchant storefront search is in scope
- global arbitrary text search across all Nostr content is out of scope
- private DM search is out of scope

### Deduplication semantics

For product listings:

- dedupe by addressable product id when a `d` tag exists
- otherwise dedupe by event id
- when multiple events exist for the same address, latest visible non-deleted event wins

For mirrored events:

- duplicate event ids from multiple upstream relays collapse into one event

### Deletion semantics

L2 must apply `kind 5` deletion events to query evaluation for products.

Rules:

- event-id deletions suppress the deleted event when deletion timestamp is newer than or equal to target event timestamp
- address-level deletions suppress the current visible state for that address under the same timestamp rule
- deleted products must not appear in browse, storefront, or detail reads

### Pagination semantics

L2 should use opaque cursors for deterministic pagination.

Cursor requirements:

- encode enough state to continue the query without duplicates
- remain stable across small background ingest changes where feasible
- expire safely if underlying sort state changes too much

Fallback rule:

If the client falls back to ordinary relays, it may revert to simple limit-based fetch and client-side truncation.

---

## Write Semantics

Scope 2 is primarily a read-acceleration layer, but write behavior must still be specified.

### Merchant-authored product writes

Preferred behavior:

- merchants publish canonical writes to merchant relays
- replication propagates those writes into L2

Optional convenience behavior:

- L2 may accept merchant-authored events and forward them to merchant relays

Constraint:

- a successful write to L2 alone must not be treated as canonical unless forwarding to the merchant relay also succeeds according to product policy

### Private messaging writes

L2 may participate in delivery for protected order-message workflows only if:

- the client is authenticated as required
- the relay authorization policy allows the operation
- privacy semantics remain equivalent to the merchant-relay path

---

## Fallback Behavior by Function

This is a required part of the Scope 2 design.

### If L2 product browse is down

Clients fall back to:

- merchant relays
- configured public relays

Client behavior:

- fetch raw `kind 30402` events
- parse client-side
- filter and sort client-side
- show slower or less complete results if some relays are unhealthy

### If L2 product detail resolution is down

Clients fall back to:

- direct address lookup on merchant relay if known
- public relay fanout by product address or event id

### If L2 thread-summary queries are down

Clients fall back to:

- gift-wrap fetch by `#p`
- local unwrap
- client-side thread grouping
- local Dexie cache for partial offline continuity

### If L2 profile batching is down

Clients fall back to:

- direct latest `kind 0` lookups by pubkey

---

## Protocol Surface Recommendation

Scope 2 should prefer **Nostr-compatible transport with capability-advertised extensions** rather than a separate JSON REST backend.

Recommended approach:

- ordinary relay reads remain supported
- L2 advertises supported capabilities in `NIP-11`
- L2 exposes enhanced query behavior through a bounded set of relay extensions or query conventions
- Conduit clients detect capabilities and choose:
  - L2 optimized path when available
  - ordinary relay fallback when not available

### Why this approach

It preserves the graceful-degradation rule:

- clients can still function against ordinary relays
- L2 adds performance and determinism instead of a hard dependency on a private API

---

## Suggested Capability Set for MVP

L2 MVP should advertise support for:

- `NIP-01`
- `NIP-11`
- `NIP-17`
- `NIP-42`
- `NIP-59`

Optional:

- `NIP-50` for bounded product search only, if implementation remains narrow and deterministic

Note:

Even if `NIP-50` is supported, Conduit clients should still treat general text search as opportunistic and keep product-browse fallback logic.

---

## Engineering Sequence

### Phase 1 - Product reads

Build first:

- mirrored `kind 30402` ingest
- deletion-aware product projection
- marketplace browse query
- merchant storefront query
- product detail resolution
- batched profile decoration

This phase replaces the most expensive current client fanout and gives immediate value to `/products`, `/store/$pubkey`, and `/products/$productId`.

### Phase 2 - Protected conversation summaries

Build next:

- `NIP-42` auth
- authorized buyer merchant-thread summaries
- authorized merchant order inbox summaries
- latest status and latest activity projections

This phase improves `/messages` and merchant `/orders` without breaking `NIP-17` privacy promises.

### Phase 3 - Live delivery and notification acceleration

Add:

- low-latency subscriptions
- status-change subscriptions
- bounded notification delivery behavior

---

## Out of Scope for Scope 2 MVP

- general marketplace search ranking
- recommendation systems
- ad products or sponsored placements
- personalized feed models
- broad analytics pipelines
- rich dashboard materialized views
- arbitrary private-message search
- any private-data API that bypasses relay auth

Those belong in later L2 phases only if clearly relay-native, or in Scope 3 if they are app-oriented read models.

---

## Open Decisions

These still need explicit design choices before implementation starts:

- whether mixed-currency price sorting should be allowed server-side in MVP
- whether conversation summaries are computed from encrypted metadata, authorized unwrap assistance, or another privacy-preserving mechanism
- exact cursor format for product and thread pagination
- whether L2 accepts convenience writes or remains mirror-only in MVP
- how much of product text search should use `NIP-50` versus a narrower Conduit capability
- exact graph inputs and thresholds for `trusted`, `connected`, `unknown`, and `suppressed` policy classes

---

## Build Checklist

An implementation can be considered Scope 2 MVP-ready when all are true:

- product browse no longer requires client fanout across multiple public relays in the happy path
- merchant storefront reads are deterministic and deletion-aware
- product detail lookup resolves addressable products without client-side scans
- buyer and merchant thread lists can load from authorized L2 summaries
- `NIP-42` protects all private summary/query surfaces
- clients still function against merchant/public relays when L2 is removed from the topology

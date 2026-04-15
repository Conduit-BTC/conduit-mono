# Conduit Relay Architecture

## Executive Summary

Conduit should be implemented as a **three-layer relay architecture with graceful degradation**:

1. **Merchant Dedicated Relays**
   The canonical publish and storage layer for merchant-owned events.
2. **Conduit L2 Relay Layer**
   A shared relay network that improves routing, read performance, delivery, and marketplace-level behavior.
3. **Conduit Cache / Index Layer**
   A derived application-performance layer used for fast hydration, search, and dashboard views.

The design goal is that **no Conduit-operated layer is required for baseline correctness**. If Conduit infrastructure is degraded, Market, Portal, and Store Builder must still be able to operate against merchant relays and compatible public relays, with reduced performance or UX where necessary.

This spec adds the implementation constraints needed to make that principle actionable:

- explicit layer responsibilities
- event lifecycle definitions
- consistency and freshness rules
- failure and recovery behavior
- privacy and authorization requirements for messaging
- rollout guidance for engineering sequencing

---

## Core Architectural Principles

### Sovereignty

Merchant relays are the canonical infrastructure for merchant-authored state. Conduit may accelerate, cache, index, and rebroadcast merchant data, but it must not become the only place that merchant state can be published or recovered from.

### Graceful degradation

Each layer improves system behavior, but loss of any single layer should degrade performance before it degrades correctness.

### Derived layers stay derived

L2 and cache/index layers may materialize, mirror, rank, or route events, but they do not redefine merchant truth.

### Privacy-preserving messaging

Direct messaging and private metadata access must preserve the privacy expectations of `NIP-17`. Relay access to protected data must require authenticated sessions via `NIP-42`, and relays must not expose query surfaces that allow unauthorized metadata discovery.

### Portable implementation

Merchant infrastructure should remain simple enough to run in hosted or self-hosted form without depending on Conduit-specific backend services.

### Open-source portability and interoperability

Conduit should design the relay stack so another operator can run the same software and participate in the same commerce network model without depending on Conduit-owned infrastructure.

That means the architecture should distinguish clearly between:

- open-source relay software that others can deploy
- interoperable protocol behavior that other clients and relays can consume
- optional Conduit-specific performance features that improve UX without becoming mandatory for correctness

---

## Layer Overview

## Scope 1 - Merchant Dedicated Relays

**Purpose:** canonical merchant infrastructure

Merchant dedicated relays are the source of truth for merchant-owned events and the merchant's sovereign Nostr presence.

### In scope

- hosted or self-hosted merchant relays
- canonical publish target for merchant-authored events
- durable storage and event retention
- inbox/outbox handling
- merchant relay list management
- relay access control
- basic spam and abuse controls
- optional rebroadcast to selected public or Conduit relays
- full Nostr support for merchant identity, commerce, and messaging use cases

### Primary event classes

- merchant metadata
- product listings
- inventory updates
- pricing changes
- order-related commerce events
- DMs and private messaging events
- social events such as notes, follows, and profile changes

### Explicit responsibilities

- accept canonical writes for merchant-authored events
- preserve event history and deletions according to policy
- expose merchant-authorized reads
- serve as the recovery source for merchant state
- enforce privacy constraints for protected event classes

### Out of scope

- global marketplace ranking
- marketplace-wide search infrastructure
- heavy cross-merchant aggregation
- application hydration APIs

### Design guidance

Keep this layer simple, stable, and portable. Merchant relays should be deployable without requiring the Conduit L2 or cache/index layers to exist.

---

## Scope 2 - Conduit L2 Relay Layer

**Purpose:** shared performance, routing, and relay-native marketplace behavior

The L2 layer is a Conduit-operated relay network that mirrors and routes events from merchant relays, Conduit relays, and public relays. It exists to improve latency, delivery, reliability, and marketplace-level reads without replacing merchant truth.

### In scope

- ingest from merchant relays, Conduit relays, and public relays
- event validation and deduplication
- relay health scoring
- relay selection and failover
- commerce-aware query execution that remains relay-native
- low-latency marketplace feed delivery
- notification fan-out and delivery acceleration
- policy enforcement such as spam controls, rate limiting, and merchant-tier limits
- selective rebroadcast to public relays

### Relay-native behaviors

These behaviors belong in L2 because they are close to relay routing and event distribution:

- subscription routing
- read fan-in across upstream relays
- deduplication of mirrored events
- delivery retries
- relay availability tracking
- bounded server-side filtering and sorting for relay queries
- notification transport based on event presence and subscription policy

### Not the job of L2

The L2 layer must not become a general-purpose application backend. The following belong elsewhere unless there is a relay-specific reason:

- long-lived application materialized views
- merchant dashboard projections
- search-document generation
- storefront hydration payload assembly
- business analytics pipelines

### Primary event classes

- mirrored commerce events
- feed-oriented derived views expressed as relay query results
- notification events
- relay health and routing metadata
- bounded ranking or prioritization signals used directly by relay query execution

### Out of scope

- canonical merchant truth
- required dependency for write correctness
- exclusive storage location for merchant events

---

## Scope 3 - Conduit Cache / Index Layer

**Purpose:** application-performance layer for Conduit apps

The cache/index layer is a derived system optimized for fast reads, search, storefront hydration, and dashboard use cases. It should be treated as disposable and rebuildable from relay-visible state.

### In scope

- caching for fast reads
- materialized views
- storefront hydration payloads
- merchant dashboards
- search indexes
- category and tag indexes
- denormalized read models for app UX

### Explicit responsibilities

- reduce latency for Conduit applications
- minimize relay round-trips
- precompute expensive application views
- support search and browse experiences
- rebuild from canonical and mirrored event sources

### Out of scope

- protocol source of truth
- required dependency for baseline app correctness
- private data access that bypasses relay authorization rules

---

## Responsibility Boundaries

### Merchant relays own

- canonical merchant-authored writes
- durable event retention
- merchant sovereignty
- private messaging access control

### L2 relays own

- routing
- mirroring
- relay-native query acceleration
- delivery performance
- notification transport

### Cache/index owns

- speed
- search
- app hydration
- dashboard-oriented read models

### Boundary rule

If a feature can be removed without changing protocol-visible correctness, it likely belongs in the cache/index layer rather than L2.

### Interoperability checklist

Use this checklist before adding relay features or query extensions:

- merchant relays remain the canonical source for merchant-authored state
- merchants can publish and recover state without Conduit-operated infrastructure
- core user flows still have a standards-based fallback using ordinary relay reads
- L2 acceleration is optional for correctness and only improves speed, ranking, routing, or aggregation
- relay behavior is expressed through standard Nostr mechanisms whenever possible
- any non-standard query behavior is capability-advertised and documented as optional
- Conduit-specific policy modules do not redefine the underlying event model
- privacy-sensitive messaging features preserve `NIP-17` expectations and require `NIP-42` authorization before protected data is exposed
- derived views can be rebuilt from relay-visible state rather than hidden private backends
- another operator can run the relay with different moderation, trust, retention, or routing policy without breaking protocol compatibility

### Interoperability warnings

The architecture is becoming too Conduit-specific if any of the following become true:

- merchants must publish to Conduit infrastructure to be discoverable
- clients must call Conduit-only query surfaces to render core marketplace or order flows
- L2 becomes the only practical source for current product state
- trust or abuse policy changes what events are considered valid rather than what is prioritized or suppressed locally
- private-thread UX depends on metadata that only Conduit can derive or authorize
- fallback behavior exists on paper but not at acceptable product or operational cost

---

## Event Lifecycle

This section defines how major event classes move through the system.

### 1. Merchant-authored commerce events

Examples:

- product listings
- pricing changes
- inventory updates
- merchant metadata

#### Publish path

1. Merchant client publishes to the merchant dedicated relay.
2. Merchant relay validates, stores, and acknowledges the event.
3. Merchant relay or an authorized replication worker republishes to selected Conduit L2 relays and optional public relays.
4. L2 relays validate, deduplicate, and make the event available for relay-native reads.
5. Cache/index consumers ingest the event and update derived read models.

#### Read path

1. Client attempts to read from the fastest available source according to product policy.
2. Preferred order for Conduit apps:
   a. cache/index for hydration-oriented views
   b. Conduit L2 for relay-native low-latency reads
   c. merchant relay for canonical verification or direct fallback
3. Freshness-sensitive flows may revalidate against the merchant relay before mutating actions.

#### Update and delete handling

- Updates are represented as new events according to the event model.
- Delete or tombstone semantics must propagate to L2 and cache/index consumers.
- Rebuilders must honor tombstones during replay or reindex.

### 2. Direct messages and private messaging events

DMs require stricter handling because privacy guarantees are part of product correctness.

#### Publish path

1. Client publishes private messaging events to an authorized relay endpoint.
2. Relay requires authenticated session establishment via `NIP-42` before allowing protected subscriptions or protected event interaction.
3. Relay stores and routes the event according to the merchant's messaging policy.
4. Any L2 acceleration for messaging must preserve authorization boundaries and must not expose unauthorized message existence or metadata.

#### Read path

1. Client authenticates to the relay using `NIP-42`.
2. Relay authorizes subscriptions for the requesting principal.
3. Only then may the client query protected DM/event metadata.

#### Privacy requirements

- Relays must not allow unauthenticated or unauthorized queries that reveal DM existence, participant metadata, timestamps, or related indexes.
- If `NIP-17` semantics imply privacy for mailbox discovery or message metadata, Conduit relays must preserve that privacy rather than exposing convenience query APIs.
- Search, caching, and indexing layers must not create side channels that expose private message metadata outside relay authorization.
- Any messaging acceleration in L2 must be implemented as authorized routing and delivery assistance, not as an unauthenticated discovery surface.

#### Implementation constraint

`NIP-42` support is required for merchant relays and any Conduit-operated relay that serves protected messaging or metadata queries.

### 3. Social events

Examples:

- notes
- follows
- profile changes

#### Handling

- Merchant relays may act as canonical publish targets for merchant-operated identities.
- L2 may mirror and accelerate reads.
- Cache/index may derive app views, but social correctness must remain recoverable from relay-visible state.

### 4. Notifications

Notifications are a delivery concern, not a new source of truth.

#### Handling

- Notification triggers derive from underlying events.
- L2 may accelerate fan-out and delivery tracking.
- Cache/index may store user-facing notification views.
- Rebuilding notifications must be possible from underlying event history and policy.

---

## Consistency and Freshness Model

This architecture uses an **authoritative-origin with derived replicas** model.

### Canonical truth

- Merchant-authored commerce state is canonical on the merchant relay.
- Derived copies on L2 and cache/index are read accelerators.

### Freshness expectations

- Cache/index may be stale.
- L2 may be stale or partially replicated.
- Merchant relay is the source for canonical verification.

### Client read policy

- Browsing flows may use cache/index or L2 for speed.
- Mutation-adjacent flows should verify freshness against canonical sources when stale reads could cause user-visible correctness issues.
- Product-specific tolerance for staleness should be defined per flow, especially for inventory and price-sensitive actions.

### Conflict and reconciliation rules

- Duplicate mirrored events are resolved by event identity and relay validation rules.
- If L2 or cache/index diverges from merchant relay state, merchant relay state wins for merchant-authored records.
- Replay and backfill jobs must support rebuilding derived layers from canonical and mirrored sources.
- Deletions and tombstones must be replay-safe and idempotent.

### Recovery rule

If a merchant relay comes back after downtime, L2 and cache/index must reconcile by replaying from the merchant relay rather than preserving stale derived state as authoritative.

---

## Failure and Degradation Behavior

### Merchant relay down

Apps may continue serving:

- mirrored data from Conduit L2
- previously seen data from public relays
- cache/index views

Constraints:

- reads may be stale
- writes requiring canonical merchant acceptance may be blocked or queued according to product policy
- mutation-sensitive flows should surface degraded-state behavior clearly

### L2 relay down

Apps fall back to:

- merchant relays
- public relays
- local or app cache

Impact:

- higher latency
- weaker feed performance
- reduced notification reliability

### Cache/index down

Apps fall back to:

- direct L2 reads
- direct merchant relay reads

Impact:

- slower storefront hydration
- degraded search and dashboard UX

### Public relays down

System continues via:

- merchant relays
- Conduit L2 relays

Impact:

- reduced public network reach
- weaker ecosystem replication

---

## Client Relay Product Contract

This section defines the minimum Phase 2 product contract for how relay roles and relay-backed reads should appear in Conduit clients.

### Product-facing relay roles

Across Conduit clients, product terminology should distinguish between:

- `merchant` for a merchant-controlled source-of-truth relay when present
- `l2` for de-commerce relay acceleration
- `general` for broader-network fallback and reach

`cache` or `index` remains a valid internal read source, but it should be treated primarily as an acceleration layer rather than as a user-managed relay role identical to the relay-network roles above.

### Settings surfaces

- Merchant clients should expose three relay groups:
  1. merchant relay
  2. de-commerce relays
  3. general relays
- Market or shopper clients should expose two relay groups:
  1. de-commerce relays
  2. general relays
- These settings surfaces should map cleanly to shared config and protocol code rather than introducing app-local relay models.

### Presentation guidance

- Relay settings should remain minimalist and future-friendly for mobile.
- The preferred treatment is a simple list of relay names with concise role badges or icons.
- Extra explanation may be available through lightweight detail affordances such as tooltips, helper text, or secondary views.
- The architecture should define the product contract without requiring one specific navigation entry point.

### Fallback and degraded-state messaging

- Fallback and degraded-state behavior must remain explicit in implementation.
- Not every relay settings view needs to surface stale or degraded-state detail at all times.
- Mutation-sensitive and trust-sensitive flows must still surface degraded-state behavior clearly when it affects user decisions.

### Shared fetch policy

- Clients should use centralized shared read-planning code for relay-backed reads.
- Shared read-planning should be route-aware rather than enforcing one universal precedence order.
- Route code should consume typed read results returned by shared protocol code instead of reconstructing relay precedence independently.
- Route code must not hard-code direct assumptions about cache, L2, merchant, or general relay internals.

### Route-aware read planning

Typical starting points include:

- marketplace browse and homepage reads may prefer:
  1. cache or index
  2. `l2`
  3. `general`
- merchant-specific storefront or product-detail reads may prefer:
  1. `merchant` when the merchant source-of-truth relay is known and available
  2. `l2`
  3. `general`
- mutation-adjacent and verification-sensitive flows may require merchant-first canonical revalidation before acting.

These are product-policy defaults, not a rule that every route must share the same order.

### Progressive verification

- Fast browse surfaces may render from cache or other accelerated reads first to avoid blank-page loading.
- Clients may update product cards, listings, and detail views as stronger sources confirm or replace earlier accelerated results.
- Source indicators should be subtle by default for ordinary browsing.
- Clients may expose more detailed source information through badges, tooltips, or similar affordances for users who want to inspect where data came from.
- When multiple sources agree, the UI may reflect that confirmation without implying that derived layers have become canonical.

### Implementation constraint

- The absence of prominent source-state messaging in ordinary browsing must not cause clients to collapse back to a single-source read assumption.
- Merchant-controlled relay truth remains canonical for merchant-authored state even when faster layers render first.

---

## Security and Privacy Requirements

### Authentication

- Protected relay reads must require `NIP-42` authentication.
- Conduit-operated relays must reject unauthorized subscriptions for protected event classes.

### Authorization

- Authorization policies must be applied before query execution for protected data.
- Relay filters must not leak whether hidden data exists when the requester is unauthorized.

### Abuse controls

- Merchant relays and L2 relays should implement spam controls, rate limiting, and policy hooks.
- Abuse controls must not silently weaken privacy guarantees for protected messaging surfaces.

### Derived-system constraints

- Cache/index systems must never become an alternate private-data API.
- Internal operators should be able to rebuild derived systems without bypassing relay-layer authorization design.

---

## Implementation Sequence

### Phase 1 - Merchant relay baseline

Build the sovereign core first:

- canonical merchant writes
- durable storage
- relay list management
- basic replication hooks
- `NIP-42` support for protected reads
- baseline DM/privacy enforcement

### Phase 2 - L2 relay acceleration

Add shared network behavior:

- mirroring
- deduplication
- relay health scoring
- relay-native query acceleration
- notification transport
- bounded policy modules

### Phase 3 - Cache/index optimization

Add app-performance systems:

- storefront hydration views
- search indexes
- dashboard projections
- rebuild and replay tooling

### Sequence rule

Do not implement application-critical behavior in L2 or cache/index before the merchant relay path can operate correctly on its own.

---

## Open Implementation Decisions

These items should be resolved during detailed design:

- exact staleness policy per user flow, especially inventory and checkout-adjacent reads
- whether message acceleration mirrors encrypted payloads, envelopes, or only routing metadata
- replay cursor and backfill strategy between merchant relays and L2
- deletion retention policy and tombstone propagation windows
- operational model for hosted merchant relays versus self-hosted merchant relays

---

## Summary

Scope 1 is merchant truth.

Scope 2 is relay-native network performance and routing.

Scope 3 is application-performance and search.

All Conduit-operated layers are optional for baseline functionality, but only if:

- merchant relays remain the canonical source
- derived layers can be rebuilt
- freshness and reconciliation rules are explicit
- private messaging remains protected with `NIP-42`-gated access that preserves `NIP-17` privacy expectations

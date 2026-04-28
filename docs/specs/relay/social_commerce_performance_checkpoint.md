# Social Commerce Relay Performance Checkpoint

## Status

Checkpoint / future-sprint planning spec.

This document captures the relay-performance architecture discussion after reviewing a high-performance Nostr reference client and comparing it with Conduit's current Market and Merchant implementation.

It is not a replacement for `docs/specs/relay/conduit_relay_architecture.md`. The existing relay architecture remains the source of truth for the user-facing relay model:

- users configure `IN` and `OUT`
- Conduit detects relay capabilities
- Conduit uses commerce priority only as a local app planning signal
- internal acceleration, cache, and routing behavior must not become user-managed relay roles

This document focuses on the next performance layer: how Conduit should hydrate product, store, profile, order, and social-commerce surfaces quickly over ordinary Nostr relays while remaining compatible with future cache or acceleration paths.

## Background

Conduit is currently optimized around the MVP commerce loop:

- product browse
- merchant storefronts
- product detail
- product publish/delete
- NIP-17 order messaging
- local Dexie caching for products, profiles, orders, and messages

The near-future product direction turns Conduit into a blended social-commerce app:

- product cards will show comments, likes/reactions, zaps, and trust context
- merchant and buyer profiles will include social feeds
- merchants will inspect product social activity and customer profiles
- long-form reviews and detailed reads will become part of product trust evaluation

That means the performance target is no longer only "make products load." Conduit needs a general event-graph hydration model where commerce events are the core nodes and social events progressively attach to them.

## Reference Architecture Observations

The reviewed reference codebase is a native Nostr client that achieves strong perceived performance primarily through relay planning and progressive hydration, not through a hidden centralized backend.

### Key Reference Strategies

1. It builds a relay pool with bounded persistent and ephemeral connections.
2. It uses NIP-65 relay lists to route reads by an author's write relays.
3. It routes writes to both the publisher's write relays and the recipient's read/inbox relays.
4. It maintains an author-to-relay coverage scoreboard so broad feeds can target a small useful relay set.
5. It chunks large author and event-id filters to avoid relay filter limits.
6. It treats indexer/search relays as safety nets, not the default path for every request.
7. It deduplicates events before expensive processing.
8. It persists a narrow set of high-value events locally and hydrates UI from that local store first.
9. It delays expensive engagement fetches until cards/items are visible.
10. It batches UI emissions and profile sweeps so bursty relay traffic does not create render storms.

The most important lesson is that performance comes from shaping the event graph and relay graph before asking for data.

## Current Conduit Architecture

Conduit already has some of the right abstractions:

- `packages/core/src/protocol/commerce.ts` returns typed `CommerceResult<T>` values with `meta` describing source, stale state, degradation, capabilities, and fetch time.
- `packages/core/src/db/index.ts` persists products, profiles, and order messages in Dexie.
- Product parsing, product dedupe, deletion filtering, order-message parsing, and profile caching already live in shared `@conduit/core` code.
- Phase 2 planning already calls for route-aware read planning, progressive verification, source-agnostic routes, relay preference/capability state, and relay settings UX.
- `docs/specs/relay/conduit_relay_architecture.md` already defines the correct Nostr-native user model: `IN`, `OUT`, capability detection, commerce priority, and route-aware planning.

However, the implementation is still MVP-shaped:

- marketplace reads mostly fan out to configured public relays
- merchant storefront reads use configured merchant relay buckets rather than discovered merchant write relays
- product/detail/social reads do not yet use a shared relay planner
- local cache is mostly used as a fallback after network failure, not as the first-render hydration path
- profile lookup is cached but not yet integrated into a broader social graph hydration pipeline
- NIP-17 order/message publish paths rely on generic NDK publish behavior instead of explicit recipient inbox/read-relay planning
- product-card social data is not yet modeled as separately staged hydration

## Key Architectural Differences

### 1. Relay Topology

Reference approach:

- Maintains an explicit relay pool.
- Separates persistent, DM, group, and ephemeral relays.
- Caps ephemeral relays and evicts least-recently-used connections.
- Tracks relay health and cooldowns.

Current Conduit approach:

- Uses NDK instances and configured relay arrays.
- Fanout helper creates per-relay NDK instances for fetches.
- Relay roles are still partly represented as config buckets in code.
- Relay health/capability data is not yet a shared planning input.

Architectural implication:

Conduit needs a shared relay planner and connection strategy that can choose target relays by route intent, event kind, author, recipient, capability, and recent relay health. It does not need to copy the reference client's full relay pool immediately, but it does need the planning layer that makes a pool useful.

### 2. Read Strategy

Reference approach:

- Reads notes from each author's write relays.
- Groups many authors into one REQ per relay.
- Uses indexers only as a fallback or safety net.
- Waits for reachable EOSE quorum rather than every possible relay.

Current Conduit approach:

- Marketplace reads fetch product events from public relays.
- Merchant storefront reads fetch products by merchant author from configured merchant relays.
- Product detail may scan a merchant storefront to resolve addressable products.
- Reads return source metadata, but actual source selection is not yet route-planned.

Architectural implication:

Product and social reads should be author-routed:

- products: merchant write relays
- product comments/reviews: product author's read/inbox relays plus commenters' write relays where needed
- reactions/zaps: target author's read/inbox relays plus event-specified relays
- profile feeds: profile owner's write relays
- trust/social context: bounded reads from the relevant users' write/read relay sets

### 3. Write Strategy

Reference approach:

- Publishes normal posts to the user's write relays.
- Publishes replies, reactions, mentions, and reposts to recipient read/inbox relays as well.
- Uses relay hints that prefer overlap between recipient inbox and publisher outbox.
- Treats DM delivery relays separately and more carefully.

Current Conduit approach:

- Product publish/delete uses generic `event.publish()`.
- Checkout and merchant order messages use NIP-17 gift wraps and generic publish.
- Recipient relay preferences are not yet explicit inputs to publish planning.

Architectural implication:

Conduit writes need explicit routing:

- product listings and deletions: merchant `OUT` relays, prioritizing commerce-compatible relays
- product comments/reviews: writer `OUT` relays plus product merchant's read/inbox relays
- reactions/zaps: actor `OUT` relays plus target author's read/inbox relays and any protocol-specified relay hints
- NIP-17 order messages: recipient DM/read relays plus sender/self storage relays
- profile updates: user `OUT` relays

### 4. Cache And Hydration

Reference approach:

- Seeds UI from local persistence on warm start.
- Persists only high-value event kinds.
- Uses write-behind batching for persistence.
- Debounces UI updates and version counters.

Current Conduit approach:

- Dexie stores products, profiles, orders, messages, and order message summaries.
- Product/profile cache TTLs exist.
- Product browse generally waits on relay reads before falling back to local cache on failure.

Architectural implication:

Conduit should use local cache as the first paint path for product and store surfaces, not merely an error fallback. Network reads should progressively verify and refine the cached view.

### 5. Engagement And Social Hydration

Reference approach:

- Fetches engagement for the first visible batch.
- Uses viewport change events to fetch more engagement data.
- Closes or lets old subscriptions age out after data is cached.
- Uses special fast collectors for bursty engagement types.

Current Conduit approach:

- Product cards do not yet hydrate comments/reactions/zaps.
- Future social data is not yet assigned staged fetch priorities.

Architectural implication:

Product cards must not fetch the entire social graph up front. Social data should hydrate in stages based on visibility, route importance, and user intent.

## Diagnosed Performance Problems

### Problem 1: Broad Public Fanout Is The Default For Marketplace Reads

Symptom:

Marketplace product lists may feel slow, inconsistent, or empty depending on public relay behavior.

Root cause:

The read path asks broad public relays for product events instead of first using merchant-specific relay intelligence. Public relays are useful discovery surfaces, but they are not guaranteed to carry every merchant's latest replaceable product events or tombstones.

Needed correction:

Use merchant write relays and commerce-compatible `IN` relays as the primary product read path. Public relays should remain fallback/discovery sources.

### Problem 2: Cache Is Treated More Like Failure Recovery Than First Paint

Symptom:

Users may see loading states even when recently fetched products or profiles exist locally.

Root cause:

Local Dexie cache is generally consulted after network failure in product reads, instead of being used to immediately render stale-aware UI while relay verification proceeds.

Needed correction:

Adopt cache-first progressive hydration for card grids, storefronts, profile headers, and order/message lists.

### Problem 3: Relay Source Metadata Exists But Does Not Yet Drive Planning

Symptom:

The code has `CommerceReadSource` and `READ_PLANS`, but actual reads still select concrete relay buckets directly.

Root cause:

The architecture has typed read metadata, but no central planner that maps route intent to relays, capabilities, NIP-65 data, and cache strategy.

Needed correction:

Implement a shared relay planner in `@conduit/core` and make route-level APIs consume plans rather than hard-coded relay arrays.

### Problem 4: Product Detail Resolution Can Be Too Expensive

Symptom:

Resolving a product detail by address may require loading a broad merchant storefront set.

Root cause:

The current product detail path does not yet have a direct addressable event lookup strategy that uses `#d`, merchant pubkey, and relay planning consistently.

Needed correction:

Product detail should resolve by address using merchant write relays and a direct `kind/pubkey/#d` filter, then fall back to cached/storefront/public reads.

### Problem 5: NIP-17 Messaging Delivery Is Under-Planned

Symptom:

Order and message delivery depends on generic publish behavior and configured relay connectivity.

Root cause:

Recipient read/DM relays are not yet first-class routing inputs for NIP-17 gift-wrap delivery.

Needed correction:

NIP-17 publish planning should target recipient read/DM relays, sender self-storage relays, and commerce-compatible write relays where appropriate.

### Problem 6: Future Social Features Could Create A Request Explosion

Symptom:

If every product card fetches comments, reactions, zaps, reviews, merchant profile, buyer trust context, and profile feed data at once, Market will degrade quickly.

Root cause:

Social features create a graph around every commerce object. Without staged hydration and viewport-aware batching, each card becomes a bundle of many relay queries.

Needed correction:

Model social data as progressive event graph hydration attached to product and profile nodes.

### Problem 7: Repeated Profile And Trust Context Fetches Will Compound

Symptom:

Product grids, storefronts, carts, checkout, order lists, comments, reviews, and profile feeds all need profile decoration.

Root cause:

Profiles are cross-cutting metadata. If each surface requests profiles independently, the app repeats relay reads and creates inconsistent loading behavior.

Needed correction:

Create a shared metadata hydration pipeline with batching, dedupe, cache-first reads, and periodic refresh.

## Agreed Design Principles

### 1. Nostr-Native Relay Planning

Conduit should not invent fixed user-facing relay roles.

Users configure:

- `IN`
- `OUT`
- Conduit-local commerce priority

Conduit detects:

- NIP-11 availability
- NIP-50/search support
- NIP-17/DM suitability
- NIP-42/auth support
- commerce compatibility
- warning states

The app plans relay usage based on route intent and detected capabilities.

### 2. Author-Routed Reads

When reading authored state, prefer the author's write relays from NIP-65.

Examples:

- merchant products: merchant write relays
- profile feed: profile owner's write relays
- long-form reviews by a reviewer: reviewer write relays
- comments by known commenters: commenter write relays where appropriate

### 3. Recipient-Aware Writes

When writing events meant to be seen by a target, publish to both the actor's write relays and the recipient's read/inbox relays.

Examples:

- product comment: commenter's write relays plus merchant/product author's read relays
- product reaction: reactor's write relays plus product author's read relays
- order DM: sender/self relays plus recipient DM/read relays

### 4. Progressive Hydration

The UI should render useful content as soon as possible and then refine it.

Order of preference for many surfaces:

1. local cache for first paint
2. targeted relay reads for verification/freshness
3. broader public or search/index relays for discovery or fallback
4. stale/degraded UI state when freshness cannot be confirmed

### 5. Event Graph Model

Conduit should model data as an event graph:

- product listing is a primary commerce node
- merchant profile is an identity node
- comments/reviews are child or related content nodes
- reactions/zaps are engagement edges
- order messages are protected conversation edges
- long-form reviews are content nodes attached to products and profiles

Hydration should fetch the graph in priority order rather than treating every route as an unrelated query.

### 6. Viewport-Aware Social Fetching

Social counters and previews should be fetched only for visible or near-visible cards.

Full comment/review/thread data should be reserved for:

- product detail
- profile detail
- expanded social panels
- merchant moderation/inspection views

### 7. Bounded Fanout

Every fanout should have:

- relay limits
- author/event-id chunking
- timeout boundaries
- dedupe behavior
- fallback policy
- stale/degraded metadata

### 8. Shared Core Over Route Logic

Relay planning, NIP-65 parsing, capability scanning, relay health, event graph hydration, and cache policy should live in `@conduit/core`, not app routes.

Routes should consume stable typed results and source/degraded metadata.

## Proposed System Architecture

### Layer 1: Relay Preference And Capability State

Shared model:

```typescript
interface RelaySettingsEntry {
  url: string
  readEnabled: boolean
  writeEnabled: boolean
  section: "commerce" | "public"
  commercePriority?: number
  capabilities: {
    nip11: boolean
    search: boolean
    dm: boolean
    auth: boolean
    commerce: boolean
  }
  warnings: {
    dmWithoutAuth: boolean
    staleRelayInfo: boolean
    unreachable: boolean
    commercePartialSupport: boolean
  }
}
```

This remains aligned with `conduit_relay_architecture.md`.

### Layer 2: NIP-65 Relay List Cache

Cache per pubkey:

- read relays
- write relays
- event timestamp
- last fetch time
- source relay(s)

Uses:

- product/store reads
- profile/social feed reads
- comment/review reads
- engagement reads
- recipient-aware writes
- DM delivery planning

### Layer 3: Relay Planner

Planner inputs:

- route intent
- event kind(s)
- actor pubkey
- target pubkey(s)
- product address/event id
- cached relay lists
- relay settings
- relay capabilities
- relay health
- recent success/failure data
- privacy requirement

Example route intents:

- `marketplace_products`
- `merchant_storefront`
- `product_detail`
- `product_card_social_summary`
- `product_comments_preview`
- `product_reviews`
- `profile_header`
- `profile_social_feed`
- `conversation_list`
- `conversation_detail`
- `commerce_publish`
- `recipient_message_publish`

Planner output:

```typescript
interface RelayReadPlan {
  intent: string
  primaryRelays: string[]
  fallbackRelays: string[]
  safetyNetRelays: string[]
  filters: NDKFilter[]
  maxRelays: number
  timeoutMs: number
  staleAllowed: boolean
}

interface RelayWritePlan {
  intent: string
  primaryRelays: string[]
  secondaryRelays: string[]
  requireAckCount?: number
  surfacePartialFailure: boolean
}
```

### Layer 4: Commerce Event Cache

Dexie remains the client-side persistence layer.

Recommended persisted objects:

- products
- product deletion/tombstone records
- profiles
- relay lists
- order messages
- social counters by event id
- recent comments/reviews by product id
- recent profile feed events
- zap/reaction aggregates where inexpensive

Cache entries should carry:

- cached time
- event created time
- source relay(s)
- verification status
- stale flag or freshness window

### Layer 5: Event Graph Hydrator

The hydrator should coordinate staged reads.

For a product card:

1. render cached product fields
2. verify product event from merchant write relays
3. hydrate merchant profile
4. hydrate social counters for visible cards
5. hydrate top comment/review preview only when card is visible or expanded
6. hydrate full threads only on detail routes

For a profile:

1. render cached profile header
2. verify kind `0`
3. fetch profile owner's recent social feed from write relays
4. hydrate related commerce objects referenced by feed events
5. hydrate trust context progressively

For Merchant:

1. render cached listings immediately
2. verify own product state from configured/user `OUT` and commerce-compatible relays
3. hydrate product social summaries for visible merchant product rows
4. hydrate customer profiles for visible order/conversation rows

### Layer 6: UI Source And Freshness Model

UI should expose source state only where it helps decisions.

Examples:

- product grid: subtle stale/degraded state, no noisy relay labels
- product detail: clearer freshness indicator if product state cannot be verified
- checkout: stronger warnings when merchant/product/payment state is stale
- merchant product management: publish/verification status should be explicit
- order/messages: delivery and local-cache state should be clear

## Recommended Next Steps

These steps intentionally exclude the already-handled conceptual cleanup PR.

### Step 1: Add This Performance Spec To The Relay Specs

Land this document, or a refined version of it, under `docs/specs/relay/`.

Purpose:

- preserve the architectural checkpoint
- make future sprint planning explicit
- define how social-commerce performance extends the existing relay architecture

### Step 2: Define The Shared Relay Planner Interface

Add an implementation spec or code scaffold in `@conduit/core` for:

- route intent enum
- relay read plan
- relay write plan
- planner inputs
- planner output metadata
- source/freshness/degraded semantics

The first version can be mostly deterministic and local. It does not need full active probing on day one.

### Step 3: Add NIP-65 Relay List Parsing And Cache

Implement shared support for:

- parsing kind `10002`
- serializing current user's relay preferences
- fetching relay lists by pubkey
- caching relay lists in Dexie
- exposing `getReadRelays(pubkey)` and `getWriteRelays(pubkey)`

This is the foundation for both commerce and social features.

### Step 4: Convert Product Reads To Cache-First Progressive Hydration

For marketplace, storefront, and product detail:

- render from Dexie when available
- issue targeted relay verification in the background
- update result metadata when verified
- use public/search relays as fallback or discovery
- keep route components source-agnostic

### Step 5: Convert Product Reads To Merchant Write-Relay Routing

For merchant-specific product reads:

- fetch merchant relay list
- target merchant write relays for product listings
- use commerce-compatible `IN` relays as preferred configured paths when available
- fall back to public relays with stale/degraded state

### Step 6: Define Product Card Social Hydration Tiers

Before adding social UI, define exactly what product cards fetch:

- initial card fields
- merchant profile
- reaction count
- zap count
- comment count
- top comment/review preview
- full social thread

Assign each tier a trigger:

- immediate
- after product verification
- viewport visible
- near viewport
- user expands
- detail route only

### Step 7: Add Engagement Summary APIs In Core

Add shared APIs such as:

- `getProductSocialSummary(productEventId | addressId)`
- `getProductCommentsPreview(productEventId | addressId)`
- `getProductZaps(productEventId | addressId)`
- `getProductReviews(productAddressId)`

These APIs should use the relay planner, not route-local fanout.

### Step 8: Convert Writes To Explicit Write Plans

Update shared publish helpers so routes no longer rely on generic publish behavior for commerce-critical events.

Cover:

- product publish/delete
- profile publish
- order NIP-17 gift wraps
- merchant order replies
- future comments/reactions/reviews

Each publish should know:

- primary target relays
- secondary target relays
- expected ack behavior
- whether partial failure should be shown to the user

### Step 9: Add Relay Health And Bounded Fanout Controls

Implement local health tracking:

- connection failures
- timeout counts
- event success
- publish ack success/failure
- short cooldowns for repeatedly failing relays

Apply bounded fanout:

- max relays per query intent
- chunk sizes for authors and event ids
- timeout and EOSE/quorum behavior
- dedupe before expensive parsing

### Step 10: Add Tests Around Planning And Hydration

Add unit tests for:

- relay list parsing
- planner output for commerce reads
- planner output for social reads
- planner output for recipient-aware writes
- cache-first product hydration
- stale/degraded metadata behavior
- product address resolution without broad storefront scans

Add relay smoke tests later for:

- product publish -> targeted read
- product delete -> tombstone-aware read
- NIP-17 publish to recipient relays
- engagement event discovery around a product

## Assumptions

1. Conduit remains external-signer-only.
2. Conduit does not custody keys or funds.
3. NIP-65 relay lists are useful but not always present or complete.
4. Public relays remain necessary for discovery and fallback.
5. Commerce-compatible relays improve reliability but are not the only valid Nostr relays.
6. Future cache or acceleration layers may exist, but route code should not depend on a single backend shape.
7. Product and social surfaces must keep working when enhanced relay/capability data is absent.
8. Social features will substantially increase relay query volume if not staged.

## Tradeoffs

### More Planning Complexity, Better UX Predictability

Adding a relay planner is more complex than direct NDK calls, but it prevents every route from inventing its own relay behavior.

### Cache-First Rendering Can Show Stale Data

Cache-first UI improves perceived speed, but it requires clear stale/degraded metadata and stronger verification before high-risk actions like checkout or merchant product edits.

### Author-Routed Reads Require Relay List Discovery

NIP-65 routing is more efficient when relay lists exist. When they do not, Conduit needs fallback relays, learned hints, and public discovery.

### Viewport-Aware Social Fetching Delays Some Data

Not all social counts/comments will appear instantly. This is preferable to slowing every product card while the app fetches complete social context.

### Recipient-Aware Writes Increase Publish Targets

Publishing to recipient read/inbox relays improves delivery, but increases publish fanout and partial failure cases. The UI needs sensible handling instead of treating every partial failure as catastrophic.

### Shared Core Work Comes Before Visible Social Features

The best time to build the planner/hydrator is before product-card social features ship. Otherwise social features will likely hard-code request behavior that must be unwound later.

## Summary

Conduit should evolve from MVP relay fanout toward a client-side social-commerce event graph architecture:

- local cache gives fast first paint
- relay planner chooses target relays by route intent
- NIP-65 routes reads and writes around authors and recipients
- product cards hydrate social data progressively
- profile and trust surfaces use the same shared graph hydrator
- routes consume typed results and freshness metadata rather than raw relay behavior

The near-term goal is fast, trustworthy product and store rendering. The durable architecture should also support comments, reactions, zaps, reviews, and profile social feeds without turning every product card into an unbounded relay workload.

## Machine-Readable Addendum

```yaml
machine_readable_addendum:
  version: 1
  captured_at: "2026-04-28"
  source_issue:
    id: "CND-20"
    suggested_title: "[RELAY] Social-commerce relay planner, cache-first reads, and explicit writes"
    purpose: >
      Consolidate the remaining relay read/write strategy work from CND-6 with
      the social commerce performance checkpoint so relay routing, caching,
      product hydration, explicit publish behavior, and relay settings UX are
      implemented as one coherent direction.
  related_issues:
    - id: "CND-6"
      relationship: "absorbed_remaining_behavior_scope"
      notes:
        - "CND-6 can be cleared once CND-20 carries the remaining read/write strategy work."
        - "Do not revive user-managed relay roles; the current direction is IN/OUT plus local commerce priority and capability detection."
    - id: "CND-19"
      relationship: "relay_settings_selector_foundation"
      notes:
        - "The selector architecture remains the base UI model."
        - "CND-20 may clean up presentation, density, routing, and entry points without changing the selector architecture."
    - id: "CND-7"
      relationship: "market_readiness_overlap"
      notes:
        - "Readiness/status may summarize relay health but should not create a second relay settings destination."
    - id: "CND-8"
      relationship: "publish_and_order_overlap"
      notes:
        - "Commerce-critical writes must use explicit relay plans before order and merchant flows depend on them."
    - id: "CND-9"
      relationship: "product_detail_overlap"
      notes:
        - "Product detail should use direct address/event lookup and cached hydration, not broad storefront scans."
    - id: "CND-10"
      relationship: "storefront_overlap"
      notes:
        - "Merchant storefront routes should share the same planner, cache, freshness, and degradation model."
    - id: "CND-12"
      relationship: "future_social_overlap"
      notes:
        - "Comments, reactions, zaps, reviews, and social proof should use staged hydration APIs instead of route-local fanout."
  current_codebase_state:
    completed:
      - "Relay settings UI model exists with commerce and public relay grouping."
      - "IN and OUT preferences are represented as the user-facing relay controls."
      - "Relay capability indicators exist for search, DM/inbox, auth, warning, and refresh."
      - "The far-right warning indicator is correctly treated as potentially important."
      - "Refresh is present and should remain a primary control aligned with IN/OUT."
    incomplete:
      - "The app cannot yet show a verified NIP-65 relay list from the user's actual Nostr network state."
      - "Relay settings currently have limited or no impact on route-level read/write plans."
      - "Signer relay import depends on optional NIP-07 getRelays support and needs fallback behavior."
      - "Product, profile, order, message, and future social writes still need explicit publish plans."
      - "Product reads and product detail hydration still need cache-first and author-routed behavior."
      - "The relay settings page has multiple navigation paths and a noisy desktop presentation that conflicts with the desired compact direction."
  implementation_workstreams:
    - id: "docs_checkpoint"
      type: "documentation"
      required: true
      outputs:
        - "Add this performance checkpoint to the repository."
        - "Keep the checkpoint aligned with the relay architecture spec."
        - "Reference CND-20 as the implementation ticket that absorbs the remaining CND-6 behavior scope."
    - id: "nip65_relay_list_cache"
      type: "core"
      required: true
      outputs:
        - "Fetch and parse kind 10002 relay lists."
        - "Persist relay list cache with freshness and provenance."
        - "Handle missing, stale, malformed, or partial relay list data."
        - "Import signer relay hints when available without assuming all signers support getRelays."
    - id: "relay_planner"
      type: "core"
      required: true
      outputs:
        - "Create shared read plans by intent."
        - "Create shared write plans by commerce-critical event type."
        - "Prefer author and recipient relay hints when available."
        - "Apply bounded fanout, relay health, timeouts, EOSE/quorum behavior, and dedupe."
    - id: "cache_first_reads"
      type: "app_and_core"
      required: true
      outputs:
        - "Render cached products, profiles, and store data first when available."
        - "Expose freshness and degradation metadata to routes."
        - "Refresh in the background using planner output."
        - "Avoid broad scans for product detail when an address or event id is known."
    - id: "explicit_writes"
      type: "app_and_core"
      required: true
      outputs:
        - "Use explicit publish targets for product publish and delete."
        - "Use explicit publish targets for profile updates."
        - "Use recipient-aware relay targets for NIP-17 order messages and merchant replies."
        - "Surface partial publish failures with commerce-appropriate severity."
    - id: "progressive_social_hydration"
      type: "core_scaffold"
      required: true
      outputs:
        - "Add shared APIs for product social summaries, comment previews, zaps, and reviews."
        - "Hydrate social data by route, viewport, interaction, and detail-page priority."
        - "Prevent product grids from triggering unbounded social relay queries."
    - id: "relay_settings_ux_cleanup"
      type: "ux"
      required: true
      outputs:
        - "Make the darker compact relay settings mock the target visual direction."
        - "Keep relay settings available from the top-right profile/account menu only."
        - "Remove or hide competing left-nav relay/network entry points."
        - "Keep IN, OUT, and refresh as primary controls with matching control size."
        - "Keep search, DM, and auth indicators smaller and informational."
        - "Keep warnings visually discoverable but avoid repeating long row-level warning text by default."
        - "Make relay URL and enabled/disabled state the row's primary readable information."
        - "Use compact grouping for commerce-enabled relays and other public relays."
        - "Keep add-relay interaction compact or collapsed until active."
        - "Use tooltips, hover details, or row expansion for capability explanations instead of permanent labels under every icon."
  ux_reference:
    desired_visual_reference:
      local_path: "/Users/ericfj/Downloads/Dark-Mode Relay Selector UI - Relay Selector UI 3 (1).png"
      linear_attachment_title: "Desired darker relay settings UX reference"
      interpretation:
        - "Darker, quieter, compact page."
        - "Relay groups are framed but not visually heavy."
        - "IN/OUT toggles dominate the action area."
        - "Capability icons are smaller than primary controls."
        - "Add Relay appears as a clean compact action."
    current_visual_reference:
      description: "Larger, lighter relay settings screenshot supplied in the planning thread."
      keep:
        - "Useful status information."
        - "Refresh action on the far right."
        - "Warning indicator semantics."
      change:
        - "Reduce noisy labels, repeated warnings, and oversized capability controls."
        - "Remove multiple visible navigation paths into relay settings."
        - "Tighten layout density and hierarchy."
  acceptance_criteria:
    - "Relay settings preferences change the actual planner inputs used by market and merchant routes."
    - "User relay data can be read from NIP-65 when available and displayed with provenance and freshness."
    - "Commerce-compatible relays are prioritized locally without publishing a custom relay role model."
    - "Product list, product detail, storefront, profile, order, and message paths consume shared planner behavior."
    - "Commerce-critical writes report ack state and partial failure in a user-appropriate way."
    - "Product cards can show cached or staged social summaries without blocking first paint."
    - "Relay settings UX has one primary entry point and matches the compact dark design direction."
    - "Search, DM, auth, warning, and refresh indicators have clear hierarchy: IN/OUT/refresh are primary, capability indicators are secondary."
  verification:
    required_tests:
      - "Relay list parsing."
      - "Planner output for commerce reads."
      - "Planner output for social reads."
      - "Planner output for recipient-aware writes."
      - "Cache-first product hydration."
      - "Stale or degraded metadata behavior."
      - "Product address resolution without broad storefront scans."
      - "Relay settings preference changes affect planner output."
    required_manual_checks:
      - "Relay settings desktop and mobile density against desired dark reference."
      - "Only top-right profile/account menu exposes relay settings as a primary navigation path."
      - "Refresh, warning, and capability indicator hierarchy is readable without row clutter."
      - "Market product list and detail routes show useful cached state before relay refresh completes."
  non_goals:
    - "Do not add user-managed relay roles."
    - "Do not add a hidden backend dependency for client route correctness."
    - "Do not ship full comments, reactions, zaps, reviews, or profile feeds as part of this checkpoint."
    - "Do not implement payment proof, fast checkout, or trust UI in this ticket."
    - "Do not replace the CND-19 relay selector architecture; clean up its UX and wire it into behavior."
  recommended_pr_sequence:
    - order: 1
      scope: "docs"
      description: "Add the social commerce performance checkpoint and this addendum."
    - order: 2
      scope: "core"
      description: "Add NIP-65 relay list cache and planner primitives."
    - order: 3
      scope: "market_reads"
      description: "Move product list, product detail, and storefront reads to cache-first planner behavior."
    - order: 4
      scope: "commerce_writes"
      description: "Move product, profile, order, and message writes to explicit publish plans."
    - order: 5
      scope: "ux_cleanup"
      description: "Clean up relay settings density, hierarchy, and single entry point."
    - order: 6
      scope: "social_scaffold"
      description: "Add progressive social hydration APIs without shipping full social surfaces."
```

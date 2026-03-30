# Client-Side Commerce Read Architecture Plan

## Why This Document Exists

This document is a **design-review snapshot** of the client-side relay architecture plan and the reasoning that led to it.

It exists primarily so collaborators reviewing the relay/client direction, including cofounder review, can understand:

- the intended client-side read architecture
- the future Scope 1 / Scope 2 / Scope 3 compatibility goals
- the implementation sequencing and tradeoffs we chose at the time

## How To Use This Document

Treat this file as **planning context**, not the permanent source of truth.

Use it to review the architecture direction, implementation intent, and rationale behind the commerce read gateway work.

Over time, the current source of truth should be:

- the relay specs in `docs/specs/relay/`
- the live code in `packages/core/` and the app routes
- tests that lock the intended client behavior

If this plan ever drifts from the specs or code, the specs and code should win.

## Summary

Implement a shared client-side `commerce read gateway` in `packages/core` that becomes the only place app code asks for product, profile, and order-thread reads.

This gateway must be designed now for all three future infrastructure scopes:
- Scope 1: merchant-haven relay as canonical merchant read/write source
- Scope 2: Conduit L2 relay as relay-native acceleration
- Scope 3: cache/index service as fastest hydration/search layer

Routes should depend only on stable typed query contracts and source metadata, never on a specific backend shape. That prevents a second rewrite when Scope 1 and Scope 3 arrive.

## Key Changes

### 1. Build a source-agnostic read gateway, not an L2-only adapter
Create a shared module in `packages/core` that exposes stable commerce query functions:
- `getMarketplaceProducts`
- `getMerchantStorefront`
- `getProductDetail`
- `getProfiles`
- `getBuyerConversationList`
- `getMerchantConversationList`
- `getConversationDetail`

These functions should return:
- typed domain data
- `meta.source` as one of `cache | l2 | merchant | public | local_cache`
- `meta.degraded`
- `meta.stale`
- `meta.capabilities`
- `meta.fetchedAt`

The gateway owns read precedence and fallback. Routes must not directly orchestrate relay fanout, protected summary reads, or unwrap-first list assembly.

### 2. Lock read precedence now so future scopes fit without route rewrites
Use these defaults inside the gateway:

For public/browse-style reads:
1. Scope 3 cache/index when available
2. Scope 2 L2 relay
3. Scope 1 merchant relay when merchant-scoped or freshness-sensitive
4. public relay fanout fallback
5. local browser cache only as last-resort display fallback

For protected order/message list reads:
1. Scope 3 cache/index only if it preserves the same auth/privacy boundary
2. Scope 2 authorized summary query
3. Scope 1 authorized merchant-haven relay read
4. current gift-wrap fetch + unwrap + local reconstruction fallback

For conversation detail:
- keep current parsed-message reconstruction model as the stable client format
- allow future cache/L2/detail providers to map into that same format

This means Scope 1 and Scope 3 are first-class in the architecture now, even if Scope 2 is implemented first.

### 3. Separate query contracts from transport/backend specifics
Define stable client query parameter/result types for:
- marketplace product browse
- merchant storefront browse
- product detail
- profile batch lookup
- buyer conversation summary list
- merchant conversation summary list
- conversation detail/history

Do not expose:
- NDK filters
- raw relay URLs
- cache API wire shapes
- Conduit-specific extension syntax
to route components.

The gateway should internally adapt:
- cache/index API responses
- L2 relay-native extension responses
- merchant relay reads
- current fanout + local parse behavior
into the same result types.

### 4. Keep Scope 1 compatibility explicit
Design the gateway so merchant-haven reads slot in cleanly later:
- merchant-scoped product reads can prefer merchant relay when the flow needs canonical freshness
- product detail can revalidate against merchant relay without changing route code
- merchant inbox and merchant-owned product management can move to merchant-haven-backed reads behind the same contracts
- write flows should stay separate from read orchestration, but publish code should gain relay-role awareness so merchant canonical writes are easy to add later

This avoids coupling merchant-owned flows to L2 assumptions.

### 5. Keep Scope 3 compatibility explicit
Assume Scope 3 will appear as the fastest source behind the same gateway, not as a second parallel client data layer.

That means:
- cache/index should satisfy the same high-level query contracts as L2 and relay fallback
- route query keys should be keyed by business intent, not by backend type
- UI components should consume `meta.capabilities` and `meta.source` rather than assuming sort/search/filter support
- storefront hydration, fast browse, and dashboard-like list views should be movable to Scope 3 later without changing route structure

Do not let route code become aware of “cache responses” versus “relay responses” beyond source metadata.

### 6. Migrate screens in an order that preserves this shape
Phase A:
- centralize current product/profile/message reads behind the gateway without changing UX

Phase B:
- migrate Market product browse, storefront, product detail, and Merchant products to the gateway
- keep current client-side fallback semantics

Phase C:
- migrate buyer messages/orders and merchant inbox list screens to summary-list contracts
- keep current unwrap/reconstruction path for detail and fallback

Phase D:
- add source precedence for real Scope 2 support
- later add Scope 1 merchant-haven reads and Scope 3 cache/index providers without changing route contracts

## Public APIs / Interfaces

Add shared types:
- `CommerceReadSource = "cache" | "l2" | "merchant" | "public" | "local_cache"`
- `CommerceQueryMeta`
- `CommerceCapabilities`
- `MarketplaceProductsQuery`
- `MerchantStorefrontQuery`
- `ProductDetailQuery`
- `ProfileBatchQuery`
- `ConversationListQuery`
- `ConversationSummary`
- `ConversationDetail`

`CommerceCapabilities` should cover the features routes care about, such as:
- deterministic sort modes available
- text search available
- protected summaries available
- canonical freshness available
- cursor pagination available

Routes should branch on capabilities, not on backend implementation.

## Test Plan

Required tests:
- gateway chooses sources in the correct order for browse, merchant-scoped, and protected reads
- unsupported cache/L2 capability falls back without changing route-facing data shape
- merchant-scoped canonical reads can be introduced without route changes
- product detail remains deletion-aware across cache, L2, merchant, and public fallback
- conversation list uses summary source when available and unwrap fallback when not
- conversation detail still renders from the stable parsed-message format regardless of source
- UI degraded-mode handling works from `meta.source` and `meta.capabilities` instead of backend-specific checks

## Assumptions and Defaults

- Scope 3 should appear through the same query gateway, not as a separate client API layer.
- Scope 1 merchant-haven relay will eventually matter for canonical merchant-scoped reads and must be representable now in source precedence.
- Scope 2 is still the first infrastructure target, but the client abstraction must not be named or shaped in a way that makes it L2-only.
- Message/thread detail stays on the current parsed-message model in v1 to avoid unnecessary UI churn.
- Route components should be refactored around business queries and capability metadata, not transport details.

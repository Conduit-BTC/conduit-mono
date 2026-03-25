# Phase 2 Implementation

## Overview

Phase 2 begins after MVP completion.

This phase is focused on:
- public repo shaping
- merchant readiness
- trust and provenance
- relay roles and merchant services
- launch safety

This is not a monetization phase.

---

## Repo Strategy

### Public Conduit Repo

Canonical public repo for:
- Market
- Merchant
- `@conduit/core`
- `@conduit/ui`
- public specs and contributor docs

### Private `conduit-services`

Private repo for:
- Store Builder
- private merchant services
- proprietary value-add systems

### Private Internal Planning

Private planning/docs area for:
- company planning
- internal roadmap and prioritization
- private ops/security notes
- internal architecture notes not ready to publish

---

## Implementation Order

1. Public Repo Shaping
2. Merchant Readiness
3. Trust And Provenance
4. Relay Roles And Merchant Services
5. Launch Safety And Policy

The repo boundary should be handled first so the rest of the phase lands in the right long-term structure.

---

## Workstreams

### 1. Public Repo Shaping

#### Deliverables
- remove Store Builder code, references, and repo assumptions from the public Conduit repo
- move Store Builder into private `conduit-services`
- remove internal-only planning docs from tracked public paths
- keep public specs, architecture docs, and contributor docs in the public repo
- establish a maintainer-led public contribution model

#### Done When
- `apps/store-builder` is no longer part of the public Conduit repo
- public docs, README, plans, and repo structure no longer describe Store Builder as part of the public Conduit repo
- the public repo contains only open-source-safe code and docs
- `README`, `PLAN`, roadmap, and implementation docs reflect the new repo boundary
- contribution expectations are explicit and maintainer-led

### 2. Merchant Readiness

#### Deliverables
- merchant settings for profile, payments, shipping, and relays
- Minimum Viable Merchant checklist
- clearer readiness states in dashboard and orders

#### Minimum Viable Merchant Checklist
- signer connected
- store name set
- avatar or fallback identity present
- about/bio set
- payment method configured
- relay defaults saved
- shipping setup completed for physical goods, or product clearly marked as non-shipping
- at least one published product with title, image, and price
- merchant can receive and act on an order from the orders workspace

#### Done When
- a merchant can see what is missing before they are launch-ready
- payment, shipping, and relay setup all have explicit surfaces
- the dashboard and orders UI reflect merchant readiness, not just raw protocol state
- the merchant setup path feels launchable, not just testable

### 3. Trust And Provenance

#### Deliverables
- public `About` surfaces in Market and Merchant
- repo links and contributor visibility
- admin/operator pubkeys
- build commit or release visibility
- clearer signer and network visibility

#### Done When
- users can understand who operates Conduit and where the code lives
- users can inspect admin/operator pubkeys from the product surface
- users can identify the build or release they are using
- signer path and network context are visible and understandable

### 4. Relay Roles And Merchant Services

#### Deliverables
- relay role model in product and docs
- explicit separation between merchant-owned, Conduit shared, and cache/index layers
- lite merchant-services implementation plan

#### Done When
- relay settings are role-based instead of a flat list
- the product and docs both describe the same relay/services boundary
- the next relay/services implementation step is agreed and spec-ready

### 5. Launch Safety And Policy

#### Deliverables
- listing moderation states: active, hidden, flagged, blocked
- merchant-facing policy warnings
- Market-side suppression of unsupported or blocked listings

#### Done When
- unsupported or blocked listings do not appear as normal active inventory
- merchants can tell why a listing is blocked or flagged
- the policy state is visible in product and backed by a documented moderation model

---

## Phase 2 Deliverables Summary

By the end of Phase 2, Conduit should have:
- a clean public repo boundary
- a separate private home for Store Builder and private services
- a launchable merchant setup flow
- visible trust and provenance surfaces
- clear relay and merchant-services boundaries
- launch policy controls for listings

---

## Non-Goals

- monetization
- ads
- premium plans
- broad social feature expansion
- full automation platform
- forcing all relay/services code public immediately

---

## Exit Criteria

Phase 2 is complete when:
- the public Conduit repo is contribution-ready
- Store Builder has a separate private home
- Merchant feels launchable, not just testable
- Conduit exposes clear trust and provenance surfaces
- relay/services boundaries are clear in product and docs
- launch policy controls exist and are visible

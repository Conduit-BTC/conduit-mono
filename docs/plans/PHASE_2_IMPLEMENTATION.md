# Phase 2 Implementation

## Overview

Phase 2 begins after MVP completion.

This phase is split into:
- `P0` launch readiness and merchant hardening
- `P1` trust, signer, and open-source follow-through

The goal is to make Conduit launchable, legible, and ready for the next public-facing step without reopening MVP scope.

---

## Priority Order

### P0

1. Merchant Portal completion and hardening
2. Minimum Viable Merchant checklist
3. payment and shipping readiness
4. role-based relay settings
5. trust, provenance, and admin-key visibility
6. hydration and loading state clarity
7. lite Conduit services layer
8. launch policy and product filtering

### P1

1. minimum trust layer:
   - comments and discussion
   - zaps
   - profile visibility and external profile links
2. NIP-46 clarity and support path
3. open-source readiness

---

## P0 Workstreams

### 1. Merchant Portal Completion And Readiness

#### Goal
Turn Merchant into a launch-ready setup and operations surface for real storefront operators.

#### Deliverables
- merchant settings for profile, payments, shipping, and relays
- Minimum Viable Merchant checklist
- clearer readiness states in dashboard, profile, and orders
- direct links from each missing checklist item to the surface where the merchant resolves it

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

#### Non-Goals
- external shipping integrations
- payment automation
- advanced merchant analytics
- full business-management tooling

#### Dependencies
- Merchant MVP surface completion from Phase 1

#### Done When
- a merchant can see a checklist of remaining setup steps from within Merchant
- every checklist item maps to a real surface and real completion state
- payment, shipping, and relay setup all have explicit surfaces
- the dashboard, profile, and orders UI reflect merchant readiness, not just raw protocol state
- the merchant setup path feels launchable, not just testable

### 2. Trust, Provenance, And Hydration Clarity

#### Goal
Make Conduit understandable and inspectable to both normal users and Nostr-native users.

#### Deliverables
- public `About` surfaces in Market and Merchant
- repo links and contributor visibility
- admin and operator pubkeys
- build commit or release visibility
- clearer signer and network visibility
- hydration and loading states that distinguish:
  - loading
  - syncing
  - empty
  - published but not yet hydrated

#### Non-Goals
- comments or discussion systems
- rich social feeds
- required NIP-05 completion

#### Dependencies
- Merchant Portal Completion And Readiness

#### Done When
- users can understand who operates Conduit and where the code lives
- users can inspect admin and operator pubkeys from the product surface
- users can identify the build or release they are using
- signer path and network context are visible and understandable
- relay-driven loading states are legible instead of feeling broken or ambiguous
- optional identity trust such as NIP-05 is clearly additive, not required

### 3. Relay Roles And Lite Conduit Services

#### Goal
Make relay architecture legible in both product UX and docs, define the thinnest Conduit services layer needed after MVP, and complete the client-side relay integration work needed to support parallel relay buildout.

#### Deliverables
- role-based relay settings in product and docs
- explicit separation between:
  - merchant canonical relays
  - Conduit shared relay/L2 layer
  - cache/index layer
- client-side hydration and read-path integration for working across those relay roles
- client-side behavior that can support parallel relay work from other contributors without requiring final relay infrastructure decisions first
- client relay integration with fallback behavior across the intended relay roles

#### Non-Goals
- shipping a real multi-slice services platform
- deep NIP-46 automation
- locking the final relay implementation stack
- building the full Conduit services layer
- acting as IC on relay infrastructure delivery in this phase

#### Dependencies
- Trust, Provenance, And Hydration Clarity

#### Done When
- relay settings are role-based instead of a flat list
- the product and docs both describe the same three-layer relay model
- Market and Merchant hydration/read behavior are prepared to work across the intended relay roles
- client integration work can proceed in parallel with separate relay buildout efforts
- client relay integration supports fallback behavior across the intended relay roles
- Market and Merchant behave correctly when only some relay layers are available

### 4. Launch Safety And Product Filtering

#### Goal
Ship minimum viable controls for unacceptable, unsupported, or blocked listings before launch.

#### Deliverables
- listing moderation states: active, hidden, flagged, blocked
- merchant-facing policy warnings
- Market-side suppression of unsupported or blocked listings
- documented moderation and policy model

#### Non-Goals
- full trust-and-safety operations tooling
- appeals workflows
- complex moderation dashboards
- broad abuse tooling beyond listings

#### Dependencies
- Merchant Portal Completion And Readiness
- Relay Roles And Lite Conduit Services where policy interacts with relay behavior

#### Done When
- unsupported or blocked listings do not appear as normal active inventory
- merchants can tell why a listing is blocked or flagged
- the policy state is visible in product and backed by a documented moderation model

---

## P1 Workstreams

### 5. Minimum Trust Layer

#### Goal
Add the first lightweight social and identity layer that makes the network feel inhabited without turning Conduit into a broad social product.

#### Deliverables
- comments and discussion
- zaps
- profile visibility
- external profile and store link-outs

#### Non-Goals
- broad social feeds
- full reputation systems
- in-app community products beyond the minimum trust layer

#### Dependencies
- Trust, Provenance, And Hydration Clarity

#### Done When
- users can see lightweight social context around merchants and products
- comments, zaps, and profile visibility work as part of the buyer trust surface
- external profile links exist where they help users understand identity or activity

### 6. NIP-46 Clarity And Support Path

#### Goal
Make remote signer support understandable and usable without making it the center of the product.

#### Deliverables
- clear NIP-46 support surfaces where relevant
- explicit explanation of signer path differences between NIP-07 and NIP-46
- a defined support path for where NIP-46 is expected to be used first

#### Non-Goals
- deep remote-signing automation
- broad signer orchestration flows

#### Dependencies
- Relay Roles And Lite Conduit Services

#### Done When
- users can understand whether they are using NIP-07 or NIP-46
- product surfaces make the support path visible instead of implied
- the first NIP-46-supported workflows are explicit in docs and product

### 7. Open-Source Readiness

#### Goal
Prepare `conduit-mono` to become a public Conduit repo for Market, Merchant, Store Builder, and shared packages.

#### Deliverables
- remove internal-only planning docs from tracked public paths
- keep public specs, architecture docs, and contributor docs in the repo
- make repo scope explicit:
  - Market
  - Merchant
  - Store Builder
  - `@conduit/core`
  - `@conduit/ui`
- establish a maintainer-led public contribution model
- record the repo rename decision as open or decided without blocking Phase 2
- describe `conduit-services` as a later separate public repo, not a Phase 2 code deliverable

#### Non-Goals
- building `conduit-services`
- creating a mirror workflow
- splitting Store Builder out of `conduit-mono`
- designing broad community governance

#### Dependencies
- P0 workstreams complete enough that the public repo boundary is stable

#### Done When
- tracked docs are safe to live in a future public repo
- repo docs consistently describe Store Builder as part of `conduit-mono`
- repo docs no longer mix internal company planning into public-facing planning docs
- `README`, `PLAN`, roadmap, and implementation docs reflect the intended public repo boundary
- contribution expectations are explicit and maintainer-led
- the rename question is documented even if deferred

---

## Exit Criteria

Phase 2 is complete when:
- all P0 workstreams are complete
- P1 scope is either complete or explicitly rescheduled with no ambiguity
- Merchant feels launchable, not just testable
- Conduit exposes clear trust and provenance surfaces
- relay roles and Conduit services boundaries are clear in product and docs
- launch policy controls exist and are visible
- open-source readiness is documented clearly enough for the next repo step

---

## Deferred / Follow-On Work

- deep NIP-46 workflows
- full Conduit services implementation
- broad automation platform
- external shipping or payment integrations
- advanced analytics
- required NIP-05 verification

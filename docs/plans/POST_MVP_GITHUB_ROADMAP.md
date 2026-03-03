# Post-MVP GitHub Roadmap (Execution Pack)

## Executive Summary

This plan governs the first 2 sprints after the Core Function MVP target (**March 12, 2026**).

Priorities:
- Primary: merchant ops reliability
- Parallel: monetization foundations
- Lightweight sidepath: social growth loops
- GTM website track: landing clarity + founder-driven `/updates` publishing

Success metrics (ethos-aligned):
- Primary KPI: successful order completion rate (aggregate-only)
- Secondary KPI: new merchant onboarding completion rate (aggregate-only)

Privacy constraints:
- aggregate telemetry default
- opt-in identified feedback only
- no message/order content export without explicit user consent

---

## 1) Local Setup For Leadership Contributors

### Prerequisites

- GitHub org access to `Conduit-BTC`
- SSH key added to GitHub
- Bun installed (`bun --version`)
- Git configured (`git config --global user.name`, `git config --global user.email`)

### Clone + Bootstrap

```bash
git clone git@github.com:Conduit-BTC/conduit-mono.git
cd conduit-mono
bun install
cp .env.example .env.local
```

### Environment Defaults

```bash
VITE_RELAY_URL=wss://relay.damus.io
VITE_DEFAULT_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
VITE_LIGHTNING_NETWORK=mock
```

### Run + Validate

```bash
bun run dev
bun run typecheck
bun run lint
bun test
```

### Reading Order (60-90 min)

1. `AGENTS.md`
2. `docs/ARCHITECTURE.md`
3. `docs/plans/ROADMAP.md`
4. `docs/plans/IMPLEMENTATION.md`
5. `docs/specs/market.md`
6. `docs/specs/merchant.md`
7. `docs/specs/monetization.md`

---

## 2) Phase Model

Phase basis: business outcomes, with explicit platform-layer separation and app assignment.

## Phase A: Reliable Commerce Core

Goal: deterministic merchant order/payment/message operations.

Layers:
- UX layer: operator confidence surfaces
- Protocol/app logic layer: state transitions + idempotency
- Infra/relay layer: retry, fallback, convergence

Apps:
- Merchant (primary)
- Market (parity and read path)
- Shared packages (`@conduit/core`, `@conduit/ui`)

## Phase B: Monetization Readiness

Goal: ship monetization contracts and gating hooks without violating non-custodial/privacy constraints.

Layers:
- UX layer: plan and value communication
- Business logic layer: entitlements and credits interfaces
- Policy layer: sponsored placement labeling and fairness rules

Apps:
- Merchant + Market + Shared

## Phase C: Social Growth Sidepath

Goal: gather opt-in quality signals and public social proof with no invasive tracking.

Layers:
- UX layer: post-order and post-error prompts
- Protocol layer: Nostr posts and DMs for optional feedback
- Ops layer: triage intake for opt-in diagnostics

Apps:
- Market + Merchant

## Phase D: GTM Website Clarity + Updates Ops

Goal: keep `conduit-landing` mostly static, but enable founder-driven product updates and SEO iteration without engineering bottlenecks.

Layers:
- UX/content layer: clear value narrative for merchants and buyers
- CMS/publish layer: lightweight admin for founder updates with publish controls
- SEO layer: structured metadata and indexable update pages

Apps:
- `conduit-landing` (primary)
- optional Supabase project for content/admin

---

## 3) Capacity Allocation

- 50% Merchant Ops Reliability
- 25% Monetization Foundations
- 15% GTM Website Clarity + Updates Ops
- 10% Social Sidepath Experiments

---

## 4) Ownership Model

- One DRI per epic
- Contributors per issue
- Split guidance:
  - Keep single issue for one app + one layer + <= 2 days effort
  - Split when crossing app boundaries or > 2 days effort

Effort sizing:
- S = 0.5-1 day
- M = 1-2 days
- L = 2-4 days (must split before sprint start)

---

## 5) Sprint Plan

## Sprint 1 (Mar 16 - Mar 29, 2026)

### Epic A1: Merchant Ops Reliability v2

Outcomes:
- order/payment state ambiguity removed under relay lag
- signer gating consistent on all write actions
- refresh behavior stable (no UI jitter loops)

### Epic A2: Market Reliability Parity

Outcomes:
- shared connected-state checks aligned with Merchant
- order/message views converge to same state under same relay data

### Epic B1: Monetization Foundation Spec + Skeleton

Outcomes:
- entitlement model fixed and documented
- credits ledger interface and idempotency contract defined
- gating hooks in place behind flags

### Epic C1: Social Sidepath Experiment #1

Outcomes:
- post-order opt-in anonymous signal path
- optional npub-attribution path
- opt-in error diagnostic submission path

### Epic D1: Website Updates Foundation (Landing)

Outcomes:
- `/updates` page and per-update detail route are indexable and SEO-safe
- founder can publish updates from a lightweight admin flow
- published updates are materialized to static content artifacts for reliability

## Sprint 2 (Mar 30 - Apr 12, 2026)

### Epic A3: Merchant Workflow Depth

Outcomes:
- partial fulfillment and split shipment model
- internal notes per order
- invoice reissue and expiry handling

### Epic B2: Monetization Alpha Readiness

Outcomes:
- entitlement enforcement points test-covered
- credits debit idempotency rules validated
- merchant-facing plan UX draft

### Epic C2: Social Sidepath Experiment #2

Outcomes:
- post-fulfillment thank-you + feedback flow
- optional Nostr DM support escalation route
- social sharing template for community visibility

### Epic D2: GTM Messaging + SEO Iteration Loop

Outcomes:
- monetization and product positioning updates ship without code redeploy friction
- update pages include social/SEO metadata (`title`, `description`, `og`, canonical)
- weekly content cadence established for launch/demo/raise narrative

Detailed issue seed list is in:
- `docs/plans/POST_MVP_ISSUE_SEED.md`

---

## 6) GitHub Project Structure

Project name:
- `Conduit Product Roadmap`

Columns:
- Backlog
- Ready
- In Progress
- In Review
- Done

Custom fields:
- `App`: Market | Merchant | Store Builder | Shared
- `Layer`: UX | Protocol/App Logic | Infra/Relay | Business/Policy
- `Epoch`: Core Function | Added Value | Monetization | Scale
- `Priority`: P0 | P1 | P2
- `Sprint`: S1-2026-03-16 | S2-2026-03-30
- `Effort`: S | M | L
- `Risk`: Low | Medium | High
- `DRI`: GitHub handle

Required merge checks:
- `lint`
- `typecheck`
- `test`
- preview deploy checks

---

## 7) Labels, Milestones, and Epic Bootstrap

Use:

```bash
bash scripts/github/bootstrap_post_mvp.sh --repo Conduit-BTC/conduit-mono --apply
```

This script:
- creates/updates planning labels
- creates milestones for Sprint 1 and Sprint 2
- seeds core epics if missing

Dry-run default:

```bash
bash scripts/github/bootstrap_post_mvp.sh --repo Conduit-BTC/conduit-mono
```

---

## 8) Acceptance Criteria (End Of Sprint 2)

- Merchant and Market show convergent order/payment states under relay variance tests
- signer-connection gating is consistent across both apps for orders/messages actions
- monetization primitives are implemented behind flags with tests
- social opt-in feedback flows exist with explicit consent and privacy-safe defaults
- landing site has a functioning `/updates` publishing path for founders
- monetization and roadmap updates can be posted to landing within the same day
- GitHub planning structure is active and used for all in-sprint issues

---

## 9) PMF Motion Guardrails (Finite, Not Infinite)

PMF search is time-boxed to avoid open-ended roadmap drift.

Window:
- 6-8 weeks after Sprint 2
- three 2-week experiment loops

Target wedge:
- merchant lists product -> receives order -> confirms payment -> fulfills reliably

Primary PMF metrics (aggregate-first):
- successful order completion rate
- new merchant activation rate (listing + first order)
- time to first merchant value
- repeat purchase signal (aggregate only)

Exit rules:
- continue if target metrics improve for 3 consecutive weeks
- pivot if two loops fail to improve completion + activation metrics

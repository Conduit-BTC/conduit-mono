# Post-MVP Issue Seed List

Use this file to create GitHub issues for Sprint 1 and Sprint 2 with consistent scope.

## Sprint 1 (Mar 16 - Mar 29, 2026)

## Epic A1: Merchant Ops Reliability v2

1. `[A1] Audit and enforce order state transition matrix`
2. `[A1] Resolve paid-state race conditions across relay lag`
3. `[A1] Stabilize manual refresh behavior with bounded cadence`
4. `[A1] Enforce signer-connected gating for merchant write actions`
5. `[A1] Add retry/fallback policy for 2-relay degraded mode`

## Epic A2: Market Reliability Parity

1. `[A2] Align market signer-gating behavior with merchant`
2. `[A2] Converge order/message fetch logic to shared core helpers`
3. `[A2] Add parity tests for connected-state and empty/error states`

## Epic B1: Monetization Foundation Spec + Skeleton

1. `[B1] ADR: define entitlement tiers and capability matrix`
2. `[B1] Define credits ledger event schema + idempotency key rules`
3. `[B1] Implement feature-flagged gating hooks (no paywall activation)`
4. `[B1] Draft sponsored placement labeling and fairness guardrails`
5. `[B1] Add privacy-safe telemetry contract (PostHog optional, default-off)`
6. `[B1] Define and document telemetry allowlist + disallowed fields`

## Epic C1: Social Sidepath Experiment #1

1. `[C1] Add post-order opt-in feedback prompt (anonymous or npub)`
2. `[C1] Add opt-in error diagnostics capture flow`
3. `[C1] Add optional 'share on Nostr' CTA template`

## Epic D1: Website Updates Foundation (Landing)

1. `[D1] Implement /updates index and update detail route structure`
2. `[D1] Define update content schema (title, slug, summary, body, tags, publish_at)`
3. `[D1] Implement founder-only admin auth (Supabase magic link + allowlist)`
4. `[D1] Implement publish flow to static artifacts for reliability`
5. `[D1] Add base SEO metadata and canonical handling for update pages`
6. `[D1] Add aggregate-only tracking plan for /updates consumption`

## Sprint 2 (Mar 30 - Apr 12, 2026)

## Epic A3: Merchant Workflow Depth

1. `[A3] Add partial fulfillment and split shipment state model`
2. `[A3] Add internal notes per order (private merchant scope)`
3. `[A3] Add invoice re-issue and expiry handling flow`

## Epic B2: Monetization Alpha Readiness

1. `[B2] Add entitlement enforcement integration tests`
2. `[B2] Implement idempotent debit processing checks`
3. `[B2] Build merchant plan comparison UX draft`

## Epic C2: Social Sidepath Experiment #2

1. `[C2] Add post-fulfillment feedback capture flow`
2. `[C2] Add optional Nostr DM escalation path for support`
3. `[C2] Add community status/share template for reliability updates`

## Epic D2: GTM Messaging + SEO Iteration Loop

1. `[D2] Add update page OG metadata and social card conventions`
2. `[D2] Publish monetization explainer update series`
3. `[D2] Publish onboarding updates for merchants and contributors`
4. `[D2] Add lightweight editorial checklist for weekly update cadence`
5. `[D2] Add GTM weekly aggregate metrics dashboard definition (PostHog or equivalent)`

## Cross-Cutting Setup Tasks

1. `[X] Founder TODO: create PostHog org/project (or self-hosted instance)`
2. `[X] Add \`ENABLE_TELEMETRY\` env gate defaults to off in all clients`
3. `[X] Add CI check for telemetry allowlist and banned fields`

# Phase 2 Implementation

Phase 2 targets public beta readiness for Conduit after MVP.

This plan is the repo-level source of truth for Phase 2 outcomes. Linear should track ownership, status, and scheduling, but issue acceptance criteria should map back to the outcomes in this file.

## How To Use This Plan

Each track defines:

- **Outcome**: the user or system state that must be true.
- **Acceptance criteria**: concrete checks that make the work assignable.
- **Verification**: expected evidence in PRs or QA.
- **Non-goals**: scope that should not be absorbed by the ticket.

Linear tickets should copy the relevant acceptance criteria and keep PRs small enough that each criterion can be reviewed directly.

---

## Phase 2 Scope - Included

### A) Contributor and Open Source Readiness

#### Outcome

`conduit-mono` can be safely shared as a public open-source client and shared-code repo, and a new contributor can clone, validate, and open a compliant PR without private context.

#### Acceptance Criteria

- The repo is publishable under MIT and no tracked public-facing doc still says `License: TBD`.
- `README.md` and `CONTRIBUTING.md` explain the monorepo layout, app/package boundaries, setup commands, validation commands, branch naming, and PR expectations.
- CI and review expectations in docs match the actual GitHub workflows and PR template.
- Public-facing tracked docs avoid private planning context and keep the current repo boundary focused on Market, Merchant, Store Builder, shared packages, and protocol implementation.
- AI review instructions remain present and aligned with Conduit's signer, privacy, protocol, and payment constraints.

#### Verification

- A reviewer can identify license, setup, test, PR, and repo-boundary guidance from tracked docs alone.
- CI passes on the open-source readiness PR.

#### Non-Goals

- Product-visible version, build, or source links. Those belong to Track H.
- A full external contributor program, code-owner rollout, or public roadmap process beyond the repo baseline.

### B) Relay Architecture and Frontend Setup

#### Outcome

Merchant and Market expose relay roles in product terms, use Conduit defaults as the public beta baseline, and verify custom/user relays before trusting them for critical behavior.

#### Acceptance Criteria

- Merchant settings show merchant, commerce, and general relay groups.
- Market settings show commerce and general relay groups.
- Relay settings map to the shared `@conduit/core` relay model instead of a flat app-local relay list.
- Conduit default relays are enough for beta readiness when no custom relay is configured.
- Signer and NIP-65 imported relays update the settings UI without reload or a manual local settings mutation.
- Custom relays are normalized and assigned a readiness state before they are treated as usable for critical flows.
- Readiness distinguishes at least unverified, verified, degraded, and incompatible states.
- Relay readiness checks cover the purposes the UI enables: writes, active reads, discovery reads, and protected-message delivery.
- Buyer order creation and buyer merchant-thread replies publish to merchant-reachable relays, not only shopper general relays.
- Route code remains source-agnostic and consumes shared typed read results with source/degraded metadata.
- Fallback behavior is explicit in UI where missing relay coverage affects product discovery, order delivery, or merchant operations.

#### Verification

- Unit coverage exists for relay grouping, signer/NIP-65 merge behavior, readiness-state derivation, and write-relay selection.
- Local relay stack or equivalent manual QA demonstrates merchant publish, market browse, buyer checkout, and merchant-thread reply behavior.
- PR evidence states which relay roles were validated and what fallback was exercised.

#### Non-Goals

- Certifying arbitrary third-party relays as commerce-compatible.
- Full relay operations, monitoring, or cache infrastructure rollout.
- Replacing route-level product logic with relay-specific branching.

### C) Merchant Setup, Readiness, and Payment Eligibility

#### Outcome

Merchants can see what setup is complete, what is missing, and which payment capability they currently support before they rely on the portal for sales.

#### Acceptance Criteria

- Merchant setup is available from one coherent settings/readiness flow covering profile, payments, shipping, and network.
- The dashboard or setup entry point shows incomplete states for required setup areas.
- Required profile fields are visibly marked, and profile preview reflects the full merchant profile, including banner where present.
- Payments setup supports the beta payment fields needed for invoice fallback, including Lightning Address and NWC setup for invoice generation.
- Updating payment fields does not erase unrelated merchant profile fields.
- Shipping setup supports a `Ships to` country list plus optional postal restriction and exclusion entries.
- Shipping rules produce a plain-language summary and can answer whether a destination is shippable.
- Network readiness uses Conduit default relay coverage for beta readiness and surfaces custom relay verification when custom relays are added.
- Payment eligibility distinguishes invoice-ready merchants from fast-checkout-eligible merchants, even though Phase 2 does not require a full direct fast checkout implementation.

#### Verification

- Manual QA covers incomplete setup, completed setup, payment field updates, shipping rule examples, and network readiness display.
- Unit coverage exists for shipping destination matching and readiness derivation where logic is shared.

#### Non-Goals

- Shipping rates, carrier integrations, pickup workflows, maps, or geohash rules.
- Automated order processing or server-side merchant operations.
- Treating fast checkout eligibility as proof that direct payment is already implemented.

### D) Market Checkout and Buyer Payment Experience

#### Outcome

Checkout clearly tells buyers whether they are using the reliable invoice fallback flow or seeing a merchant that is eligible for a future fast checkout path.

#### Acceptance Criteria

- The existing order-first invoice fallback remains the reliable baseline.
- Checkout explains that the buyer sends an order request and the merchant sends payment details when fallback is used.
- If merchant readiness indicates fast-checkout eligibility, checkout can show that eligibility without requiring a full direct-payment implementation.
- Buyers can tell why direct payment is unavailable when the merchant is not eligible.
- Shipping validation and order submission errors remain explicit and recoverable.
- Checkout does not depend on hidden backend assumptions or custody.
- The fallback path still supports buyer order creation, merchant invoice response, buyer payment, and merchant confirmation.

#### Verification

- Manual QA covers eligible and non-eligible merchant states.
- Existing checkout, cart, and order-message tests continue to pass.
- PR evidence shows invoice fallback behavior was not regressed.

#### Non-Goals

- Full direct fast checkout implementation in Phase 2.
- Server-generated invoices, custodial payment handling, or automated refunds.

### E) Payment Proof, Detection, and Order State Handling

#### Outcome

Payment proof becomes a first-class order concept, but proof completion requires payment evidence rather than only a signed buyer claim.

#### Acceptance Criteria

- A `payment_proof` order message requires payment evidence such as an NWC payment result, zap receipt, or wallet-provided receipt/reference.
- A signed buyer message can transport or attest to evidence, but a signed claim alone is not enough to mark proof complete.
- Buyer-facing states distinguish payment evidence sent, proof sent, and awaiting merchant confirmation.
- Merchant-facing states distinguish unpaid, payment evidence received, and confirmed paid.
- Missing evidence, unverifiable evidence, invoice mismatch, and disputed payment do not collapse into a vague `pending` state.
- Proof remains linked to the order conversation so both sides can audit the payment trail.
- Shared schemas and UI copy preserve the non-custodial model.

#### Verification

- Schema tests cover accepted and rejected payment proof payloads.
- UI/manual QA covers buyer proof submission, merchant proof review, confirmed paid, and mismatch/unverified states.
- PR evidence states which evidence source was used in QA.

#### Non-Goals

- Guaranteeing every wallet can provide the same evidence shape.
- Automated settlement, chargebacks, or custodial balance tracking.
- Requiring zap receipts for non-zap invoice flows.

### F) Checkout Trust Layer and Merchant Context

#### Outcome

Buyers see merchant trust context before payment-sensitive actions, but trust is informational in Phase 2 and does not silently allow or block checkout.

#### Acceptance Criteria

- Storefront and checkout surfaces show merchant identity and available trust context before the buyer sends an order or payment-sensitive action.
- Trust context distinguishes loading, unavailable, absent, and available states.
- Missing or low-context trust displays a clear warning in checkout.
- Trust warnings do not block invoice fallback or fast-checkout eligibility in Phase 2.
- Trust context is visible product information, not a hidden reputation score or allow/block system.
- Slow trust hydration does not make the UI appear broken or imply trust data is absent before loading completes.

#### Verification

- Manual QA covers connected and disconnected buyers, trust loading, trust unavailable, absent trust, and available trust.
- PR evidence includes screenshots or notes showing checkout warning behavior.

#### Non-Goals

- Advanced reputation, social ranking, or automated merchant scoring.
- Blocking checkout based on trust context alone.

### G) Legal, Risk, and Support Surfaces

#### Outcome

Public beta users can find legal, risk, and support information, and payment-risk copy is visible at the moments where it affects decisions.

#### Acceptance Criteria

- Market and Merchant expose accessible links to Privacy Policy, Terms of Service, risk disclosures, and beta support or bug reporting.
- Product copy states that Conduit does not custody funds, does not control merchants, and Lightning payments are irreversible.
- Irreversible-payment and non-custodial language appears near payment-sensitive actions, not only in footer/legal pages.
- Support language does not promise message inspection, fund recovery, or platform-controlled dispute resolution.
- Monitoring/support copy aligns with `docs/specs/privacy-observability.md`: system metrics only, no message content inspection, no behavioral tracking.

#### Verification

- Manual QA verifies links and payment-risk copy in Market and Merchant.
- Privacy/observability review confirms no conflicting support or telemetry language was introduced.

#### Non-Goals

- A full support ticketing system.
- Behavioral analytics, user-level profiling, or message-content monitoring.

### H) Launch Safety, Filtering, and Version Transparency

#### Outcome

Market and Merchant avoid misleading beta users by making listing state, data availability, and app version/source context visible.

#### Acceptance Criteria

- Merchant-facing listing state distinguishes active, hidden, flagged, blocked, and unsupported where those states exist.
- Hidden, blocked, or unsupported listings do not render as ordinary active inventory in Market.
- Blocked or unsupported listings are suppressed in Market when that state is present.
- Merchants can see why a listing is not active when the app has a reason to show.
- Loading, partially hydrated, unavailable, empty, and error states use distinct copy where the distinction affects user decisions.
- Market and Merchant expose version/build context useful for beta support.
- Product-visible source links are added only once the repo is safe to expose publicly under Track A.

#### Verification

- Manual QA covers active, hidden, blocked/unsupported, loading, empty, and unavailable states.
- Version/build/source display is visible in a support or about surface.

#### Non-Goals

- Full moderation operations, appeals, or review queues.
- Ranking, reputation, or paid placement systems.

---

## Payment Flow Baseline

### Phase 2 Baseline: Manual Invoice Fallback

Buyer places order -> merchant sends invoice -> buyer pays externally -> buyer sends payment evidence -> merchant confirms paid.

This remains the reliable beta path.

#### Acceptance Criteria

- Buyer and merchant can complete the fallback loop without ambiguous state transitions.
- Payment evidence is required before proof is complete.
- Merchant confirmation remains explicit.

### Phase 2 Readiness: Fast Checkout Eligibility

Fast checkout is an eligibility/readiness concept in Phase 2. The product may show whether a merchant is eligible, but a full direct-payment fast checkout path is not required for Phase 2 completion.

#### Acceptance Criteria

- Eligibility depends on merchant setup, payment readiness, relay readiness, and required checkout context.
- Ineligible merchants fall back to the manual invoice flow with clear copy.
- Eligibility language does not imply that Conduit custodies funds or guarantees fulfillment.

---

## Optional Scope

Optional unless added later in writing:

- Advanced trust or social features.
- Broad NIP-46 product support.
- Full relay/cache operations beyond frontend readiness and fallback behavior.

## Explicit Exclusions

Not included in Phase 2 unless added later:

- Advanced analytics or reputation systems.
- Full social feed or non-commerce social features.
- Custodial payments, refunds, or dispute resolution.
- Carrier shipping integrations or shipping-rate automation.

---

## Exit Criteria

Phase 2 is complete when:

- The repo is ready for public open-source use.
- Relay roles, readiness, and fallback behavior are explicit in product and shared implementation.
- Merchant setup and payment eligibility are visible and actionable.
- Checkout clearly preserves invoice fallback and can show fast-checkout eligibility without ambiguity.
- Payment proof requires evidence and creates understandable buyer/merchant states.
- Trust context is visible before payment-sensitive actions.
- Legal, risk, and beta-support surfaces are present and privacy-aligned.
- Listing state, blocked-listing suppression, loading clarity, and version/build transparency are visible in product.

## Verification Checklist For This Plan

- Each Phase 2 track has assignable acceptance criteria.
- The plan preserves the A-H scope while targeting public beta readiness.
- Linear tickets can copy acceptance criteria from this document without reinterpreting product intent.
- The plan does not introduce backend custody, behavioral tracking, or hidden app-only truth.

# Phase 2 Implementation

Phase 2 is the execution plan for the Conduit closeout sprint after MVP.

This document translates Phase 2 scope into a codebase-aware implementation map for `conduit-mono`.

Execution state, ownership, and merge order live in Linear. This document should describe the repo-local delivery contract and should be kept in sync when Phase 2A closeout work lands.

For each included area, this plan states:

- current codebase state
- Phase 2 implementation work
- done when

The goal is to make this file usable as both:

- a human-readable scope reference
- an operational planning document that can be turned into issues and PRs without re-discovering the repo

Phase 2B is expected to introduce broader local-first app architecture and source-aware commerce reads. Current Phase 2A work should avoid blocking that direction, but it should not force a Commerce Graph or relay-substrate refactor into closeout milestones before the future architecture spec lands.

---

## Phase 2 Scope - Included

### A) Getting the Codebase Ready for Contributors and Open Source

Top priority. This work enables the team to move faster and lets outside contributors understand the repo without guessing.

#### Current codebase state

- `README.md` already explains repo structure, local relay setup, app roles, and common commands.
- `CONTRIBUTING.md` already defines branch naming, required checks, package boundaries, protocol constraints, and merge expectations.
- `.github/workflows/ci.yml` already runs `lint`, `typecheck`, `test`, and build jobs.
- `.github/pull_request_template.md` already defines PR summary, scope, risk review, and test plan expectations.
- `.github/copilot-instructions.md` and `.github/instructions/pr-review.instructions.md` already define AI review priorities and review format.
- The repo has MIT licensing and explicit trademark/open-source posture in `README.md`, `OPEN_SOURCE.md`, and `TRADEMARKS.md`.
- Branch protection rules are described in `CONTRIBUTING.md`, but this plan should treat repo protection and review policy as required repo standards, not just contributor notes.
- Open PR work is expected to add bug-report forms, provenance/About surfaces, compact legal footers, Playwright smoke coverage, and automation/telemetry guardrails.

#### Phase 2 implementation work

- Maintain the public repo baseline:
  - keep MIT licensing and trademark posture explicit
  - keep `README.md` and related docs public-safe
  - remove or relocate tracked docs that are future-service, private-planning, or underspecified product scope rather than current `conduit-mono` contracts
- Tighten contributor onboarding so a new engineer can understand:
  - the monorepo layout
  - app/package boundaries
  - required local setup
  - how to run tests and validation
- Define the working agreement for day-to-day delivery:
  - branching conventions
  - PR expectations
  - review expectations
  - merge requirements for `main`
- Treat repo protection as product infrastructure:
  - required CI checks
  - protected branch expectations
  - code ownership or equivalent protection for critical shared surfaces if needed later
- Keep multi-developer work safe by documenting where shared logic belongs:
  - `apps/market`
  - `apps/merchant`
  - `packages/core`
  - `packages/ui`
  - `.github/*`
- Keep AI review tooling as a required quality surface:
  - preserve and refine Copilot review instructions
  - keep AI review aligned with protocol, privacy, and payment constraints
- Add and maintain public repo linking from product and website surfaces.

#### Done when

- The repo remains publishable under MIT without stale placeholders or private planning references.
- A new contributor can clone the repo, run the apps, and understand the monorepo boundary from `README.md` and `CONTRIBUTING.md`.
- Required PR checks and review expectations are explicit and match actual CI.
- AI review instructions are present, current, and aligned with Conduit’s protocol and privacy rules.
- The repo can support parallel work without pushing shared logic into app-local copies.
- Product and website surfaces can safely link to the public repo.

### B) Relay Architecture and Frontend Setup

Second priority. This work aligns relay preferences, commerce compatibility, and the relay settings UI around the Nostr-native model.

#### Current codebase state

- `packages/core/src/config.ts` supports commerce, public, and default relay lists.
- The current config already builds a merged relay list for client use.
- `packages/core/src/protocol/commerce.ts` returns source metadata for commerce, public, and local-cache reads without exposing fixed relay roles as the product model.
- Relay architecture is documented in `docs/specs/relay/conduit_relay_architecture.md`.
- Merchant and Market already depend on relay reads, local cache, and fallback handling.
- Shared relay preference/capability state exists in `@conduit/core`, and Market/Merchant expose Network settings surfaces built on the shared `@conduit/ui` relay settings panel.
- Phase 2B is expected to deepen source-aware relay health and read-frontier behavior. Current Phase 2A work should keep route code source-aware where practical without introducing a premature custom relay substrate.

#### Phase 2 implementation work

- Make relay preferences and detected capabilities explicit in product and docs:
  - `IN` for relays Conduit may read from
  - `OUT` for relays Conduit may publish to
  - commerce priority order as a Conduit-local app setting
  - capability indicators derived from NIP-11, active probes, and commerce compatibility checks
- Refine relay settings UX that maps to shared relay preference and capability state instead of user-managed relay roles.
- Use two user-facing relay sections across Conduit clients:
  - Commerce Enabled Relays
  - Other Public Relays
- Keep the selector minimalist and mobile-friendly:
  - use IN/OUT controls for user preferences
  - use read-only capability icons for search, DM, auth, and warnings
  - allow drag-to-rank only in Commerce Enabled Relays
  - use tooltip or detail affordances only when extra explanation is needed
- Keep Market and Merchant route code source-agnostic:
  - routes should consume stable typed read results
  - routes should react to source and degraded-state metadata
  - routes should not hard-code assumptions about internal acceleration paths
- Preserve graceful degradation:
  - browsing may use faster layers first
  - verification should still be possible through ordinary relay reads
  - apps should continue to function when acceleration or cache paths are absent
- Use route-aware read planning instead of one universal precedence rule:
  - commerce flows should prefer Commerce Enabled Relays in Conduit commerce priority order
  - general Nostr flows should follow user `IN` / `OUT` preferences
  - protected and mutation-adjacent flows may require stronger-source verification before acting
- Preserve progressive verification in UI:
  - fast surfaces may render from cache first to avoid blank-page loading
  - cards and detail views may update source state as stronger relay-backed reads confirm the same data
  - source indicators should be subtle by default and more explicit only where degraded or stale state affects user decisions
- Keep any future acceleration or local cache paths narrow in responsibility:
  - hydration
  - performance
  - verification support
  - not user-managed selector roles
- Align frontend behavior with the existing relay architecture docs instead of creating a second architecture in UI code.

#### Recommended PR sequence

1. Shared relay model and settings UX
   - define relay preference, capability, warning, and commerce priority state in shared code
   - map that model to Merchant and Market settings surfaces
   - make the grouped relay UX understandable without exposing internal acceleration details
2. Merchant-side relay behavior
   - publish merchant-authored events to user-enabled `OUT` relays, prioritizing commerce-compatible relays for commerce events
   - keep merchant messaging and inbox reads aligned with the optimized relay path
   - preserve source-aware typed results in shared protocol code
3. Market / shopper read planning
   - implement route-aware read plans
   - support progressive source verification after fast initial render
   - surface source and degraded-state information where it materially helps the user

#### Done when

- Merchant and Market can explain relay preferences and detected capabilities in product terms, not just env var terms.
- Relay settings map cleanly to shared relay preference and capability state in `@conduit/core`.
- Merchant and Market settings surfaces use Commerce Enabled Relays and Other Public Relays without asking users to assign relay roles.
- Frontend reads remain compatible with public-relay, commerce-compatible-relay, and cached/degraded-read scenarios.
- Fallback behavior is explicit in UI and implementation instead of implicit in scattered route logic.
- Fast browse flows may load from cache first while still supporting later verification against stronger relay sources.
- The infrastructure team can extend relay and local cache behavior without forcing route-level rewrites.

### C) Merchant Setup, Readiness & Payment Eligibility

#### Current codebase state

- Merchant already has working surfaces for:
  - profile editing in `apps/merchant/src/routes/profile.tsx`
  - product management in `apps/merchant/src/routes/products.tsx`
  - order handling and invoicing in `apps/merchant/src/routes/orders.tsx`
  - dashboard stats in `apps/merchant/src/routes/index.tsx`
- Merchant now has separate Profile, Payments, Shipping, Network, Products, Orders, and Dashboard surfaces.
- Merchant readiness logic exists in app code and is surfaced on the dashboard.
- There is not yet a single settings route, but the active design favors focused setup surfaces plus dashboard readiness instead of a monolithic settings editor.
- Remaining work should tighten readiness copy, payment capability state, and shipping/payment/relay hydration rather than re-opening route structure.

#### Phase 2 implementation work

- Keep a complete merchant setup/readiness model across the existing focused surfaces:
  - profile identity
  - payment setup
  - shipping readiness
  - relay configuration
- Keep the minimum viable merchant checklist grounded in current product capabilities and explicit dashboard readiness states.
- Split merchant payment capability into clear product states:
  - eligible for fast checkout
  - limited to invoice/manual flow
- Make payment eligibility depend on real merchant setup, not just whether an invoice can eventually be sent.
- Keep the readiness model grounded in current app surfaces rather than inventing a separate back-office system.

#### Done when

- Merchants can see what setup is complete, what is missing, and what payment path they currently support.
- Merchant setup is understandable from focused setup pages and a dashboard readiness summary instead of raw counts alone.
- Dashboard states reflect merchant readiness and payment eligibility directly.
- The app can clearly distinguish between instant-payment-capable merchants and invoice-only merchants.

### D) Market Checkout & Buyer Payment Experience

#### Current codebase state

- Market checkout already exists in `apps/market/src/routes/checkout.tsx`.
- The current buyer flow is order-first:
  - buyer signs and sends the order
  - merchant reviews the order
  - merchant later replies with payment details
- Merchant orders already support invoice generation and sending through:
  - WebLN
  - NWC
  - manual invoice paste
- Fast checkout, NWC/WebLN payment attempts, and payment proof behavior are active Phase 2 work and should be treated as part of closeout once the related open PRs merge.

#### Phase 2 implementation work

- Keep the existing order-first checkout path as the fallback baseline.
- Finish and harden the fast checkout path for eligible merchants and NWC-ready buyers.
- Let buyers initiate payment directly from the order total when eligibility rules are satisfied.
- Gate fast checkout on explicit merchant readiness and trust conditions.
- Keep checkout language and route behavior clear about which path the buyer is using:
  - fast checkout
  - merchant invoice fallback
- Avoid rewriting checkout around hidden backend assumptions; extend the existing Market route and shared protocol surfaces.

#### Done when

- Market checkout supports a fast path and a fallback path without ambiguity.
- Buyers can tell whether the merchant qualifies for direct payment or requires invoice follow-up.
- The buyer can initiate payment from the order total only when the merchant meets the required conditions.
- The invoice/manual path still works when fast checkout is unavailable.

### E) Payment Proof, Detection & Order State Handling

#### Current codebase state

- `packages/core/src/schemas/index.ts` already defines:
  - `payment_request`
  - `payment_proof`
  - order status values including `invoiced` and `paid`
- Merchant orders already support invoice sending and status updates in `apps/merchant/src/routes/orders.tsx`.
- Market already renders payment requests and payment proof messages in buyer order conversations.
- Current order/payment state handling is useful but still partial:
- payment proof exists as a message type, and open Phase 2 work promotes it into a first-class state model
  - buyer success confirmation and merchant payment-state clarity need to be tightened
  - mismatch and unverified-payment handling are not yet defined as a complete state model

#### Phase 2 implementation work

- Make signed proof of payment a required Phase 2 concept, not just an available message type.
- Keep proof attached to the order conversation as receipt-style evidence.
- Make buyer-facing success states explicit:
  - payment sent
  - proof sent
  - awaiting merchant confirmation
- Make merchant-facing payment states explicit:
  - unpaid
  - proof received
  - confirmed paid
- Define how invoice mismatch, unverifiable invoice, missing proof, or disputed payment should appear in product state.
- Extend shared schemas and order-summary logic only as needed to support clear buyer and merchant state rendering.

#### Done when

- Payment proof is a first-class order concept in both Market and Merchant.
- Buyers can tell when payment and proof were sent successfully.
- Merchants can tell whether an order is unpaid, proof-backed, or confirmed paid.
- Proof is directly linked to the order conversation.
- Edge cases do not collapse into a single vague “pending” state.

### F) Checkout Trust Layer & Merchant Context

#### Current codebase state

- Storefront trust context is partially present in `apps/market/src/routes/store/$pubkey.tsx`.
- Store pages already show merchant profile information and follow/unfollow behavior for connected buyers.
- Trust context is active Phase 2 work and should appear before payment-sensitive actions once the related open PRs merge.

#### Phase 2 implementation work

- Surface merchant follows/following in storefront and related trust surfaces using the existing store route as the starting point.
- Decide where trust context must appear before payment:
  - storefront
  - checkout
  - order/payment confirmation surfaces
- Add warning patterns for low-context payment flows without pretending trust is binary.
- Keep slow hydration acceptable:
  - trust context may load later than core storefront data
  - UI should distinguish between loading, unavailable, and absent trust context
- Treat trust context as buyer information, not as a hidden allow/block system for ordinary browsing.

#### Done when

- Buyers can see merchant trust context before sending funds.
- Checkout warns users when trust context is missing or still loading.
- Trust context is additive and visible, not hidden in profile details only.
- Slow trust hydration does not make the UI feel broken or misleading.

### G) Legal, Risk & Support Surfaces

#### Current codebase state

- Privacy and observability constraints are already documented in `docs/specs/privacy-observability.md`.
- That spec already prohibits behavioral tracking, message inspection, and sensitive telemetry fields.
- Open Phase 2 work is expected to add compact app footers, bug-report forms, and provenance/about surfaces.
- The core non-custodial risk posture exists in repo docs and should remain consistent with user-facing product copy.

#### Phase 2 implementation work

- Add clear product surfaces for:
  - Privacy Policy
  - Terms of Service
  - risk disclosures
  - beta support / bug reporting
- State clearly in product language that:
  - Conduit does not hold funds
  - Conduit does not control merchants
  - Lightning payments are irreversible
- Use `docs/specs/privacy-observability.md` as the source of truth for monitoring constraints.
- Keep support and monitoring implementation aligned with the privacy policy:
  - system metrics only
  - no message content inspection
  - no user-level tracking workarounds

#### Done when

- Legal and support surfaces are easy to find in Market and Merchant.
- Non-custodial and irreversible-payment language is visible at the right user moments.
- Monitoring language in product and docs matches the existing privacy-observability spec.
- Beta users have a clear support path without introducing privacy-hostile instrumentation.

### H) Launch Safety, Filtering and Version Transparency

#### Current codebase state

- Product visibility concepts exist in product and spec history, but listing moderation states still need clear runtime product semantics before they become launch gates.
- Market already handles empty, loading, and missing-data states in several routes; launch work should keep loading/degraded/unavailable language consistent.
- Open provenance work is expected to expose version/build/source context through product surfaces and NIP-89 metadata.

#### Phase 2 implementation work

- Define merchant-facing listing moderation states:
  - active
  - hidden
  - flagged
  - blocked
- Prevent unsupported or blocked listings from rendering as normal inventory in Market.
- Show merchants why a listing is not active and what action is required, when applicable.
- Distinguish three separate concerns instead of mixing them:
  - moderation state
  - loading-state UX copy
  - version/build/source transparency
- Add version and source transparency surfaces so users can identify:
  - what app version is running
  - what build or release they are on
  - where the source lives once the repo is public
- Improve loading and hydration language so users can tell whether data is:
  - loading
  - partially hydrated
  - unavailable
  - fully available

#### Done when

- Merchants can see listing moderation state directly.
- Unsupported or blocked listings are not shown as ordinary active listings.
- Users can tell whether missing data is still loading or actually unavailable.
- Market and Merchant expose version/build/source context in a way that supports trust and debugging.

---

## Payment Flow (Phase 2 Baseline)

Phase 2 uses a payment model that depends on merchant capability.

### Primary Flow (Fast / Zap-Based Checkout)

Buyer pays immediately based on order total -> proof of payment is created and sent -> merchant verifies and marks order as paid

#### Current codebase state

- The current codebase has checkout, invoice, payment-attempt, payment-rail, and order-message primitives.
- Open Phase 2 work is expected to complete the fast-path buyer and merchant experience.

#### Phase 2 implementation work

- Extend current checkout and order-message flows so eligible buyers can pay directly from checkout.
- Use proof of payment as the bridge between buyer payment and merchant confirmation.
- Gate this path on merchant readiness and trust conditions.

#### Done when

- Fast checkout is hardened as a real product path, not just a protocol possibility.
- Buyers and merchants can both see the fast-payment state clearly.

### Fallback Flow (Manual Invoice)

Buyer places order -> merchant sends invoice -> buyer pays and sends proof -> merchant confirms and marks order as paid

- Fast checkout is only available when the merchant meets the required setup and trust conditions.

#### Current codebase state

- This is the most implemented payment path in the repo today.
- Merchant can already send invoices and update order state from the orders workspace.
- Buyer can already receive invoice and payment-related conversation messages.

#### Phase 2 implementation work

- Keep this path as a required baseline, not a legacy edge case.
- Tighten proof handling, state labels, and buyer confirmation around the existing invoice flow.

#### Done when

- The manual invoice flow remains reliable and understandable even after fast checkout is added.
- Buyers and merchants can complete the full fallback loop without ambiguous state transitions.

---

## Optional Scope (P1 Workstreams - Non-Blocking)

These items are optional unless added later in writing.

- More advanced trust or social features
- Broad NIP-46 remote-signer UX beyond the external-signer policy already documented in the repo

Current codebase note:

- Basic trust context and follow behavior are present or landing in Market store and checkout surfaces.
- Repo workflow and AI review instructions mention NIP-46 because the architecture allows external signers beyond NIP-07, but broad NIP-46 product UX is not a required Phase 2A deliverable.

---

## Explicit Exclusions

Not included in Phase 2 unless added later.

- Advanced analytics or reputation systems
- Full social feed or non-commerce social features

Current codebase note:

- The privacy-observability spec already pushes the implementation away from user tracking and toward aggregate metrics.
- Relay and trust docs include broader trust-network ideas, but they are not part of required Phase 2 delivery.

---

## Design / Product Guidelines

Implementation for Market and Merchant should remain in substantial conformance with these product rules:

- Non-custodial architecture
- Signer-based authentication
- Trust-visible payment flows
- Clear separation of fast and fallback payment paths
- Application architecture supporting future relay, caching, and local-first app architecture work

Codebase-aware interpretation:

- Keep auth external-signer-only across Market and Merchant, consistent with current repo rules in `CONTRIBUTING.md` and `.github/copilot-instructions.md`.
- Keep payments invoice/proof based and avoid any balance-holding or custody model.
- Keep trust visible in product surfaces rather than hiding it in relay or moderation internals.
- Keep route code and shared protocol code extensible enough to support relay, cache, and future local-first architecture without rewriting app behavior around a single backend shape.
- Current work may continue using NDK where it is the practical repo pattern. When adding new relay-heavy or source-aware behavior, leave a small note in PRs if NDK appears to be constraining the design and a future Nostrify/custom adapter boundary should be considered.

---

## Exit Criteria

Phase 2 is complete when:

- the repo is ready for outside contributors and public open-source use
- relay roles and fallback behavior are explicit in both docs and product behavior
- Merchant exposes readiness and payment eligibility clearly
- Market supports both fast checkout and fallback invoice checkout
- payment proof and payment states are visible and understandable to buyers and merchants
- trust context is visible before payment-sensitive actions
- legal, risk, and beta-support surfaces are present
- listing moderation state and blocked-listing suppression work clearly
- version, build, and source transparency are visible in product

---

## Verification Checklist For This Plan

- The document preserves the current A-H Phase 2 scope while reflecting shipped and in-flight implementation.
- Each section distinguishes between current implementation, extension work, and net-new work.
- The plan points to real monorepo surfaces where implementation is likely to live.
- The plan does not invent backend architecture that conflicts with the current codebase.
- Another engineer can use this file to create issues or implement PRs without first re-mapping the repo.

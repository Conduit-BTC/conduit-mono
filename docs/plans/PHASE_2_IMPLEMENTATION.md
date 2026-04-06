# Phase 2 Implementation

Phase 2 is the execution plan for the next Conduit sprint after MVP.

This document preserves the finalized Phase 2 scope agreed between the parties, but translates that scope into a codebase-aware implementation map for `conduit-mono`.

For each included area, this plan states:
- current codebase state
- Phase 2 implementation work
- done when

The goal is to make this file usable as both:
- a human-readable scope reference
- an operational planning document that can be turned into issues and PRs without re-discovering the repo

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
- The repo is not yet open-source complete: `README.md` still says `License: TBD`.
- Branch protection rules are described in `CONTRIBUTING.md`, but the Phase 2 doc should treat repo protection and review policy as required repo standards, not just contributor notes.

#### Phase 2 implementation work

- Finish the public repo baseline:
  - add MIT licensing
  - update `README.md` and related docs so the public repo boundary is explicit
  - remove or relocate any tracked docs that are not safe for a public repo
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
- Add public repo linking from product and website surfaces once the repo is ready to expose.

#### Done when

- The repo is publishable under MIT without `TBD` placeholders.
- A new contributor can clone the repo, run the apps, and understand the monorepo boundary from `README.md` and `CONTRIBUTING.md`.
- Required PR checks and review expectations are explicit and match actual CI.
- AI review instructions are present, current, and aligned with Conduit’s protocol and privacy rules.
- The repo can support parallel work without pushing shared logic into app-local copies.
- Product and website surfaces can safely link to the public repo.

### B) Relay Architecture and Frontend Setup

Second priority. This work lets relay and caching infrastructure proceed in parallel without forcing another frontend rewrite.

#### Current codebase state

- `packages/core/src/config.ts` already supports:
  - `relayUrl`
  - `l2RelayUrls`
  - `merchantRelayUrls`
  - `publicRelayUrls`
  - `cacheApiUrl`
- The current config already builds a merged relay list for client use.
- `packages/core/src/protocol/commerce.ts` already uses source-aware read plans and returns source metadata such as `cache`, `l2`, `merchant`, `public`, and `local_cache`.
- Relay architecture is already documented in:
  - `docs/specs/relay/conduit_relay_architecture.md`
  - `docs/specs/relay/conduit_l2_scope2_functional.md`
- Merchant and Market already depend on relay reads, local cache, and fallback handling, but relay roles are not yet a clear user-facing product concept.
- Merchant UI currently exposes relay health at a high level on the dashboard, but there is not yet a full relay settings product surface aligned to the three-layer architecture.

#### Phase 2 implementation work

- Make the three relay roles explicit in product and docs:
  - merchant relay
  - public relay
  - future Conduit-operated acceleration layers such as L2 and cache/index
- Build relay settings UX that maps to the existing `@conduit/core` config model instead of a single flat relay list.
- Keep Market and Merchant route code source-agnostic:
  - routes should consume stable typed read results
  - routes should react to source and degraded-state metadata
  - routes should not hard-code assumptions about cache or L2 internals
- Preserve graceful degradation:
  - browsing may use faster layers first
  - canonical verification should still be possible against merchant-visible state
  - apps should continue to function when cache or L2 is absent
- Keep Conduit-operated relay and cache layers narrow in responsibility:
  - hydration
  - performance
  - verification support
  - not hidden app-only truth
- Align frontend behavior with the existing relay architecture docs instead of creating a second architecture in UI code.

#### Done when

- Merchant and Market can explain relay roles in product terms, not just env var terms.
- Relay settings map cleanly to the current config model in `@conduit/core`.
- Frontend reads remain compatible with merchant-only, public-relay, and accelerated-read scenarios.
- Fallback behavior is explicit in UI and implementation instead of implicit in scattered route logic.
- The infrastructure team can extend relay and cache layers without forcing route-level rewrites.

### C) Merchant Setup, Readiness & Payment Eligibility

#### Current codebase state

- Merchant already has working surfaces for:
  - profile editing in `apps/merchant/src/routes/profile.tsx`
  - product management in `apps/merchant/src/routes/products.tsx`
  - order handling and invoicing in `apps/merchant/src/routes/orders.tsx`
  - dashboard stats in `apps/merchant/src/routes/index.tsx`
- Merchant dashboard already shows high-level counts such as listings, open orders, awaiting payment, and awaiting fulfillment.
- There is no single merchant settings editor that combines profile, payment, shipping, and relay readiness into one operational setup flow.
- There is no explicit “minimum viable merchant” checklist or readiness state model in the current product.
- Merchant payment eligibility is currently implied by available invoice tooling, not expressed as a formal readiness state.

#### Phase 2 implementation work

- Build a complete merchant settings surface that covers:
  - profile identity
  - payment setup
  - shipping readiness
  - relay configuration
- Define a minimum viable merchant checklist using current product capabilities and required missing surfaces.
- Add explicit readiness states to the Merchant dashboard instead of relying on raw order or listing counts.
- Split merchant payment capability into clear product states:
  - eligible for fast checkout
  - limited to invoice/manual flow
- Make payment eligibility depend on real merchant setup, not just whether an invoice can eventually be sent.
- Keep the readiness model grounded in current app surfaces rather than inventing a separate back-office system.

#### Done when

- Merchants can see what setup is complete, what is missing, and what payment path they currently support.
- Merchant setup is understandable from one settings/readiness flow instead of scattered pages.
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
- This means the fallback invoice flow is already partially implemented.
- Fast checkout from order total does not yet exist as a clearly gated buyer flow.

#### Phase 2 implementation work

- Keep the existing order-first checkout path as the fallback baseline.
- Add a fast checkout path for eligible merchants and NWC-ready buyers.
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
  - payment proof exists as a message type, but the Phase 2 proof model is not yet enforced as a full product rule
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
- Trust context is not yet established as a checkout decision surface.
- Checkout itself does not yet clearly warn buyers when they are sending funds without visible trust context.

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
- The apps do not yet appear to expose a complete legal and support surface for beta users.
- The core non-custodial risk posture exists in repo docs, but it is not yet consistently surfaced as user-facing product copy.

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

- Product visibility concepts exist in product and spec history, but listing moderation states are not yet clearly implemented as runtime merchant-facing states.
- Market already handles empty, loading, and missing-data states in several routes, but loading-state language is not yet standardized as a launch-readiness concern.
- Package versions exist in `package.json` files, and protocol docs already call for post-MVP versioning and provenance, but version/build/source visibility is not yet exposed as a clear product surface.

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

- The current codebase has checkout, invoice, and order-message primitives.
- The current codebase does not yet expose this full fast path as a complete buyer and merchant experience.

#### Phase 2 implementation work

- Extend current checkout and order-message flows so eligible buyers can pay directly from checkout.
- Use proof of payment as the bridge between buyer payment and merchant confirmation.
- Gate this path on merchant readiness and trust conditions.

#### Done when

- Fast checkout exists as a real product path, not just a protocol possibility.
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
- NIP-46 support

Current codebase note:
- Basic trust context and follow behavior are partially present in Market store surfaces.
- Repo workflow and AI review instructions already mention NIP-46 as an auth constraint, but broad NIP-46 product support is not yet a required Phase 2 deliverable.

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
- Application architecture supporting future relay, caching and service extensibility

Codebase-aware interpretation:

- Keep auth external-signer-only across Market and Merchant, consistent with current repo rules in `CONTRIBUTING.md` and `.github/copilot-instructions.md`.
- Keep payments invoice/proof based and avoid any balance-holding or custody model.
- Keep trust visible in product surfaces rather than hiding it in relay or moderation internals.
- Keep route code and shared protocol code extensible enough to support relay, cache, and service evolution without rewriting app behavior around a single backend shape.

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

- The document preserves the finalized A-H scope exactly.
- Each section distinguishes between current implementation, extension work, and net-new work.
- The plan points to real monorepo surfaces where implementation is likely to live.
- The plan does not invent backend architecture that conflicts with the current codebase.
- Another engineer can use this file to create issues or implement PRs without first re-mapping the repo.

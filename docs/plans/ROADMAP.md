# Conduit Roadmap

Strategic roadmap for the Conduit commerce platform. For the current planning index, see [PLAN.md](../../PLAN.md). For current implementation status, see [IMPLEMENTATION.md](./IMPLEMENTATION.md). For system architecture, see [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## Vision

Build a decentralized commerce platform where merchants and buyers transact directly over Nostr protocol, with no platform custody of funds or user data.

---

## Development Epochs

| Epoch             | Status   | Focus                                                                   |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| **Genesis**       | Complete | Architecture, infrastructure, wireframes                                |
| **Core Function** | Complete | Market + Merchant Portal MVP                                            |
| **Phase 2A**      | Active   | Closeout, launch safety, merchant readiness, trust, provenance, support |
| **Phase 2B**      | Planned  | Local-first performance and app architecture                            |
| **Added Value**   | Future   | Social features and enhanced discovery                                  |
| **Scale**         | Future   | Multi-language and enterprise readiness                                 |

---

## Epoch Details

### Genesis (Complete)

**Objective**: Prepare a fully specified, architecturally sound foundation such that implementation can proceed without ambiguity.

**Market**

- Finalize marketplace scope, assumptions, and boundaries
- Lock protocol primitives (event kinds, signer model, relay assumptions)
- Complete PRDs, system diagrams, and AI-agent context documentation
- Establish repository structure, environments, and CI/AI review workflows
- Finalize initial Figma designs and UX flows for core interactions
- Build wireframes for product listing, product cards, cart, profile, messaging

**Merchant Portal**

- Define Portal as sole interface for merchant product management
- Lock authentication to external signers (NIP-07, NIP-46)
- Define merchant protocol surface (publishable/readable event kinds)
- Lock order/payment primitives (NIP-17 DMs, NWC invoices)
- Define merchant-controlled relay roles
- Produce protocol boundary documentation

**Store Builder**

- Define Store Builder role relative to Market (discovery) and Portal (operations)
- Finalize store identity, publishing model, and event linkage
- Capture first storefront assumptions for future scoping
- Keep generated-store deployment out of current client milestones until a future spec is accepted

---

### Core Function (Complete)

**Objective**: Prove the core marketplace loop works end-to-end.

**Market**

- Buyers authenticate via external signers
- Products discoverable, viewable, understandable
- Buyer-merchant communication via NIP-17
- Orders initiated and settled via Lightning/NWC
- Basic profiles and identity surfaces
- Full UX design implemented from Figma

**Merchant Portal**

- Product management surface (create, edit, publish, deprecate)
- Order dashboard with filtering by state
- Order state transitions (protocol-backed vs local annotations)
- Fulfillment acknowledgment (minimal, no shipping integrations)
- Failure/recovery handling (partial orders, duplicates, delayed payments)

**Store Builder**

- Placeholder app exists in the monorepo
- Generated-store product scope deferred until a future spec is accepted

---

### Phase 2A: Closeout, Architecture & Velocity

**Objective**: Stabilize and finish the current Market and Merchant launch-readiness work without expanding scope into a broad architecture refactor.

**Market**

- Fast/fallback checkout clarity
- Payment proof and buyer success states
- Merchant trust context before payment-sensitive actions
- Legal, support, provenance, and issue-reporting surfaces

**Merchant Portal**

- Readiness and setup state for profile, payments, shipping, relays, products, and orders
- Shipping and payment readiness that reflect real user workflows
- Product publish/delete safety and order-state clarity

**Shared Packages**

- Relay settings and capability surfaces that remain Nostr-native
- Payment proof state model
- Secure marketplace messaging and NIP-44 v3 readiness
- Minimum essential-commerce outbox for signed orders, messages, payment proofs, and product publish/delete actions
- Automation/telemetry guardrails that preserve privacy
- Source/version/build transparency

### Phase 2B: Performance and App Architecture

**Objective**: Move toward local-first resilience and source-aware Nostr reads after Phase 2A closeout, without blocking current milestone delivery.

The target direction is a shared local-first commerce substrate with Market and Merchant rendering prepared state from the same underlying evidence model. Current Phase 2A work should leave room for that direction, but should not replace working route/query behavior until the Phase 2B architecture has its own accepted spec.

Expected themes:

- full signed-write frontier beyond the Phase 2A essential-commerce outbox
- source-aware relay read execution and relay health
- local-first product/profile/order/message readiness
- cache and media readiness as performance aids, not hidden sources of truth
- Merchant workspace and Market browse views as lenses over shared commerce evidence

### Added Value

**Objective**: Deliver user-facing value beyond raw protocol access.

**Market**

- Enhanced social context (richer profiles, social signals, web-of-trust)
- Improved discovery (filtering, categorization, relevance)
- Robust communication beyond baseline NIPs
- Better relay handling (selection, prioritization, performance)
- "Serious" marketplace experience comparable to modern web apps

**Merchant Portal**

- Enhanced fulfillment workflows (partial/split, backorder, internal notes)
- Shipping integrations (ShipStation/EasyPost - USPS, UPS, FedEx)
- Packing & dispatch tooling (slips, batch labels)
- Payment operational controls (invoice expiry, re-issuance)
- Cross-channel consistency between Market and any future storefront surfaces

**Store Builder**

- Future generated-store direction, not active Added Value scope until accepted separately

---

### Scale

**Objective**: Evolve into a durable, multi-dimensional platform for global usage.

- Multi-language and multi-currency support
- Advanced discovery and advertising formats
- Ecosystem partnerships and revenue-sharing
- Enterprise-grade infrastructure
- Future Store Builder and service-backed commerce capabilities once they have their own accepted specs

---

## Protocol Constraints (Non-Negotiable)

### Authentication

- External signers ONLY (NIP-07, NIP-46)
- NO key generation, custody, or storage in apps
- Merchant/buyer identity = pubkey only

### Privacy

- NO behavioral tracking or profiling
- NO message content inspection
- System metrics only (relay success, load times)
- All user data stays on user's device or relays

### Payments

- Non-custodial Lightning payment requests and proofs
- NWC/WebLN payment rails, not balance management
- No refund processing in-app

---

## App Schedule

| App/Area              | Genesis  | Core Function         | Phase 2A                          | Phase 2B                                | Future                   |
| --------------------- | -------- | --------------------- | --------------------------------- | --------------------------------------- | ------------------------ |
| **Market**            | Complete | Complete              | Active                            | Planned                                 | Added Value / Scale      |
| **Merchant Portal**   | Complete | Complete              | Active                            | Planned                                 | Added Value / Scale      |
| **Store Builder**     | Concept  | Placeholder app       | Out of active scope               | Out of active scope                     | Future spec required     |
| **Relay**             | Concept  | Shared relay defaults | Congee/default relay and settings | Source-aware relay health/read frontier | Future service hardening |
| **External Services** | Concept  | Out of scope          | Out of scope                      | Out of scope                            | Future service repo/spec |

---

## References

- [PLAN.md](../../PLAN.md) - Current planning index
- [IMPLEMENTATION.md](./IMPLEMENTATION.md) - Current implementation status
- [ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture and diagrams
- [Protocol specs](../specs/) - Feature specifications

# Conduit Roadmap

Strategic roadmap for the Conduit commerce platform. For the current planning index, see [PLAN.md](../../PLAN.md). For current implementation status, see [IMPLEMENTATION.md](./IMPLEMENTATION.md). For system architecture, see [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## Vision

Build a decentralized commerce platform where merchants and buyers transact directly over Nostr protocol, with no platform custody of funds or user data.

---

## Development Epochs

| Epoch | Focus | Target |
|-------|-------|--------|
| **Genesis** | Architecture, infrastructure, wireframes | 2/12/2026 |
| **Core Function** | Market + Merchant Portal MVP | 3/12/2026 |
| **Added Value** | Social features, enhanced UX | TBD |
| **Monetization** | Premium tiers, ads | TBD |
| **Scale** | Multi-language, enterprise | TBD |

---

## Epoch Details

### Genesis (Current)

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
- Create first individual store template using Market components
- Establish build/deploy workflows

---

### Core Function

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
- AI-driven store generation from template
- Store creation tied to merchant identity
- Product publishing into store context
- Basic layout, navigation, product listing
- Order initiation and settlement
- Minimal customization (distinguish stores from each other)

---

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
- Cross-channel consistency (Market + Store Builder orders identical)

**Store Builder**
- Feature parity with Market social/interaction capabilities
- Richer customization (branding, layout, presentation controls)
- Improved buyer trust signals and social context
- Optional managed hosting by Conduit
- Integration with Portal features (shipping, wallets, dashboards)

---

### Monetization

**Objective**: Establish revenue generation while preserving trust and baseline access.

See [monetization.md](../specs/monetization.md) for full specification.

**Principles**
- Value-aligned: Pay for leverage, not access
- Two-sided: Both shoppers and merchants can subscribe
- Sats-denominated: All pricing in satoshis
- No custody: Credits are prepaid tokens, not held funds
- Graceful degradation: Free tier always works

**Revenue Streams**

| Stream | Target | Description |
|--------|--------|-------------|
| **Shopper Membership** | Buyers | Ad-free, personalized discovery, NIP-05, monthly credits |
| **Merchant Membership** | Sellers | Automated orders, AI messaging, analytics |
| **Sats Credits** | Both | Prepaid tokens for premium services |
| **Sponsored Placements** | Merchants | Bid for visibility in search/browse |
| **Store Hosting** | Merchants | Managed Blossom hosting ($12-21/mo) |
| **Curator Revenue Share** | Curators | Percentage of ad spend on curated pages |

**Membership Tiers**

| Tier | Approx Price | Target |
|------|--------------|--------|
| **Free** | $0 | Casual users, new merchants |
| **Side Hustle** | ~$7-10/mo | Regular shoppers, hobbyist sellers |
| **Pro Hustle** | ~$15-30/mo | Power users, serious businesses |
| **Enterprise** | Custom | High-volume merchants |

**Credit System**
- Sats-denominated prepaid tokens (never expire)
- Consumed by: automated orders, AI messaging, analytics, AI store generation
- Membership includes monthly credit allotment
- Volume discounts for high usage

**Advertising**
- Sponsored Products in search results
- Category Sponsorship at top of category pages
- Homepage Featured rotation
- Curated Page Sponsor (on curator collections)
- All sponsored content clearly labeled
- Fair auction mechanism
- Self-serve campaign tools in Merchant Portal

**Non-Goals (Preserve Trust)**
- No percentage of sales (0% revenue share)
- No charging buyers to browse/buy
- No selling user data or behavior
- No pay-to-win search ranking (organic stays organic)
- No locking merchants into platform
- No custody of user funds
- No message content inspection

---

### Scale

**Objective**: Evolve into a durable, multi-dimensional platform for global usage.

- Multi-language and multi-currency support
- Advanced discovery and advertising formats
- Ecosystem partnerships and revenue-sharing
- Enterprise-grade infrastructure
- "Shopify killer" moment for Store Builder

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
- NWC-based Lightning (no custody)
- Invoice generation, not balance management
- No refund processing in-app

---

## App Schedule

| App | Genesis | Core Function | Added Value | Monetization | Scale |
|-----|---------|---------------|-------------|--------------|-------|
| **Market** | 2/12/2026 | 2/26/2026 | TBD | TBD | TBD |
| **Merchant Portal** | 2/12/2026 | 3/12/2026 | TBD | TBD | TBD |
| **Store Builder** | TBD | TBD | TBD | TBD | TBD |
| **Relay** | TBD | TBD | TBD | TBD | TBD |
| **Coordinator** | TBD | TBD | TBD | TBD | TBD |

---

## References

- [PLAN.md](../../PLAN.md) - Current planning index
- [IMPLEMENTATION.md](./IMPLEMENTATION.md) - Current implementation status
- [ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture and diagrams
- [Protocol specs](../specs/) - Feature specifications

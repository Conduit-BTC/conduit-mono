# Implementation Guide

## Overview

Build the Conduit monorepo fresh, using legacy repos (`conduit-market-client`, `merchant-portal`) as **visual/design reference only**. No code migration - clean architecture from day one.

**Goals**: Market 2/26, Merchant 3/12, MVP 3/12

---

## MVP Scope

### In MVP (Phases 1-4)

| Feature | Market | Merchant | Notes |
|---------|--------|----------|-------|
| Product discovery | ✅ | - | Browse, search, filter |
| Product detail | ✅ | - | Images, description, add to cart |
| Cart | ✅ | - | localStorage, grouped by merchant |
| Checkout | ✅ | - | Shipping form, order creation |
| Order creation | ✅ | - | NIP-17 DM to merchant |
| Invoice display | ✅ | - | QR code, copy, timer |
| Invoice generation | - | ✅ Manual | Merchant uses NWC button |
| Payment confirmation | - | ✅ Manual | Merchant checks wallet |
| Order management | ✅ View | ✅ Full | Status updates via DM |
| Messaging | ✅ | ✅ | NIP-17 encrypted DMs |
| Product CRUD | - | ✅ | Kind 30402 publish/edit/delete |
| Profile management | ✅ | ✅ | Kind 0 |

### MVP Stretch Milestones (Optional, Still Within Phases 3-4)

These are nice-to-have milestones that should not block the Phase 4 Merchant Portal v1 delivery.

| Milestone | Phase | Market | Merchant | Notes |
|----------|-------|--------|----------|------|
| One-way checkout (pay handle + proof) | 4 | ✅ | ✅ | Buyer pays merchant directly, then sends `PaymentProof` via NIP-17; merchant verifies async. No custody, no invoices. |

### NOT in MVP (Post-MVP Phases)

| Feature | Phase | Why Deferred |
|---------|-------|--------------|
| Automated payments | 6 (Coordinator) | Requires server-side bot |
| Auto invoice generation | 6 (Coordinator) | Requires NIP-46 remote signing |
| Inventory sync | 6 (Coordinator) | Requires event processing |
| Custom relay | 5 (Relay) | Public relays work for MVP |
| NIP-46 auth (Remote signer) | 6 (Coordinator) | Extra connection UX + reliability surface; bundle with automation/hardening |
| Store Builder | 7 | Nice-to-have, not core loop |
| Shipping integrations | Added Value | ShipStation/EasyPost |
| GitHub migration | 4.5 | Do before onboarding team members |
| Monetization | 8 (Monetization) | Membership, credits, ads, hosting |

### MVP Payment Flow (Baseline)

**Manual but functional:**
1. Buyer creates order → NIP-17 DM to merchant
2. Merchant sees order → manually generates NWC invoice
3. Merchant sends invoice → NIP-17 DM to buyer
4. Buyer pays invoice → Lightning payment
5. Merchant confirms → manually marks "Paid"
6. Merchant ships → sends tracking via DM

See `docs/ARCHITECTURE.md` for flow diagrams comparing MVP vs Coordinator.

### Milestone: One-Way Checkout (Optional)

Buyer-initiated, non-custodial flow:
1. Merchant publishes payment handle(s) (e.g. Lightning Address, stablecoin address) in Portal settings
2. Buyer creates order → NIP-17 DM to merchant
3. Buyer pays merchant directly (outside Conduit custody)
4. Buyer sends `PaymentProof` payload to merchant via NIP-17 DM
5. Merchant verifies independently and marks the order "Paid (verified)"
6. Fulfillment proceeds asynchronously

---

## Pre-Implementation: Extract Protocol from Legacy

Before starting infrastructure work, extract these from legacy repos and document in `docs/specs/protocol.md`:

### Protocol Schemas (Defined in Legacy)

**Order Event (Kind 16, wrapped in NIP-17):**
```
Source: /conduit-market-client/src/lib/nostr/createOrder.ts
```
- Tags: `p` (merchant), `subject`, `type`, `order` (ID), `amount`, `item[]`, `shipping`, `address`, `phone`, `email`
- Use Conduit's internal Zod schemas in `@conduit/core` for validation (interop parsing is best-effort)
- Wrapped in Kind 1059 (gift wrap) + Kind 13 (seal)

**Order Event Types:**
```
Source: /conduit-market-client/src/stores/useOrderStore.ts
```
- `order`, `payment_request`, `status_update`, `shipping_update`, `receipt`

**Order States:**
- `pending`, `processing`, `completed`, `cancelled`, `failed`

**Cart Structure:**
```
Source: /conduit-market-client/src/stores/useCartStore.ts
```
- Grouped by merchant pubkey
- Items: productId, eventId, tags, currency, name, price, image, quantity

### Design System (Extract from Legacy + Figma)
- [ ] Color palette from `/conduit-market-client/src/styles/`
- [ ] Component patterns from `/conduit-market-client/src/components/`
- [ ] Typography/spacing from Figma

### Decisions Made
- **localStorage** - Cart, shipping info, user preferences
- **Dexie (IndexedDB)** - Orders, messages, event cache (larger datasets, offline support)
- **Zod schemas in `@conduit/core`** - Validate normalized objects; emit spec-aligned events; parse external events best-effort

### Storage Architecture
```
localStorage (small, sync)     Dexie/IndexedDB (large, async)
├── cart items                 ├── orders (by orderId)
├── shipping info              ├── messages (by conversation)
├── relay preferences          ├── products cache (by eventId)
└── auth state                 └── profiles cache (by pubkey)
```

---

## Phase 0: Extract & Document

**Before writing infrastructure code**, extract existing patterns from legacy repos:

### P0.1: Protocol Specification
📍 Create `docs/specs/protocol.md` (TODO)

The protocol details are currently documented inline in:
- `docs/specs/market.md` - Cart model, Order event (Kind 16), checkout flow
- `docs/specs/merchant.md` - Product event (Kind 30402), order states, shipping (Kind 30406)
- `docs/ARCHITECTURE.md` - Event flow diagrams, state machines

A dedicated `protocol.md` should consolidate:
- [ ] All event kind definitions with tag schemas
- [ ] NIP-17 wrapping flow (seal + gift wrap)
- [ ] Order event types (order, payment_request, status_update, shipping_update, receipt)
- [ ] Validation with `@conduit/core` Zod schemas (product/order/etc)
- [ ] Payment flow (NWC invoice generation, zap receipts)

**Key Legacy Files for Reference:**
```
/conduit-market-client/src/lib/nostr/createOrder.ts      # Order creation + NIP-17 wrapping
/conduit-market-client/src/stores/useOrderStore.ts       # Order types/states
/conduit-market-client/src/stores/useCartStore.ts        # Cart structure
/merchant-portal/src/stores/useProductStore.ts           # Product CRUD + Kind 30402
/merchant-portal/src/stores/useShippingOptionStore.ts    # Kind 30406
```

### P0.2: Design Tokens & UI Extraction
📍 Enhance `packages/ui/src/styles/`

**From Figma** (Primary source for visual design):
```
File: "Conduit High Fi - Website" in Conduit Market Team
URL: https://www.figma.com/design/adfNXYE3nBqr35frkl0b5q
Pages: "High Fi - WIP" (screen designs), "Site Map & 3 User flows" (flows)
```

Extract from Figma:
- [ ] Color palette (dark theme, purple/violet primary, lime secondary)
- [ ] Typography scale (ABC Whyte Inktrap for headings, Poppins for body)
- [ ] Spacing and layout grid
- [ ] Component designs (cards, buttons, forms, nav)
- [ ] Screen layouts for each route

**From Legacy** (Secondary - code patterns only):
```
/conduit-market-client/src/styles/
/conduit-market-client/src/components/
```

**Figma MCP Workflow:**
1. Open Figma desktop with "Conduit High Fi - Website" file
2. Navigate to "High Fi - WIP" page
3. Select specific frames to extract:
   - `mcp__figma-desktop__get_design_context` - Component code hints
   - `mcp__figma-desktop__get_variable_defs` - Design tokens
   - `mcp__figma-desktop__get_screenshot` - Visual reference
4. Map Figma frames to routes in specs

**Known Design Tokens (from Figma):**
```typescript
// Typography
"Text/Heading/Desktop/H2": "ABC Whyte Inktrap Trial, Medium, 48px"
"Text/Heading/Desktop/H4": "Poppins SemiBold, 32px"
"Text/Heading/Desktop/H5": "Poppins SemiBold, 24px"
"Text/Heading/Desktop/tagline": "Poppins Medium, 16px"

// Theme: Dark mode with purple accents
// Primary: Purple/violet
// Secondary: Lime/yellow-green
// Background: Deep navy/purple
```

### P0.3: Verify Dependencies
- [ ] Confirm NDK version compatibility
- [ ] List other reusable packages from legacy

---

## Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | Bun | Fast, native TS |
| Build | Vite 6 + SWC | HMR, fast builds |
| Framework | React 19 | Latest concurrent features |
| Routing | **TanStack Router** | Type-safe, loaders, search params |
| Server State | **TanStack Query + NDK** | All relay data |
| Client State | **React Context** | Auth only |
| Persistence | **localStorage** | Cart, preferences, auth |
| Database | **Dexie (IndexedDB)** | Orders, messages, event cache |
| Forms | react-hook-form + Zod | Validation |
| UI | **shadcn/ui** + Tailwind | Composable, accessible |
| Validation | `@conduit/core` (Zod) | Order/event validation |
| Analytics | **Optional (default-off)** | Aggregate-only, self-hosted preferred |
| Events/Errors | **Optional (default-off)** | Operational metrics only, strict allowlist |

**No Zustand. No Jotai. No state library.**

---

## Analytics & Observability

### Philosophy

Conduit follows a privacy-first observability model:
- telemetry is optional and default-off
- investor reporting uses aggregate metrics, not user-level traces
- no persistent product-analytics identifiers
- no message/order/payment content in telemetry

Authoritative policy:
- `docs/specs/privacy-observability.md`

Implementation rules:
- If enabled, use aggregate-only counters and operational health metrics.
- Prefer self-hosted telemetry backends.
- Maintain a strict event allowlist and CI guard against unauthorized tracking SDKs.
- Centralized billing metrics are allowed for accounting (MRR, top-ups, credits spent), not surveillance.

---

## Environments & Testing

### Environment Variables

```bash
# .env.example
VITE_RELAY_URL=wss://relay.conduit.market
VITE_DEFAULT_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
VITE_LIGHTNING_NETWORK=mock  # mock | mutinynet | mainnet
```

### Environment Strategy

| Environment | Default Config | Can Override |
|-------------|----------------|--------------|
| **Local** | mock payments, public relays | Yes, via .env.local |
| **Preview** | mutinynet, public relays | Set in Cloudflare |
| **Production** | mainnet, conduit relay | Set in Cloudflare |

**Local .env.local examples:**
```bash
# Default local (mock payments)
VITE_LIGHTNING_NETWORK=mock

# Test real testnet payments locally
VITE_LIGHTNING_NETWORK=mutinynet

# Test real mainnet payments locally (careful!)
VITE_LIGHTNING_NETWORK=mainnet

# Use local relay
VITE_RELAY_URL=ws://localhost:7777
VITE_DEFAULT_RELAYS=ws://localhost:7777
```

### Cloudflare Pages Setup

Automatic preview deployments per branch - no config needed.

```bash
# Install Wrangler CLI
bun add -g wrangler

# Login
wrangler login

# Create projects (one-time)
wrangler pages project create conduit-market
wrangler pages project create conduit-merchant
```

**Build settings:**
- Build command: `bun run build`
- Build output: `dist`
- Root directory: `apps/market` (or `apps/merchant`)

**Environment variables (set in Cloudflare dashboard):**

Production:
```
VITE_RELAY_URL=wss://relay.conduit.market
VITE_DEFAULT_RELAYS=wss://relay.conduit.market,wss://relay.damus.io
VITE_LIGHTNING_NETWORK=mainnet
```

Preview:
```
VITE_RELAY_URL=wss://relay.damus.io
VITE_DEFAULT_RELAYS=wss://relay.damus.io,wss://nos.lol
VITE_LIGHTNING_NETWORK=mutinynet
```

### Preview URLs

Every PR/branch automatically gets:
- `feat-checkout.conduit-market.pages.dev`
- `feat-checkout.conduit-merchant.pages.dev`

Share with teammates for testing before merge.

### Lightning Testing Environments

| Network | Use Case | Wallet |
|---------|----------|--------|
| **Mocked** | Local dev, unit tests | Mock NWC responses |
| **Mutinynet** | Preview/staging, integration tests | [Mutiny Wallet](https://mutinywallet.com) (signet mode) |
| **Mainnet** | Production | Any NWC wallet |

### Local Development

```bash
# Start local relay (optional, for offline dev)
docker run -p 7777:7777 dockurr/strfry

# Start apps
bun run dev:market    # localhost:3000
bun run dev:merchant  # localhost:3001
```

### Config Module

```typescript
// packages/core/src/config.ts
export type LightningNetwork = "mock" | "mutinynet" | "mainnet"

export const config = {
  relayUrl: import.meta.env.VITE_RELAY_URL ?? "wss://relay.damus.io",
  defaultRelays: (import.meta.env.VITE_DEFAULT_RELAYS ?? "wss://relay.damus.io,wss://nos.lol").split(","),
  lightningNetwork: (import.meta.env.VITE_LIGHTNING_NETWORK ?? "mock") as LightningNetwork,

  get isMockPayments() {
    return this.lightningNetwork === "mock"
  },
  get isTestnet() {
    return this.lightningNetwork === "mutinynet"
  },
  get isMainnet() {
    return this.lightningNetwork === "mainnet"
  },
}
```

**Behavior by network:**

| Network | Invoice | Payment Confirm | Use Case |
|---------|---------|-----------------|----------|
| `mock` | Fake bolt11 | Auto after 2s | Local dev, unit tests |
| `mutinynet` | Real (signet) | Real zap receipt | Integration tests, preview |
| `mainnet` | Real | Real zap receipt | Production |

---

## Feature-Based Implementation

### Legend
- 🔐 = Auth Required
- 📍 = Where it lives
- 🔗 = Dependencies

---

## Phase 1: Foundation ✅ (Done)

### F1: Monorepo Structure
📍 Root
- Bun workspaces configuration
- Root tsconfig with path aliases
- AGENTS.md, CLAUDE.md context files
- .gitignore (node_modules, dist, context/, .env)

### F2: Core Package Scaffold
📍 packages/core
- types/ - TypeScript interfaces
- protocol/ - NDK service, event kinds
- schemas/ - Zod validators
- utils/ - formatPrice, formatPubkey, cn()

### F3: UI Package Scaffold
📍 packages/ui
- components/ - Base structure
- styles/ - Tailwind config, theme tokens
- hooks/ - Shared React hooks

### F4: App Scaffolds
📍 apps/*
- Vite + TanStack Router for each app
- Basic root route and layout

---

## Phase 2: Shared Infrastructure (Goal: 2/12)

### F5: Design System
📍 packages/ui
🔗 None

**Components:**
- Button (primary, secondary, outline, ghost, destructive)
- Card, CardHeader, CardContent, CardFooter
- Input, Label, Textarea, Select
- Dialog, Sheet (drawer), AlertDialog
- Avatar, Badge, Skeleton
- Table, Tabs, Tooltip
- Container, Stack, Grid layouts

**Theming:**
- HSL color tokens (Purple primary, Orange secondary)
- Typography scale
- Spacing, radius, shadows

### F6: NDK Integration
📍 packages/core/protocol
🔗 F2

**Core:**
- NDK singleton with lazy initialization
- Default relay list (relay.damus.io, nos.lol, relay.conduit.market)
- Connection state management (connecting, connected, error)
- Reconnection with exponential backoff

**Event Kinds:**
- Kind 0: Profile metadata
- Kind 4/44: Encrypted DMs (NIP-17)
- Kind 5: Deletion
- Kind 9734/9735: Zaps
- Kind 30402: Products

**Multi-Relay Strategy:**
- Write to multiple relays
- Require N acknowledgements before success
- Track relay health (success/failure rates)

### F7: External Signer Auth
📍 packages/core/protocol + context
🔗 F6

**MVP: NIP-07 (Browser Extension)**
- Detect window.nostr
- Request pubkey
- Sign events
- Encrypt/decrypt (NIP-04, NIP-44)

**Deferred (Post-MVP): NIP-46 (Remote Signer)**
- Do not implement in Phase 2.
- Implement alongside Coordinator hardening in Phase 6 (see F27).
- Keep the AuthContext surface area compatible with adding NIP-46 later.

**AuthContext:**
- pubkey state
- connect(), disconnect() (NIP-07 only in MVP)
- isConnecting, isConnected, error states
- Persist connection preference (localStorage)

### F8: Query Hooks
📍 packages/core/hooks
🔗 F6, F7

**Product Hooks:**
- `useProducts(filters?)` - Paginated product list
- `useProduct(eventId)` - Single product detail
- `useProductsByMerchant(pubkey)` - Merchant's products

**Profile Hooks:**
- `useProfile(pubkey)` - Any user's profile
- `useMyProfile()` - Current user's profile
- `useUpdateProfile()` - Publish Kind 0 mutation

**Order Hooks:**
- `useOrders(pubkey)` - User's order history
- `useOrder(orderId)` - Single order
- `useMerchantOrders(pubkey)` - Orders for merchant

**Message Hooks:**
- `useConversations()` - DM thread list
- `useMessages(counterpartyPubkey)` - Thread messages
- `useSendMessage()` - NIP-17 DM mutation

### F9: Billing Stubs (MVP Prep)
📍 packages/core/billing
🔗 F6

**Purpose:** Prepare infrastructure for monetization without enabling billing.

**Entitlement Stub:**
```typescript
// packages/core/src/billing/entitlements.ts
export function getEntitlements(pubkey: string): UserEntitlements {
  // MVP: Always return full access
  return {
    pubkey,
    tier: "pro_hustle",  // Everyone gets full access in MVP
    creditBalance: 0,
    features: {
      adFree: true,
      automatedOrders: true,
      aiMessaging: true,
      premiumAnalytics: true,
      priorityRelay: true,
    },
  }
}
```

**Usage Tracking (no billing):**
- Track feature usage events (for analytics only)
- Track potential credit-consuming actions
- Data informs future pricing decisions

**UI Placeholder:**
- Credit balance shows 0
- "Upgrade" buttons visible but disabled or hidden
- Tier badge shows "Free" (even though all features enabled)

### F10: Local Database (Dexie)
📍 packages/core/db
🔗 F6

**Dexie Schema:**
```typescript
// packages/core/src/db/schema.ts
import Dexie from "dexie"

class ConduitDB extends Dexie {
  orders!: Table<StoredOrder>
  messages!: Table<StoredMessage>
  products!: Table<CachedProduct>
  profiles!: Table<CachedProfile>

  constructor() {
    super("conduit")
    this.version(1).stores({
      orders: "orderId, status, merchantPubkey, createdAt",
      messages: "id, conversationId, createdAt",
      products: "eventId, merchantPubkey, updatedAt",
      profiles: "pubkey, updatedAt",
    })
  }
}
```

**Adapters (from legacy pattern):**
- `ordersAdapter` - CRUD for orders
- `messagesAdapter` - CRUD for DM cache
- `eventsAdapter` - Generic event cache

**Query Integration:**
- Seed TanStack Query from Dexie on mount
- Background sync from relays
- Write-through cache on mutations

---

## Phase 3: Market App (Goal: 2/26)

### F11: App Shell & Layout
📍 apps/market
🔗 F5, F7

**Root Layout:**
- Header with logo, nav, auth button, cart icon
- Footer with links
- Main content area with max-width container

**Responsive:**
- Mobile hamburger menu
- Desktop horizontal nav
- Sticky header on scroll

**Auth Integration:**
- Connect wallet button
- Show pubkey/avatar when connected
- Disconnect option

### F12: Product Discovery (No Auth)
📍 apps/market/routes
🔗 F5, F8

**Home Page (/):**
- Hero section
- Featured products grid
- Category links
- Skeleton loading states

**Products Page (/products):**
- Product grid with filters
- Category filter
- Price range filter
- Sort (newest, price low/high)
- URL search params for shareable filters
- Infinite scroll or pagination
- Empty state

**Product Card:**
- Image (with Blossom fallback)
- Title, price (sats)
- Merchant name/avatar
- Quick add to cart

### F13: Product Detail (No Auth)
📍 apps/market/routes/products
🔗 F5, F8, F11

**Product Page (/products/$productId):**
- Image gallery with thumbnails
- Title, description (markdown)
- Price in sats (with USD estimate)
- Merchant info with link to store
- Add to cart with quantity
- Share button
- Related products

**Merchant Link:**
- Click to view merchant's store page

### F14: Cart System (No Auth for Cart, Auth for Checkout)
📍 apps/market
🔗 F5, F11

**Cart Storage (localStorage):**
- CartItem: { productId, quantity, addedAt }
- Persist across sessions
- Clear on checkout complete

**Cart Hooks:**
- `useCart()` - Current cart items
- `useAddToCart()` - Add/update quantity
- `useRemoveFromCart()` - Remove item
- `useClearCart()` - Empty cart

**Cart Drawer (Sheet):**
- Slide out from right
- List cart items with quantity adjust
- Subtotal calculation
- Remove item
- Proceed to checkout (requires auth)

**Cart Page (/cart):**
- Full page cart view
- Same functionality as drawer
- Better for mobile

**Cart Badge:**
- Item count in header

### F15: Checkout & Payment 🔐
📍 apps/market/routes
🔗 F7, F8, F13

**Checkout Page (/checkout) - Auth Required:**
- Cart summary
- Shipping info form (name, address)
- Payment section

**Order Creation:**
- Generate order from cart
- Send order DM to merchant (NIP-17)
- Baseline MVP: buyer waits for merchant to send invoice manually

**Payment Flow (Baseline MVP - Manual):**
- Receive invoice via NIP-17 DM from merchant
- Display Lightning invoice (QR + copy)
- Invoice expiration timer
- Poll for payment confirmation OR receive status update DM
- No auto-invoice - merchant generates manually in Portal

**Order Confirmation:**
- Success state with order details
- Clear cart
- Link to order history

> **Note:** See ARCHITECTURE.md "Payment Flow" for MVP vs Coordinator comparison.
> Automated payments (auto-invoice, auto-confirm) are Phase 6 (Coordinator).

**Milestone (Optional): One-way checkout**
- Requires merchant-published payment handles (Phase 4 Settings).
- Add behind a feature flag until Portal v1 is complete.
- UX: buyer pays directly, then sends `PaymentProof` via NIP-17.

### F16: Order History 🔐
📍 apps/market/routes/orders
🔗 F7, F8, F14

**Orders Page (/orders):**
- List of user's orders
- Status badge (pending, paid, shipped, complete)
- Date, merchant, total

**Order Detail (/orders/$orderId):**
- Order items with quantities
- Shipping address
- Status timeline (pending → paid → shipped → delivered)
- Tracking info (if provided)
- Message merchant button

### F17: Messaging 🔐
📍 apps/market/routes
🔗 F7, F8

**Messages Page (/messages):**
- Conversation list (grouped by counterparty)
- Unread indicators
- Last message preview

**Message Thread:**
- Full conversation history
- Order cards inline (linked orders)
- Compose input
- Send button
- Delivery status (sent, acknowledged, pending)

**NIP-17 Integration:**
- Encrypt outgoing messages
- Decrypt incoming messages
- Handle decryption failures gracefully

### F18: Merchant Store Page (No Auth)
📍 apps/market/routes/store
🔗 F5, F8, F11

**Store Page (/store/$pubkey):**
- Merchant banner/avatar
- Bio, NIP-05 verification
- Products grid (merchant's products only)
- Contact button (opens DM, requires auth)

### F19: User Profile 🔐
📍 apps/market/routes
🔗 F7, F8

**Profile Page (/profile):**
- View own profile
- Edit mode
  - Name, bio, avatar URL
  - NIP-05 identifier
- Publish profile (Kind 0)
- Relay list management

---

## Phase 4: Merchant Portal (Goal: 3/12)

### F20: Portal Shell & Auth
📍 apps/merchant
🔗 F5, F7

**Auth Guard:**
- All routes require authentication
- Redirect to /login if not authed

**Login Page (/login):**
- NIP-07 connect button
- Signer detection with helpful messages
> NIP-46 is post-MVP (Phase 6).

**Sidebar Layout:**
- Dashboard, Products, Orders, Messages, Settings
- Collapse on mobile
- Active state indicators

### F21: Dashboard
📍 apps/merchant/routes
🔗 F5, F8, F19

**Dashboard Page (/):**
- Stats cards (total products, pending orders, revenue)
- Recent orders table
- Quick actions (add product, view orders)
- System health indicators (relay connected, wallet connected)

### F22: Product Management 🔐
📍 apps/merchant/routes/products
🔗 F7, F8, F19

**Products List (/products):**
- Table view with columns: image, title, price, status, actions
- Status filter (active, draft, archived)
- Sort by date, price, title
- Search by title

**Create Product (/products/new):**
- Form: title, description (markdown), price, images
- Image upload to Blossom/nostr.build
- Preview before publish
- Publish as Kind 30402 event

**Edit Product (/products/$productId):**
- Same form, pre-filled
- Update publishes new event (replaceable)
- Archive option (soft delete)

**Delete Product:**
- Confirmation dialog
- Publish Kind 5 deletion event

### F23: Order Management 🔐
📍 apps/merchant/routes/orders
🔗 F7, F8, F19

**Orders List (/orders):**
- Table: date, buyer, items, total, status, actions
- Filter by status (pending, paid, shipped, complete, cancelled)
- Date range filter
- Buyer search

**Order Detail (/orders/$orderId):**
- Order items with product details
- Buyer info (pubkey, profile if available)
- Shipping address
- Order timeline
- Actions: generate invoice, mark paid, mark shipped, cancel

**MVP Payment Actions (Manual):**
- **Generate Invoice** - Merchant clicks to create NWC invoice for order amount
- **Send Invoice** - Send invoice to buyer via NIP-17 DM
- **Mark Paid** - Merchant manually confirms payment received
- ⚠️ MVP: Merchant must be online to process orders
- ⚠️ Post-MVP: Coordinator automates all of this (Phase 6)

**Milestone (Optional): One-way checkout support**
- Display incoming `PaymentProof` payloads on the order detail view.
- Add actions: "Mark paid (verified)" and "Reject proof" (with a DM template back to buyer).
- Merchant verification remains independent/manual in MVP.

**Order State Machine:**
- pending → invoiced (invoice sent to buyer)
- invoiced → paid (payment confirmed)
- paid → shipped (merchant marks shipped)
- shipped → complete (buyer confirms or timeout)
- any → cancelled

**Fulfillment:**
- Add tracking number
- Carrier selection
- Generate shipping label (future: ShipStation integration)
- Partial shipment support

### F24: Merchant Messaging 🔐
📍 apps/merchant/routes
🔗 F7, F8, F19

**Inbox (/messages):**
- Conversation list with buyers
- Unread count
- Filter by order status (awaiting payment, awaiting shipment)

**Message View:**
- Thread with buyer
- Order cards inline
- Quick reply templates
  - "Order received, invoice sent"
  - "Shipped! Tracking: ..."
  - "Sorry for delay, expected..."

**Compose:**
- Rich text or markdown
- Attach images via Blossom (optional)

### F25: Settings 🔐
📍 apps/merchant/routes
🔗 F7, F8, F19

**Profile Settings (/settings):**
- Store name, bio, avatar
- NIP-05 verification
- Banner image

**Relay Settings:**
- Add/remove relays
- Set primary relay
- Relay health status

**Wallet Settings:**
- Connect NWC wallet
- Connection status
- Test invoice generation

**Payment Settings (for One-way Checkout milestone):**
- Lightning Address / LNURL-pay handle (public)
- Stablecoin address + accepted token(s) + memo convention (public, optional)
- Hosted checkout URL (public, optional)
- Accepted methods + default currency (public)

---

## Phase 4.5: GitHub Migration (Pre-Team Onboarding)

Migrate from GitLab to GitHub before onboarding contributors. Do this after MVP merge and before hi-fi UI work.

**Why now:**
- Don't onboard people to a platform you're leaving
- CI pipeline is simple — easier to port now than after more complexity
- Nostr ecosystem lives on GitHub (NDK, nostr-tools, market-spec)
- GitHub Projects/Issues better for delegation and scoped access

### Org & Repo Setup
- [ ] Create `conduit-btc` org on GitHub
- [ ] Push mirror of `conduit-mono` to GitHub
- [ ] Set `main` branch protection: require PR reviews, no direct push
- [ ] Configure contributor access (Write role, no admin)

### CI/CD Migration
- [ ] Port `.gitlab-ci.yml` to GitHub Actions workflow
  - Typecheck, lint, build (same matrix)
  - Cloudflare Pages deploy (signet + mainnet previews per PR)
  - Preview links posted as PR comment
- [ ] Port Codex MR review to GitHub PR review (webhook or Action)
- [ ] Verify preview deploys work from GitHub Actions

### Project Management
- [ ] Set up GitHub Projects board (Kanban: Backlog, In Progress, Review, Done)
- [ ] Migrate open GitLab issues to GitHub Issues (if any)
- [ ] Create issue templates: bug report, feature request, task
- [ ] Create PR template with test plan checklist

### Cleanup
- [ ] Update all docs referencing GitLab URLs
- [ ] Update CLAUDE.md git remote references
- [ ] Archive GitLab repo (read-only) with pointer to GitHub
- [ ] Update Cloudflare Pages deploy hooks if needed

### New Repo Scaffolding (as needed)
- [ ] `conduit-relay` — when Phase 5 starts
- [ ] `conduit-coordinator` — when Phase 6 starts
- [ ] Same branch protection and access patterns as conduit-mono

---

## Phase 5: Relay (Post-MVP)

### F26: Commerce Relay
📍 infrastructure/relay
🔗 None

**Base Setup:**
- strfry or nostr-rs-relay
- Docker containerization
- PostgreSQL storage

**Commerce Optimization:**
- Indexes for Kind 30402 (products)
- Indexes for Kind 4/44 (DMs)
- Query optimization for marketplace patterns

**Rate Limiting:**
- Per-pubkey limits
- Event size limits (64KB max)

**Policies:**
- Retention by kind (products indefinite, DMs 90 days)
- Deletion event handling

**Operations:**
- NIP-11 relay info endpoint
- Health check endpoint
- Prometheus metrics

**Deployment:**
- Fly.io or Railway
- relay.conduit.market domain
- Auto TLS via Caddy

---

## Phase 6: Coordinator (Post-MVP)

### F27: Commerce Coordinator
📍 infrastructure/coordinator
🔗 F25

**Event Listener:**
- Subscribe to zap receipts (9735)
- Subscribe to product updates (30402)
- Filter for registered merchants

**Order Processing:**
- Validate zap amount vs product price
- Match zap to order
- Update order state

**Automated Actions:**
- Send order confirmation DM
- Update inventory count
- Publish updated product event

**Merchant Integration:**
- NIP-46 remote signer connection (post-MVP)
- Per-merchant configuration
- Multi-tenant support

**State Management:**
- PostgreSQL for order state
- Idempotent processing
- Deduplication by event ID

**Operations:**
- Health checks
- Error alerting
- Order processing metrics

---

## Phase 7: Store Builder (Post-MVP)

### F28: Store Creation
📍 apps/store-builder
🔗 F5, F8

**Creation Wizard:**
- Connect merchant identity
- Choose template
- Import products
- Customize branding

**AI Generation:**
- LLM-powered layout suggestions
- Auto-generate store description
- Product arrangement optimization

**Templates:**
- Minimal (clean, focused)
- Catalog (grid-heavy)
- Featured (hero products)

### F29: Store Customization
📍 apps/store-builder
🔗 F27

**Branding:**
- Colors (primary, secondary, background)
- Logo upload
- Font selection

**Layout:**
- Hero section toggle
- Product grid columns
- Navigation style

**Preview:**
- Live preview while editing
- Mobile/desktop toggle

### F30: Store Publishing
📍 apps/store-builder + infrastructure/store-deploy
🔗 F28, F29

See `docs/specs/store-builder.md` for full Cloudflare integration details.

**Deployment Service (Cloudflare Worker):**
- Receives deploy requests from Store Builder app
- Generates static React app from template + config
- Creates/updates Cloudflare Pages project via API
- Configures subdomain DNS records
- Returns deployment status and URL

**Cloudflare Pages Integration:**
- Project naming: `conduit-store-{store-id}`
- Automatic SSL provisioning
- CDN edge caching
- Environment variable injection

**Subdomain Setup (`{store}.conduit.market`):**
- CNAME record: `{store}` → `conduit-store-{id}.pages.dev`
- Custom domain added to Pages project
- Automatic SSL via Cloudflare

**Custom Domain Setup (Premium):**
- Merchant provides domain in UI
- Display DNS instructions (CNAME + TXT verification)
- Poll for verification status
- Auto-provision SSL once verified

**Store Lifecycle:**
- Create → Deploy → Live
- Update → Redeploy (keeps previous for rollback)
- Pause → Maintenance page
- Delete → 7-day grace period → Remove project

**Self-Host Export:**
- Download zip with built static assets
- README with hosting instructions
- Environment variable template

**Product Sync:**
- Pull from merchant's Kind 30402 events
- Rebuild triggered by webhook or manual republish
- Auto-update on product changes (future: realtime via relay)

---

## Phase 8: Monetization (Post-MVP)

See [monetization.md](../specs/monetization.md) for business model and [billing.md](../specs/billing.md) for infrastructure.

### F31: Billing Infrastructure
📍 infrastructure/billing-api + Supabase
🔗 F7

**Supabase Schema:**
- `memberships` - Tier, credit balance, subscription dates
- `credit_transactions` - Audit log of all credit activity
- `subscription_invoices` - Lightning invoices for subscriptions
- `stores` - Store Builder billing (linked from store-builder.md)
- `usage_summary` - Aggregated usage for volume discounts

**Edge Entitlement API (Cloudflare Worker):**
- `GET /api/billing/entitlements` - Fast entitlement checks
- Cloudflare KV cache (5 min TTL)
- Falls back to Supabase on cache miss

**Entitlement Response:**
```typescript
interface EntitlementResponse {
  pubkey: string
  tier: "free" | "side_hustle" | "pro_hustle" | "enterprise"
  creditBalance: number
  features: {
    adFree: boolean
    automatedOrders: boolean
    aiMessaging: boolean
    premiumAnalytics: boolean
    priorityRelay: boolean
  }
  subscription: {
    active: boolean
    expiresAt: string | null
  }
}
```

**MVP Prep (in earlier phases):**
- Stub entitlement service (always returns full access)
- Track usage metrics via PostHog (for pricing decisions)
- Credit balance UI placeholder (shows 0, non-functional)

### F32: Credit System
📍 packages/core/billing + Supabase functions
🔗 F31

See [billing.md](../specs/billing.md) for full schema and functions.

**Credit Operations (Supabase RPC):**
- `spend_credits()` - Atomic deduct with balance check
- `add_credits()` - Top-up, bonus, subscription allotment

**API Endpoints:**
- `GET /api/billing/credits` - Balance + recent transactions
- `POST /api/billing/credits/topup` - Generate Lightning invoice

**Services That Consume Credits:**
| Service | Base Cost | Description |
|---------|-----------|-------------|
| `automated_order` | ~100 sats | Payment confirm, inventory, notify |
| `ai_message` | ~10 sats | Auto-respond to inquiry |
| `analytics_query` | ~50 sats | Custom report/forecast |
| `ai_generation` | ~500 sats | Store layout, descriptions |
| `notification` | ~5 sats | SMS/email fallback |

**Volume Discounts:**
- 100+ actions/month: 20% off
- 500+ actions/month: 40% off
- 1000+ actions/month: 50% off
- Pro tier: additional 20% off all rates

### F33: Membership Management
📍 apps/market, apps/merchant
🔗 F31, F32

**Subscription UI:**
- View current tier
- Upgrade/downgrade options
- Credit balance display
- Top-up via Lightning

**Payment Processing:**
- Lightning payment for subscriptions
- Fiat-to-sats conversion (future)
- Monthly renewal handling

**Shopper Benefits (Side Hustle/Pro Hustle):**
- Ad-free browsing
- Personalized discovery (pinned categories, saved searches)
- NIP-05 identifier (`alice@conduit.market`)
- Monthly sats credits
- Priority relay access

**Merchant Benefits (Side Hustle/Pro Hustle):**
- Monthly credits
- Automated order handling
- AI messaging (limited/full)
- Enhanced/premium analytics
- Lower credit costs (Pro)

### F34: Store Hosting
📍 apps/store-builder
🔗 F30

**Managed Hosting (Blossom-Backed):**
- Subdomain: `mystore.conduit.market` ($12/mo)
- Custom domain: Your domain + DNS management ($21/mo)
- SSL, CDN included
- Privacy-preserving (no tracking injected)

**Self-Host Option:**
- Merchants can publish to own Nostr relays
- No hosting fee for self-hosted

### F35: Sponsored Placements
📍 apps/market, apps/merchant
🔗 F31

**Placement Types:**
- Sponsored Products (top of search)
- Category Sponsor (featured in category)
- Homepage Featured (rotating banner)
- Curated Page Sponsor (on curator collections)

**Campaign Management (Merchant Portal):**
- Self-serve campaign creation
- Budget setting (in sats)
- Auction-based bidding
- Performance metrics

**Display Rules:**
- All sponsored content clearly labeled
- Organic discovery not overshadowed
- Premium members can hide ads

### F36: Curator Revenue Share
📍 apps/store-builder
🔗 F35

**Curated Markets:**
- Curators create themed "micro-markets"
- Select products across merchants
- AI generates polished storefront

**Revenue Model:**
- Merchants pay for sponsored placements on curated pages
- Curator receives percentage of ad spend
- No tracking individual sales (simpler than affiliate)

---

## Auth Requirements Summary

| Feature | Auth | Storage |
|---------|------|---------|
| Browse products | No | - |
| Product detail | No | - |
| Merchant store | No | - |
| Add to cart | No | localStorage |
| Checkout | **Yes** | Relay (DM) |
| Orders | **Yes** | Relay |
| Messages | **Yes** | Relay (NIP-17) |
| Profile | **Yes** | Relay (Kind 0) |
| Merchant Portal | **Yes** | All |

---

## Missing from Initial Plan (Added)

From context doc analysis, these were missing:

1. **Blossom Media** - Image hosting for products/avatars
2. **Multi-relay writes** - Write to N relays, verify acks
3. **IndexedDB caching** - Offline support, performance
4. **Skeleton loading** - Everywhere data loads
5. **Optimistic UI** - Instant feedback, rollback on error
6. **Order state machine** - Full lifecycle
7. **DM threading** - Orders inline in conversations
8. **Relay health indicators** - UI feedback
9. **Wallet status** - Connected/disconnected
10. **Message delivery status** - Sent, ack, pending
11. **Invoice expiration** - Timer, retry
12. **Quick reply templates** - Merchant efficiency

### Hardening Notes

- GitLab Duo followups from MR `!5`: see `docs/knowledge/followups-duo-mr5.md`
- GitLab Duo followups from MR `!10` (merchant product CRUD):
  - Add explicit d-tag format validation for product creation
  - Add conflict handling for concurrent edits (last-write-wins warning or optimistic lock)
  - Add CRUD edge-case tests (dedupe freshness, malformed events, delete semantics)
  - Revisit polling strategy for production-scale relay usage
- Automated testing plan/spec: see `docs/specs/testing-e2e.md`

---

## Reference Repos (Visual Only)

| Repo | Path | Use For |
|------|------|---------|
| conduit-market-client | `/Users/dylangolow/workspace/CONDUIT/conduit-market-client` | UI patterns, component design |
| merchant-portal | `/Users/dylangolow/workspace/CONDUIT/merchant-portal` | Dashboard layout, UX flows |

**Do NOT copy code. Reference for design/UX only.**

---

## Verification Milestones

### Infrastructure (Goal: 2/12)
- [x] shadcn components render correctly
- [x] NDK connects to relays
- [x] NIP-07 auth works
- [x] Query hooks fetch real products
- [x] Dexie database works

### Market (Goal: 2/26)
- [x] Products display from relays
- [x] Product search, sort, and tag filtering
- [x] Cart works (localStorage)
- [x] Checkout creates order (NIP-17 order DM)
- [x] Shipping address form with optional toggle
- [x] Messages page — two-column inbox with order conversations
- [x] Invoice display with QR code, copy-to-clipboard, "Open in wallet" link
- [x] NIP-04 fallback for gift unwrap (nip44 → nip04)
- [x] MarketHeader with logo, nav, mobile Sheet menu
- [x] Payment flow completes (buyer pays invoice end-to-end)
- [x] Profile management (Kind 0)

### Merchant (Goal: 3/12)
- [x] Product CRUD works
- [x] Orders inbox — two-column DM workspace with conversation threading
- [x] Invoice generation — WebLN (Alby) primary, NWC fallback, manual BOLT11 paste
- [x] Status updates via DM (invoiced, paid, processing, shipped, complete, cancelled)
- [x] Shipping updates via DM (carrier, tracking number, tracking URL)
- [x] NWC wallet connection with onboarding guide
- [x] MerchantHeader with logo, nav, mobile Sheet menu
- [x] Shipping info captured and displayed on order cards
- [x] NIP-04 fallback for gift unwrap
- [x] Success flash notifications on all merchant actions
- [x] Profile management (Kind 0)

### MVP (Goal: 3/12)
- [x] CI pipeline: lint → typecheck → test → build → deploy → review
- [x] Cloudflare Pages preview deploys per branch via wrangler
- [x] Codex MR reviews with inline diff comments
- [x] NDK relay connection resilience (10s timeout, auto-retry with fresh instance)
- [ ] Market deployed to shop.conduit.market
- [ ] Portal deployed to sell.conduit.market
- [x] End-to-end purchase works

### Automated Testing (Hardening Track)

Non-blocking for MVP merge velocity, but should be added immediately after core flow stabilization.

- [ ] Add deterministic local relay smoke suite (`docs/specs/testing-e2e.md`)
- [x] Add merchant product CRUD automated smoke coverage (`tests/merchant-products-crud.relay.test.ts`)
- [ ] Add market checkout -> merchant inbox automated smoke coverage
- [ ] Add CI smoke execution for local relay-based E2E

### Design Polish (Post E2E Loop)

These items should come after the end-to-end loop is working, so we can iterate on visuals without destabilizing the core flows.

- [ ] Extract tokens (color/typography/spacing) from Figma into `packages/ui`
- [ ] Bring Market pages in line with Figma (layout, typography, components)
- [ ] Bring Merchant pages in line with Figma (layout, typography, components)
- [x] Market header + nav parity (MarketHeader component with logo, nav, mobile menu)
- [x] Merchant header + nav parity (MerchantHeader component matching market layout)
- [ ] Market products grid/detail parity (`apps/market/src/routes/products/index.tsx`, `apps/market/src/routes/products/$productId.tsx`)
- [ ] Market cart/checkout parity (`apps/market/src/routes/cart.tsx`, `apps/market/src/routes/checkout.tsx`)
- [ ] Merchant orders/products visual polish

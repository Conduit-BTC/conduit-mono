# Conduit Monorepo

## Project Overview

Conduit is a decentralized commerce platform built on Nostr protocol. This monorepo contains three applications sharing common infrastructure:

- **Market** (`apps/market`) - Buyer-facing marketplace for product discovery and purchase
- **Merchant Portal** (`apps/merchant`) - Seller dashboard for product management, orders, and communications
- **Store Builder** (`apps/store-builder`) - Tool for creating standalone merchant storefronts

## Architecture

### Monorepo Structure

```
conduit-mono/
├── apps/
│   ├── market/           # Buyer marketplace
│   ├── merchant/         # Seller dashboard
│   └── store-builder/    # Storefront generator
├── packages/
│   ├── core/             # Types, protocol, schemas, utilities
│   └── ui/               # Shared React components
├── docs/
│   ├── plans/            # ROADMAP.md, IMPLEMENTATION.md
│   └── specs/            # Feature specifications
└── context/              # Ephemeral files (gitignored)
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Build | Vite 6 + SWC |
| Framework | React 19 |
| Routing | TanStack Router (file-based, type-safe) |
| Server State | TanStack Query + NDK |
| Client State | React Context (auth only) |
| Persistence | localStorage (cart, preferences) |
| Database | Dexie (IndexedDB) for orders, messages, cache |
| UI | shadcn/ui + Tailwind CSS |
| Forms | react-hook-form + Zod |
| Validation | Zod schemas in `@conduit/core` |
| Protocol | Nostr via NDK |
| Analytics | Plausible (traffic) + PostHog (events/errors) |

**No Zustand. No Jotai. No state management library.**

### Nostr Protocol

Core event kinds used:
- **Kind 0** - User profile metadata
- **Kind 5** - Event deletion (NIP-09)
- **Kind 10002** - Relay list (NIP-65)
- **Kind 30402** - Product listings (NIP-99 + GammaMarkets `market-spec`)

Authentication: External signers only (NIP-07, NIP-46). No key custody.
Messaging: NIP-17 encrypted DMs for buyer-merchant communication.
Payments: NWC-based Lightning payments (NIP-47).

## Session Workflow

1. **Start**: Read `AGENTS.md`, then:
   - `docs/ARCHITECTURE.md` - System diagrams, protocol, data flow
   - `docs/plans/ROADMAP.md` - Strategic epochs and direction
   - `docs/plans/IMPLEMENTATION.md` - Current build phases and deliverables

2. **Before building**: Read the relevant `docs/specs/*.md` for feature details

3. **End**: Update deliverable checkboxes in `docs/plans/IMPLEMENTATION.md` with user confirmation

## Protected Files

Do not modify without explicit confirmation:
- `docs/ARCHITECTURE.md` - System architecture and diagrams
- `docs/plans/IMPLEMENTATION.md` - Technical build guide
- `docs/specs/*.md` - Feature specifications

## Public Repo Posture

Treat `conduit-mono` as a future public client/shared-code repository.

When writing:
- commit messages
- PR titles
- PR descriptions
- tracked public-facing docs

avoid framing this repo around:
- internal company planning
- repo-scope assumptions that do not belong to `conduit-mono`

Keep public language focused on:
- Market
- Merchant
- Store Builder
- shared packages
- protocol/spec implementation
- trust, provenance, and open-source-safe engineering context

If discussing future repo boundaries, keep `conduit-services` clearly separate from the current `conduit-mono` scope unless the repo structure has actually changed.

Keep private company context out of tracked public history unless explicitly requested.

## Commands

```bash
# Development
bun install              # Install all dependencies
bun run dev              # Start all apps in parallel
bun run dev:market       # Start Market only
bun run dev:merchant     # Start Merchant Portal only
bun run dev:store-builder # Start Store Builder only

# Build
bun run build            # Build all packages then apps
bun run build:packages   # Build shared packages only

# Quality
bun run typecheck        # Type check all packages
bun run lint             # Lint all packages
bun test                 # Run tests

# Clean
bun run clean            # Remove all node_modules
```

## Code Style

- **TypeScript strict mode** - All code must pass strict type checking
- **Double quotes** for strings
- **2-space indentation**
- **async/await** over .then() chains
- **Explicit error handling** - No swallowed errors

### Import Order

1. External dependencies (react, zustand, etc)
2. @conduit/core imports
3. @conduit/ui imports
4. Relative imports (./components, ../utils)

### Component Structure (TanStack Router)

```
apps/market/src/
├── routes/              # TanStack Router file-based routes
│   ├── __root.tsx       # Root layout (header, footer)
│   ├── index.tsx        # Home page (/)
│   ├── products/
│   │   ├── index.tsx    # Product grid (/products)
│   │   └── $productId.tsx  # Product detail (/products/:id)
│   ├── cart.tsx         # Cart page
│   ├── checkout.tsx     # Checkout (auth required)
│   ├── orders/
│   │   ├── index.tsx    # Order history
│   │   └── $orderId.tsx # Order detail
│   ├── messages.tsx     # DM inbox
│   ├── store/
│   │   └── $pubkey.tsx  # Merchant storefront
│   └── profile.tsx      # User profile
├── components/          # Shared app components
├── hooks/               # App-specific hooks (useCart, etc)
├── lib/                 # Utilities, guards, query client
└── main.tsx             # App entry point
```

## Package Dependencies

Apps depend on packages, never the reverse:

```
apps/market     ─┬─> @conduit/core
                 └─> @conduit/ui
apps/merchant   ─┬─> @conduit/core
                 └─> @conduit/ui
packages/ui     ───> @conduit/core
packages/core   ───> (external only)
```

## Environment Variables

```bash
# .env.local (gitignored)
VITE_DEFAULT_RELAY_URL=wss://relay.conduit.market
VITE_BLOSSOM_SERVER_URL=https://blossom.conduit.market
```

## GitHub CI/CD

Pipeline stages: lint → typecheck → test → build → deploy

Protected branches: `main`
Pull request required for all changes.

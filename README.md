# Conduit

Decentralized commerce platform built on [Nostr](https://nostr.com). Merchants and buyers transact directly over the protocol — no platform custody of funds or user data.

**[conduit.market](https://conduit.market)**

Conduit code is MIT-licensed. Conduit trademarks, names, and logos are reserved. See [LICENSE](./LICENSE), [TRADEMARKS.md](./TRADEMARKS.md), and [OPEN_SOURCE.md](./OPEN_SOURCE.md).

---

## Apps

| App                                      | Port | Description                                                               |
| ---------------------------------------- | ---- | ------------------------------------------------------------------------- |
| **Market** (`apps/market`)               | 3000 | Buyer marketplace: browse products, cart, checkout, order tracking        |
| **Merchant Portal** (`apps/merchant`)    | 3001 | Seller dashboard: product CRUD, order management, invoicing, DM workspace |
| **Store Builder** (`apps/store-builder`) | 3002 | Standalone merchant storefronts (WIP)                                     |

## Shared Packages

| Package         | Description                                                                  |
| --------------- | ---------------------------------------------------------------------------- |
| `@conduit/core` | Types, protocol (NDK), schemas (Zod), React Query hooks, Dexie DB, utilities |
| `@conduit/ui`   | shadcn/ui components, design tokens, theme styles                            |

---

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- A Nostr signer browser extension ([Alby](https://getalby.com), [nos2x](https://github.com/nicely/nos2x), or similar NIP-07 extension)
- (Optional) [NWC](https://nwc.dev) wallet connection for Lightning invoicing

## Quick Start

```bash
# Clone and install
git clone https://github.com/Conduit-BTC/conduit-mono.git
cd conduit-mono
bun install

# Start all apps
bun run dev
```

This starts Market on http://localhost:3000, Merchant Portal on http://localhost:3001, and Store Builder on http://localhost:3002.

By default, dev mode uses **mock Lightning** (fake invoices) and points to a **local relay** on port 7777.

```bash
# Or start individually
bun run dev:market
bun run dev:merchant
bun run dev:store-builder
```

## Local Development Setup

### 1. Local Relay

A local relay keeps your dev environment isolated from public relays. Both modes expose `ws://127.0.0.1:7777`.

```bash
# Auto-selects Docker if available, otherwise uses a Bun WebSocket relay
bun run relay:local:start

# View logs
bun run relay:local:logs

# Stop
bun run relay:local:stop
```

Or use Docker/Bun explicitly:

```bash
# Docker (nostr-rs-relay)
bun run relay:local:start:docker

# Bun (lightweight, no Docker needed)
bun run relay:local:start:bun
```

### 2. Environment Variables

Each app reads `VITE_`-prefixed env vars via Vite. A root `.env.example` shows available options. For local dev, apps ship with `.env.local` files that point to the local relay in mock mode.

For shared network switching, Market and Merchant also support committed mode files:

- `.env.mock` for local/mock development
- `.env.mainnet` for public-relay/mainnet-style testing

Use the mode-specific scripts instead of hand-editing `.env.local`:

```bash
bun run dev:market:mock
bun run dev:merchant:mock
bun run dev:market:mainnet
bun run dev:merchant:mainnet
```

`.env.local` should remain for personal overrides only. Keep mode files minimal and let the shared core relay defaults handle the broader fallback strategy unless a mode truly needs different values.

| Variable                   | Default (dev)         | Description                                              |
| -------------------------- | --------------------- | -------------------------------------------------------- |
| `VITE_RELAY_URL`           | `ws://127.0.0.1:7777` | Default relay hint when no relay preference is available |
| `VITE_DEFAULT_RELAYS`      | `ws://127.0.0.1:7777` | General relay defaults                                   |
| `VITE_PUBLIC_RELAY_URLS`   | —                     | Public relays for broader Nostr reads and writes         |
| `VITE_COMMERCE_RELAY_URLS` | —                     | Commerce-compatible relays Conduit can prioritize        |
| `VITE_LIGHTNING_NETWORK`   | `mock`                | `mock`, `signet`, or `mainnet`                           |
| `VITE_BLOSSOM_SERVER_URL`  | —                     | Blossom media server for product images                  |

**Modes:**

- **mock** — Fake `lnbcrt` invoices, yellow badge in header. Use for local dev.
- **signet** — Real Lightning testnet, blue badge. Use for integration testing.
- **mainnet** — Production Lightning, no badge.

### 3. Seed Test Products

```bash
SEED_NSEC=<your-test-nsec> SEED_RELAY_URLS=ws://127.0.0.1:7777 bun run seed:products
```

Generate a throwaway nsec for seeding:

```bash
bun run seed:nsec
```

### 4. Test a Purchase Flow

1. Open **Market** (http://localhost:3000) — connect signer as buyer
2. Open **Merchant Portal** (http://localhost:3001) in a different browser profile — connect a different signer as merchant
3. **Merchant**: Products > New Product > publish
4. **Buyer**: Products > Add to Cart > Checkout > Place Order
5. **Merchant**: Orders > select order > Send Invoice (mock mode auto-generates)
6. **Buyer**: Orders > see invoice QR, status updates, shipping info

---

## Common Commands

```bash
bun run dev            # Start all apps
bun run build          # Build all (core -> ui -> apps)
bun run format:fix     # Format changed files
bun run format:check   # Check changed-file formatting
bun run typecheck      # TypeScript check all packages
bun run lint           # Lint all packages
bun test               # Run tests
bun run clean          # Remove all node_modules
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full PR checklist and CI recovery notes.

## Project Structure

```
conduit-mono/
├── apps/
│   ├── market/              # Buyer marketplace
│   ├── merchant/            # Seller portal
│   └── store-builder/       # Merchant storefronts (WIP)
├── packages/
│   ├── core/                # Types, protocol, schemas, hooks, DB, utils
│   └── ui/                  # Components, theme, styles
├── docs/
│   ├── README.md          # Docs index and source-of-truth guide
│   ├── ARCHITECTURE.md      # System diagrams and data flow
│   ├── DESIGN.md          # Shared design system and theming guidance
│   ├── plans/
│   │   ├── ROADMAP.md       # Strategic epochs
│   │   ├── IMPLEMENTATION.md # Current implementation index
│   │   └── PHASE_2_IMPLEMENTATION.md # Current post-MVP deliverables
│   ├── specs/               # Feature specifications
│   └── knowledge/           # Supporting notes and references
├── PLAN.md                  # Current planning index
└── scripts/                 # Dev tooling, CI helpers, seed data
```

## Tech Stack

| Layer         | Choice                                        |
| ------------- | --------------------------------------------- |
| Runtime       | Bun                                           |
| Build         | Vite 6 + SWC                                  |
| Framework     | React 19                                      |
| Routing       | TanStack Router (file-based, type-safe)       |
| Server State  | TanStack Query + NDK                          |
| Client State  | React Context (auth only)                     |
| Local Storage | Dexie (IndexedDB) for orders, messages, cache |
| Forms         | react-hook-form + Zod                         |
| UI            | shadcn/ui + Tailwind CSS                      |
| Protocol      | Nostr via NDK                                 |
| Payments      | Lightning via NWC (NIP-47)                    |
| Messaging     | NIP-17 gift-wrapped encrypted DMs             |

## Open Source

- Code and redistributable bundled assets in this repository are MIT-licensed.
- Conduit names, logos, and branded app identities are not granted under the MIT license.
- Forks are welcome, but they must not imply official Conduit operation or endorsement.
- Public client builds should remain rebuildable from the public repository without private production assets.

See [OPEN_SOURCE.md](./OPEN_SOURCE.md) for reproducible-build notes and [TRADEMARKS.md](./TRADEMARKS.md) for brand usage rules.

## Protocol

- **Authentication**: External signers only (NIP-07, NIP-46). No key generation or custody.
- **Products**: Kind 30402 replaceable events (NIP-99)
- **Orders**: NIP-17 gift-wrapped encrypted DMs between buyer and merchant
- **Payments**: NWC-based Lightning invoicing (NIP-47). No fund custody.
- **Profiles**: Kind 0 metadata events (NIP-01)

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for system diagrams and protocol details.

## Roadmap

See [PLAN.md](PLAN.md) for the current planning index, [ROADMAP.md](docs/plans/ROADMAP.md) for strategic epochs, and [IMPLEMENTATION.md](docs/plans/IMPLEMENTATION.md) for the current implementation index.

| Epoch         | Focus                                    | Target       |
| ------------- | ---------------------------------------- | ------------ |
| Genesis       | Architecture, infrastructure, wireframes | Feb 12, 2026 |
| Core Function | Market + Merchant Portal MVP             | Mar 12, 2026 |
| Added Value   | Social features, enhanced UX             | TBD          |
| Monetization  | Premium tiers, ads                       | TBD          |
| Scale         | Multi-language, enterprise               | TBD          |

## Docs

- [Documentation Index](docs/README.md)
- [Design Guidance](docs/DESIGN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Specs](docs/specs/)
- [Knowledge Notes](docs/knowledge/)

---

## Links

- [conduit.market](https://conduit.market)
- [Nostr profile](https://njump.me/nprofile1qqsfmys8030rttmk77cumprnsqqt0whmg0fqkz3xcx8798ag8rf8z3sad6jak)

## License

MIT for code and redistributable bundled assets in this repository.

Conduit trademarks and logos are reserved and are not licensed under MIT. See [TRADEMARKS.md](./TRADEMARKS.md).

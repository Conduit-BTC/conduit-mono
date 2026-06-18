# Conduit

Decentralized commerce platform built on [Nostr](https://nostr.com). Merchants and buyers transact directly over the protocol — no platform custody of funds or user data.

**[conduit.market](https://conduit.market)**

Conduit code is MIT-licensed. Conduit trademarks, names, and logos are reserved. See [LICENSE](./LICENSE), [TRADEMARKS.md](./TRADEMARKS.md), and [OPEN_SOURCE.md](./OPEN_SOURCE.md).

---

## Apps

| App                                      | Port | Description                                                              |
| ---------------------------------------- | ---- | ------------------------------------------------------------------------ |
| **Market** (`apps/market`)               | 3000 | Buyer marketplace: browse products, cart, checkout, order tracking       |
| **Merchant Portal** (`apps/merchant`)    | 3001 | Seller dashboard: product CRUD, order management, payments, DM workspace |
| **Store Builder** (`apps/store-builder`) | 3002 | Placeholder app shell                                                    |

## Shared Packages

| Package         | Description                                                                          |
| --------------- | ------------------------------------------------------------------------------------ |
| `@conduit/core` | Types, Nostr protocol helpers, schemas (Zod), React Query hooks, Dexie DB, utilities |
| `@conduit/ui`   | shadcn/ui components, design tokens, theme styles                                    |

---

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- A Nostr signer browser extension ([Alby](https://getalby.com), [nos2x](https://github.com/nicely/nos2x), or similar NIP-07 extension)
- (Optional) [NWC](https://nwc.dev) wallet connection for Lightning payment requests and proofs

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

The plain `dev` command uses each app's normal Vite environment resolution. Use the `:mock` scripts with the local relay when you want isolated fake Lightning invoices and local-only relay traffic.

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

Each app reads `VITE_`-prefixed env vars via Vite. A root `.env.example` shows available options. For isolated local dev, start the local relay and use the committed `mock` mode files.

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

| Variable                     | Default (dev)         | Description                                              |
| ---------------------------- | --------------------- | -------------------------------------------------------- |
| `VITE_RELAY_URL`             | —                     | Optional single relay hint also added to fallback relays |
| `VITE_DEFAULT_RELAY_URL`     | —                     | Optional single relay added to fallback relay discovery  |
| `VITE_DEFAULT_RELAYS`        | —                     | Optional comma-separated relays added to fallback reads  |
| `VITE_APP_WRITE_RELAY_URLS`  | —                     | Optional comma-separated app write relay additions       |
| `VITE_PUBLIC_RELAY_URLS`     | —                     | Optional comma-separated public relay override/additions |
| `VITE_COMMERCE_RELAY_URLS`   | —                     | Optional comma-separated commerce relay additions        |
| `VITE_LIGHTNING_NETWORK`     | `mainnet`             | `mainnet`, `signet`, `testnet`, or `mock`                |
| `VITE_BLOSSOM_SERVER_URL`    | —                     | Blossom media server for product images                  |
| `VITE_CACHE_API_URL`         | —                     | Optional cache/acceleration API endpoint                 |
| `VITE_NIP89_RELAY_HINT`      | `VITE_RELAY_URL`      | Relay hint for Conduit NIP-89 handler metadata           |
| `VITE_NIP89_MARKET_PUBKEY`   | —                     | Official Conduit Market handler pubkey                   |
| `VITE_NIP89_MERCHANT_PUBKEY` | —                     | Official Conduit Merchant Portal handler pubkey          |
| `VITE_APP_VERSION`           | app package version   | Build-time app version surfaced on About pages           |
| `VITE_BUILD_COMMIT`          | current git commit    | Commit SHA surfaced on About pages                       |
| `VITE_BUILD_BRANCH`          | current git branch    | Branch or preview ref surfaced on About pages            |
| `VITE_BUILD_TIME`            | current build time    | Build timestamp surfaced on About pages                  |
| `VITE_SOURCE_URL`            | GitHub repository URL | Source repository link surfaced on About pages           |
| `VITE_RELEASE_CHANNEL`       | local/preview/prod    | Release channel surfaced on About pages                  |

The canonical fallback/reset relay list is code-owned in `packages/core/src/config.ts` and currently starts from:

```text
wss://conduitl2.fly.dev
wss://relay.plebeian.market
wss://relay.primal.net
wss://relay.damus.io
wss://nos.lol
wss://nostr.mom
wss://relay.nostr.net
wss://relay.minibits.cash
```

Browser builds print a relay map in DevTools showing the code defaults, raw/normalized relay env vars, and the final resolved relay lists. Conduit-hosted deploys should leave relay env vars empty so reviewers can compare the open-source code defaults with the deployed behavior.

**Modes:**

- **mock** — Fake `lnbcrt` invoices, yellow badge in header. Use for local dev.
- **signet** / **testnet** — Real Lightning test networks. Use for integration testing.
- **mainnet** — Production Lightning, no badge.

### 3. Seed Test Products

```bash
SEED_NSEC=<your-test-nsec> SEED_RELAY_URLS=ws://127.0.0.1:7777 bun run seed:products
```

Generate a throwaway nsec for seeding:

```bash
bun run seed:nsec
```

### 4. Publish NIP-89 Handler Metadata

Conduit uses NIP-89 `kind:31990` handler metadata plus outbound `client` tags
for protocol-level app provenance. Market and Merchant also expose human-facing
About pages with build metadata, source links, and the matching NIP-89 app
identity.

Official client/source names are:

- Market: `Conduit Market`
- Merchant: `Conduit Merchant Portal`

Set the matching `VITE_NIP89_*_PUBKEY` values in deploy env before relying on
outbound client tags. The publish helper should be run with dedicated
Conduit-controlled app keys, never a user or merchant signer.

The app build injects version, commit, branch, build time, release channel, and
source URL from CI-friendly environment variables. Cloudflare Pages and GitHub
Actions variables are used when explicit `VITE_BUILD_*` overrides are absent.

Dry-run first:

```bash
NIP89_APP=market NIP89_NSEC=<market-nsec> NIP89_RELAY_URLS=wss://conduitl2.fly.dev bun run nip89:publish-handler -- --dry-run
NIP89_APP=merchant NIP89_NSEC=<merchant-nsec> NIP89_RELAY_URLS=wss://conduitl2.fly.dev bun run nip89:publish-handler -- --dry-run
```

Then publish without `--dry-run` and verify the resulting `31990` events on the
target relay(s): pubkey, `d`, `k`, `web`, and replaceable-event address.

### 5. Test a Purchase Flow

1. Open **Market** (http://localhost:3000) — connect signer as buyer
2. Open **Merchant Portal** (http://localhost:3001) in a different browser profile — connect a different signer as merchant
3. **Merchant**: Products > New Product > publish
4. **Buyer**: Products > Add to Cart > Checkout > Place Order
5. **Merchant**: Orders > send payment request or confirm payment state
6. **Buyer**: Orders > see payment request/proof state, status updates, shipping info

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
│   └── store-builder/       # Placeholder app shell
├── packages/
│   ├── core/                # Types, protocol, schemas, hooks, DB, utils
│   └── ui/                  # Components, theme, styles
├── docs/
│   ├── README.md            # Docs index and source-of-truth guide
│   ├── ARCHITECTURE.md      # System diagrams and data flow
│   ├── DESIGN.md            # Shared design system and theming guidance
│   ├── specs/               # Active feature specifications
│   └── knowledge/           # Supporting notes and references
└── scripts/                 # Dev tooling, CI helpers, seed data
```

## Tech Stack

| Layer         | Choice                                                             |
| ------------- | ------------------------------------------------------------------ |
| Runtime       | Bun                                                                |
| Build         | Vite 6 + SWC                                                       |
| Framework     | React 19                                                           |
| Routing       | TanStack Router (file-based, type-safe)                            |
| Server State  | TanStack Query over shared Nostr protocol helpers                  |
| Client State  | React Context (auth only)                                          |
| Local Storage | Dexie (IndexedDB) for orders, messages, cache                      |
| Forms         | react-hook-form + Zod                                              |
| UI            | shadcn/ui + Tailwind CSS                                           |
| Protocol      | Nostr via `@conduit/core` helpers; NDK is the current edge library |
| Payments      | Lightning via NWC (NIP-47), WebLN, invoices, and payment proofs    |
| Messaging     | NIP-17 gift-wrapped encrypted DMs                                  |

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
- **Payments**: Non-custodial Lightning payment requests, NWC/WebLN payment rails, and payment proofs. No fund custody.
- **Profiles**: Kind 0 metadata events (NIP-01)

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for system diagrams and protocol details.

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

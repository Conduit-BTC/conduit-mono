![Conduit Logo](https://user-content.gitlab-static.net/c61862c47d1f4ea3b9eaffaa7691290a910c1a83/68747470733a2f2f63646e2e70726f642e776562736974652d66696c65732e636f6d2f3637613038633466376231633566393961613665393230312f3637613166353164363165646235306333656130633138325f636f6e647569742532304c4f474f2e706e67)

![Build](https://img.shields.io/badge/build-passing-brightgreen) ![Bitcoin](https://img.shields.io/badge/bitcoin-⚡-orange) ![Nostr](https://img.shields.io/badge/nostr-connected-purple)

# ⚡ Conduit ⚡
**The open commerce conduit for Nostr De-Commerce**

> Sell anything, anywhere — no gatekeepers, no middlemen, just direct connection between Buyer and Seller on the Nostr network.

---

## 🚀 What's Here?

| Project | Description | Status |
|---------|-------------|--------|
| 🛒 **Market** | Buyer-facing marketplace | Active |
| 🧑‍💻 **Merchant Portal** | Manage products, orders, messaging | Active |
| 🏗️ **Store Builder** | AI-generated storefronts | Planned |
| 📡 **Relay** | Custom commerce relay | Planned |

## 📦 Packages

| Package | Description |
|---------|-------------|
| `@conduit/core` | Types, protocol utilities, Query hooks |
| `@conduit/ui` | Shared components, design tokens |

---

## 🛠️ Tech Stack

- **Runtime**: Bun
- **Build**: Vite 6 + SWC
- **Framework**: React 19
- **Routing**: TanStack Router
- **Data**: TanStack Query + NDK
- **UI**: shadcn/ui + Tailwind CSS

---

## 🏃 Getting Started

```bash
bun install
bun run dev:market      # localhost:3000
bun run dev:merchant    # localhost:3001
```

## Local Development (Recommended)

For reliable, deterministic testing (no relay noise/rate limits), run a local relay and seed sample products into it.

### 1) Start a Local Relay

Both modes expose a relay at `ws://127.0.0.1:7777`.

Docker mode (`nostr-rs-relay` image):
```bash
bun run relay:local:start:docker
bun run relay:local:logs:docker
bun run relay:local:stop:docker
```

Bun mode (built-in lightweight local relay):
```bash
bun run relay:local:start:bun
bun run relay:local:stop:bun
```

Default aliases:
```bash
bun run relay:local:start
bun run relay:local:logs
bun run relay:local:stop
```

`relay:local:start` auto-selects Docker when available, otherwise falls back to Bun mode.

### 2) Point the Apps at the Local Relay

Market:
```bash
echo 'VITE_DEFAULT_RELAY_URL=ws://127.0.0.1:7777' > apps/market/.env.local
```

Merchant:
```bash
echo 'VITE_DEFAULT_RELAY_URL=ws://127.0.0.1:7777' > apps/merchant/.env.local
```

### 3) Seed Sample Listings

```bash
SEED_NSEC=... SEED_RELAY_URLS=ws://127.0.0.1:7777 bun run seed:products
```

Then run:
```bash
bun run dev:market
bun run dev:merchant
```

Notes:
- Cloudflare Pages previews are served over `https://` and must use `wss://` relays (no `ws://` mixed-content).
- The seeding script is dev-only; keep the `nsec` out of apps and repos.

---

## 📋 Roadmap

See [ROADMAP.md](./docs/plans/ROADMAP.md) for full details.

| Phase | Goal |
|-------|------|
| Infrastructure | Feb 12 |
| Market | Feb 26 |
| Merchant | Mar 12 |
| MVP Launch | Mar 12 |

---

## 🔗 Links

- **🌐 [conduit.market](https://conduit.market)**
- **📂 [GitLab](https://gitlab.com/conduit-btc)**
- **💬 [Nostr](https://njump.me/nprofile1qqsfmys8030rttmk77cumprnsqqt0whmg0fqkz3xcx8798ag8rf8z3sad6jak)**

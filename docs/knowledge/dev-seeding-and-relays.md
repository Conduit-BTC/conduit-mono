# Dev Seeding + Relay Strategy (Local vs Preview)

This note describes how to seed sample products for Market UI development and what relay setup to use for local vs deployed preview testing.

## Why A Seeding Script Exists

Before Merchant Portal product CRUD is fully ready, the Market app needs real kind `30402` listings to exercise:
- product discovery (`/products`)
- product detail (`/products/:id`)
- add-to-cart behavior

We seed listings via a dev-only script that publishes spec-aligned `30402` events.

Script:
- `scripts/dev/seed_products.ts`

## How To Seed Products

This publishes a small set of sample kind `30402` listings to one or more relays.

To sanity-check that a relay has products before wiring it into previews, use:
```bash
CHECK_RELAY_URLS=wss://relay.damus.io bun run check:products
```

Environment variables:
- `SEED_NSEC` (required): a test `nsec...` used only for seeding (do not put this in apps)
- `SEED_RELAY_URLS` (optional): comma-separated relay URLs
  - If omitted, falls back to `VITE_DEFAULT_RELAY_URL`, else a public default.
- `SEED_COUNT` (optional): number of products to publish (default 6, max 50)

Run (public relay example):
```bash
SEED_NSEC=... \
SEED_RELAY_URLS=wss://relay.damus.io,wss://relay.primal.net \
bun run seed:products
```

Run (local relay example):
```bash
SEED_NSEC=... \
SEED_RELAY_URLS=ws://127.0.0.1:7777 \
bun run seed:products
```

Important:
- If your Market/Merchant app is served over `https://` (Cloudflare Pages previews), it must connect to relays over `wss://` (no `ws://` due to browser mixed-content rules).
- For local development with Vite (default `http://localhost`), `ws://127.0.0.1:<port>` is fine.

## Relay Choice: Local vs Public

### Local development (recommended for speed and determinism)

Use a local relay so:
- the product list is stable (no external spam/no rate limits)
- you can reset state easily
- you can test reliably offline

Then set:
- `VITE_DEFAULT_RELAY_URL=ws://127.0.0.1:<port>`

and seed into that relay.

If you have Docker running, you can use the built-in helper scripts:
```bash
bun run relay:local:start
bun run relay:local:logs
```

Stop it with:
```bash
bun run relay:local:stop
```

Local dev quick-start (Market app):
```bash
# 1) point Market at your local relay
echo 'VITE_DEFAULT_RELAY_URL=ws://127.0.0.1:7777' > apps/market/.env.local

# 2) seed listings
SEED_NSEC=... SEED_RELAY_URLS=ws://127.0.0.1:7777 bun run seed:products

# 3) run Market
bun run dev:market
```

### Preview deployments (Cloudflare Pages)

Preview deployments cannot access your local relay.

Use a public relay (or a dedicated staging relay) and seed to it.

Then set the Pages env var:
- `VITE_DEFAULT_RELAY_URL=wss://<public-relay>`

Notes:
- Prefer a dedicated staging relay if possible to avoid noise and ensure reliability.
- Use a dedicated “staging merchant” keypair for seeded listings.

Preview quick-start (Cloudflare Pages):
```bash
# 1) seed to a public relay using a dedicated staging nsec
SEED_NSEC=... SEED_RELAY_URLS=wss://relay.damus.io bun run seed:products

# 2) set Cloudflare Pages env var for the project:
# VITE_DEFAULT_RELAY_URL=wss://relay.damus.io
```

If you want to see only your seeded listings in the Market UI, use the merchant filter:
- Seed script prints `Publisher pubkey: <hex>`.
- Open: `/products?merchant=<hex>` to filter by that author.

## “Staging / Signet-like” Environments

Conduit’s near-term MVP uses Lightning (not on-chain), so “signet” is more of an analogy for “staging.”

If you want clean separation:
- Use a separate relay URL for staging
- Use a separate merchant pubkey for staging listings/orders
- Use a testnet Lightning wallet/NWC pairing for staging payments (later, when automating)

Do not block Market MVP on this; start with a public relay + dedicated staging key.

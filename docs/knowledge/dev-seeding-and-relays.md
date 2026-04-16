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

### Full relay stack (recommended)

The monorepo ships a three-tier relay stack matching the production architecture. All three relays run locally via Docker Compose:

Note: the Conduit L2 source is maintained in the sibling repository at `../conduitl2`.
The local compose stack builds the L2 service from that external path.

| Role         | Service        | Port                  | Technology    | Purpose                                                                                 |
| ------------ | -------------- | --------------------- | ------------- | --------------------------------------------------------------------------------------- |
| **L2**       | conduitl2      | `ws://127.0.0.1:3334` | Go / Khatru   | Commerce-aware queries (NIP-50 search DSL, price sorting, pagination)                   |
| **Merchant** | Haven          | `ws://127.0.0.1:3355` | Go / BadgerDB | Merchant source-of-truth (outbox `/`, chat `/chat`, inbox `/inbox`, private `/private`) |
| **Public**   | nostr-rs-relay | `ws://127.0.0.1:7777` | Rust          | Generic public relay (gossip, fallback reads)                                           |

Start the full stack:

```bash
bun run relay:stack:up      # Build images and start all 3 relays
bun run relay:stack:status   # Check status
bun run relay:stack:logs     # Tail all logs
```

Stop and manage:

```bash
bun run relay:stack:down     # Stop all relays (preserve data)
bun run relay:stack:reset    # Stop and delete all relay data volumes
```

Individual relay logs:

```bash
bun run relay:conduitl2:logs
bun run relay:haven:logs
```

### Haven publish policy in local dev

Haven outbox accepts product writes from:

- the configured relay owner pubkey, and
- any pubkeys listed in `relays/haven/whitelist_npubs.dev.json`.

If you publish with `nak` or another ad-hoc key, add its `npub` to that file first, then restart Haven:

```bash
# 1) generate a demo keypair
NSEC=$(nak key generate)
HEX=$(nak key public "$NSEC")
NPUB=$(nak encode npub "$HEX")

# 2) whitelist that npub for local Haven outbox writes
printf '["%s"]\n' "$NPUB" > relays/haven/whitelist_npubs.dev.json

# 3) restart Haven to reload env+whitelist
docker compose -f docker-compose.dev.yml up -d haven --force-recreate
```

Without whitelisting, Haven will reject publish attempts with:
`auth-required: you must be authenticated to post to this relay`.

Full stack quick-start (Market app):

```bash
# 1) start the relay stack
bun run relay:stack:up

# 2) configure relay role URLs
cat > apps/market/.env.local <<'EOF'
VITE_RELAY_URL=ws://127.0.0.1:7777
VITE_L2_RELAY_URLS=ws://127.0.0.1:3334
VITE_MERCHANT_RELAY_URLS=ws://127.0.0.1:3355
VITE_PUBLIC_RELAY_URLS=ws://127.0.0.1:7777
EOF

# 3) seed to all relays
SEED_NSEC=... SEED_RELAY_URLS=ws://127.0.0.1:3334,ws://127.0.0.1:3355,ws://127.0.0.1:7777 bun run seed:products

# 4) verify the stack
bun scripts/dev/relay_stack_verify.ts

# 5) run Market
bun run dev:market
```

The commerce read gateway (`packages/core/src/protocol/commerce.ts`) routes queries through the relay tiers automatically based on read plans defined per query type.

Note:

- Keep `VITE_RELAY_URL` pointed at a local relay during stack testing to avoid implicit fallback to external relays in generic NDK operations.
- Relay-role URLs are wired for source-aware reads and fallback planning; the direct L2 optimization path is currently demonstrated via `scripts/dev/relay_stack_verify.ts`.

### Quick `nak` PoC (push + pull like frontend flows)

```bash
# start relays
bun run relay:stack:up

# generate a demo key + whitelist for Haven
NSEC=$(nak key generate)
HEX=$(nak key public "$NSEC")
NPUB=$(nak encode npub "$HEX")
printf '["%s"]\n' "$NPUB" > relays/haven/whitelist_npubs.dev.json
docker compose -f docker-compose.dev.yml up -d haven --force-recreate

# publish one product to each relay
nak event -q --sec "$NSEC" -k 30402 -d poc-l2 -t title='PoC L2 Product' -t price='11;USD' ws://127.0.0.1:3334
nak event -q --sec "$NSEC" -k 30402 -d poc-merchant -t title='PoC Haven Product' -t price='22;USD' ws://127.0.0.1:3355/
nak event -q --sec "$NSEC" -k 30402 -d poc-public -t title='PoC Public Product' -t price='33;USD' ws://127.0.0.1:7777

# read from each relay
nak req -q -k 30402 -l 10 --search 'conduit-l2:q=;sort=price_asc' ws://127.0.0.1:3334
nak req -q -k 30402 -l 10 ws://127.0.0.1:3355/
nak req -q -k 30402 -l 10 ws://127.0.0.1:7777
```

### Single local relay (lightweight alternative)

If you only need a single generic relay (e.g., quick prototyping without L2 or merchant features), you can still use the single-relay setup:

```bash
bun run relay:local:start
bun run relay:local:logs
```

Stop it with:

```bash
bun run relay:local:stop
```

Single-relay quick-start (Market app):

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

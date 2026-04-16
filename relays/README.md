# Conduit Relay Infrastructure

This directory contains the relay services for local development, matching the three-tier relay architecture described in `docs/specs/relay/conduit_relay_architecture.md`.

## Architecture

```
                +-----------------+
                |  Conduit L2     |  ws://127.0.0.1:3334
                |  (commerce)     |  NIP-50 search DSL, price sorting, pagination
                +-----------------+
                        |
+-----------------+     |     +-----------------+
|  Haven          |     |     |  Public Relay    |  ws://127.0.0.1:7777
|  (merchant)     |     |     |  (generic)       |  Standard Nostr relay
|  ws://127.0.0.1:3355  |     +-----------------+
|  Source of truth|     |
+-----------------+     |
                        |
                +-----------------+
                |  Frontend       |
                |  commerce.ts    |  Routes reads through relay tiers
                +-----------------+
```

## Directory Structure

```
relays/
  # L2 source lives in sibling repository:
  #   ../conduitl2
  # docker-compose.dev.yml builds conduitl2 from that path
  haven/            Config and Dockerfile for the Haven merchant relay
    Dockerfile      Builds Haven v1.2.2 from source
    .env.dev        Dev-friendly config (WoT disabled, permissive limits)
    relays_*.json   Empty relay lists for local dev
    whitelist_npubs.dev.json  Local publish whitelist for ad-hoc keys
```

## Relay Roles

| Role         | Service        | Port | Kind Focus | Notes                                                                     |
| ------------ | -------------- | ---- | ---------- | ------------------------------------------------------------------------- |
| **L2**       | conduitl2      | 3334 | 30402      | Commerce-aware queries via `conduit-l2:` NIP-50 DSL                       |
| **Merchant** | Haven          | 3355 | 30402, DMs | 4 endpoints: outbox `/`, chat `/chat`, inbox `/inbox`, private `/private` |
| **Public**   | nostr-rs-relay | 7777 | All        | Generic relay for gossip and fallback reads                               |

## Quick Start

```bash
# Start all relays
bun run relay:stack:up

# Check status
bun run relay:stack:status

# View logs
bun run relay:stack:logs

# Stop (preserve data)
bun run relay:stack:down

# Stop and reset all data
bun run relay:stack:reset
```

### App Env Setup

Set local relay URLs in `apps/market/.env.local` or `apps/merchant/.env.local`:

```bash
VITE_RELAY_URL=ws://127.0.0.1:7777
VITE_L2_RELAY_URLS=ws://127.0.0.1:3334
VITE_MERCHANT_RELAY_URLS=ws://127.0.0.1:3355
VITE_PUBLIC_RELAY_URLS=ws://127.0.0.1:7777
```

`VITE_RELAY_URL` should remain local while testing to avoid implicit fallback to external public relays in generic NDK flows.

Relay-role URLs are consumed by `packages/core/src/config.ts` and used by source-aware reads in `packages/core/src/protocol/commerce.ts`.

### Haven Local Write Access

Haven outbox enforces publisher policy. For local ad-hoc publishers (for example `nak`), add allowed npubs to:

- `relays/haven/whitelist_npubs.dev.json`

Then recreate Haven:

```bash
docker compose -f docker-compose.dev.yml up -d haven --force-recreate
```

The whitelist file is mounted into the container at `/app/whitelist_npubs.dev.json` and read via `WHITELISTED_NPUBS_FILE` in `relays/haven/.env.dev`.

## Running L2 Tests

```bash
bun run relay:conduitl2:test
```

Or directly:

```bash
cd ../conduitl2 && go test ./... -v -count=1
```

## See Also

- `docs/specs/relay/conduit_relay_architecture.md` - Full architecture spec
- `docs/specs/relay/conduit_l2_scope2_functional.md` - L2 functional spec
- `docs/knowledge/dev-seeding-and-relays.md` - Seeding and relay setup guide
- `scripts/dev/relay_stack_verify.ts` - Stack verification and demo script

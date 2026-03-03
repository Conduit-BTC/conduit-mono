# Conduit Relay Specification

## Overview

A custom Nostr relay optimized for commerce events. Provides reliable storage and delivery of product listings, orders, and merchant communications without requiring trust in third-party relays.

## Reference

**GitHub repo**: `https://github.com/Conduit-BTC/conduit-market-relay`
- Check for existing relay implementation patterns
- May contain useful configuration and policy decisions

## Purpose

1. **Reliability** - Guaranteed uptime for commerce-critical events
2. **Performance** - Optimized indexing for marketplace queries
3. **Control** - Define retention, rate limits, and event policies
4. **Fallback** - Primary relay when public relays are slow/unavailable

## Event Kinds Supported

| Kind | Description | Retention |
|------|-------------|-----------|
| 0 | Profile metadata | Indefinite |
| 4/44 | NIP-17 Encrypted DMs | 90 days |
| 5 | Deletion events | 30 days |
| 10002 | Relay list | Indefinite |
| 30402 | Product listings | Indefinite |
| 9734 | Zap requests | 30 days |
| 9735 | Zap receipts | Indefinite |

## Architecture

```
┌─────────────────────────────────────────┐
│              Conduit Relay              │
├─────────────────────────────────────────┤
│  WebSocket Server (NIP-01)              │
│  ├── Connection handling                │
│  ├── Subscription management            │
│  └── Event validation                   │
├─────────────────────────────────────────┤
│  Event Processor                        │
│  ├── Signature verification             │
│  ├── Kind-specific validation           │
│  └── Rate limiting                      │
├─────────────────────────────────────────┤
│  Storage Layer                          │
│  ├── PostgreSQL (primary)               │
│  ├── Event indexing                     │
│  └── Query optimization                 │
├─────────────────────────────────────────┤
│  NIPs Supported                         │
│  ├── NIP-01 (Basic protocol)            │
│  ├── NIP-02 (Follow list)               │
│  ├── NIP-04 (Encrypted DM - legacy)     │
│  ├── NIP-09 (Deletion)                  │
│  ├── NIP-11 (Relay info)                │
│  ├── NIP-17 (Private DMs)               │
│  ├── NIP-42 (Auth)                      │
│  └── NIP-99 (Classifieds/Products)      │
└─────────────────────────────────────────┘
```

## Tech Stack Options

| Option | Pros | Cons |
|--------|------|------|
| **strfry** (C++) | Fast, battle-tested | C++ complexity |
| **nostr-rs-relay** (Rust) | Good performance, active | Rust learning curve |
| **khatru** (Go) | Simple, embeddable | Newer, less features |
| **Custom (TypeScript)** | Full control, familiar | Build from scratch |

**Recommendation**: Start with **strfry** or **nostr-rs-relay** for proven reliability, customize via plugins/policies.

## Features

### Required (Phase 5)
- [ ] Basic NIP-01 relay functionality
- [ ] PostgreSQL storage with commerce-optimized indexes
- [ ] Kind 30402 (product) query optimization
- [ ] Rate limiting per pubkey
- [ ] NIP-11 relay information document
- [ ] Health monitoring endpoint

### Future
- [ ] NIP-42 authentication (merchant verification)
- [ ] Paid relay tiers (premium merchants)
- [ ] Geographic distribution (multi-region)
- [ ] Event analytics (aggregated, anonymous)
- [ ] Webhook notifications for merchants

## Query Optimization

Commerce-specific indexes:

```sql
-- Fast product lookups
CREATE INDEX idx_products_merchant ON events (pubkey)
  WHERE kind = 30402;

-- Product search by tags
CREATE INDEX idx_products_tags ON events USING GIN (tags)
  WHERE kind = 30402;

-- Recent products
CREATE INDEX idx_products_created ON events (created_at DESC)
  WHERE kind = 30402;

-- Merchant DMs
CREATE INDEX idx_dms_participants ON events (pubkey, tags)
  WHERE kind IN (4, 44);
```

## Policies

### Rate Limits
- Events per minute per pubkey: 60
- Subscriptions per connection: 20
- Max event size: 64KB

### Retention
- Products (30402): Indefinite while merchant active
- DMs (4/44): 90 days
- Zap requests: 30 days
- Deletions: Honor immediately, log for 30 days

### Spam Prevention
- Proof of work optional (NIP-13)
- Pubkey allowlist for merchants
- Content filtering (no illegal content)

## Deployment

### Infrastructure Options

| Option | Cost | Pros | Cons |
|--------|------|------|------|
| **Fly.io** | ~$20/mo | Easy deploy, global edge, free Postgres | Limited customization |
| **Railway** | ~$20/mo | Simple, good DX, managed Postgres | Newer platform |
| **Render** | ~$25/mo | Easy, free TLS, managed DB | Slower cold starts |
| **Hetzner + Coolify** | ~$10/mo | Cheap, full control, EU privacy | More setup |
| **DigitalOcean** | ~$30/mo | Reliable, managed DB option | More expensive |
| **AWS (ECS/RDS)** | ~$50+/mo | Enterprise-grade, scalable | Complex, expensive |

**Recommendation**: Start with **Fly.io** or **Railway** for simplicity. Move to Hetzner/DO when scaling.

### Stack
- Docker container (strfry or nostr-rs-relay)
- PostgreSQL 15+ (managed or self-hosted)
- Redis (optional, for caching/rate limiting)
- Caddy (auto TLS, reverse proxy)

### Fly.io Example

```toml
# fly.toml
app = "conduit-relay"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  DATABASE_URL = "postgres://..."

[http_service]
  internal_port = 8080
  force_https = true

[[services]]
  protocol = "tcp"
  internal_port = 8080
  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

### Railway Example

```yaml
# railway.yaml
services:
  relay:
    build:
      dockerfile: Dockerfile
    healthcheck:
      path: /
    domains:
      - relay.conduit.market
```

### Endpoints
- `wss://relay.conduit.market` - Primary relay
- `https://relay.conduit.market` - NIP-11 info

## Privacy

- **No IP logging** beyond connection metrics
- **No message inspection** (encrypted DMs)
- **No behavioral tracking**
- Aggregated metrics only (event counts, relay health)

## Integration

Apps connect to Conduit relay as primary, with fallback to public relays:

```typescript
const ndk = new NDK({
  explicitRelayUrls: [
    "wss://relay.conduit.market",  // Primary
    "wss://relay.damus.io",        // Fallback
    "wss://nos.lol",               // Fallback
  ],
})
```

## Success Metrics

- 99.9% uptime
- <100ms event delivery
- <500ms query response (p95)
- Zero data loss
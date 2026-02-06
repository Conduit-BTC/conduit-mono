# Commerce Coordinator Specification

## Overview

A server-side Nostr bot that automates merchant operations. Monitors commerce events and handles checkout, inventory, payments, and fulfillment without requiring merchants to be constantly online.

**Status**: Post-MVP (Phase 5+)
**Repo**: https://gitlab.com/conduit-btc/a-nostr-commerce-coordinator

## Purpose

Without a coordinator, merchants must:
- Manually monitor for zap receipts
- Send order confirmations manually
- Track inventory in spreadsheets
- Miss orders when offline

The coordinator automates this flow, providing 24/7 merchant availability.

## Core Functions

### 1. Checkout Automation
```
Zap Receipt (9735) → Validate → Send Order Confirmation DM
```
- Listens for zap receipts to merchant pubkey
- Validates payment amount matches product price
- Sends encrypted DM (NIP-17) confirming order
- Creates order record for merchant dashboard

### 2. Inventory Management
- Tracks product quantities from Kind 30402 events
- Decrements on confirmed purchase
- Publishes updated product event with new quantity
- Optional: Auto-unpublish when out of stock

### 3. Payment Processing
- Monitors NWC wallet for incoming payments
- Matches payments to pending orders
- Handles partial payments (reject or hold)
- Timeout handling for expired invoices

### 4. Fulfillment Notifications
- Sends shipping confirmation DMs
- Publishes fulfillment status events
- Optional: Integrates with shipping APIs (future)

## Architecture

```
┌─────────────────────────────────────────┐
│           Commerce Coordinator          │
├─────────────────────────────────────────┤
│  Event Listener                         │
│  ├── Subscribe to merchant events       │
│  ├── Zap receipts (9735)                │
│  ├── Product updates (30402)            │
│  └── Order-related DMs (NIP-17)         │
├─────────────────────────────────────────┤
│  Order State Machine                    │
│  ├── pending → paid → confirmed          │
│  ├── confirmed → shipped → delivered     │
│  └── any → cancelled/refunded           │
├─────────────────────────────────────────┤
│  Action Dispatcher                      │
│  ├── Send confirmation DMs               │
│  ├── Publish inventory updates          │
│  └── Log to merchant dashboard          │
├─────────────────────────────────────────┤
│  Merchant Keys (NIP-46 Remote Signer)   │
│  └── Never stores private keys          │
└─────────────────────────────────────────┘
```

## Security Model

### Key Management
- **NO private key storage** in coordinator
- Uses NIP-46 remote signing (Nostr Connect)
- Merchant authorizes coordinator pubkey
- Limited permissions (sign specific event kinds only)

### Permissions
```typescript
// Coordinator requests only necessary permissions
const permissions = [
  "sign_event:4",      // Encrypted DMs
  "sign_event:30402",  // Product updates
  "nip04_encrypt",     // DM encryption
  "nip04_decrypt",     // DM decryption
]
```

### Trust Model
- Coordinator is trusted infrastructure (run by Conduit)
- Merchants opt-in by connecting NIP-46 signer
- All actions auditable via Nostr events
- Merchant can revoke at any time

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Bun or Node.js |
| Nostr | NDK |
| State | PostgreSQL or SQLite |
| Queue | BullMQ (Redis) or in-process |
| Deploy | Docker / Fly.io / Railway |

## Features

### Phase 5 (MVP Coordinator)
- [ ] Zap receipt → order confirmation flow
- [ ] Basic inventory decrement
- [ ] NIP-46 signer integration
- [ ] Order state persistence
- [ ] Merchant dashboard API

### Phase 6+ (Enhanced)
- [ ] Multi-merchant support (SaaS model)
- [ ] Shipping integration (ShipStation API)
- [ ] Refund processing assistance
- [ ] Analytics and reporting
- [ ] Webhooks for external systems

## Event Flow

```
1. Buyer zaps product (9734 → 9735)
2. Coordinator receives zap receipt
3. Coordinator validates:
   - Correct amount?
   - Product in stock?
   - Valid buyer pubkey?
4. Coordinator (via NIP-46) signs order confirmation DM
5. Coordinator updates inventory (new 30402 event)
6. Coordinator logs order to database
7. Merchant Portal shows new order
8. Merchant ships, marks fulfilled
9. Coordinator sends fulfillment DM to buyer
```

## Deployment

### Self-Hosted (Merchants)
Not recommended for MVP. Complexity of key management, uptime requirements.

### Conduit-Managed
- Single coordinator instance for all merchants
- Horizontal scaling as needed
- 99.9% uptime SLA (future)

### Infrastructure
```yaml
# docker-compose.yml
services:
  coordinator:
    build: .
    environment:
      - DATABASE_URL=postgres://...
      - RELAY_URL=wss://relay.conduit.market
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:15
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
```

## Privacy

- DM content encrypted end-to-end (NIP-17)
- Coordinator has temporary access to decrypt (for processing)
- No long-term storage of message content
- Order metadata stored for merchant dashboard
- Aggregated metrics only, no buyer tracking

## Best Practices

### Idempotency
- Process each zap receipt exactly once
- Use event ID as deduplication key
- Handle relay reconnection gracefully

### Error Handling
- Retry transient failures (relay disconnect)
- Alert on persistent failures
- Never lose order data

### Monitoring
- Health check endpoint
- Order processing latency metrics
- Failed order alerts

### Testing
- Mock NIP-46 signer for tests
- Simulate various payment scenarios
- Test inventory edge cases (0, negative, concurrent)

## Integration with Other Components

| Component | Integration |
|-----------|-------------|
| **Market** | Coordinator confirms orders initiated from Market |
| **Merchant Portal** | Dashboard reads from coordinator's order database |
| **Relay** | Coordinator subscribes to Conduit relay primarily |
| **Store Builder** | Same order flow as Market |

## Success Metrics

- Order confirmation latency: <5s from zap
- Order accuracy: 100% (no missed orders)
- Uptime: 99.9%
- Merchant onboarding: <5 minutes

## References

- Existing repo: https://gitlab.com/conduit-btc/a-nostr-commerce-coordinator
- NIP-46 (Nostr Connect): https://github.com/nostr-protocol/nips/blob/master/46.md
- NIP-17 (Private DMs): https://github.com/nostr-protocol/nips/blob/master/17.md
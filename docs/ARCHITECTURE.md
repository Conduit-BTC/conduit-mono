# Conduit Architecture

System architecture and technical design for the current `conduit-mono` client repository.

Execution sequencing lives in Linear. This document describes repo-local architecture and should not be used to pull future service, billing, or generated-store scope into current Market and Merchant milestones.

---

## System Overview

```
Market ─────────┐
                ├── @conduit/core ── Nostr relays, Lightning/NWC/WebLN, Dexie
Merchant ───────┤
                └── @conduit/ui ─── shared components, tokens, styles
Store Builder ──┘
```

| App                  | Current role                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/market`        | Buyer marketplace: browse, cart, checkout, orders, messages, wallet, network settings                  |
| `apps/merchant`      | Seller workspace: readiness dashboard, products, orders, profile, payments, shipping, network settings |
| `apps/store-builder` | Placeholder app for future standalone storefront work                                                  |

| Package         | Current role                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@conduit/core` | Types, schemas, Nostr protocol helpers, relay planning/settings, Dexie persistence, pricing/payment helpers, React hooks |
| `@conduit/ui`   | Shared shadcn-style components, design tokens, typography, theme styles                                                  |

`@conduit/ui` does not depend on `@conduit/core`. Apps may depend on both shared packages. Shared protocol and business behavior belongs in `@conduit/core`; reusable controls and interaction primitives belong in `@conduit/ui`.

---

## Public Domains

| Domain                   | Purpose                      |
| ------------------------ | ---------------------------- |
| `conduit.market`         | Marketing / landing page     |
| `shop.conduit.market`    | Market app                   |
| `sell.conduit.market`    | Merchant Portal              |
| `build.conduit.market`   | Future Store Builder surface |
| `blossom.conduit.market` | Blossom media hosting        |

The canonical relay reset list is code-owned in `packages/core/src/config.ts` and currently starts with `wss://conduitl2.fly.dev`. Retired Conduit relay hosts should not appear in active docs or examples.

---

## App Routes

### Market

```
apps/market/src/routes/
├── __root.tsx
├── index.tsx
├── products/
│   ├── index.tsx
│   └── $productId.tsx
├── cart.tsx
├── checkout.tsx
├── orders.tsx
├── messages.tsx
├── network.tsx
├── wallet.tsx
├── profile.tsx
├── about.tsx
├── store/
│   └── $pubkey.tsx
└── u/
    └── $profileRef.tsx
```

### Merchant

```
apps/merchant/src/routes/
├── __root.tsx
├── index.tsx
├── products.tsx
├── orders.tsx
├── profile.tsx
├── payments.tsx
├── shipping.tsx
├── network.tsx
└── about.tsx
```

### Store Builder

```
apps/store-builder/src/routes/
├── __root.tsx
└── index.tsx
```

Do not document Store Builder as a generated-store platform until that scope has an accepted spec and implementation plan.

---

## Protocol Surface

### Nostr Event Kinds

| Kind    | Purpose                      | Notes                             |
| ------- | ---------------------------- | --------------------------------- |
| `0`     | Profile metadata             | NIP-01                            |
| `3`     | Contact list / follow graph  | NIP-02                            |
| `5`     | Event deletion               | NIP-09                            |
| `13`    | Seal                         | NIP-59 / NIP-17 message wrapping  |
| `14`    | Private direct message       | NIP-17                            |
| `16`    | Order message payload        | Conduit payload wrapped in NIP-17 |
| `1059`  | Gift wrap                    | NIP-17                            |
| `9734`  | Zap request                  | NIP-57                            |
| `9735`  | Zap receipt                  | NIP-57                            |
| `10002` | Relay list                   | NIP-65                            |
| `10050` | Private message relays       | NIP-17 recipient relay hints      |
| `30402` | Product listing              | NIP-99 + GammaMarkets market-spec |
| `30406` | Shipping option              | Conduit commerce extension        |
| `31989` | Application recommendation   | NIP-89                            |
| `31990` | Application handler metadata | NIP-89                            |

Authentication is external-signer-only. The repo policy allows NIP-07 and NIP-46 style external signers, but broad NIP-46 UX is not a Phase 2A blocker.

### Product Discovery

Product listings are replaceable addressable events:

```text
30402:<merchant_pubkey>:<d_tag>
```

Routes should prefer shared product parsing, dedupe, relay-planning, and cache helpers instead of inventing per-route event semantics. Current code may still use NDK as the edge library. Future Phase 2B architecture is expected to move more relay execution/source-health behavior behind an explicit shared boundary, but current closeout work should not introduce a broad custom substrate before that architecture is accepted.

### Orders And Messages

Buyer-merchant communication uses NIP-17 encrypted messages. A Conduit order message payload is kind `16`, encrypted/sealed/wrapped before publishing. General buyer/merchant DMs use kind `14` inside the same private-message transport and should stay distinct from order-linked kind `16` conversations in product state.

Phase 2A secure messaging work should move route-level send/read behavior behind a Conduit-owned private-message boundary in `@conduit/core`. That boundary should preserve NIP-44 v2 compatibility, keep NIP-44 v3 readiness visible as emerging Linear-tracked work, require public draft/client references and capability detection before v3 is used, parse kind `10050` private-message relay hints, and keep decrypt/unwrap diagnostics content-free. NWC remains conservative and should not move to NIP-44 v3 unless wallet capability discovery and public draft/client references explicitly support it.

Standard order message types:

| Type              | Direction         | Meaning                           |
| ----------------- | ----------------- | --------------------------------- |
| `order`           | buyer -> merchant | Initial order intent/details      |
| `payment_request` | merchant -> buyer | Lightning invoice/payment request |
| `payment_proof`   | buyer -> merchant | Buyer payment evidence            |
| `status_update`   | merchant -> buyer | Order state transition            |
| `shipping_update` | merchant -> buyer | Tracking or shipping update       |
| `receipt`         | merchant -> buyer | Final receipt/confirmation        |

Order status values currently include:

```text
pending -> invoiced -> paid -> processing -> shipped -> complete
```

`cancelled` may occur from pending or later operational states. Product copy should distinguish unpaid, proof received, and confirmed paid where that distinction affects buyer or merchant decisions.

---

## Data Layer

### React State

- TanStack Query handles remote/server-like relay state.
- React Context owns auth state.
- App-local `useState` / `useReducer` owns ephemeral UI state.
- No Zustand, Jotai, Redux, or equivalent global state library.

### Dexie

Dexie is used for local-first persistence and recovery:

| Table                    | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `orders`                 | Buyer/merchant order records and local status |
| `messages`               | Message cache                                 |
| `products`               | Product cache                                 |
| `profiles`               | Profile cache                                 |
| `orderMessages`          | Order-linked message history                  |
| `relayLists`             | NIP-65 relay list cache                       |
| `productSocialSummaries` | Product trust/social summary cache            |
| `paymentAttempts`        | Buyer payment attempt history                 |

Cache data is evidence for fast paint and recovery. It should not be presented as proof that relay discovery is complete.

### localStorage

localStorage is used for small local preferences and cart state. Sensitive order/message/payment contents should stay in the encrypted message flow or local IndexedDB records designed for that purpose.

---

## Relay Architecture

Conduit treats relays as Nostr infrastructure, not fixed app roles.

User-facing relay settings expose:

- `IN`: relays Conduit may read from
- `OUT`: relays Conduit may publish to
- Commerce priority: Conduit-local ordering for commerce-compatible relays
- Capability/warning indicators derived from NIP-11, probes, and local observations

The current canonical fallback/reset relay list lives in `packages/core/src/config.ts`:

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

Conduit-hosted deploys should leave relay env vars empty unless an operator intentionally needs an override. This keeps the public code defaults auditable.

Future Phase 2B work is expected to add a more explicit source-aware read frontier, relay health model, and local-first performance layer. Current Phase 2A work should keep relay behavior typed and recoverable without making that future architecture a milestone blocker.

Phase 2A also includes an essential commerce outbox slice for signed orders, messages, merchant replies, payment proofs, and product publish/delete actions. This is a minimum usability layer for locally visible, retryable signed commerce writes; the broader generic write frontier remains Phase 2B architecture work.

---

## Payments

Conduit is non-custodial. Apps never hold balances or process refunds.

Current payment model:

1. Buyer creates an order.
2. If merchant/buyer readiness allows fast checkout, buyer can initiate payment from checkout using NWC/WebLN-compatible rails.
3. Otherwise the order-first/manual invoice path remains the fallback baseline.
4. Payment request and payment proof messages stay linked to the order conversation.
5. Merchant verifies payment independently or through their own wallet tooling and updates order state.

Payment proof is receipt-style evidence, not custody. Product UI should avoid collapsing these states:

- payment requested
- payment sent
- proof sent
- proof received
- confirmed paid
- mismatch/unverified/disputed

Future service automation may improve offline merchant availability, but it belongs outside current `conduit-mono` scope unless a service repo/spec is accepted.

---

## Environment Architecture

### Local Development

Root commands:

```bash
bun run dev
bun run dev:mock
bun run dev:market
bun run dev:merchant
bun run dev:store-builder
```

Default Vite ports are:

| App           | Port   |
| ------------- | ------ |
| Market        | `3000` |
| Merchant      | `3001` |
| Store Builder | `3002` |

Agents may use the 7000 range when they need stable side-by-side local servers:

| App           | Agent port |
| ------------- | ---------- |
| Market        | `7000`     |
| Merchant      | `7001`     |
| Store Builder | `7002`     |

### Environment Variables

```bash
VITE_RELAY_URL=
VITE_DEFAULT_RELAY_URL=
VITE_DEFAULT_RELAYS=
VITE_APP_WRITE_RELAY_URLS=
VITE_PUBLIC_RELAY_URLS=
VITE_COMMERCE_RELAY_URLS=
VITE_CACHE_API_URL=
VITE_LIGHTNING_NETWORK=mainnet # mainnet | signet | testnet | mock
VITE_BLOSSOM_SERVER_URL=https://blossom.conduit.market
```

`VITE_RELAY_URL` is a legacy/default relay hint and NIP-89 relay hint fallback. It is not a user-facing relay role.

---

## Future Direction Notes

These notes are directional, not current-phase blockers:

- Phase 2B should introduce an accepted local-first app architecture before route code is broadly refactored around a new commerce substrate.
- NDK may remain useful at the edges, but future source-aware relay execution may be better served by Nostrify or a Conduit-owned adapter around signed events and relay outcomes.
- Future service, billing, monetization, and generated-store concepts live under `docs/knowledge/future/` until they have their own accepted repo boundary and implementation contract.

---

## References

- [PLAN.md](../PLAN.md) - Current planning index
- [IMPLEMENTATION.md](./plans/IMPLEMENTATION.md) - Current implementation status
- [ROADMAP.md](./plans/ROADMAP.md) - Strategic epochs
- [Protocol spec](./specs/protocol.md) - Protocol and message contracts
- [Relay spec](./specs/relay.md) - Relay compatibility and settings model
- [Nostr NIPs](https://github.com/nostr-protocol/nips) - Protocol specifications

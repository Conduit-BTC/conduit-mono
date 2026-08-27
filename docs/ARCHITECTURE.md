# Conduit Architecture

System architecture and technical design for the current `conduit-mono` client repository.

---

## System Overview

```
Market ─────────┐
                ├── @conduit/core ── Nostr relays, Lightning/Spark/NWC/WebLN, Dexie
Merchant ───────┤
                └── @conduit/ui ─── shared components, tokens, styles
Store Builder ──┘
```

| App                  | Current role                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/market`        | Buyer marketplace: browse, cart, checkout, orders, messages, wallet, network settings                  |
| `apps/merchant`      | Seller workspace: readiness dashboard, products, orders, profile, payments, shipping, network settings |
| `apps/store-builder` | Placeholder app shell                                                                                  |

| Package         | Current role                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@conduit/core` | Types, schemas, Nostr protocol helpers, relay planning/settings, Dexie persistence, pricing/payment helpers, React hooks |
| `@conduit/ui`   | Shared shadcn-style components, design tokens, typography, theme styles                                                  |

`@conduit/core` must not depend on `@conduit/ui`. `@conduit/ui` may depend on
`@conduit/core` for shared protocol **types and pure helpers** — the dependency
is one-directional (build order `core → ui → apps`, no cycle) and exists so
shared, protocol-aware presentational components (e.g. the order-message bubble
and messenger) can live in `@conduit/ui` instead of being duplicated per app.
`@conduit/ui` must not pull relay/network/Dexie side effects; protocol and
business behavior still belongs in `@conduit/core`, and reusable controls and
interaction primitives belong in `@conduit/ui`. Apps may depend on both.

---

## Public Domains

| Domain                   | Purpose                      |
| ------------------------ | ---------------------------- |
| `conduit.market`         | Marketing / landing page     |
| `shop.conduit.market`    | Market app                   |
| `sell.conduit.market`    | Merchant Portal              |
| `build.conduit.market`   | Store Builder app shell      |
| `blossom.conduit.market` | Blossom media hosting        |
| `relay.conduit.market`   | Conduit-operated Nostr relay |
| `e.conduit.market`       | Product telemetry proxy      |

The canonical relay reset list is code-owned in `packages/core/src/config.ts` and currently starts with `wss://relay.conduit.market`. Retired Conduit relay hosts should not appear in active docs or examples.

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
├── privacy-policy.tsx
├── terms-of-service.tsx
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
├── about.tsx
├── privacy-policy.tsx
└── terms-of-service.tsx
```

### Store Builder

```
apps/store-builder/src/routes/
├── __root.tsx
└── index.tsx
```

Do not document Store Builder behavior beyond implemented routes and shared app infrastructure.

### Product Legal Boot Boundary

`/privacy-policy` and `/terms-of-service` are the exact public legal routes in
both Market and Merchant. Each app detects those paths in its entry point before
starting product providers or workers, and its root route dispatches to a bare
legal outlet before auth or telemetry hooks. Direct legal loads therefore do
not restore a signer, start a Conduit session or Nostr connection, prune product
caches, run delivery workers, warm prices, evaluate merchant readiness, start
payment automation, or emit Product telemetry. Product legal links use ordinary
anchors so navigation re-enters that boot boundary.

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
| `30406` | Shipping option              | GammaMarkets market-spec          |
| `31989` | Application recommendation   | NIP-89                            |
| `31990` | Application handler metadata | NIP-89                            |

Market and Merchant durable account authentication is external-signer-only. The
repo policy allows NIP-07 and NIP-46 external signers. Guest checkout may create
a temporary order-scoped browser key, and an NIP-46 connection may use an
encrypted browser-local client key; neither is a Conduit-custodied user account
key. The only approved server-side private-key exception is the Anon Conduit
Shopper public zap signer described in `docs/specs/protocol.md`; it is limited
to authenticated, merchant-authorized public zap request signing and does not
authorize user key custody.

### Product Discovery

Product listings are replaceable addressable events:

```text
30402:<merchant_pubkey>:<d_tag>
```

Routes should prefer shared product parsing, dedupe, relay-planning, and cache helpers instead of inventing per-route event semantics. Current code may still use NDK as the edge library.

Fixed physical-product shipping uses a product-scoped Gamma kind `30406`.
Merchant requires a positive relay acknowledgement for that option before
publishing the referencing kind `30402`. Market resolves only the exact
coordinate and prepares one fulfillment snapshot for pricing, destination
eligibility, checkout, and order persistence. See
`docs/specs/fixed-product-shipping.md`.

### Orders And Messages

Buyer-merchant communication uses NIP-17 encrypted messages. A Conduit order message payload is kind `16`, encrypted/sealed/wrapped before publishing. General buyer/merchant DMs use kind `14` inside the same private-message transport and should stay distinct from order-linked kind `16` conversations in product state.

New private-message work should use a Conduit-owned private-message boundary in `@conduit/core` instead of route-local send/read implementations. That boundary should preserve NIP-44 v2 compatibility, require public draft/client references and capability detection before any newer encryption version is used, parse kind `10050` private-message relay hints, and keep decrypt/unwrap diagnostics content-free. NWC remains conservative and should not move beyond NIP-44 v2 unless wallet capability discovery and public draft/client references explicitly support it.

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
| `wallets`                | Non-secret local wallet descriptors/defaults  |
| `walletCredentials`      | Device-local provider credential records      |

Cache data is evidence for fast paint and recovery. It should not be presented as proof that relay discovery is complete.

`wallets` and `walletCredentials` are deliberately separate. The registry
contains opaque local instance IDs, provider/kind metadata, capabilities,
network, status, labels, and defaults. `walletCredentials` contains
provider-owned local records such as an NWC connection URI or an encrypted Spark
recovery envelope. These records are device-local, are never relay-synced, and
must not enter logs or telemetry. Spark SDK storage is additionally isolated by
wallet instance.

### localStorage

localStorage is used for small local preferences, cart state, selected public
key/signer method, and relay settings. IndexedDB stores local
order/message/payment records, caches, wallet descriptors, and provider-owned
credential records. A legacy single-wallet NWC record may be read only for
transactional migration into `wallets` and `walletCredentials`; new wallet
credentials must not be written to localStorage. Guest checkout and remote
signer flows also use bounded session or encrypted browser-local storage as
described in `docs/specs/protocol.md`. Sensitive contents must remain excluded
from telemetry and diagnostics even when the browser, a counterparty, a signer,
a wallet, a relay, or another user-selected provider processes them.

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
wss://relay.conduit.market
wss://nos.lol
wss://relay.ditto.pub
wss://relay.primal.net
```

Conduit-hosted deploys should leave relay env vars empty unless an operator intentionally needs an override. This keeps the public code defaults auditable.

Signed commerce writes for orders, messages, merchant replies, payment proofs, and product publish/delete actions should remain locally visible and retryable where implemented. Relay behavior should stay typed, recoverable, and shared rather than being rebuilt in routes.

---

## Payments

Conduit is non-custodial. Conduit-operated services never receive wallet seeds,
NWC connection secrets, or control funds, and apps do not process refunds.

Market supports multiple wallet instances behind a provider-neutral wallet
registry:

- **Portable Wallets** are self-custodial wallets whose recovery material can
  recreate the wallet in a compatible application. Spark is the first provider.
- **Connected Wallets** remain external wallets authorized through a connection
  protocol. NWC is the first connection protocol.

Portable Wallet credentials are distinct from Nostr identity keys. Nostr account
authentication remains external-signer-only; a Portable Wallet provider may
create or restore a wallet seed only inside its isolated client-side storage.
Non-secret registry metadata lives in Dexie. See `docs/specs/wallets.md`.

Wallet ownership is device-local rather than Nostr-account-scoped. Market keeps
`/wallet` available while signed out so a user can create, restore, unlock,
receive with, or remove a device-owned Portable Wallet without connecting an
identity signer. A shared browser profile therefore shares its local wallet
registry; signing out does not delete or switch those wallets.

Each Spark wallet uses a user-chosen local password to encrypt its BIP39
mnemonic in the device-local credential store. The password is an unlock
credential for that browser profile, not portable recovery material. The BIP39
mnemonic, explicit Spark account number, and network form the portable
cross-application recovery bundle.

Current payment model:

1. Buyer creates an order.
2. If merchant/buyer readiness allows fast checkout, buyer selects an eligible
   Portable or Connected Wallet instance. NWC, Spark, and WebLN-compatible rails
   may satisfy the payment request.
3. Otherwise the order-first/manual invoice path remains the fallback baseline.
4. Payment request and payment proof messages stay linked to the order conversation.
5. Merchant verifies payment independently or through their own wallet tooling and updates order state.

The chosen wallet instance ID is persisted only in the buyer's local order
lifecycle. It is never included in order messages, payment proofs, merchant
payloads, logs, or analytics. A retry resolves that exact instance; changing the
wallet or falling back to WebLN/manual payment requires a new explicit user
choice.

Spark sends use a prepare/review/send boundary. Market displays the payment
amount, provider fee, and total before the irreversible send call. Declining or
dismissing the review performs no send. An ambiguous result remains attached to
the original wallet and attempt and must be reconciled from payment history
before any retry.

Wallet secrets, recovery material, credentials, invoices, payment content,
selected wallet instance IDs, and balances are excluded from diagnostics and
telemetry.

Payment proof is receipt-style evidence, not custody. Product UI should avoid collapsing these states:

- payment requested
- payment sent
- proof sent
- proof received
- confirmed paid
- mismatch/unverified/disputed

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

## References

- [Protocol spec](./specs/protocol.md) - Protocol and message contracts
- [Relay spec](./specs/relay.md) - Relay compatibility and settings model
- [Wallets spec](./specs/wallets.md) - Portable/Connected Wallet contract
- [Nostr NIPs](https://github.com/nostr-protocol/nips) - Protocol specifications

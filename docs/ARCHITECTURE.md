# Conduit Architecture

System architecture and technical design for the Conduit commerce platform.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CONDUIT PLATFORM                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                    │
│  │    Market    │   │   Merchant   │   │    Store     │                    │
│  │  (Buyers)    │   │   Portal     │   │   Builder    │                    │
│  │              │   │  (Sellers)   │   │ (Storefronts)│                    │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘                    │
│         │                  │                  │                             │
│         └──────────────────┼──────────────────┘                             │
│                            │                                                │
│                   ┌────────▼────────┐                                       │
│                   │  Shared Layer   │                                       │
│                   │                 │                                       │
│                   │  @conduit/core  │ ← Types, Protocol, Schemas, Utils     │
│                   │  @conduit/ui    │ ← Components, Hooks, Styles           │
│                   └────────┬────────┘                                       │
│                            │                                                │
└────────────────────────────┼────────────────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
       ┌───────────┐  ┌───────────┐  ┌───────────┐
       │   Nostr   │  │  Blossom  │  │ Lightning │
       │   Relays  │  │  (Media)  │  │   (NWC)   │
       └───────────┘  └───────────┘  └───────────┘
```

### Domain Structure

| Domain | Purpose |
|--------|---------|
| `conduit.market` | Marketing / landing page |
| `shop.conduit.market` | Market app (buyers) |
| `sell.conduit.market` | Merchant Portal (sellers) |
| `build.conduit.market` | Store Builder app |
| `relay.conduit.market` | Nostr relay |
| `blossom.conduit.market` | Media hosting (Blossom) |
| `{store}.conduit.market` | Generated merchant stores |

---

## App Architecture

### Market (Buyer-Facing)

```
market/src/
├── routes/                  # TanStack Router (file-based)
│   ├── __root.tsx           # Layout shell
│   ├── index.tsx            # Home (/)
│   ├── products/
│   │   ├── index.tsx        # Browse (/products)
│   │   └── $productId.tsx   # Detail (/products/:id)
│   ├── cart.tsx             # Cart review
│   ├── checkout.tsx         # Order + payment
│   ├── orders/
│   │   ├── index.tsx        # History
│   │   └── $orderId.tsx     # Detail
│   ├── messages.tsx         # NIP-17 DMs
│   ├── store/
│   │   └── $pubkey.tsx      # Merchant storefront
│   └── profile.tsx          # User profile
├── components/              # App-specific components
├── hooks/                   # useCart, useCheckout, etc.
└── lib/                     # Query client, guards
```

### Merchant Portal (Seller Dashboard)

```
merchant/src/
├── routes/
│   ├── __root.tsx           # Dashboard layout
│   ├── index.tsx            # Overview metrics
│   ├── products/
│   │   ├── index.tsx        # Product list
│   │   ├── new.tsx          # Create product
│   │   └── $productId.tsx   # Edit product
│   ├── orders/
│   │   ├── index.tsx        # Order list
│   │   └── $orderId.tsx     # Order detail + state transitions
│   ├── messages.tsx         # Buyer conversations
│   └── settings.tsx         # Profile, relays, wallet
├── components/
├── hooks/
└── lib/
```

### Store Builder (Storefronts)

```
store-builder/src/
├── routes/
│   ├── __root.tsx
│   ├── index.tsx            # Store home
│   ├── products/
│   ├── cart.tsx
│   └── checkout.tsx
├── components/
└── templates/               # Store templates
```

---

## Protocol Layer

### Nostr Event Kinds

| Kind | Purpose | NIP | Used By |
|------|---------|-----|---------|
| 0 | Profile metadata | NIP-01 | All apps |
| 5 | Deletion request | NIP-09 | Merchant Portal |
| 10002 | Relay list | NIP-65 | All apps |
| 30402 | Product listing | NIP-15 | Market, Portal |
| 16 | Order message | Custom | Market, Portal |
| 1059 | Gift wrap (NIP-17 DMs) | NIP-17 | All apps |

### Event Flow: Product Discovery

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Product Discovery                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Merchant Portal              Relay Network                Market       │
│  ┌─────────────┐              ┌───────────┐           ┌─────────────┐   │
│  │ Create      │  publish     │ Store     │  query    │ Discover    │   │
│  │ Product     │────────────► │ Kind      │◄──────────│ Products    │   │
│  │ (Form)      │  Kind 30402  │ 30402     │  filter   │ (Grid/List) │   │
│  └─────────────┘              └───────────┘           └─────────────┘   │
│                                                                         │
│  NDK handles signing via NIP-07/NIP-46 external signer                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Event Flow: Order Checkout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Order Flow                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Buyer (Market)                                    Merchant (Portal)    │
│                                                                         │
│  1. Add to cart                                                         │
│     └─► localStorage (grouped by merchant)                              │
│                                                                         │
│  2. Checkout                                                            │
│     └─► Create Kind 16 order event                                      │
│         ├─ tags: p (merchant), subject, type, order, amount             │
│         ├─ items: productId, quantity, price                            │
│         └─ shipping: address, phone, email                              │
│                                                                         │
│  3. Wrap in NIP-17                                                      │
│     └─► Kind 1059 (gift wrap) + Kind 13 (seal)                          │
│         └─► Send to merchant's relays                                   │
│                                                                         │
│  4. Merchant receives DM                                                │
│     └─► Unwrap, view order details ─────────────────────► See order     │
│                                                                         │
│  5. Generate Lightning invoice                                          │
│     └─► NWC invoice creation ◄──────────────────────────┤               │
│                                                                         │
│  6. Send payment request                                                │
│     └─► NIP-17 DM with invoice ─────────────────────────► Receive       │
│                                                                         │
│  7. Buyer pays invoice                                                  │
│     └─► Lightning payment ──────────────────────────────► Confirm       │
│                                                                         │
│  8. Order state updates                                                 │
│     └─► NIP-17 DMs for status changes                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## State Machines

### Order States

```
                  ┌─────────────────────────────────────────┐
                  │             Order Created               │
                  │          (Kind 16 + NIP-17)             │
                  └─────────────────┬───────────────────────┘
                                    │
                                    ▼
                           ┌────────────────┐
                     ┌─────│    PENDING     │─────┐
                     │     │ (awaiting pay) │     │
                     │     └───────┬────────┘     │
                     │             │              │
                     │ buyer       │ payment      │ merchant
                     │ cancels     │ received     │ cancels
                     │             ▼              │
                     │     ┌────────────────┐     │
                     │     │     PAID       │     │
                     │     │ (processing)   │     │
                     │     └───────┬────────┘     │
                     │             │              │
                     ▼             │ merchant     ▼
                ┌────────────┐     │ ships   ┌────────────┐
                │ CANCELLED  │     │         │ CANCELLED  │
                └────────────┘     ▼         └────────────┘
                           ┌────────────────┐
                           │  FULFILLED     │
                           │  (shipped)     │
                           └────────────────┘
```

**State storage:**
- Protocol state: Derived from NIP-17 message history
- Local annotations: Stored in Dexie (notes, internal tracking)

### Authentication States

```
                    ┌─────────────────────────┐
                    │      NO SIGNER          │
                    │  (anonymous browsing)   │
                    └───────────┬─────────────┘
                                │ user clicks "Connect"
                                ▼
                    ┌─────────────────────────┐
                    │   SIGNER REQUESTED      │
                    │  (awaiting NIP-07/46)   │
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │ approved        │ rejected        │ timeout
              ▼                 ▼                 ▼
    ┌──────────────────┐  ┌──────────────┐  ┌──────────────┐
    │   CONNECTED      │  │   REJECTED   │  │   TIMEOUT    │
    │  (has pubkey)    │  │              │  │              │
    └────────┬─────────┘  └──────────────┘  └──────────────┘
             │
             │ user disconnects
             ▼
    ┌──────────────────┐
    │   DISCONNECTED   │
    └──────────────────┘
```

**No key custody**: Apps never generate, store, or manage private keys.

---

## Data Layer

### TanStack Query + NDK

```typescript
// Product query example
const { data: products, isLoading } = useQuery({
  queryKey: ["products", { category, relay }],
  queryFn: () => ndk.fetchEvents({
    kinds: [30402],
    "#t": category ? [category] : undefined,
  }),
  staleTime: 1000 * 60 * 5, // 5 minutes
})

// Profile query with caching
const { data: profile } = useQuery({
  queryKey: ["profile", pubkey],
  queryFn: () => ndk.fetchEvent({
    kinds: [0],
    authors: [pubkey],
  }),
})
```

### Dexie (IndexedDB) Schema

```typescript
// packages/core/src/db/schema.ts
class ConduitDB extends Dexie {
  orders!: Table<Order>
  messages!: Table<Message>
  productCache!: Table<CachedProduct>

  constructor() {
    super("conduit")
    this.version(1).stores({
      orders: "id, status, merchantPubkey, createdAt",
      messages: "id, conversationId, timestamp",
      productCache: "id, merchantPubkey, updatedAt",
    })
  }
}
```

**Why Dexie:**
- Orders need offline access and state tracking
- Messages need local history (NIP-17 DMs are ephemeral on relays)
- Product cache improves cold-start performance

### localStorage (Cart)

```typescript
// Cart structure - grouped by merchant
interface Cart {
  merchants: {
    [pubkey: string]: {
      items: CartItem[]
      updatedAt: number
    }
  }
}

interface CartItem {
  productId: string
  eventId: string
  name: string
  price: number
  currency: string
  quantity: number
  image?: string
}
```

---

## Authentication Flow

### NIP-07 (Browser Extension)

```
User                   Browser Extension          App
  │                         │                      │
  │  Click "Connect"        │                      │
  │ ────────────────────────┼─────────────────────►│
  │                         │                      │
  │                         │◄─── getPublicKey() ──│
  │                         │                      │
  │  Approve in extension   │                      │
  │ ───────────────────────►│                      │
  │                         │                      │
  │                         │──── pubkey ─────────►│
  │                         │                      │
  │                         │                      │ Store in AuthContext
  │                         │                      │
  │  Sign event (on action) │                      │
  │                         │◄─── signEvent() ─────│
  │ ───────────────────────►│                      │
  │                         │──── signed event ───►│
```

### NIP-46 (Remote Signer)

```
User                   Remote Signer              App
  │                         │                      │
  │  Scan QR / Enter URI    │                      │
  │ ────────────────────────┼─────────────────────►│
  │                         │                      │
  │                         │◄─── connect req ─────│
  │                         │     (via relay)      │
  │  Approve on device      │                      │
  │ ───────────────────────►│                      │
  │                         │──── ack ────────────►│
  │                         │                      │
  │  Sign request           │                      │
  │                         │◄─── sign_event ──────│
  │ ───────────────────────►│                      │
  │                         │──── signature ──────►│
```

---

## Payment Flow

### MVP: Manual Merchant Flow

In MVP, merchants manually handle invoice generation and payment confirmation. No server-side automation.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    MVP Payment Flow (Manual)                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Buyer (Market)                                Merchant (Portal)        │
│                                                                         │
│  1. Checkout                                                            │
│     └─► Create order (Kind 16)                                          │
│     └─► Wrap in NIP-17                                                  │
│     └─► Send to merchant's relays ─────────────► 2. Order appears       │
│                                                     in inbox            │
│                                                                         │
│                                                  3. Merchant manually   │
│                                                     generates invoice   │
│                                                     └─► NWC makeInvoice │
│                                                                         │
│  4. Invoice received ◄───────────────────────────── Send via NIP-17 DM  │
│     └─► Display QR + copy button                                        │
│     └─► Countdown timer                                                 │
│                                                                         │
│  5. Pay with wallet ─────── Lightning ──────────► 6. Payment received   │
│                                                     └─► Check wallet    │
│                                                     └─► Or poll NWC     │
│                                                                         │
│                                                  7. Manually mark       │
│  8. Status update received ◄─────────────────────── order "Paid"        │
│     └─► Show "Paid" status                         └─► Send NIP-17 DM   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**MVP Tradeoffs:**
- Merchant must be online to process orders
- Manual invoice generation per order
- Manual payment confirmation
- Works for low-volume merchants, common for marketplace MVPs

---

### Post-MVP: Automated Coordinator Flow

With Coordinator (Phase 6), payment flow is fully automated server-side.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                 Automated Payment Flow (Coordinator)                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Buyer (Market)              Coordinator              Merchant Wallet   │
│                                                                         │
│  1. Checkout                                                            │
│     └─► Order event ──────► 2. Receive order                            │
│                                └─► Validate                             │
│                                └─► Auto-generate ────► 3. NWC invoice   │
│                                    invoice                              │
│                                                                         │
│  4. Invoice received ◄─────── Send via NIP-17                           │
│     └─► Display + pay                                                   │
│                                                                         │
│  5. Payment ─────────────────────────────────────► 6. Wallet receives   │
│                                                                         │
│                             7. Detect payment                           │
│                                └─► Subscribe to                         │
│  8. Confirmation ◄───────────    zap receipts                           │
│     └─► Order complete          └─► Update order                        │
│                                    └─► Notify buyer                     │
│                                    └─► Update inventory                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Coordinator Benefits:**
- Merchant doesn't need to be online
- Instant invoice generation
- Automatic payment confirmation
- Inventory sync
- Scales to high-volume merchants

See `docs/specs/coordinator.md` for full specification.

---

## Environment Architecture

### Local Development

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Local Development                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Vite Dev Server (:5173)           Public Relays                        │
│  ┌─────────────────┐               ┌─────────────────┐                  │
│  │  bun run dev    │──────────────►│ relay.damus.io  │                  │
│  │  (hot reload)   │               │ nos.lol         │                  │
│  └─────────────────┘               └─────────────────┘                  │
│                                                                         │
│  Payment: Mock (no real Lightning)                                      │
│  Auth: NIP-07 extension (real keys) or test keypair                     │
│                                                                         │
│  .env.local:                                                            │
│    VITE_LIGHTNING_NETWORK=mock                                          │
│    VITE_DEFAULT_RELAYS=wss://relay.damus.io,wss://nos.lol               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Preview Environment

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Preview (Cloudflare Pages)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  <branch>.conduit-market.pages.dev                                      │
│  ┌─────────────────┐               ┌─────────────────┐                  │
│  │  Cloudflare     │──────────────►│ Public relays   │                  │
│  │  Pages (auto)   │               │ + test relay    │                  │
│  └─────────────────┘               └─────────────────┘                  │
│                                                                         │
│  Payment: Mutinynet (testnet Lightning)                                 │
│  Auth: Real NIP-07/NIP-46 signers                                       │
│                                                                         │
│  Environment variables (Cloudflare):                                    │
│    VITE_LIGHTNING_NETWORK=mutinynet                                     │
│    VITE_DEFAULT_RELAYS=wss://relay.damus.io,wss://nos.lol               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Production

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Production                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  shop.conduit.market               Conduit Relay                        │
│  sell.conduit.market               ┌─────────────────┐                  │
│  ┌─────────────────┐               │ relay.conduit   │                  │
│  │  Cloudflare     │──────────────►│ .market         │                  │
│  │  Pages          │               │ (primary)       │                  │
│  └─────────────────┘               └─────────────────┘                  │
│                                           │                             │
│                                           │ + public relays             │
│                                           ▼                             │
│                                    ┌─────────────────┐                  │
│                                    │ relay.damus.io  │                  │
│                                    │ nos.lol         │                  │
│                                    │ (fallback)      │                  │
│                                    └─────────────────┘                  │
│                                                                         │
│  Payment: Mainnet Lightning                                             │
│  Auth: Real NIP-07/NIP-46 signers                                       │
│                                                                         │
│  Environment variables:                                                 │
│    VITE_RELAY_URL=wss://relay.conduit.market                            │
│    VITE_LIGHTNING_NETWORK=mainnet                                       │
│    VITE_BLOSSOM_SERVER_URL=https://blossom.conduit.market               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Future Components

### Coordinator (Post-MVP)

Server-side bot that automates checkout flow:
- Automated invoice generation
- Payment confirmation
- Inventory sync
- Order state management

See `docs/specs/coordinator.md` for full specification.

### Relay (Post-MVP)

Custom Nostr relay optimized for commerce:
- Product indexing
- Fast search
- Merchant verification
- Spam filtering

---

## References

- [IMPLEMENTATION.md](./plans/IMPLEMENTATION.md) - Build phases and deliverables
- [ROADMAP.md](./plans/ROADMAP.md) - Strategic epochs
- [Nostr NIPs](https://github.com/nostr-protocol/nips) - Protocol specifications
- [NDK](https://github.com/nostr-dev-kit/ndk) - Nostr Development Kit

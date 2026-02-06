# Market Specification

## Overview

Conduit Market is the buyer-facing marketplace for discovering products, communicating with merchants, and completing transactions using Nostr-native protocols.

## Reference

**Figma** (Primary - visual design):
```
File: "Conduit High Fi - Website" in Conduit Market Team
URL: https://www.figma.com/design/adfNXYE3nBqr35frkl0b5q
Page: "High Fi - WIP" for screen designs
```
- Use Figma MCP tools to extract design context when implementing screens
- Select specific frames to get component details and design tokens

**Legacy repo** (Secondary - code patterns):
```
/Users/dylangolow/workspace/CONDUIT/conduit-market-client
```
- Use for state management patterns, Nostr integration, checkout flow logic
- Do NOT copy code directly - rebuild with TanStack Router/Query

---

## Core Flows

### Product Discovery
1. Browse product grid (all, by category, by merchant)
2. Filter and search
3. View product detail
4. Add to cart

### Checkout
1. Review cart
2. Enter shipping info
3. Generate Lightning invoice (NWC)
4. Complete payment
5. Order confirmation

### Messaging
1. Open conversation with merchant
2. Send NIP-17 encrypted DM
3. Receive order updates inline
4. Delivery feedback

---

## Pages

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | HomePage | Featured products, categories |
| `/products` | ProductsPage | Product grid with filters |
| `/products/$productId` | ProductDetailPage | Single product view |
| `/cart` | CartPage | Shopping cart |
| `/checkout` | CheckoutPage | Payment flow |
| `/orders` | OrdersPage | Order history |
| `/orders/$orderId` | OrderDetailPage | Single order |
| `/messages` | MessagesPage | DM inbox |
| `/profile` | ProfilePage | User profile |
| `/store/$pubkey` | StorePage | Merchant storefront |

---

## Data Layer

### TanStack Query Hooks

```typescript
// Product hooks
useProducts(filters?)      // Product listings from relays
useProduct(eventId)        // Single product detail
useProductsByMerchant(pubkey)

// Profile hooks
useProfile(pubkey)         // User/merchant profiles
useMyProfile()             // Current user

// Order hooks
useOrders()                // Order history (from Dexie)
useOrder(orderId)          // Single order

// Message hooks
useConversations()         // DM thread list
useMessages(pubkey)        // Thread with counterparty
```

### React Context
- `AuthContext` - Pubkey, signer connection state

### Dexie (IndexedDB)
- `orders` table - Full order event history
- `messages` table - DM cache for offline access

### localStorage
- Cart items (per merchant)
- Shipping info (for checkout prefill)
- Relay preferences

---

## Cart System

### Data Model (from legacy)

```typescript
// Cart grouped by merchant
interface CartState {
  carts: Map<string, Cart>  // key = merchantPubkey
}

interface Cart {
  merchantPubkey: string
  items: CartItem[]
}

interface CartItem {
  productId: string         // d-tag value
  eventId: string           // Nostr event ID
  name: string
  price: number
  currency: string          // "SAT", "USD", etc
  image?: string
  quantity: number
  tags: string[][]          // Original product tags (for order creation)
}
```

### Cart Hooks

```typescript
useCart()                   // All carts
useCartForMerchant(pubkey)  // Single merchant's cart
useAddToCart()              // Add/update item
useRemoveFromCart()         // Remove item
useClearCart()              // Clear after checkout
useCartTotal()              // Calculate totals
```

### Persistence
- localStorage key: `conduit-market-carts`
- Persist only: carts Map (not actions)
- Clear on successful checkout

---

## Checkout Flow

### State Machine

```
CART → SHIPPING → INVOICE → PAYING → CONFIRMED
  ↓        ↓         ↓         ↓
EMPTY   INVALID   EXPIRED   FAILED
```

### Checkout Steps

1. **Cart Review**
   - Display items grouped by merchant
   - Allow quantity adjustment
   - Show subtotal per merchant

2. **Shipping Info**
   - Name, address, phone, email (optional)
   - Save to localStorage for next time
   - Validate required fields

3. **Order Creation** (per merchant)
   - Generate order ID: `crypto.randomUUID()`
   - Create Kind 16 order event
   - Wrap in NIP-17 (seal + gift wrap)
   - Publish to merchant's relays

4. **Invoice Display**
   - Show QR code + copy button
   - Expiration countdown timer
   - "Retry" button on expiration

5. **Payment Confirmation**
   - Poll for zap receipt (Kind 9735)
   - Or use NWC payment confirmation
   - Update order status in Dexie

6. **Success State**
   - Clear cart for this merchant
   - Show order confirmation
   - Link to order history

### Order Event Structure (Kind 16)

```typescript
// Created in src/lib/nostr/createOrder.ts
const orderEvent = {
  kind: 16,
  tags: [
    ["p", merchantPubkey],
    ["subject", "New Order"],
    ["type", "order"],
    ["order", orderId],
    ["amount", totalSats.toString()],
    // One tag per item
    ["item", `30402:${merchantPubkey}:${productId}`, quantity.toString()],
    // Optional shipping info
    ["shipping", shippingMethod],
    ["address", JSON.stringify(address)],
    ["phone", phone],
    ["email", email],
  ],
  content: "Order message/notes"
}
```

### NIP-17 Wrapping

```
Order Event (Kind 16)
    ↓ encrypt with NIP-44
Seal (Kind 13)
    ↓ encrypt with random key
Gift Wrap (Kind 1059)
    ↓ publish
Merchant's Relays
```

---

## Protocol Events

### Read
- Kind 0: Profiles
- Kind 30402: Product listings
- Kind 1059: Gift-wrapped DMs (decrypt to get order updates)
- Kind 9735: Zap receipts (payment confirmation)

### Publish
- Kind 1059: Gift-wrapped order DMs
- Kind 9734: Zap requests (if using zaps for payment)

---

## Currency Conversion

### useSats Hook (from legacy)

```typescript
interface UseSatsReturn {
  convertToSats: (amount: number, currency: string) => number
  convertToUsd: (sats: number) => number
  convertBetweenCurrencies: (amount: number, from: string, to: string) => number
  satsPerUsd: number
  isLoading: boolean
}

// Rate sources:
// - BTC/USD: mempool.space API (1s cache)
// - Other currencies: open.er-api.com (10s cache)
```

---

## UI Components

### From Legacy (adapt for shadcn/ui)

**Product Display:**
- ProductCard - Image, title, price, merchant avatar, quick add
- ProductGrid - Responsive grid with loading skeletons
- ProductDetail - Gallery, description, variants, add to cart

**Cart:**
- CartDrawer (Sheet) - Slide-out cart summary
- CartItem - Image, name, quantity controls, remove
- CartTotal - Subtotal with currency conversion

**Checkout:**
- ShippingForm - Address fields with validation
- InvoiceDisplay - QR code, copy button, timer
- PaymentStatus - Loading, success, error states

**Orders:**
- OrderCard - Status badge, date, items summary
- OrderTimeline - Status progression visualization

---

## HUD Layer Pattern

From legacy: Floating UI layer for cart drawer that persists across routes.

```typescript
// In TanStack Router, use layout routes
// __root.tsx
export function RootLayout() {
  return (
    <>
      <Header />
      <Outlet />
      <CartDrawer />  {/* Always mounted, controlled by state */}
      <Footer />
    </>
  )
}
```

---

## Deployment

### Cloudflare Pages

| Environment | URL |
|-------------|-----|
| Production | `shop.conduit.market` |
| Preview | `<branch>.conduit-market.pages.dev` |

### Environment Variables

```bash
# Production
VITE_RELAY_URL=wss://relay.conduit.market
VITE_DEFAULT_RELAYS=wss://relay.conduit.market,wss://relay.damus.io
VITE_LIGHTNING_NETWORK=mainnet

# Preview
VITE_RELAY_URL=wss://relay.damus.io
VITE_DEFAULT_RELAYS=wss://relay.damus.io,wss://nos.lol
VITE_LIGHTNING_NETWORK=mutinynet
```

### Build Settings

- Build command: `bun run build`
- Build output: `dist`
- Root directory: `apps/market`

---

## Privacy Constraints

- NO user behavior tracking
- NO message content inspection
- NO cross-session correlation
- System metrics only (relay success, load times)
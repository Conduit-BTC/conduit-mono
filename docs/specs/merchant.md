# Merchant Portal Specification

## Overview

The Merchant Portal is the seller dashboard for managing products, orders, and customer communications. It is the sole interface for merchant-authored product management.

## Reference

**Figma** (Primary - visual design):
```
File: "Conduit High Fi - Website" in Conduit Market Team
URL: https://www.figma.com/design/adfNXYE3nBqr35frkl0b5q
Page: "High Fi - WIP" for Merchant Portal screens
```
- Use Figma MCP tools to extract design context when implementing screens
- Merchant Portal screens: Dashboard, Product creation, Orders, Settings

**Legacy repo** (Secondary - code patterns):
```
/Users/dylangolow/workspace/CONDUIT/merchant-portal
```
- Use for product form structure, order management, event publishing patterns
- Do NOT copy code directly - rebuild with TanStack Router/Query

---

## Core Flows

### Product Management
1. Create product (title, description, images, price)
2. Publish to relays as Kind 30402 event
3. Edit/update existing products (republish)
4. Delete via Kind 5 deletion event

### Order Processing
1. Receive order via NIP-17 DM
2. View order details
3. Generate Lightning invoice (NWC)
4. Confirm payment receipt
5. Mark as fulfilled/shipped

### Communication
1. Unified inbox of buyer conversations
2. Order-linked message threading
3. Reply via signed NIP-17 DMs

---

## Pages

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | DashboardPage | Overview metrics |
| `/products` | ProductsPage | Product list |
| `/products/new` | ProductCreatePage | Create product |
| `/products/$id/edit` | ProductEditPage | Edit product |
| `/orders` | OrdersPage | Order list |
| `/orders/$id` | OrderDetailPage | Single order |
| `/messages` | MessagesPage | DM inbox |
| `/settings` | SettingsPage | Profile, relays, wallet |
| `/settings/profile` | ProfileEditPage | Edit store profile |
| `/settings/relays` | RelaysPage | Relay management |
| `/settings/shipping` | ShippingPage | Shipping options |

---

## Data Layer

### TanStack Query Hooks

```typescript
// Product hooks
useMerchantProducts()       // Own products (Kind 30402)
useProduct(id)              // Single product for editing
useCreateProduct()          // Mutation: publish Kind 30402
useUpdateProduct()          // Mutation: republish Kind 30402
useDeleteProduct()          // Mutation: publish Kind 5

// Order hooks
useMerchantOrders()         // Orders received (from Dexie)
useOrder(orderId)           // Single order detail
useUpdateOrderStatus()      // Mutation: state transition

// Message hooks
useConversations()          // Buyer conversation list
useMessages(buyerPubkey)    // Thread with buyer
useSendMessage()            // Mutation: NIP-17 DM

// Profile hooks
useStoreProfile()           // Own Kind 0 profile
useUpdateProfile()          // Mutation: publish Kind 0

// Shipping hooks
useShippingOptions()        // Kind 30406 options
useCreateShippingOption()   // Mutation
useUpdateShippingOption()   // Mutation
useDeleteShippingOption()   // Mutation: Kind 5
```

### React Context
- `AuthContext` - Merchant authentication state

### Dexie (IndexedDB)
- `orders` table - Order events with local state
- `messages` table - DM cache

---

## Product Management

### Product Form (from legacy)

**Tabbed structure:**
1. **Basic** - Title, price, summary, visibility
2. **Details** - Full description, specs, categories
3. **Images** - Image URLs with drag-to-reorder
4. **Shipping** - Weight, dimensions, shipping options

### Form State

```typescript
interface ProductFormState {
  id: string                    // d-tag value
  title: string
  price: {
    amount: string
    currency: string            // "SAT", "USD", etc
    frequency?: string          // For subscriptions
  }
  summary: string               // Short description
  content: string               // Full markdown description
  stock: string                 // "" = unlimited
  type: {
    type: "simple" | "variable" | "variation"
    physicalType: "digital" | "physical"
  }
  visibility: "hidden" | "on-sale" | "pre-order"
  images: Array<{
    url: string
    dimensions?: string
    order?: number
  }>
  specs: Array<{ key: string; value: string }>
  weight?: { value: string; unit: string }
  dimensions?: { dimensions: string; unit: string }
  categories: string[]
  shippingOptions: Array<{
    reference: string           // Shipping option ID
    extraCost?: string
  }>
}
```

### Product Event (Kind 30402)

```typescript
const productEvent = {
  kind: 30402,
  tags: [
    ["d", productId],           // Unique identifier
    ["title", title],
    ["price", amount, currency],
    ["type", type],             // "simple", "variable", etc
    ["visibility", visibility],
    ["summary", summary],
    ["image", imageUrl],        // Multiple allowed
    ["t", category],            // Multiple allowed
    // Optional
    ["stock", stockCount],
    ["spec", key, value],       // Multiple allowed
    ["weight", value, unit],
    ["dim", dimensions, unit],
    ["shipping", shippingRef, extraCost],
  ],
  content: markdownDescription
}
```

### Validation

Use Conduit's internal schemas (`@conduit/core`) instead of `nostr-commerce-schema`.

Validate the normalized product object before emitting tags/content, and use best-effort parsing for inbound events:
```typescript
import { parseProductEvent, productSchema } from "@conduit/core"

// Inbound (from relays): parse + validate into a stable shape
const product = parseProductEvent(event)

// Outbound (from form state): validate the normalized object before mapping to tags
const res = productSchema.safeParse(candidateProduct)
if (!res.success) throw new Error(res.error.message)
```

### Publishing Flow

1. Convert form state to tags array
2. Validate with `@conduit/core` schemas (e.g. `productSchema.safeParse(...)`)
3. Create NDKEvent with kind 30402
4. Sign with NIP-07/46 signer
5. Publish to relay set
6. Update local store on success

### Deletion Flow

```typescript
const deletionEvent = {
  kind: 5,
  tags: [
    ["e", productEventId],      // Event to delete
    ["k", "30402"],             // Kind being deleted
  ],
  content: ""
}
```

---

## Order Management

### Order States

```
PENDING → PAID → PROCESSING → SHIPPED → DELIVERED
    ↓       ↓        ↓           ↓
CANCELLED  CANCELLED CANCELLED RETURNED
```

### Order Event Types (from legacy)

Received via NIP-17 DMs:

| Type | Description |
|------|-------------|
| `order` | Initial order from buyer |
| `payment_request` | Invoice sent to buyer |
| `status_update` | State transition |
| `shipping_update` | Tracking info |
| `receipt` | Final confirmation |

### Order Data Model

```typescript
interface StoredOrder {
  id: string                    // Event ID
  orderId: string               // Order ID from tags
  buyerPubkey: string
  items: Array<{
    productId: string
    quantity: number
    price: number
  }>
  totalSats: number
  shippingAddress?: Address
  status: OrderStatus
  createdAt: number
  updatedAt: number
  // Local annotations (not on-chain)
  internalNotes?: string
  trackingNumber?: string
  trackingCarrier?: string
}

type OrderStatus =
  | "pending"
  | "paid"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "returned"
```

### Order Actions

**Mark as Paid:**
- Verify payment via NWC or zap receipt
- Update status in Dexie
- Send status_update DM to buyer

**Mark as Shipped:**
- Capture tracking number/carrier
- Update status in Dexie
- Send shipping_update DM to buyer

**Cancel Order:**
- Update status
- Send status_update DM
- (No refund processing in-app)

---

## Messaging

### Inbox Structure

```typescript
interface Conversation {
  counterpartyPubkey: string
  counterpartyProfile?: Profile
  lastMessage: Message
  unreadCount: number
  relatedOrderIds: string[]     // Orders in this conversation
}

interface Message {
  id: string
  content: string
  timestamp: number
  direction: "incoming" | "outgoing"
  orderId?: string              // If order-related
}
```

### Quick Reply Templates

```typescript
const templates = [
  { label: "Order Received", text: "Thank you for your order! I'll send an invoice shortly." },
  { label: "Shipped", text: "Your order has shipped! Tracking: {tracking}" },
  { label: "Delay Notice", text: "Sorry for the delay. Expected ship date: {date}" },
]
```

---

## Store Profile

### Profile Event (Kind 0)

```typescript
interface StoreProfile {
  name: string                  // display_name
  about: string                 // Store description
  picture: string               // Avatar URL
  banner?: string               // Banner image
  nip05?: string                // Verification
  lud16?: string                // Lightning address
  website?: string
}
```

### Relay Management

```typescript
// Relay list (Kind 10002)
const relayListEvent = {
  kind: 10002,
  tags: [
    ["r", "wss://relay.conduit.market"],
    ["r", "wss://relay.damus.io"],
    ["r", "wss://nos.lol"],
  ],
  content: ""
}
```

### Relay Discovery Pattern (from legacy)

```typescript
async function loadProfileWithRelayDiscovery(pubkey: string) {
  // 1. Fetch Kind 10002 for relay list
  const relayList = await fetchRelayList(pubkey)

  // 2. If not found, use PUBLIC_FALLBACK_RELAYS
  const relays = relayList?.length > 0
    ? relayList
    : PUBLIC_FALLBACK_RELAYS

  // 3. Fetch Kind 0 from those relays
  const profile = await fetchProfile(pubkey, relays)

  return profile
}
```

---

## Shipping Options

### Shipping Option Event (Kind 30406)

```typescript
const shippingEvent = {
  kind: 30406,
  tags: [
    ["d", optionId],
    ["title", "Standard Shipping"],
    ["price", "5000", "SAT"],
    ["region", "US"],           // Multiple allowed
    ["eta", "5-7", "days"],
  ],
  content: "Description of shipping option"
}
```

---

## NDK Service Pattern

### Singleton (from legacy)

```typescript
class NDKService {
  private static instance: NDKService | null = null
  private ndk: NDK | null = null

  static getInstance(): NDKService {
    if (!this.instance) {
      this.instance = new NDKService()
    }
    return this.instance
  }

  async initialize(relays: string[]): Promise<NDK> {
    if (this.ndk) return this.ndk

    this.ndk = new NDK({
      explicitRelayUrls: relays,
      signer: new NDKNip07Signer(),
    })

    await this.ndk.connect()
    return this.ndk
  }
}
```

### Event Publishing Pattern

```typescript
async function publishProduct(tags: string[][], content: string) {
  const ndk = await getNdk()

  const event = new NDKEvent(ndk)
  event.kind = 30402
  event.tags = tags
  event.content = content
  event.created_at = Math.floor(Date.now() / 1000)

  await event.sign()
  await event.publish()

  return event
}
```

---

## Deployment

### Cloudflare Pages

| Environment | URL |
|-------------|-----|
| Production | `sell.conduit.market` |
| Preview | `<branch>.conduit-merchant.pages.dev` |

### Environment Variables

```bash
# Production
VITE_RELAY_URL=wss://relay.conduit.market
VITE_LIGHTNING_NETWORK=mainnet

# Preview
VITE_RELAY_URL=wss://relay.damus.io
VITE_LIGHTNING_NETWORK=mutinynet
```

### Build Settings

- Build command: `bun run build`
- Build output: `dist`
- Root directory: `apps/merchant`

---

## Privacy Constraints

- NO buyer behavior analytics
- NO message content inspection
- Operational metrics only (order counts, relay health)
- All buyer data stays on relays

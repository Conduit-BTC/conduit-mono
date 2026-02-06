# Monetization Specification

## Overview

Revenue generation while preserving Conduit's ethos: no surveillance, no lock-in, no rent-seeking on transactions. Users pay for enhanced capabilities and convenience, not for basic access.

**Source**: `context/Conduit Monetization Plan LONG.pdf`

**Related specs:**
- [billing.md](./billing.md) - Technical infrastructure (Supabase schema, APIs, entitlements)

---

## Principles

1. **Value-aligned** - Pay for leverage, not access
2. **Two-sided** - Both shoppers and merchants can subscribe
3. **Sats-denominated** - All pricing in satoshis
4. **No custody** - Credits are like prepaid tokens, not held funds
5. **Privacy-first** - No tracking or profiling to manage memberships
6. **Graceful degradation** - Free tier always works

---

## Revenue Streams Overview

| Stream | Target | Phase |
|--------|--------|-------|
| Shopper Membership | Buyers | Added Value |
| Merchant Membership | Sellers | Added Value |
| Sats Credits | Both | Monetization |
| Sponsored Placements | Merchants | Monetization |
| Store Hosting | Merchants | Added Value |
| Curator Revenue Share | Curators | Scale |

---

## Shopper & Curator Monetization

### Premium Market Membership

Free users get full core functionality. Premium members get enhanced experience.

**Tiers:**

| Tier | Price (approx) | Target |
|------|----------------|--------|
| **Free** | $0 | Casual browsers |
| **Side Hustle** | ~$7/mo (half of Prime) | Regular shoppers |
| **Pro Hustle** | ~$15/mo | Power users |

**Member Benefits:**
- **Ad-Free Browsing** - Hide all sponsored listings
- **Personalized Discovery** - Pin categories, saved searches, default filters
- **NIP-05 Identifier** - `alice@conduit.market` verification
- **Monthly Sats Credits** - Included credit allotment
- **Priority Relay Access** - Faster, more reliable connections

**Implementation:**
- Membership tied to Nostr pubkey (no separate account)
- Payment via Lightning (one-time or recurring)
- Preferences stored client-side or encrypted

### Curated Markets (Affiliates)

Curators create themed "micro-markets" using Store Builder:
- Select products across merchants
- AI generates polished storefront
- Curator earns revenue share from ads on their pages

**Revenue Share:**
- Merchants pay for sponsored placements on curated pages
- Curator receives percentage of ad spend
- No need to track individual sales (simpler than traditional affiliate)

---

## Merchant Monetization

### Merchant Membership Tiers

Core marketplace participation is **free**. Memberships unlock premium tools.

**Tiers:**

| Tier | Price (approx) | Target |
|------|----------------|--------|
| **Free** | $0 | New merchants |
| **Side Hustle** | ~$10/mo | Hobbyist sellers |
| **Pro Hustle** | ~$20-30/mo | Serious businesses |
| **Enterprise** | Custom | High-volume |

*All prices significantly below Shopify ($39/mo) and Etsy.*

**Member Benefits:**

| Feature | Free | Side Hustle | Pro Hustle |
|---------|------|-------------|------------|
| List products | ✅ | ✅ | ✅ |
| Receive orders | ✅ | ✅ | ✅ |
| Monthly credits | - | Base amount | 3× credits |
| Automated orders | - | ✅ | ✅ |
| AI messaging | - | Limited | Full |
| Analytics dashboard | Basic | Enhanced | Premium |
| Priority support | - | - | ✅ |
| Lower credit costs | - | - | ✅ |

### Sats Credit System

Credits are prepaid tokens denominated in sats. Never expire, can be topped up anytime.

**How Credits Work:**
1. Membership includes monthly credit allotment
2. Top up via Lightning or fiat conversion
3. Spend on various services
4. Volume discounts for high usage

**Services That Consume Credits:**

| Service | Description | Cost |
|---------|-------------|------|
| **Automated Order Handling** | Payment confirm, inventory update, shipping label, notify customer | X sats/order |
| **AI Messaging Concierge** | Auto-respond to common inquiries | X sats/message |
| **Advanced Analytics** | Custom reports, sales forecasts | X sats/query |
| **AI Store Generation** | Generate layouts, descriptions, images | X sats/generation |
| **Sponsored Placements** | Boost products in search/browse | Auction-based |
| **Notifications** | SMS/email fallback | X sats/send |

**Confidential Compute:**
All automation runs in secure enclaves - Conduit never sees plaintext message content or sensitive data.

### Store Hosting

**Managed Hosting (Blossom-Backed):**

| Option | Price | Features |
|--------|-------|----------|
| **Subdomain** | $12/mo | `mystore.conduit.market`, SSL, CDN |
| **Custom Domain** | $21/mo | Your domain, DNS management, SSL |

- Blossom media infrastructure for fast global delivery
- Privacy-preserving (no tracking/ads injected)
- Optional - merchants can self-host on Nostr relays

### Advertising / Sponsored Placements

Merchants bid sats for visibility:

| Placement | Description |
|-----------|-------------|
| **Sponsored Products** | Top of search results |
| **Category Sponsor** | Featured in category pages |
| **Homepage Featured** | Rotating banner |
| **Curated Page Sponsor** | Appear on curator collections |

**Rules:**
- All sponsored content clearly labeled
- Fair auction mechanism
- Organic discovery not overshadowed
- Self-serve campaign tools in Merchant Portal

---

## Gamification & Incentives

### Volume Discounts
- First 100 automated actions: X sats each
- Next 100: 0.8× cost
- Pro members get best rates automatically

### Loyalty Rewards
- Bulk credit packages give bonus sats
- High-activity users unlock discounted tiers
- Referral bonuses for bringing new merchants

### Reputation & Identity
- Membership badges on profiles
- NIP-05 verification
- Trust signals that carry across Nostr

### Trial Period
- 1-month free Side Hustle for new merchants
- Starter credit balance (~10 orders worth)
- Credits never expire even after trial ends

---

## Implementation Phases

### MVP (Phases 1-4)
- **No billing** - All features free
- Track usage metrics for future billing
- Build entitlement infrastructure (always returns true)
- Credit balance UI (shows 0, non-functional)

### Added Value Phase
- Introduce membership tiers
- Implement credit system
- Store hosting fees
- Basic ad placements

### Monetization Phase
- Full credit consumption services
- Advanced analytics (paid)
- AI features (paid)
- Curator revenue sharing

### Scale Phase
- Enterprise tier
- Integration marketplace
- Volume-based discounts at scale
- Yield on pooled balances

---

## Technical Requirements

### Entitlement System

```typescript
interface UserEntitlements {
  pubkey: string
  tier: "free" | "side_hustle" | "pro_hustle" | "enterprise"
  creditBalance: number  // in sats
  features: {
    adFree: boolean
    automatedOrders: boolean
    aiMessaging: boolean
    premiumAnalytics: boolean
    priorityRelay: boolean
  }
  hosting?: {
    type: "subdomain" | "custom_domain"
    domain: string
    expiresAt: Date
  }
}
```

### Credit Transactions

```typescript
interface CreditTransaction {
  id: string
  pubkey: string
  type: "topup" | "spend" | "refund" | "bonus"
  amount: number  // sats (positive for add, negative for spend)
  service?: string  // e.g., "automated_order", "ai_message"
  reference?: string  // order ID, etc.
  timestamp: number
}
```

### Billing Service

```
┌─────────────────────────────────────────┐
│           Billing Service               │
├─────────────────────────────────────────┤
│  Entitlements                           │
│  ├── Check tier by pubkey               │
│  ├── Feature gating                     │
│  └── Credit balance                     │
├─────────────────────────────────────────┤
│  Credit System                          │
│  ├── Top-up via Lightning               │
│  ├── Deduct for services                │
│  └── Volume discount calculation        │
├─────────────────────────────────────────┤
│  Subscription Management                │
│  ├── Monthly renewal                    │
│  ├── Credit allotment                   │
│  └── Tier upgrades/downgrades           │
└─────────────────────────────────────────┘
```

---

## Non-Goals (Preserve Trust)

- ❌ Percentage of sales (0% revenue share)
- ❌ Charging for basic browsing/buying
- ❌ Selling user data or behavior
- ❌ Pay-to-win search ranking (organic stays organic)
- ❌ Locking merchants in (data always portable)
- ❌ Custody of user funds
- ❌ Inspecting message content

---

## Key Differences from Original Spec

| Original | New |
|----------|-----|
| Volume-based GMV fees | Membership + credit system |
| 72-hour enforcement | Graceful feature degradation |
| Merchants only | Both shoppers and merchants |
| Simple tiers | Side Hustle / Pro Hustle naming |
| No curator model | Curator revenue sharing |
| No hosting fees | $12-21/mo hosting options |

---

## Open Questions

- [ ] Exact sats pricing per service
- [ ] Credit-to-membership ratio (how many credits per tier)
- [ ] Curator revenue share percentage
- [ ] Confidential compute infrastructure (secure enclaves vs alternatives)
- [ ] Payment rails for fiat-to-sats conversion

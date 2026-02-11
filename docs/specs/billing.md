# Billing Infrastructure Specification

## Overview

Server-side billing infrastructure for membership management, credit system, and entitlement checks. Uses Supabase as the authoritative source of truth, with edge caching for fast entitlement lookups.

**Related specs:**
- [monetization.md](./monetization.md) - Business model, tiers, pricing
- [store-builder.md](./store-builder.md) - Store hosting billing
- [privacy-observability.md](./privacy-observability.md) - Privacy-safe telemetry policy

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Billing Architecture                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Client Apps                         Edge Layer                             │
│  ┌─────────────┐                    ┌─────────────────┐                    │
│  │ Market      │                    │ Cloudflare      │                    │
│  │ Merchant    │───────────────────►│ Worker          │                    │
│  │ Store Builder│  GET /entitlements│ (entitlement    │                    │
│  └─────────────┘                    │  checks)        │                    │
│                                     └────────┬────────┘                    │
│                                              │                              │
│                                              ▼                              │
│                                     ┌─────────────────┐                    │
│                                     │ Cloudflare KV   │                    │
│                                     │ (cache)         │                    │
│                                     │ TTL: 5 min      │                    │
│                                     └────────┬────────┘                    │
│                                              │ cache miss                   │
│                                              ▼                              │
│                                     ┌─────────────────┐                    │
│                                     │ Supabase        │                    │
│                                     │                 │                    │
│                                     │ - memberships   │                    │
│                                     │ - credits       │                    │
│                                     │ - transactions  │                    │
│                                     │ - stores        │                    │
│                                     └─────────────────┘                    │
│                                                                             │
│  Payment Flow                                                               │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                  │
│  │ Lightning   │────►│ Webhook     │────►│ Supabase    │                  │
│  │ Invoice Paid│     │ Handler     │     │ Update      │                  │
│  └─────────────┘     └─────────────┘     └─────────────┘                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Storage Strategy

| Data Type | Storage | Reason |
|-----------|---------|--------|
| Membership state | Supabase | Authoritative, transactional |
| Credit balances | Supabase | Must be tamper-proof |
| Transaction history | Supabase | Audit log, compliance |
| Store records | Supabase | Billing + deployment state |
| Entitlement cache | Cloudflare KV | Fast edge lookups |
| Usage events | PostHog | Analytics, not billing |

### Billing Privacy Boundary

Supabase is used for billing/accounting and entitlements, not user behavior surveillance.

Required constraints:
- No storage of message content, order item details, or payment payloads in analytics tools.
- No user-level behavior timelines for product analytics.
- Billing data may be aggregated for investor reporting (MRR, churn, top-ups, credits spent).
- Any operational telemetry must follow `privacy-observability.md` allowlist rules.

---

## Database Schema (Supabase)

### Memberships

```sql
create table memberships (
  pubkey text primary key,
  tier text not null default 'free'
    check (tier in ('free', 'side_hustle', 'pro_hustle', 'enterprise')),

  -- Credit balance (sats)
  credit_balance bigint not null default 0
    check (credit_balance >= 0),

  -- Subscription dates
  started_at timestamptz,
  expires_at timestamptz,

  -- Monthly credit allotment (set by tier)
  monthly_credits bigint not null default 0,
  last_credit_at timestamptz,

  -- Metadata
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for expiration checks
create index idx_memberships_expires_at on memberships(expires_at);

-- Updated timestamp trigger
create trigger memberships_updated_at
  before update on memberships
  for each row execute function update_updated_at();
```

### Credit Transactions

```sql
create table credit_transactions (
  id uuid primary key default gen_random_uuid(),
  pubkey text not null references memberships(pubkey),

  type text not null
    check (type in ('topup', 'spend', 'refund', 'bonus', 'subscription_credit', 'expire')),

  -- Positive for credits added, negative for spent
  amount bigint not null,

  -- Running balance after this transaction
  balance_after bigint not null,

  -- What service consumed credits (for spend type)
  service text,  -- 'automated_order', 'ai_message', 'analytics_query', 'ai_generation', 'notification'

  -- Reference to related entity
  reference_type text,  -- 'order', 'message', 'store', 'invoice'
  reference_id text,

  -- Payment info (for topup type)
  payment_hash text,  -- Lightning payment hash

  created_at timestamptz not null default now()
);

-- Indexes
create index idx_credit_transactions_pubkey on credit_transactions(pubkey);
create index idx_credit_transactions_created_at on credit_transactions(created_at);
create index idx_credit_transactions_service on credit_transactions(service);
```

### Subscription Invoices

```sql
create table subscription_invoices (
  id uuid primary key default gen_random_uuid(),
  pubkey text not null references memberships(pubkey),

  -- Invoice details
  tier text not null,
  amount_sats bigint not null,

  -- Lightning invoice
  bolt11 text not null,
  payment_hash text not null unique,
  expires_at timestamptz not null,

  -- Status
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'expired', 'cancelled')),
  paid_at timestamptz,

  -- Period this invoice covers
  period_start timestamptz not null,
  period_end timestamptz not null,

  created_at timestamptz not null default now()
);

create index idx_subscription_invoices_pubkey on subscription_invoices(pubkey);
create index idx_subscription_invoices_payment_hash on subscription_invoices(payment_hash);
create index idx_subscription_invoices_status on subscription_invoices(status);
```

### Stores (for Store Builder billing)

```sql
create table stores (
  id text primary key,  -- Generated store ID
  pubkey text not null references memberships(pubkey),

  -- Store identity
  name text unique not null,  -- Subdomain: "my-store"
  display_name text,

  -- Hosting tier
  tier text not null default 'subdomain'
    check (tier in ('subdomain', 'custom_domain', 'self_host')),

  -- Custom domain (for premium tier)
  custom_domain text,
  custom_domain_status text
    check (custom_domain_status in ('pending', 'active', 'failed')),

  -- Cloudflare deployment
  cloudflare_project_id text,
  deployment_url text,
  last_deployed_at timestamptz,

  -- Store configuration (template, branding, layout)
  template text not null,
  config jsonb not null default '{}',

  -- Status
  status text not null default 'draft'
    check (status in ('draft', 'deploying', 'live', 'paused', 'deleted')),

  -- Billing
  billing_started_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_stores_pubkey on stores(pubkey);
create index idx_stores_status on stores(status);
create index idx_stores_custom_domain on stores(custom_domain);
```

### Usage Tracking (for analytics, not billing)

```sql
-- Lightweight table for billing-relevant usage
-- Detailed events go to PostHog
create table usage_summary (
  id uuid primary key default gen_random_uuid(),
  pubkey text not null references memberships(pubkey),

  -- Period
  period_start date not null,
  period_end date not null,

  -- Counts
  automated_orders int not null default 0,
  ai_messages int not null default 0,
  analytics_queries int not null default 0,
  ai_generations int not null default 0,
  notifications_sent int not null default 0,

  -- For volume discount calculation
  total_actions int generated always as (
    automated_orders + ai_messages + analytics_queries + ai_generations + notifications_sent
  ) stored,

  created_at timestamptz not null default now(),

  unique(pubkey, period_start)
);
```

---

## Entitlement API

### Edge Function (Cloudflare Worker)

```typescript
// infrastructure/billing-api/src/entitlements.ts

interface EntitlementRequest {
  pubkey: string
}

interface EntitlementResponse {
  pubkey: string
  tier: "free" | "side_hustle" | "pro_hustle" | "enterprise"
  creditBalance: number
  features: {
    adFree: boolean
    automatedOrders: boolean
    aiMessaging: boolean
    premiumAnalytics: boolean
    priorityRelay: boolean
  }
  limits: {
    aiMessagesPerDay: number | null  // null = unlimited
    analyticsQueriesPerDay: number | null
  }
  subscription: {
    active: boolean
    expiresAt: string | null
  }
}

// Feature matrix by tier
const TIER_FEATURES = {
  free: {
    adFree: false,
    automatedOrders: false,
    aiMessaging: false,
    premiumAnalytics: false,
    priorityRelay: false,
  },
  side_hustle: {
    adFree: true,
    automatedOrders: true,
    aiMessaging: true,  // Limited
    premiumAnalytics: false,
    priorityRelay: false,
  },
  pro_hustle: {
    adFree: true,
    automatedOrders: true,
    aiMessaging: true,  // Unlimited
    premiumAnalytics: true,
    priorityRelay: true,
  },
  enterprise: {
    adFree: true,
    automatedOrders: true,
    aiMessaging: true,
    premiumAnalytics: true,
    priorityRelay: true,
  },
}

const TIER_LIMITS = {
  free: { aiMessagesPerDay: 0, analyticsQueriesPerDay: 0 },
  side_hustle: { aiMessagesPerDay: 50, analyticsQueriesPerDay: 10 },
  pro_hustle: { aiMessagesPerDay: null, analyticsQueriesPerDay: null },
  enterprise: { aiMessagesPerDay: null, analyticsQueriesPerDay: null },
}

export async function getEntitlements(
  pubkey: string,
  env: Env
): Promise<EntitlementResponse> {
  // 1. Check KV cache
  const cacheKey = `entitlements:${pubkey}`
  const cached = await env.BILLING_KV.get(cacheKey, "json")
  if (cached) {
    return cached as EntitlementResponse
  }

  // 2. Fetch from Supabase
  const { data: membership } = await env.SUPABASE
    .from("memberships")
    .select("*")
    .eq("pubkey", pubkey)
    .single()

  // 3. Build response
  const tier = membership?.tier ?? "free"
  const isActive = membership?.expires_at
    ? new Date(membership.expires_at) > new Date()
    : false

  // Downgrade to free if subscription expired
  const effectiveTier = isActive ? tier : "free"

  const response: EntitlementResponse = {
    pubkey,
    tier: effectiveTier,
    creditBalance: membership?.credit_balance ?? 0,
    features: TIER_FEATURES[effectiveTier],
    limits: TIER_LIMITS[effectiveTier],
    subscription: {
      active: isActive,
      expiresAt: membership?.expires_at ?? null,
    },
  }

  // 4. Cache for 5 minutes
  await env.BILLING_KV.put(cacheKey, JSON.stringify(response), {
    expirationTtl: 300,
  })

  return response
}
```

### API Endpoints

```typescript
// GET /api/billing/entitlements
// Returns current user's entitlements
// Auth: Nostr signature in Authorization header

// GET /api/billing/credits
// Returns credit balance and recent transactions
// Auth: Required

// POST /api/billing/credits/topup
// Generate Lightning invoice for credit purchase
// Body: { amount_sats: number }
// Auth: Required

// POST /api/billing/subscribe
// Generate Lightning invoice for subscription
// Body: { tier: "side_hustle" | "pro_hustle" }
// Auth: Required

// GET /api/billing/invoices
// List user's invoices
// Auth: Required

// POST /api/billing/webhook/lightning
// Webhook for Lightning payment confirmation
// Auth: Webhook signature verification
```

---

## Credit Operations

### Spending Credits

```typescript
// packages/core/src/billing/credits.ts

interface SpendCreditsRequest {
  pubkey: string
  amount: number
  service: "automated_order" | "ai_message" | "analytics_query" | "ai_generation" | "notification"
  referenceType?: string
  referenceId?: string
}

async function spendCredits(request: SpendCreditsRequest): Promise<boolean> {
  const { pubkey, amount, service, referenceType, referenceId } = request

  // Atomic transaction: check balance and deduct
  const { data, error } = await supabase.rpc("spend_credits", {
    p_pubkey: pubkey,
    p_amount: amount,
    p_service: service,
    p_reference_type: referenceType,
    p_reference_id: referenceId,
  })

  if (error || !data.success) {
    return false  // Insufficient credits or error
  }

  // Invalidate cache
  await invalidateEntitlementCache(pubkey)

  return true
}
```

### Supabase Function for Atomic Credit Spend

```sql
create or replace function spend_credits(
  p_pubkey text,
  p_amount bigint,
  p_service text,
  p_reference_type text default null,
  p_reference_id text default null
) returns jsonb as $$
declare
  v_balance bigint;
  v_new_balance bigint;
begin
  -- Lock row and get current balance
  select credit_balance into v_balance
  from memberships
  where pubkey = p_pubkey
  for update;

  if v_balance is null then
    return jsonb_build_object('success', false, 'error', 'membership_not_found');
  end if;

  if v_balance < p_amount then
    return jsonb_build_object('success', false, 'error', 'insufficient_credits', 'balance', v_balance);
  end if;

  -- Deduct credits
  v_new_balance := v_balance - p_amount;

  update memberships
  set credit_balance = v_new_balance,
      updated_at = now()
  where pubkey = p_pubkey;

  -- Record transaction
  insert into credit_transactions (
    pubkey, type, amount, balance_after, service, reference_type, reference_id
  ) values (
    p_pubkey, 'spend', -p_amount, v_new_balance, p_service, p_reference_type, p_reference_id
  );

  return jsonb_build_object('success', true, 'new_balance', v_new_balance);
end;
$$ language plpgsql;
```

### Adding Credits (Top-up)

```sql
create or replace function add_credits(
  p_pubkey text,
  p_amount bigint,
  p_type text,  -- 'topup', 'bonus', 'subscription_credit', 'refund'
  p_payment_hash text default null
) returns jsonb as $$
declare
  v_new_balance bigint;
begin
  -- Upsert membership if doesn't exist
  insert into memberships (pubkey, credit_balance)
  values (p_pubkey, p_amount)
  on conflict (pubkey) do update
  set credit_balance = memberships.credit_balance + p_amount,
      updated_at = now()
  returning credit_balance into v_new_balance;

  -- Record transaction
  insert into credit_transactions (
    pubkey, type, amount, balance_after, payment_hash
  ) values (
    p_pubkey, p_type, p_amount, v_new_balance, p_payment_hash
  );

  return jsonb_build_object('success', true, 'new_balance', v_new_balance);
end;
$$ language plpgsql;
```

---

## Subscription Flow

### Subscribe

```
1. User selects tier in app
2. App calls POST /api/billing/subscribe { tier: "side_hustle" }
3. Backend generates Lightning invoice via NWC
4. Returns bolt11 + invoice ID
5. User pays with Lightning wallet
6. Lightning provider sends webhook
7. Backend updates membership tier + expiration
8. Backend adds monthly credit allotment
9. Invalidate entitlement cache
```

### Monthly Renewal

```
1. Cron job checks memberships expiring in 7 days
2. Send reminder DM via NIP-17 (optional)
3. User can renew early in app
4. If not renewed by expiration:
   - Tier downgrades to "free"
   - Features disabled (credits preserved)
   - No hard cutoff - graceful degradation
```

### Credit Allotment

```sql
-- Monthly credit allotment by tier
create or replace function process_monthly_credits() returns void as $$
begin
  update memberships
  set
    credit_balance = credit_balance + monthly_credits,
    last_credit_at = now()
  where
    tier != 'free'
    and expires_at > now()
    and (last_credit_at is null or last_credit_at < now() - interval '30 days');

  -- Record transactions
  insert into credit_transactions (pubkey, type, amount, balance_after)
  select
    pubkey,
    'subscription_credit',
    monthly_credits,
    credit_balance
  from memberships
  where last_credit_at = now();  -- Just updated
end;
$$ language plpgsql;
```

---

## Volume Discounts

Credit costs decrease with usage volume:

```typescript
// Credit cost calculation
function getCreditCost(
  service: string,
  tier: string,
  monthlyUsage: number
): number {
  const baseCosts = {
    automated_order: 100,    // sats
    ai_message: 10,
    analytics_query: 50,
    ai_generation: 500,
    notification: 5,
  }

  const base = baseCosts[service]

  // Volume discount tiers
  let discount = 1.0
  if (monthlyUsage > 100) discount = 0.8
  if (monthlyUsage > 500) discount = 0.6
  if (monthlyUsage > 1000) discount = 0.5

  // Pro tier gets additional 20% off
  if (tier === "pro_hustle" || tier === "enterprise") {
    discount *= 0.8
  }

  return Math.ceil(base * discount)
}
```

---

## Webhook Handler

```typescript
// infrastructure/billing-api/src/webhook.ts

interface LightningWebhook {
  payment_hash: string
  amount_sats: number
  settled: boolean
}

async function handleLightningWebhook(payload: LightningWebhook) {
  if (!payload.settled) return

  // Find invoice by payment hash
  const { data: invoice } = await supabase
    .from("subscription_invoices")
    .select("*")
    .eq("payment_hash", payload.payment_hash)
    .eq("status", "pending")
    .single()

  if (!invoice) {
    // Check if it's a credit top-up
    // Handle accordingly
    return
  }

  // Update invoice status
  await supabase
    .from("subscription_invoices")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("id", invoice.id)

  // Update membership
  await supabase
    .from("memberships")
    .upsert({
      pubkey: invoice.pubkey,
      tier: invoice.tier,
      started_at: invoice.period_start,
      expires_at: invoice.period_end,
      monthly_credits: TIER_MONTHLY_CREDITS[invoice.tier],
      updated_at: new Date().toISOString(),
    })

  // Add initial credit allotment
  await supabase.rpc("add_credits", {
    p_pubkey: invoice.pubkey,
    p_amount: TIER_MONTHLY_CREDITS[invoice.tier],
    p_type: "subscription_credit",
    p_payment_hash: payload.payment_hash,
  })

  // Invalidate cache
  await invalidateEntitlementCache(invoice.pubkey)
}
```

---

## Client Integration

### React Hook

```typescript
// packages/core/src/hooks/useEntitlements.ts

import { useQuery } from "@tanstack/react-query"

export function useEntitlements() {
  const { pubkey } = useAuth()

  return useQuery({
    queryKey: ["entitlements", pubkey],
    queryFn: () => fetchEntitlements(pubkey),
    enabled: !!pubkey,
    staleTime: 5 * 60 * 1000,  // 5 minutes (matches server cache)
  })
}

export function useCanUseFeature(feature: keyof EntitlementResponse["features"]) {
  const { data: entitlements } = useEntitlements()
  return entitlements?.features[feature] ?? false
}

export function useCreditBalance() {
  const { data: entitlements } = useEntitlements()
  return entitlements?.creditBalance ?? 0
}
```

### Feature Gating Component

```typescript
// packages/ui/src/components/FeatureGate.tsx

interface FeatureGateProps {
  feature: keyof EntitlementResponse["features"]
  children: React.ReactNode
  fallback?: React.ReactNode
}

export function FeatureGate({ feature, children, fallback }: FeatureGateProps) {
  const canUse = useCanUseFeature(feature)

  if (!canUse) {
    return fallback ?? <UpgradePrompt feature={feature} />
  }

  return <>{children}</>
}

// Usage:
// <FeatureGate feature="premiumAnalytics">
//   <AnalyticsDashboard />
// </FeatureGate>
```

---

## MVP Implementation

During MVP (Phases 1-4), billing is stubbed:

```typescript
// packages/core/src/billing/entitlements.ts

export function getEntitlements(pubkey: string): EntitlementResponse {
  // MVP: Everyone gets full access
  return {
    pubkey,
    tier: "pro_hustle",
    creditBalance: 999999,  // Effectively unlimited
    features: {
      adFree: true,
      automatedOrders: true,
      aiMessaging: true,
      premiumAnalytics: true,
      priorityRelay: true,
    },
    limits: {
      aiMessagesPerDay: null,
      analyticsQueriesPerDay: null,
    },
    subscription: {
      active: true,
      expiresAt: null,
    },
  }
}
```

**MVP tracking (for future pricing):**
- PostHog tracks all potentially-billable actions
- No actual charges or credit deductions
- Data informs pricing decisions

---

## Supabase Project Setup

```bash
# Create project (use supabase-personal or new project)
# Run migrations
supabase db push

# Set up Edge Functions for webhook
supabase functions deploy billing-webhook

# Environment variables
supabase secrets set LIGHTNING_WEBHOOK_SECRET=xxx
```

---

## Security

### Authentication

All billing endpoints require Nostr signature:

```typescript
// Verify request signature
async function verifyNostrAuth(request: Request): Promise<string | null> {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Nostr ")) return null

  const event = JSON.parse(atob(authHeader.slice(6)))

  // Verify signature
  if (!verifySignature(event)) return null

  // Check timestamp (within 5 minutes)
  if (Math.abs(Date.now() / 1000 - event.created_at) > 300) return null

  // Check kind (27235 for HTTP auth per NIP-98)
  if (event.kind !== 27235) return null

  return event.pubkey
}
```

### Row-Level Security

```sql
-- Users can only read their own data
alter table memberships enable row level security;

create policy "Users can read own membership"
  on memberships for select
  using (pubkey = current_setting('app.current_pubkey'));

create policy "Users can read own transactions"
  on credit_transactions for select
  using (pubkey = current_setting('app.current_pubkey'));

create policy "Users can read own stores"
  on stores for select
  using (pubkey = current_setting('app.current_pubkey'));
```

---

## Monitoring

### Alerts

- Credit balance approaching zero
- Subscription expiring (7 days, 1 day)
- Payment failures
- Unusual spending patterns

### Metrics (PostHog)

```typescript
// Track billing events (aggregate only)
track("subscription_started", { tier })
track("subscription_renewed", { tier })
track("subscription_expired", { tier })
track("credits_purchased", { amount_sats })
track("credits_spent", { service, amount_sats })
```

---

## Open Questions

- [ ] Exact sats pricing per service
- [ ] Monthly credit allotment per tier
- [ ] Volume discount thresholds
- [ ] Grace period length for expired subscriptions
- [ ] Refund policy for unused credits
- [ ] Enterprise tier pricing model

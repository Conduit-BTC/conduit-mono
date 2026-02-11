# Privacy & Observability Specification

## Goal

Provide investor-grade proof of product usage and business health without user surveillance.

## Principles

1. Default-off telemetry in product clients.
2. Aggregate metrics over user-level tracking.
3. No persistent identifiers for product analytics.
4. No storage of message/order/payment content in telemetry systems.
5. Centralized billing is allowed for accounting and entitlements only.

## Data Classes

### Public Protocol Metrics (preferred)

Computed from public relay events and app-level public data:
- Total product listings
- Active merchants (count of unique merchant pubkeys over period)
- Order event volume
- Shipping/status update volume

These metrics are aggregate-only and require no private profile of users.

### Operational Metrics (optional, default-off)

Anonymous reliability and performance counters:
- App load success/failure counts
- Relay connect/publish success rates
- Latency buckets (`<100ms`, `100-500ms`, `>500ms`)
- Error counts by category

Allowed fields:
- `event_name`, `app`, `network`, `status`, `latency_bucket`, `count`, `time_bucket`

Disallowed fields:
- pubkey/npub/nsec
- message content
- order items or titles
- invoice strings/payment requests
- contact/address data
- IP address or fingerprint fields

### Billing & Revenue Metrics (centralized, allowed)

Centralized data for monetization and accounting:
- Active subscriptions by tier
- MRR/ARR
- Credit top-ups and credit spend totals
- Churn and renewal rates

Constraint:
- Billing tables must not be used to reconstruct behavior timelines of specific users for product analytics.

## Allowed Tooling

- `Plausible` (optional): aggregate traffic only, no custom user identifiers.
- `PostHog` (optional): operational events and feature flags only; self-hosted preferred.
- Self-hosted stack strongly preferred for both.

## Investor Dashboard Requirements

Expose only aggregate KPIs:
- Weekly active merchants (aggregate)
- Weekly order-event count
- Product catalog growth
- Checkout success rate (aggregate)
- MRR and credit economy metrics

No per-user journey replay, no identity-level drilldowns.

## Enforcement

1. Maintain telemetry event allowlist in code/docs.
2. CI check to block banned telemetry SDKs unless explicitly approved.
3. Production defaults:
   - telemetry disabled unless `ENABLE_TELEMETRY=true`
   - high-verbosity logs disabled
4. Document retention windows and redaction policy.

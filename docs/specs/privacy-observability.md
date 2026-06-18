# Privacy & Observability Specification

## Goal

Provide aggregate proof of product usage, reliability, and business health without user surveillance.

## Principles

1. Default-off telemetry in product clients.
2. Aggregate metrics over user-level tracking.
3. No persistent identifiers for active users in product analytics.
4. Public commerce page identifiers may be used only as sanitized page context for aggregate storefront performance reporting.
5. No storage of message/order/payment content in telemetry systems.
6. Future centralized billing, if accepted under a separate service boundary, is allowed for accounting and entitlements only.

## Identity Boundary

Telemetry must distinguish active user identity from public page identity.

Active user identity means signer, buyer, wallet, session, or connected account
context. Product clients must not send active user pubkeys, npubs, nsecs,
wallet pubkeys, signer connection strings, NWC URIs, or any stable identifier
that can reconstruct a viewer journey.

Public page identity means an address already used to render a public commerce
surface, such as a storefront route identified by a store npub. A public store
npub may appear only in sanitized route context such as `page_path` or
`page_url`, and only for aggregate storefront/page reporting. It must not be
copied into custom identity fields, joined to active user identity, used for
per-viewer drilldowns, or used to infer what that store owner is doing in an
authenticated session.

## Data Classes

### Public Protocol Metrics (preferred)

Computed from public relay events and app-level public data:

- Total product listings
- Active merchants (count of unique merchant pubkeys over period)
- Order event volume
- Shipping/status update volume

These metrics are aggregate-only and require no private profile of users.

### Operational Metrics (optional, default-off)

Anonymous reliability, performance, and public commerce page counters:

- App load success/failure counts
- Relay connect/publish success rates
- Latency buckets (`<100ms`, `100-500ms`, `>500ms`)
- Error counts by category
- Storefront pageview and browse-action counts by sanitized public store route

Allowed fields:

- `event_name`, `app`, `page_url`, `page_path`, `network`, `status`,
  `latency_bucket`, `count`, `time_bucket`, `surface`, `action`, `step`,
  `mode`, `rail`, `method`, `event_family`, `count_bucket`,
  `result_count_bucket`, `amount_bucket`, `product_type`

Disallowed fields:

- active user, signer, buyer, wallet, or session pubkey/npub/nsec
- message content
- order items or titles
- invoice strings/payment requests
- contact/address data
- IP address or fingerprint fields

Permitted public page context:

- sanitized storefront route context may include the public store npub in
  `page_path` or `page_url`
- product, profile, order, query string, unknown route, and active user
  identifiers must remain redacted

### Future Billing & Revenue Metrics

Centralized data for monetization and accounting is future service scope, not a current `conduit-mono` client requirement:

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

## Aggregate Reporting Requirements

Expose only aggregate KPIs:

- Weekly active merchants (aggregate)
- Storefront page performance by public store route (aggregate)
- Weekly order-event count
- Product catalog growth
- Checkout success rate (aggregate)
- MRR and credit economy metrics

No per-user journey replay, no active-user identity drilldowns, and no joining
public page performance data to signer, buyer, wallet, or session identity.

## Enforcement

1. Maintain telemetry event allowlist in code/docs.
2. CI check to block banned telemetry SDKs unless explicitly approved.
3. Production defaults:
   - telemetry disabled unless `ENABLE_TELEMETRY=true`
   - high-verbosity logs disabled
4. Document retention windows and redaction policy.

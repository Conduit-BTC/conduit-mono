# Privacy & Observability Specification

## Goal

Provide aggregate proof of product usage and reliability without user surveillance.

## Principles

1. Default-off telemetry in product clients.
2. Aggregate metrics over user-level tracking.
3. No persistent identifiers for active users in product analytics.
4. Public commerce page identifiers may be used only as sanitized page context for aggregate storefront performance reporting.
5. No storage of message/order/payment content in telemetry systems.
6. Product clients and telemetry stay cookieless.

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

## Public Zap Message Boundary

Public zap requests and receipts are public protocol content. When product
policy allows a public zap payment, client-generated public comment text must
stay within the merchant's selected policy and must not include order contents,
cart contents, shipping/contact data, invoices, payment request strings,
private message contents, signer details, wallet connection details, or active
buyer identity. Generic public comments may include item count only; public
listing context is included only when the shopper writes a custom public
comment.

## Cookieless Client Policy

Conduit product clients should not set or depend on cookies for app behavior,
telemetry, or support diagnostics.

- No `document.cookie` or Cookie Store API usage in Market, Merchant,
  placeholder app shells, shared UI, or shared client code.
- No `Set-Cookie` headers from Conduit-operated app surfaces unless a future
  spec change approves a narrow non-tracking infrastructure exception.
- No cookie-setting analytics SDKs, ad pixels, retargeting pixels, session
  replay, cross-context behavioral tracking, or browser fingerprinting.
- Telemetry, when enabled, must remain default-off, aggregate-only, cookieless,
  and free of persistent product analytics identifiers.
- Operational monitoring may collect system counters only, such as app load
  success/failure counts, relay connect/publish success rates, latency buckets,
  and error counts by category.
- Honor Global Privacy Control as a privacy signal where applicable.

## Allowed Tooling

- `Plausible` (optional): aggregate traffic only, no custom user identifiers,
  no automatic pageview capture, and no cookies.
- `PostHog` (optional): operational events and feature flags only; self-hosted
  preferred, memory-only persistence, no person profiles, no session replay,
  and no heatmaps.
- Self-hosted stack strongly preferred for both.

## Aggregate Reporting Requirements

Expose only aggregate KPIs:

- Weekly active merchants (aggregate)
- Storefront page performance by public store route (aggregate)
- Weekly order-event count
- Product catalog growth
- Checkout success rate (aggregate)

No per-user journey replay, no active-user identity drilldowns, and no joining
public page performance data to signer, buyer, wallet, or session identity.

## Enforcement

1. Maintain telemetry event allowlist in code/docs.
2. CI check to block banned telemetry/cookie SDKs unless explicitly approved.
3. CI/static checks block cookie APIs and `Set-Cookie` usage in client source.
4. Production defaults:
   - telemetry disabled unless `ENABLE_TELEMETRY=true`
   - high-verbosity logs disabled
5. Document retention windows and redaction policy.

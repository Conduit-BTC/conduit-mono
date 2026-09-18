# Privacy & Observability Specification

## Goal

Provide aggregate proof of product usage and reliability without user surveillance.

## Principles

1. Default-off telemetry in product clients.
2. Aggregate metrics over user-level tracking.
3. No persistent identifiers for active users in product analytics.
4. Public commerce page identifiers may be used only as sanitized page context for aggregate storefront and product performance reporting.
5. No storage of message/order/payment content in telemetry systems.
6. Product clients and telemetry stay cookieless.

The exact Product legal paths `/privacy-policy` and `/terms-of-service` are a
hard no-telemetry boot boundary. Direct loads must bypass signer restoration,
sessions, Nostr connections, cache/worker maintenance, pricing, readiness,
payment automation, and every telemetry provider or queue.

## Identity Boundary

Telemetry must distinguish active user identity from public page identity.

Active user identity means signer, buyer, wallet, session, or connected account
context. Product clients must not send active user pubkeys, npubs, nsecs,
wallet pubkeys, signer connection strings, NWC URIs, or any stable identifier
that can reconstruct a viewer journey.

Public page identity means an address already used to render a public commerce
surface. This includes a storefront route identified by a store npub and a
kind-30402 product route identified by a canonical public naddr. A public store
npub may appear only in sanitized route context such as `page_path` or
`page_url`. A product naddr may appear only in `$pageview` route context. Every
custom event, error event, `$pageleave`, and `$web_vitals` event must redact the
product route as `/products/:productId`. Neither public page identifier may be
copied into custom identity fields, joined to active user identity, used for
per-viewer drilldowns, or used to infer what a merchant is doing in an
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
- Product pageview counts by sanitized canonical public product route

### Verified Public-Zap Settlement Volume (optional, server-only)

After the existing receipt-authority boundary positively verifies a public
NIP-57 receipt for a Conduit Zap Out, the server may emit one
`zapout_settled` event. Its only business property is the exact positive
whole-satoshi amount proven equal across the authorized request, BOLT11
invoice, and paid receipt.

This is a narrow exception to the bucket-only amount rule for browser and
operational telemetry. The event must:

- use a shared static service identity with PostHog person-profile processing
  disabled;
- round its event timestamp to the UTC calendar day;
- use a secret-key-derived opaque event UUID only to deduplicate the same
  verified receipt;
- prevent the raw receipt identifier and HMAC secret from leaving the server;
- prevent PostHog from recording the requesting browser's IP address; and
- omit buyer, merchant, signer, wallet, session, order, product, public key,
  route, URL, comment, invoice, payment hash, preimage, receipt, relay,
  connection, fee, and payment-rail data.

Invalid, authority-unavailable, unpaid, private-checkout, and non-Zap-Out
flows must not emit the event. Capture is best effort and must not control
payment, proof delivery, order state, or retry behavior. Exact amounts can be
distinctive and public zap receipts are public protocol data, so reporting is
privacy-minimized rather than guaranteed unlinkable. Aggregate reporting must
describe the resulting metric as observed verified public-Zap-Out volume and a
possible undercount, not total platform sales, merchant revenue, or funds
processed by Conduit.

Allowed fields:

- `event_name`, `app`, `page_url`, `page_path`, `network`, `status`,
  `latency_bucket`, `count`, `time_bucket`, `surface`, `action`, `step`,
  `mode`, `rail`, `method`, `event_family`, `count_bucket`,
  `result_count_bucket`, `amount_bucket`, `product_type`

The server-only `zapout_settled` event additionally allows
`settled_amount_sats` under the constraints above. No other event may use that
field or send an exact payment amount.

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
- `$pageview` product route context may include a canonical kind-30402 naddr in
  `page_path` or `page_url`; canonicalization must remove relay hints
- every non-pageview event must use `/products/:productId`
- invalid product references must use `/products/:productId`
- profile, order, query string, unknown route, and active user identifiers must
  remain redacted

## Historical Analytics and Live Presence

Historical pageview analytics and live presence are separate systems.

- Historical `$pageview` events may retain the permitted public page route
  under the configured provider retention policy.
- Historical dashboards must report pageviews or anonymous sessions. They must
  not describe those metrics as exact concurrent visitors or unique people.
- Live presence may count active connections for one public product or store
  scope. A product page may join its item-specific product scope and the public
  merchant's store scope. The store count may aggregate active storefront and
  product connections for that merchant. It must not persist visit history or
  send presence events to PostHog.
- Live presence must not receive or reuse telemetry session IDs, pageview IDs,
  active user identifiers, cookies, fingerprints, or persistent viewer IDs.
- The edge may derive a secret-keyed source hash from Cloudflare's connection
  address only to enforce a concurrent socket limit. It must discard the raw
  address before the gateway request. The hash may exist only in an active
  socket attachment. It must not enter logs, analytics, responses, durable
  records, or page-level visit history.
- An exact live value means the current active connection count known to the
  service, including the current visible page. Multiple tabs, browsers, or
  devices can count separately.
- Clients must disconnect when the page is hidden or offline and must honor
  Global Privacy Control. A failed or unavailable count stays hidden.
- Clients may send only a deployment-scoped opaque room hash and a fixed,
  content-free heartbeat. The service may return only the current integer count
  or fixed heartbeat response and must not use durable storage. Clients must
  hide stale counts when the heartbeat response expires.
- The room hash reduces accidental identifier exposure in infrastructure URLs.
  It is not authentication and does not hide a public page from a determined
  observer.
- Exact low counts expose activity timing and unauthenticated sockets can
  inflate them. Exact presence stays enabled only on previews. Production and
  staging remain disabled until a maintainer approves explicit privacy and
  abuse controls, such as a minimum threshold and bounded count buckets.

## Public Zap Message Boundary

Public zap requests and receipts are public protocol content. When product
policy allows a public zap payment, client-generated public comment text must
stay within the merchant's selected policy and must not include order contents,
cart contents, shipping/contact data, invoices, payment request strings,
private message contents, signer details, wallet connection details, or active
buyer identity. Anonymous public comments are limited to fixed item-count copy
such as `Zapped out 1 item at https://shop.conduit.market/` or
`Zapped out 4 items at https://shop.conduit.market/`; the public shop URL is
intentional protocol content. Other public listing context is included only
when the shopper writes and signs a custom public comment.

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

- `Plausible` (legacy, nonofficial/dev only): aggregate traffic only, no custom
  user identifiers, no automatic pageview capture, and no cookies. Official
  Product hosts disable this provider.
- `PostHog` (optional): allowlisted operational events only; sessionStorage-only
  SDK state, no person profiles, no feature flags, no session replay, and no
  heatmaps. Official Product hosts pin browser ingestion to the constrained
  Conduit telemetry proxy even if a build-time host override is present.
- Self-hosted stack strongly preferred for both.

## Aggregate Reporting Requirements

Expose only aggregate KPIs:

- Weekly active merchants (aggregate)
- Storefront page performance by public store route (aggregate)
- Product pageview counts by canonical public product route (aggregate)
- Weekly order-event count
- Product catalog growth
- Checkout success rate (aggregate)
- Observed verified public-Zap-Out settled volume in sats (aggregate,
  best-effort lower bound)

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

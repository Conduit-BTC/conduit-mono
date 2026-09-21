# Telemetry Event Allowlist

Conduit telemetry is privacy-constrained measurement only. Product clients must
remain useful without optional browser analytics, and those analytics must stay
disabled unless a deployment explicitly enables them. The separately
contracted first-party commerce GMV measurement is activated only when its
Worker secret and rate-limit bindings are configured.

## Allowed Properties

Runtime telemetry events may only use these fields:

- `event_name`
- `app`
- `page_url`
- `page_path`
- `network`
- `status`
- `latency_bucket`
- `count`
- `time_bucket`
- `surface`
- `action`
- `step`
- `mode`
- `rail`
- `method`
- `event_family`
- `count_bucket`
- `result_count_bucket`
- `amount_bucket`
- `estimated_gmv_sats` (Worker-emitted on the two GMV events only)
- `product_type`
- `declaration_class`
- `delivery_route`
- `ack_outcome`
- `repair_outcome`
- `block_reason`

## Retention and Redaction

PostHog Cloud currently reports a plan-managed event retention window of 84
months. The provider controls that field and does not expose it as a mutable
project setting. This longer provider window is acceptable only while every
event uses the shared service identity, any session linkage remains ephemeral
and non-identifying, and every property passes the allowlist and redaction
controls in this document. Maintainers must review the provider window at least
quarterly and select a shorter plan or self-hosted retention policy when
PostHog makes one available.

The first-party aggregate GMV measurement is deliberately narrower than
optional browser telemetry and follows its own policy. Official Shop and Sell
clients may report it even when generic browser telemetry is disabled or Global
Privacy Control is enabled. Conduit uses it only for aggregate commerce
measurement, not sale or sharing of personal information, cross-context
behavioral advertising, person profiles, or actor identification.

The Worker immediately transforms the raw random order UUID with a dedicated
HMAC secret. In daily mode, the HMAC input and domain are also scoped to the UTC
order date. One SQLite-backed Durable Object per UTC order day stores only the
opaque per-order fingerprint needed for deduplication, plus the day's aggregate
total and delivery revision. It never stores a per-order amount. Active
deduplication state is deleted 30 days after the end of the UTC order day even
if a final best-effort provider delivery fails; Cloudflare's SQLite
point-in-time recovery may retain restorable database state for its separate
provider recovery window.

Before daily aggregation is activated, the bounded legacy path sends PostHog
one opaque per-order UUID, the estimated amount, the UTC order date, and the
same static service identity. It does not send the raw order UUID or an actor
identifier.

After activation, PostHog receives `commerce_gmv_estimated_daily` as immutable
aggregate revision snapshots. Each snapshot contains a deterministic opaque
revision UUID, the positive whole-satoshi daily total, the UTC day as its
rounded timestamp, and one static service identity. Person profiles and
provider IP capture are disabled. The first snapshot is scheduled 12 hours
after the UTC day closes; later reconciliation is batched into fixed 12-hour
windows. A failed or ambiguous delivery retries the exact frozen snapshot with
the same UUID; a later revision uses a different UUID. It receives no per-order
fingerprint or amount. The raw order UUID is transient inside the request
handler and never reaches Durable Object storage or PostHog. Consumers must
select the greatest `estimated_gmv_sats` snapshot for each UTC day and must
never sum the revision snapshots.

Production activation requires the PostHog proxy Worker to provide both
`POSTHOG_PROJECT_TOKEN` and a random, secret-store-only
`COMMERCE_GMV_TELEMETRY_HMAC_SECRET` of at least 32 characters. Keep that secret
stable across deployments so all qualifying observations of one order retain
one deduplication key. The Worker also requires its configured global and
per-order rate-limit bindings, Durable Object binding and migration, and an
explicit UTC cutover date. Before activation, no cutover preserves the legacy
path. Initial activation requires a strictly future UTC day so traffic already
accepted on the legacy grain cannot overlap. The first valid cutover is durably
latched; later removal keeps the latch active, and a conflicting or invalid
value fails closed. Missing Durable Object bindings also fail closed without
affecting commerce or payment state. After configuring the future date, an
operator must call the content-free Worker health route before that date begins;
the successful check latches the cutover without creating a GMV observation.

Redaction happens before provider delivery. Events that fail the event-name or
property allowlist must be dropped rather than repaired downstream. Browser
events must remove raw paths, query strings, SDK-generated device/window
properties, IP/fingerprint properties, and active-user identifiers. The only
allowed SDK journey properties are UUIDv7 `$session_id`, `$pageview_id`, and
`$prev_pageview_id` values used to calculate anonymous session metrics, plus a
sanitized `$prev_pageview_pathname` route class on `$pageleave`. Worker events
must construct a new payload from the documented property allowlist and must
never spread request-derived properties into a provider payload. If an event
outside this contract is ingested, delete it from the provider and treat the
incident as a telemetry-policy failure.

## PostHog Dashboard Split

PostHog dashboards should split Market and Merchant traffic with the shared
`app` property. Use `app = market` for Market client panels and
`app = merchant` for Merchant Portal panels. Do not use PostHog identity,
grouping, person profile, or session replay features to create this split.
PostHog project settings must discard IP data. Browser capture uses
sessionStorage-only SDK state, one static browser-service distinct ID, and
disabled person-profile processing. A random session ID may link events within
one anonymous visit, but it must rotate after 30 minutes of inactivity, expire
within 24 hours, and never be promoted into a person or cross-session
identifier. Dashboards must label these counts as sessions, not users or
visitors. Do not enable PostHog's server-hashed cookieless mode for Conduit
events because it requires raw IP, host, and user-agent inputs that this
telemetry policy excludes.

## Product Legal Route Exclusion

Direct loads of `/privacy-policy` and `/terms-of-service` in Market and Merchant
must bypass product telemetry completely. They also bypass signer restoration,
Conduit sessions, Nostr connections, cache pruning, deletion-delivery workers,
BTC price warmups, merchant readiness, and payment automation. Keep the exact
legal-path allowlist in `@conduit/ui`; do not classify these routes for pageview
or error telemetry. Links into and between Product legal pages use ordinary
full-document anchors so a navigation rebuilds the correct provider boundary.

Do not include active user, signer, buyer, wallet, or session pubkeys/npubs,
invoices, order contents, product titles, addresses, message contents, IPs,
fingerprints, signer connection strings, NWC URIs, raw URLs, raw paths, query
strings, cross-session identifiers, or SDK window/device identifiers. Browser
custom events may include only shared-helper route context through `page_url`
and `page_path`. Store route context may include the public store `npub`.
Only `$pageview` may include a canonical public kind-30402 product `naddr` with
no relay hints. The pageview sanitizer derives that `naddr` from a valid raw
coordinate or existing `naddr`. Every custom event, error event, `$pageleave`,
and `$web_vitals` event must use `/products/:productId`. The ingestion proxy
enforces this event-specific boundary. It verifies the naddr checksum and
requires relay-free canonical re-encoding before accepting a product-attributed
`$pageview`.
Profile, order, query string, unknown route, and active user identifiers stay
redacted. Public store npubs must not be copied into custom properties or
joined to viewer identity. Product naddrs must not appear outside `$pageview`
route context.

## Historical Pageviews and Live Presence

PostHog `$pageview` events provide historical pageview counts. A valid product
page is attributed to `/products/<canonical-naddr>`, and a valid storefront is
attributed to `/store/<canonical-npub>`. These retained pageviews are anonymous
session metrics. They are not an exact concurrent count or a count of unique
people.

Live product and storefront counts use a separate ephemeral presence path.
Live presence must not send events to PostHog, reuse PostHog session or
pageview IDs, or retain a page-level visit history. An exact live count means
active visible-page connections known to that service, including the current
page. A product page joins its product room and its merchant's store room. The
product count remains item-specific. The storefront count includes active
storefront connections and active product connections for that public merchant.
Separate tabs, browsers, or devices can count separately. The edge may
use a secret-keyed, connection-lifetime source hash only to enforce the socket
limit. It must discard the raw network address before the presence gateway and
must not log, return, retain, or join the hash to analytics. The exact-count
feature uses a fixed content-free heartbeat and hides a count when the
connection stops responding. It is preview-only; production and staging keep
it disabled pending explicit privacy and abuse-control approval.

## Provider Lifecycle Events

Three PostHog lifecycle events are allowed through the shared sanitizer:

- `$pageview` uses the static browser-service distinct ID, sanitized route
  context, app, and ephemeral UUIDv7 session/pageview IDs. Permitted public
  product and store route identifiers support aggregate page-level reporting.
- `$pageleave` adds bounded duration and scroll/content percentages so bounce
  rate and session duration can be calculated. Its route fields and
  `$prev_pageview_pathname` identify the departing sanitized route class.
  Pixel coordinates, raw paths, and SDK window/device fields are dropped.
- `$web_vitals` keeps only finite bounded CLS, FCP, INP, and LCP numeric values,
  app, sanitized route class, and the ephemeral session ID. Nested metric
  events, DOM attribution, element data, metric IDs, window IDs, and browser
  metadata are dropped.

The SDK must keep automatic interaction capture, exception capture, network
timing, Web Vitals attribution, heatmaps, and session recording disabled.
Session storage is the only allowed PostHog persistence mechanism; cookies and
localStorage remain prohibited. The SDK must bootstrap with the shared static
browser-service identity rather than generating a device identifier, and it
must not retain campaign parameters or referrer data.

Browser ingestion is routed through the origin-restricted
`e.conduit.market` Worker. The proxy accepts only PostHog event-ingestion paths
from the exact Market and Merchant production origins. Cloudflare Pages
previews, branch deployments, local apps, and every other nonofficial origin
must be rejected before payload processing. The proxy must not forward cookies,
browser user-agent, `CF-Connecting-IP`, `X-Forwarded-For`, or other identity
headers, and it must not cache or log request payloads. It must reject ingest
bodies larger than 1 MiB before forwarding them upstream.

The official Shop and Sell hosts disable the legacy Plausible integration and
pin PostHog ingestion to `e.conduit.market`; build-time provider overrides do
not widen that official-host boundary. The browser discards PostHog
configuration before loading the SDK unless the runtime hostname and app are
the exact official pair: `shop.conduit.market` for Market or
`sell.conduit.market` for Merchant. Accidentally inherited enablement,
allowlists, project keys, or provider hosts therefore cannot activate PostHog
on a nonofficial or cross-app host. Nonofficial and local test hosts may use the
legacy Plausible configuration only within their explicit telemetry host
allowlist.

## Events

<!-- telemetry-event: app_load_result properties=event_name,app,page_url,page_path,network,status,latency_bucket,count,time_bucket -->

### `app_load_result`

Emitted as an aggregate operational counter when an app load succeeds or fails.

<!-- telemetry-event: client_error_result properties=event_name,app,page_url,page_path,surface,action,event_family,mode,status -->

### `client_error_result`

Emitted for aggregate browser runtime errors, unhandled promise rejections, and
React error-boundary failures. It records only bounded source, error-family,
handled-state, and outcome enums plus the shared sanitized route context. It
must never include exception messages, stacks, code locations, console output,
breadcrumbs, query strings, user-agent data, user or signer identity, product
or order data, payment or wallet data, shipping or contact data, or any other
free text. Identical source/family/route combinations are deduplicated for ten
seconds, and each app emits at most five client-error events per minute.

PostHog's built-in exception capture and console-log recording remain disabled;
this bounded event is the only approved client-error capture path.

<!-- telemetry-event: signer_connected properties=event_name,app,page_url,page_path,method,status,count,time_bucket -->

### `signer_connected`

Emitted when Market or Merchant reaches a connected browser signer state. It may
record signer method class, such as `nip07`, but must not include signer
identity or pubkey data.

<!-- telemetry-event: signer_disconnected properties=event_name,app,page_url,page_path,method,status,count,time_bucket -->

### `signer_disconnected`

Emitted when Market or Merchant transitions from a connected browser signer
state to disconnected. It may record signer method class, such as `nip07`, but
must not include signer identity or pubkey data.

<!-- telemetry-event: cart_add properties=event_name,app,page_url,page_path,surface,action,status,count_bucket,product_type,time_bucket -->

### `cart_add`

Emitted when a buyer adds or increments an item in the cart. It may record
product format class and quantity bucket, but must not include product,
merchant, buyer, price, search, or title data.

<!-- telemetry-event: cart_remove properties=event_name,app,page_url,page_path,surface,action,status,count_bucket,product_type,time_bucket -->

### `cart_remove`

Emitted when a buyer removes an item from the cart. It may record product format
class and quantity bucket, but must not include product, merchant, buyer, price,
search, or title data.

<!-- telemetry-event: cart_clear properties=event_name,app,page_url,page_path,surface,action,status,count_bucket,product_type,time_bucket -->

### `cart_clear`

Emitted when a buyer clears a full cart or one compatible purchase group. It
may record cart composition buckets, but must not include product, merchant,
buyer, price, search, purchase, or title data. Checkout success cleanup should
not emit this event.

<!-- telemetry-event: checkout_initiated properties=event_name,app,page_url,page_path,surface,status,count_bucket,product_type,time_bucket -->

### `checkout_initiated`

Emitted when a buyer starts checkout from a cart. It may record auth-required
vs ready status and cart composition buckets, but must not include buyer,
merchant, product, or cart identifiers.

<!-- telemetry-event: checkout_step_result properties=event_name,app,page_url,page_path,surface,step,mode,rail,status,latency_bucket,count_bucket,amount_bucket,product_type,time_bucket -->

### `checkout_step_result`

Emitted for aggregate checkout step outcomes such as shipping validation,
order submission, direct payment, manual fallback, or payment failure. It must
use enum and bucket properties only. `latency_bucket` measures one named step;
it never includes an order, buyer, merchant, relay, or product identifier.

<!-- telemetry-event: checkout_success properties=event_name,app,page_url,page_path,surface,mode,rail,status,count_bucket,amount_bucket,product_type,time_bucket -->

### `checkout_success`

Emitted when checkout reaches a terminal successful outcome, including
order-first submission or paid fast checkout. It may record payment rail class
and amount bucket, but must not include invoice, payment hash, order,
merchant, buyer, or product identifiers.

<!-- telemetry-event: relay_connect_result properties=event_name,app,page_url,page_path,network,status,latency_bucket,count,time_bucket -->

### `relay_connect_result`

Emitted as an aggregate operational counter for relay connection outcomes.

<!-- telemetry-event: relay_publish_result properties=event_name,app,page_url,page_path,network,status,latency_bucket,count,time_bucket -->

### `relay_publish_result`

Emitted as an aggregate operational counter for relay publish outcomes.

<!-- telemetry-event: nip17_compatibility_result properties=event_name,app,page_url,page_path,action,declaration_class,delivery_route,ack_outcome,repair_outcome,block_reason -->

### `nip17_compatibility_result`

Emitted only for the bounded NIP-17 migration rollout. It contains fixed enums
and no identifiers, relay URLs, payloads, errors, or free text.

- `action=order_delivery` denominator: every validated kind-16 recipient send
  that reaches declaration route selection. Route-blocked attempts use
  `delivery_route=blocked` and a fixed `block_reason`; a selected strict or
  compatibility route uses
  `ack_outcome=unavailable|zero|partial|positive`. `unavailable` means the
  attempt failed before relay acknowledgement evidence was available; `zero`
  is reserved for relay diagnostics that show no successful acknowledgement.
- `action=declaration_repair` denominator: explicit unified Network inbox
  setup/update, exact retry, or redistribution attempts that keep a usable
  inbox. No-ops, successful signed withdrawals, unrelated relay-list updates,
  and outcomes after account cancellation are excluded. `repair_outcome` is
  `discoverable` only after the current mutation owner completes exact
  confirmation, otherwise `confirmation_pending` or `failed`; delivery and
  ACK fields are `not_applicable`. Failures before a resulting checkpoint use
  `declaration_class=unknown`; no account or signed-event details are emitted.
- Rollout observation uses a rolling 24-hour window per deployment profile.
  Event counts are aggregate attempts, not users, merchants, or orders. No
  identity may be reconstructed or correlated from these counters.

<!-- telemetry-event: checkout_result properties=event_name,app,page_url,page_path,surface,mode,rail,network,status,count_bucket,amount_bucket,product_type,time_bucket -->

### `checkout_result`

Emitted as an aggregate operational counter for terminal checkout success,
failure, blocked direct-payment, or degraded local tracking outcomes. It must
use enum and bucket properties only and must not contain invoice strings, order
contents, item titles, buyer identity, merchant identity, or shipping/contact
data.

<!-- telemetry-event: wallet_connect_result properties=event_name,app,page_url,page_path,rail,method,status,latency_bucket,count,time_bucket -->

### `wallet_connect_result`

Emitted as an aggregate operational counter for wallet connection outcomes.

<!-- telemetry-event: payment_attempt_result properties=event_name,app,page_url,page_path,rail,mode,status,latency_bucket,amount_bucket,count,time_bucket -->

### `payment_attempt_result`

Emitted once for each automatic Portable or Connected Wallet (`rail=wallet`)
or WebLN payment attempt, plus an `unavailable` result with `rail=none` when no
automatic rail can run. It records only the automatic mode, rail enum, bounded
outcome (`success`, `failure`, `blocked`, `unavailable`, or `ambiguous`),
latency bucket, and amount bucket.
`ambiguous` means a request may have moved funds without returning sufficient
proof and must not be collapsed into a safe retry. It must not include invoices,
payment hashes, preimages, wallet connection data, provider errors, order data,
or exact amounts.

<!-- telemetry-event: merchant_setup_step_result properties=event_name,app,page_url,page_path,surface,step,status,count,time_bucket -->

### `merchant_setup_step_result`

Emitted once per resolved Merchant readiness step and outcome while the
readiness provider is mounted. It records only the `profile`, `payments`,
`shipping`, or `network` step and a `success` or `blocked` outcome. Pending
checks are not emitted. It must not include merchant identity, profile content,
Lightning addresses, wallet configuration, shipping destinations, or relay
URLs.

<!-- telemetry-event: product_publish_result properties=event_name,app,page_url,page_path,event_family,status,latency_bucket,count,time_bucket -->

### `product_publish_result`

Emitted after a product create, update, or signed-delivery retry reaches a
user-visible publish outcome. It records only the operation family, bounded
latency, and `success` or `failure`; partial relay delivery is conservatively
counted as failure because the UI still requires retry. It must not include
product or merchant identifiers, event coordinates, titles, descriptions,
tags, prices, stock, shipping data, signer data, relay URLs, or provider errors.

<!-- telemetry-event: shipping_publish_result properties=event_name,app,page_url,page_path,event_family,status,latency_bucket,count,time_bucket -->

### `shipping_publish_result`

Emitted after a shipping settings publish or clear attempt reaches a
user-visible outcome. It records only the operation family, bounded latency,
and `success` or `failure`. It must not include merchant identity, countries,
postal rules, prices, event coordinates, signer data, relay URLs, or provider
errors.

<!-- telemetry-event: market_browse_action properties=event_name,app,page_url,page_path,surface,action,status,result_count_bucket,product_type,time_bucket -->

### `market_browse_action`

Emitted for aggregate browsing actions such as changing sort/filter modes or
storefront search. It must not include search terms or product/store
identifiers.

<!-- telemetry-event: product_detail_action properties=event_name,app,page_url,page_path,surface,action,product_type,time_bucket -->

### `product_detail_action`

Emitted for the bounded `add_to_cart` and `view_cart` actions on a product
detail page. It records only the action, product-format class, and the shared
sanitized route context. That route context must use
`/products/:productId`. It must not include product or merchant identifiers,
titles, descriptions, tags, prices, quantities, stock, images, profile data,
or cart contents.

<!-- telemetry-event: anon_zap_signer_request_result properties=event_name,app,surface,action,status,latency_bucket -->

### `anon_zap_signer_request_result`

Emitted once for each authenticated signer Worker request as an aggregate
operational outcome. It may record only the `sign` or `rate_limit` action, a
bounded outcome status, and a latency bucket. It must not include request
contents, origins, URLs, pubkeys, amounts, invoices, checkout/session keys,
rate-limit keys, or any other request or user identifier. The Worker uses one
static service-level distinct ID and disables PostHog person-profile processing.

<!-- telemetry-event: commerce_gmv_estimated properties=estimated_gmv_sats -->

### `commerce_gmv_estimated`

Legacy per-order event retained only for observations whose UTC order date is
before the daily-aggregation cutover. This bounded transition remains available
for up to 30 days so later merchant reconciliation does not disappear at
cutover. It preserves the prior opaque per-order PostHog upsert contract and is
excluded for order dates on or after cutover.

<!-- telemetry-event: commerce_gmv_estimated_daily properties=estimated_gmv_sats -->

### `commerce_gmv_estimated_daily`

Emitted as a recall-biased daily aggregate when Conduit commerce orders move
through any supported paid signal: wallet success, a buyer report, automatic
merchant wallet verification, manual merchant confirmation, or later
paid-order reconciliation. The sole business property is the sum of the first
accepted positive whole-satoshi estimate for each structurally deduplicated
order on the UTC day. These signals are OR gates for one logical per-order
contribution, not separate contributions.

This event is a narrowly scoped first-party aggregate commerce measurement, not
ordinary optional product analytics. It is not suppressed solely because GPC
is enabled or the generic browser telemetry flag is disabled. GPC continues to
suppress the optional browser analytics it governs. The exception does not
permit sale, sharing, advertising use, person profiling, or additional event
properties.

The Worker immediately transforms the raw order UUID into a day-scoped opaque
fingerprint, then atomically accepts it at most once in the Durable Object for
that UTC day. The Durable Object stores the opaque fingerprint but no per-order
amount. The first accepted estimate wins when shopper and merchant signals
disagree. It emits immutable daily aggregate revision snapshots with a UTC-day
timestamp, the running daily total, and a shared static service identity. Each
revision uses an opaque event UUID deterministically derived from the daily
seed and revision. The first snapshot is scheduled 12 hours after that UTC day
closes; later reconciliation is batched into fixed 12-hour windows rather than
forwarded per observation. Failed or ambiguous delivery retries the exact
frozen aggregate revision, total, and UUID; observations accepted meanwhile
wait for the next fixed window, which uses a different UUID. PostHog ingestion
disables IP capture and person-profile processing. Neither the raw order UUID
nor the opaque per-order fingerprint reaches PostHog. Multiple immutable
revision snapshots can therefore exist for one UTC day. Dashboard and query
consumers must select the greatest `estimated_gmv_sats` value for each UTC day
and must never sum those snapshots.

Active opaque fingerprints are retained through 30 days after the UTC order
day to cover delayed merchant reconciliation. At expiry the Worker attempts
one final snapshot, then deletes active state even if that provider delivery
fails. Cloudflare's provider-managed SQLite point-in-time recovery may retain
restorable state beyond active deletion for its recovery window. The Worker
ignores observations outside the accepted window so an expired day cannot be
recreated.

It must not include app, route, session, buyer, merchant, order, product,
public key, comment, invoice, payment hash, preimage, receipt, relay, wallet,
connection, fee, or payment-rail data. Unpaid orders and zero-sat orders do not
emit. Delivery is best effort and can still undercount. Buyer reports and
client-originated requests are intentionally not settlement proof and can
inflate the estimate. A first accepted estimate can slightly overstate or
understate exact invoiced sats, which is accepted for this recall-biased
metric. Payment state never depends on telemetry availability.
Aggregate reporting must call this estimated Conduit commerce GMV, not verified
settlement or merchant revenue. Exact amounts can be distinctive, so the event
is privacy-minimized rather than guaranteed unlinkable from outside knowledge.

## Agent Use

Agents may use telemetry only after it has been reduced to a sanitized incident
summary. Raw telemetry, customer reports, private dashboard screenshots, and
credentials belong in the private operations repo or secret stores, not public
tracked files.

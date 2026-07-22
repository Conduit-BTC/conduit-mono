# Telemetry Event Allowlist

Conduit telemetry is privacy-safe operational telemetry only. Product clients
must remain useful without telemetry, and telemetry must stay disabled unless a
deployment explicitly enables it.

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
- `product_type`

## Retention and Redaction

PostHog Cloud currently reports a plan-managed event retention window of 84
months. The provider controls that field and does not expose it as a mutable
project setting. This longer provider window is acceptable only while every
event remains aggregate-only, uses a shared service identity, and passes the
allowlist and redaction controls in this document. Maintainers must review the
provider window at least quarterly and select a shorter plan or self-hosted
retention policy when PostHog makes one available.

Redaction happens before provider delivery. Events that fail the event-name or
property allowlist must be dropped rather than repaired downstream. Browser
events must remove raw paths, query strings, SDK-generated device/session
properties, IP/fingerprint properties, and active-user identifiers. Worker
events must construct a new payload from the documented property allowlist and
must never spread request-derived properties into a provider payload. If an
event outside this contract is ingested, delete it from the provider and treat
the incident as a telemetry-policy failure.

## PostHog Dashboard Split

PostHog dashboards should split Market and Merchant traffic with the shared
`app` property. Use `app = market` for Market client panels and
`app = merchant` for Merchant Portal panels. Do not use PostHog identity,
grouping, person profile, or session replay features to create this split.
PostHog project settings must discard IP data. Browser capture uses memory-only
SDK state, one static browser-service distinct ID, and disabled person-profile
processing. Do not enable PostHog's server-hashed cookieless mode for Conduit
events because it requires raw IP, host, and user-agent inputs that this
telemetry policy excludes.

Do not include active user, signer, buyer, wallet, or session pubkeys/npubs,
invoices, order contents, product titles, addresses, message contents, IPs,
fingerprints, signer connection strings, NWC URIs, raw URLs, raw paths, query
strings, or user journey identifiers. Browser custom events may include only
shared-helper route context through `page_url` and `page_path`; store route
context may include the public store `npub` as the page identifier, while
product, profile, order, query string, unknown route, and active user
identifiers stay redacted. Public store npubs must not be copied into custom
properties or joined to viewer identity.

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

Emitted when a buyer clears a full cart or a merchant cart group. It may record
cart composition buckets, but must not include product, merchant, buyer, price,
search, or title data. Checkout success cleanup should not emit this event.

<!-- telemetry-event: checkout_initiated properties=event_name,app,page_url,page_path,surface,status,count_bucket,product_type,time_bucket -->

### `checkout_initiated`

Emitted when a buyer starts checkout from a cart. It may record auth-required
vs ready status and cart composition buckets, but must not include buyer,
merchant, product, or cart identifiers.

<!-- telemetry-event: checkout_step_result properties=event_name,app,page_url,page_path,surface,step,mode,rail,status,count_bucket,amount_bucket,product_type,time_bucket -->

### `checkout_step_result`

Emitted for aggregate checkout step outcomes such as shipping validation,
order submission, direct payment, manual fallback, or payment failure. It must
use enum and bucket properties only.

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

Emitted once for each automatic NWC or WebLN payment attempt, plus an
`unavailable` result with `rail=none` when no automatic rail can run. It records
only the automatic mode, rail enum, bounded outcome (`success`, `failure`,
`blocked`, `unavailable`, or `ambiguous`), latency bucket, and amount bucket.
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
sanitized route class. It must not include product or merchant identifiers,
event coordinates, titles, descriptions, tags, prices, quantities, stock,
images, profile data, or cart contents.

<!-- telemetry-event: anon_zap_signer_request_result properties=event_name,app,surface,action,status,latency_bucket -->

### `anon_zap_signer_request_result`

Emitted once for each authenticated signer Worker request as an aggregate
operational outcome. It may record only the `sign` or `rate_limit` action, a
bounded outcome status, and a latency bucket. It must not include request
contents, origins, URLs, pubkeys, amounts, invoices, checkout/session keys,
rate-limit keys, or any other request or user identifier. The Worker uses one
static service-level distinct ID and disables PostHog person-profile processing.

## Agent Use

Agents may use telemetry only after it has been reduced to a sanitized incident
summary. Raw telemetry, customer reports, private dashboard screenshots, and
credentials belong in the private operations repo or secret stores, not public
tracked files.

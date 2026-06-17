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

Do not include pubkeys, npubs, invoices, order contents, product titles,
addresses, message contents, IPs, fingerprints, signer connection strings, NWC
URIs, raw URLs, raw paths, query strings, or user journey identifiers. Browser
custom events may include only route-redacted `page_url` and `page_path` values
from the shared telemetry helper.

## Events

<!-- telemetry-event: app_load_result properties=event_name,app,page_url,page_path,network,status,latency_bucket,count,time_bucket -->

### `app_load_result`

Emitted as an aggregate operational counter when an app load succeeds or fails.

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

<!-- telemetry-event: checkout_result properties=event_name,app,page_url,page_path,network,status,latency_bucket,count,time_bucket -->

### `checkout_result`

Emitted as an aggregate operational counter for checkout success/failure. It
must not contain invoice strings, order contents, item titles, buyer identity,
merchant identity, or shipping/contact data.

<!-- telemetry-event: wallet_connect_result properties=event_name,app,page_url,page_path,rail,method,status,latency_bucket,count,time_bucket -->

### `wallet_connect_result`

Emitted as an aggregate operational counter for wallet connection outcomes.

<!-- telemetry-event: payment_attempt_result properties=event_name,app,page_url,page_path,rail,mode,status,latency_bucket,amount_bucket,count,time_bucket -->

### `payment_attempt_result`

Emitted as an aggregate operational counter for payment attempt outcomes.

<!-- telemetry-event: merchant_setup_step_result properties=event_name,app,page_url,page_path,surface,step,status,count,time_bucket -->

### `merchant_setup_step_result`

Emitted when a merchant setup surface reaches an aggregate success, blocked, or
failure state.

<!-- telemetry-event: product_publish_result properties=event_name,app,page_url,page_path,event_family,status,latency_bucket,count,time_bucket -->

### `product_publish_result`

Emitted as an aggregate operational counter for product publish outcomes.

<!-- telemetry-event: shipping_publish_result properties=event_name,app,page_url,page_path,event_family,status,latency_bucket,count,time_bucket -->

### `shipping_publish_result`

Emitted as an aggregate operational counter for shipping settings publish
outcomes.

<!-- telemetry-event: market_browse_action properties=event_name,app,page_url,page_path,surface,action,status,result_count_bucket,product_type,time_bucket -->

### `market_browse_action`

Emitted for aggregate browsing actions such as changing sort/filter modes or
storefront search. It must not include search terms or product/store
identifiers.

<!-- telemetry-event: product_detail_action properties=event_name,app,page_url,page_path,surface,action,product_type,time_bucket -->

### `product_detail_action`

Emitted for aggregate product detail actions. It must not include product,
merchant, title, price, or profile identifiers.

## Agent Use

Agents may use telemetry only after it has been reduced to a sanitized incident
summary. Raw telemetry, customer reports, private dashboard screenshots, and
credentials belong in the private operations repo or secret stores, not public
tracked files.

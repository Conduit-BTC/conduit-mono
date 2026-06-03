# Telemetry Event Allowlist

Conduit telemetry is privacy-safe operational telemetry only. Product clients
must remain useful without telemetry, and telemetry must stay disabled unless a
deployment explicitly enables it.

## Allowed Properties

Runtime telemetry events may only use these fields:

- `event_name`
- `app`
- `network`
- `status`
- `latency_bucket`
- `count`
- `time_bucket`

Do not include pubkeys, npubs, invoices, order contents, product titles,
addresses, message contents, IPs, fingerprints, signer connection strings, NWC
URIs, or user journey identifiers.

## Events

<!-- telemetry-event: app_load_result properties=event_name,app,network,status,latency_bucket,count,time_bucket -->

### `app_load_result`

Emitted as an aggregate operational counter when an app load succeeds or fails.

<!-- telemetry-event: relay_connect_result properties=event_name,app,network,status,latency_bucket,count,time_bucket -->

### `relay_connect_result`

Emitted as an aggregate operational counter for relay connection outcomes.

<!-- telemetry-event: relay_publish_result properties=event_name,app,network,status,latency_bucket,count,time_bucket -->

### `relay_publish_result`

Emitted as an aggregate operational counter for relay publish outcomes.

<!-- telemetry-event: checkout_result properties=event_name,app,network,status,latency_bucket,count,time_bucket -->

### `checkout_result`

Emitted as an aggregate operational counter for checkout success/failure. It
must not contain invoice strings, order contents, item titles, buyer identity,
merchant identity, or shipping/contact data.

## Agent Use

Agents may use telemetry only after it has been reduced to a sanitized incident
summary. Raw telemetry, customer reports, private dashboard screenshots, and
credentials belong in the private operations repo or secret stores, not public
tracked files.

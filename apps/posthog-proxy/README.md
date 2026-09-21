# PostHog proxy Worker

This Worker sanitizes optional browser telemetry and receives the separate
first-party aggregate commerce GMV estimate.

## Daily GMV runtime contract

Daily aggregation is inactive until the Worker receives a valid, strictly
future `COMMERCE_GMV_DAILY_CUTOVER_DATE` in `YYYY-MM-DD` UTC format. Before
activation, an absent date keeps the bounded legacy per-order delivery path.
The content-free `/health` route resolves the configured date without emitting
a GMV observation. The first valid date is durably latched; removing the
variable cannot deactivate it, while conflicting, current, past, or malformed
values fail closed.

Post-cutover observations are deduplicated inside one SQLite-backed Durable
Object per UTC order day. Each fixed-window aggregate revision uses a distinct,
opaque event UUID; retries of that same revision reuse its UUID. Consumers must
select the greatest `estimated_gmv_sats` value for each UTC day and must not sum
the revision snapshots.

The Worker requires `POSTHOG_PROJECT_TOKEN`, the dedicated
`COMMERCE_GMV_TELEMETRY_HMAC_SECRET`, both rate-limit bindings, and both Durable
Object bindings. Secret values are configuration-only and must not be committed
or logged.

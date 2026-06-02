# Analytics Event Allowlist

Conduit client telemetry is anonymous and aggregate-only. It is disabled unless
`VITE_ENABLE_TELEMETRY=true`.

## Client Events

| Tool      | Event       | When                   | Allowed properties                                                                      | PII allowed |
| --------- | ----------- | ---------------------- | --------------------------------------------------------------------------------------- | ----------- |
| Plausible | `pageview`  | Anonymous route change | sanitized URL only                                                                      | No          |
| PostHog   | `$pageview` | Anonymous route change | `app`, `network`, `route`, `telemetry_mode`, `distinct_id`, `$current_url`, `$pathname` | No          |

## Distinct ID Policy

Client code does not call `identify`, does not send pubkeys or npubs, and does
not attach user, merchant, buyer, order, invoice, address, or message fields.
PostHog persistence is disabled and `distinct_id` is forced to the literal
string `anonymous` so the browser SDK must not create persistent product-analytics
identifiers or user-level timelines.

Signer-connected sessions are not tracked without explicit consent. The current
implementation passes no consent flag, so route telemetry pauses as soon as a
signer connection is active, connecting, or restoring.

## Disallowed Fields

Telemetry payloads must not include:

- pubkey, npub, or nsec values
- message content
- order items, titles, ids, or totals
- invoice strings, payment requests, BOLT11 invoices, or payment hashes
- contact, shipping, address, email, or phone data
- raw dynamic route parameters such as product ids, order ids, profile refs, or store pubkeys

## Route Sanitization

Dynamic route segments are collapsed before telemetry is sent:

- `/products/<id>` -> `/products/:productId`
- `/orders/<id>` -> `/orders/:orderId`
- `/store/<pubkey>` -> `/store/:pubkey`
- `/u/<profile-ref>` -> `/u/:profileRef`

Unknown long, Nostr-encoded, or hex-like segments are collapsed to `:id`.

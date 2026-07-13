# Anon Zap Signer Handoff

This note is the public-safe implementation handoff for the Anon Conduit
Shopper signer boundary. It does not contain production keys, private
deployment records, dashboard links, or operator-only runbooks.

## Scope

The signer exists only to sign validated NIP-57 zap request drafts as the
shared Anon Conduit Shopper identity. It is not a general event signer, buyer
account, merchant signer, wallet service, payment custodian, NIP-17 order
sender, or payment-proof sender.

Production private key material must stay outside tracked files, GitHub,
Linear, logs, screenshots, test fixtures, browser-visible config, and `VITE_*`
environment variables. Developers should receive only public identity values
and the server-side request contract below.

## Public Identity Handoff

Before public anonymous checkout zaps are enabled, an operator must confirm the
identity profile is live on common Nostr clients and relays:

- display name is the approved Anon Conduit Shopper name or approved variant
- kind `0` profile text says the identity is a shared checkout signal, not an
  individual shopper
- image and optional profile fields are approved for public zap surfaces
- public runtime config has the identity `npub` and, where code needs it, the
  derived 64-character hex pubkey

The public pubkey/npub and profile evidence may be shared with implementation
work. The production `nsec` or raw private key must not be shared through repo,
tracker, chat, screenshots, logs, or CI.

## Runtime Config Contract

Market browser config:

- `VITE_ANON_ZAP_SIGNER_URL`: client-facing Market endpoint for anon zap
  signing, usually a Pages route such as `/api/anon-zap-sign`. This must not be
  the raw Worker endpoint when Worker auth headers or shared secrets are needed.
- `VITE_ANON_ZAP_SIGNER_PUBKEY`: public Anon Conduit Shopper identity value
  used by client-side receipt and signer-readiness logic. Prefer the derived
  64-character hex pubkey when the caller validates event authors directly; an
  `npub` is acceptable only where the caller explicitly normalizes it.

Current public handoff values:

- Anon Conduit Shopper npub:
  `npub1thhp3svkq7y22s0vewpdnm7s8c22nkuga6dxrd7pu8akfjfs3ynqwa7jgy`
- Anon Conduit Shopper hex pubkey:
  `5dee18c1960788a541eccb82d9efd03e14a9db88ee9a61b7c1e1fb64c9308926`
- public profile:
  `https://primal.net/p/npub1thhp3svkq7y22s0vewpdnm7s8c22nkuga6dxrd7pu8akfjfs3ynqwa7jgy`
- production client-facing Market signer path: `/api/anon-zap-sign`
- production signer Worker URL: `https://anon-signer.conduit.market`
- production Market origin: `https://shop.conduit.market`
- preview Market origin patterns:
  `https://*.conduit-market-coo.pages.dev` and
  `https://*.conduit-market-signet.pages.dev`

Market server or Pages-function config:

- `ANON_ZAP_SIGNER_URL`: server-side URL for the signer Worker.
- `ANON_SIGNER_REQUEST_AUTH_SECRET`: server-side HMAC secret shared only between
  the trusted Market server boundary and signer Worker.
- `ANON_ZAP_ALLOWED_ORIGINS`: browser origins allowed to call the Market
  Pages endpoints.
- `ANON_ZAP_COMMERCE_RELAYS`: optional comma-separated relay override used to
  resolve the current signed merchant profile and product listings. When unset,
  Market uses its canonical commerce relays.
- `ANON_ZAP_RECEIPT_RELAYS`: optional comma-separated relay override embedded
  in the canonical zap request and watched for the resulting receipt. When
  unset, Market uses its canonical public relays.
- `ANON_ZAP_AUTH_TTL_SECONDS`: optional lifetime for the stateless checkout
  authorization token. The default is 120 seconds and accepted values are
  bounded from 30 through 300 seconds.

Signer Worker config:

- `ANON_CONDUIT_SHOPPER_PRIVATE_KEY_HEX`: production signer secret binding.
  The Worker accepts raw hex or `nsec`, but production values must be configured
  only as deployment secrets.
- `ANON_CONDUIT_SHOPPER_PUBKEY`: expected public identity pubkey or `npub`.
- `ANON_SIGNER_REQUEST_AUTH_SECRET`: same server-to-server HMAC secret used by
  the trusted Market boundary.
- `ANON_SIGNER_ALLOWED_ORIGINS`: browser origins allowed by Worker CORS. CORS is
  not authentication; request signing is still required.
- `ANON_SIGNER_RATE_LIMITER`: Cloudflare rate-limit binding. The Worker fails
  closed when it is missing.
- `ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS`: optional request and zap-draft freshness
  window. Default is five minutes.
- `ANON_CONDUIT_MARKET_NIP89_ADDRESS`: optional `31990:<pubkey>:<d-tag>` client
  handler address for a strict NIP-89 `client` tag.
- `ANON_CONDUIT_MARKET_NIP89_RELAY_HINT`: optional relay hint for that NIP-89
  `client` tag.

Local-only signer config:

- `ANON_SIGNER_PORT`: local signer port, defaulting to `7010`.

## Signer Request Contract

Only the trusted Market server boundary should call the signer Worker. The
browser sends checkout intent to Market; Market validates public product state,
merchant zap policy, LNURL support, amount bounds, and the canonical zap draft
before calling the signer.

Worker request:

```json
{
  "zapRequest": {
    "kind": 9734,
    "createdAt": 1720000000,
    "content": "",
    "tags": [
      ["p", "<merchant hex pubkey>"],
      ["amount", "1000"],
      ["lnurl", "<merchant lnurl>"],
      ["relays", "wss://relay.example"]
    ]
  },
  "authorization": {
    "checkoutSessionId": "<opaque idempotency/session key>",
    "merchantPubkey": "<merchant hex pubkey>",
    "amountMsats": 1000,
    "lnurl": "<merchant lnurl>",
    "publicZapPolicy": "anonymous_public_zap_allowed"
  }
}
```

`checkoutSessionId` is a bounded idempotency and rate-limit key derived by the
trusted Market boundary from canonical public checkout fields. It does not
identify an order and does not require server-side storage of order, contact,
shipping, invoice, note, wallet, or session data.

Required headers:

- `content-type: application/json`
- `x-conduit-anon-signer-timestamp`: current Unix timestamp in seconds
- `x-conduit-anon-signer-signature`: lowercase hex HMAC-SHA256 of
  `<timestamp>.<raw body>` using `ANON_SIGNER_REQUEST_AUTH_SECRET`

The Worker returns:

```json
{
  "id": "<signed event id>",
  "rawEvent": {}
}
```

The Worker independently enforces:

- authenticated HMAC request headers
- request body size limit
- origin allow-list when an origin header is present
- rate limiting per `checkoutSessionId`
- kind `9734` only
- fresh `createdAt`
- a single merchant `p` tag, `amount` tag, `lnurl` tag, and `relays` tag
- allowed public tags only: `p`, `amount`, `lnurl`, `relays`, `client`, `omf`
- `content` length at or below 280 characters
- draft `p`, `amount`, and `lnurl` match the server-side authorization object
- private key matches `ANON_CONDUIT_SHOPPER_PUBKEY`

The zap request must not include order ids, cart contents, addresses, phone,
email, private buyer notes, invoices, NWC data, wallet secrets, or encrypted
message payloads.

## Dev And Test Strategy

Local and preview work must use a throwaway identity, never the production
Anon Conduit Shopper secret. Generate local key material with `bun run seed:nsec`
or equivalent Nostr tooling, derive the matching public key locally, and store
values only in `.env.local` or deployment-secret configuration.

Unit tests may use deterministic fixture keys when the fixture is scoped to test
code and clearly not a production identity. Browser-visible config should use
only public URLs and public pubkeys.

## Ready Checklist

Before enabling the dependent checkout integration:

- public profile is live and visible from common Nostr clients
- implementation has the public `npub`, derived hex pubkey, and client-facing
  Market signer URL
- production signer Worker has secret bindings and rate limiting configured
- production and preview allowed origins are confirmed
- Market server boundary has a signer Worker URL and request-auth secret
- dev/test throwaway identity strategy is documented for local and CI use
- no production private key material appears in tracked files, issue text,
  comments, screenshots, logs, or test fixtures

## Validation

For this signer boundary, use focused tests before broader checkout QA:

```bash
bun test tests/anon-zap-signer-service.test.ts tests/anon-zap-pages-function.test.ts tests/anon-zap-signer.test.ts
```

Run formatting checks for docs/env-only changes:

```bash
bun run format:check
```

## Protocol Sources

- NIP-57 defines zap requests as kind `9734` events sent to the receiver's
  LNURL callback as the `nostr` parameter. It requires `p` and `relays`, and
  recommends `amount` and `lnurl`; the Conduit signer requires all four so the
  request stays bound to the verified merchant, amount, LNURL, and receipt
  relay set.
- NIP-01 defines the base Nostr event shape and kind `0` profile metadata.

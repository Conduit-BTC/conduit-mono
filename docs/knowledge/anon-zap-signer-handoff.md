# Anon Zap Signer Handoff

This note is the public-safe implementation handoff for the Anon Conduit
Shopper signer boundary. It does not contain production keys, private
deployment records, dashboard links, or operator-only runbooks.

This note is subordinate to the normative signer exception in
`docs/specs/protocol.md`. It records the runtime and request contract needed to
operate that exception; it does not widen the events, identities, or checkout
flows the signer may authorize.

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
  used by client-side signer and receipt validation. Prefer the derived
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

Current Market Pages-function config:

- `ANON_ZAP_ALLOWED_ORIGINS`: browser origins allowed to call the current
  fail-closed Market Pages endpoints.

Trusted-checkout proxy config:

The Market Pages boundary authorizes anonymous checkout zaps from current
signed product/profile events, derives fiat-priced totals with a server-owned
rate quote, and forwards only the canonical public draft to the signer Worker.
The browser supplies product coordinates and quantities, not an authoritative
amount or comment.

- `ANON_ZAP_SIGNER_URL`: server-side URL for the signer Worker. Production
  requires HTTPS and rejects credentials, query strings, fragments, and private
  hosts.
- `ANON_ZAP_SIGNER_ALLOWED_HOSTS`: required comma-separated exact-host
  allow-list for `ANON_ZAP_SIGNER_URL`. Production should normally contain only
  `anon-signer.conduit.market`; wildcards are not accepted.
- `ANON_ZAP_ALLOW_INSECURE_LOCALHOST`: local-development-only opt-in for an
  `http://localhost` or `http://127.0.0.1` signer URL. Leave false in deployed
  environments, and include the local hostname in the exact-host allow-list.
- `ANON_SIGNER_REQUEST_AUTH_SECRET`: server-side HMAC secret shared only between
  the trusted Market server boundary and signer Worker. See Secret Lifecycle
  below.
- `ANON_ZAP_COMMERCE_RELAYS`: optional comma-separated relay override used to
  resolve the current signed merchant profile and product listings. When unset,
  Market uses its canonical commerce relays.
- `ANON_ZAP_RECEIPT_RELAYS`: optional comma-separated relay override embedded
  in the canonical zap request and watched for the resulting receipt. When
  unset, Market uses its canonical public relays. Market exposes this public
  list at `/api/anon-zap-config` so the Zapouts feed reads the same relays as
  checkout.
- `ANON_ZAP_AUTH_TTL_SECONDS`: optional lifetime for the stateless checkout
  authorization token. The default is 120 seconds and accepted values are
  bounded from 30 through 300 seconds.
- `ANON_ZAP_LNURL_ALLOWED_HOSTS`: required exact-host allow-list for LNURL-pay
  metadata egress performed by the public Zapouts authority endpoint. Checkout
  metadata is fetched by the browser, so this allow-list does not gate invoice
  creation or make Pages a dependency of the merchant's wallet provider.
- `ANON_ZAP_PROVIDER_ATTESTATION_KEY_ID`: identifier for the active checkout
  authorization signing key. The deployed name is retained for compatibility;
  use a new identifier for every rotation.
- `ANON_ZAP_PROVIDER_ATTESTATION_PRIVATE_KEY_HEX`: dedicated 32-byte Schnorr
  private key used by Market Pages to bind `omf_auth` to the exact authorized
  public request. It does not attest browser-fetched provider metadata and must
  not reuse the Anon Shopper or transport-auth key.
- `ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS`: comma-separated
  `key-id:hex-pubkey` verification ring shared by Market Pages and the signer
  Worker. Retain public keys for routine rotations; never retain old private
  keys.
- `ANON_ZAP_RATE_LIMIT_SERVICE`: required Cloudflare Pages service binding to
  the Anon signer Worker. Pages Functions do not own Rate Limiting bindings;
  they send only HMAC-pseudonymous bucket keys through this authenticated
  service boundary.
- `ANON_ZAP_SIGNER_SERVICE`: required Cloudflare Pages service binding to the
  same environment-specific signer Worker for authenticated signing requests.
  This avoids routing a same-account Worker request through a public
  `workers.dev` or custom-domain hop. `ANON_ZAP_SIGNER_URL` remains the
  validated logical request URL and local-development fallback.

Configure both service bindings separately on every Git-connected Pages
project because Market, Merchant, and their Signet projects all consume the
repository-root `functions/` directory. Do not add a partial app-local Pages
Wrangler file: it is outside that project root and cannot represent all four
projects. Both sides fail closed on missing or unavailable rate-limit bindings.

`POST /api/zapout-authority` accepts only a bounded batch of public receipt
events. It rate-limits before streaming the bounded body, validates signatures
and invoice bindings, then resolves current merchant/provider metadata during a
five-minute payment-time window. The `omf_auth` proof authorizes the anonymous
request for signing but does not establish provider authority. Retired Anon
Shopper keys are not authority inputs. Older receipts, lookup failure, rate
limiting, or provider rotation are reported as authority unavailable rather
than invalid. Fallback metadata
lookups are restricted to exact operator-allowed hosts and deduplicated only
while a request is in flight, so provider revocation is not hidden by a
persistent cache. Recipient limits affect only that recipient's fallback result
and never suppress unrelated or attested receipts. The browser never fetches
receipt-selected wallet domains. Responses preserve `verified`, `invalid`, and
`authority_unavailable` as distinct outcomes.

Authorization reads require an EOSE-complete, non-saturated response from every
configured authoritative commerce relay for product listings, merchant
profiles, address deletions, and exact-event deletions. Public fallback relays
are not implicit authorization dependencies. A partial, failed, omitted, or
limit-saturated authoritative read returns temporary unavailability instead of
authorizing from incomplete public state.

Signer Worker config:

- `ANON_CONDUIT_SHOPPER_PRIVATE_KEY_HEX`: production signer secret binding.
  The Worker accepts raw hex or `nsec`, but production values must be configured
  only as deployment secrets.
- `ANON_CONDUIT_SHOPPER_PUBKEY`: expected public identity pubkey or `npub`.
- `ANON_SIGNER_REQUEST_AUTH_SECRET`: same server-to-server HMAC secret used by
  the trusted Market boundary. See Secret Lifecycle below.
- `ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS`: same public verification ring
  configured on Market Pages; the Worker verifies the proof before signing.
- `ANON_SIGNER_ALLOWED_ORIGINS`: browser origins allowed by Worker CORS. CORS is
  not authentication; request signing is still required.
- `ANON_SIGNER_RATE_LIMITER`: Cloudflare rate-limit binding. The Worker checks
  both the opaque checkout-session bucket and a stable merchant bucket, so
  minting a fresh authorization cannot bypass merchant-level limits. The Worker
  fails closed when the binding is missing or unavailable.
- `ANON_AUTHORIZATION_RATE_LIMITER`: independently tuned rate-limit binding for
  pseudonymous checkout source and merchant authorization buckets.
- `ANON_AUTHORITY_RATE_LIMITER`: higher-capacity rate-limit binding for bounded
  Zapouts authority batches and fallback-recipient metadata egress. A normal
  feed load cannot exhaust the signer or checkout namespace.
- `ANON_SIGNER_MAX_CLOCK_SKEW_SECONDS`: optional request and zap-draft freshness
  window. Default is five minutes.
- `ANON_CONDUIT_MARKET_NIP89_ADDRESS`: optional `31990:<pubkey>:<d-tag>` client
  handler address for a strict NIP-89 `client` tag.
- `ANON_CONDUIT_MARKET_NIP89_RELAY_HINT`: optional relay hint for that NIP-89
  `client` tag.

Local-only signer config:

- `ANON_SIGNER_PORT`: local signer port, defaulting to `7010`.

### Secret Lifecycle

`ANON_SIGNER_REQUEST_AUTH_SECRET` is an authorization credential, not ordinary
configuration. Generate at least 32 cryptographically random bytes and encode
them as hex or base64url; both runtimes must use the exact encoded text as the
HMAC key. Production, preview, CI, and local environments must use different
values. Never copy the production value into a preview or developer runtime.

The current Worker accepts one active request-auth secret and does not support
an overlap window. Rotation is therefore fail-closed: disable anonymous public
signing, update both server runtimes, verify an authenticated request, then
re-enable the route. While signing is disabled, the already-delivered order may
continue through one plain private invoice before any invoice reaches a payment
rail. Removing the secret from either runtime is the emergency revocation path;
missing request authentication must never fall back to an unauthenticated
Worker call.

Checkout authorization attestations use a separate asymmetric key lifecycle.
For routine rotation, deploy a new key id/private key, add its public key to
`ANON_ZAP_PROVIDER_ATTESTATION_PUBLIC_KEYS`, retain prior public keys for
historical verification, verify signing, and then destroy the retired private
key. If an attestation private key is suspected compromised, remove its public
key from every signer verifier immediately so affected requests can no longer
be signed. Preview, production, CI, and local environments must use distinct
attestation keys.

## Signer Request Contract

Only the trusted Market server boundary should call the signer Worker. The
browser sends checkout intent to Market; Market validates public product state,
merchant zap policy, amount, the profile-derived LNURL, and the canonical zap
draft before calling the signer. The browser separately fetches LNURL-pay
metadata, checks zap support, receipt pubkey, callback safety, amount bounds,
and exact LNURL agreement before requesting a signature or invoice.

Worker request:

```json
{
  "zapRequest": {
    "kind": 9734,
    "createdAt": 1720000000,
    "content": "Zapped out 1 item at https://shop.conduit.market/",
    "tags": [
      ["p", "<merchant hex pubkey>"],
      ["amount", "1000"],
      ["lnurl", "<merchant lnurl>"],
      ["relays", "wss://relay.example"],
      ["omf", "zapout"],
      ["omf_auth", "<attestation key id>", "<Schnorr signature>"],
      ["client", "conduit-market"]
    ]
  },
  "authorization": {
    "checkoutSessionId": "<opaque retry/rate-limit key>",
    "merchantPubkey": "<merchant hex pubkey>",
    "amountMsats": 1000,
    "lnurl": "<merchant lnurl>",
    "publicZapPolicy": "anonymous_public_zap_allowed"
  }
}
```

`checkoutSessionId` is a server-minted, nonce-bound key used only to group
signing retries into one rate-limit bucket. It must contain at least 128 bits of
cryptographic randomness and must not be derived solely from public checkout
fields. It is not an idempotency key: the Worker stores no replay result and
does not deduplicate requests. It does not identify an order and must not encode
order, contact, shipping, invoice, note, wallet, or browser-session data.

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
- rate limiting per `checkoutSessionId` and merchant pubkey
- kind `9734` only
- fresh `createdAt`
- a single merchant `p` tag, `amount` tag, `lnurl` tag, and `relays` tag
- allowed public tags only: `p`, `amount`, `lnurl`, `relays`, `client`, `omf`,
  `omf_provider`, and `omf_auth`
- an exact server-issued `omf_auth` proof for checkout authorization; new
  requests do not include `omf_provider`
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

Before enabling anonymous checkout integration:

- public profile is live and visible from common Nostr clients
- Market has the public `npub`, derived hex pubkey, and client-facing
  Market signer URL
- production signer Worker has secret bindings and session-plus-merchant rate
  limiting configured
- Market Pages has both signer and rate-limit service bindings configured; the
  target Worker has all three rate-limit bindings and uses HMAC-pseudonymous
  source keys
- production Pages targets the production Worker, while preview Pages targets
  the separately configured preview Worker and secrets
- the signer URL uses HTTPS and its exact hostname is allow-listed
- production and preview allowed origins are confirmed
- Market server boundary has a signer Worker URL, request-auth secret, and
  access to its trusted pricing providers
- missing or unhealthy signer configuration suppresses only the optional public
  zap; the same delivered order continues through one plain private invoice
  before any invoice reaches a payment rail
- request-auth secrets meet the entropy, environment-separation, rotation, and
  emergency-revocation requirements above
- dev/test throwaway identity strategy is documented for local and CI use
- no production private key material appears in tracked files, issue text,
  comments, screenshots, logs, or test fixtures

## Validation

For this signer boundary, use focused tests before broader checkout QA:

```bash
bun test tests/anon-zap-signer-service.test.ts tests/anon-zap-pages-function.test.ts tests/anon-zap-signer.test.ts tests/zapout-authority-pages-function.test.ts tests/lnurl-authority.test.ts
```

Deployment evidence must record a UTC timestamp, target environment, status
code, and secret-free command shape for each check. At minimum, confirm that a
raw Worker request without HMAC is rejected, unsigned or browser-priced intents
are rejected, a signed fiat listing receives a server-derived amount,
disallowed origins are rejected, and the configured rate limiter returns a
bounded retry response. Run the Pages-to-Worker service-binding smoke in both
production and preview, confirming each targets its environment-specific Worker
without exposing request signatures, secret values, checkout payloads, or
private deployment links in the evidence. Separately test checkout with the
Pages-to-Worker binding absent or rejected: one order must be delivered, one
plain invoice must be requested, and no public zap may be claimed.

Run formatting checks for docs/env-only changes:

```bash
bun run format:check
```

### No-Funds Deployment Canary

After a preview deployment is configured, run the authorize/sign canary against
an explicit preview URL:

```bash
bun run smoke:anon-zap
```

The canary requires public, non-secret inputs for its target URL, signed
merchant/product coordinates, expected Anon Shopper pubkey, expected canonical
LNURL, and checkout-authorization attestation public key ring:

- `ANON_ZAP_CANARY_BASE_URL`
- `ANON_ZAP_CANARY_MERCHANT_PUBKEY`
- `ANON_ZAP_CANARY_PRODUCT_ADDRESS`
- `ANON_ZAP_CANARY_SIGNER_PUBKEY`
- `ANON_ZAP_CANARY_EXPECTED_LNURL`
- `ANON_ZAP_CANARY_ATTESTATION_PUBLIC_KEYS`

It submits only merchant and product coordinates. The Pages boundary derives
the amount from current signed listings, pricing, shipping, and merchant
metadata. The canary verifies the canonical kind `9734` content, pricing-bound
amount, canonical LNURL, receipt relays, asymmetric checkout-authorization
attestation, absence of server-asserted provider authority, and final Anon
Shopper signature. It intentionally stops before fetching browser-owned LNURL
provider metadata, calling the callback, requesting an invoice, publishing an
event, or sending funds.

This canary proves the Pages authorization and signer deployment boundary only.
Before release, also complete one minimum-value preview-wallet checkout and
verify that the exact signed kind `9734` reaches the LNURL callback, the BOLT11
description hash commits to it, and the resulting kind `9735` is accepted by
the Zapouts authority path on the configured receipt relays.

A passing canary does not prove checkout resilience. Deliberately make the
preview signer or its Pages service binding unavailable and verify that one
encrypted order is delivered, one plain private invoice is requested and can
be paid, no public zap is claimed, and no second invoice is requested. Treat
that failure-mode checkout as a release gate for anonymous zap changes.

### Provider Invoice-Readiness Canary

`bun run smoke:anon-zap-provider` checks a configured wallet provider beyond
the Pages signer boundary. It first runs the deployed authorize/sign canary,
then fetches live LNURL-pay metadata and requires an exact provider host,
NIP-57 support, a valid receipt pubkey, the exact authorized LNURL, and an
authorized amount inside the provider range. In invoice mode it sends the exact
kind `9734` returned by the deployed signer to the provider callback and
verifies that the returned mainnet BOLT11 encodes the exact server-priced amount
and commits its description hash to that exact signed request.

The canary never logs or persists the authorization token, signed event,
provider pubkeys, invoice, or callback query parameters. It never publishes the
request, pays the invoice, or claims a kind `9735` receipt.

The deterministic provider-canary tests run in normal pull-request CI. The live
`Anon Zap Provider Canary` workflow is manual-only because it checks deployed
signer and provider boundaries and can request an unpaid invoice. Configure
these public repository variables with a team-controlled provider fixture
before dispatching it:

- `ANON_ZAP_PROVIDER_CANARY_LUD16`
- `ANON_ZAP_PROVIDER_CANARY_EXPECTED_HOST`

The workflow also requires the six public `ANON_ZAP_CANARY_*` variables listed
in the no-funds deployment canary section. Configure them for a minimum-value
product owned by the same merchant pubkey whose signed profile uses the fixture
Lightning address. The authorized product price controls the invoice amount.

Use a dedicated fixture address whose operator permits unpaid invoice requests.
Do not point the callback canary at an unrelated public wallet. For a
metadata-only check, clear the `request_invoice` input when dispatching the
workflow.

This closes the provider compatibility gap through invoice generation, but it
does not prove settlement or receipt publication. A funded smoke still needs a
capped NWC credential in a protected deployment environment, explicit approval,
and verification of the matching kind `9735` on an approved relay.

## Protocol Sources

- NIP-57 defines zap requests as kind `9734` events sent to the receiver's
  LNURL callback as the `nostr` parameter. It requires `p` and `relays`, and
  recommends `amount` and `lnurl`; the Conduit signer requires all four so the
  request stays bound to the verified merchant, amount, LNURL, and receipt
  relay set.
- NIP-01 defines the base Nostr event shape and kind `0` profile metadata.

# Signed pricing availability

The signed common-feed collector uses ordered failover, not agreement or price voting:

- BTC/USD: mempool.space, Coinbase spot, Kraken spot.
- Broad fiat/USD: Frankfurter v1, FloatRates USD feed, ECB daily SDMX JSON.

All paths use fixed public HTTPS destinations without credentials. A provider
failure, malformed result, timeout or missing conversion advances to the next
path. Valid earlier conversions retain their values and per-currency provenance.
Mempool conversions take priority where available. The Worker exposes only the
canonical supported product-price currencies; provider coverage cannot authorize
a new commerce currency. Historical currency and provider labels remain readable
in retained signed snapshots.

The common-feed collector is separate from the existing general/anonymous-zap
collector. Adding signed-feed provider labels does not change anonymous-zap
authorization or deploy its signer.

These are separate delivery paths, with correlated data dependencies. Mempool
aggregates several exchanges, including Coinbase and Kraken. Frankfurter and ECB
share reference data; FloatRates combines central-bank/institution sources. A
second CDN serving the same provider would not be another source. No public
endpoint provides an availability guarantee.

## Deadlines and data checks

The common-feed refresh runs BTC and FX chains concurrently, with at most two
active fetches. Each provider has a two-second deadline covering headers and
streamed bytes, inside one six-second refresh deadline. Responses are bounded to
128 KiB. There are no automatic provider retries. Invalid or missing optional
conversions remain absent; an unrelated missing fiat does not invalidate BTC or
another available conversion. Coinbase base/quote and Kraken's error envelope
are validated. Decimal strings are parsed strictly, without hexadecimal or
partial-string coercion.

FX publication age and signed snapshot validity are separate. Frankfurter/ECB
observations must be no more than seven calendar days old, allowing weekends and
bank holidays; FloatRates observations must be no more than three days old.
Retired ECB series are excluded by publication date. ECB EUR-based reference
rates are normalized as USD-per-EUR divided by currency-units-per-EUR. These
checks never widen the five-minute signed validity window.

## Cache and outage behavior

A snapshot refreshes after four minutes and expires at its original fetch time
plus five minutes. One in-flight refresh is shared per isolate. While it remains
valid, the exact signed snapshot can be served immediately during a background
refresh. An incomplete refresh cannot replace still-valid broader coverage, and
old/new rate ages are never combined. A failed refresh has a five-second pause
before another request may attempt refresh; this does not extend validity.

The native edge cache stores only the public signed payload. It is local to a
Cloudflare data center and can be evicted. A new isolate verifies a restored
snapshot against the configured public key, current currency policy and original
expiry. Storage failure leaves a genuine fresh response usable in memory. Cache
reads and writes each have a 250-millisecond deadline. Cache
TTL never exceeds signed expiry. Origin-specific CORS headers are constructed
after retrieval; public responses remain `no-store`.

If all live sources fail, a valid snapshot remains usable only until its original
expiry. An expired or empty cache cannot manufacture a rate. Retained historical
recovery verifies the original signature against an independently anchored prior
acceptance/funding time and never fetches a replacement rate.

## Preview qualification boundary

The standalone preview entry accepts an optional fixed, bounded operator
deployment schedule. It forces predefined provider transport failures, then
automatically becomes inert. It is restricted to the dedicated preview hostname;
there is no request header, query parameter, body field or additional route that
can activate it. It cannot supply prices, destinations, timestamps or keys. The
ordinary adapters, cache, expiry checks and signer remain in use.

Response diagnostics contain only fixed provider identifiers, outcomes, durations
and cache state. They do not enable request, body, header or trace logging. All
requests remain rate-only, with exact allowed origins and service-level limiting
without visitor identity. The dedicated pricing key stays in runtime secret
storage; public trust and historical keys remain separate from anonymous-zap and
wallet signing.

Request shape is validated before protected work. The mandatory native service
ceiling is consumed once per coalesced upstream refresh, before collection or
new signing. Valid signed memory/edge cache hits do not consume it. Failed or
exhausted admission cannot authorize new collection/signing; a previously signed
snapshot remains usable only within its original freshness. Repeated public
requests cannot spend refresh capacity while that common snapshot is fresh.

Exact CORS is a browser boundary, not caller authentication: a non-browser caller
can forge an allowed Origin. This resource ceiling does not claim caller-isolated
edge abuse protection or DDoS immunity. Adding visitor-based controls requires a
separately reviewed privacy boundary; no visitor key is introduced here.

## Source references

- [Mempool updater](https://github.com/mempool/mempool/blob/master/backend/src/tasks/price-updater.ts)
- [Coinbase prices](https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices)
- [Kraken ticker](https://docs.kraken.com/api-reference/market-data/get-ticker-information)
- [Frankfurter v1](https://frankfurter.dev/v1/)
- [FloatRates public JSON feeds](https://www.floatrates.com/json-feeds.html)
- [FloatRates data sources](https://www.floatrates.com/currency-sources.html)
- [ECB public data API](https://data.ecb.europa.eu/help/api/overview)
- [ECB reuse conditions](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html)
- [Cloudflare Cache API locality and semantics](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [AWS guidance on deadlines and retries](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)

ExchangeRate-API is retained as a historical provenance label, but is not called
by new collection: its published terms restrict redistribution. Provider data
permissions remain distinct from software licensing. FloatRates advertises free
feed use; this is not a claim that a separate redistribution license was granted.

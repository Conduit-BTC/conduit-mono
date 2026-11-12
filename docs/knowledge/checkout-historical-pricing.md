# Invoice-time historical pricing

`invoice-historical-1pct-v1` is a fixed Conduit pricing policy for new fiat
orders. It is not a replacement router or a payment receipt. Private order
messages retain the existing NIP-17 envelope and signed listing/shipping terms.

## Evidence and time

Commerce pricing version 2 carries the policy identifier and the exact rate
used to calculate the order. Its digest commits both. Buyer-supplied rates and
timestamps are claims, not price or payment proof.

Before exposing funding, Buyer checks the rate against history at the fresh
provider-confirmed funding invoice's creation time. Merchant independently
repeats the check using its exact received-payment proof and that same original
invoice time. Transfer creation, recipient claim and the recovery clock do not
replace this anchor. Existing funding-invoice expiry and payment checks remain.

If provider time is slightly ahead, preparation waits for real device time to
reach the full provider millisecond timestamp before the strict pricing check.
The five-second monotonic clock budget ends before historical HTTP lookup; it
does not include network time. A fresh clock, routing-window and session check
after asynchronous preparation still gates persistence and invoice exposure.

The claimed rate must not have a fetch timestamp after the provider invoice
creation time. A device clock ahead of the provider can therefore reject a
historical-priced preparation even within a few seconds. Correct the device
clock before retrying; neither retry nor verification rewrites that timestamp.
This conservative limit remains in place rather than relaxing freshness.

The fixed benchmark is:

- Coinbase Exchange BTC-USD: close of the preceding completed UTC minute.
  Select the exact candle epoch, not its position in the response.
- Other fiat currencies: ECB reference rates through Frankfurter's native EUR
  endpoint, requesting the previous UTC calendar date. USD and the requested
  conversion must share the actual observation date; it must precede the
  invoice's UTC day and be at most seven calendar days old.
- USD is identity; derive other USD/unit conversions from the same EUR fixing.
  There is no fallback to today's rate, another provider or mixed fixing dates.

## Acceptance

Each effective fiat-to-sats conversion must be within the inclusive 99%-101%
range of its benchmark. Compare exact decimal ratios before the existing
whole-sat rounding. Do not separately allow 1% BTC and 1% FX differences.
Cross-currency shipping conversions receive the same bound, and benchmark
recalculation must preserve the signed free-shipping decision and weight band.
The final shipping charge must also remain within 1% of its recalculated
benchmark charge plus one sat for whole-sat rounding; intermediate handling
rounding cannot widen that allowance.
Signed product, shipping, allocation and order arithmetic still match exactly;
the rate allowance is not permission to change quantities, fees or totals.

Missing history leaves verification unavailable; a mismatching rate does not
authorize payment processing or fulfillment. An invoice-time minute/day change
is checked before invoice exposure. Failed preparation follows existing
pristine cleanup, never an automatic replacement-invoice loop. Funded orders
are never repriced or resent because a lookup failed or a provider revised data.
Historical corrections can require reconciliation rather than automatic acceptance.

Public observations may be cached in memory for 60 seconds, bounded to 32
entries. Receipts, order authority and payment status are not cached by this
module. Requests omit credentials/referrers, use fixed destinations and share a
six-second deadline with bounded response bodies.

## Compatibility and rollout

Version 1 retains its original wire/digest and signature/keyring verification,
including funded recovery long after quote expiry. Older clients that do not
understand version 2 cannot verify those orders; they must upgrade, not silently
downgrade the policy. Updated readers retain both versions.

Managed builds bind the new-order selector to their reviewed trust digest.
Preview and production explicitly select historical pricing for new orders;
staging remains on the default `signed-v1` policy without mainnet trust.
Missing/invalid selection never opts into historical pricing. Publish the
production selector change only after the dual-version reader release is
served by both apps and the older-client refresh/grace gate is satisfied.

The retired pricing Workers are no longer an issuance dependency. Managed
profiles retain public verification keyrings with no issuance URL. New fiat
preparation requires the explicit historical policy; legacy, missing or invalid
selection fails before creating a funding invoice. Sats-only terms are unchanged.

A rollback target must retain historical new-order pricing and both
evidence-version readers.
Changing the selector to `signed-v1` cannot restore issuance after the Workers
are removed. Use a known-good historical/dual-reader release or forward-fix the
historical path while new fiat preparation remains paused. Funded version 1
orders still verify against the retained keys; funded version 2 orders retain
their original historical policy. Never restore a pre-reader release, downgrade
funded terms or resend an uncertain payment. Restoring signed issuance would
require a separate service deployment and qualified configuration. This document
does not establish live payment settlement or full router completion.

Sources: [Coinbase candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles),
[Frankfurter API](https://api.frankfurter.dev/v2/openapi.json),
[ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html).
These are historical benchmarks, not an immutable signed market-price oracle.

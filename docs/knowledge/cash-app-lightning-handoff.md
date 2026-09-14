# Cash App invoice handoff

Market's Orders payment panel can open the same BOLT11 invoice in Cash App.
This is an external-wallet presentation option, not Cash App Pay or a separate
payment method. Invoice creation, order binding, receipt detection, and merchant
verification remain in their existing flows. Conversation invoices still require
review in Orders before payment controls are available.

## Handoff

- Cash App: `https://cash.app/launch/lightning/<normalized BOLT11>`.
- General Lightning wallet: `lightning:<normalized BOLT11>`.
- QR and copy use that same normalized BOLT11. No amount or order parameters are
  appended to the Cash App URL.
- The Cash App anchor opens a separate browsing context with `noopener`,
  `noreferrer`, and `referrerPolicy="no-referrer"`, preserving the guest order tab.
  No app-install probing, automatic redirect, server request, or payment callback
  is introduced. Links are only followed after a buyer action.
- Cash App is offered only for a mainnet invoice with a payment hash, matching
  order amount, valid expiry, and a matching configured network. The existing
  order guard runs again on click. Returning from the wallet is not payment proof.
- A missing or stale conversion quote falls back to the invoice amount in sats.
  The guest USD display is an estimate of this invoice, not a promised Cash App
  debit. Cash funding is conditional on Cash App account eligibility.

## Sources

Checked September 14, 2026:

- [BOLT11](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md):
  invoice encoding, amount, expiry, and the standard `lightning:` URI.
- [Breez Cash App URL construction](https://github.com/breez/spark-sdk/blob/main/crates/breez-sdk/common/src/buy/cashapp.rs):
  implementation precedent for the Cash App URL. This is not a Cash App API SLA.
- [Cash App iOS association](https://cash.app/.well-known/apple-app-site-association)
  and [Android association](https://cash.app/.well-known/assetlinks.json):
  platform association evidence, not proof of a particular browser/device flow.
- [Cash App USD-funded Lightning announcement](https://cash.app/press/cash-unlocks-bitcoin-everyday-stablecoins).
- [Cash App brand selector](https://design.cash.app/logo-variant-selector/):
  green `#00e013`. The bundled Cash App glyph is from
  [Simple Icons v16.0.0](https://github.com/simple-icons/simple-icons/blob/16.0.0/icons/cashapp.svg);
  it is loaded locally, with no third-party image request.

## Required device validation

Before release, a maintainer should exercise iOS Safari and Android Chrome with
Cash App installed and absent. Confirm the intended invoice and exact sats reach
the payment screen, eligible accounts can select Cash funding, cancelling does
not report payment, and returning preserves the guest order. Check common
in-app browser behavior and the copy/general-wallet fallback. Observe the existing
receipt or merchant-verification flow after a deliberately small authorized
payment. Browser rendering and URL tests do not establish native app behavior or
settlement. Do not attach real invoices, customer data, or wallet balances to
test logs or PR evidence.

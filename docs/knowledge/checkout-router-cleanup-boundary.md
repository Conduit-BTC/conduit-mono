# Checkout router cleanup boundary

New paid checkout uses `prepareCheckoutSparkSettledOrder` and the settled
preparation/funding/shopper runner. The retired Market chain
(`checkout-spark-router-preparation`, `checkout-spark-router-funding`,
`checkout-spark-shopper-advance`, `checkout-spark-outgoing-provider`, and
`checkout-spark-recipient-invoice-witness`) had no application entry-point
caller. Its private tests and witness fixture were removed with it. The old
Core `checkout-spark-outgoing-step` executor also had no remaining runtime
caller and was removed with its tests and barrel export.

This does not retire historical payment state. Keep the Core plan parsers,
reconciliation repositories, recovery readers, encrypted handoffs, tombstones,
and merchant recovery paths. Keep direct-pay order recovery and the active
negotiated/free-order paths. No stored record is migrated or deleted by this
cleanup. The shared preparation lock name also remains stable across tabs.

## Pricing feeds

Wallet fiat estimates and the Merchant revenue dashboard use
`useDisplayBtcUsdRate`, which reads public providers directly. Its query and
browser-storage keys are separate from the economic `useBtcUsdRate` feed.
Display estimates are not checkout pricing authority.

Checkout, Merchant invoice creation and historical recovery retain the existing
economic feed and signed-pricing verification. A recovered fiat order keeps its
original quote, anchored to the provider-confirmed funding invoice creation
time, not the recovery clock or recipient claim time. Both pricing Workers and
their deployment configuration remain required until that authority has an
explicit replacement. Other application hooks can still request the economic
feed; this display split does not make an entire page Worker-independent.

The old receive-reconciliation adapter remains as a read-only historical
provider-evidence boundary. Removing a send executor does not remove historical
plan restoration or provider-history interpretation.

## Coverage after the test reduction

`tests/checkout-spark-settled-outgoing.test.ts` retains selected durable-intent,
ambiguity, exact retry, fee, invoice-expiry, and takeover checks on the live
executor. `tests/checkout-spark-settled-preparation-recovery.test.ts` retains
lost-ACK and outbox-readback recovery without creating a second wallet or funding
invoice. The exact scope and evidence limits are listed in
[`tests/README.md`](../../tests/README.md).

The broader preparation, funding, shopper-runner, recipient-evidence, vertical
composition, and persistence test matrices were retired in the repository-wide
test reduction. The former Playwright layer was already retired by #779.

The unused Market wallet-retention forwarding module is gone. The shared Core
retention guard remains; its historical takeover-window tests were retired.

The obsolete manual-invoice identity helper's test only asserted that its input
was returned unchanged. Actual invoice requests, payment proofs, and persisted
attempt recovery remain in place. Only the selected payment and recovery tests
listed above and in the suite README remain.
